import type { SceneAudio } from './tts';

export const LEAD_S = 0.4;
export const GAP_S = 0.6;

export interface SceneTiming {
  id: string;
  videoStart: number;
  videoEnd: number;
}

// Where scene i's narration (audioStart..audioEnd of narration.mp3) plays in the final video.
export interface Placement {
  videoAt: number;
  audioStart: number;
  audioEnd: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function sceneHold(a: SceneAudio): number {
  return LEAD_S + (a.end - a.start) + GAP_S;
}

// timings and audio are both in storyboard scene order.
export function computePlacements(timings: SceneTiming[], audio: SceneAudio[], trimStart: number): Placement[] {
  return timings.map((t, i) => ({ videoAt: r3(t.videoStart - trimStart + LEAD_S), audioStart: audio[i].start, audioEnd: audio[i].end }));
}

export function finalDuration(timings: SceneTiming[], trimStart: number): number {
  return r3(timings[timings.length - 1].videoEnd - trimStart);
}
