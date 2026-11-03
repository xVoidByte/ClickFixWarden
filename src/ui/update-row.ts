// The Updates row in the settings and the bar in the popup, both drawn from the status the background reports.

import { browser } from 'wxt/browser';
import type { AppUpdateStatus } from '../shared/app-update';
import { t } from '../shared/i18n';
import type { Message } from '../shared/messages';
import { el } from './graphite';

const send = <T>(msg: Message) => browser.runtime.sendMessage(msg) as Promise<T>;

export function updateLine(s: AppUpdateStatus): string {
  switch (s.state) {
    case 'ready':
      return t('updReady', s.version ?? '');
    case 'downloading':
      return t('updDownloading', s.version ?? '');
    case 'checking':
      return t('updChecking');
    case 'throttled':
      return t('updThrottled');
    case 'error':
      return t('updError');
    case 'auto':
      return t('updAuto');
    default:
      return t('updCurrent');
  }
}

function installButton(): HTMLButtonElement {
  const b = el(document, 'button', 'g-btn primary small', t('updApply'));
  b.title = t('tipUpdApply');
  b.addEventListener('click', () => {
    b.disabled = true;
    void send({ type: 'app-update-install' });
  });
  return b;
}

/** Settings row, with Check for updates, or Update now once the new version is downloaded. */
export function drawUpdateRow(box: HTMLElement, s: AppUpdateStatus): void {
  const info = el(document, 'div', 'grow');
  info.append(el(document, 'div', 'upd-version', t('updVersion', s.current)), el(document, 'div', 'muted small', updateLine(s)));
  const row = el(document, 'div', 'row');
  row.append(info);
  if (s.state === 'ready') row.append(installButton());
  else if (s.state !== 'auto' && s.state !== 'downloading') {
    const check = el(document, 'button', 'g-btn small', t('updCheck'));
    check.title = t('tipUpdCheck');
    check.disabled = s.state === 'checking';
    check.addEventListener('click', async () => {
      drawUpdateRow(box, { ...s, state: 'checking' });
      const next = await send<AppUpdateStatus>({ type: 'app-update-check' }).catch(() => undefined);
      drawUpdateRow(box, next ?? { ...s, state: 'error' });
    });
    row.append(check);
  }
  box.replaceChildren(row);
}

/** Popup bar, shown only while a newer version is on its way or ready. */
export function drawUpdateBar(box: HTMLElement, s: AppUpdateStatus): void {
  box.hidden = s.state !== 'ready' && s.state !== 'downloading';
  if (box.hidden) return;
  const text = el(document, 'span', undefined, updateLine(s));
  box.replaceChildren(text);
  if (s.state === 'ready') box.append(installButton());
}

/** Draws now and again whenever the background records a new download. */
export function watchUpdate(draw: (s: AppUpdateStatus) => void): void {
  const refresh = () =>
    void send<AppUpdateStatus>({ type: 'app-update-status' })
      .then((s) => s && draw(s))
      .catch(() => undefined);
  refresh();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.appUpdate) refresh();
  });
}
