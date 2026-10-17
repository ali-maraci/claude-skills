import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { KEY_RE } from './paths';

export const SURFACES = ['app-web', 'portal'] as const;
export const SurfaceSchema = z.enum(SURFACES);
export type Surface = z.infer<typeof SurfaceSchema>;

export const MAX_WORDS = 300;
export const SCENE_SEPARATOR = '\n\n';

const TargetSchema = z.union([
  z.object({ role: z.string().min(1), name: z.string().min(1) }).strict(),
  z.object({ label: z.string().min(1) }).strict(),
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ testId: z.string().min(1) }).strict(),
]);
export type Target = z.infer<typeof TargetSchema>;

const ActionSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), path: z.string().startsWith('/'), surface: SurfaceSchema.optional() }).strict(),
  z.object({ do: z.literal('click'), target: TargetSchema }).strict(),
  z.object({ do: z.literal('hover'), target: TargetSchema }).strict(),
  z.object({ do: z.literal('fill'), target: TargetSchema, value: z.string() }).strict(),
  z.object({ do: z.literal('scroll'), y: z.number().int() }).strict(),
  z.object({ do: z.literal('waitFor'), target: TargetSchema }).strict(),
  z.object({ do: z.literal('pause'), ms: z.number().int().positive().max(10_000) }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;

const CardSchema = z
  .object({
    heading: z.string().min(1).optional(),
    sub: z.string().min(1).optional(),
    bullets: z.array(z.string().min(1)).max(5).optional(),
  })
  .strict()
  .refine((c) => c.heading || c.bullets?.length, 'card needs a heading or bullets');
export type Card = z.infer<typeof CardSchema>;

const sceneId = z.string().regex(/^[a-z0-9-]+$/, 'scene id must be lowercase kebab-case');
const narration = z.string().trim().min(1);

const SceneSchema = z.discriminatedUnion('kind', [
  z.object({ id: sceneId, kind: z.literal('card'), card: CardSchema, narration }).strict(),
  z
    .object({ id: sceneId, kind: z.literal('ui'), surface: SurfaceSchema, actions: z.array(ActionSchema).min(1), narration })
    .strict(),
]);

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const StoryboardSchema = z
  .object({
    ticket: z.string().regex(KEY_RE),
    title: z.string().min(1),
    setup: z
      .array(z.object({ surface: SurfaceSchema, actions: z.array(ActionSchema).min(1) }).strict())
      .default([]),
    scenes: z.array(SceneSchema).min(2),
  })
  .strict()
  .superRefine((sb, ctx) => {
    const last = sb.scenes.length - 1;
    if (sb.scenes[0].kind !== 'card')
      ctx.addIssue({ code: 'custom', path: ['scenes', 0], message: 'first scene must be a title card' });
    if (sb.scenes[last].kind !== 'card')
      ctx.addIssue({ code: 'custom', path: ['scenes', last], message: 'last scene must be a recap card' });
    // A card replaces the page with its own HTML, so the next UI scene has nothing to act on
    // until it navigates back to staging.
    sb.scenes.forEach((s, i) => {
      if (s.kind === 'ui' && sb.scenes[i - 1]?.kind === 'card' && s.actions[0].do !== 'goto')
        ctx.addIssue({ code: 'custom', path: ['scenes', i, 'actions', 0], message: 'a UI scene after a card must open with goto' });
    });
    const seen = new Set<string>();
    sb.scenes.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'id'], message: `duplicate scene id "${s.id}"` });
      seen.add(s.id);
    });
    const words = sb.scenes.reduce((n, s) => n + countWords(s.narration), 0);
    if (words > MAX_WORDS)
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: `narration is ${words} words; max ${MAX_WORDS} (~2 min)` });
  });

export type Storyboard = z.infer<typeof StoryboardSchema>;
export type Scene = Storyboard['scenes'][number];

export class StoryboardError extends Error {}

export function parseStoryboard(json: unknown): Storyboard {
  const r = StoryboardSchema.safeParse(json);
  if (!r.success) {
    throw new StoryboardError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  return r.data;
}

export function loadStoryboard(path: string): Storyboard {
  return parseStoryboard(JSON.parse(readFileSync(path, 'utf8')));
}

export function surfacesUsed(sb: Storyboard): Surface[] {
  const out = new Set<Surface>();
  const scan = (actions: Action[]) => actions.forEach((a) => a.do === 'goto' && a.surface && out.add(a.surface));
  sb.setup.forEach((s) => (out.add(s.surface), scan(s.actions)));
  sb.scenes.forEach((s) => s.kind === 'ui' && (out.add(s.surface), scan(s.actions)));
  return [...out];
}

export interface Script {
  text: string;
  ranges: { start: number; end: number }[]; // one per scene, in scene order
}

export function narrationScript(sb: Storyboard): Script {
  let text = '';
  const ranges: Script['ranges'] = [];
  sb.scenes.forEach((s, i) => {
    if (i > 0) text += SCENE_SEPARATOR;
    const start = text.length;
    text += s.narration;
    ranges.push({ start, end: text.length });
  });
  return { text, ranges };
}
