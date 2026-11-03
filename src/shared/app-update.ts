// What the background knows about a newer version of the extension, shared by the popup and the settings page.

export type AppUpdateState = 'current' | 'auto' | 'checking' | 'downloading' | 'ready' | 'throttled' | 'error';

export interface AppUpdateStatus {
  state: AppUpdateState;
  /** The version that is installed now. */
  current: string;
  /** The newer version, once the store named one. */
  version?: string;
}

/** Kept in storage.local, so a page opened later still shows a download that finished. */
export interface StoredAppUpdate {
  version: string;
  ready: boolean;
  /** When the store named this version, a download that never finishes is forgotten after a day. */
  since: number;
  /** When we last restarted for it, so a version the browser fails to install cannot cause a restart loop. */
  tried?: number;
}

/** Compares dotted versions such as 0.1.10 and 0.1.9, a negative result means a is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
