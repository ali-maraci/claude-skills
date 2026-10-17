import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';

export const isSelfTest = (env: NodeJS.ProcessEnv = process.env) => env.BUG_HUNT_SELF_TEST === '1';

export const STAGING_ORIGINS_FILE = 'staging-origins.txt';

// The ONE origin-line grammar. hooks/verifier-guard.sh carries the same ERE character for character
// (the shared case table test/fixtures/origin-cases.json pins that they agree). There is no pattern
// syntax in the file: each line is one literal origin, compared by exact string equality.
const ORIGIN_LINE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
// Loopback/IP hosts: localhost, *.localhost, and any host whose last label is all digits or starts with 0x
// (WHATWG parses those as IPv4, e.g. 127.1, 2130706433, 0x7f000001). Same ERE as the hook.
const FORBIDDEN_HOST = /^https:\/\/([a-z0-9.-]*\.)?(localhost|[0-9]+|0x[a-z0-9-]*)(:[0-9]+)?$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Read `<configDir>/staging-origins.txt`: one origin per line, blank lines and `#` comment lines ignored.
 * Fails closed: a missing, unreadable, empty or invalid file throws, and a single bad line invalidates
 * the whole file. The message never echoes a line's value.
 */
export function loadStagingOrigins(configDir: string): string[] {
  const file = join(configDir, STAGING_ORIGINS_FILE);
  const fail = (why: string): never => { throw new Error(`setup-failed: ${why} (${file})`); };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return fail('staging origins file is missing or unreadable'); }
  // Same message as hooks/verifier-guard.sh: the first bad line by number (any CR, or a non-blank,
  // non-comment line that is not a well-formed, non-loopback origin), never its value.
  const lines = text.split('\n');
  const bad = (n: number): never => fail(`staging origins file invalid at line ${n + 1}`);
  const cr = lines.findIndex((l) => l.includes('\r'));
  if (cr >= 0) bad(cr);
  const origins: string[] = [];
  lines.forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    if (!ORIGIN_LINE.test(line) || FORBIDDEN_HOST.test(line)) bad(i);
    origins.push(line);
  });
  if (origins.length === 0) fail('staging origins file lists no origins');
  return origins;
}

/** Is `origin` a target bug-hunt may ever use: a listed staging origin, or localhost only in self-test. */
export function isAllowedOrigin(origin: string, selfTest: boolean, origins: string[]): boolean {
  return origins.includes(origin) || (selfTest && LOCAL.test(origin));
}

export function assertAllowedUrl(url: string, cfg: Pick<Config, 'baseUrl' | 'stagingOrigins'>, selfTest = isSelfTest()): void {
  const base = new URL(cfg.baseUrl).origin;
  if (!isAllowedOrigin(base, selfTest, cfg.stagingOrigins)) throw new Error(`the configured APP_WEB_STAGING_URL is not a listed staging origin (${STAGING_ORIGINS_FILE})`);
  const origin = new URL(url).origin;
  if (origin === base) return;
  if (selfTest && LOCAL.test(origin)) return;
  throw new Error(`${origin} is not an allowed bug-hunt origin (staging only${selfTest ? ' + localhost in self-test' : ''})`);
}
