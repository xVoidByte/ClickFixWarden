// Finds and installs newer versions from the add-on store, never while one of our pages is open, and nothing leaves for anyone but the store.

import { browser } from 'wxt/browser';
import { type AppUpdateStatus, compareVersions, type StoredAppUpdate } from '../shared/app-update';
import { loadI18nOverride, t } from '../shared/i18n';

export const APPLY_ALARM = 'apply-update';
const DAY = 24 * 60 * 60 * 1000;
const RETRY_AFTER = 6 * 60 * 60 * 1000;

type CheckResult = { status: 'throttled' | 'no_update' | 'update_available'; version?: string };
type RuntimeExtras = {
  requestUpdateCheck?: () => Promise<CheckResult | [string, { version?: string }]>;
  getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
};
const runtime = browser.runtime as unknown as RuntimeExtras;

const current = () => browser.runtime.getManifest().version;

async function stored(): Promise<StoredAppUpdate | undefined> {
  const { appUpdate } = (await browser.storage.local.get('appUpdate')) as { appUpdate?: StoredAppUpdate };
  if (!appUpdate || compareVersions(appUpdate.version, current()) <= 0) return undefined;
  if (!appUpdate.ready && Date.now() - (appUpdate.since ?? 0) > DAY) return undefined;
  return appUpdate;
}

async function setToolbarTitle(version: string | null): Promise<void> {
  try {
    await loadI18nOverride();
    await browser.action.setTitle({ title: version ? t('tipActionUpdate', version) : t('extName') });
  } catch {
    // the toolbar button may be hidden
  }
}

/** A tab showing the warning page, the settings or an open popup would close on restart, so the update waits for them. */
async function ourPagesOpen(): Promise<boolean> {
  if (!runtime.getContexts) return false;
  try {
    return (await runtime.getContexts({ contextTypes: ['TAB', 'POPUP'] })).length > 0;
  } catch {
    return false;
  }
}

/** Restarts into the downloaded version as soon as none of our pages is open, else looks again in a minute. */
export async function applyWhenSafe(): Promise<void> {
  const pending = await stored();
  if (!pending?.ready) return;
  // Already restarted for this version and still on the old one, the browser will finish it on its next start.
  if (pending.tried && Date.now() - pending.tried < RETRY_AFTER) return;
  if (await ourPagesOpen()) {
    await browser.alarms.create(APPLY_ALARM, { delayInMinutes: 1 });
    return;
  }
  await restart(pending);
}

async function restart(pending: StoredAppUpdate): Promise<void> {
  await browser.storage.local.set({ appUpdate: { ...pending, tried: Date.now() } satisfies StoredAppUpdate });
  browser.runtime.reload();
}

/** The browser finished downloading a newer version. Listening delays it until we restart, which applyWhenSafe does. */
export async function onDownloaded(version: string): Promise<void> {
  // The browser may announce a version again after a restart that did not install it, the last try must survive that.
  const before = await stored();
  const tried = before?.version === version ? before.tried : undefined;
  await browser.storage.local.set({ appUpdate: { version, ready: true, since: before?.version === version ? before.since : Date.now(), tried } satisfies StoredAppUpdate });
  await setToolbarTitle(version);
  await applyWhenSafe();
}

/** On every start, forgets an update that is installed now and shows one that is still waiting. */
export async function tidyAfterStart(): Promise<void> {
  const pending = await stored();
  if (!pending) {
    await browser.storage.local.remove('appUpdate');
    return;
  }
  if (pending.ready) await setToolbarTitle(pending.version);
}

export async function appUpdateStatus(): Promise<AppUpdateStatus> {
  const pending = await stored();
  if (pending) return { state: pending.ready ? 'ready' : 'downloading', current: current(), version: pending.version };
  return { state: runtime.requestUpdateCheck ? 'current' : 'auto', current: current() };
}

/** Asks the store right away, the same request the browser itself sends every few hours. Firefox has no such call and updates on its own. */
export async function checkNow(): Promise<AppUpdateStatus> {
  const pending = await stored();
  if (pending?.ready || !runtime.requestUpdateCheck) return appUpdateStatus();
  try {
    const raw = await runtime.requestUpdateCheck();
    const result: CheckResult = Array.isArray(raw) ? { status: raw[0] as CheckResult['status'], version: raw[1]?.version } : raw;
    if (result.status === 'update_available' && result.version && compareVersions(result.version, current()) > 0) {
      // The browser may have finished the download while we waited, that record must not go back to downloading.
      const now = await stored();
      if (now?.ready && compareVersions(now.version, result.version) >= 0) return appUpdateStatus();
      await browser.storage.local.set({ appUpdate: { version: result.version, ready: false, since: Date.now() } satisfies StoredAppUpdate });
      return { state: 'downloading', current: current(), version: result.version };
    }
    if (result.status === 'throttled') return { state: 'throttled', current: current() };
    return { state: 'current', current: current() };
  } catch {
    return { state: 'error', current: current() };
  }
}

/** The visitor pressed Update now, a popup or settings tab closing with the restart is expected. */
export async function installNow(): Promise<boolean> {
  const pending = await stored();
  if (!pending?.ready) return false;
  await restart(pending);
  return true;
}
