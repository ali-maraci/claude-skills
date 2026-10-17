import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnSurface, hasAuthSessionCookie, isLoginUrl, mergedStorageState } from '../src/browser/session';
import type { Config } from '../src/config';

describe('isLoginUrl', () => {
  it.each([
    ['https://x.test/login', true],
    ['https://x.test/admin/login?next=/admin/', true],
    ['https://x.test/auth/signin', true],
    ['https://x.test/sign-in/', true],
    ['https://x.test/items', false],
    ['https://x.test/blogin', false],
    ['https://x.test/items?login=1', false],
  ])('%s → %s', (url, expected) => expect(isLoginUrl(url)).toBe(expected));
});

describe('hasAuthSessionCookie', () => {
  const cookie = (name: string, expires = -1) => ({ name, value: 'v', domain: 'app.test', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' as const });
  const now = 1_800_000_000;

  it('accepts an Auth.js session cookie, plain, __Secure- prefixed or chunked', () => {
    expect(hasAuthSessionCookie([cookie('authjs.session-token')], now)).toBe(true);
    expect(hasAuthSessionCookie([cookie('__Secure-authjs.session-token')], now)).toBe(true);
    expect(hasAuthSessionCookie([cookie('__Secure-authjs.session-token.0', now + 60)], now)).toBe(true);
    expect(hasAuthSessionCookie([cookie('next-auth.session-token')], now)).toBe(true);
  });

  it('does not treat a custom signup-ticket cookie as a session', () => {
    expect(hasAuthSessionCookie([cookie('my_signup_ticket', now + 1800), cookie('__Secure-authjs.callback-url')], now)).toBe(false);
  });

  it('ignores the cookies a signed-out visit gets, and expired sessions', () => {
    expect(hasAuthSessionCookie([cookie('authjs.csrf-token'), cookie('__Secure-authjs.callback-url')], now)).toBe(false);
    expect(hasAuthSessionCookie([cookie('authjs.session-token', now - 1)], now)).toBe(false);
    expect(hasAuthSessionCookie([], now)).toBe(false);
  });
});

describe('mergedStorageState', () => {
  const cfgWith = (stateDir: string) => ({ stateDir }) as Config;

  it('merges cookies and origins from each surface file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-state-'));
    writeFileSync(join(dir, 'app-web.json'), JSON.stringify({ cookies: [{ name: 'a' }], origins: [{ origin: 'https://a' }] }));
    writeFileSync(join(dir, 'portal.json'), JSON.stringify({ cookies: [{ name: 'p' }], origins: [] }));
    const s = mergedStorageState(cfgWith(dir), ['app-web', 'portal']);
    expect(s.cookies.map((c) => c.name)).toEqual(['a', 'p']);
    expect(s.origins).toHaveLength(1);
  });

  it('tells you to run auth when a session file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-state-'));
    mkdirSync(dir, { recursive: true });
    expect(() => mergedStorageState(cfgWith(dir), ['portal'])).toThrow(/feature-showcase auth portal/);
  });
});

describe('assertOnSurface', () => {
  const surfaces = {
    'app-web': { baseUrl: 'https://app.test', signedInPath: '/' },
    portal: { baseUrl: 'https://portal.test/admin', signedInPath: '/dashboard' },
  } as Config['surfaces'];

  it('ignores surfaces that are not configured', () => {
    const only = { 'app-web': surfaces['app-web'] } as Config['surfaces'];
    expect(() => assertOnSurface('https://portal.test/admin/items', only, 'app-web')).toThrow(/left staging/);
  });

  it('passes on either staging origin', () => {
    expect(() => assertOnSurface('https://app.test/items', surfaces, 'app-web')).not.toThrow();
    expect(() => assertOnSurface('https://portal.test/admin/items', surfaces, 'app-web')).not.toThrow();
  });

  it('names the surface whose session expired when it lands on a login page', () => {
    expect(() => assertOnSurface('https://portal.test/admin/login', surfaces, 'app-web')).toThrow(/run: feature-showcase auth portal/);
  });

  it('fails when a redirect leaves staging (e.g. an SSO login page)', () => {
    expect(() => assertOnSurface('https://login.microsoftonline.com/x/oauth2/v2.0/authorize', surfaces, 'portal')).toThrow(
      /left staging for https:\/\/login\.microsoftonline\.com[\s\S]*feature-showcase auth portal/,
    );
  });
});
