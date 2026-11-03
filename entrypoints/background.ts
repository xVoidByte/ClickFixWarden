import { browser, type Browser } from 'wxt/browser';
import { lookupKeys } from '../src/feed/db';
import { APPLY_ALARM, appUpdateStatus, applyWhenSafe, checkNow, installNow, onDownloaded, tidyAfterStart } from '../src/background/app-update';
import { ipKey, lookupKeysForUrl } from '../src/feed/keys';
import type { FeedHit } from '../src/feed/types';
import { updateAll } from '../src/feed/update';
import { FEED_REFRESH_MINUTES } from '../src/shared/constants';
import { renewI18nOverride } from '../src/shared/i18n';
import { addDetection } from '../src/shared/log';
import type { Message, PageStatus, TabMessage } from '../src/shared/messages';
import { computeEffectiveSettings, type EffectiveSettings, isTrusted, normalizeSite, saveSettings } from '../src/shared/settings';

interface TabState {
  url: string;
  hits: FeedHit[];
  ipHits: FeedHit[];
  /** The tab could not be sent to the warning page, so the page must keep loading and show its warning bar. */
  redirectFailed?: boolean;
}

const ALARM = 'feed-update';
const tabs = new Map<number, TabState>();
let effective: Promise<EffectiveSettings> | null = null;

function getEffective(): Promise<EffectiveSettings> {
  if (!effective) {
    effective = computeEffectiveSettings().then(async (e) => {
      await browser.storage.local.set({ effective: e });
      return e;
    });
  }
  return effective;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function readTab(tabId: number): Promise<TabState | undefined> {
  const cached = tabs.get(tabId);
  if (cached) return cached;
  const key = `tab:${tabId}`;
  const stored = (await browser.storage.session.get(key))[key] as TabState | undefined;
  if (stored) tabs.set(tabId, stored);
  return stored;
}

async function writeTab(tabId: number, state: TabState): Promise<void> {
  tabs.set(tabId, state);
  await browser.storage.session.set({ [`tab:${tabId}`]: state });
}

async function setBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text: on ? '!' : '' });
    if (on) await browser.action.setBadgeBackgroundColor({ tabId, color: '#c5221f' });
  } catch {
    // the tab may be gone already
  }
}

async function isBypassed(host: string): Promise<boolean> {
  const { bypass } = (await browser.storage.session.get('bypass')) as { bypass?: Record<string, number> };
  const until = bypass?.[host];
  return typeof until === 'number' && until > Date.now();
}

async function addBypass(host: string): Promise<void> {
  const { bypass } = (await browser.storage.session.get('bypass')) as { bypass?: Record<string, number> };
  await browser.storage.session.set({ bypass: { ...(bypass ?? {}), [host]: Date.now() + 60 * 60 * 1000 } });
}

function warningUrl(target: string): string {
  return browser.runtime.getURL('/warning.html') + '?u=' + encodeURIComponent(target);
}

/** Looks up a top-level navigation and sends every reported address to the warning page before the site can react. */
async function checkNavigation(tabId: number, url: string): Promise<void> {
  if (tabId < 0 || !/^https?:/i.test(url)) return;
  const { settings } = await getEffective();
  const previous = await readTab(tabId);
  if (!settings.enabled || !settings.reputation) {
    await writeTab(tabId, { url, hits: [], ipHits: [] });
    await setBadge(tabId, false);
    return;
  }
  const host = hostOf(url);
  const hits = isTrusted(host, settings) ? [] : await lookupKeys(lookupKeysForUrl(url));
  const ipHits = previous?.url === url ? previous.ipHits : [];
  // A redirect that failed once for this address is not tried again, so a reload shows the page with its warning bar instead.
  const failedBefore = previous?.url === url && !!previous.redirectFailed;
  await writeTab(tabId, { url, hits, ipHits, ...(failedBefore ? { redirectFailed: true } : {}) });
  await setBadge(tabId, hits.length + ipHits.length > 0);
  if (hits.length && settings.blockPage && !failedBefore && !(await isBypassed(host))) {
    try {
      await browser.tabs.update(tabId, { url: warningUrl(url) });
    } catch {
      // A prerendered or closing tab cannot be redirected, reloading it shows the page with its usual warning bar.
      await writeTab(tabId, { url, hits, ipHits, redirectFailed: true });
      await browser.tabs.reload(tabId).catch(() => undefined);
      return;
    }
    await addDetection({
      kind: 'reputation-block',
      action: 'blocked',
      url,
      host,
      reasons: hits.flatMap((h) => h.records.map((r) => `${r.source}:${r.category}`)),
    });
  }
}

async function pageStatus(url: string, tabId: number | undefined): Promise<PageStatus> {
  const { settings } = await getEffective();
  const host = hostOf(url);
  const trusted = isTrusted(host, settings);
  if (!settings.enabled || !settings.reputation || trusted) return { hits: [], trusted };
  let state = tabId !== undefined ? await readTab(tabId) : undefined;
  if (!state || state.url !== url) {
    state = { url, hits: await lookupKeys(lookupKeysForUrl(url)), ipHits: state?.url === url ? state.ipHits : [] };
    if (tabId !== undefined) await writeTab(tabId, state);
  }
  // Worked out here as well, a page asking before the background finished its own lookup still learns that the warning page is coming.
  const blocked = state.hits.length > 0 && settings.blockPage && !state.redirectFailed && !(await isBypassed(host));
  return { hits: [...state.hits, ...state.ipHits], trusted, blocked };
}

async function leave(tabId: number): Promise<void> {
  const target = import.meta.env.FIREFOX ? 'about:newtab' : 'chrome://newtab/';
  try {
    await browser.tabs.update(tabId, { url: target });
  } catch {
    await browser.tabs.update(tabId, { url: 'about:blank' });
  }
}

async function handle(msg: Message, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'page-status':
      return pageStatus(msg.url, tabId);
    case 'lookup-url':
      return lookupKeys(lookupKeysForUrl(msg.url));
    case 'lookup-targets': {
      const keys = new Set<string>();
      for (const u of msg.urls.slice(0, 20)) for (const k of lookupKeysForUrl(u)) keys.add(k);
      return lookupKeys([...keys]);
    }
    case 'log': {
      const d = await addDetection(msg.detection);
      if (tabId !== undefined) await setBadge(tabId, true);
      return d;
    }
    case 'show-alert':
      if (tabId !== undefined && sender.frameId !== 0) {
        const forward: TabMessage = { type: 'show-alert', alert: msg.alert };
        await browser.tabs.sendMessage(tabId, forward, { frameId: 0 }).catch(() => undefined);
      }
      return true;
    case 'trust-site': {
      const { settings } = await getEffective();
      const site = normalizeSite(msg.host);
      if (site && !settings.trustedSites.includes(site)) await saveSettings({ trustedSites: [...settings.trustedSites, site] });
      return true;
    }
    case 'untrust-site': {
      const { settings } = await getEffective();
      const site = normalizeSite(msg.host);
      await saveSettings({ trustedSites: settings.trustedSites.filter((s) => s !== site) });
      return true;
    }
    case 'leave-site':
      if (tabId !== undefined) await leave(tabId);
      return true;
    case 'bypass': {
      const host = hostOf(msg.url);
      if (!host || tabId === undefined) return false;
      await addBypass(host);
      await addDetection({ kind: 'reputation-block', action: 'continued', url: msg.url, host, reasons: [] });
      await browser.tabs.update(tabId, { url: msg.url });
      return true;
    }
    case 'update-now':
      return updateAll({ forceBulk: true });
    case 'clear-log':
      await browser.storage.local.set({ log: [] });
      return true;
    case 'app-update-status':
      return appUpdateStatus();
    case 'app-update-check':
      return checkNow();
    case 'app-update-install':
      return installNow();
  }
}

/** Downloads the database when there is none yet, for example right after install or after a failed first try. */
async function ensureFeed(): Promise<void> {
  const { settings } = await getEffective();
  if (!settings.feedUpdates) return;
  const { feedMeta, updateState } = (await browser.storage.local.get(['feedMeta', 'updateState'])) as {
    feedMeta?: unknown;
    updateState?: { lastAttempt?: string };
  };
  if (feedMeta) return;
  const last = updateState?.lastAttempt ? Date.parse(updateState.lastAttempt) : 0;
  if (Date.now() - last < 2 * 60_000) return;
  await updateAll();
}

async function ensureAlarm(): Promise<void> {
  const alarm = await browser.alarms.get(ALARM);
  if (!alarm) await browser.alarms.create(ALARM, { periodInMinutes: FEED_REFRESH_MINUTES, delayInMinutes: 5 });
}

export default defineBackground(() => {
  // Each step stands alone, so a failing welcome tab cannot hold up the first download.
  browser.runtime.onInstalled.addListener((details) => {
    void ensureAlarm().catch(() => undefined);
    if (details.reason === 'install') {
      void Promise.resolve(browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '?welcome=1' })).catch(() => undefined);
    }
    void ensureFeed().catch(() => undefined);
  });

  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm().catch(() => undefined);
  });

  // Registered at the top so the browser hands the finished download to us instead of waiting for a browser restart.
  browser.runtime.onUpdateAvailable.addListener((details) => {
    void onDownloaded(details.version).catch(() => undefined);
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === APPLY_ALARM) {
      await applyWhenSafe();
      return;
    }
    if (alarm.name !== ALARM) return;
    const { settings } = await getEffective();
    if (settings.feedUpdates) await updateAll();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && changes.settings) || area === 'managed') {
      effective = null;
      void getEffective();
    }
  });

  browser.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId === 0) void checkNavigation(d.tabId, d.url);
  });

  browser.webNavigation.onCommitted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const state = await readTab(d.tabId);
    if (!state || state.url !== d.url) void checkNavigation(d.tabId, d.url);
  });

  browser.webRequest.onResponseStarted.addListener(
    (d) => {
      const ip = (d as { ip?: string }).ip;
      if (!ip || d.tabId < 0) return;
      void (async () => {
        const { settings } = await getEffective();
        if (!settings.enabled || !settings.reputation || isTrusted(hostOf(d.url), settings)) return;
        const ipHits = await lookupKeys([ipKey(ip)]);
        if (!ipHits.length) return;
        const state = (await readTab(d.tabId)) ?? { url: d.url, hits: [], ipHits: [] };
        await writeTab(d.tabId, { ...state, url: d.url, ipHits });
        await setBadge(d.tabId, true);
        const msg: TabMessage = { type: 'reputation-update' };
        await browser.tabs.sendMessage(d.tabId, msg, { frameId: 0 }).catch(() => undefined);
      })();
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  browser.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
    void browser.storage.session.remove(`tab:${tabId}`);
  });

  browser.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
    handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });

  void getEffective();
  void ensureAlarm().catch(() => undefined);
  void ensureFeed().catch(() => undefined);
  void tidyAfterStart()
    .then(applyWhenSafe)
    .catch(() => undefined);
  // A picked language keeps a copy of its texts, after an update that copy is renewed from the new version.
  void renewI18nOverride().catch(() => undefined);
});
