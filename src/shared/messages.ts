import type { FeedHit } from '../feed/types';

export type DetectionKind =
  | 'clipboard'
  | 'manual-copy'
  | 'paste'
  | 'protocol'
  | 'fullscreen'
  | 'page-instructions'
  | 'web3-loader'
  | 'reputation'
  | 'reputation-block';

export type DetectionAction = 'blocked' | 'warned' | 'copied-anyway' | 'continued' | 'trusted';

export interface Detection {
  id: string;
  time: string;
  kind: DetectionKind;
  action: DetectionAction;
  url: string;
  host: string;
  score?: number;
  reasons: string[];
  what?: string;
}

/** What an in-page warning shows, the two bold phrases say what was found and why it was stopped. */
export interface AlertData {
  kind: DetectionKind;
  host: string;
  score?: number;
  what?: string;
  why?: string;
  hits?: FeedHit[];
}

export interface PageStatus {
  hits: FeedHit[];
  trusted: boolean;
  /** The background is already sending this tab to the warning page. */
  blocked?: boolean;
}

export type Message =
  | { type: 'page-status'; url: string }
  | { type: 'lookup-targets'; urls: string[] }
  | { type: 'lookup-url'; url: string }
  | { type: 'log'; detection: Omit<Detection, 'id' | 'time'> }
  | { type: 'show-alert'; alert: AlertData }
  | { type: 'trust-site'; host: string }
  | { type: 'untrust-site'; host: string }
  | { type: 'leave-site' }
  | { type: 'bypass'; url: string }
  | { type: 'update-now' }
  | { type: 'clear-log' }
  | { type: 'app-update-status' }
  | { type: 'app-update-check' }
  | { type: 'app-update-install' };

/** Messages the background sends into a tab. */
export type TabMessage = { type: 'reputation-update' } | { type: 'show-alert'; alert: AlertData };
