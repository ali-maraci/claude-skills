import { runTool } from './exec';
import type { Placement } from './timeline';

export interface ComposeInput {
  videoPath: string;
  audioPath: string;
  placements: Placement[];
  trimStart: number;
  duration: number;
  outPath: string;
  burnCaptions?: string;
}

export function buildComposeArgs(i: ComposeInput): string[] {
  const parts = i.placements.map(
    (p, n) =>
      `[1:a]atrim=start=${p.audioStart}:end=${p.audioEnd},asetpts=PTS-STARTPTS,adelay=${Math.round(p.videoAt * 1000)}:all=1[a${n}]`,
  );
  const inputs = i.placements.map((_, n) => `[a${n}]`).join('');
  parts.push(`${inputs}amix=inputs=${i.placements.length}:normalize=0:duration=longest[aout]`);
  let videoMap = '0:v';
  if (i.burnCaptions) {
    parts.push(`[0:v]subtitles=filename=${i.burnCaptions}:force_style='FontSize=20,MarginV=40'[vout]`);
    videoMap = '[vout]';
  }
  return [
    '-y', '-ss', String(i.trimStart), '-i', i.videoPath, '-i', i.audioPath,
    '-filter_complex', parts.join(';'),
    '-map', videoMap, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    '-t', String(i.duration), i.outPath,
  ];
}

export async function probeMedia(path: string): Promise<{ video: boolean; audio: boolean; duration: number }> {
  const out = await runTool('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path]);
  const j = JSON.parse(out) as { streams: { codec_type: string }[]; format: { duration: string } };
  return {
    video: j.streams.some((s) => s.codec_type === 'video'),
    audio: j.streams.some((s) => s.codec_type === 'audio'),
    duration: Number(j.format.duration),
  };
}
