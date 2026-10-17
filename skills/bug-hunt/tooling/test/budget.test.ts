import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOtpBudget, countSends, otpLedgerPath, readOtpLedger, recordOtpSend } from '../src/budget';

const now = new Date('2026-10-10T10:00:00Z');
const BUDGET = { perHour: 8, perEmail: 3 };
const ago = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();

describe('countSends', () => {
  it('counts only timestamps within the last hour and ignores junk lines', () => {
    const ledger = [ago(90), ago(61), ago(59), ago(30), ago(1), '', 'not a date', ago(0)].join('\n');
    expect(countSends(ledger, now)).toBe(4);
  });
  it('is zero for an empty ledger', () => expect(countSends('', now)).toBe(0));
});

describe('checkOtpBudget', () => {
  it('returns the count below the budget', () => {
    expect(checkOtpBudget(Array.from({ length: 7 }, () => ago(5)).join('\n'), now, BUDGET)).toBe(7);
  });
  it('refuses at the budget with the count', () => {
    const ledger = Array.from({ length: 8 }, () => ago(5)).join('\n');
    expect(() => checkOtpBudget(ledger, now, BUDGET)).toThrow(/^setup-failed: OTP budget — 8 codes sent in the last hour/);
  });
  it('honours the budget it is given', () => {
    const budget = { perHour: 2, perEmail: 1 };
    expect(() => checkOtpBudget([ago(5), ago(4)].join('\n'), now, budget)).toThrow(/^setup-failed: OTP budget — 2 codes sent in the last hour/);
    expect(checkOtpBudget(ago(5), now, budget)).toBe(1);
    expect(() => checkOtpBudget(ago(5), now, budget, 'qa+a@example.test')).toThrow(/this address/);
  });
});

describe('recordOtpSend', () => {
  it('appends one ISO line per send to a 0600 ledger under cacheRoot', () => {
    const cfg = { cacheRoot: join(mkdtempSync(join(tmpdir(), 'bh-bud-')), 'cache') };
    recordOtpSend(cfg, now);
    recordOtpSend(cfg, new Date(now.getTime() + 1000));
    expect(otpLedgerPath(cfg)).toBe(join(cfg.cacheRoot, 'otp-sends.log'));
    expect(readFileSync(otpLedgerPath(cfg), 'utf8')).toBe(`${now.toISOString()}\n${new Date(now.getTime() + 1000).toISOString()}\n`);
    expect(statSync(otpLedgerPath(cfg)).mode & 0o777).toBe(0o600);
    expect(countSends(readOtpLedger(cfg), new Date(now.getTime() + 2000))).toBe(2);
  });
  it('reads a missing ledger as empty', () => {
    expect(readOtpLedger({ cacheRoot: join(tmpdir(), 'bh-nope-does-not-exist') })).toBe('');
  });
});

describe('per-address budget (default: 3 codes/email/15 min)', () => {
  const a = 'qa+member@example.test';
  const b = 'qa+signup-001@example.test';
  it('tags sends with a hash of the address, never the address itself', () => {
    const cfg = { cacheRoot: join(mkdtempSync(join(tmpdir(), 'bh-bud-')), 'cache') };
    recordOtpSend(cfg, now, a);
    const line = readOtpLedger(cfg).trim();
    expect(line).toMatch(/^\S+ [0-9a-f]{12}$/);
    expect(line).not.toContain('qa');
    expect(countSends(line, now)).toBe(1);
  });
  it('refuses a 4th code to one address within 15 minutes, not to another address', () => {
    const cfg = { cacheRoot: join(mkdtempSync(join(tmpdir(), 'bh-bud-')), 'cache') };
    for (const m of [14, 10, 5]) recordOtpSend(cfg, new Date(now.getTime() - m * 60_000), a);
    expect(() => checkOtpBudget(readOtpLedger(cfg), now, BUDGET, a)).toThrow(/^setup-failed: OTP budget — 3 codes sent to this address in the last 15 minutes/);
    expect(checkOtpBudget(readOtpLedger(cfg), now, BUDGET, b)).toBe(3);
    expect(checkOtpBudget(readOtpLedger(cfg), new Date(now.getTime() + 60_001), BUDGET, a)).toBe(3);
  });
  it('counts untagged (older) lines against every address', () => {
    expect(() => checkOtpBudget([ago(3), ago(2), ago(1)].join('\n'), now, BUDGET, a)).toThrow(/this address/);
  });
});
