import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateState, activeStatePath, cleanupRun, runPaths } from '../src/paths';
import type { Config } from '../src/config';

const run = '2026-10-10-0930';
const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'bh-act-'));
  return { runsRoot: join(root, 'runs'), cacheRoot: join(root, 'cache') } as Config;
};
const seedMember = (cfg: Config, content: string) => {
  const p = runPaths(cfg, run).state('member');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};
const mode = (p: string) => statSync(p).mode & 0o777;

describe('activateState', () => {
  it('member copies the run state byte-for-byte with 0600 file and 0700 dir', () => {
    const cfg = mk();
    const bytes = '{"cookies":[{"name":"session-token","value":"x"}],"origins":[]}\n';
    seedMember(cfg, bytes);
    const out = activateState(cfg, run, 'member');
    expect(out).toBe(activeStatePath(cfg));
    expect(readFileSync(out, 'utf8')).toBe(bytes);
    expect(mode(out)).toBe(0o600);
    expect(mode(join(cfg.cacheRoot, 'active'))).toBe(0o700);
  });
  it('empty writes the empty state', () => {
    const cfg = mk();
    const out = activateState(cfg, run, 'empty');
    expect(readFileSync(out, 'utf8')).toBe('{"cookies":[],"origins":[]}');
    expect(mode(out)).toBe(0o600);
  });
  it('member without a member state throws', () => {
    expect(() => activateState(mk(), run, 'member')).toThrow(/setup-failed: no member session/);
  });
  it('swapping member -> empty -> member leaves the right content each time', () => {
    const cfg = mk();
    seedMember(cfg, '{"cookies":[{"name":"a"}],"origins":[]}');
    const p = activeStatePath(cfg);
    activateState(cfg, run, 'member');
    expect(readFileSync(p, 'utf8')).toContain('"a"');
    activateState(cfg, run, 'empty');
    expect(readFileSync(p, 'utf8')).toBe('{"cookies":[],"origins":[]}');
    activateState(cfg, run, 'member');
    expect(readFileSync(p, 'utf8')).toContain('"a"');
    expect(mode(p)).toBe(0o600);
  });
  it('cleanupRun deletes the run cache and resets the active file to empty', () => {
    const cfg = mk();
    seedMember(cfg, '{"cookies":[{"name":"a"}],"origins":[]}');
    activateState(cfg, run, 'member');
    cleanupRun(cfg, run);
    expect(existsSync(runPaths(cfg, run).cache)).toBe(false);
    expect(readFileSync(activeStatePath(cfg), 'utf8')).toBe('{"cookies":[],"origins":[]}');
    expect(mode(activeStatePath(cfg))).toBe(0o600);
  });
});
