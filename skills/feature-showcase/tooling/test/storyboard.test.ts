import { describe, expect, it } from 'vitest';
import { narrationScript, parseStoryboard, surfacesUsed, SCENE_SEPARATOR } from '../src/storyboard';
import { sampleStoryboard } from './fixtures/storyboard';

describe('parseStoryboard', () => {
  it('accepts the sample and defaults setup to []', () => {
    const sb = parseStoryboard(sampleStoryboard());
    expect(sb.setup).toEqual([]);
    expect(sb.scenes).toHaveLength(3);
  });

  it('requires a title card first and a recap card last', () => {
    const raw = sampleStoryboard();
    raw.scenes = [raw.scenes[1], raw.scenes[1]];
    raw.scenes[1] = { ...raw.scenes[1], id: 'again' };
    expect(() => parseStoryboard(raw)).toThrow(/first scene must be a title card[\s\S]*last scene must be a recap card/);
  });

  it('rejects duplicate scene ids', () => {
    const raw = sampleStoryboard();
    raw.scenes[2] = { ...raw.scenes[2], id: 'title' };
    expect(() => parseStoryboard(raw)).toThrow(/duplicate scene id "title"/);
  });

  it('rejects narration over 300 words', () => {
    const raw = sampleStoryboard();
    raw.scenes[1] = { ...raw.scenes[1], narration: 'word '.repeat(301) };
    expect(() => parseStoryboard(raw)).toThrow(/max 300/);
  });

  it('requires a UI scene after a card to open with goto', () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions.shift();
    expect(() => parseStoryboard(raw)).toThrow(/scenes\.1\.actions\.0: a UI scene after a card must open with goto/);
  });

  it('rejects unknown actions', () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions = [{ do: 'teleport' }];
    expect(() => parseStoryboard(raw)).toThrow(/scenes\.1\.actions\.0/);
  });

  it('rejects a goto path without a leading slash', () => {
    const raw = sampleStoryboard() as any;
    raw.scenes[1].actions[0] = { do: 'goto', path: 'items' };
    expect(() => parseStoryboard(raw)).toThrow(/path/);
  });
});

describe('narrationScript', () => {
  it('joins narration with the separator and records exact ranges', () => {
    const sb = parseStoryboard(sampleStoryboard());
    const s = narrationScript(sb);
    expect(s.text.split(SCENE_SEPARATOR)).toEqual(sb.scenes.map((x) => x.narration));
    for (const [i, r] of s.ranges.entries()) {
      expect(s.text.slice(r.start, r.end)).toBe(sb.scenes[i].narration);
    }
  });
});

describe('surfacesUsed', () => {
  it('collects scene, setup and goto-override surfaces, deduplicated', () => {
    const raw = sampleStoryboard() as any;
    raw.setup = [{ surface: 'portal', actions: [{ do: 'goto', path: '/items' }] }];
    raw.scenes[1].actions.push({ do: 'goto', path: '/x', surface: 'app-web' });
    expect(surfacesUsed(parseStoryboard(raw)).sort()).toEqual(['app-web', 'portal']);
  });
});
