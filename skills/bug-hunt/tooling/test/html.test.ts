import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referencedScreens, renderHtml } from '../src/html';
import { stageArtifact } from '../src/artifact';
import { setupFailed, type ScenarioOutcome } from '../src/findings';
import { scanDir } from '../src/scan';

const f = (title: string, severity: string, evidence: string[] = ['a.png'], kind = 'functional') => ({
  title, severity, kind, steps: ['open /items'], expected: 'one row', actual: 'two rows', evidence, route: '/items',
});
const outcome = (scenario: string, findings: object[], mode = 'fuzz', extra: object = {}): ScenarioOutcome =>
  ({ scenario, mode, goal_reached: true, findings, notes: 'did not test drag-and-drop', status: 'ok', dropped: [], ...extra }) as ScenarioOutcome;
const meta = { run: '2026-10-11-1014', baseUrl: 'https://app-staging.ab12.example.test', started: '2026-10-11-1014' };

describe('renderHtml', () => {
  const outcomes = [
    outcome('example-upload', [f('Double upload', 'major'), f('Typo', 'cosmetic', [], 'copy')]),
    outcome('example-upload', [f('Double upload', 'major', ['b.png'])], 'happy'),
    outcome('example-account', [f('No edit button', 'info', [], 'gap')], 'happy', { dropped: ['x — no evidence on disk'] }),
    setupFailed('example-signup', 'happy', 'setup-failed: pool empty'),
  ];
  const html = renderHtml(meta, outcomes, { 'example-upload-fuzz': { errors: ['[ERROR] 502'], failed: [] } });

  it('has a short title and the summary numbers', () => {
    expect(html.startsWith('<title>Bug Hunt 2026-10-11-1014</title>')).toBe(true);
    expect(html).toMatch(/<b>3 \/ 4<\/b><span>scenario runs completed/);
    expect(html).toMatch(/<b>1<\/b><span>blocker or major/);
  });
  it('merges duplicates, orders by severity and keeps gaps apart', () => {
    expect(html.match(/<h3>Double upload<\/h3>/g)).toHaveLength(1);
    expect(html.indexOf('Double upload')).toBeLessThan(html.indexOf('<h3>Typo'));
    expect(html.indexOf('<h3>No edit button')).toBeGreaterThan(html.indexOf('<h2>Gaps'));
  });
  it('draws the run funnel with numbers only', () => {
    expect(html).toMatch(/A\[4 scenario runs\] --> B\[3 completed\]/);
    expect(html).toMatch(/D\[1 setup failed\]/);
    expect(html).toMatch(/F\[1 dropped for evidence\]/);
  });
  it('shows a red dot for setup failures and grey for modes not run', () => {
    expect(html).toMatch(/dot setup-failed" title="happy: setup-failed"/);
    expect(html).toMatch(/dot none" title="fuzz: not run"/);
  });
  it('escapes untrusted text everywhere', () => {
    const evil = renderHtml(meta, [outcome('example-upload', [{
      ...f('<img src=x onerror=alert(1)>', 'minor', ['console: <script>x</script>']), route: '"><b>', steps: ['</ol><script>'],
    }], 'fuzz', { notes: '<iframe>' })], {});
    expect(evil).not.toMatch(/<img src=x|<script>|<iframe>|<\/ol><script>/);
    expect(evil).not.toContain('<span class="tag">"><b>');
    expect(evil).toContain('<span class="tag">&#34;&#62;&#60;b&#62;</span>');
    expect(evil).toContain('&#60;img src=x onerror=alert(1)&#62;');
  });
  it('links only plain png basenames that exist', () => {
    const h = renderHtml(meta, [outcome('example-upload', [f('Shots', 'minor', ['ok.png', 'screens/also.png', '../../etc/x.png', 'bad name.png', 'gone.png'])])], {});
    expect(h).toContain('src="screens/ok.png"');
    expect(h).toContain('src="screens/also.png"');
    expect(h).toContain('src="screens/x.png"'); // basename only: no traversal survives
    expect(h).not.toContain('bad name.png"');
    const exists = (n: string) => n !== 'gone.png';
    const h2 = renderHtml(meta, [outcome('example-upload', [f('Shots', 'minor', ['ok.png', 'gone.png'])])], {}, [], exists);
    expect(h2).not.toContain('screens/gone.png');
    expect(referencedScreens([outcome('d', [f('S', 'minor', ['ok.png', 'gone.png', 'ok.png'])])], exists)).toEqual(['ok.png']);
  });
  it('passes the secret scan', () => {
    const d = mkdtempSync(join(tmpdir(), 'bh-html-'));
    writeFileSync(join(d, 'report.html'), html);
    expect(scanDir(d, 'pw-not-present')).toEqual([]);
  });
});

describe('stageArtifact', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'bh-art-'));
    const dir = join(root, 'runs', meta.run);
    const screens = join(dir, 'screens');
    mkdirSync(screens, { recursive: true });
    for (const n of ['a.png', 'b.png', 'unlinked.png']) writeFileSync(join(screens, n), 'png');
    const html = join(dir, 'report.html');
    writeFileSync(html, renderHtml(meta, [outcome('example-upload', [f('X', 'minor', ['a.png', 'b.png', 'missing.png'])])], {}));
    return { root, p: { dir, html, screens } };
  };
  it('copies the page and only the screenshots it links, and returns root + relative files for the Artifact tool', () => {
    const { root, p } = setup();
    const dest = join(root, 'scratch');
    const r = stageArtifact(p, meta.run, dest);
    const out = join(dest, `bug-hunt-${meta.run}`);
    expect(r.file_path).toBe(join(out, 'report.html'));
    expect(r.root).toBe(out);
    expect([...r.files].sort()).toEqual(['screens/a.png', 'screens/b.png']);
    expect(readdirSync(join(out, 'screens')).sort()).toEqual(['a.png', 'b.png']);
    expect(readFileSync(r.file_path, 'utf8')).toBe(readFileSync(p.html, 'utf8'));
  });
  it('refuses a relative destination or one inside the run folder, and a run without report.html', () => {
    const { p } = setup();
    expect(() => stageArtifact(p, meta.run, 'scratch')).toThrow(/absolute/);
    expect(() => stageArtifact(p, meta.run, join(p.dir, 'out'))).toThrow(/outside the run folder/);
    expect(() => stageArtifact({ ...p, html: join(p.dir, 'nope.html') }, meta.run, mkdtempSync(join(tmpdir(), 'bh-d-')))).toThrow(/bug-hunt report/);
  });
});
