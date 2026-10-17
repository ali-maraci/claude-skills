import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRunId, ensureRunDirs, runPaths } from '../src/paths';
import type { Config } from '../src/config';

const root = mkdtempSync(join(tmpdir(), 'bh-'));
const cfg = { runsRoot: join(root, 'runs'), cacheRoot: join(root, 'cache') } as Config;

describe('runPaths', () => {
  it('keeps session state in the cache, never under runs', () => {
    const p = runPaths(cfg, '2026-10-10-0930');
    expect(p.state('member')).toBe(join(root, 'cache', '2026-10-10-0930', 'state', 'member.json'));
    expect(p.state('member').startsWith(cfg.runsRoot)).toBe(false);
  });
  it('rejects run ids that could escape the directory', () => {
    expect(() => assertRunId('../x')).toThrow();
    expect(() => assertRunId('2026-10-10-0930')).not.toThrow();
  });
  it('creates the cache state dir as 0700', () => {
    ensureRunDirs(cfg, '2026-10-10-0931');
    expect(statSync(join(root, 'cache', '2026-10-10-0931', 'state')).mode & 0o777).toBe(0o700);
  });
});
