import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../src/config';

const STG = 'https://app-staging.ab12.example.test';
const cfgDir = (origins: string | null = `${STG}\n`) => {
  const d = mkdtempSync(join(tmpdir(), 'bh-cfg-'));
  if (origins !== null) writeFileSync(join(d, 'staging-origins.txt'), origins);
  return d;
};
const CFG = cfgDir();

const base = {
  APP_WEB_STAGING_URL: 'https://app-staging.ab12.example.test/',
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'qa@example.test',
  IMAP_APP_PASSWORD: 'abcd efgh ijkl mnop',
  QA_MAILBOX_BASE: 'qa@example.test',
  RUNS_DIR: '~/bug-hunt/runs',
  OTP_SUBJECT: 'Your sign-in code',
  SIGNED_IN_PATH: '/account',
};

describe('parseConfig', () => {
  it('normalises the base URL, defaults the port, derives the member address and expands ~', () => {
    const c = parseConfig(base, CFG, false);
    expect(c.baseUrl).toBe(STG);
    expect(c.imap.port).toBe(993);
    expect(c.memberEmail).toBe('qa+qa-member@example.test');
    expect(c.runsRoot).toBe(`${homedir()}/bug-hunt/runs`);
    expect(c.stagingOrigins).toEqual([STG]);
    expect(c.cacheRoot).toBe(`${homedir()}/.cache/bug-hunt`);
  });

  it('defaults the sign-in and budget settings', () => {
    const c = parseConfig(base, CFG, false);
    expect(c.otpSubject).toBe('Your sign-in code');
    expect(c.signIn).toEqual({
      loginPath: '/login', emailLabel: 'Email address', submitLabel: 'Continue', codeLabel: 'Code',
      signedInPath: '/account', rateLimitedText: '',
    });
    expect(c.otpBudget).toEqual({ perHour: 8, perEmail: 3 });
  });
  it('reads the optional sign-in and budget settings', () => {
    const c = parseConfig({
      ...base, LOGIN_PATH: '/signin', EMAIL_LABEL: 'Your email', SUBMIT_LABEL: 'Next', CODE_LABEL: 'Digit {n}',
      RATE_LIMITED_TEXT: 'Slow down', OTP_BUDGET_PER_HOUR: '5', OTP_BUDGET_PER_EMAIL: '2',
    }, CFG, false);
    expect(c.signIn).toEqual({
      loginPath: '/signin', emailLabel: 'Your email', submitLabel: 'Next', codeLabel: 'Digit {n}',
      signedInPath: '/account', rateLimitedText: 'Slow down',
    });
    expect(c.otpBudget).toEqual({ perHour: 5, perEmail: 2 });
  });
  it.each(['OTP_SUBJECT', 'SIGNED_IN_PATH'])('rejects a missing %s', (key) => {
    const env: Record<string, string | undefined> = { ...base };
    delete env[key];
    expect(() => parseConfig(env, CFG, false)).toThrow(new RegExp(key));
  });
  it('rejects a SIGNED_IN_PATH that is not a path', () => {
    expect(() => parseConfig({ ...base, SIGNED_IN_PATH: 'account' }, CFG, false)).toThrow(/SIGNED_IN_PATH/);
  });

  it.each([['SIGNED_IN_PATH', '//evil.example.test/x'], ['SIGNED_IN_PATH', '/\\evil.example.test/x'], ['LOGIN_PATH', '//evil.example.test/x'], ['LOGIN_PATH', '/\\evil.example.test/x']])('rejects an off-origin %s (%s)', (key, v) => {
    expect(() => parseConfig({ ...base, [key]: v }, CFG, false)).toThrow(new RegExp(key));
  });

  it('names bad variables without echoing their values', () => {
    let msg = '';
    try { parseConfig({ ...base, IMAP_APP_PASSWORD: '', APP_WEB_STAGING_URL: 'SECRETVALUE' }, CFG, false); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/IMAP_APP_PASSWORD/);
    expect(msg).toMatch(/APP_WEB_STAGING_URL/);
    expect(msg).not.toMatch(/SECRETVALUE/);
  });

  it('refuses a mailbox base with a plus tag already in it', () => {
    expect(() => parseConfig({ ...base, QA_MAILBOX_BASE: 'qa+x@example.test' }, CFG, false)).toThrow(/QA_MAILBOX_BASE/);
  });

  // F1 / R24: staging-only is enforced in code, not just by the operator's env
  it.each([
    ['prod', 'https://app.example.test'],
    ['lookalike', `${STG}.evil.com`],
    ['http staging', 'http://app-staging.ab12.example.test'],
    ['unlisted sibling', 'https://other-staging.ab12.example.test'],
    ['localhost', 'http://localhost:3000'],
  ])('refuses a non-staging APP_WEB_STAGING_URL (%s) without echoing it', (_n, url) => {
    let msg = '';
    try { parseConfig({ ...base, APP_WEB_STAGING_URL: url }, CFG, false); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/APP_WEB_STAGING_URL: not a staging host/);
    expect(msg).not.toContain(url);
  });
  it('allows localhost / 127.0.0.1 only in self-test, never prod', () => {
    expect(parseConfig({ ...base, APP_WEB_STAGING_URL: 'http://localhost:3000' }, CFG, true).baseUrl).toBe('http://localhost:3000');
    expect(parseConfig({ ...base, APP_WEB_STAGING_URL: 'http://127.0.0.1:3001/' }, CFG, true).baseUrl).toBe('http://127.0.0.1:3001');
    const stg = STG;
    expect(parseConfig({ ...base, APP_WEB_STAGING_URL: `${stg}/?ref=1` }, CFG, false).baseUrl).toBe(stg);
    expect(() => parseConfig({ ...base, APP_WEB_STAGING_URL: 'https://app.example.test' }, CFG, true)).toThrow(/not a staging host/);
  });
  it('accepts any origin listed in staging-origins.txt, exactly', () => {
    const d = cfgDir(`# two hosts\n${STG}\nhttps://other-staging.ab12.example.test:8443\n`);
    expect(parseConfig({ ...base, APP_WEB_STAGING_URL: 'https://other-staging.ab12.example.test:8443/x' }, d, false).baseUrl).toBe('https://other-staging.ab12.example.test:8443');
    expect(() => parseConfig({ ...base, APP_WEB_STAGING_URL: 'https://other-staging.ab12.example.test' }, d, false)).toThrow(/not a staging host/);
  });
  it.each([
    ['missing', null],
    ['empty', ''],
    ['one bad line', `${STG}\nhttp://bad.example.test\n`],
  ])('fails closed when staging-origins.txt is %s', (_n, contents) => {
    const d = cfgDir(contents);
    let msg = '';
    try { parseConfig(base, d, false); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^setup-failed: .*staging-origins\.txt/);
    expect(msg).not.toContain('bad.example.test');
  });
  it('the error names staging-origins.txt without echoing the value', () => {
    let msg = '';
    try { parseConfig({ ...base, APP_WEB_STAGING_URL: 'https://secretvalue.example.test' }, CFG, false); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/staging-origins\.txt/);
    expect(msg).not.toContain('secretvalue');
  });
});
