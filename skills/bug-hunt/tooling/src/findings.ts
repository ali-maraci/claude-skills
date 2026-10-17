import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { redactText } from './redact';

export const FindingSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(['blocker', 'major', 'minor', 'cosmetic', 'info']),
  kind: z.enum(['functional', 'error', 'ux', 'a11y', 'copy', 'performance', 'gap']),
  route: z.string().optional(),
  steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  evidence: z.array(z.string()),
});
export const VerifierResultSchema = z.object({
  scenario: z.string(), mode: z.enum(['happy', 'fuzz']), goal_reached: z.boolean(),
  findings: z.array(FindingSchema), notes: z.string().default(''),
});
export type Finding = z.infer<typeof FindingSchema>;
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
export type ScenarioOutcome = VerifierResult & { status: 'ok' | 'incomplete' | 'setup-failed'; cause?: string; dropped: string[] };

const Envelope = z.object({
  scenario: z.string(), mode: z.enum(['happy', 'fuzz']), goal_reached: z.boolean(),
  findings: z.array(z.unknown()), notes: z.string().default(''),
});
type Env = z.infer<typeof Envelope>;

// End index of the balanced object starting at `start`, honouring JSON strings; -1 if unbalanced.
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const MAX_CANDIDATES = 100;
// First balanced {...} that parses AND has the result envelope shape. Returns the reason on failure.
function findEnvelope(text: string): { env: Env } | { reason: string } {
  let sawObject = false;
  let tried = 0;
  for (let i = text.indexOf('{'); i >= 0 && tried < MAX_CANDIDATES; i = text.indexOf('{', i + 1)) {
    // JSON objects open with `{` then `"` or `}`; anything else is prose.
    if (!/^\{\s*["}]/.test(text.slice(i, i + 40))) continue;
    tried++;
    const end = matchingBrace(text, i);
    if (end < 0) continue;
    let v: unknown;
    try { v = JSON.parse(text.slice(i, end + 1)); } catch { continue; }
    sawObject = true;
    const e = Envelope.safeParse(v);
    if (e.success) return { env: e.data };
  }
  return { reason: sawObject ? 'no object matched the result shape' : 'no JSON object found' };
}

function extract(raw: string): { env: Env } | { reason: string } {
  const fenced = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  for (const m of fenced) {
    const r = findEnvelope(m[1]);
    if ('env' in r) return r;
  }
  return findEnvelope(raw);
}

const isPng = (e: string) => e.toLowerCase().endsWith('.png');
const hasText = (e: string) => /^(console|network):\s*\S/i.test(e);

// Verifier output is free text: neutralise anything the end-of-run scan would flag (R17).
const redact = (s: string) => redactText(s);
const redactFinding = (f: Finding): Finding => ({
  ...f,
  title: redact(f.title),
  route: f.route === undefined ? undefined : redact(f.route),
  steps: f.steps.map(redact),
  expected: redact(f.expected),
  actual: redact(f.actual),
  evidence: f.evidence.map(redact),
});
export function redactOutcome(o: ScenarioOutcome): ScenarioOutcome {
  return {
    ...o,
    findings: o.findings.map(redactFinding),
    notes: redact(o.notes),
    dropped: o.dropped.map(redact),
    ...(o.cause === undefined ? {} : { cause: redact(o.cause) }),
  };
}

export function parseVerifierOutput(raw: string, screensDir: string, scenario: string, mode: string): ScenarioOutcome {
  const m = mode as 'happy' | 'fuzz';
  const got = extract(raw);
  if ('reason' in got) {
    return { scenario, mode: m, goal_reached: false, findings: [], notes: `verifier returned no valid result: ${got.reason}`, status: 'incomplete', dropped: [] };
  }
  const dropped: string[] = [];
  const findings: Finding[] = [];
  got.env.findings.forEach((raw, i) => {
    const p = FindingSchema.safeParse(raw);
    if (!p.success) {
      const issue = p.error.issues[0];
      dropped.push(`invalid finding #${i}: ${issue.path.join('.') || '(root)'} (${issue.code})`);
      return;
    }
    const f = p.data;
    // a screenshot is cited only if it exists on disk
    const onDisk = (e: string) => existsSync(join(screensDir, basename(e)));
    const evidence = f.evidence.filter((e) => {
      if (!isPng(e) || onDisk(e)) return true;
      dropped.push(`${f.title} — dropped missing screenshot ${basename(e)}`);
      return false;
    });
    if (!evidence.some((e) => hasText(e) || (isPng(e) && onDisk(e)))) {
      dropped.push(`${f.title} — no evidence on disk`);
      return;
    }
    findings.push({ ...f, evidence });
  });
  // scenario and mode come from the caller, not the verifier's own claim
  return redactOutcome({ scenario, mode: m, goal_reached: got.env.goal_reached, findings, notes: got.env.notes, status: 'ok', dropped });
}

export function setupFailed(scenario: string, mode: string, cause: string): ScenarioOutcome {
  return redactOutcome({ scenario, mode: mode as 'happy' | 'fuzz', goal_reached: false, findings: [], notes: '', status: 'setup-failed', cause, dropped: [] });
}
