import type { NetEntry } from './collect';
import type { ScenarioOutcome } from './findings';
import { REPORT_CSS } from './html-style';
import { merge, ORDER, type Merged } from './report';

type Net = Record<string, { errors: string[]; failed: NetEntry[] }>;
type Meta = { run: string; baseUrl: string; started: string };

// Verifier and orchestrator text is untrusted: everything that reaches the page goes through esc().
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Screenshots are published next to the page as screens/<name>; only plain basenames are linked.
export const SCREEN_RE = /^[A-Za-z0-9._-]+\.png$/;
export const screenName = (e: string): string | null => {
  if (!/\.png$/i.test(e)) return null;
  const base = e.split(/[\\/]/).pop() ?? '';
  return SCREEN_RE.test(base) ? base : null;
};

/** Screenshot names a report links to, so the caller publishes exactly those files. */
export function referencedScreens(outcomes: ScenarioOutcome[], exists: (name: string) => boolean): string[] {
  const names = new Set<string>();
  for (const o of outcomes) for (const f of o.findings) for (const e of f.evidence) {
    const n = screenName(e);
    if (n && exists(n)) names.add(n);
  }
  return [...names].sort();
}

const card = (f: Merged, exists: (name: string) => boolean) => {
  const shots = f.evidence.map(screenName).filter((n): n is string => !!n && exists(n));
  const other = f.evidence.filter((e) => !screenName(e));
  return `<article class="card ${f.severity}">
  <div class="meta"><span class="sev">${f.severity}</span><span class="tag">${esc(f.kind)}</span>${f.route ? `<span class="tag">${esc(f.route)}</span>` : ''}<span>${f.scenarios.map(esc).join(', ')}</span></div>
  <h3>${esc(f.title)}</h3>
  ${f.steps.length ? `<div><span class="label">Steps</span><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
  <div class="ea"><div><span class="label">Expected</span><p>${esc(f.expected)}</p></div><div><span class="label">Actual</span><p>${esc(f.actual)}</p></div></div>
  ${shots.length ? `<div class="shots">${shots.map((n) => `<a href="screens/${n}" target="_blank" rel="noopener"><img src="screens/${n}" alt="Screenshot for: ${esc(f.title)}" loading="lazy"></a>`).join('')}</div>` : ''}
  ${other.map((e) => `<div class="ev">${esc(e)}</div>`).join('')}
</article>`;
};

function funnel(outcomes: ScenarioOutcome[], kept: number, distinct: number): string {
  const n = (s: ScenarioOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  const dropped = outcomes.reduce((a, o) => a + o.dropped.length, 0);
  // numbers only inside the diagram: no untrusted text reaches mermaid
  return `<pre class="mermaid">
flowchart LR
  A[${outcomes.length} scenario runs] --> B[${n('ok')} completed]
  A --> C[${n('incomplete')} incomplete]
  A --> D[${n('setup-failed')} setup failed]
  B --> E[${kept} findings kept]
  B --> F[${dropped} dropped for evidence]
  E --> G[${distinct} distinct issues]
</pre>`;
}

function statusGrid(outcomes: ScenarioOutcome[]): string {
  const ids = [...new Set(outcomes.map((o) => o.scenario))].sort();
  const dot = (id: string, mode: 'happy' | 'fuzz') => {
    const o = outcomes.find((x) => x.scenario === id && x.mode === mode);
    const label = mode === 'happy' ? 'H' : 'F';
    if (!o) return `<span class="dot none" title="${mode}: not run">–</span>`;
    const goal = o.status === 'ok' ? (o.goal_reached ? 'goal reached' : 'goal not reached') : o.status;
    return `<span class="dot ${o.status}" title="${mode}: ${esc(goal)}">${label}${o.status === 'ok' && !o.goal_reached ? '!' : ''}</span>`;
  };
  return `<div class="grid">${ids.map((id) => `<div class="cell"><span class="id">${esc(id)}</span><span class="modes">${dot(id, 'happy')}${dot(id, 'fuzz')}</span></div>`).join('')}</div>`;
}

export function renderHtml(meta: Meta, outcomes: ScenarioOutcome[], network: Net, skipped: string[] = [], exists: (name: string) => boolean = () => true): string {
  const all = merge(outcomes);
  const bugs = all.filter((f) => f.kind !== 'gap');
  const gaps = all.filter((f) => f.kind === 'gap');
  const count = (s: string) => bugs.filter((f) => f.severity === s).length;
  const kept = outcomes.reduce((a, o) => a + o.findings.length, 0);
  const errLines = Object.entries(network).flatMap(([k, x]) => [
    ...x.errors.map((e) => `<li><code>${esc(k)}</code> ${esc(e)}</li>`),
    ...x.failed.map((r) => `<li><code>${esc(k)}</code> ${esc(r.method)} ${esc(r.url)} → ${esc(String(r.status))}</li>`),
  ]);
  const ok = outcomes.filter((o) => o.status === 'ok').length;
  const serious = count('blocker') + count('major');
  const max = Math.max(1, ...ORDER.map(count), errLines.length);
  const bar = (label: string, v: number, color: string) =>
    `<div class="bar"><span>${label}</span><div class="track"><div class="fill" style="width:${((v / max) * 100).toFixed(1)}%;background:var(${color})"></div></div><span class="v">${v}</span></div>`;
  const notes = outcomes.filter((o) => o.notes || o.dropped.length || o.cause);
  return `<title>Bug Hunt ${esc(meta.run)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${REPORT_CSS}</style>
<div class="wrap">
<header>
  <div class="eyebrow">/bug-hunt · run ${esc(meta.run)}</div>
  <h1>Bug hunt report</h1>
  <p class="muted">Target <code>${esc(meta.baseUrl)}</code> · ${outcomes.length} scenario runs. Every finding below survived the orchestrator's screenshot check; console and network lines are listed separately.</p>
</header>
<div class="stats">
  <div class="stat ${ok === outcomes.length ? 'good' : 'alert'}"><b>${ok} / ${outcomes.length}</b><span>scenario runs completed</span></div>
  <div class="stat ${serious ? 'alert' : 'good'}"><b>${serious}</b><span>blocker or major</span></div>
  <div class="stat"><b>${count('minor')}</b><span>minor</span></div>
  <div class="stat"><b>${count('cosmetic')}</b><span>cosmetic</span></div>
  <div class="stat"><b>${gaps.length}</b><span>gaps (missing features)</span></div>
  <div class="stat"><b>${errLines.length}</b><span>console / network lines</span></div>
</div>
<section>
  <h2>Run at a glance</h2>
  <div class="panel diagram">${funnel(outcomes, kept, all.length)}</div>
  <div class="panel bars">${bar('Blocker', count('blocker'), '--blocker')}${bar('Major', count('major'), '--major')}${bar('Minor', count('minor'), '--minor')}${bar('Cosmetic', count('cosmetic'), '--cosmetic')}${bar('Info', count('info'), '--info')}${bar('Console / net', errLines.length, '--muted')}</div>
</section>
<section>
  <h2>Bugs</h2>
  ${bugs.length ? `<div class="cards">${bugs.map((f) => card(f, exists)).join('')}</div>` : '<p class="muted">None found.</p>'}
</section>
<section>
  <h2>Gaps (missing features, not bugs)</h2>
  ${gaps.length ? `<div class="cards">${gaps.map((f) => card(f, exists)).join('')}</div>` : '<p class="muted">None.</p>'}
</section>
<section>
  <h2>Scenario status</h2>
  ${statusGrid(outcomes)}
  <p class="muted">H = happy, F = fuzz. Green: completed (a trailing ! means the goal wasn't reached). Amber: incomplete. Red: setup failed. Grey: mode not run.</p>
</section>
<section>
  <h2>Details</h2>
  <details><summary>Console and network errors (${errLines.length})</summary>${errLines.length ? `<ul>${errLines.join('')}</ul>` : '<p class="muted">None.</p>'}</details>
  <details><summary>Coverage notes (${notes.length})</summary><ul>${notes.map((o) => `<li><code>${esc(o.scenario)} (${o.mode})</code> ${o.cause ? `<b>${esc(o.cause)}</b> ` : ''}${esc(o.notes)}${o.dropped.length ? ` <span class="muted">· dropped: ${o.dropped.map(esc).join('; ')}</span>` : ''}</li>`).join('')}</ul></details>
  ${skipped.length ? `<details open><summary>Unreadable files (${skipped.length})</summary><ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
</section>
<footer>Generated by <code>bug-hunt report</code> from <code>findings/</code> and <code>network/</code> for run ${esc(meta.run)}. Synthetic test personas only. Triage only: nothing is filed to a tracker.</footer>
</div>`;
}
