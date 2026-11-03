import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small stand-in for the extension APIs the update code calls, with one place to change the store's answer.
const store: Record<string, unknown> = {};
const calls = { reload: 0, alarms: [] as string[], titles: [] as string[] };
let openPages = 0;
let checkAnswer: { status: string; version?: string } | null = { status: 'no_update' };
let duringCheck: (() => Promise<void>) | null = null;

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      reload: () => void calls.reload++,
      get requestUpdateCheck() {
        return checkAnswer
          ? async () => {
              if (duringCheck) await duringCheck();
              return checkAnswer;
            }
          : undefined;
      },
      getContexts: async () => Array.from({ length: openPages }, () => ({})),
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) => void Object.assign(store, items),
        remove: async (key: string) => void delete store[key],
      },
    },
    alarms: { create: async (name: string) => void calls.alarms.push(name) },
    action: { setTitle: async ({ title }: { title: string }) => void calls.titles.push(title) },
    i18n: { getMessage: (key: string, subs?: string[]) => (subs?.length ? `${key}:${subs.join(',')}` : key) },
  },
}));

const update = await import('../../src/background/app-update');
const { compareVersions } = await import('../../src/shared/app-update');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  calls.reload = 0;
  calls.alarms = [];
  calls.titles = [];
  openPages = 0;
  checkAnswer = { status: 'no_update' };
  duringCheck = null;
});

describe('versions', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });
});

describe('checking the store', () => {
  it('reports the latest version when the store has nothing newer', async () => {
    expect((await update.checkNow()).state).toBe('current');
  });
  it('remembers a newer version while it downloads', async () => {
    checkAnswer = { status: 'update_available', version: '0.1.1' };
    expect(await update.checkNow()).toMatchObject({ state: 'downloading', version: '0.1.1' });
    expect((await update.appUpdateStatus()).state).toBe('downloading');
  });
  it('keeps a download that finished while the store was being asked', async () => {
    openPages = 1;
    checkAnswer = { status: 'update_available', version: '0.1.1' };
    duringCheck = () => update.onDownloaded('0.1.1');
    expect((await update.checkNow()).state).toBe('ready');
    expect((await update.appUpdateStatus()).state).toBe('ready');
  });
  it('passes on a throttled answer', async () => {
    checkAnswer = { status: 'throttled' };
    expect((await update.checkNow()).state).toBe('throttled');
  });
  it('falls back to automatic updates where the browser has no check, like Firefox', async () => {
    checkAnswer = null;
    expect((await update.checkNow()).state).toBe('auto');
  });
});

describe('installing', () => {
  it('restarts at once when none of our pages is open', async () => {
    await update.onDownloaded('0.1.1');
    expect(calls.reload).toBe(1);
    expect(calls.titles.at(-1)).toBe('tipActionUpdate:0.1.1');
  });
  it('waits while the warning page, the settings or the popup is open', async () => {
    openPages = 1;
    await update.onDownloaded('0.1.1');
    expect(calls.reload).toBe(0);
    expect(calls.alarms).toContain(update.APPLY_ALARM);
    expect((await update.appUpdateStatus()).state).toBe('ready');
    openPages = 0;
    await update.applyWhenSafe();
    expect(calls.reload).toBe(1);
  });
  it('never restarts in a loop when the browser keeps the old version', async () => {
    await update.onDownloaded('0.1.1');
    await update.tidyAfterStart();
    await update.applyWhenSafe();
    await update.applyWhenSafe();
    expect(calls.reload).toBe(1);
  });
  it('never restarts in a loop when the browser announces the same version again', async () => {
    await update.onDownloaded('0.1.1');
    await update.onDownloaded('0.1.1');
    await update.onDownloaded('0.1.1');
    expect(calls.reload).toBe(1);
  });
  it('forgets an update once it is installed', async () => {
    store.appUpdate = { version: '0.1.0', ready: true, since: Date.now() };
    await update.tidyAfterStart();
    expect(store.appUpdate).toBeUndefined();
    expect((await update.appUpdateStatus()).state).toBe('current');
  });
  it('forgets a download that never finished after a day', async () => {
    store.appUpdate = { version: '0.1.1', ready: false, since: Date.now() - 25 * 60 * 60 * 1000 };
    expect((await update.appUpdateStatus()).state).toBe('current');
  });
  it('Update now does nothing before the download is ready', async () => {
    store.appUpdate = { version: '0.1.1', ready: false, since: Date.now() };
    expect(await update.installNow()).toBe(false);
    expect(calls.reload).toBe(0);
  });
});
