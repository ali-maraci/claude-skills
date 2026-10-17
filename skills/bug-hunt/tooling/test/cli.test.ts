import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real CLI with HOME and the config dir pointed at a temp dir, so ~/.cache and ~/.config are never touched.
const BIN = join(__dirname, '../bin/bug-hunt');
const STAGING = 'https://app-staging.ab12.example.test';
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bh-cli-'));
  const configDir = join(home, 'cfg');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'staging-origins.txt'), `${STAGING}\n`);
  writeFileSync(join(configDir, '.env'), [
    `APP_WEB_STAGING_URL=${STAGING}`, 'IMAP_HOST=imap.example.test', 'IMAP_USER=qa@example.test',
    'IMAP_APP_PASSWORD=not-a-real-password', 'QA_MAILBOX_BASE=qa@example.test', 'OTP_SUBJECT=Your sign-in code', 'SIGNED_IN_PATH=/account', `RUNS_DIR=${join(home, 'runs')}`,
  ].join('\n'));
  const cache = join(home, '.cache', 'bug-hunt');
  const cli = (...args: string[]) => spawnSync('sh', [BIN, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, BUG_HUNT_CONFIG_DIR: configDir },
  });
  return { home, configDir, cache, cli };
}

describe('cli OTP ledger (F4)', () => {
  it('session reserve-signup records a send in the ledger', () => {
    const s = sandbox();
    writeFileSync(join(s.configDir, 'signup-pool.txt'), 'qa+signup-001@example.test\n');
    const r = s.cli('session', 'reserve-signup', '2026-10-10-0930');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('qa+signup-001@example.test');
    expect(readFileSync(join(s.cache, 'otp-sends.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('session reserve-signup refuses at 8 sends without taking an address', () => {
    const s = sandbox();
    writeFileSync(join(s.configDir, 'signup-pool.txt'), 'qa+signup-001@example.test\n');
    mkdirSync(s.cache, { recursive: true });
    writeFileSync(join(s.cache, 'otp-sends.log'), Array.from({ length: 8 }, () => new Date().toISOString()).join('\n') + '\n');
    const r = s.cli('session', 'reserve-signup', '2026-10-10-0930');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/OTP budget/);
    expect(readFileSync(join(s.configDir, 'signup-pool.txt'), 'utf8')).toMatch(/signup-001/);
  });
  it('new-run warns with the hourly count, and refuses at 8', () => {
    const s = sandbox();
    mkdirSync(s.cache, { recursive: true });
    const stamp = () => new Date().toISOString();
    writeFileSync(join(s.cache, 'otp-sends.log'), Array.from({ length: 3 }, stamp).join('\n') + '\n');
    const ok = s.cli('new-run');
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(ok.stderr).toMatch(/3 OTP codes sent in the last hour/);
    writeFileSync(join(s.cache, 'otp-sends.log'), Array.from({ length: 8 }, stamp).join('\n') + '\n');
    const no = s.cli('new-run');
    expect(no.status).toBe(1);
    expect(no.stderr).toMatch(/setup-failed: OTP budget — 8 codes sent in the last hour/);
    expect(existsSync(join(s.home, 'runs'))).toBe(true);
  });
});
