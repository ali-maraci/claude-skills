import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  area: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  persona: z.enum(['finished-member', 'fresh-signup']),
  start: z.string().startsWith('/'),
  modes: z.array(z.enum(['happy', 'fuzz'])).min(1),
  budget: z.object({ max_turns: z.number().int().min(10).max(150) }),
});
export type ScenarioMeta = z.infer<typeof ScenarioSchema>;
export interface Scenario { meta: ScenarioMeta; body: string; path: string }
const SECTIONS = ['## Goal', '## Success criteria', '## Fuzz twists', '## Out of bounds'];
// A heading on its own line, not a mention or a longer/deeper heading.
const hasHeading = (body: string, h: string) => new RegExp(`^${h}[ \\t]*$`, 'm').test(body);

export function parseScenario(path: string, text: string): Scenario {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${basename(path)}: missing front-matter`);
  const r = ScenarioSchema.safeParse(parse(m[1]));
  if (!r.success) throw new Error(`${basename(path)}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  if (`${r.data.id}.md` !== basename(path)) throw new Error(`${basename(path)}: id "${r.data.id}" must match the filename`);
  for (const s of SECTIONS) if (!hasHeading(m[2], s)) throw new Error(`${basename(path)}: missing "${s}" section`);
  return { meta: r.data, body: m[2], path };
}

export function loadScenarios(dir: string): Scenario[] {
  const errors: string[] = [];
  const out: Scenario[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    try { out.push(parseScenario(join(dir, f), readFileSync(join(dir, f), 'utf8'))); }
    catch (e) { errors.push((e as Error).message); }
  }
  if (errors.length) throw new Error(`invalid scenarios:\n  ${errors.join('\n  ')}`);
  return out;
}
