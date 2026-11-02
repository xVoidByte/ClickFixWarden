// Checks every address in the database against the lookup the extension runs on each page visit, no listed site is ever opened.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupKeysForUrl } from '../src/feed/keys';
import type { FeedPart } from '../src/feed/types';

// The live site by default, or a folder such as dist/site/v1 before it is published.
const BASE = process.argv[2] ?? 'https://xvoidbyte.github.io/ClickFixWarden/v1/';
const load = async (name: string) =>
  (/^https?:/.test(BASE) ? await (await fetch(BASE + name)).json() : JSON.parse(readFileSync(join(BASE, name), 'utf8'))) as FeedPart;

/** The addresses a visitor would really open for a key, with a scheme, a subdomain or a path where they apply. */
function visitsFor(key: string): string[] {
  const value = key.slice(2);
  if (key.startsWith('h:')) return [`https://${value}/`, `http://${value}/login?next=1`, `https://www.${value}/page`];
  if (key.startsWith('i:')) return value.includes(':') ? [`http://[${value}]/`] : [`http://${value}/`, `http://${value}:8080/panel`];
  return [`http://${value}`, `https://${value}`];
}

const parts: FeedPart[] = [await load('hot.json'), await load('bulk.json')];
const allKeys = new Set(parts.flatMap((p) => p.entries.map(([key]) => key)));

const stats = new Map<string, { keys: number; visits: number; missed: number }>();
const misses: string[] = [];
for (const part of parts) {
  for (const [key] of part.entries) {
    const kind = key.slice(0, 2);
    const s = stats.get(kind) ?? { keys: 0, visits: 0, missed: 0 };
    s.keys++;
    for (const url of visitsFor(key)) {
      s.visits++;
      // Found when any key the extension looks up for this visit is in the database, the same as a real page load.
      if (!lookupKeysForUrl(url).some((k) => allKeys.has(k))) {
        s.missed++;
        if (misses.length < 20) misses.push(`${key}  <-  ${url}`);
      }
    }
    stats.set(kind, s);
  }
}

const names: Record<string, string> = { 'h:': 'whole hosts', 'i:': 'server IPs', 'u:': 'exact addresses' };
let total = 0;
let missed = 0;
for (const [kind, s] of stats) {
  console.log(`${names[kind] ?? kind}: ${s.keys} keys, ${s.visits} visits checked, ${s.missed} missed`);
  total += s.keys;
  missed += s.missed;
}
console.log(`database from ${parts[0].generated}, ${total} keys, ${missed === 0 ? 'every one is found' : missed + ' visits missed'}`);
for (const m of misses) console.log('  missed ' + m);
process.exit(missed === 0 ? 0 : 1);
