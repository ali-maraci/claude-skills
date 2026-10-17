import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';

type Roots = Pick<Config, 'runsRoot' | 'cacheRoot'>;

export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;
export function assertRunId(id: string): void {
  if (!RUN_ID_RE.test(id)) throw new Error(`"${id}" is not a run id like 2026-10-10-0930`);
}
export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
export function runPaths(cfg: Roots, run: string) {
  assertRunId(run);
  const dir = join(cfg.runsRoot, run);
  const cache = join(cfg.cacheRoot, run);
  return {
    dir, cache,
    findings: join(dir, 'findings'), screens: join(dir, 'screens'), network: join(dir, 'network'),
    report: join(dir, 'report.md'), html: join(dir, 'report.html'),
    state: (persona: string) => join(cache, 'state', `${persona}.json`),
  };
}
export function ensureRunDirs(cfg: Roots, run: string): void {
  const p = runPaths(cfg, run);
  for (const d of [p.findings, p.screens, p.network]) mkdirSync(d, { recursive: true });
  mkdirSync(join(p.cache, 'state'), { recursive: true, mode: 0o700 });
}

// The browser MCP re-reads this one file for every new context, so personas are switched by swapping it.
export const EMPTY_STATE = { cookies: [], origins: [] };
export function activeStatePath(cfg: Pick<Config, 'cacheRoot'>): string {
  return join(cfg.cacheRoot, 'active', 'state.json');
}
function prepareActive(cfg: Pick<Config, 'cacheRoot'>): string {
  const out = activeStatePath(cfg);
  const dir = join(cfg.cacheRoot, 'active');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return out;
}
export function activateState(cfg: Roots, run: string, persona: 'member' | 'empty'): string {
  const out = prepareActive(cfg);
  if (persona === 'member') {
    const src = runPaths(cfg, run).state('member');
    if (!existsSync(src)) throw new Error(`setup-failed: no member session for run ${run} — run \`bug-hunt session member ${run}\` first`);
    copyFileSync(src, out);
  } else {
    writeFileSync(out, JSON.stringify(EMPTY_STATE));
  }
  chmodSync(out, 0o600);
  return out;
}
export function cleanupRun(cfg: Roots, run: string): void {
  rmSync(runPaths(cfg, run).cache, { recursive: true, force: true });
  activateState(cfg, run, 'empty');
}
