import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isConsentFixPaste, matchProtocol, web3Host, externalScheme } from '../../src/engine/checks';
import { BUNDLED_RULES, isUsableRules, pickRules } from '../../src/engine/rules';
import { lookupKeysForUrl, urlKey } from '../../src/feed/keys';
import { verifySignature } from '../../src/feed/verify';

const rules = BUNDLED_RULES;

describe('lookup keys', () => {
  it('covers the exact address, the host and its parents', () => {
    const keys = lookupKeysForUrl('https://a.b.evil.example/path/x.ps1?y=1');
    expect(keys).toContain('u:a.b.evil.example/path/x.ps1?y=1');
    expect(keys).toContain('h:a.b.evil.example');
    expect(keys).toContain('h:evil.example');
    expect(keys).not.toContain('h:example');
  });
  it('ignores the scheme and keeps non-default ports', () => {
    expect(urlKey('http://evil.example:8080/a')).toBe('u:evil.example:8080/a');
    expect(urlKey('https://evil.example:443/a')).toBe('u:evil.example/a');
  });
  it('adds an IP key for IP hosts and skips non-web addresses', () => {
    expect(lookupKeysForUrl('http://192.0.2.10/a.exe')).toContain('i:192.0.2.10');
    expect(lookupKeysForUrl('chrome://settings')).toEqual([]);
  });
  it('matches with or without a trailing slash', () => {
    const keys = lookupKeysForUrl('https://evil.example/landing');
    expect(keys).toContain('u:evil.example/landing/');
  });
});

describe('signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
  const data = Buffer.from('{"format":1}');
  const sig = sign(null, data, privateKey).toString('base64');

  it('accepts a file signed with the key', async () => {
    expect(await verifySignature(new Uint8Array(data), sig, pub)).toBe(true);
  });
  it('rejects a changed file', async () => {
    expect(await verifySignature(new Uint8Array(Buffer.from('{"format":2}')), sig, pub)).toBe(false);
  });
  it('rejects another key and garbage', async () => {
    const other = generateKeyPairSync('ed25519').publicKey;
    const otherPub = Buffer.from((other.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    expect(await verifySignature(new Uint8Array(data), sig, otherPub)).toBe(false);
    expect(await verifySignature(new Uint8Array(data), 'not base64!', pub)).toBe(false);
  });
});

describe('rules files', () => {
  it('bundled rules are usable', () => {
    expect(isUsableRules(rules)).toBe(true);
  });
  it('carry a real date, the settings page shows it instead of the version number', () => {
    expect(rules.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(rules.updated + 'T00:00:00Z')).toBeLessThanOrEqual(Date.now());
  });
  it('a stored copy only wins when it is newer', () => {
    expect(pickRules({ ...rules, version: rules.version + 1 }).version).toBe(rules.version + 1);
    expect(pickRules({ ...rules, version: rules.version })).toBe(rules);
    expect(pickRules({ ...rules, version: 999, minEngine: 999 })).toBe(rules);
    expect(pickRules(null)).toBe(rules);
  });
  it('every regex in the rules compiles', () => {
    for (const r of rules.command) expect(() => new RegExp(r.re, 'im'), r.id).not.toThrow();
    for (const r of rules.page.instructions) expect(() => new RegExp(r.re, 'iu'), r.id).not.toThrow();
    for (const r of rules.protocols) expect(() => new RegExp(r.re, 'i'), r.id).not.toThrow();
  });
  it('every rule has an English label', () => {
    for (const r of [...rules.command, ...rules.protocols]) expect(r.label.en, r.id).toBeTruthy();
  });
});

describe('other checks', () => {
  it('spots ConsentFix sign-in links on untrusted pages only', () => {
    const link = 'http://localhost:53682/?code=0.AXEAabcdefghijklmnop&state=abc';
    expect(isConsentFixPaste(link, 'phish.example', rules)).toBe(true);
    expect(isConsentFixPaste(link, 'login.microsoftonline.com', rules)).toBe(false);
    expect(isConsentFixPaste('hello world', 'phish.example', rules)).toBe(false);
    expect(isConsentFixPaste('https://example.com/?q=code', 'phish.example', rules)).toBe(false);
  });
  it('matches dangerous protocol links', () => {
    expect(matchProtocol('applescript://com.apple.scripteditor?action=new&script=x', rules)?.id).toBe('proto-applescript');
    expect(matchProtocol('search-ms:query=a&crumb=location:\\\\192.0.2.1@SSL\\DavWWWRoot', rules)?.id).toBe('proto-search-ms');
    expect(matchProtocol('mailto:a@example.com', rules)).toBeNull();
    expect(matchProtocol('https://example.com', rules)).toBeNull();
    expect(externalScheme('zoommtg://zoom.us/join')).toBe('zoommtg');
    expect(matchProtocol('zoommtg://zoom.us/join', rules)).toBeNull();
  });
  it('tells test-network blockchain lookups from main-network ones', () => {
    expect(web3Host('https://data-seed-prebsc-1-s1.bnbchain.org:8545/', rules)).toBe('testnet');
    expect(web3Host('https://bsc-dataseed.binance.org/', rules)).toBe('mainnet');
    expect(web3Host('https://example.com/', rules)).toBeNull();
  });
});
