import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { checkOtpBudget, readOtpLedger } from './budget';
import type { Config } from './config';
import { RUN_ID_RE, ensureRunDirs, newRunId, runPaths } from './paths';

type Roots = Pick<Config, 'runsRoot' | 'cacheRoot' | 'otpBudget'>;

// Run artifacts must never be committable: inside a git work tree the folder has to be git-ignored.
export function assertRunsRootIgnored(runsRoot: string): void {
  let at = runsRoot;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const real = realpathSync(at);
  const inTree = spawnSync('git', ['-C', real, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inTree.error) throw new Error('cannot check that RUNS_DIR is git-ignored: git is not available');
  if (inTree.status !== 0 || inTree.stdout.trim() !== 'true') return; // not in a work tree
  const target = join(real, relative(at, runsRoot));
  const ignored = spawnSync('git', ['-C', real, 'check-ignore', '-q', '--', target]);
  if (ignored.status === 0) return;
  if (ignored.status === 1) throw new Error('RUNS_DIR is inside a git work tree and not git-ignored — use a gitignored folder such as `.scratch/`');
  throw new Error('cannot check that RUNS_DIR is git-ignored (git check-ignore failed)');
}

// Session state of earlier runs that never reached cleanup. Only run-id directories; never active/ or mcp-out/.
function purgeStaleCaches(cfg: Pick<Config, 'cacheRoot'>): void {
  if (!existsSync(cfg.cacheRoot)) return;
  for (const name of readdirSync(cfg.cacheRoot)) {
    const p = join(cfg.cacheRoot, name);
    if (RUN_ID_RE.test(name) && lstatSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  }
}

export function startRun(cfg: Roots, now = new Date()): { id: string; warnings: string[] } {
  const sent = checkOtpBudget(readOtpLedger(cfg), now, cfg.otpBudget);
  assertRunsRootIgnored(cfg.runsRoot);
  const id = newRunId(now);
  if (existsSync(runPaths(cfg, id).dir)) throw new Error(`run ${id} already exists — wait a minute and retry`);
  purgeStaleCaches(cfg);
  ensureRunDirs(cfg, id);
  const warnings = sent ? [`${sent} OTP codes sent in the last hour (new-run refuses at ${cfg.otpBudget.perHour})`] : [];
  return { id, warnings };
}
