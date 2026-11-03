import { browser } from 'wxt/browser';
import type { FeedMeta, UpdateState } from '../../src/feed/types';
import { DONATE_URL } from '../../src/shared/constants';
import { loadI18nOverride, localizePage, relativeTime, t, tParts } from '../../src/shared/i18n';
import type { Detection, Message, PageStatus } from '../../src/shared/messages';
import { computeEffectiveSettings, isTrusted, saveSettings } from '../../src/shared/settings';
import { confirmDialog, el } from '../../src/ui/graphite';
import { addPageParts } from '../../src/ui/page-parts';
import { drawUpdateBar, watchUpdate } from '../../src/ui/update-row';

addPageParts();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: Message) => browser.runtime.sendMessage(msg) as Promise<T>;
const RECENT_MS = 30 * 60 * 1000;

function kindLine(d: Detection): string {
  return t('kindAction', [t('kind_' + d.kind.replace(/-/g, '_')), t('action_' + d.action.replace(/-/g, '_'))]);
}

async function render(): Promise<void> {
  const eff = await computeEffectiveSettings();
  const enabled = $<HTMLInputElement>('enabled');
  enabled.checked = eff.settings.enabled;
  enabled.disabled = eff.locked || eff.managedKeys.includes('enabled');
  $('offNote').hidden = eff.settings.enabled;

  const { log } = (await browser.storage.local.get('log')) as { log?: Detection[] };
  const entries = (log ?? []).filter((d) => d.action !== 'trusted');

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch {
    // not a web page
  }
  const status = $('status');
  const trust = $<HTMLButtonElement>('trust');
  status.replaceChildren();
  trust.hidden = true;
  if (!host) {
    $('host').textContent = t('popupNotWebPage');
  } else {
    $('host').textContent = host;
    const trusted = isTrusted(host, eff.settings);
    const page = await send<PageStatus>({ type: 'page-status', url });
    const recent = entries.find((d) => d.host === host && d.action === 'blocked' && Date.now() - Date.parse(d.time) < RECENT_MS);
    if (trusted) status.append(t('popupTrusted'));
    else if (recent?.what) status.append(...tParts('popupBlockedLine', [el(document, 'strong', 'red', recent.what), relativeTime(recent.time)]));
    else if (page?.hits?.length) status.append(el(document, 'strong', 'red', t('popupReported')));
    else status.append(t('popupNoReports'));
    if (!eff.locked) {
      trust.hidden = false;
      trust.textContent = trusted ? t('popupUntrust') : t('btnTrust');
      trust.title = trusted ? t('tipUntrust') : t('tipTrust');
      trust.onclick = () => {
        if (trusted) {
          void send({ type: 'untrust-site', host }).then(() => setTimeout(render, 150));
          return;
        }
        document.body.append(
          confirmDialog(document, {
            host,
            reported: !!page?.hits?.length,
            mode: 'trust',
            onConfirm: () => void send({ type: 'trust-site', host }).then(() => setTimeout(render, 150)),
          }),
        );
      };
    }
  }

  const { feedMeta, updateState } = (await browser.storage.local.get(['feedMeta', 'updateState'])) as {
    feedMeta?: FeedMeta;
    updateState?: UpdateState;
  };
  const stats = $('stats');
  stats.replaceChildren();
  if (feedMeta?.count) {
    const first = el(document, 'div');
    first.append(...tParts('popupReports', [el(document, 'strong', undefined, feedMeta.count.toLocaleString())]));
    stats.append(first, el(document, 'div', undefined, t('popupUpdated', relativeTime(feedMeta.generated))));
  } else {
    stats.append(el(document, 'div', undefined, updateState?.lastError ? t('popupFeedError') : t('popupFeedNone')));
  }

  const recentBox = $('recent');
  recentBox.replaceChildren();
  const items = entries.slice(0, 3);
  if (!items.length) recentBox.append(el(document, 'div', 'item', t('popupNoDetections')));
  for (const d of items) {
    const row = el(document, 'div', 'item');
    row.append(el(document, 'span', undefined, kindLine(d)), el(document, 'span', undefined, relativeTime(d.time)));
    row.title = d.host;
    recentBox.append(row);
  }
}

$<HTMLInputElement>('enabled').addEventListener('change', async (e) => {
  await saveSettings({ enabled: (e.target as HTMLInputElement).checked });
  setTimeout(render, 150);
});
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  void browser.runtime.openOptionsPage();
  window.close();
});
$('openHistory').addEventListener('click', (e) => {
  e.preventDefault();
  void browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '#history' });
  window.close();
});
if (DONATE_URL) {
  const donate = $<HTMLAnchorElement>('donate');
  donate.hidden = false;
  donate.href = DONATE_URL;
  donate.target = '_blank';
  donate.rel = 'noopener noreferrer';
}

void (async () => {
  await loadI18nOverride();
  localizePage();
  watchUpdate((s) => drawUpdateBar($('appUpdate'), s));
  await render();
})();
