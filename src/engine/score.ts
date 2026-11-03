import { normalize, withPadding } from './normalize';
import { compileRules } from './rules';
import type { CommandContext, Reason, RulesFile, Verdict } from './types';

const URL_RE = /\b(?:https?|hxxps?):\/\/[^\s"'`|;)<>]+/gi;
const UNC_RE = /\\\\([a-z0-9.-]+)(?:@ssl)?(?:@\d+)?\\/gi;
// "irm host.tld/path | iex" works without a scheme, PowerShell and curl add one themselves, so every host after a download command counts.
const FETCH_RE = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl(?:\.exe)?|wget(?:\.exe)?)\b([^|;\n]{0,600})/gi;
const HOST_RE = /(?<![\w@./-])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?::\d+)?)(\/[^\s"'`|;)<>]*)?(?![\w.-])/gi;
const OUTPUT_FLAG_RE = /(?:^|\s)(?:-OutFile|--output-document|--output|-o|>)\s*["']?[^\s"']+/gi;
const FILE_EXT = new Set(['sh', 'py', 'zip', 'exe', 'cmd', 'bat', 'ps', 'msi', 'dll', 'js', 'vbs', 'hta', 'txt', 'log', 'tmp', 'bin', 'dat', 'json', 'xml', 'jar', 'rar', 'gz', 'tar', 'deb', 'rpm', 'pkg', 'dmg', 'app', 'lnk', 'scr', 'iso', 'img']);

/** Scores text that a page is about to put in the clipboard. */
export function evaluateCommand(text: string, rules: RulesFile, ctx: CommandContext = {}): Verdict {
  const compiled = compileRules(rules);
  const norm = withPadding(normalize(text), rules.structure.paddingMin);
  const reasons: Reason[] = [];

  let exec = 0;
  let fetch = 0;
  let hallmark = 0;
  let gate = false;

  for (const { rule, re } of compiled.command) {
    if (!re.test(norm.match)) continue;
    reasons.push({ id: rule.id, w: rule.w, label: rule.label });
    if (rule.cat === 'exec') {
      exec += rule.w;
      gate = true;
    } else if (rule.cat === 'fetch') fetch += rule.w;
    else hallmark += rule.w;
  }

  const s = rules.structure;
  if (norm.padding) {
    hallmark += s.padding.w;
    reasons.push({ id: 'struct-padding', w: s.padding.w, label: s.padding.label });
  }
  if (norm.invisible) {
    hallmark += s.invisible.w;
    reasons.push({ id: 'struct-invisible', w: s.invisible.w, label: s.invisible.label });
  }
  if (norm.homoglyph) {
    hallmark += s.homoglyph.w;
    reasons.push({ id: 'struct-homoglyph', w: s.homoglyph.w, label: s.homoglyph.label });
  }
  if (norm.obfuscation) {
    hallmark += s.obfuscation.w;
    reasons.push({ id: 'struct-obfuscation', w: s.obfuscation.w, label: s.obfuscation.label });
  }
  if (norm.base64) {
    hallmark += s.base64.w;
    reasons.push({ id: 'struct-base64', w: s.base64.w, label: s.base64.label });
  }

  const capability = Math.min(rules.thresholds.capabilityCap, exec + fetch);

  let context = 0;
  if (ctx.pageScore) context += ctx.pageScore;
  if (ctx.pageReasons) for (const r of ctx.pageReasons) reasons.push(r);
  if (ctx.trigger === 'captcha') {
    context += rules.trigger.captchaLike.w;
    reasons.push({ id: 'trigger-captcha', w: rules.trigger.captchaLike.w });
  } else if (ctx.trigger === 'fix') {
    context += rules.trigger.fixLike.w;
    reasons.push({ id: 'trigger-fix', w: rules.trigger.fixLike.w });
  } else if (ctx.trigger === 'copy') {
    context += rules.trigger.copyLike.w;
  }
  if (ctx.pageReported) {
    context += rules.context.pageReported;
    reasons.push({ id: 'page-reported', w: rules.context.pageReported });
  }
  if (ctx.web3) {
    context += rules.context.web3Loader;
    reasons.push({ id: 'page-web3', w: rules.context.web3Loader });
  }
  if (ctx.manual) context += rules.context.manualCopy;
  context = Math.max(-20, Math.min(rules.thresholds.contextCap, context));

  const score = gate ? capability + hallmark + context : 0;
  const level = !gate ? 'none' : score >= rules.thresholds.block ? 'block' : score >= rules.thresholds.warn ? 'warn' : 'none';

  return { level, score, capability, hallmark, context, gate, reasons, norm, urls: extractTargets(text, norm.decoded) };
}

/** Web addresses and network shares named in the command, used for the reputation lookup. */
export function extractTargets(text: string, decoded: string[] = []): string[] {
  const found = new Set<string>();
  for (const source of [text, ...decoded]) {
    for (const m of source.matchAll(URL_RE)) {
      const url = m[0].replace(/^hxxp/i, 'http').replace(/[.,]+$/, '');
      found.add(url);
      if (found.size >= 20) return [...found];
    }
    for (const call of source.matchAll(FETCH_RE)) {
      // Full addresses are already counted, and the file a command saves to is not an address.
      const rest = call[1].replace(/(?:https?|hxxps?):\/\/\S+/gi, ' ').replace(OUTPUT_FLAG_RE, ' ');
      for (const m of rest.matchAll(HOST_RE)) {
        const tld = m[1].slice(m[1].lastIndexOf('.') + 1).toLowerCase();
        // "install.sh" or "a.exe" with no path is a file name, a real host on such a domain almost always comes with one.
        if (!m[2] && m[1].split('.').length === 2 && FILE_EXT.has(tld)) continue;
        found.add(`https://${m[1]}${(m[2] ?? '/').replace(/[.,]+$/, '')}`);
        if (found.size >= 20) return [...found];
      }
    }
    for (const m of source.matchAll(UNC_RE)) found.add(`http://${m[1].toLowerCase()}/`);
  }
  return [...found];
}
