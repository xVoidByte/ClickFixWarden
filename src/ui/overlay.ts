// In-page warnings in the Graphite design, inside a closed shadow root so page styles and scripts cannot reach them.

import { browser } from 'wxt/browser';
import { isRtl, t, tParts, uiLang } from '../shared/i18n';
import type { AlertData } from '../shared/messages';
import { longDate, whatOfReport } from './explain';
import { boldSentence, confirmDialog, dangerHead, el, FONT_FACES, FONT_STACK, PARTS_CSS, warnIcon } from './graphite';

export interface OverlayActions {
  leave(): void;
  trust(host: string): void;
}

const DIALOG_KINDS = new Set(['clipboard', 'manual-copy', 'paste', 'protocol', 'fullscreen']);

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: #F3F3F4; -webkit-font-smoothing: antialiased; }
${PARTS_CSS}
.banner { position: fixed; top: 12px; left: 12px; right: 12px; z-index: 2147483647; background: #1A1B1E; border: 1px solid #2A2B30; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.45); display: flex; align-items: center; gap: 14px; padding: 12px 16px; flex-wrap: wrap; }
.banner .text { flex: 1 1 320px; min-width: 0; font-size: 14px; line-height: 1.5; color: #C4C6CC; }
.banner .text strong { color: #FFFFFF; font-weight: 700; }
.close { background: none; border: none; padding: 8px; cursor: pointer; border-radius: 8px; }
.close:focus-visible { outline: 1.5px solid rgba(243, 243, 244, 0.7); outline-offset: 2px; }
`;

let hostEl: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let dialogOpen = false;
let fontsAdded = false;
const shownBanners = new Set<string>();

function addFonts(): void {
  if (fontsAdded) return;
  fontsAdded = true;
  try {
    const style = document.createElement('style');
    style.textContent = FONT_FACES((p) => (browser.runtime.getURL as unknown as (path: string) => string)('/' + p));
    (document.head ?? document.documentElement).appendChild(style);
  } catch {
    // the system font is a fine fallback
  }
}

function root(): ShadowRoot {
  if (hostEl && shadow && hostEl.isConnected) return shadow;
  addFonts();
  hostEl = document.createElement('cfw-warden');
  hostEl.setAttribute('dir', isRtl() ? 'rtl' : 'ltr');
  hostEl.setAttribute('lang', uiLang());
  hostEl.setAttribute('style', 'all: initial !important; display: block !important; position: static !important;');
  shadow = hostEl.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  (document.documentElement ?? document).appendChild(hostEl);
  return shadow;
}

function closeIcon(): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '14');
  s.setAttribute('height', '14');
  s.setAttribute('viewBox', '0 0 14 14');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M1 1 13 13 M13 1 1 13');
  p.setAttribute('stroke', '#A6A8AE');
  p.setAttribute('stroke-width', '2');
  s.append(p);
  return s;
}

const TEXT_KEYS: Record<string, { title: string; desc: string; note?: string }> = {
  clipboard: { title: 'titleClipboard', desc: 'descClipboard', note: 'descNote' },
  'manual-copy': { title: 'titleManual', desc: 'descManual', note: 'descManualNote' },
  paste: { title: 'titlePaste', desc: 'descPaste' },
  protocol: { title: 'titleProtocol', desc: 'descProtocol' },
  fullscreen: { title: 'titleFullscreen', desc: 'descFullscreen', note: 'descFullscreenNote' },
};

export function showAlert(alert: AlertData, actions: OverlayActions, customWarning = ''): void {
  if (DIALOG_KINDS.has(alert.kind)) showDialog(alert, actions, customWarning);
  else showBanner(alert, actions);
}

function showDialog(alert: AlertData, actions: OverlayActions, customWarning: string): void {
  if (dialogOpen) return;
  const r = root();
  dialogOpen = true;
  const keys = TEXT_KEYS[alert.kind] ?? TEXT_KEYS.clipboard;
  const wrap = el(document, 'div', 'wrap');
  const backdrop = el(document, 'div', 'g-backdrop');
  const card = el(document, 'div', 'g-card');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = el(document, 'h1', 'g-title', t(keys.title));
  title.id = 'cfw-title';
  card.setAttribute('aria-labelledby', 'cfw-title');
  card.append(dangerHead(document), title, boldSentence(document, keys.desc, alert.what ?? '', alert.why ?? ''));
  if (keys.note) card.append(el(document, 'p', 'g-text', t(keys.note)));
  if (customWarning) card.append(el(document, 'p', 'g-note', customWarning));

  const close = () => {
    wrap.remove();
    dialogOpen = false;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey, true);

  const row = el(document, 'div', 'g-row');
  const dismiss = el(document, 'button', 'g-btn', t('btnClose'));
  dismiss.title = t('tipClose');
  dismiss.addEventListener('click', close);
  const leave = el(document, 'button', 'g-btn primary', t('btnLeave'));
  leave.title = t('tipLeave');
  leave.addEventListener('click', () => {
    close();
    actions.leave();
  });
  row.append(dismiss, leave);
  card.append(row);
  backdrop.append(card);
  wrap.append(backdrop);
  r.append(wrap);
  leave.focus();
}

function bannerText(alert: AlertData): HTMLElement {
  const text = el(document, 'div', 'text');
  if (alert.kind === 'reputation' && alert.hits?.length) {
    text.append(el(document, 'strong', undefined, t('bannerReported')), ' ');
    const rep = whatOfReport(alert.hits);
    if (rep) {
      const what = el(document, 'strong', undefined, rep.what);
      if (rep.firstSeen) text.append(...tParts('repLine', [rep.source, what, longDate(rep.firstSeen, uiLang())]));
      else text.append(...tParts('repLineNoDate', [rep.source, what]));
    }
  } else if (alert.kind === 'web3-loader') {
    text.append(el(document, 'strong', undefined, t('bannerWeb3')), ' ', t('bannerWeb3Detail'));
  } else {
    text.append(el(document, 'strong', undefined, t('bannerInstructions')), ' ', t('bannerInstructionsDetail'));
  }
  return text;
}

function showBanner(alert: AlertData, actions: OverlayActions): void {
  if (shownBanners.has(alert.kind)) return;
  shownBanners.add(alert.kind);
  const r = root();
  const wrap = el(document, 'div', 'wrap');
  const bar = el(document, 'div', 'banner');
  bar.setAttribute('role', 'alert');
  const box = el(document, 'div', 'g-iconbox small');
  box.append(warnIcon(document, 20));
  const trust = el(document, 'button', 'g-btn small', t('btnTrust'));
  trust.title = t('tipTrust');
  trust.addEventListener('click', () => {
    const dialog = confirmDialog(document, {
      host: alert.host,
      reported: alert.kind === 'reputation',
      mode: 'trust',
      onConfirm: () => {
        bar.remove();
        actions.trust(alert.host);
      },
    });
    const holder = el(document, 'div', 'wrap');
    holder.append(dialog);
    r.append(holder);
  });
  const leave = el(document, 'button', 'g-btn primary small', t('btnLeave'));
  leave.title = t('tipLeave');
  leave.addEventListener('click', () => actions.leave());
  const close = el(document, 'button', 'close');
  close.title = t('tipClose');
  close.setAttribute('aria-label', t('btnClose'));
  close.append(closeIcon());
  close.addEventListener('click', () => bar.remove());
  bar.append(box, bannerText(alert));
  const rep = alert.kind === 'reputation' && alert.hits?.length ? whatOfReport(alert.hits) : null;
  if (rep && /^https:\/\/(urlhaus|threatfox|feodotracker)\.abuse\.ch\//.test(rep.ref)) {
    const details = el(document, 'a', 'g-btn small', t('bannerDetails'));
    details.href = rep.ref;
    details.target = '_blank';
    details.rel = 'noopener noreferrer';
    bar.append(details);
  }
  bar.append(trust, leave, close);
  wrap.append(bar);
  r.append(wrap);
}
