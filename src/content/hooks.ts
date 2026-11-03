// Page-world hooks installed before any page script, they ask the guard for a verdict and fall back to the bundled engine.

import { externalScheme, matchProtocol, web3Host } from '../engine/checks';
import { BUNDLED_RULES } from '../engine/rules';
import { evaluateCommand } from '../engine/score';
import { type CheckKind, EVT, escapeHtml, htmlToText, safeText } from './protocol';

type AnyFn = (...args: unknown[]) => unknown;
type Realm = Window & typeof globalThis;

export function installHooks(root: Realm): void {
  // Keep private references so later page code cannot tamper with them.
  const ProxyC = Proxy;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getDescriptor = Object.getOwnPropertyDescriptor;
  const stringify = JSON.stringify;
  const CE = root.CustomEvent;
  const dispatch = root.EventTarget.prototype.dispatchEvent;
  const prevented = getDescriptor(root.Event.prototype, 'defaultPrevented')!.get!;
  const patched = new WeakSet<object>();

  function send(type: string, detail: unknown): boolean {
    const ev = new CE(type, { detail: stringify(detail), cancelable: true });
    apply(dispatch, root, [ev]);
    return apply(prevented, ev, []) as boolean;
  }

  function fallback(kind: CheckKind, payload: string): boolean {
    if (kind === 'protocol') return !!matchProtocol(payload, BUNDLED_RULES);
    if (kind === 'fullscreen' || kind === 'keyboard-lock') return false;
    return evaluateCommand(payload, BUNDLED_RULES).level === 'block';
  }

  /** True means block. */
  function check(kind: CheckKind, payload: string): boolean {
    try {
      if (send(EVT.ping, null)) return send(EVT.check, { kind, payload });
    } catch {
      // fall through to the bundled engine
    }
    try {
      return fallback(kind, payload);
    } catch {
      return false;
    }
  }

  type Handler = (target: AnyFn, thisArg: unknown, args: unknown[]) => unknown;
  // Clipboard hooks that must stay the outermost wrapper, another extension or the page may wrap them later without calling through.
  const guarded: { obj: object; name: string; handler: Handler }[] = [];
  const checkedItems = new WeakSet<object>();
  const ours = new WeakSet<object>();

  /**
   * When a later wrapper calls through to an older copy of the same hook with the same arguments, that inner copy passes
   * the call on, but a wrapper that swapped the text in between is checked again.
   */
  function once(handler: Handler): Handler {
    const outer: unknown[][] = [];
    return (target, thisArg, args) => {
      const seen = outer[outer.length - 1];
      // execCommand copies the current selection, which a wrapper in between can change, so only text arguments count as the same call.
      const sameText = seen && seen.length === args.length && seen.every((a, i) => a === args[i]) && args.some((a) => typeof a === 'string' && !/^(copy|cut)$/i.test(a));
      if (sameText) return apply(target, thisArg, args);
      outer.push(args.slice());
      try {
        return handler(target, thisArg, args);
      } finally {
        outer.pop();
      }
    };
  }

  function hook(obj: object | undefined, name: string, handler: Handler, guard = false): void {
    if (!obj) return;
    const desc = getDescriptor(obj, name);
    if (!desc || typeof desc.value !== 'function') return;
    const shared = guard ? once(handler) : handler;
    const proxy = new ProxyC(desc.value as AnyFn, { apply: shared });
    ours.add(proxy);
    defineProperty(obj, name, { ...desc, value: proxy });
    if (guard) guarded.push({ obj, name, handler: shared });
  }

  /** Wraps again on top of anything added after us, so a click or key press always reaches our check first. */
  function reassert(): void {
    for (const g of guarded) {
      try {
        const desc = getDescriptor(g.obj, g.name);
        if (!desc || typeof desc.value !== 'function' || ours.has(desc.value)) continue;
        const proxy = new ProxyC(desc.value as AnyFn, { apply: g.handler });
        ours.add(proxy);
        defineProperty(g.obj, g.name, { ...desc, value: proxy });
      } catch {
        // a frozen property stays as it is
      }
    }
  }

  function hookAccessor(obj: object | undefined, name: string, kind: 'get' | 'set', handler: (target: AnyFn, thisArg: unknown, args: unknown[]) => unknown): void {
    if (!obj) return;
    const desc = getDescriptor(obj, name);
    const fn = desc?.[kind];
    if (!desc || typeof fn !== 'function') return;
    defineProperty(obj, name, { ...desc, [kind]: new ProxyC(fn as AnyFn, { apply: handler }) });
  }

  function selectionText(doc: Document): string {
    const isField = (el: Element | null): el is HTMLTextAreaElement | HTMLInputElement =>
      !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    const active = doc.activeElement;
    try {
      if (isField(active) && typeof active.selectionStart === 'number' && active.selectionEnd! > active.selectionStart)
        return active.value.slice(active.selectionStart, active.selectionEnd!);
    } catch {
      // some input types have no selection
    }
    const fields = doc.querySelectorAll('textarea, input');
    for (let i = 0; i < fields.length && i < 200; i++) {
      const el = fields[i] as HTMLTextAreaElement;
      try {
        if (typeof el.selectionStart === 'number' && el.selectionEnd! > el.selectionStart) return el.value.slice(el.selectionStart, el.selectionEnd!);
      } catch {
        // ignore
      }
    }
    return doc.getSelection?.()?.toString() ?? '';
  }

  function patchRealm(w: Realm): void {
    let key: object;
    try {
      key = w.Document.prototype;
    } catch {
      return; // cross-origin frame, it gets its own copy of this script
    }
    if (patched.has(key)) return;
    patched.add(key);
    // Re-wrap right before the click or key press that a lure needs, on DOMContentLoaded and load too.
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) w.addEventListener(type, reassert, true);
    w.addEventListener('DOMContentLoaded', reassert, true);
    w.addEventListener('load', reassert, true);

    // navigator.clipboard.writeText(text)
    hook(w.Clipboard?.prototype, 'writeText', (target, thisArg, args) => {
      const text = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
      if (text && check('clipboard-write', text)) return apply(target, thisArg, [safeText()]);
      return apply(target, thisArg, args);
    }, true);

    // navigator.clipboard.write([new ClipboardItem({...})])
    hook(w.Clipboard?.prototype, 'write', (target, thisArg, args) => {
      const items = args[0] as ClipboardItem[] | undefined;
      // The check runs after an await, so an inner copy of this hook recognises the item list it already checked.
      if (items && typeof items === 'object' && checkedItems.delete(items)) return apply(target, thisArg, args);
      return (async () => {
        let text = '';
        try {
          const parts: string[] = [];
          for (const item of Array.from(items ?? []).slice(0, 5)) {
            for (const type of ['text/plain', 'text/html']) {
              if (!item.types?.includes(type)) continue;
              const blob = await item.getType(type);
              const s = await blob.text();
              parts.push(type === 'text/html' ? htmlToText(s) : s);
            }
          }
          text = parts.join('\n');
        } catch {
          // unreadable item, let the browser handle it
        }
        if (text && check('clipboard-write', text)) {
          const safe = [new w.ClipboardItem({ 'text/plain': new w.Blob([safeText()], { type: 'text/plain' }) })];
          checkedItems.add(safe);
          return apply(target, thisArg, [safe]);
        }
        if (items && typeof items === 'object') checkedItems.add(items);
        return apply(target, thisArg, args);
      })();
    }, true);

    // document.execCommand('copy') on a hidden textarea
    hook(w.Document?.prototype, 'execCommand', (target, thisArg, args) => {
      const cmd = String(args[0] ?? '').toLowerCase();
      if (cmd !== 'copy' && cmd !== 'cut') return apply(target, thisArg, args);
      const doc = thisArg as Document;
      send(EVT.mark, 'begin');
      try {
        const text = selectionText(doc);
        if (!text || !check('exec-copy', text)) return apply(target, thisArg, args);
        // Copy a harmless note instead of the selection.
        const ta = doc.createElement('textarea');
        ta.value = safeText();
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        (doc.body ?? doc.documentElement).appendChild(ta);
        ta.select();
        try {
          return apply(target, thisArg, ['copy']);
        } finally {
          ta.remove();
        }
      } finally {
        send(EVT.mark, 'end');
      }
    }, true);

    // event.clipboardData.setData('text/plain', ...) inside a copy handler
    hook(w.DataTransfer?.prototype, 'setData', (target, thisArg, args) => {
      const format = String(args[0] ?? '').toLowerCase();
      const data = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '');
      if (data && /^(text\/plain|text|text\/unicode|text\/uri-list|text\/html)$/.test(format)) {
        const isHtml = format === 'text/html';
        if (check('set-data', isHtml ? htmlToText(data) : data))
          return apply(target, thisArg, [args[0], isHtml ? escapeHtml(safeText()) : safeText()]);
      }
      return apply(target, thisArg, args);
    }, true);

    // Full-screen fake update pages
    for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
      hook(w.Element?.prototype, name, (target, thisArg, args) => {
        if (check('fullscreen', '')) {
          return name === 'requestFullscreen' ? Promise.reject(new w.DOMException('Blocked by ClickFix Warden', 'NotAllowedError')) : undefined;
        }
        return apply(target, thisArg, args);
      });
    }
    const KeyboardProto = (w as unknown as { Keyboard?: { prototype: object } }).Keyboard?.prototype;
    hook(KeyboardProto, 'lock', (target, thisArg, args) => {
      if (check('keyboard-lock', '')) return Promise.reject(new w.DOMException('Blocked by ClickFix Warden', 'NotAllowedError'));
      return apply(target, thisArg, args);
    });

    // Links that open programs outside the browser
    hook(w, 'open', (target, thisArg, args) => {
      const url = String(args[0] ?? '');
      if (url && externalScheme(url) && check('protocol', url)) return null;
      const child = apply(target, thisArg, args) as Realm | null;
      if (child) patchRealm(child);
      return child;
    });
    hookAccessor(w.HTMLIFrameElement?.prototype, 'src', 'set', (target, thisArg, args) => {
      const url = String(args[0] ?? '');
      if (url && externalScheme(url) && check('protocol', url)) return undefined;
      return apply(target, thisArg, args);
    });

    // Fresh same-origin frames would hand out unwrapped functions, wrap them on first access.
    hookAccessor(w.HTMLIFrameElement?.prototype, 'contentWindow', 'get', (target, thisArg, args) => {
      const win = apply(target, thisArg, args) as Realm | null;
      if (win) patchRealm(win);
      return win;
    });
    hookAccessor(w.HTMLIFrameElement?.prototype, 'contentDocument', 'get', (target, thisArg, args) => {
      const doc = apply(target, thisArg, args) as Document | null;
      if (doc?.defaultView) patchRealm(doc.defaultView as Realm);
      return doc;
    });

    // Blockchain lookups used by hacked sites to load fake CAPTCHA code (ClearFake, EtherHiding)
    const signalWeb3 = (url: string, body: unknown) => {
      const net = web3Host(url, BUNDLED_RULES);
      if (!net) return;
      if (typeof body === 'string' && body && !body.includes('eth_call')) return;
      let host = '';
      try {
        host = new URL(url, w.location.href).hostname;
      } catch {
        // ignore
      }
      send(EVT.signal, { kind: 'web3', net, host });
    };
    hook(w, 'fetch', (target, thisArg, args) => {
      try {
        const input = args[0] as string | URL | Request;
        const url = typeof input === 'string' ? input : input instanceof w.URL ? input.href : (input as Request)?.url;
        if (url) signalWeb3(url, (args[1] as RequestInit | undefined)?.body);
      } catch {
        // never break the page's request
      }
      return apply(target, thisArg, args);
    });
    const xhrUrls = new WeakMap<object, string>();
    hook(w.XMLHttpRequest?.prototype, 'open', (target, thisArg, args) => {
      try {
        xhrUrls.set(thisArg as object, String(args[1] ?? ''));
      } catch {
        // ignore
      }
      return apply(target, thisArg, args);
    });
    hook(w.XMLHttpRequest?.prototype, 'send', (target, thisArg, args) => {
      try {
        const url = xhrUrls.get(thisArg as object);
        if (url) signalWeb3(url, args[0]);
      } catch {
        // ignore
      }
      return apply(target, thisArg, args);
    });
  }

  patchRealm(root);
}
