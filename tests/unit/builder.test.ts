import { describe, expect, it } from 'vitest';
import { ageDays, type BuildOptions, type Entries, fromFeodo, fromThreatfox, fromThreatfoxApi, fromUrlhaus, parseCsvLine, promoteClickFixHosts } from '../../feed-builder/sources';
import { BUNDLED_RULES } from '../../src/engine/rules';
import { diffEntries, type FeedEntry, refFor, splitEntries } from '../../src/feed/types';

// Synthetic rows in the abuse.ch export layout, with reserved test names only.
const now = new Date('2026-10-31T12:00:00Z');
const opts: BuildOptions = {
  clickfixTags: BUNDLED_RULES.feed.clickfixTags,
  noHostLevel: BUNDLED_RULES.feed.noHostLevel,
  now,
  maxAgeDays: 30,
  ipMaxAgeDays: 30,
  minConfidence: 50,
  minIpConfidence: 75,
};

const URLHAUS = `################################################################
# abuse.ch URLhaus Database Dump (CSV - recent URLs)           #
################################################################
#
# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter
"9001","2026-10-30 08:00:00","https://cdn.example.invalid/v.ps1","online","2026-10-31 10:00:00","malware_download","ClickFix,ps1","https://urlhaus.abuse.ch/url/9001/","tester"
"9002","2026-10-29 08:00:00","http://192.0.2.10/i.sh","offline","2026-10-29 09:00:00","malware_download","elf,mirai","https://urlhaus.abuse.ch/url/9002/","tester"
"9003","2026-08-01 08:00:00","http://old.example.invalid/x.exe","offline","2026-08-01 09:00:00","malware_download","exe","https://urlhaus.abuse.ch/url/9003/","tester"
"9004","2026-10-30 08:00:00","https://raw.githubusercontent.com/someone/repo/main/a.exe","online","","malware_download","exe","https://urlhaus.abuse.ch/url/9004/","tester"
`;

const THREATFOX = `# ThreatFox IOCs: CSV export
# "first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_printable","last_seen_utc","confidence_level","is_compromised","reference","tags","anonymous","reporter"
"2026-10-20 10:00:00","101","lure.example.invalid","domain","payload_delivery","js.clearfake","None","ClearFake","","100","0","","ClickFix,FakeCaptcha","0","tester"
"2026-10-21 10:00:00","102","https://evil.example.invalid/gate.php","url","payload_delivery","win.lumma","None","Lumma Stealer","","75","0","","Lumma","0","tester"
"2026-10-22 10:00:00","103","192.0.2.50:443","ip:port","botnet_cc","win.remcos","None","Remcos","","100","0","","Remcos","0","tester"
"2026-10-22 10:00:00","104","192.0.2.51:443","ip:port","botnet_cc","win.remcos","None","Remcos","","50","0","","Remcos","0","tester"
"2026-10-22 10:00:00","105","github.com","domain","payload_delivery","unknown","None","Unknown malware","","100","0","","","0","tester"
"2026-10-22 10:00:00","106","lowconf.example.invalid","domain","payload_delivery","unknown","None","Unknown malware","","25","0","","","0","tester"
"2026-10-22 10:00:00","107","0123456789abcdef0123456789abcdef","md5_hash","payload","win.lumma","None","Lumma Stealer","","100","0","","","0","tester"
`;

const FEODO = JSON.stringify([
  { ip_address: '192.0.2.60', port: 443, status: 'online', first_seen: '2026-10-01 00:00:00', last_online: '2026-10-30', malware: 'QakBot' },
  { ip_address: '192.0.2.61', port: 443, status: 'offline', first_seen: '2025-01-01 00:00:00', last_online: '2026-03-12', malware: 'Emotet' },
]);

describe('csv reader', () => {
  it('handles quotes, doubled quotes and commas in fields', () => {
    expect(parseCsvLine('"a","b,c","d ""e"""')).toEqual(['a', 'b,c', 'd "e"']);
  });
  it('reads abuse.ch dates', () => {
    expect(ageDays('2026-10-30 12:00:00', now)).toBe(1);
    expect(ageDays('2026-10-30', now)).toBe(1.5);
    expect(ageDays('', now)).toBe(Infinity);
  });
});

describe('URLhaus', () => {
  const entries: Entries = new Map();
  const count = fromUrlhaus(URLHAUS, opts, entries);
  it('keeps recent and online addresses and drops old offline ones', () => {
    expect(count).toBe(3);
    expect(entries.has('u:old.example.invalid/x.exe')).toBe(false);
  });
  it('marks ClickFix tags and keeps only those', () => {
    expect(entries.get('u:cdn.example.invalid/v.ps1')?.[0]).toEqual(['urlhaus', 'clickfix', '', '2026-10-30', '9001', ['ClickFix', 'ps1']]);
    expect(entries.get('u:192.0.2.10/i.sh')?.[0]).toEqual(['urlhaus', 'malware', '', '2026-10-29', '9002', []]);
  });
  it('never lists a whole shared host', () => {
    expect(entries.has('h:raw.githubusercontent.com')).toBe(false);
    expect(entries.has('u:raw.githubusercontent.com/someone/repo/main/a.exe')).toBe(true);
  });
});

describe('ClickFix hosts', () => {
  const entries: Entries = new Map();
  fromUrlhaus(URLHAUS, opts, entries);
  fromUrlhaus(
    `# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter
"9101","2026-10-30 08:00:00","https://cdn.jsdelivr.net/gh/x/y/a.js","online","","malware_download","ClickFix","",""\n"9102","2026-10-30 08:00:00","http://192.0.2.70/p.ps1","online","","malware_download","ClickFix","",""\n`,
    opts,
    entries,
  );
  const promoted = promoteClickFixHosts(opts, entries);
  it('lists the whole host of a reported ClickFix address', () => {
    expect(entries.get('h:cdn.example.invalid')?.[0]).toEqual(['urlhaus', 'clickfix', '', '2026-10-30', '9001', ['ClickFix', 'ps1']]);
    expect(entries.has('i:192.0.2.70')).toBe(false);
    expect(entries.has('u:192.0.2.70/p.ps1')).toBe(true);
    expect(promoted).toBe(1);
  });
  it('never lists a subdomain of a shared host as a whole', () => {
    const shared: Entries = new Map();
    fromUrlhaus(
      `# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter
"9301","2026-10-30 08:00:00","https://www.google.com/url?q=x","online","","malware_download","ClickFix","",""
"9302","2026-10-30 08:00:00","https://dl.dropbox.com/s/x/a.ps1","online","","malware_download","ClickFix","",""
`,
      opts,
      shared,
    );
    expect(promoteClickFixHosts(opts, shared)).toBe(0);
    expect(shared.has('h:www.google.com')).toBe(false);
    expect(shared.has('h:dl.dropbox.com')).toBe(false);
  });
  it('still lists a customer subdomain on a hosting platform as a whole', () => {
    const tenant: Entries = new Map();
    fromUrlhaus(
      `# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter
"9401","2026-10-30 08:00:00","https://verify-human-x.pages.dev/c.ps1","online","","malware_download","ClickFix","",""
`,
      opts,
      tenant,
    );
    expect(promoteClickFixHosts(opts, tenant)).toBe(1);
    expect(tenant.has('h:verify-human-x.pages.dev')).toBe(true);
    expect(tenant.has('h:pages.dev')).toBe(false);
  });
  it('leaves malware downloads and shared CDNs at the exact address', () => {
    expect(entries.has('i:192.0.2.10')).toBe(false);
    expect(entries.has('h:cdn.jsdelivr.net')).toBe(false);
    expect(entries.has('u:cdn.jsdelivr.net/gh/x/y/a.js')).toBe(true);
  });
});

describe('ThreatFox', () => {
  const entries: Entries = new Map();
  fromThreatfox(THREATFOX, opts, entries);
  it('adds domains, URLs and confident IPs', () => {
    expect(entries.get('h:lure.example.invalid')?.[0]).toEqual([
      'threatfox',
      'clickfix',
      'ClearFake',
      '2026-10-20',
      '101',
      ['ClickFix', 'FakeCaptcha'],
    ]);
    expect(entries.get('u:evil.example.invalid/gate.php')?.[0][1]).toBe('malware');
    expect(entries.get('i:192.0.2.50')?.[0][1]).toBe('c2');
  });
  it('skips weak, shared and non-network reports', () => {
    expect(entries.has('i:192.0.2.51')).toBe(false);
    expect(entries.has('h:github.com')).toBe(false);
    expect(entries.has('h:lowconf.example.invalid')).toBe(false);
    expect([...entries.keys()].some((k) => k.includes('0123456789abcdef'))).toBe(false);
  });
});

describe('addresses a browser would write differently', () => {
  const entries: Entries = new Map();
  fromUrlhaus(
    `# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter\n"9201","2026-10-30 08:00:00","http://192.0.2.80:443/boot","online","","malware_download","sh","",""\n`,
    opts,
    entries,
  );
  fromThreatfoxApi(
    JSON.stringify({
      query_status: 'ok',
      data: [{ id: '2010003', ioc: '0xf20221c0cf767eee759bbe1fb8dd76eaef0e5779', ioc_type: 'domain', threat_type: 'payload_delivery', malware_printable: 'ClearFake', malware_alias: null, confidence_level: 100, first_seen: '2026-10-31 11:29:00 UTC', last_seen: null, tags: ['etherhide'] }],
    }),
    opts,
    entries,
  );
  it('keeps an address reported with port 443 findable over https', () => {
    expect(entries.has('u:192.0.2.80:443/boot')).toBe(true);
    expect(entries.has('u:192.0.2.80/boot')).toBe(true);
  });
  it('skips blockchain contract addresses reported as domains', () => {
    expect(entries.has('h:0xf20221c0cf767eee759bbe1fb8dd76eaef0e5779')).toBe(false);
  });
});

describe('ThreatFox API', () => {
  const entries: Entries = new Map();
  const answer = JSON.stringify({
    query_status: 'ok',
    data: [
      { id: '2010001', ioc: 'fresh-lure.example.invalid', ioc_type: 'domain', threat_type: 'payload_delivery', malware_printable: 'ClearFake', malware_alias: null, confidence_level: 100, first_seen: '2026-10-31 11:29:00 UTC', last_seen: null, tags: ['compromised', 'etherhide'] },
      { id: '2010002', ioc: 'weak.example.invalid', ioc_type: 'domain', threat_type: 'payload_delivery', malware_printable: 'Unknown malware', malware_alias: null, confidence_level: 25, first_seen: '2026-10-31 11:29:00 UTC', last_seen: null, tags: null },
    ],
  });
  const count = fromThreatfoxApi(answer, opts, entries);
  it('adds reports minutes old with the same rules as the export', () => {
    expect(count).toBe(1);
    expect(entries.get('h:fresh-lure.example.invalid')?.[0]).toEqual(['threatfox', 'clickfix', 'ClearFake', '2026-10-31', '2010001', ['compromised', 'etherhide']]);
    expect(entries.has('h:weak.example.invalid')).toBe(false);
  });
  it('ignores an answer that is not ok', () => {
    expect(fromThreatfoxApi(JSON.stringify({ query_status: 'no_result' }), opts, new Map())).toBe(0);
  });
});

describe('Feodo Tracker', () => {
  it('keeps only recently active servers', () => {
    const entries: Entries = new Map();
    fromFeodo(FEODO, opts, entries);
    expect(entries.has('i:192.0.2.60')).toBe(true);
    expect(entries.has('i:192.0.2.61')).toBe(false);
  });
});

describe('hot and bulk parts', () => {
  const entries: FeedEntry[] = [
    ['h:lure.example.invalid', [['threatfox', 'clickfix', 'ClearFake', '2026-10-20', '101', []]]],
    ['i:192.0.2.50', [['threatfox', 'c2', 'Remcos', '2026-10-22', '103', []]]],
    ['u:cdn.example.invalid/v.ps1', [['urlhaus', 'clickfix', '', '2026-10-30', '9001', ['ClickFix']]]],
    ['u:192.0.2.10/i.sh', [['urlhaus', 'malware', '', '2026-10-29', '9002', []]]],
    ['u:evil.example.invalid/gate.php', [['threatfox', 'malware', 'Lumma Stealer', '2026-10-21', '102', []]]],
  ];
  it('keeps ClickFix, hosts, IPs and ThreatFox hot and plain URLhaus links in bulk', () => {
    const { hot, bulk } = splitEntries(entries);
    expect(hot.map((e) => e[0])).toEqual(['h:lure.example.invalid', 'i:192.0.2.50', 'u:cdn.example.invalid/v.ps1', 'u:evil.example.invalid/gate.php']);
    expect(bulk.map((e) => e[0])).toEqual(['u:192.0.2.10/i.sh']);
  });
  it('builds an hourly change list', () => {
    const next: FeedEntry[] = [
      entries[0],
      ['i:192.0.2.50', [['threatfox', 'c2', 'Remcos', '2026-10-22', '103', ['Remcos']]]],
      ['h:new.example.invalid', [['threatfox', 'clickfix', 'ClearFake', '2026-10-31', '104', []]]],
    ];
    const { put, del } = diffEntries(entries, next);
    expect(put.map((e) => e[0])).toEqual(['i:192.0.2.50', 'h:new.example.invalid']);
    expect(del).toEqual(['u:cdn.example.invalid/v.ps1', 'u:192.0.2.10/i.sh', 'u:evil.example.invalid/gate.php']);
  });
  it('turns report ids back into links', () => {
    expect(refFor('threatfox', '101')).toBe('https://threatfox.abuse.ch/ioc/101/');
    expect(refFor('urlhaus', '9001')).toBe('https://urlhaus.abuse.ch/url/9001/');
    expect(refFor('feodo', '192.0.2.60')).toBe('https://feodotracker.abuse.ch/browse/host/192.0.2.60/');
    expect(refFor('urlhaus', '../evil')).toBe('');
  });
});
