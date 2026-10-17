import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';
import { extractCode, fetchRecent, pickCode, waitForCode, type MailMeta } from '../src/otp';
import type { Config } from '../src/config';
import { stubConfig } from './cfg-stub';

const SUBJECT = 'Your sign-in code';
const mail = (to: string, mins: number, code: string, subject = SUBJECT): MailMeta => ({
  to: [to], date: new Date(Date.UTC(2026, 9, 10, 10, mins)), subject,
  text: `Your sign-in code is:\n\n${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
});
const since = new Date(Date.UTC(2026, 9, 10, 10, 5));
const A = 'qa+signup-007@example.test';

describe('extractCode', () => {
  it('reads the zero-padded 6-digit code', () => expect(extractCode(mail(A, 6, '004213').text)).toBe('004213'));
  it('returns null without a code', () => expect(extractCode('hello')).toBeNull());
});

describe('pickCode', () => {
  it('matches on the subject it is given, not a built-in one', () => {
    expect(pickCode([mail(A, 6, '121212', 'Your code for Example App')], A, since, 'Your code for Example App')).toBe('121212');
    expect(pickCode([mail(A, 6, '121212')], A, since, 'Your code for Example App')).toBeNull();
  });
  it('ignores mail from before the request (an earlier run)', () => {
    expect(pickCode([mail(A, 4, '111111')], A, since, SUBJECT)).toBeNull();
  });
  it('ignores mail to another plus-address', () => {
    expect(pickCode([mail('qa+signup-008@example.test', 6, '222222')], A, since, SUBJECT)).toBeNull();
  });
  it('ignores other subjects', () => {
    expect(pickCode([mail(A, 6, '333333', 'Welcome to Example App')], A, since, SUBJECT)).toBeNull();
  });
  it('picks the newest qualifying code (after a resend)', () => {
    expect(pickCode([mail(A, 6, '444444'), mail(A, 8, '555555'), mail(A, 7, '666666')], A, since, SUBJECT)).toBe('555555');
  });
  it('matches the address case-insensitively', () => {
    expect(pickCode([mail('QA+Signup-007@Example.Test', 6, '777777')], A, since, SUBJECT)).toBe('777777');
  });
});

describe('waitForCode', () => {
  const cfg = stubConfig({ otpSubject: SUBJECT });
  it('polls until a code arrives', async () => {
    let calls = 0;
    const fetch = async () => (++calls < 3 ? [] : [mail(A, 6, '888888')]);
    await expect(waitForCode(cfg, A, { since, pollMs: 1, timeoutMs: 1000, fetch })).resolves.toBe('888888');
  });
  it('times out with a message naming the likely causes', async () => {
    await expect(waitForCode(cfg, A, { since, pollMs: 1, timeoutMs: 20, fetch: async () => [] }))
      .rejects.toThrow(/no code within .* may not be accepted by the app/);
  });
});

// F5: a fake ImapFlow — enough surface for fetchRecent, no network.
class FakeImap extends EventEmitter {
  searched: unknown[] = [];
  loggedOut = 0;
  constructor(private opts: { search?: () => Promise<number[]>; logout?: () => Promise<void>; source?: string } = {}) { super(); }
  async connect() {}
  async getMailboxLock() { return { release() {} }; }
  async search(q: unknown) { this.searched.push(q); return this.opts.search ? this.opts.search() : [1]; }
  async *fetch() { yield { source: Buffer.from(this.opts.source ?? ''), internalDate: new Date(Date.UTC(2026, 9, 10, 10, 6)) }; }
  async logout() { this.loggedOut++; if (this.opts.logout) await this.opts.logout(); }
  close() {}
}
const asClient = (f: FakeImap) => () => f as unknown as ImapFlow;
const RAW = `To: ${A}\r\nSubject: ${SUBJECT}\r\nContent-Type: text/plain\r\n\r\nYour sign-in code is:\r\n\r\n123456\r\n`;

describe('fetchRecent (F5)', () => {
  const cfg = stubConfig({ otpSubject: SUBJECT });
  it('narrows the IMAP search by recipient as well as subject and date', async () => {
    const f = new FakeImap({ source: RAW });
    const got = await fetchRecent(cfg, since, A, asClient(f));
    expect(f.searched).toHaveLength(1);
    expect(f.searched[0]).toMatchObject({ subject: SUBJECT, to: A });
    expect((f.searched[0] as { since: Date }).since).toBeInstanceOf(Date);
    expect(got).toEqual([expect.objectContaining({ to: [A], subject: SUBJECT })]);
    expect(extractCode(got[0].text)).toBe('123456');
    expect(f.loggedOut).toBe(1);
  });
  it('rejects on an async socket error instead of crashing or hanging', async () => {
    const f = new FakeImap({ search: () => new Promise(() => {}) });
    setTimeout(() => f.emit('error', new Error('ECONNRESET')), 5);
    await expect(fetchRecent(cfg, since, A, asClient(f))).rejects.toThrow('ECONNRESET');
    expect(f.loggedOut).toBe(1);
  });
  it('a failing logout never masks the original error', async () => {
    const f = new FakeImap({ search: async () => { throw new Error('search failed'); }, logout: async () => { throw new Error('logout failed'); } });
    await expect(fetchRecent(cfg, since, A, asClient(f))).rejects.toThrow('search failed');
  });
  it('a failing logout after a good read still returns the mail', async () => {
    const f = new FakeImap({ source: RAW, logout: async () => { throw new Error('logout failed'); } });
    await expect(fetchRecent(cfg, since, A, asClient(f))).resolves.toHaveLength(1);
  });
  it('waitForCode passes the address through to fetch', async () => {
    const seen: string[] = [];
    const fetch = async (_c: Config, _s: Date, address: string) => { seen.push(address); return [mail(A, 6, '999999')]; };
    await expect(waitForCode(stubConfig({ otpSubject: SUBJECT }), A, { since, pollMs: 1, timeoutMs: 100, fetch })).resolves.toBe('999999');
    expect(seen).toEqual([A]);
  });
});

