import { describe, expect, it } from 'vitest';
import { buildConcatList } from '../src/browser/screencast';

describe('buildConcatList', () => {
  it('gives each frame the time until the next one; first frame starts at 0; last repeats', () => {
    expect(buildConcatList([{ file: '000000.jpg', t: 0.2 }, { file: '000001.jpg', t: 1.0 }], 3.0)).toBe(
      "ffconcat version 1.0\nfile '000000.jpg'\nduration 1.000\nfile '000001.jpg'\nduration 2.000\nfile '000001.jpg'\n",
    );
  });

  it('refuses an empty capture', () => {
    expect(() => buildConcatList([], 1)).toThrow(/no frames/);
  });
});
