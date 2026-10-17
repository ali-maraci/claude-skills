import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowedUrl, isAllowedOrigin, loadStagingOrigins } from '../src/allowlist';
import cases from './fixtures/origin-cases.json';

const STAGING = 'https://app-staging.ab12.example.test';
const cfg = { baseUrl: STAGING, stagingOrigins: [STAGING] };

// Consumer of test/fixtures/origin-cases.json (shared with verifier-guard.test.ts).
// `file: null` means the staging-origins.txt file does not exist; a string is its exact contents.
function configDirFor(file: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'bh-origins-'));
  if (file !== null) writeFileSync(join(dir, 'staging-origins.txt'), file);
  return dir;
}

describe('loadStagingOrigins (shared origin-cases.json)', () => {
  it.each(cases.map((c) => [JSON.stringify(c.file), c] as const))('%s', (_n, c) => {
    const dir = configDirFor(c.file);
    if (!c.valid) {
      let msg = '';
      try { loadStagingOrigins(dir); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/^setup-failed: .*staging-origins\.txt/);
      // never echoes a line's value
      for (const line of (c.file ?? '').split(/\r?\n/).filter((l) => l.length > 3)) expect(msg).not.toContain(line);
      return;
    }
    const origins = loadStagingOrigins(dir);
    for (const o of c.allowed) expect(isAllowedOrigin(o, false, origins), o).toBe(true);
    for (const o of c.denied) expect(isAllowedOrigin(o, false, origins), o).toBe(false);
  });

  it('fails closed when the config dir does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-origins-'));
    expect(() => loadStagingOrigins(join(dir, 'nope'))).toThrow(/^setup-failed: staging origins file is missing or unreadable/);
  });

  it('fails closed when staging-origins.txt is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-origins-'));
    mkdirSync(join(dir, 'staging-origins.txt'));
    expect(() => loadStagingOrigins(dir)).toThrow(/^setup-failed: staging origins file is missing or unreadable/);
  });

  it.skipIf(process.getuid?.() === 0)('fails closed when staging-origins.txt is not readable (mode 000)', () => {
    const dir = configDirFor(`${STAGING}\n`);
    chmodSync(join(dir, 'staging-origins.txt'), 0o000);
    expect(() => loadStagingOrigins(dir)).toThrow(/^setup-failed: staging origins file is missing or unreadable/);
  });

  it('names the first invalid line by number, never by value', () => {
    expect(() => loadStagingOrigins(configDirFor(`# c\n${STAGING}\nnot-an-origin\n`))).toThrow(/staging origins file invalid at line 3 \(/);
    expect(() => loadStagingOrigins(configDirFor(`${STAGING}\n# c\r\n`))).toThrow(/staging origins file invalid at line 2 \(/);
  });
});

describe('isAllowedOrigin', () => {
  it('denies everything given an empty list, localhost only in self-test', () => {
    expect(isAllowedOrigin(STAGING, false, [])).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', false, [])).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', true, [])).toBe(true);
    expect(isAllowedOrigin('https://localhost:3000', true, [])).toBe(false);
  });
});

describe('assertAllowedUrl', () => {
  it('allows the staging origin, any path', () => {
    expect(() => assertAllowedUrl(`${STAGING}/items?x=1`, cfg, false)).not.toThrow();
  });
  it.each([
    'https://app.example.test/dashboard',
    `${STAGING}.evil.com/`,
    'http://app-staging.ab12.example.test/',
    'http://localhost:3000/',
  ])('refuses %s in normal mode', (u) => expect(() => assertAllowedUrl(u, cfg, false)).toThrow(/not an allowed/));
  it('self-test mode adds localhost and 127.0.0.1 only', () => {
    expect(() => assertAllowedUrl('http://localhost:3000/login', cfg, true)).not.toThrow();
    expect(() => assertAllowedUrl('http://127.0.0.1:3001/', cfg, true)).not.toThrow();
    expect(() => assertAllowedUrl('https://app.example.test/', cfg, true)).toThrow();
  });

  // the configured origin itself must be a listed staging origin
  it.each(['https://app.example.test', `${STAGING}.evil.com`, 'http://localhost:3000'])(
    'refuses everything when the configured origin %s is not listed (normal mode)', (baseUrl) => {
      expect(() => assertAllowedUrl(`${baseUrl}/dashboard`, { baseUrl, stagingOrigins: [STAGING] }, false)).toThrow(/not a listed staging origin/);
    });
  it('refuses everything with an empty origin list', () => {
    expect(() => assertAllowedUrl(`${STAGING}/x`, { baseUrl: STAGING, stagingOrigins: [] }, false)).toThrow(/not a listed staging origin/);
  });
  it('self-test: a localhost base is allowed, an unlisted base is still refused', () => {
    expect(() => assertAllowedUrl('http://localhost:3000/login', { baseUrl: 'http://localhost:3000', stagingOrigins: [STAGING] }, true)).not.toThrow();
    expect(() => assertAllowedUrl('https://app.example.test/', { baseUrl: 'https://app.example.test', stagingOrigins: [STAGING] }, true)).toThrow(/not a listed staging origin/);
  });
});
