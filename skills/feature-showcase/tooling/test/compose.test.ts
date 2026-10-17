import { describe, expect, it } from 'vitest';
import { buildComposeArgs } from '../src/compose';
import { computePlacements } from '../src/timeline';

const placements = [
  { id: 'a', videoAt: 0.4, audioStart: 0, audioEnd: 2 },
  { id: 'b', videoAt: 2.4, audioStart: 2.2, audioEnd: 5.2 },
  { id: 'c', videoAt: 7, audioStart: 5.4, audioEnd: 7.4 },
];
const base = { videoPath: '/w/raw.mp4', audioPath: '/w/narration.mp3', placements, trimStart: 1.25, duration: 10, outPath: '/o/showcase.mp4' };

describe('buildComposeArgs', () => {
  it('trims the video input, delays each narration segment and mixes them', () => {
    const args = buildComposeArgs(base);
    expect(args.slice(0, 5)).toEqual(['-y', '-ss', '1.25', '-i', '/w/raw.mp4']);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[1:a]atrim=start=2.2:end=5.2,asetpts=PTS-STARTPTS,adelay=2400:all=1[a1]');
    expect(fc).toContain('[a0][a1][a2]amix=inputs=3:normalize=0:duration=longest[aout]');
    expect(fc).not.toContain('subtitles');
    expect(args).toContain('0:v');
    expect(args.slice(-3)).toEqual(['-t', '10', '/o/showcase.mp4']);
  });

  it('burns captions when asked', () => {
    const args = buildComposeArgs({ ...base, burnCaptions: 'captions.srt' });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[0:v]subtitles=filename=captions.srt');
    expect(args[args.indexOf('-map') + 1]).toBe('[vout]');
  });

  it('a scene that started late on slow staging still gets its narration at its real start', () => {
    const audio = [
      { start: 0, end: 2, cues: [] },
      { start: 2.2, end: 5.2, cues: [] },
    ];
    // Scene a overran: b started at 9.0s instead of ~3.0s.
    const late = computePlacements([{ id: 'a', videoStart: 0.5, videoEnd: 9 }, { id: 'b', videoStart: 9, videoEnd: 13 }], audio, 0.5);
    const fc = buildComposeArgs({ ...base, placements: late, trimStart: 0.5 }).join(' ');
    expect(fc).toContain('adelay=8900:all=1[a1]');
  });
});
