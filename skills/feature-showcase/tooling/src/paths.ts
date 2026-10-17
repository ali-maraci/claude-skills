import { join } from 'node:path';
import type { Config } from './config';

export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a ticket key like PROJ-123`);
}

export function showcasePaths(cfg: Config, key: string) {
  assertKey(key);
  const dir = join(cfg.outputDir, key);
  const work = join(dir, 'work');
  return {
    dir,
    work,
    storyboard: join(dir, 'storyboard.json'),
    mp4: join(dir, 'showcase.mp4'),
    srt: join(dir, 'transcript.srt'),
    transcript: join(dir, 'transcript.md'),
    probes: join(work, 'probe'),
  };
}
