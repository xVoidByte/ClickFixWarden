// Builds the signed hot.json, bulk.json, hourly hot-delta.json and rules.json from the abuse.ch exports into dist/site, and stops before publishing if any source fails.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { isUsableRules } from '../src/engine/rules';
import type { RulesFile } from '../src/engine/types';
import { FEED_PUBLIC_KEY } from '../src/feed/public-key';
import { diffEntries, type FeedDelta, type FeedEntry, type FeedPart, type FeedSource, type SourceCount, splitEntries } from '../src/feed/types';
import { type BuildOptions, type Entries, fromFeodo, fromThreatfox, fromThreatfoxApi, fromUrlhaus, promoteClickFixHosts, SOURCE_LABELS } from './sources';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, process.env.OUT_DIR ?? 'dist/site');
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? 'https://xvoidbyte.github.io/ClickFixWarden/';
const unsigned = process.argv.includes('--unsigned');
const UA = 'clickfix-warden-feed (+https://github.com/xVoidByte/ClickFixWarden)';

const authKey = process.env.ABUSECH_AUTH_KEY?.trim();
if (!authKey) fail('ABUSECH_AUTH_KEY is not set. Create a free key at https://auth.abuse.ch/ and add it as a repository secret.');

function fail(message: string): never {
  console.error(`Feed build failed: ${message}`);
  process.exit(1);
}

function redact(s: string): string {
  return authKey ? s.split(authKey).join('***') : s;
}

async function download(url: string, optional = false): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA } });
  } catch (e) {
    if (optional) return null;
    fail(redact(`${url} could not be reached, ${(e as Error).message}`));
  }
  if (res.status === 404 && optional) return null;
  if (!res.ok) fail(redact(`${url} answered HTTP ${res.status}`));
  return new Uint8Array(await res.arrayBuffer());
}

function firstCsvInZip(zip: Uint8Array): string {
  const files = unzipSync(zip);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.csv'));
  if (!name) fail('the ThreatFox export has no CSV file inside');
  return new TextDecoder().decode(files[name]);
}

function signFile(data: Buffer, pem: string): string {
  const key = createPrivateKey(pem);
  const signature = sign(null, data, key);
  // Make sure the secret matches the public key compiled into the extension.
  const raw = Buffer.from(FEED_PUBLIC_KEY, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!verify(null, data, pub, signature)) fail('FEED_SIGNING_KEY does not match src/feed/public-key.ts');
  return signature.toString('base64');
}

const rulesText = readFileSync(resolve(root, 'rules/rules.json'));
const rules = JSON.parse(rulesText.toString('utf8')) as RulesFile;
if (!isUsableRules(rules)) fail('rules/rules.json is not a usable rules file');

const opts: BuildOptions = {
  clickfixTags: rules.feed.clickfixTags,
  noHostLevel: rules.feed.noHostLevel,
  now: new Date(),
  maxAgeDays: 30,
  ipMaxAgeDays: 30,
  minConfidence: 50,
  minIpConfidence: 75,
};

const entries: Entries = new Map();
const counts: Record<FeedSource, number> = { urlhaus: 0, threatfox: 0, feodo: 0 };

console.log('Downloading URLhaus');
const urlhaus = await download(`https://urlhaus-api.abuse.ch/v2/files/exports/${authKey}/recent.csv`);
counts.urlhaus = fromUrlhaus(new TextDecoder().decode(urlhaus!), opts, entries);

console.log('Downloading ThreatFox');
const threatfox = await download(`https://threatfox-api.abuse.ch/v2/files/exports/${authKey}/full.csv.zip`);
counts.threatfox = fromThreatfox(firstCsvInZip(threatfox!), opts, entries);

// The full export can be hours old, the API adds the reports of the last two days within minutes of their posting.
console.log('Asking the ThreatFox API for the newest reports');
try {
  const res = await fetch('https://threatfox-api.abuse.ch/api/v1/', {
    method: 'POST',
    headers: { 'user-agent': UA, 'Auth-Key': authKey!, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'get_iocs', days: 2 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fresh = fromThreatfoxApi(await res.text(), opts, entries);
  console.log(`ThreatFox API gave ${fresh} recent reports`);
} catch (e) {
  console.log(redact(`The ThreatFox API could not be read, publishing the export alone, ${(e as Error).message}`));
}

console.log('Downloading Feodo Tracker');
const feodo = await download('https://feodotracker.abuse.ch/downloads/ipblocklist.json');
counts.feodo = fromFeodo(new TextDecoder().decode(feodo!), opts, entries);

const promoted = promoteClickFixHosts(opts, entries);
console.log(`Reports: URLhaus ${counts.urlhaus}, ThreatFox ${counts.threatfox}, Feodo ${counts.feodo}, ClickFix hosts ${promoted}, keys ${entries.size}`);
if (counts.urlhaus < 100) fail(`URLhaus gave only ${counts.urlhaus} reports, the export format may have changed`);
if (counts.threatfox < 100) fail(`ThreatFox gave only ${counts.threatfox} reports, the export format may have changed`);

const generated = opts.now.toISOString();
const sources: SourceCount[] = (Object.keys(counts) as FeedSource[]).map((id) => ({ id, name: SOURCE_LABELS[id], count: counts[id] }));
const all: FeedEntry[] = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const { hot, bulk } = splitEntries(all);
const hotFile: FeedPart = { format: 2, part: 'hot', generated, sources, entries: hot };
const bulkFile: FeedPart = { format: 2, part: 'bulk', generated, sources, entries: bulk };

const files: Record<string, Buffer> = {
  'hot.json': Buffer.from(JSON.stringify(hotFile)),
  'bulk.json': Buffer.from(JSON.stringify(bulkFile)),
  'rules.json': rulesText,
};

// The hourly delta is built against the hot.json that is live right now.
const previous = await download(`${PUBLIC_BASE}v1/hot.json`, true);
if (previous) {
  try {
    const prev = JSON.parse(new TextDecoder().decode(previous)) as FeedPart;
    if (prev.format === 2 && prev.part === 'hot' && prev.generated < generated) {
      const { put, del } = diffEntries(prev.entries, hot);
      const delta: FeedDelta = { format: 2, part: 'hot-delta', base: prev.generated, generated, sources, put, del };
      files['hot-delta.json'] = Buffer.from(JSON.stringify(delta));
      console.log(`Delta against ${prev.generated}: ${put.length} changed, ${del.length} removed`);
    }
  } catch {
    console.log('The live hot.json could not be read, publishing without a delta');
  }
}

mkdirSync(resolve(out, 'v1'), { recursive: true });
for (const [name, data] of Object.entries(files)) writeFileSync(resolve(out, 'v1', name), data);
writeFileSync(
  resolve(out, 'v1/meta.json'),
  JSON.stringify(
    {
      generated,
      keys: all.length,
      hot: hot.length,
      bulk: bulk.length,
      clickfix: all.filter(([, r]) => r.some((x) => x[1] === 'clickfix')).length,
      sources,
      rulesVersion: rules.version,
    },
    null,
    2,
  ),
);

if (!unsigned) {
  const pem = process.env.FEED_SIGNING_KEY;
  if (!pem?.includes('PRIVATE KEY')) fail('FEED_SIGNING_KEY is not set. Add the private key PEM as a repository secret.');
  for (const [name, data] of Object.entries(files)) writeFileSync(resolve(out, 'v1', name + '.sig'), signFile(data, pem));
}

cpSync(resolve(root, 'feed-builder/site'), out, { recursive: true });
writeFileSync(resolve(out, '.nojekyll'), '');
const mb = (b: Buffer | undefined) => (b ? (b.length / 1024 / 1024).toFixed(1) : '0') + ' MB';
console.log(`Written to ${out}, hot ${hot.length} (${mb(files['hot.json'])}), bulk ${bulk.length} (${mb(files['bulk.json'])}), delta ${mb(files['hot-delta.json'])}`);
