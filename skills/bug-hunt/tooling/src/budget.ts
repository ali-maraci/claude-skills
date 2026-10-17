import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';

// The budget (OTP_BUDGET_PER_HOUR / OTP_BUDGET_PER_EMAIL, defaults 8 and 3) should sit below the app's own
// send limits, to leave headroom for the verifier's in-scenario "resend" clicks, which this ledger can't see.
export interface OtpBudget { perHour: number; perEmail: number }
const HOUR = 3_600_000;
const EMAIL_WINDOW = 15 * 60_000;
// The ledger never holds the address itself, only a short hash of it.
const addressTag = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);

type Cache = Pick<Config, 'cacheRoot'>;
export const otpLedgerPath = (cfg: Cache) => join(cfg.cacheRoot, 'otp-sends.log');

/** Append one timestamp line, tagged with the address when known: a code is (about to be) requested. */
export function recordOtpSend(cfg: Cache, now = new Date(), email?: string): void {
  mkdirSync(cfg.cacheRoot, { recursive: true, mode: 0o700 });
  const p = otpLedgerPath(cfg);
  appendFileSync(p, `${now.toISOString()}${email ? ` ${addressTag(email)}` : ''}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}
export function readOtpLedger(cfg: Cache): string {
  const p = otpLedgerPath(cfg);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
/** Sends within the window before `now` (later stamps count too: clock skew errs on the safe side). */
// With `email`, counts only sends to that address; untagged (older) lines count for every address.
export function countSends(ledger: string, now: Date, windowMs = HOUR, email?: string): number {
  const from = now.getTime() - windowMs;
  const tag = email ? addressTag(email) : undefined;
  return ledger.split('\n').filter((l) => {
    const [stamp = '', lineTag] = l.trim().split(' ');
    const t = Date.parse(stamp);
    return !Number.isNaN(t) && t > from && (!tag || !lineTag || lineTag === tag);
  }).length;
}
/** Returns the count in the last hour; throws once it reaches the budget, or the address's 15-minute cap. */
export function checkOtpBudget(ledger: string, now: Date, budget: OtpBudget, email?: string): number {
  const n = countSends(ledger, now);
  if (n >= budget.perHour) throw new Error(`setup-failed: OTP budget — ${n} codes sent in the last hour; wait and retry`);
  if (email) {
    const e = countSends(ledger, now, EMAIL_WINDOW, email);
    if (e >= budget.perEmail) {
      throw new Error(`setup-failed: OTP budget — ${e} codes sent to this address in the last 15 minutes; wait and retry`);
    }
  }
  return n;
}
