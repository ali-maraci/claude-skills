import type { Storyboard } from './storyboard';
import type { Alignment, SceneAudio } from './tts';
import type { Placement } from './timeline';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export const MAX_CUE_CHARS = 84;
export const MAX_LINE_CHARS = 42;

export function chunkText(text: string, max = MAX_CUE_CHARS): { start: number; end: number }[] {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index!, e: m.index! + m[0].length }));
  const chunks: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const w of words) {
    if (cur && (w.e - cur.start > max || /[.!?]$/.test(text.slice(cur.start, cur.end)))) {
      chunks.push(cur);
      cur = null;
    }
    cur = cur ? { start: cur.start, end: w.e } : { start: w.s, end: w.e };
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function wrapLines(text: string, max = MAX_LINE_CHARS): string {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// Cues for the scene narration at text[range], timed from that scene's audio start.
export function sceneCues(text: string, range: { start: number; end: number }, alignment: Alignment, audioStart: number): Cue[] {
  const sceneText = text.slice(range.start, range.end);
  return chunkText(sceneText).map((c) => ({
    start: alignment.character_start_times_seconds[range.start + c.start] - audioStart,
    end: alignment.character_end_times_seconds[range.start + c.end - 1] - audioStart,
    text: wrapLines(sceneText.slice(c.start, c.end)),
  }));
}

// scenes and placements are both in storyboard scene order.
export function buildCues(scenes: SceneAudio[], placements: Placement[]): Cue[] {
  return scenes.flatMap((s, i) =>
    s.cues.map((c) => ({ ...c, start: r3(placements[i].videoAt + c.start), end: r3(placements[i].videoAt + c.end) })),
  );
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const titleCase = (id: string) => id.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function toMarkdown(sb: Storyboard, placements: Placement[], duration: number): string {
  const lines = [`# ${sb.title} — ${sb.ticket}`, '', `Duration: ${mmss(duration)}`, ''];
  for (const [i, s] of sb.scenes.entries()) {
    const label = s.kind === 'card' && s.card.heading ? s.card.heading : titleCase(s.id);
    lines.push(`## [${mmss(placements[i].videoAt)}] ${label}`, '', s.narration, '');
  }
  return lines.join('\n');
}
