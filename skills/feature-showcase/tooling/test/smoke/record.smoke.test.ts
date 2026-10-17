import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { dryRun, record } from '../../src/runner';
import { parseStoryboard } from '../../src/storyboard';
import { sceneHold, computePlacements, finalDuration } from '../../src/timeline';
import { buildComposeArgs, probeMedia } from '../../src/compose';
import { runTool } from '../../src/exec';
import type { Config } from '../../src/config';
import { sampleStoryboard } from '../fixtures/storyboard';

let server: Server;
let base = '';
const root = mkdtempSync(join(tmpdir(), 'fs-smoke-'));
const work = join(root, 'work');

beforeAll(async () => {
  const html = readFileSync(new URL('../fixtures/demo.html', import.meta.url));
  const overlay = readFileSync(new URL('../fixtures/overlay.html', import.meta.url));
  server = createServer((req, res) => {
    const send = (body: Buffer) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    if (req.url === '/overlay') return send(overlay);
    if (req.url === '/slow') return void setTimeout(() => send(html), 2000);
    send(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function cfg(): Config {
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  for (const s of ['app-web', 'portal']) writeFileSync(join(stateDir, `${s}.json`), JSON.stringify({ cookies: [], origins: [] }));
  return {
    elevenlabs: { apiKey: 'sk_unused', baseUrl: 'https://api.elevenlabs.io', voiceId: 'v', modelId: 'm' },
    surfaces: { 'app-web': { baseUrl: base, signedInPath: '/' }, portal: { baseUrl: base, signedInPath: '/' } },
    outputDir: root,
    stateDir,
  };
}

// Fake narration: 6 s of silence split across the three scenes.
const sceneAudio = [
  { start: 0, end: 1.5, cues: [] },
  { start: 1.7, end: 4.2, cues: [] },
  { start: 4.4, end: 5.8, cues: [] },
];

describe('runner (smoke: Chromium + ffmpeg)', () => {
  it('dry-runs every action without recording', async () => {
    const timings = await dryRun(cfg(), parseStoryboard(sampleStoryboard()), work);
    expect(timings.map((t) => t.id)).toEqual(['title', 'open-details', 'recap']);
    expect(existsSync(join(work, 'raw.mp4'))).toBe(false);
  });

  it('records, holds each scene for its narration, and composes a playable mp4', async () => {
    // A stale frame from a "previous run" must not leak into this recording.
    mkdirSync(join(work, 'frames'), { recursive: true });
    writeFileSync(join(work, 'frames', '999999.jpg'), 'stale');

    const sb = parseStoryboard(sampleStoryboard());
    const r = await record(cfg(), sb, work, sceneAudio);
    expect(existsSync(r.rawVideoPath)).toBe(true);
    expect(existsSync(join(work, 'frames', '999999.jpg'))).toBe(false);
    for (const [i, t] of r.timings.entries()) {
      expect(t.videoEnd - t.videoStart).toBeGreaterThanOrEqual(sceneHold(sceneAudio[i]) - 0.05);
    }

    const audioPath = join(work, 'narration.mp3');
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-c:a', 'libmp3lame', audioPath]);
    const trimStart = r.timings[0].videoStart;
    const placements = computePlacements(r.timings, sceneAudio, trimStart);
    const duration = finalDuration(r.timings, trimStart);
    const out = join(root, 'showcase.mp4');
    await runTool('ffmpeg', buildComposeArgs({ videoPath: r.rawVideoPath, audioPath, placements, trimStart, duration, outPath: out }), work);

    const m = await probeMedia(out);
    expect(m.video && m.audio).toBe(true);
    expect(Math.abs(m.duration - duration)).toBeLessThan(1);
  });

  it('fails a broken step with the scene name and a screenshot', async () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions = [{ do: 'goto', path: '/' }, { do: 'click', target: { role: 'button', name: 'Nope' } }];
    const sb = parseStoryboard(raw);
    await expect(dryRun(cfg(), sb, work)).rejects.toThrow(/scene "open-details" step 2 \(click\) failed/);
    expect(existsSync(join(work, 'failure-open-details-2.png'))).toBe(true);
  });

  it('clicks only once the target can receive the click (an overlay is covering it at first)', async () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions = [
      { do: 'goto', path: '/overlay' },
      { do: 'click', target: { role: 'button', name: 'Show details' } },
      { do: 'waitFor', target: { text: 'Details panel' } },
    ];
    await dryRun(cfg(), parseStoryboard(raw), work);
  });

  it("loads a UI scene's opening page before its narration clock starts", async () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions[0] = { do: 'goto', path: '/slow' };
    const timings = await dryRun(cfg(), parseStoryboard(raw), work);
    // The 2 s load sits between the title card's end and the scene's start, not inside the scene.
    expect(timings[1].videoStart - timings[0].videoEnd).toBeGreaterThanOrEqual(1.5);
  });
});
