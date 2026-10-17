import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import { runTool } from '../exec';
import { VIEWPORT } from './session';

const QUALITY = 90; // JPEG quality of each screencast frame

export interface Frame {
  file: string;
  t: number;
}

// Records via Chrome's CDP screencast: frames arrive only when the page repaints, each
// stamped with seconds since start(). One clock (performance.now) is shared with the
// runner's scene timings, so scene offsets and frames line up exactly.
export class ScreencastRecorder {
  private session?: CDPSession;
  private frames: Frame[] = [];
  private t0 = 0;
  private n = 0;

  constructor(private page: Page, private dir: string) {}

  async start(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true }); // never mix in frames from a previous run
    mkdirSync(this.dir, { recursive: true });
    this.session = await this.page.context().newCDPSession(this.page);
    this.t0 = performance.now();
    this.session.on('Page.screencastFrame', async ({ data, sessionId }) => {
      const file = `${String(this.n++).padStart(6, '0')}.jpg`;
      writeFileSync(join(this.dir, file), Buffer.from(data, 'base64'));
      this.frames.push({ file, t: this.now() });
      await this.session?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.send('Page.startScreencast');
  }

  // Cross-origin navigations can swap the renderer; restarting is cheap and idempotent.
  async restart(): Promise<void> {
    await this.session?.send('Page.stopScreencast').catch(() => {});
    await this.send('Page.startScreencast');
  }

  now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  async stop(): Promise<{ frames: Frame[]; end: number }> {
    const end = this.now();
    await this.session?.send('Page.stopScreencast').catch(() => {});
    await this.session?.detach().catch(() => {});
    return { frames: [...this.frames], end };
  }

  private async send(method: 'Page.startScreencast') {
    await this.session!.send(method, {
      format: 'jpeg', quality: QUALITY, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
    });
  }
}

export function buildConcatList(frames: Frame[], end: number): string {
  if (!frames.length) throw new Error('screencast captured no frames');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const from = i === 0 ? 0 : f.t;
    const to = i + 1 < frames.length ? frames[i + 1].t : end;
    lines.push(`file '${f.file}'`, `duration ${Math.max(to - from, 0.001).toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  return lines.join('\n') + '\n';
}

export async function encodeFrames(dir: string, frames: Frame[], end: number, outPath: string): Promise<void> {
  writeFileSync(join(dir, 'frames.ffconcat'), buildConcatList(frames, end));
  await runTool('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat',
    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', outPath,
  ], dir);
}
