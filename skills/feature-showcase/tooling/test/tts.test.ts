import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTts, segmentScenes, synthesize, type Alignment } from '../src/tts';
import { narrationScript, parseStoryboard } from '../src/storyboard';
import { sampleStoryboard } from './fixtures/storyboard';

const cfg = { apiKey: 'sk_SECRETKEY', baseUrl: 'https://api.elevenlabs.io', voiceId: 'voice1', modelId: 'm1' };
const script = narrationScript(parseStoryboard(sampleStoryboard()));

// 50 ms per character.
function fakeAlignment(text: string): Alignment {
  const characters = text.split('');
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => i * 0.05 + 0.05),
  };
}
const okBody = (text: string) =>
  new Response(JSON.stringify({ audio_base64: Buffer.from('MP3').toString('base64'), alignment: fakeAlignment(text) }), { status: 200 });

describe('segmentScenes', () => {
  it('maps each scene range to start/end seconds of its first/last character', () => {
    const scenes = segmentScenes(script, fakeAlignment(script.text));
    expect(scenes).toHaveLength(3);
    const r1 = script.ranges[1];
    expect(scenes[1].start).toBeCloseTo(r1.start * 0.05);
    expect(scenes[1].end).toBeCloseTo((r1.end - 1) * 0.05 + 0.05);
    // Cues are timed from the scene's own audio start, so its first cue starts at 0.
    expect(scenes[1].cues[0].start).toBeCloseTo(0);
    expect(scenes[1].cues[0].text.replace('\n', ' ')).toMatch(/^Tap Show details/);
  });

  it('refuses an alignment that does not echo the script verbatim', () => {
    expect(() => segmentScenes(script, fakeAlignment(script.text.replace('details panel', 'detials panel')))).toThrow(/does not match the script/);
  });
});

describe('synthesize', () => {
  it('posts to the with-timestamps endpoint with the key header', async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push([url, init]), okBody('hi'))) as unknown as typeof fetch;
    const r = await synthesize(cfg, 'hi', { fetchImpl });
    expect(calls[0][0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice1/with-timestamps?output_format=mp3_44100_128');
    expect((calls[0][1].headers as Record<string, string>)['xi-api-key']).toBe('sk_SECRETKEY');
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ text: 'hi', model_id: 'm1' });
    expect(r.audio.toString()).toBe('MP3');
  });

  it('retries 429 with backoff, then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? new Response('slow down', { status: 429 }) : okBody('hi'))) as unknown as typeof fetch;
    await synthesize(cfg, 'hi', { fetchImpl, sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([1000]);
  });

  it('gives up after 3 retries on 5xx', async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response('boom', { status: 503 }))) as unknown as typeof fetch;
    await expect(synthesize(cfg, 'hi', { fetchImpl, sleep: async () => {} })).rejects.toThrow(/HTTP 503/);
    expect(n).toBe(4);
  });

  it('stops on 401 without echoing the key', async () => {
    const fetchImpl = (async () => new Response('{"detail":"invalid_api_key"}', { status: 401 })) as unknown as typeof fetch;
    const err = (await synthesize(cfg, 'hi', { fetchImpl }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/rejected the API key/);
    expect(err.message).not.toContain('SECRETKEY');
  });
});

describe('runTts cache', () => {
  it('calls ElevenLabs once, then reuses narration for an unchanged script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-tts-'));
    let n = 0;
    const fetchImpl = (async () => (n++, okBody(script.text))) as unknown as typeof fetch;
    const first = await runTts(cfg, script, dir, { fetchImpl });
    const second = await runTts(cfg, script, dir, { fetchImpl });
    expect(n).toBe(1);
    expect(first.cached).toBe(false);
    expect(first.characters).toBe(script.text.length);
    expect(second.cached).toBe(true);
    expect(second.scenes).toEqual(first.scenes);
  });

  it('caches a mismatched alignment so a re-run fails without re-spending credit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-tts-'));
    let n = 0;
    const fetchImpl = (async () => (n++, okBody(script.text.toUpperCase()))) as unknown as typeof fetch;
    await expect(runTts(cfg, script, dir, { fetchImpl })).rejects.toThrow(/does not match/);
    await expect(runTts(cfg, script, dir, { fetchImpl })).rejects.toThrow(/does not match/);
    expect(n).toBe(1);
  });
});
