import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleStoryboard } from './fixtures/storyboard';

const outputDir = mkdtempSync(join(tmpdir(), 'fs-out-'));
mkdirSync(join(outputDir, 'PROJ-123'), { recursive: true });
writeFileSync(join(outputDir, 'PROJ-123', 'storyboard.json'), JSON.stringify(sampleStoryboard()));

vi.mock('../src/config', async (orig) => ({
  ...(await orig<typeof import('../src/config')>()),
  loadConfig: () => ({ outputDir, stateDir: join(outputDir, 'state') }),
}));
vi.mock('../src/runner', () => ({ dryRun: vi.fn(async () => undefined), record: vi.fn() }));
// Stop produce right after the dry-run decision: nothing reaches ElevenLabs or staging.
vi.mock('../src/tts', () => ({ runTts: vi.fn(async () => { throw new Error('stop after dry-run stage'); }) }));

const { main } = await import('../src/cli');
const { dryRun } = await import('../src/runner');

describe('produce --once', () => {
  beforeEach(() => vi.mocked(dryRun).mockClear());

  it('runs the dry run by default', async () => {
    await expect(main(['produce', 'PROJ-123'])).rejects.toThrow(/stop after dry-run stage/);
    expect(dryRun).toHaveBeenCalledOnce();
  });

  it('skips the dry run with --once', async () => {
    await expect(main(['produce', 'PROJ-123', '--once'])).rejects.toThrow(/stop after dry-run stage/);
    expect(dryRun).not.toHaveBeenCalled();
  });
});
