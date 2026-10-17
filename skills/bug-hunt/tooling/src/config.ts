import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import type { OtpBudget } from './budget';
import { isAllowedOrigin, isSelfTest, loadStagingOrigins } from './allowlist';

export const CONFIG_DIR = process.env.BUG_HUNT_CONFIG_DIR ?? join(homedir(), '.config', 'bug-hunt');

export interface Config {
  baseUrl: string;
  stagingOrigins: string[];
  imap: { host: string; port: number; user: string; password: string };
  mailboxBase: string;
  memberEmail: string;
  /** Exact subject line of the app's sign-in-code email. */
  otpSubject: string;
  otpBudget: OtpBudget;
  signIn: {
    loginPath: string;
    emailLabel: string;
    submitLabel: string;
    /** Accessible name of the code box; if it contains `{n}`, six per-digit boxes named `{n}`=1..6. */
    codeLabel: string;
    /** A page that redirects to login when signed out. */
    signedInPath: string;
    /** Text the app shows when a code request is throttled; empty = no rate-limit detection. */
    rateLimitedText: string;
  };
  configDir: string;
  cacheRoot: string;
  runsRoot: string;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const defaulted = <T extends z.ZodTypeAny>(schema: T, fallback: unknown) =>
  z.preprocess((v) => (v === '' || v == null ? fallback : v), schema);
const posInt = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().positive());
// A same-origin path: `//host` and `/\host` would resolve to another host.
const path = z.string().regex(/^\/(?![\/\\])/);
const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
// Error text is static: a bad value is never echoed.
const envSchema = (selfTest: boolean, origins: string[]) => z.object({
  APP_WEB_STAGING_URL: z.string().url()
    .refine((u) => isAllowedOrigin(originOf(u), selfTest, origins), `not a staging host (must be listed in staging-origins.txt${selfTest ? ', or localhost in self-test' : ''})`),
  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.preprocess((v) => (v === '' || v == null ? 993 : Number(v)), z.number().int().positive()),
  IMAP_USER: z.string().email(),
  IMAP_APP_PASSWORD: z.string().min(1),
  QA_MAILBOX_BASE: z.string().email().refine((e) => !e.split('@')[0].includes('+'), 'must not contain a +tag'),
  RUNS_DIR: z.string().min(1),
  OTP_SUBJECT: z.string().min(1),
  SIGNED_IN_PATH: path,
  LOGIN_PATH: defaulted(path, '/login'),
  EMAIL_LABEL: defaulted(z.string().min(1), 'Email address'),
  SUBMIT_LABEL: defaulted(z.string().min(1), 'Continue'),
  CODE_LABEL: defaulted(z.string().min(1), 'Code'),
  RATE_LIMITED_TEXT: z.string().optional(),
  OTP_BUDGET_PER_HOUR: defaulted(posInt, 8),
  OTP_BUDGET_PER_EMAIL: defaulted(posInt, 3),
});

export function plusAddress(base: string, tag: string): string {
  const [local, domain] = base.split('@');
  return `${local}+${tag}@${domain}`;
}

export function parseConfig(env: Record<string, string | undefined>, configDir = CONFIG_DIR, selfTest = isSelfTest()): Config {
  const stagingOrigins = loadStagingOrigins(configDir);
  const r = envSchema(selfTest, stagingOrigins).safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid ${join(configDir, '.env')}:\n${lines.join('\n')}`);
  }
  const e = r.data;
  return {
    baseUrl: new URL(e.APP_WEB_STAGING_URL).origin, // a path or query would break `${baseUrl}/login`
    stagingOrigins,
    imap: { host: e.IMAP_HOST, port: e.IMAP_PORT, user: e.IMAP_USER, password: e.IMAP_APP_PASSWORD },
    mailboxBase: e.QA_MAILBOX_BASE,
    memberEmail: plusAddress(e.QA_MAILBOX_BASE, 'qa-member'),
    otpSubject: e.OTP_SUBJECT,
    otpBudget: { perHour: e.OTP_BUDGET_PER_HOUR, perEmail: e.OTP_BUDGET_PER_EMAIL },
    signIn: {
      loginPath: e.LOGIN_PATH, emailLabel: e.EMAIL_LABEL, submitLabel: e.SUBMIT_LABEL, codeLabel: e.CODE_LABEL,
      signedInPath: e.SIGNED_IN_PATH, rateLimitedText: e.RATE_LIMITED_TEXT ?? '',
    },
    configDir,
    cacheRoot: join(homedir(), '.cache', 'bug-hunt'),
    runsRoot: expandHome(e.RUNS_DIR),
  };
}

export function loadConfig(configDir = CONFIG_DIR): Config {
  const p = join(configDir, '.env');
  if (!existsSync(p)) throw new Error(`missing ${p} — see skills/bug-hunt/SKILL.md "Setup"`);
  return parseConfig(parseEnv(readFileSync(p, 'utf8')), configDir);
}
