// Parsers that turn each abuse.ch export into lookup keys in the same format the extension uses.

import { cleanHost, hostKey, ipKey, isIp, urlKey } from '../src/feed/keys';
import type { Category, FeedRecordTuple, FeedSource } from '../src/feed/types';

export interface BuildOptions {
  clickfixTags: string[];
  noHostLevel: string[];
  now: Date;
  /** Reports older than this many days are left out, unless still online. */
  maxAgeDays: number;
  /** IP reports are riskier because cloud addresses change hands, so they expire sooner. */
  ipMaxAgeDays: number;
  minConfidence: number;
  minIpConfidence: number;
}

export type Entries = Map<string, FeedRecordTuple[]>;

/** Minimal CSV reader that handles quoted fields, doubled quotes and commas inside quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Reads an abuse.ch CSV whose header sits in the last comment line. */
export function readCsv(text: string, expected: string[]): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const cols = parseCsvLine(line.replace(/^#\s*/, ''));
      if (cols.length >= 3 && expected.every((c) => cols.includes(c))) header = cols;
      continue;
    }
    const cols = parseCsvLine(line);
    const names = header ?? expected;
    const row: Record<string, string> = {};
    names.forEach((name, i) => (row[name] = cols[i] ?? ''));
    rows.push(row);
  }
  return rows;
}

function normTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && t.toLowerCase() !== 'none' && t.toLowerCase() !== 'null')
    .slice(0, 8);
}

function isClickFix(values: string[], opts: BuildOptions): boolean {
  const wanted = new Set(opts.clickfixTags.map(normTag));
  return values.some((v) => wanted.has(normTag(v)));
}

function day(ts: string): string {
  return (ts || '').slice(0, 10);
}

/** abuse.ch dates come as "2026-10-20 12:34:56" or "2026-10-20", always UTC. */
export function ageDays(ts: string | null | undefined, now: Date): number {
  const s = (ts ?? '').trim();
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s + 'T00:00:00Z';
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) iso = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : Infinity;
}

function isHostname(host: string): boolean {
  return host.includes('.') && /^[a-z0-9_.-]+$/.test(host) && !/^0x[0-9a-f]+$/.test(host);
}

/** An address reported with port 80 or 443, like http://1.2.3.4:443/x, also gets the key a browser makes once it drops that port. */
function urlKeys(raw: string): string[] {
  const key = urlKey(raw);
  if (!key) return [];
  const portless = key.replace(/^u:([^/]+):(?:80|443)(?=\/)/, 'u:$1');
  return portless === key ? [key] : [key, portless];
}

function add(entries: Entries, key: string, record: FeedRecordTuple): void {
  const list = entries.get(key);
  if (!list) entries.set(key, [record]);
  else if (!list.some((r) => r[0] === record[0] && r[4] === record[4])) list.push(record);
}

export const URLHAUS_COLUMNS = ['id', 'dateadded', 'url', 'url_status', 'last_online', 'threat', 'tags', 'urlhaus_link', 'reporter'];

/** URLhaus reports exact malware download addresses, so it only ever adds exact-address keys. */
export function fromUrlhaus(csv: string, opts: BuildOptions, entries: Entries): number {
  let count = 0;
  for (const row of readCsv(csv, ['id', 'dateadded', 'url'])) {
    const url = row.url;
    if (!url) continue;
    const online = row.url_status === 'online';
    if (!online && ageDays(row.dateadded, opts.now) > opts.maxAgeDays) continue;
    const keys = urlKeys(url);
    if (!keys.length) continue;
    const tags = splitTags(row.tags ?? '');
    const category: Category = isClickFix(tags, opts) ? 'clickfix' : 'malware';
    // Only ClickFix tags are kept for URLhaus, the rest (elf, mirai, 32-bit) mean nothing to a visitor.
    for (const key of keys) add(entries, key, ['urlhaus', category, '', day(row.dateadded), row.id, category === 'clickfix' ? tags.slice(0, 3) : []]);
    count++;
  }
  return count;
}

export const THREATFOX_COLUMNS = [
  'first_seen_utc',
  'ioc_id',
  'ioc_value',
  'ioc_type',
  'threat_type',
  'fk_malware',
  'malware_alias',
  'malware_printable',
  'last_seen_utc',
  'confidence_level',
  'reference',
  'tags',
  'anonymous',
  'reporter',
];

/** One ThreatFox report in the shape both the CSV export and the API share. */
interface ThreatfoxRow {
  id: string;
  value: string;
  type: string;
  threatType: string;
  malware: string;
  alias: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  tags: string[];
}

export function fromThreatfox(csv: string, opts: BuildOptions, entries: Entries): number {
  const rows = readCsv(csv, ['first_seen_utc', 'ioc_id', 'ioc_value', 'ioc_type']).map(
    (row): ThreatfoxRow => ({
      id: row.ioc_id,
      value: row.ioc_value,
      type: row.ioc_type,
      threatType: row.threat_type ?? '',
      malware: row.malware_printable ?? '',
      alias: row.malware_alias ?? '',
      confidence: Number(row.confidence_level ?? 0),
      firstSeen: row.first_seen_utc,
      lastSeen: row.last_seen_utc ?? '',
      tags: splitTags(row.tags ?? ''),
    }),
  );
  return addThreatfox(rows, opts, entries);
}

interface ThreatfoxApiIoc {
  id: string | number;
  ioc: string;
  ioc_type: string;
  threat_type: string;
  malware_printable: string | null;
  malware_alias: string | null;
  confidence_level: number;
  first_seen: string | null;
  last_seen: string | null;
  tags: string[] | null;
}

/** The ThreatFox API answer to get_iocs, which holds reports only minutes old while the full export lags behind. */
export function fromThreatfoxApi(json: string, opts: BuildOptions, entries: Entries): number {
  const body = JSON.parse(json) as { query_status?: string; data?: ThreatfoxApiIoc[] };
  if (body.query_status !== 'ok' || !Array.isArray(body.data)) return 0;
  const utc = (ts: string | null) => (ts ?? '').replace(/\s*UTC$/i, '');
  const rows = body.data.map(
    (ioc): ThreatfoxRow => ({
      id: String(ioc.id),
      value: ioc.ioc,
      type: ioc.ioc_type,
      threatType: ioc.threat_type ?? '',
      malware: ioc.malware_printable ?? '',
      alias: ioc.malware_alias ?? '',
      confidence: Number(ioc.confidence_level ?? 0),
      firstSeen: utc(ioc.first_seen),
      lastSeen: utc(ioc.last_seen),
      tags: (ioc.tags ?? []).filter((t) => t && t.toLowerCase() !== 'none').slice(0, 8),
    }),
  );
  return addThreatfox(rows, opts, entries);
}

function addThreatfox(rows: ThreatfoxRow[], opts: BuildOptions, entries: Entries): number {
  const noHost = new Set(opts.noHostLevel.map((h) => h.toLowerCase()));
  let count = 0;
  for (const row of rows) {
    const value = row.value;
    const type = row.type;
    if (!value || !type) continue;
    const confidence = row.confidence;
    const seen = row.lastSeen || row.firstSeen;
    const tags = row.tags;
    const malware = row.malware && !/^unknown/i.test(row.malware) ? row.malware : '';
    const clickfix = isClickFix([...tags, malware, row.alias], opts);
    const category: Category = clickfix ? 'clickfix' : row.threatType === 'botnet_cc' ? 'c2' : 'malware';
    const record: FeedRecordTuple = ['threatfox', category, malware, day(row.firstSeen), row.id, tags.slice(0, 3)];
    if (type === 'domain') {
      if (confidence < opts.minConfidence || ageDays(seen, opts.now) > opts.maxAgeDays) continue;
      const host = cleanHost(value);
      // Some "domains" are blockchain contract addresses like 0xf202...e5779, nobody can browse to those.
      if (!host || !isHostname(host) || noHost.has(host)) continue;
      add(entries, hostKey(host), record);
      count++;
    } else if (type === 'url') {
      if (confidence < opts.minConfidence || ageDays(seen, opts.now) > opts.maxAgeDays) continue;
      const keys = urlKeys(value);
      if (!keys.length) continue;
      for (const key of keys) add(entries, key, record);
      count++;
    } else if (type === 'ip:port') {
      if (confidence < opts.minIpConfidence || ageDays(seen, opts.now) > opts.ipMaxAgeDays) continue;
      const ip = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!isIp(ip)) continue;
      add(entries, ipKey(ip), record);
      count++;
    }
  }
  return count;
}

interface FeodoRow {
  ip_address: string;
  status: string;
  first_seen: string;
  last_online: string | null;
  malware: string;
}

export function fromFeodo(json: string, opts: BuildOptions, entries: Entries): number {
  const rows = JSON.parse(json) as FeodoRow[];
  let count = 0;
  for (const row of rows) {
    if (!row.ip_address || !isIp(row.ip_address)) continue;
    const last = row.last_online ?? row.first_seen;
    if (ageDays(last, opts.now) > opts.ipMaxAgeDays) continue;
    add(entries, ipKey(row.ip_address), ['feodo', 'c2', row.malware ?? '', day(row.first_seen), row.ip_address, []]);
    count++;
  }
  return count;
}

/** A host that served a reported ClickFix address is listed as a whole, except shared hosting where only the exact address counts. */
export function promoteClickFixHosts(opts: BuildOptions, entries: Entries): number {
  const noHost = new Set(opts.noHostLevel.map((h) => h.toLowerCase()));
  const byHost = new Map<string, FeedRecordTuple[]>();
  for (const [key, records] of entries) {
    if (!key.startsWith('u:')) continue;
    const clickfix = records.filter((r) => r[1] === 'clickfix');
    if (!clickfix.length) continue;
    const host = cleanHost(key.slice(2).split('/')[0].replace(/:\d+$/, ''));
    if (!host || noHost.has(host)) continue;
    const list = byHost.get(host) ?? [];
    list.push(...clickfix);
    byHost.set(host, list);
  }
  let count = 0;
  for (const [host, records] of byHost) {
    const key = isIp(host) ? ipKey(host) : hostKey(host);
    // The newest reports are enough to explain the warning, three keep the file small.
    for (const record of [...records].sort((a, b) => (a[3] < b[3] ? 1 : -1)).slice(0, 3)) add(entries, key, record);
    count++;
  }
  return count;
}

export const SOURCE_LABELS: Record<FeedSource, string> = { urlhaus: 'URLhaus', threatfox: 'ThreatFox', feodo: 'Feodo Tracker' };
