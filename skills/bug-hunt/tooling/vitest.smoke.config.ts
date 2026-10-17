import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/smoke/**/*.smoke.test.ts'], testTimeout: 180_000 } });
