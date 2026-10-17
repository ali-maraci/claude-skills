import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from './config';
import { assertKey, showcasePaths } from './paths';
import { loadStoryboard, narrationScript, SURFACES, SurfaceSchema, type Storyboard, type Surface } from './storyboard';
import { runTts } from './tts';
import { computePlacements, finalDuration } from './timeline';
import { buildCues, toMarkdown, toSrt } from './captions';
import { buildComposeArgs, probeMedia } from './compose';
import { runTool } from './exec';
import { dryRun, record } from './runner';
import { runAuth } from './auth';
import { runProbe } from './probe';
import { runPreflight } from './preflight';

const HELP = `feature-showcase <command>
  auth <app-web|portal>                         sign in once as the showcase persona; saves the session
  preflight <KEY> [--merge owner/repo@sha]... [--surface app-web|portal]...
  probe <KEY> <surface> <path>                  aria snapshot + screenshot of a staging route
  validate <KEY>                                check <out>/<KEY>/storyboard.json
  dry-run <KEY>                                 run every action on staging, no recording
  produce <KEY> [--captions] [--once]           dry run → narration → record → captions → mp4
                                                --once skips the dry run, for a flow that can only run once
                                                (e.g. a sign-up that books a call); a failure uses up the persona`;

export function parseMerge(s: string): { repo: string; sha: string } {
  const i = s.lastIndexOf('@');
  if (i < 1 || !s.slice(0, i).includes('/')) throw new Error(`--merge expects owner/repo@sha, got "${s}"`);
  return { repo: s.slice(0, i), sha: s.slice(i + 1) };
}

export function assertTicketMatches(sb: Storyboard, key: string): void {
  if (sb.ticket !== key) throw new Error(`storyboard is for ${sb.ticket}, not ${key}`);
}

function asSurface(s: string | undefined): Surface {
  const r = SurfaceSchema.safeParse(s);
  if (!r.success) throw new Error(`surface must be one of ${SURFACES.join(', ')}`);
  return r.data;
}

function storyboardFor(cfg: Config, key: string) {
  const p = showcasePaths(cfg, key);
  if (!existsSync(p.storyboard)) throw new Error(`no storyboard at ${p.storyboard}`);
  const sb = loadStoryboard(p.storyboard);
  assertTicketMatches(sb, key);
  return { p, sb };
}

async function produce(cfg: Config, key: string, { captions, once }: { captions: boolean; once: boolean }) {
  const { p, sb } = storyboardFor(cfg, key);
  mkdirSync(p.work, { recursive: true });
  if (once) {
    console.log('1/5 dry run skipped (--once)');
  } else {
    console.log('1/5 dry run…');
    await dryRun(cfg, sb, p.work);
  }
  console.log('2/5 narration…');
  const script = narrationScript(sb);
  const tts = await runTts(cfg.elevenlabs, script, p.work);
  console.log('3/5 recording…');
  const rec = await record(cfg, sb, p.work, tts.scenes);
  const trimStart = rec.timings[0].videoStart;
  const placements = computePlacements(rec.timings, tts.scenes, trimStart);
  const duration = finalDuration(rec.timings, trimStart);
  writeFileSync(join(p.work, 'scene-timings.json'), JSON.stringify(rec.timings, null, 2));
  console.log('4/5 captions…');
  writeFileSync(p.srt, toSrt(buildCues(tts.scenes, placements)));
  writeFileSync(p.transcript, toMarkdown(sb, placements, duration));
  console.log('5/5 compose…');
  if (captions) copyFileSync(p.srt, join(p.work, 'captions.srt'));
  await runTool('ffmpeg', buildComposeArgs({
    videoPath: rec.rawVideoPath, audioPath: tts.audioPath, placements, trimStart, duration, outPath: p.mp4,
    burnCaptions: captions ? 'captions.srt' : undefined,
  }), p.work);
  const m = await probeMedia(p.mp4);
  if (!m.video || !m.audio || Math.abs(m.duration - duration) > 1) {
    throw new Error(`output check failed: video=${m.video} audio=${m.audio} duration=${m.duration}s (expected ≈${duration}s)`);
  }
  console.log(`✓ ${p.mp4}\n  ${p.transcript}\n  duration ${duration.toFixed(1)}s · ElevenLabs characters ${tts.cached ? '0 (cached)' : tts.characters}`);
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { merge: { type: 'string', multiple: true }, surface: { type: 'string', multiple: true }, captions: { type: 'boolean' }, once: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  const [cmd, a1, a2, a3] = positionals;
  if (!cmd || values.help) return void console.log(HELP);
  const cfg = loadConfig();
  switch (cmd) {
    case 'auth':
      await runAuth(cfg, asSurface(a1));
      return;
    case 'preflight': {
      assertKey(a1);
      const results = await runPreflight(cfg, { merges: (values.merge ?? []).map(parseMerge), surfaces: (values.surface ?? []).map(asSurface) });
      for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
      if (results.some((r) => !r.ok)) throw new Error('preflight failed');
      return;
    }
    case 'probe': {
      const p = showcasePaths(cfg, a1);
      const r = await runProbe(cfg, asSurface(a2), a3 ?? '/', p.probes);
      console.log(r.snapshot);
      console.log(`\n(saved ${r.snapshotPath})`);
      return;
    }
    case 'validate': {
      const { sb } = storyboardFor(cfg, a1);
      console.log(`✓ storyboard ok — ${sb.scenes.length} scenes`);
      return;
    }
    case 'dry-run': {
      const { p, sb } = storyboardFor(cfg, a1);
      await dryRun(cfg, sb, p.work);
      console.log('✓ dry run passed');
      return;
    }
    case 'produce':
      await produce(cfg, a1, { captions: values.captions ?? false, once: values.once ?? false });
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n${HELP}`);
  }
}
