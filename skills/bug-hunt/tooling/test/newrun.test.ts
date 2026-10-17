import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRun } from '../src/newrun';

const now = new Date(2026, 9, 10, 9, 30, 15);
const ID = '2026-10-10-0930';
const mk = (runsSub = 'runs') => {
  const root = mkdtempSync(join(tmpdir(), 'bh-new-'));
  return { root, cfg: { runsRoot: join(root, runsSub), cacheRoot: join(root, 'cache'), otpBudget: { perHour: 8, perEmail: 3 } } };
};
const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

describe('startRun (F6)', () => {
  it('creates the run outside a git repo and returns its id', () => {
    const { cfg } = mk();
    expect(startRun(cfg, now).id).toBe(ID);
    expect(existsSync(join(cfg.runsRoot, ID, 'findings'))).toBe(true);
  });
  it('refuses when the run dir already exists (same minute)', () => {
    const { cfg } = mk();
    startRun(cfg, now);
    expect(() => startRun(cfg, now)).toThrow(/run 2026-10-10-0930 already exists — wait a minute and retry/);
  });
  it('refuses a RUNS_DIR inside a git work tree that is not git-ignored', () => {
    const { root, cfg } = mk('.scratch/bug-hunt/runs');
    expect(git(root, 'init', '-q').status).toBe(0);
    expect(() => startRun(cfg, now)).toThrow(/RUNS_DIR is inside a git work tree and not git-ignored/);
    expect(existsSync(cfg.runsRoot)).toBe(false);
  });
  it('accepts a git-ignored RUNS_DIR inside a repo, even before it exists', () => {
    const { root, cfg } = mk('.scratch/bug-hunt/runs');
    expect(git(root, 'init', '-q').status).toBe(0);
    writeFileSync(join(root, '.gitignore'), '/.scratch/\n');
    expect(startRun(cfg, now).id).toBe(ID);
  });
  it('deletes stale run caches only (never active/, mcp-out/, the OTP ledger or other names)', () => {
    const { cfg } = mk();
    for (const d of ['2026-10-09-0900/state', '2026-10-08-1200', 'active', 'mcp-out/bug-hunt', 'notes-2026']) mkdirSync(join(cfg.cacheRoot, d), { recursive: true });
    writeFileSync(join(cfg.cacheRoot, 'otp-sends.log'), '');
    writeFileSync(join(cfg.cacheRoot, '2026-10-07-0800'), 'a file, not a run dir');
    startRun(cfg, now);
    expect(existsSync(join(cfg.cacheRoot, '2026-10-09-0900'))).toBe(false);
    expect(existsSync(join(cfg.cacheRoot, '2026-10-08-1200'))).toBe(false);
    for (const keep of ['active', 'mcp-out/bug-hunt', 'notes-2026', 'otp-sends.log', '2026-10-07-0800', `${ID}/state`]) {
      expect(existsSync(join(cfg.cacheRoot, keep))).toBe(true);
    }
  });
  it('refuses over the OTP budget before creating anything, and warns below it', () => {
    const { cfg } = mk();
    mkdirSync(cfg.cacheRoot, { recursive: true });
    writeFileSync(join(cfg.cacheRoot, 'otp-sends.log'), Array.from({ length: 8 }, () => now.toISOString()).join('\n'));
    expect(() => startRun(cfg, now)).toThrow(/OTP budget — 8 codes/);
    expect(existsSync(cfg.runsRoot)).toBe(false);
    writeFileSync(join(cfg.cacheRoot, 'otp-sends.log'), `${now.toISOString()}\n`);
    expect(startRun(cfg, now).warnings).toEqual([expect.stringMatching(/^1 OTP codes sent in the last hour/)]);
  });
});
