// Graphite design tokens and the shared warning parts used by the in-page overlay and the extension pages.

import { t, tParts } from '../shared/i18n';

export const FONT_STACK = "'CFW Jakarta', 'CFW Manrope', 'Plus Jakarta Sans', Manrope, system-ui, -apple-system, 'Segoe UI', sans-serif";

export const FONT_FACES = (url: (path: string) => string) => `
@font-face { font-family: 'CFW Jakarta'; font-weight: 400 800; font-display: swap; src: url('${url('fonts/plus-jakarta-sans-latin.woff2')}') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: 'CFW Jakarta'; font-weight: 400 800; font-display: swap; src: url('${url('fonts/plus-jakarta-sans-latin-ext.woff2')}') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: 'CFW Manrope'; font-weight: 400 800; font-display: swap; src: url('${url('fonts/manrope-cyrillic.woff2')}') format('woff2'); unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
`;

/** Classes shared by the overlay shadow root and the extension pages, so a confirmation looks the same everywhere. */
export const PARTS_CSS = `
.g-label { font-size: 15px; font-weight: 800; letter-spacing: 0.08em; color: #FF5C5C; }
.g-iconbox { width: 44px; height: 44px; border-radius: 12px; background: #3A2224; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.g-iconbox.small { width: 36px; height: 36px; border-radius: 10px; }
.g-head { display: flex; align-items: center; gap: 12px; }
.g-title { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 800; letter-spacing: -0.015em; color: #FF5C5C; }
.g-title.white { color: #F3F3F4; font-size: 26px; }
.g-text { margin: 0; font-size: 15px; line-height: 1.65; color: #C4C6CC; }
.g-text strong { color: #FFFFFF; font-weight: 700; }
.g-row { display: flex; gap: 10px; align-items: center; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
.g-btn { font: inherit; font-size: 15px; font-weight: 600; background: transparent; color: #F3F3F4; border: 1px solid #44464D; border-radius: 12px; padding: 11px 18px; cursor: pointer; }
.g-btn.primary { font-weight: 700; background: #F3F3F4; color: #111214; border-color: #F3F3F4; }
.g-btn.danger { color: #FF5C5C; border-color: #FF5C5C; }
.g-btn.small { font-size: 14px; border-radius: 10px; padding: 8px 14px; }
.g-btn:hover:not(:disabled) { background: #2A2B30; border-color: #5A5C63; color: #FFFFFF; }
.g-btn.primary:hover:not(:disabled) { background: #FFFFFF; border-color: #FFFFFF; color: #111214; }
.g-btn.danger:hover:not(:disabled) { background: #3A2224; border-color: #FF5C5C; color: #FF7A7A; }
a.g-btn { display: inline-flex; align-items: center; text-decoration: none; }
.g-btn[hidden] { display: none; }
.g-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.g-btn:focus-visible, .g-check input:focus-visible { outline: 1.5px solid rgba(243, 243, 244, 0.7); outline-offset: 2px; }
.g-check { display: flex; align-items: flex-start; gap: 10px; padding: 14px; border-radius: 12px; background: #1A1B1E; border: 1px solid #34363C; font-size: 14px; line-height: 1.5; color: #F3F3F4; cursor: pointer; }
.g-check input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: #FF5C5C; flex-shrink: 0; }
.g-check span { white-space: nowrap; }
.g-card.wide { width: 780px; container-type: inline-size; }
@container (max-width: 720px) { .g-check span { white-space: normal; } }
.g-card { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; background: #222327; border: 1px solid #34363C; border-radius: 18px; padding: 28px 28px 24px; display: flex; flex-direction: column; gap: 14px; color: #F3F3F4; text-align: start; }
.g-backdrop { position: fixed; inset: 0; background: rgba(8,8,10,0.66); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 2147483647; }
.g-note { margin: 0; padding: 12px 14px; border-radius: 12px; background: #1A1B1E; border: 1px solid #34363C; font-size: 14px; line-height: 1.55; color: #F3F3F4; }
`;

const SVG = 'http://www.w3.org/2000/svg';

/** Red triangle with an exclamation mark. */
export function warnIcon(doc: Document, size = 24): SVGSVGElement {
  const s = doc.createElementNS(SVG, 'svg');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const tri = doc.createElementNS(SVG, 'path');
  tri.setAttribute('d', 'M12 3 L21 19 H3 Z');
  tri.setAttribute('fill', 'none');
  tri.setAttribute('stroke', '#FF5C5C');
  tri.setAttribute('stroke-width', '2');
  tri.setAttribute('stroke-linejoin', 'round');
  const mark = doc.createElementNS(SVG, 'path');
  mark.setAttribute('d', 'M12 9.5 V13.5 M12 16.2 V16.4');
  mark.setAttribute('stroke', '#FF5C5C');
  mark.setAttribute('stroke-width', '2.2');
  mark.setAttribute('stroke-linecap', 'round');
  s.append(tri, mark);
  return s;
}

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Icon box plus the POTENTIALLY DANGEROUS SITE label. */
export function dangerHead(doc: Document): HTMLElement {
  const head = el(doc, 'div', 'g-head');
  const box = el(doc, 'div', 'g-iconbox');
  box.append(warnIcon(doc));
  head.append(box, el(doc, 'div', 'g-label', t('dangerLabel')));
  return head;
}

/** A message with $1 and $2 shown in bold, each language keeps its own word order, text never goes through HTML parsing. */
export function boldSentence(doc: Document, key: string, ...bold: string[]): HTMLParagraphElement {
  const p = el(doc, 'p', 'g-text');
  p.append(...tParts(key, bold.map((b) => el(doc, 'strong', undefined, b))));
  return p;
}

export interface AskOptions {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): void;
}

/** A plain yes or no question in the Graphite look, in place of the browser's own confirm box. Cancel has the focus. */
export function askDialog(doc: Document, opts: AskOptions): HTMLElement {
  const backdrop = el(doc, 'div', 'g-backdrop');
  const card = el(doc, 'div', 'g-card');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = el(doc, 'h1', 'g-title white', opts.title);
  title.id = 'cfw-ask-title';
  card.setAttribute('aria-labelledby', title.id);
  const row = el(doc, 'div', 'g-row');
  const yes = el(doc, 'button', 'g-btn danger', opts.confirmLabel);
  const no = el(doc, 'button', 'g-btn primary', t('btnCancel'));
  row.append(yes, no);
  const close = () => backdrop.remove();
  yes.addEventListener('click', () => {
    close();
    opts.onConfirm();
  });
  no.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  card.append(title, el(doc, 'p', 'g-text', opts.body), row);
  backdrop.append(card);
  setTimeout(() => no.focus(), 0);
  return backdrop;
}

export interface ConfirmOptions {
  host: string;
  reported: boolean;
  mode: 'trust' | 'open';
  onConfirm(): void;
  onCancel?(): void;
}

/** The "Stop protecting this site?" confirmation, the confirm button stays off until the risk box is ticked. */
export function confirmDialog(doc: Document, opts: ConfirmOptions): HTMLElement {
  const backdrop = el(doc, 'div', 'g-backdrop');
  // Wide enough to keep the risk sentence on one line, it wraps on narrow screens.
  const card = el(doc, 'div', 'g-card wide');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = el(doc, 'h1', 'g-title white', t(opts.mode === 'trust' ? 'confirmTrustTitle' : 'confirmOpenTitle', opts.host));
  title.id = 'cfw-confirm-title';
  card.setAttribute('aria-labelledby', title.id);
  const body = boldSentence(doc, 'confirmBody', t('confirmBodyStrong'));
  if (opts.reported) body.prepend(t('confirmReported') + ' ');
  const only = el(doc, 'p', 'g-text', t(opts.reported ? 'confirmOnlyReported' : 'confirmOnlyKnown'));
  const label = el(doc, 'label', 'g-check');
  const box = el(doc, 'input');
  box.type = 'checkbox';
  label.append(box, el(doc, 'span', undefined, t(opts.mode === 'trust' ? 'confirmCheckTrust' : 'confirmCheckOpen')));
  const row = el(doc, 'div', 'g-row');
  const yes = el(doc, 'button', 'g-btn danger', t(opts.mode === 'trust' ? 'confirmTrust' : 'confirmOpen'));
  yes.disabled = true;
  const no = el(doc, 'button', 'g-btn primary', t('confirmKeep'));
  row.append(yes, no);
  box.addEventListener('change', () => (yes.disabled = !box.checked));
  const close = () => backdrop.remove();
  yes.addEventListener('click', () => {
    if (!box.checked) return;
    close();
    opts.onConfirm();
  });
  no.addEventListener('click', () => {
    close();
    opts.onCancel?.();
  });
  backdrop.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      close();
      opts.onCancel?.();
    }
  });
  card.append(dangerHead(doc), title, body, only, label, row);
  backdrop.append(card);
  setTimeout(() => no.focus(), 0);
  return backdrop;
}
