import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import type { Script } from './storyboard';
import { sceneCues, type Cue } from './captions';

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

// One per storyboard scene, in scene order. Times are seconds into narration.mp3; cues are
// relative to the scene's own start.
export interface SceneAudio {
  start: number;
  end: number;
  cues: Cue[];
}

export interface TtsDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface TtsResult {
  scenes: SceneAudio[];
  audioPath: string;
  cached: boolean;
  characters: number;
}

type TtsConfig = Config['elevenlabs'];
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export function segmentScenes(script: Script, alignment: Alignment): SceneAudio[] {
  const { characters, character_start_times_seconds: st, character_end_times_seconds: et } = alignment;
  if (characters.length !== script.text.length || characters.join('') !== script.text) {
    throw new Error(
      `ElevenLabs alignment (${characters.length} chars) does not match the script (${script.text.length} chars) — ` +
        'rewrite numbers/symbols in the narration as words and retry',
    );
  }
  return script.ranges.map((r) => {
    let a = r.start;
    while (a < r.end - 1 && /\s/.test(script.text[a])) a++;
    let b = r.end - 1;
    while (b > a && /\s/.test(script.text[b])) b--;
    return { start: st[a], end: et[b], cues: sceneCues(script.text, r, alignment, st[a]) };
  });
}

export async function synthesize(cfg: TtsConfig, text: string, deps: TtsDeps = {}) {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${cfg.baseUrl}/v1/text-to-speech/${cfg.voiceId}/with-timestamps?output_format=mp3_44100_128`;
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.modelId }),
    });
    if (res.ok) {
      const body = (await res.json()) as { audio_base64: string; alignment: Alignment };
      return { audio: Buffer.from(body.audio_base64, 'base64'), alignment: body.alignment };
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`ElevenLabs rejected the API key (HTTP ${res.status}) — check ~/.config/feature-showcase/.env`);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`ElevenLabs TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

export function ttsCacheKey(cfg: TtsConfig, text: string): string {
  return createHash('sha256').update([cfg.voiceId, cfg.modelId, text].join('\u0000')).digest('hex');
}

export async function runTts(cfg: TtsConfig, script: Script, workDir: string, deps: TtsDeps = {}): Promise<TtsResult> {
  mkdirSync(workDir, { recursive: true });
  const audioPath = join(workDir, 'narration.mp3');
  const metaPath = join(workDir, 'alignment.json');
  const key = ttsCacheKey(cfg, script.text);
  if (existsSync(audioPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { key: string; alignment: Alignment };
    if (meta.key === key) {
      return { scenes: segmentScenes(script, meta.alignment), audioPath, cached: true, characters: 0 };
    }
  }
  const { audio, alignment } = await synthesize(cfg, script.text, deps);
  // Persist BEFORE segmenting: a mismatch must not cost a second API call on re-run.
  writeFileSync(audioPath, audio);
  writeFileSync(metaPath, JSON.stringify({ key, alignment }, null, 2));
  const scenes = segmentScenes(script, alignment);
  return { scenes, audioPath, cached: false, characters: script.text.length };
}
