import { describe, expect, it } from 'vitest';
import { buildCues, chunkText, srtTime, toMarkdown, toSrt, wrapLines } from '../src/captions';
import { narrationScript, parseStoryboard } from '../src/storyboard';
import { segmentScenes, type Alignment } from '../src/tts';
import { sampleStoryboard } from './fixtures/storyboard';

const fake = (text: string): Alignment => {
  const c = text.split('');
  return { characters: c, character_start_times_seconds: c.map((_, i) => i * 0.05), character_end_times_seconds: c.map((_, i) => i * 0.05 + 0.05) };
};

describe('chunkText', () => {
  it('breaks at sentence ends and never exceeds the limit (except a single giant word)', () => {
    const text = 'Short one. ' + 'word '.repeat(40).trim() + '. ' + 'x'.repeat(100);
    const chunks = chunkText(text, 84);
    expect(text.slice(chunks[0].start, chunks[0].end)).toBe('Short one.');
    for (const c of chunks.slice(0, -1)) expect(c.end - c.start).toBeLessThanOrEqual(84);
    expect(text.slice(chunks.at(-1)!.start, chunks.at(-1)!.end)).toBe('x'.repeat(100));
  });

  it('never splits inside a word', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho';
    for (const c of chunkText(text, 20)) {
      expect(/^\S/.test(text.slice(c.start, c.end))).toBe(true);
      expect(c.end === text.length || /\s/.test(text[c.end])).toBe(true);
    }
  });
});

describe('wrapLines', () => {
  it('leaves short text alone and splits long text into two lines near the middle', () => {
    expect(wrapLines('short')).toBe('short');
    const two = wrapLines('Tap Show details and the panel opens right in place, with search');
    const [a, b] = two.split('\n');
    expect(b).toBeDefined();
    expect(Math.abs(a.length - b.length)).toBeLessThan(12);
  });
});

describe('srt', () => {
  it('formats timecodes', () => {
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(srtTime(0.0004)).toBe('00:00:00,000');
  });

  it('builds cues at video-timeline times', () => {
    const sb = parseStoryboard(sampleStoryboard());
    const script = narrationScript(sb);
    const scenes = segmentScenes(script, fake(script.text));
    const placements = scenes.map((s, i) => ({ videoAt: 10 * (i + 1), audioStart: s.start, audioEnd: s.end }));
    const cues = buildCues(scenes, placements);
    expect(cues[0].start).toBeCloseTo(10);
    const firstOfScene2 = cues.find((c) => c.text.startsWith('Tap'))!;
    expect(firstOfScene2.start).toBeCloseTo(20);
    const srt = toSrt(cues);
    expect(srt.startsWith('1\n00:00:10,000 --> ')).toBe(true);
  });
});

describe('toMarkdown', () => {
  it('lists scenes with timecodes and narration', () => {
    const sb = parseStoryboard(sampleStoryboard());
    const md = toMarkdown(sb, [
      { videoAt: 0.4, audioStart: 0, audioEnd: 2 },
      { videoAt: 4, audioStart: 2, audioEnd: 6 },
      { videoAt: 75.2, audioStart: 6, audioEnd: 8 },
    ], 80);
    expect(md).toContain('# Details panel — PROJ-123');
    expect(md).toContain('Duration: 1:20');
    expect(md).toContain('## [1:15] Recap');
    expect(md).toContain('Tap Show details and the panel opens');
  });
});
