import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveSignup } from '../src/pool';
import type { Config } from '../src/config';

const mk = (pool: string) => {
  const configDir = mkdtempSync(join(tmpdir(), 'bh-pool-'));
  writeFileSync(join(configDir, 'signup-pool.txt'), pool);
  return { configDir } as Config;
};

describe('reserveSignup', () => {
  it('takes the first address and records it as used, whatever happens next', () => {
    const cfg = mk('qa+signup-001@example.test\nqa+signup-002@example.test\n');
    expect(reserveSignup(cfg)).toBe('qa+signup-001@example.test');
    expect(readFileSync(join(cfg.configDir, 'signup-pool.txt'), 'utf8')).toBe('qa+signup-002@example.test\n');
    expect(readFileSync(join(cfg.configDir, 'used.txt'), 'utf8')).toMatch(/^qa\+signup-001@example\.test\t\d{4}-/);
  });
  it('skips blank lines and comments', () => {
    expect(reserveSignup(mk('# invited 2026-10-10\n\nqa+signup-003@example.test\n'))).toBe('qa+signup-003@example.test');
  });
  it('fails with the design wording when empty', () => {
    expect(() => reserveSignup(mk('\n'))).toThrow(/setup-failed: pool empty/);
  });
});
