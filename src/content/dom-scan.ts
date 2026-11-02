// Finds a ClickFix instruction box anywhere in a page, inside shadow roots too, however long the page around it is.

import { scorePageText } from '../engine/page';
import { compileRules } from '../engine/rules';
import type { PageVerdict, RulesFile } from '../engine/types';

type ShadowGetter = (el: Element) => ShadowRoot | null;

/** Extensions may open closed shadow roots, Chrome through chrome.dom and Firefox through openOrClosedShadowRoot. */
function shadowGetter(): ShadowGetter {
  const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } }).chrome?.dom;
  return (el) => {
    try {
      if (dom?.openOrClosedShadowRoot) return dom.openOrClosedShadowRoot(el) ?? null;
      const ff = (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
      if (ff !== undefined) return ff ?? null;
      return el.shadowRoot ?? null;
    } catch {
      return el.shadowRoot ?? null;
    }
  };
}

const getShadow = shadowGetter();

/** Every shadow root in the document, nested ones included. */
export function shadowRoots(limit = 300): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const queue: ParentNode[] = [document];
  while (queue.length && found.length < limit) {
    const node = queue.shift()!;
    for (const el of node.querySelectorAll('*')) {
      const root = getShadow(el);
      if (!root || found.includes(root)) continue;
      found.push(root);
      queue.push(root);
      if (found.length >= limit) break;
    }
  }
  return found;
}

function text(el: Element): string {
  try {
    return (el as HTMLElement).innerText ?? el.textContent ?? '';
  } catch {
    return el.textContent ?? '';
  }
}

/** Text of a shadow root, innerText of its top elements keeps hidden parts out once they are rendered hidden. */
function rootText(root: ShadowRoot): string {
  const parts: string[] = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (node.nodeType === Node.ELEMENT_NODE && !/^(STYLE|SCRIPT|TEMPLATE)$/.test((node as Element).tagName)) parts.push(text(node as Element));
  }
  return parts.join('\n');
}

// A step like "Press <b>Ctrl</b> + <b>V</b>" is split over several text nodes, so a single key word is enough to start from.
const KEY_WORD = /ctrl|strg|ctl\b|cmd|command|⌘|\bwin|⊞|❖|terminal|powershell|explorer|address bar|\brun\b|ejecutar|ausführen|exécuter|выполнить|изпълн/i;
const CONTROLS = 'button, input[type=checkbox], input[type=button], input[type=submit], [role=button], [role=checkbox], a';

/** A real lure box sits next to a check or a button like "Verify", "Fix" or "Copy", an article that quotes one does not. */
export function hasLureControl(el: Element, shadow: ShadowRoot | null, rules: RulesFile): boolean {
  const t = compileRules(rules).trigger;
  const controls = [...el.querySelectorAll(CONTROLS), ...(shadow ? shadow.querySelectorAll(CONTROLS) : [])].slice(0, 40);
  for (const c of controls) {
    if (c.matches('input[type=checkbox], [role=checkbox]')) return true;
    const label = [c.getAttribute('aria-label'), c.getAttribute('title'), (c as HTMLInputElement).value, c.textContent].filter(Boolean).join(' ').trim().slice(0, 80);
    if (label && (t.captcha?.test(label) || t.fix?.test(label) || t.copy?.test(label))) return true;
  }
  return false;
}

/**
 * Starts at each piece of text that names a paste or an open step, like "Ctrl + V" or "Win + R",
 * climbs to the smallest block that also holds the rest of the lure, then up to two more levels for its button.
 */
export function findLureBox(rules: RulesFile, roots: ShadowRoot[]): PageVerdict | null {
  const maxBox = rules.page.boxMaxTextLength ?? 3000;
  let checked = 0;
  for (const root of [document as Document | ShadowRoot, ...roots]) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && checked < 300; node = walker.nextNode()) {
      const data = node.textContent ?? '';
      if (data.length < 2 || !KEY_WORD.test(data)) continue;
      let el: Element | null = node.parentElement;
      let inner = '';
      let shadow: ShadowRoot | null = null;
      let found: PageVerdict | null = null;
      for (let level = 0, extra = 0; el && level < 12; level++) {
        const block = text(el) + (inner ? '\n' + inner : '');
        if (block.length > maxBox) break;
        checked++;
        if (!found) {
          const v = scorePageText(block, rules);
          if (v.standalone) found = v;
        }
        if (found) {
          if (hasLureControl(el, shadow, rules)) return found;
          if (++extra > 2) break;
        }
        const parent: Element | null = el.parentElement;
        if (!parent && el.parentNode instanceof ShadowRoot) {
          // Leave the shadow root for its host, keeping the text and buttons the host cannot see.
          shadow = el.parentNode;
          inner = rootText(shadow);
          el = shadow.host;
        } else el = parent;
      }
    }
  }
  return null;
}
