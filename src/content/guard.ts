// Isolated-world guard that answers the page hooks, adds page context, shows warnings and writes the local log.

import { browser } from 'wxt/browser';
import { externalScheme, isConsentFixPaste, matchProtocol } from '../engine/checks';
import { classifyTriggerText, scorePageText } from '../engine/page';
import { BUNDLED_RULES, pickRules } from '../engine/rules';
import { evaluateCommand } from '../engine/score';
import type { CommandContext, PageVerdict, Reason, RulesFile, TriggerKind, Verdict } from '../engine/types';
import type { FeedHit } from '../feed/types';
import { label, setI18nOverride, t } from '../shared/i18n';
import type { AlertData, DetectionAction, DetectionKind, Message, PageStatus, TabMessage } from '../shared/messages';
import { DEFAULT_SETTINGS, type EffectiveSettings, isTrusted, type Settings } from '../shared/settings';
import { whatOfCommand, whyOfCommand, whyOfPage } from '../ui/explain';
import { showAlert } from '../ui/overlay';
import { findLureBox, hasLureControl, shadowRoots } from './dom-scan';
import { type CheckDetail, EVT, type SignalDetail, safeText } from './protocol';

export function startGuard(): void {
  const isTop = window === window.top;
  const host = location.hostname;
  let rules: RulesFile = BUNDLED_RULES;
  let settings: Settings = DEFAULT_SETTINGS;
  let trusted = false;
  let pageReported = false;
  const web3 = { mainnet: false, testnet: false };
  let lastPointer: { el: Element | null; time: number } = { el: null, time: 0 };
  let copyMark = 0;
  // Counts every write to the clipboard this page can see, a later recheck only replaces what is still the last write.
  let clipboardSeq = 0;
  let pageCache: { time: number; v: PageVerdict } | null = null;
  // The instruction box found in the page, it also raises the score of any command copied afterwards.
  let lureBox: PageVerdict | null = null;

  const active = () => settings.enabled && !trusted;

  function sendMessage<T = unknown>(msg: Message): Promise<T | undefined> {
    try {
      return (browser.runtime.sendMessage(msg) as Promise<T>).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  // ---- state from storage ----
  async function load(): Promise<void> {
    try {
      const stored = await browser.storage.local.get(['rules', 'effective', 'i18nOverride']);
      setI18nOverride(stored.i18nOverride);
      rules = pickRules(stored.rules);
      const eff = stored.effective as EffectiveSettings | undefined;
      if (eff?.settings) settings = { ...DEFAULT_SETTINGS, ...eff.settings };
      trusted = isTrusted(host, settings);
    } catch {
      // extension context gone, keep the bundled defaults
    }
  }
  void load();
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.rules || changes.effective || changes.i18nOverride)) void load();
    });
  } catch {
    // ignore
  }

  // ---- page context ----
  function pageText(): string {
    const body = document.body;
    if (!body) return '';
    let text = '';
    try {
      text = body.innerText || body.textContent || '';
    } catch {
      text = body.textContent || '';
    }
    const extras: string[] = [];
    for (const node of body.querySelectorAll('img[alt], [aria-label]')) {
      const v = node.getAttribute('alt') || node.getAttribute('aria-label');
      if (v) extras.push(v);
      if (extras.length >= 60) break;
    }
    return (text + '\n' + extras.join('\n')).slice(0, 200_000);
  }

  function pageVerdict(fresh = false): PageVerdict {
    if (!fresh && pageCache && Date.now() - pageCache.time < 1500) return pageCache.v;
    const v = scorePageText(pageText(), rules);
    pageCache = { time: Date.now(), v };
    return v;
  }

  function trigger(): TriggerKind {
    if (!lastPointer.el || Date.now() - lastPointer.time > 5000) return null;
    const target = lastPointer.el;
    const el = target.closest('button, a, label, [role=button], [role=checkbox], input, [onclick]') ?? target;
    const isCheckbox =
      el.matches('input[type=checkbox], [role=checkbox]') || !!el.querySelector?.('input[type=checkbox], [role=checkbox]');
    const label = (node: Element) =>
      [node.getAttribute('aria-label'), node.getAttribute('title'), (node as HTMLElement).innerText ?? node.textContent].filter(Boolean).join(' ').trim();
    let text = label(el).slice(0, 300);
    // A fake checkbox is often an empty box, the "not a robot" text sits next to it in the same widget.
    for (let up = el.parentElement, i = 0; !text && up && up !== document.body && i < 3; up = up.parentElement, i++) text = label(up).slice(0, 300);
    return classifyTriggerText(text, isCheckbox, rules);
  }

  function context(manual: boolean, fresh = false, trig: TriggerKind = trigger()): CommandContext {
    let p = pageVerdict(fresh);
    if (lureBox && lureBox.score > p.score) p = lureBox;
    return { pageScore: p.score, pageReasons: p.reasons, trigger: trig, pageReported, web3: web3.mainnet || web3.testnet, manual };
  }

  // ---- reporting ----
  function present(alert: AlertData): void {
    if (isTop) {
      showAlert(alert, overlayActions, settings.customWarning);
    } else {
      void sendMessage({ type: 'show-alert', alert });
    }
  }

  function log(kind: DetectionKind, action: DetectionAction, extra: { score?: number; reasons?: string[]; what?: string } = {}): void {
    void sendMessage({
      type: 'log',
      detection: { kind, action, url: location.href, host, score: extra.score, reasons: extra.reasons ?? [], what: extra.what },
    });
  }

  // The command itself is never shown, only what it does and why it was stopped, so nobody copies it from the warning.
  function reportVerdict(kind: DetectionKind, v: Verdict, hits?: FeedHit[]): void {
    const reasons: Reason[] = hits?.length ? [{ id: 'payload-reported', w: 30 }, ...v.reasons] : v.reasons;
    const what = whatOfCommand(reasons);
    present({ kind, host, score: v.score, what, why: whyOfCommand(reasons) });
    log(kind, 'blocked', { score: v.score, reasons: reasons.filter((r) => r.w >= 10).map((r) => r.id), what });
  }

  async function writeSafeClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(safeText());
      return;
    } catch {
      // fall back to a temporary text field
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = safeText();
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      (document.body ?? document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch {
      // nothing else to try
    }
  }

  // Borderline commands that were let through and later stopped, so each one is swapped and reported only once.
  const settled = new Set<string>();

  /** A borderline command gets a second look: is its download address in the database? */
  async function checkTargets(v: Verdict, payload: string, seq: number): Promise<void> {
    if (!v.urls.length) return;
    const hits = await sendMessage<FeedHit[]>({ type: 'lookup-targets', urls: v.urls });
    if (!Array.isArray(hits) || !hits.length || settled.has(payload) || seq !== clipboardSeq) return;
    settled.add(payload);
    await writeSafeClipboard();
    reportVerdict('clipboard', v, hits);
  }

  /** Lures often show their paste steps only after the copy, so a borderline command is scored again while the page changes. */
  function recheckLater(payload: string, seq: number, trig: TriggerKind): void {
    for (const delay of [400, 1000, 2000, 4000, 8000]) {
      setTimeout(() => {
        // Something else was copied since, the visitor's own copy must never be replaced.
        if (seq !== clipboardSeq || settled.has(payload) || !active() || !settings.clipboard) return;
        scanPage();
        const v = evaluateCommand(payload, rules, context(false, true, trig));
        if (v.level !== 'block') return;
        settled.add(payload);
        void writeSafeClipboard();
        reportVerdict('clipboard', v);
      }, delay);
    }
  }

  const overlayActions = {
    leave: () => void sendMessage({ type: 'leave-site' }),
    trust: (h: string) => {
      trusted = true;
      void sendMessage({ type: 'trust-site', host: h });
      log('reputation', 'trusted', { reasons: [] });
    },
  };

  // ---- answers to the page-world hooks ----
  function onCheck(detail: CheckDetail): boolean {
    if (!active()) return false;
    const payload = String(detail.payload ?? '');
    switch (detail.kind) {
      case 'clipboard-write':
      case 'set-data':
      case 'exec-copy': {
        if (!settings.clipboard) return false;
        const seq = ++clipboardSeq;
        const trig = trigger();
        const v = evaluateCommand(payload, rules, context(false, false, trig));
        if (v.level === 'block') {
          reportVerdict('clipboard', v);
          return true;
        }
        if (v.level === 'warn') {
          void checkTargets(v, payload, seq);
          recheckLater(payload, seq, trig);
        }
        return false;
      }
      case 'fullscreen':
      case 'keyboard-lock': {
        if (!settings.fullscreen) return false;
        const p = pageVerdict(true);
        const block =
          detail.kind === 'keyboard-lock'
            ? p.score >= rules.fullscreen.keyboardLockMinScore && (p.groups.has('open') || p.ids.has('page-fake-update'))
            : p.score >= rules.fullscreen.fullscreenMinScore && p.ids.has('page-fake-update');
        if (block) {
          const what = t('fullscreenWhat');
          present({ kind: 'fullscreen', host, score: p.score, what, why: whyOfPage(p.reasons) });
          log('fullscreen', 'blocked', { score: p.score, reasons: p.reasons.map((r) => r.id), what });
          try {
            if (document.fullscreenElement) void document.exitFullscreen();
          } catch {
            // ignore
          }
        }
        return block;
      }
      case 'protocol':
        return blockProtocol(payload);
    }
    return false;
  }

  function blockProtocol(url: string): boolean {
    if (!active() || !settings.protocols) return false;
    const rule = matchProtocol(url, rules);
    if (!rule) return false;
    const key = 'proto_' + rule.id.replace(/^proto-/, '').replace(/-/g, '_');
    const what = t(key) !== key ? t(key) : label(rule.label, rule.id);
    present({ kind: 'protocol', host, what, why: t('protocolWhy') });
    log('protocol', 'blocked', { reasons: [rule.id], what });
    return true;
  }

  window.addEventListener(
    EVT.ping,
    (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
  window.addEventListener(
    EVT.check,
    (e) => {
      e.stopImmediatePropagation();
      let detail: CheckDetail;
      try {
        detail = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      if (onCheck(detail)) e.preventDefault();
    },
    true,
  );
  window.addEventListener(
    EVT.mark,
    (e) => {
      e.stopImmediatePropagation();
      let detail = '';
      try {
        detail = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      copyMark = Math.max(0, copyMark + (detail === 'begin' ? 1 : -1));
    },
    true,
  );
  window.addEventListener(
    EVT.signal,
    (e) => {
      e.stopImmediatePropagation();
      let detail: SignalDetail;
      try {
        detail = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      if (detail.kind !== 'web3' || !settings.web3) return;
      web3[detail.net] = true;
      if (detail.net === 'testnet' && active()) {
        present({ kind: 'web3-loader', host });
        log('web3-loader', 'warned', { reasons: [`rpc:${detail.host}`] });
      }
    },
    true,
  );

  // ---- what the visitor does ----
  window.addEventListener('pointerdown', (e) => (lastPointer = { el: e.target as Element, time: Date.now() }), true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') lastPointer = { el: e.target as Element, time: Date.now() };
  }, true);

  function selectedText(): string {
    const activeEl = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    try {
      if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT') && activeEl.selectionEnd! > activeEl.selectionStart!)
        return activeEl.value.slice(activeEl.selectionStart!, activeEl.selectionEnd!);
    } catch {
      // ignore
    }
    return document.getSelection()?.toString() ?? '';
  }

  const onCopy = (e: ClipboardEvent) => {
    if (copyMark > 0) return;
    clipboardSeq++;
    if (!active() || !settings.clipboard) return;
    const text = selectedText();
    if (text.trim().length < 6) return;
    const v = evaluateCommand(text, rules, context(true));
    if (v.level !== 'block') return;
    e.clipboardData?.setData('text/plain', safeText());
    e.preventDefault();
    reportVerdict('manual-copy', v);
  };
  window.addEventListener('copy', onCopy, true);
  window.addEventListener('cut', onCopy, true);

  window.addEventListener(
    'paste',
    (e) => {
      if (!active() || !settings.paste) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text || !isConsentFixPaste(text, host, rules)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const what = t('pasteWhat');
      present({ kind: 'paste', host, what, why: t('pasteWhy') });
      log('paste', 'blocked', { reasons: ['consentfix'], what });
    },
    true,
  );

  window.addEventListener(
    'click',
    (e) => {
      const path = e.composedPath();
      const link = path.find((n): n is HTMLAnchorElement | HTMLAreaElement => n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement);
      if (!link?.href || !externalScheme(link.href)) return;
      if (blockProtocol(link.href)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigate', (e) => {
    const ev = e as Event & { destination?: { url: string }; cancelable: boolean };
    const url = ev.destination?.url;
    if (url && externalScheme(url) && ev.cancelable && blockProtocol(url)) ev.preventDefault();
  });

  // ---- the DOM of every page, watched for as long as it is open ----
  const WATCH: MutationObserverInit = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] };
  const watchedRoots = new WeakSet<Node>();
  const watchStart = Date.now();
  let scanTimer: number | undefined;
  const observer = new MutationObserver(() => scheduleScan());

  /**
   * Throttled, not debounced, so a slider that changes every moment cannot keep the scan from running.
   * Lures appear within seconds of a load, so scans space out over time and pause while the tab is hidden.
   */
  function scheduleScan(): void {
    if (lureBox || scanTimer !== undefined || document.hidden) return;
    const age = Date.now() - watchStart;
    const wait = age < 30_000 ? 1000 : age < 300_000 ? 5000 : 15_000;
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined;
      scanPage();
    }, wait);
  }
  document.addEventListener('visibilitychange', () => scheduleScan());

  function scanPage(): void {
    if (!active() || lureBox) return;
    const roots = shadowRoots();
    // Changes inside a shadow root never reach the document observer, so each root gets watched on its own.
    for (const root of roots) {
      if (watchedRoots.has(root)) continue;
      watchedRoots.add(root);
      observer.observe(root, WATCH);
    }
    const p = pageVerdict(true);
    // A short page counts as a lure on its own only with a check or a Verify button, like a box inside a longer page.
    const whole = p.standalone && document.body && (hasLureControl(document.body, null, rules) || roots.some((r) => hasLureControl(r.host, r, rules)));
    const box = whole ? p : findLureBox(rules, roots);
    if (!box) return;
    lureBox = box;
    observer.disconnect();
    if (!settings.pageWarnings) return;
    present({ kind: 'page-instructions', host });
    log('page-instructions', 'warned', { score: box.score, reasons: box.reasons.map((r) => r.id) });
  }

  function watchPage(): void {
    observer.observe(document.documentElement, WATCH);
    scheduleScan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchPage, { once: true });
  else watchPage();

  // ---- reputation, top frame only ----
  if (isTop) {
    const showReputation = async (first: boolean) => {
      const status = await sendMessage<PageStatus>({ type: 'page-status', url: location.href });
      if (!status?.hits?.length) return;
      pageReported = true;
      if (!settings.reputation || !settings.enabled || status.trusted) return;
      // The warning page is on its way, stop the site from loading any further, only on the first check and never on a later update.
      if (status.blocked && first) {
        window.stop();
        return;
      }
      const render = () =>
        showAlert({ kind: 'reputation', host, hits: status.hits }, overlayActions, settings.customWarning);
      if (document.documentElement) render();
      else document.addEventListener('DOMContentLoaded', render, { once: true });
      log('reputation', 'warned', {
        reasons: status.hits.flatMap((h) => h.records.map((r) => `${r.source}:${r.category}`)),
      });
    };
    void load().then(() => showReputation(true));
    try {
      browser.runtime.onMessage.addListener((msg: TabMessage) => {
        if (msg.type === 'reputation-update') void showReputation(false);
        if (msg.type === 'show-alert') showAlert(msg.alert, overlayActions, settings.customWarning);
      });
    } catch {
      // ignore
    }
  }
}
