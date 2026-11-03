import { browser } from 'wxt/browser';
import { BUNDLED_RULES, pickRules } from '../../src/engine/rules';
import { lookupKeys } from '../../src/feed/db';
import { lookupKeysForUrl } from '../../src/feed/keys';
import { type FeedMeta, type FeedRecord, SOURCE_NAMES, type UpdateState } from '../../src/feed/types';
import type { UpdateResult } from '../../src/feed/update';
import { DONATE_URL, PRIVACY_URL, PROJECT_URL } from '../../src/shared/constants';
import { chooseLanguage, LANGUAGES, loadI18nOverride, localizePage, overrideLang, relativeTime, t, uiLang, uiLocaleCode } from '../../src/shared/i18n';
import { longDate } from '../../src/ui/explain';
import type { Detection, Message } from '../../src/shared/messages';
import { computeEffectiveSettings, type EffectiveSettings, normalizeSite, saveSettings, type Settings } from '../../src/shared/settings';
import { askDialog, confirmDialog } from '../../src/ui/graphite';
import { addPageParts } from '../../src/ui/page-parts';
import { drawUpdateRow, watchUpdate } from '../../src/ui/update-row';

addPageParts();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: Message) => browser.runtime.sendMessage(msg) as Promise<T>;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A drawn info mark, a dot over a rounded stem. */
function infoIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '8');
  dot.setAttribute('cy', '4.4');
  dot.setAttribute('r', '1.35');
  dot.setAttribute('fill', 'currentColor');
  const stem = document.createElementNS(SVG_NS, 'path');
  stem.setAttribute('d', 'M8 7.6 V12');
  stem.setAttribute('stroke', 'currentColor');
  stem.setAttribute('stroke-width', '2.1');
  stem.setAttribute('stroke-linecap', 'round');
  svg.append(dot, stem);
  return svg;
}

function tip(key: string): HTMLElement {
  const s = make('span', { className: 'tip', tabIndex: 0 }, infoIcon());
  s.dataset.tip = t(key);
  s.setAttribute('aria-label', t(key));
  return s;
}

function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = make('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// ---- protection toggles ----
const TOGGLES: { key: keyof Settings; label: string; tip: string; sub?: boolean }[] = [
  { key: 'enabled', label: 'setEnabled', tip: 'tipEnabled' },
  { key: 'clipboard', label: 'setClipboard', tip: 'tipClipboard' },
  { key: 'paste', label: 'setPaste', tip: 'tipPaste' },
  { key: 'protocols', label: 'setProtocols', tip: 'tipProtocols' },
  { key: 'fullscreen', label: 'setFullscreen', tip: 'tipFullscreen' },
  { key: 'pageWarnings', label: 'setPageWarnings', tip: 'tipPageWarnings' },
  { key: 'web3', label: 'setWeb3', tip: 'tipWeb3' },
  { key: 'reputation', label: 'setReputation', tip: 'tipReputation' },
  { key: 'blockPage', label: 'setBlockPage', tip: 'tipBlockPage', sub: true },
  { key: 'feedUpdates', label: 'setFeedUpdates', tip: 'tipFeedUpdates' },
];

let eff: EffectiveSettings;

function locked(key: string): boolean {
  return eff.locked || eff.managedKeys.includes(key);
}

function languageRow(): HTMLElement {
  const select = make('select', { id: 'language' });
  select.append(make('option', { value: '', textContent: t('langBrowser') }));
  for (const l of LANGUAGES) select.append(make('option', { value: l.code, textContent: l.name }));
  select.value = overrideLang();
  select.addEventListener('change', async () => {
    select.disabled = true;
    await chooseLanguage(select.value);
    location.reload();
  });
  const label = make('label', { htmlFor: 'language', className: 'grow', textContent: t('setLanguage') });
  return make('div', { className: 'row lang' }, label, tip('tipLanguage'), select);
}

const toggleInputs = new Map<keyof Settings, HTMLInputElement>();

/** Built once, later calls only update the switches, so a switch the visitor flips keeps its slide. */
function renderToggles(): void {
  if (toggleInputs.size) {
    for (const item of TOGGLES) {
      const input = toggleInputs.get(item.key)!;
      input.checked = eff.settings[item.key] as boolean;
      input.disabled = locked(item.key);
    }
    return;
  }
  const box = $('toggles');
  box.replaceChildren(languageRow());
  for (const item of TOGGLES) {
    const input = make('input', { type: 'checkbox', checked: eff.settings[item.key] as boolean, disabled: locked(item.key) });
    input.id = 'set-' + item.key;
    toggleInputs.set(item.key, input);
    input.addEventListener('change', async () => {
      await saveSettings({ [item.key]: input.checked } as Partial<Settings>);
      await refresh();
    });
    const label = make('label', { htmlFor: input.id, className: 'grow' + (item.sub ? ' sub' : ''), textContent: t(item.label) });
    const sw = make('span', { className: 'switch' }, input, make('span', { className: 'track' }), make('span', { className: 'knob' }));
    box.append(make('div', { className: 'row setting' }, label, tip(item.tip), sw));
  }
}

// ---- trusted sites ----
function renderSites(): void {
  const list = $('sites');
  list.replaceChildren();
  if (!eff.settings.trustedSites.length) list.append(make('div', { className: 'row muted', textContent: t('trustedEmpty') }));
  for (const site of eff.settings.trustedSites) {
    const remove = make('button', { className: 'g-btn small', textContent: t('trustedRemove'), title: t('tipTrustedRemove'), disabled: locked('trustedSites') });
    remove.addEventListener('click', async () => {
      await saveSettings({ trustedSites: eff.settings.trustedSites.filter((s) => s !== site) });
      await refresh();
    });
    list.append(make('div', { className: 'row' }, make('span', { className: 'grow', textContent: site }), remove));
  }
  $<HTMLButtonElement>('addSite').disabled = locked('trustedSites');
  $<HTMLInputElement>('siteInput').disabled = locked('trustedSites');
}

$('addSite').addEventListener('click', () => {
  const input = $<HTMLInputElement>('siteInput');
  const site = normalizeSite(input.value);
  if (!site || !site.includes('.') || eff.settings.trustedSites.includes(site)) return;
  // Trusting a site here needs the same confirmation as in a warning.
  document.body.append(
    confirmDialog(document, {
      host: site,
      reported: false,
      mode: 'trust',
      onConfirm: async () => {
        await saveSettings({ trustedSites: [...eff.settings.trustedSites, site] });
        input.value = '';
        await refresh();
      },
    }),
  );
});
$('siteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('addSite').click();
});

// ---- custom warning text ----
$('saveWarning').addEventListener('click', async () => {
  await saveSettings({ customWarning: $<HTMLTextAreaElement>('customWarning').value.trim() });
  $('savedNote').hidden = false;
  setTimeout(() => ($('savedNote').hidden = true), 2000);
  await refresh();
});

// ---- history check ----
interface HistoryFinding {
  url: string;
  title: string;
  lastVisit: string;
  records: FeedRecord[];
}
let historyFindings: HistoryFinding[] = [];

async function runHistoryScan(days: number): Promise<void> {
  const out = $('historyResult');
  out.replaceChildren(make('p', { className: 'muted', textContent: t('historyScanning') }));
  const history = (browser as unknown as { history: typeof browser.history }).history;
  const items = await history.search({ text: '', startTime: Date.now() - days * 86_400_000, maxResults: 100_000 });
  const byKey = new Map<string, typeof items>();
  for (const item of items) {
    if (!item.url) continue;
    for (const key of lookupKeysForUrl(item.url)) {
      const list = byKey.get(key);
      if (list) list.push(item);
      else byKey.set(key, [item]);
    }
  }
  const keys = [...byKey.keys()];
  const found = new Map<string, HistoryFinding>();
  for (let i = 0; i < keys.length; i += 4000) {
    const hits = await lookupKeys(keys.slice(i, i + 4000));
    for (const hit of hits) {
      for (const item of byKey.get(hit.key) ?? []) {
        const f = found.get(item.url!) ?? {
          url: item.url!,
          title: item.title ?? '',
          lastVisit: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : '',
          records: [],
        };
        f.records.push(...hit.records);
        found.set(item.url!, f);
      }
    }
  }
  historyFindings = [...found.values()].sort((a, b) => b.lastVisit.localeCompare(a.lastVisit));
  out.replaceChildren(make('p', { textContent: t('historyChecked', [String(items.length), String(days)]) }));
  $('exportHistory').hidden = false;
  if (!historyFindings.length) {
    out.append(make('p', { className: 'ok', textContent: t('historyClean') }));
    return;
  }
  out.append(make('p', {}, make('strong', { className: 'red', textContent: t('historyFound', String(historyFindings.length)) })));
  out.append(make('p', { className: 'muted', textContent: t('historyAdvice') }));
  const table = make('table');
  table.append(make('tr', {}, make('th', { textContent: t('colVisited') }), make('th', { textContent: t('colAddress') }), make('th', { textContent: t('colReport') })));
  for (const f of historyFindings.slice(0, 300)) {
    const report = make('td');
    for (const r of f.records) {
      const line = make('div', { textContent: [SOURCE_NAMES[r.source], t('category_' + r.category), r.malware, r.firstSeen].filter(Boolean).join(', ') + ' ' });
      if (/^https:\/\/(urlhaus|threatfox|feodotracker)\.abuse\.ch\//.test(r.ref))
        line.append(make('a', { className: 'g-btn small', href: r.ref, target: '_blank', rel: 'noopener noreferrer', textContent: t('bannerDetails') }));
      report.append(line);
    }
    table.append(make('tr', {}, make('td', { textContent: f.lastVisit ? new Date(f.lastVisit).toLocaleString() : '' }), make('td', { className: 'url', textContent: f.url }), report));
  }
  out.append(make('div', { className: 'table-wrap' }, table));
}

$('scanHistory').addEventListener('click', () => {
  const days = Number($<HTMLSelectElement>('historyDays').value) || 30;
  // The permission prompt has to open straight from the click.
  browser.permissions.request({ permissions: ['history'] }).then(async (granted) => {
    if (!granted) {
      $('historyResult').replaceChildren(make('p', { className: 'muted', textContent: t('historyDenied') }));
      return;
    }
    $('dropHistory').hidden = false;
    await saveSettings({ historyDays: days });
    try {
      await runHistoryScan(days);
    } catch (e) {
      $('historyResult').replaceChildren(make('p', { className: 'muted', textContent: String(e) }));
    }
  });
});
$('exportHistory').addEventListener('click', () => download(`clickfix-warden-history-${stamp()}.json`, historyFindings));
$('dropHistory').addEventListener('click', async () => {
  await browser.permissions.remove({ permissions: ['history'] });
  $('dropHistory').hidden = true;
});

// ---- extensions check ----
$('scanExtensions').addEventListener('click', () => {
  browser.permissions.request({ permissions: ['management'] }).then(async (granted) => {
    const out = $('extensionsResult');
    if (!granted) {
      out.replaceChildren(make('p', { className: 'muted', textContent: t('extensionsDenied') }));
      return;
    }
    $('dropManagement').hidden = false;
    const { rules: stored } = await browser.storage.local.get('rules');
    const rules = pickRules(stored);
    const management = (browser as unknown as { management: typeof browser.management }).management;
    const all = await management.getAll();
    const bad = new Map(rules.extensions.malicious.map((m) => [m.id, m]));
    const found = all.filter((ext) => bad.has(ext.id));
    out.replaceChildren(make('p', { textContent: t('extensionsChecked', String(all.length)) }));
    if (!found.length) {
      out.append(make('p', { className: 'ok', textContent: t('extensionsClean') }));
      return;
    }
    for (const ext of found) {
      const remove = make('button', { className: 'g-btn danger small', textContent: t('extensionsRemove'), title: t('tipExtensionsRemove') });
      remove.addEventListener('click', () => void management.uninstall(ext.id, { showConfirmDialog: true }));
      const info = bad.get(ext.id)!;
      out.append(
        make(
          'div',
          { className: 'found' },
          make('strong', { className: 'red', textContent: `${ext.name} (${ext.id})` }),
          make('div', { className: 'muted', textContent: t('extensionsKnownAs', info.name) }),
          make('div', { className: 'inline' }, remove, make('a', { className: 'g-btn small', href: info.ref, target: '_blank', rel: 'noopener noreferrer', textContent: t('bannerDetails') })),
        ),
      );
    }
  });
});
$('dropManagement').addEventListener('click', async () => {
  await browser.permissions.remove({ permissions: ['management'] });
  $('dropManagement').hidden = true;
});

// ---- detection log ----
async function renderLog(): Promise<Detection[]> {
  const { log } = (await browser.storage.local.get('log')) as { log?: Detection[] };
  const list = log ?? [];
  const box = $('logTable');
  box.replaceChildren();
  if (!list.length) {
    box.append(make('p', { className: 'muted', textContent: t('popupNoDetections') }));
    return list;
  }
  const table = make('table');
  table.append(
    make('tr', {}, make('th', { textContent: t('colTime') }), make('th', { textContent: t('colWhat') }), make('th', { textContent: t('colSite') }), make('th', { className: 'opt', textContent: t('colDetails') })),
  );
  for (const d of list.slice(0, 200)) {
    // What was found, never the command itself, so nobody copies it from here.
    const details = make('td', { className: 'opt', textContent: d.what ?? '' });
    table.append(
      make(
        'tr',
        {},
        make('td', { textContent: new Date(d.time).toLocaleString() }),
        make('td', { textContent: t('kindAction', [t('kind_' + d.kind.replace(/-/g, '_')), t('action_' + d.action.replace(/-/g, '_'))]) }),
        make('td', { className: 'url', textContent: d.host || d.url }),
        details,
      ),
    );
  }
  box.append(table);
  return list;
}
$('exportLog').addEventListener('click', async () => {
  const { log } = (await browser.storage.local.get('log')) as { log?: Detection[] };
  download(`clickfix-warden-log-${stamp()}.json`, log ?? []);
});
$('clearLog').addEventListener('click', () => {
  document.body.append(
    askDialog(document, {
      title: t('logClearConfirm'),
      body: t('logClearBody'),
      confirmLabel: t('logClear'),
      onConfirm: () => void send({ type: 'clear-log' }).then(renderLog),
    }),
  );
});

// ---- database ----
async function renderDatabase(): Promise<void> {
  const { feedMeta, updateState, rules } = (await browser.storage.local.get(['feedMeta', 'updateState', 'rules'])) as {
    feedMeta?: FeedMeta;
    updateState?: UpdateState;
    rules?: unknown;
  };
  const status = $('dbStatus');
  const active = pickRules(rules);
  const lines = [
    feedMeta ? t('dbGenerated', [String(feedMeta.count), relativeTime(feedMeta.generated)]) : t('popupFeedNone'),
    feedMeta ? t('dbChecked', relativeTime(feedMeta.checked)) : '',
    t('popupRulesLine', [longDate(active.updated, uiLang()), active === BUNDLED_RULES ? t('popupRulesBundled') : t('popupRulesUpdated')]),
    updateState?.lastError ? t('dbError', updateState.lastError) : '',
  ].filter(Boolean);
  status.replaceChildren(...lines.map((l) => make('div', { textContent: l })));
  const sources = $('dbSources');
  sources.replaceChildren(...(feedMeta?.sources ?? []).map((s) => make('li', { textContent: `${SOURCE_NAMES[s.id] ?? s.name}: ${s.count}` })));
}
$('updateNow').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('updateNow');
  btn.disabled = true;
  $('updateResult').textContent = t('popupUpdating');
  const result = await send<UpdateResult>({ type: 'update-now' });
  btn.disabled = false;
  $('updateResult').textContent = result?.error ? t('dbError', result.error) : t('dbUpdated');
  await renderDatabase();
});

// ---- about and welcome ----
$<HTMLAnchorElement>('projectLink').href = PROJECT_URL;
if (DONATE_URL) {
  const d = $<HTMLAnchorElement>('donateLink');
  d.href = DONATE_URL;
  d.hidden = false;
}
$('version').textContent = `v${browser.runtime.getManifest().version}`;

async function checkHostAccess(): Promise<void> {
  const granted = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('hostAccess').hidden = granted;
  if (!granted) $('welcome').hidden = false;
}
$('grantHosts').addEventListener('click', () => {
  browser.permissions.request({ origins: ['<all_urls>'] }).then(() => checkHostAccess());
});
if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;

async function refresh(): Promise<void> {
  eff = await computeEffectiveSettings();
  $('managedNote').hidden = !(eff.locked || eff.managedKeys.length);
  renderToggles();
  renderSites();
  const ta = $<HTMLTextAreaElement>('customWarning');
  ta.value = eff.settings.customWarning;
  ta.disabled = locked('customWarning');
  $<HTMLButtonElement>('saveWarning').disabled = locked('customWarning');
  $<HTMLSelectElement>('historyDays').value = String(eff.settings.historyDays);
}

void (async () => {
  await loadI18nOverride();
  localizePage();
  $<HTMLAnchorElement>('privacyLink').href = PRIVACY_URL + '?lang=' + uiLocaleCode();
  await refresh();
  await renderLog();
  await renderDatabase();
  watchUpdate((s) => drawUpdateRow($('appUpdate'), s));
  await checkHostAccess();
  if (await browser.permissions.contains({ permissions: ['history'] })) $('dropHistory').hidden = false;
  if (await browser.permissions.contains({ permissions: ['management'] })) $('dropManagement').hidden = false;
})();

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.log) void renderLog();
  if (changes.feedMeta || changes.updateState || changes.rules) void renderDatabase();
});
