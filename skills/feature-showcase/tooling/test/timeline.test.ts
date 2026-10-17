import { describe, expect, it } from 'vitest';
import { computePlacements, finalDuration, sceneHold, LEAD_S } from '../src/timeline';

const audio = [
  { start: 0, end: 2, cues: [] },
  { start: 2.2, end: 5.2, cues: [] },
];

describe('timeline', () => {
  it('holds a scene for lead + narration + gap', () => {
    expect(sceneHold(audio[1])).toBeCloseTo(0.4 + 3 + 0.6);
  });

  it('places narration LEAD_S after each scene actual start, relative to the trim', () => {
    const p = computePlacements(
      [{ id: 'a', videoStart: 1.0, videoEnd: 4.0 }, { id: 'b', videoStart: 4.0, videoEnd: 9.5 }],
      audio,
      1.0,
    );
    expect(p).toEqual([
      { videoAt: LEAD_S, audioStart: 0, audioEnd: 2 },
      { videoAt: 3 + LEAD_S, audioStart: 2.2, audioEnd: 5.2 },
    ]);
  });

  it('final duration runs from the trim to the last scene end', () => {
    expect(finalDuration([{ id: 'a', videoStart: 1, videoEnd: 4 }, { id: 'b', videoStart: 4, videoEnd: 9.5 }], 1)).toBeCloseTo(8.5);
  });
});
