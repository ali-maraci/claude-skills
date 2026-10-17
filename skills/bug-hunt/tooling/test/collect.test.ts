import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/collect';
import { scanDir } from '../src/scan';

const network = [
  '[GET] https://s.test/dashboard => [200] OK',
  '[POST] https://s.test/api/items?x=1 => [500] Internal Server Error',
  '[GET] https://s.test/_next/static/a.js => [404] Not Found',
  '[POST] https://s.test/api/session => [200] OK',
  '[GET] https://s.test/api/slow => [FAILED] net::ERR_ABORTED',
].join('\n');
const consoleText = '[LOG] hi\n[ERROR] TypeError: x is undefined at signature=abc\n[WARNING] w';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const cleanScan = (data: unknown) => {
  const d = mkdtempSync(join(tmpdir(), 'bh-col-'));
  mkdirSync(join(d, 'network'));
  writeFileSync(join(d, 'network', 'a.json'), JSON.stringify(data));
  return scanDir(d, 'pw-never-present');
};

describe('collect', () => {
  it('keeps 4xx/5xx/failed requests with redacted URLs, and console errors only', () => {
    const r = collect({ console: consoleText, network });
    expect(r.failed).toEqual([
      { method: 'POST', url: 'https://s.test/api/items', status: 500 },
      { method: 'GET', url: 'https://s.test/_next/static/a.js', status: 404 },
      { method: 'GET', url: 'https://s.test/api/slow', status: 'failed' },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/TypeError/);
    expect(r.errors[0]).not.toMatch(/abc/);
  });
  it('parses the real Playwright MCP fixtures', () => {
    const r = collect({ console: fx('console-messages.txt'), network: fx('network-requests.txt') });
    expect(r.failed.map((f) => [f.status, new URL(f.url).pathname])).toEqual([
      [404, '/no-such-page-probe'],
      [404, '/api/probe-missing'],
      ['failed', '/unreachable'],
    ]);
    expect(r.errors).toHaveLength(5);
    expect(r.errors.some((e) => e.includes('WARNING'))).toBe(false);
    const out = JSON.stringify(r);
    expect(out).not.toContain('?x=1');
    expect(out).not.toContain('_rsc=');
    expect(out).not.toContain('/settings');
  });
  it('produces scan-clean output', () => {
    const dirty = collect({
      console: '[ERROR] bad signature=abc "pin": "1" Authorization: Bearer x authjs.session-token=q eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl missing signature',
      network,
    });
    expect(cleanScan(dirty)).toEqual([]);
    expect(cleanScan(collect({ console: fx('console-messages.txt'), network: fx('network-requests.txt') }))).toEqual([]);
  });
  it('redacts secret-looking URL paths and keeps normal password prose scan-clean', () => {
    const r = collect({
      console: '[ERROR] Password field is required and "current-password" missing',
      network: '[GET] https://s.test/x/user_abc/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl => [500] ',
    });
    expect(cleanScan(r)).toEqual([]);
  });
  it('a wss console line keeps no signature or agent_id query', () => {
    const line = "[ERROR] WebSocket connection to 'wss://realtime.example.test/v1/stream?agent_id=agent_01jx9fake&signature=cvtkn_01FAKESIGVALUE' failed: Connection closed before receiving a handshake response @ https://app-staging.ab12.example.test/_next/static/chunks/app/chat/page-1a2b.js:1";
    const r = collect({ console: line, network: '' });
    expect(r.errors).toHaveLength(1);
    const out = JSON.stringify(r);
    expect(out).not.toMatch(/cvtkn_01FAKESIGVALUE|signature|agent_id=|agent_01jx9fake/);
    expect(out).toContain('wss://realtime.example.test/v1/stream');
    expect(cleanScan(r)).toEqual([]);
  });
});

