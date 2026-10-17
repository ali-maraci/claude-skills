import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAndPurge, scanDir } from '../src/scan';

const PW = 'abcd efgh ijkl mnop';
const dirWith = (name: string, body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'bh-scan-'));
  mkdirSync(join(d, 'findings'));
  writeFileSync(join(d, 'findings', name), body);
  return d;
};

describe('scan', () => {
  it.each([
    ['pin', '{"pin":"1234"}'],
    ['authorization', 'Authorization: Bearer x'],
    ['auth cookie', '__Secure-authjs.session-token'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
    ['env key', 'IMAP_APP_PASSWORD=x'],
    ['password literal', `the pw is ${PW}`],
  ])('flags %s', (_rule, body) => {
    expect(scanDir(dirWith('a.json', body), PW).length).toBeGreaterThan(0);
  });
  it('passes a clean run', () => {
    expect(scanDir(dirWith('a.json', '{"title":"Upload button double-submits"}'), PW)).toEqual([]);
  });
  it('purges offenders and throws without echoing the secret', () => {
    const d = dirWith('bad.json', `x ${PW}`);
    let msg = '';
    try { scanAndPurge(d, PW); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/bad\.json/);
    expect(msg).not.toContain(PW);
    expect(existsSync(join(d, 'findings', 'bad.json'))).toBe(false);
  });
  it('skips binary screenshots', () => {
    const d = dirWith('a.json', '{}');
    writeFileSync(join(d, 'findings', 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(scanDir(d, PW)).toEqual([]);
  });
  it('flags a pin inside a JSON-escaped string value', () => {
    const body = JSON.stringify({ title: 'x', evidence: '{"pin": "1234"}' });
    expect(scanDir(dirWith('a.json', body), PW).length).toBeGreaterThan(0);
  });
  it('flags the JSON-escaped form of the imap password', () => {
    const pw = 'ab"cd\\ef';
    expect(scanDir(dirWith('a.json', JSON.stringify({ t: `x ${pw}` })), pw).length).toBeGreaterThan(0);
  });
  it('flags padded JWTs', () => {
    expect(scanDir(dirWith('a.json', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl='), PW).length).toBeGreaterThan(0);
  });
  it('never follows or deletes through symlinks', () => {
    const outside = mkdtempSync(join(tmpdir(), 'bh-out-'));
    writeFileSync(join(outside, 'secret.txt'), `x ${PW}`);
    const d = dirWith('a.json', '{}');
    symlinkSync(outside, join(d, 'linkdir'));
    symlinkSync(join(outside, 'secret.txt'), join(d, 'findings', 'link.txt'));
    expect(scanDir(d, PW).map((h) => h.rule)).toEqual(['symlink in run dir', 'symlink in run dir']);
    expect(() => scanAndPurge(d, PW)).toThrow(/symlink/);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
  });
  it.each(['a.yml', 'a.MD', 'a.har'])('scans unknown/upper-case extension %s', (name) => {
    expect(scanDir(dirWith(name, 'authorization=1'), PW).length).toBeGreaterThan(0);
  });
  it('skips upper-case image extensions', () => {
    const d = dirWith('a.json', '{}');
    writeFileSync(join(d, 'findings', 'x.PNG'), `authorization ${PW}`);
    expect(scanDir(d, PW)).toEqual([]);
  });
});
