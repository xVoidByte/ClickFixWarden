export type Lang = 'en' | 'bg';
export type Label = { en: string } & Partial<Record<string, string>>;

export type CommandCategory = 'exec' | 'fetch' | 'hallmark';

export interface CommandRule {
  id: string;
  cat: CommandCategory;
  w: number;
  re: string;
  label: Label;
}

export interface WeightedLabel {
  w: number;
  label: Label;
}

export interface PageRule {
  id: string;
  group: 'open' | 'paste' | 'enter' | 'lure';
  w: number;
  re: string;
}

export interface ProtocolRule {
  id: string;
  re: string;
  label: Label;
}

export interface RulesFile {
  format: number;
  version: number;
  minEngine: number;
  updated: string;
  thresholds: { block: number; warn: number; capabilityCap: number; contextCap: number };
  command: CommandRule[];
  structure: {
    paddingMin: number;
    padding: WeightedLabel;
    invisible: WeightedLabel;
    homoglyph: WeightedLabel;
    obfuscation: WeightedLabel;
    base64: WeightedLabel;
  };
  page: {
    maxTextLength: number;
    standaloneMinScore: number;
    standaloneMaxTextLength: number;
    /** Largest block of text that still counts as one instruction box inside a longer page, 3000 when missing. */
    boxMaxTextLength?: number;
    instructions: PageRule[];
  };
  trigger: {
    captchaLike: { w: number; re: string };
    fixLike: { w: number; re: string };
    copyLike: { w: number; re: string };
  };
  context: { pageReported: number; web3Loader: number; manualCopy: number };
  consentfix: { re: string[]; allowedHosts: string[] };
  protocols: ProtocolRule[];
  fullscreen: { keyboardLockMinScore: number; fullscreenMinScore: number };
  web3: { rpcHosts: string[]; testnetHosts: string[] };
  feed: { clickfixTags: string[]; noHostLevel: string[] };
  extensions: { malicious: { id: string; name: string; ref: string }[] };
}

export interface Reason {
  id: string;
  w: number;
  label?: Label;
}

export type DisplayPart = { t: 'text'; v: string } | { t: 'gap'; n: number };

export interface Normalized {
  match: string;
  display: DisplayPart[];
  decoded: string[];
  maxSpaceRun: number;
  padding: boolean;
  invisible: boolean;
  homoglyph: boolean;
  obfuscation: boolean;
  base64: boolean;
}

export type TriggerKind = 'captcha' | 'fix' | 'copy' | null;

export interface CommandContext {
  pageScore?: number;
  pageReasons?: Reason[];
  trigger?: TriggerKind;
  pageReported?: boolean;
  web3?: boolean;
  manual?: boolean;
}

export type Level = 'none' | 'warn' | 'block';

export interface Verdict {
  level: Level;
  score: number;
  capability: number;
  hallmark: number;
  context: number;
  gate: boolean;
  reasons: Reason[];
  norm: Normalized;
  urls: string[];
}

export interface PageVerdict {
  score: number;
  reasons: Reason[];
  groups: Set<string>;
  ids: Set<string>;
  standalone: boolean;
  textLength: number;
}
