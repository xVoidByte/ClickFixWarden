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
export const KEY_WORD = /\bctrl\b|\bstrg\b|\bctl\b|\bcmd\b|⌘|\bcommand\s*\+|\bwin(?:dows)?\b|⊞|❖|\bterminal\b|powershell|file explorer|address bar|\brun\b|ejecutar|ausführen|exécuter|выполнить|изпълн/i;
// The paste keys sit in every lure, so climbing starts from them before the more common words.
const PASTE_KEY = /\bctrl\b|\bstrg\b|\bctl\b|\bcmd\b|⌘|\bcommand\s*\+/i;
// Fake checks are often a plain div or span, their click handler, focus order or class name gives them away.
const CONTROLS = [
  'button', 'a', 'label', 'input[type=checkbox]', 'input[type=button]', 'input[type=submit]', '[role=button]', '[role=checkbox]', '[onclick]', '[tabindex]',
  '[class*="checkbox" i]', '[id*="checkbox" i]', '[class*="captcha" i]', '[id*="captcha" i]', '[class*="turnstile" i]', '[class*="challenge" i]', '[id*="challenge" i]',
].join(', ');
// Names of fake check widgets, kept narrow so a checklist, a checkout or a verified badge in an article does not count.
const CHECK_HINT = /checkbox|captcha|turnstile|challenge|i-?am-?human|not-?a-?robot/i;

/** A real lure box sits next to a check or a button like "Verify", "Fix" or "Copy", an article that quotes one does not. */
export function hasLureControl(el: Element, shadow: ShadowRoot | null, rules: RulesFile): boolean {
  const t = compileRules(rules).trigger;
  const controls = [...el.querySelectorAll(CONTROLS), ...(shadow ? shadow.querySelectorAll(CONTROLS) : [])].slice(0, 80);
  for (const c of controls) {
    if (c.matches('input[type=checkbox], [role=checkbox]')) return true;
    if (CHECK_HINT.test(`${c.id} ${c.getAttribute('class') ?? ''}`)) return true;
    const label = [c.getAttribute('aria-label'), c.getAttribute('title'), (c as HTMLInputElement).value, c.textContent].filter(Boolean).join(' ').trim().slice(0, 80);
    if (label && (t.captcha?.test(label) || t.fix?.test(label) || t.copy?.test(label))) return true;
  }
  // A fake check can be an empty clickable square with no name at all, its pointer cursor and size give it away.
  const boxes = [...el.querySelectorAll('div, span, i'), ...(shadow ? shadow.querySelectorAll('div, span, i') : [])].slice(0, 200);
  for (const b of boxes) {
    if (b.childElementCount > 1 || (b.textContent ?? '').trim() || b.closest('a, button')) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 12 || r.width > 64 || Math.abs(r.width - r.height) > 8) continue;
    try {
      const st = getComputedStyle(b);
      // A drawn square with a border and a pointer is how a fake check looks, an icon in a share link is neither.
      if (st.cursor === 'pointer' && parseFloat(st.borderTopWidth) > 0 && st.borderTopStyle !== 'none') return true;
    } catch {
      // a detached node has no style
    }
  }
  return false;
}

/** Text nodes that could start a lure, paste keys first, from the document and every shadow root, with a cap per root. */
function anchors(roots: (Document | ShadowRoot)[]): Text[] {
  const strong: Text[] = [];
  const weak: Text[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let taken = 0;
    for (let node = walker.nextNode() as Text | null; node && taken < 400; node = walker.nextNode() as Text | null) {
      const data = node.data;
      if (data.length < 2 || !KEY_WORD.test(data)) continue;
      (PASTE_KEY.test(data) ? strong : weak).push(node);
      taken++;
    }
  }
  return [...strong, ...weak];
}

/**
 * Starts at each piece of text that names a paste or an open step, like "Ctrl + V" or "Win + R",
 * climbs to the smallest block that also holds the rest of the lure, then up to two more levels for its button.
 * Every element is scored once per scan, so common words cannot use up the budget twice.
 */
export function findLureBox(rules: RulesFile, roots: ShadowRoot[]): PageVerdict | null {
  const maxBox = rules.page.boxMaxTextLength ?? 3000;
  const scored = new Set<Element>();
  for (const node of anchors([document, ...roots])) {
    if (scored.size >= 800) break;
    let el: Element | null = node.parentElement;
    let inner = '';
    let shadow: ShadowRoot | null = null;
    let found: PageVerdict | null = null;
    for (let level = 0, extra = 0; el && level < 12; level++) {
      // An element already scored as no lure was climbed past by an earlier anchor, everything above it was seen then.
      if (!found && !inner && scored.has(el)) break;
      const block = text(el) + (inner ? '\n' + inner : '');
      if (block.length > maxBox) break;
      if (!found) {
        const v = scorePageText(block, rules);
        if (v.standalone) found = v;
        else if (!inner) scored.add(el);
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
  return null;
}
