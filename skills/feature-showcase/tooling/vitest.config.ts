import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests never read the real ~/.config/feature-showcase: point it at an empty temp dir unless the caller chose one.
const configDir = process.env.FEATURE_SHOWCASE_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'fs-test-cfg-'));

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/smoke/**'], env: { FEATURE_SHOWCASE_CONFIG_DIR: configDir } },
});
