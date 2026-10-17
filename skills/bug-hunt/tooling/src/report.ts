import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NetEntry } from './collect';
import { redactOutcome, type Finding, type ScenarioOutcome } from './findings';

export const ORDER = ['blocker', 'major', 'minor', 'cosmetic', 'info'] as const;
export type Merged = Finding & { scenarios: string[] };

export function merge(outcomes: ScenarioOutcome[]): Merged[] {
  const byKey = new Map<string, Merged>();
  for (const o of outcomes) for (const f of o.findings) {
    const key = `${f.title.toLowerCase()}|${f.kind}|${f.route ?? ''}`;
    const run = `${o.scenario} (${o.mode})`;
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.scenarios.includes(run)) hit.scenarios.push(run);
      // the worst sighting wins: a blocker in fuzz must not stay `minor` because happy saw it first
      if (ORDER.indexOf(f.severity) < ORDER.indexOf(hit.severity)) hit.severity = f.severity;
      for (const e of f.evidence) if (!hit.evidence.includes(e)) hit.evidence.push(e);
    } else byKey.set(key, { ...f, evidence: [...f.evidence], scenarios: [run] });
  }
  return [...byKey.values()].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}

// verifier text is untrusted: no line breaks (heading forgery) and no raw pipes (table breakage)
const one = (s: string) => s.replace(/[\r\n]+/g, ' ');
const cell = (s: string) => one(s).replace(/\|/g, '\\|');
const evidenceLine = (e: string) => (/\.png$/i.test(e) ? `- ![](screens/${one(e).split(/[\\/]/).pop()})` : `- ${one(e)}`);

const section = (f: Merged) => [
  `### [${f.severity}] ${one(f.title)}`,
  `- Scenarios: ${f.scenarios.map(one).join(', ')}${f.route ? ` · Route: \`${one(f.route)}\`` : ''} · Kind: ${f.kind}`,
  '- Steps:', ...f.steps.map((s, i) => `  ${i + 1}. ${one(s)}`),
  `- Expected: ${one(f.expected)}`, `- Actual: ${one(f.actual)}`,
  ...f.evidence.map(evidenceLine), '',
];

export function renderReport(meta: { run: string; baseUrl: string; started: string }, outcomes: ScenarioOutcome[], network: Record<string, { errors: string[]; failed: NetEntry[] }>, skipped: string[] = []): string {
  const all = merge(outcomes);
  const bugs = all.filter((f) => f.kind !== 'gap');
  const gaps = all.filter((f) => f.kind === 'gap');
  const count = (s: string) => bugs.filter((f) => f.severity === s).length;
  const errors = Object.values(network).reduce((n, x) => n + x.errors.length + x.failed.length, 0);
  return [
    `# Bug hunt — ${meta.run}`, '',
    `Target: ${meta.baseUrl} · Started: ${meta.started} · Scenario runs: ${outcomes.length}`, '',
    '| Severity | Count |', '|---|---|', ...ORDER.map((s) => `| ${s} | ${count(s)} |`), `| errors | ${errors} |`, '',
    '## Bugs', '', ...(bugs.length ? bugs.flatMap(section) : ['None found.', '']),
    '## Gaps (missing features, not bugs)', '', ...(gaps.length ? gaps.flatMap(section) : ['None.', '']),
    '## Console and network errors', '',
    ...Object.entries(network).flatMap(([k, n]) => (n.errors.length || n.failed.length
      ? [`- **${k}**`, ...n.errors.map((e) => `  - ${one(e)}`), ...n.failed.map((r) => `  - ${one(r.method)} ${one(r.url)} → ${r.status}`)]
      : [])), '',
    '## Scenario status', '', '| Scenario | Mode | Status | Goal reached | Note |', '|---|---|---|---|---|',
    ...outcomes.map((o) => `| ${cell(o.scenario)} | ${o.mode} | ${o.status} | ${o.goal_reached ? 'yes' : 'no'} | ${cell(o.cause ?? '')} |`), '',
    ...(skipped.length ? ['## Unreadable files', '', ...skipped.map((s) => `- ${one(s)}`), ''] : []),
    '## Coverage notes', '', ...outcomes.filter((o) => o.notes || o.dropped.length).map((o) =>
      `- ${one(o.scenario)} (${o.mode}): ${one(o.notes)}${o.dropped.length ? ` · dropped: ${o.dropped.map(one).join('; ')}` : ''}`), '',
  ].join('\n');
}

type Net = { errors: string[]; failed: NetEntry[] };
function readJsonDir<T>(dir: string, ok: (v: unknown) => v is T, skipped: string[]): [string, T][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f): [string, T][] => {
    try {
      const v: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (ok(v)) return [[f.replace(/\.json$/, ''), v]];
    } catch { /* fall through */ }
    skipped.push(`${f} could not be read and was skipped`);
    return [];
  });
}
const isOutcome = (v: unknown): v is ScenarioOutcome =>
  !!v && typeof v === 'object' && Array.isArray((v as ScenarioOutcome).findings) && Array.isArray((v as ScenarioOutcome).dropped)
  && typeof (v as ScenarioOutcome).scenario === 'string' && typeof (v as ScenarioOutcome).status === 'string';
const isNet = (v: unknown): v is Net =>
  !!v && typeof v === 'object' && Array.isArray((v as Net).errors) && Array.isArray((v as Net).failed);

export type RunData = { outcomes: ScenarioOutcome[]; network: Record<string, Net>; skipped: string[] };

// Reads findings/*.json and network/*.json (keyed <scenario>-<mode>); unreadable files are noted, never fatal.
// Findings may have been hand-edited by the orchestrator (drop/downgrade notes), so every outcome is
// redacted again and written back before rendering: the JSON, report.md and report.html must all pass scan.
export function loadRun(paths: { findings: string; network: string }): RunData {
  const skipped: string[] = [];
  const outcomes = readJsonDir(paths.findings, isOutcome, skipped).flatMap(([name, o]) => {
    let clean: ScenarioOutcome;
    try { clean = redactOutcome(o); } catch {
      skipped.push(`${name}.json has an unexpected shape and was skipped`);
      return [];
    }
    writeFileSync(join(paths.findings, `${name}.json`), JSON.stringify(clean, null, 2));
    return [clean];
  });
  const network = Object.fromEntries(readJsonDir(paths.network, isNet, skipped));
  return { outcomes, network, skipped };
}
export function loadRunReport(paths: { findings: string; network: string }, meta: { run: string; baseUrl: string; started: string }): string {
  const { outcomes, network, skipped } = loadRun(paths);
  return renderReport(meta, outcomes, network, skipped);
}
