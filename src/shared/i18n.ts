import { browser } from 'wxt/browser';
import type { Label } from '../engine/types';

/** Interface languages, folder name under public/_locales and the name people know it by. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'العربية' },
  { code: 'bg', name: 'Български' },
  { code: 'cs', name: 'Čeština' },
  { code: 'da', name: 'Dansk' },
  { code: 'de', name: 'Deutsch' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'es', name: 'Español' },
  { code: 'fi', name: 'Suomi' },
  { code: 'fr', name: 'Français' },
  { code: 'he', name: 'עברית' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'hu', name: 'Magyar' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'nb', name: 'Norsk bokmål' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt_BR', name: 'Português (Brasil)' },
  { code: 'pt_PT', name: 'Português (Portugal)' },
  { code: 'ro', name: 'Română' },
  { code: 'ru', name: 'Русский' },
  { code: 'sk', name: 'Slovenčina' },
  { code: 'sv', name: 'Svenska' },
  { code: 'th', name: 'ไทย' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'uk', name: 'Українська' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'zh_CN', name: '简体中文' },
  { code: 'zh_TW', name: '繁體中文' },
];

const RTL = new Set(['ar', 'he']);

interface Override {
  lang: string;
  messages: Record<string, string>;
  /** The extension version the messages were copied from, an update makes them stale. */
  version?: string;
}

let override: Override | null = null;

const currentVersion = (): string => {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '';
  }
};

/** The language picked in the settings, empty when the browser language is used. */
export function overrideLang(): string {
  return override?.lang ?? '';
}

export function setI18nOverride(value: unknown): void {
  const o = value as Override | null | undefined;
  override = o && typeof o.lang === 'string' && o.messages && typeof o.messages === 'object' ? o : null;
  // Texts copied from another version can miss keys or placeholders, the browser's own copy is right until they are renewed.
  if (override && override.version !== currentVersion()) override = { ...override, messages: {} };
}

/** Reads the language picked in the settings, if any, before a page renders, and renews it after an update. */
export async function loadI18nOverride(): Promise<void> {
  try {
    const { i18nOverride } = await browser.storage.local.get('i18nOverride');
    setI18nOverride(i18nOverride);
    const stored = i18nOverride as Override | undefined;
    if (stored?.lang && stored.version !== currentVersion()) {
      await chooseLanguage(stored.lang);
      setI18nOverride((await browser.storage.local.get('i18nOverride')).i18nOverride);
    }
  } catch {
    // keep what was read, the browser language fills any gap
  }
}

/** Copies the picked language's texts again from this version, the background calls it on every start. */
export async function renewI18nOverride(): Promise<void> {
  const { i18nOverride } = (await browser.storage.local.get('i18nOverride')) as { i18nOverride?: Override };
  if (i18nOverride?.lang && i18nOverride.version !== currentVersion()) await chooseLanguage(i18nOverride.lang);
}

/** Loads a language's messages from the extension and stores them, an empty code goes back to the browser language. */
export async function chooseLanguage(code: string): Promise<void> {
  if (!code) {
    await browser.storage.local.remove('i18nOverride');
    return;
  }
  const url = (browser.runtime.getURL as unknown as (p: string) => string)(`/_locales/${code}/messages.json`);
  const raw = (await (await fetch(url)).json()) as Record<string, { message: string }>;
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) messages[key] = value.message;
  await browser.storage.local.set({ i18nOverride: { lang: code, messages, version: currentVersion() } satisfies Override });
}

function fill(text: string, subs: string[]): string {
  return text.replace(/\$(\d)/g, (m, d: string) => subs[Number(d) - 1] ?? m);
}

export function t(key: string, subs?: string | string[]): string {
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  const own = override?.messages[key];
  if (own !== undefined) return fill(own, list);
  try {
    const value = browser.i18n.getMessage(key as never, list as never);
    return value || key;
  } catch {
    return key;
  }
}

/** Fills a message whose $1, $2 are elements, for example bold phrases, keeping each language's word order. */
export function tParts(key: string, parts: (string | Node)[]): (string | Node)[] {
  const marks = parts.map((_, i) => String.fromCharCode(0xe000 + i));
  const text = t(key, marks);
  const out: (string | Node)[] = [];
  let buf = '';
  for (const ch of text) {
    const index = ch.charCodeAt(0) - 0xe000;
    if (index >= 0 && index < parts.length) {
      if (buf) out.push(buf);
      buf = '';
      out.push(parts[index]);
    } else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** The interface language as a BCP 47 tag, for dates and the lang attribute. */
export function uiLang(): string {
  try {
    return (override?.lang ?? browser.i18n.getUILanguage()).replace('_', '-');
  } catch {
    return 'en';
  }
}

/** The locale folder that matches the interface language, for links such as the privacy policy. */
export function uiLocaleCode(): string {
  const tag = uiLang();
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === tag.replace('-', '_').toLowerCase());
  if (exact) return exact.code;
  const base = tag.split('-')[0].toLowerCase();
  if (base === 'pt') return 'pt_BR';
  if (base === 'zh') return 'zh_CN';
  if (base === 'no' || base === 'nn') return 'nb';
  return LANGUAGES.find((l) => l.code === base)?.code ?? 'en';
}

export function isRtl(): boolean {
  return RTL.has(uiLang().split('-')[0]);
}

export function label(l: Label | undefined, fallback: string): string {
  if (!l) return fallback;
  return l[uiLang().split('-')[0]] || l.en || fallback;
}

/** Fills every element that carries data-i18n, data-i18n-title, data-i18n-placeholder or data-i18n-tip. */
export function localizePage(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-tip]')) el.dataset.tip = t(el.dataset.i18nTip!);
  document.documentElement.lang = uiLang();
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return t('timeNever');
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return t('timeJustNow');
  if (min < 60) return t('timeMinutes', String(min));
  const h = Math.round(min / 60);
  if (h < 48) return t('timeHours', String(h));
  return t('timeDays', String(Math.round(h / 24)));
}
