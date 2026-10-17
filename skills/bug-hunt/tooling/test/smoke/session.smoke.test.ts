import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadConfig } from '../../src/config';
import { cleanupRun, newRunId, runPaths } from '../../src/paths';
import { signInMember } from '../../src/session';

// Uses one real OTP against staging — run deliberately.
describe('signInMember (live)', () => {
  it('signs in, stores a 0600 state with a session cookie, and cleans up', async () => {
    const cfg = loadConfig();
    const run = newRunId();
    const path = await signInMember(cfg, run);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toMatch(/session-token/);
    cleanupRun(cfg, run);
    expect(existsSync(runPaths(cfg, run).cache)).toBe(false);
  }, 120_000);
});
