import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Config } from './config';
import { surfacesUsed, type Storyboard } from './storyboard';
import type { SceneAudio } from './tts';
import { sceneHold, type SceneTiming } from './timeline';
import { CURSOR_INIT_SCRIPT } from './browser/cursor';
import { renderCard } from './browser/cards';
import { FAST, perform, type ActionContext, type Pace } from './browser/actions';
import { assertOnSurface, VIEWPORT, withStagingContext } from './browser/session';
import { encodeFrames, ScreencastRecorder } from './browser/screencast';

// Pace plus the scene clock: a dry run's clock is wall time and holds nothing; a recording's
// clock is the screencast's, and each scene is held until its narration has played.
interface Pacing extends Pace {
  now(): number;
  minSceneSeconds(sceneIndex: number): number;
}

function fastPacing(): Pacing {
  const t0 = performance.now();
  return { ...FAST, now: () => (performance.now() - t0) / 1000, minSceneSeconds: () => 0 };
}

// Runs fn; on failure saves failure-<file>.png and rethrows as "<what> failed: …".
async function guard(page: Page, workDir: string, file: string, what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    await page.screenshot({ path: join(workDir, `failure-${file}.png`) }).catch(() => {});
    throw new Error(`${what} failed: ${(e as Error).message}`);
  }
}

async function runSetup(cfg: Config, sb: Storyboard, workDir: string) {
  if (!sb.setup.length) return;
  await withStagingContext(cfg, surfacesUsed(sb), async (ctx) => {
    const page = await ctx.newPage();
    const mouse = { x: 0, y: 0 };
    for (const [i, s] of sb.setup.entries()) {
      const actx: ActionContext = { page, surfaces: cfg.surfaces, defaultSurface: s.surface, mouse, pace: FAST };
      for (const [j, a] of s.actions.entries()) {
        await guard(page, workDir, `setup-${i + 1}-${j + 1}`, `scene "setup-${i + 1}" step ${j + 1} (${a.do})`, async () => {
          await perform(actx, a);
          assertOnSurface(page.url(), cfg.surfaces, s.surface);
        });
      }
    }
  });
}

// Unrecorded setup, then fn on a fresh page with the visible cursor installed.
async function withShownPage<T>(cfg: Config, sb: Storyboard, workDir: string, fn: (page: Page) => Promise<T>): Promise<T> {
  mkdirSync(workDir, { recursive: true });
  await runSetup(cfg, sb, workDir);
  return withStagingContext(cfg, surfacesUsed(sb), async (ctx) => {
    await ctx.addInitScript(CURSOR_INIT_SCRIPT);
    return fn(await ctx.newPage());
  });
}

async function playScenes(cfg: Config, sb: Storyboard, page: Page, workDir: string, pacing: Pacing): Promise<SceneTiming[]> {
  const timings: SceneTiming[] = [];
  const mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  for (const [i, scene] of sb.scenes.entries()) {
    let videoStart: number;
    if (scene.kind === 'card') {
      videoStart = pacing.now();
      await page.setContent(renderCard(scene.card, sb, cfg.brand), { waitUntil: 'load' });
    } else {
      const actx: ActionContext = { page, surfaces: cfg.surfaces, defaultSurface: scene.surface, mouse, pace: pacing };
      const step = (j: number) =>
        guard(page, workDir, `${scene.id}-${j + 1}`, `scene "${scene.id}" step ${j + 1} (${scene.actions[j].do})`, async () => {
          await perform(actx, scene.actions[j]);
          assertOnSurface(page.url(), cfg.surfaces, scene.surface);
        });
      // An opening goto loads BEFORE the scene's clock starts: Chrome keeps painting the previous
      // frame while the page loads, so slow staging adds silence there, not narration over it.
      const first = scene.actions[0].do === 'goto' ? 1 : 0;
      if (first) await step(0);
      videoStart = pacing.now();
      for (let j = first; j < scene.actions.length; j++) await step(j);
    }
    const remaining = pacing.minSceneSeconds(i) - (pacing.now() - videoStart);
    if (remaining > 0) await page.waitForTimeout(remaining * 1000);
    if (scene.kind === 'ui') {
      await guard(page, workDir, `${scene.id}-hold`, `scene "${scene.id}" (during its hold)`, async () =>
        assertOnSurface(page.url(), cfg.surfaces, scene.surface),
      );
    }
    timings.push({ id: scene.id, videoStart, videoEnd: pacing.now() });
  }
  return timings;
}

// Runs every action on staging as fast as possible, recording nothing.
export function dryRun(cfg: Config, sb: Storyboard, workDir: string): Promise<SceneTiming[]> {
  return withShownPage(cfg, sb, workDir, (page) => playScenes(cfg, sb, page, workDir, fastPacing()));
}

// Records the storyboard to <workDir>/raw.mp4, holding scene i for audio[i]'s narration.
export function record(cfg: Config, sb: Storyboard, workDir: string, audio: SceneAudio[]): Promise<{ timings: SceneTiming[]; rawVideoPath: string }> {
  return withShownPage(cfg, sb, workDir, async (page) => {
    const framesDir = join(workDir, 'frames');
    const recorder = new ScreencastRecorder(page, framesDir);
    await recorder.start();
    let timings: SceneTiming[];
    try {
      timings = await playScenes(cfg, sb, page, workDir, {
        humanize: true,
        onNavigate: () => recorder.restart(),
        now: () => recorder.now(),
        minSceneSeconds: (i) => sceneHold(audio[i]),
      });
    } catch (e) {
      // Don't encode a failed run: an ffmpeg error on partial frames would mask the step failure.
      await recorder.stop().catch(() => {});
      throw e;
    }
    const { frames, end } = await recorder.stop();
    const rawVideoPath = join(workDir, 'raw.mp4');
    await encodeFrames(framesDir, frames, end, rawVideoPath); // throws on an empty capture
    rmSync(framesDir, { recursive: true, force: true });
    return { timings, rawVideoPath };
  });
}
