import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunReport, renderReport } from '../src/report';
import { setupFailed, type ScenarioOutcome } from '../src/findings';
import { scanDir } from '../src/scan';

const f = (title: string, severity: string, kind = 'functional', start = '/items') => ({
  title, severity, kind, steps: ['a'], expected: 'e', actual: 'x', evidence: ['screens/a.png'], route: start,
});
const outcome = (scenario: string, findings: object[]): ScenarioOutcome =>
  ({ scenario, mode: 'fuzz', goal_reached: true, findings, notes: 'did not test drag-and-drop', status: 'ok', dropped: [] }) as ScenarioOutcome;
const meta = { run: '2026-10-10-0930', baseUrl: 'https://app-staging.ab12.example.test', started: '2026-10-10T09:30:00Z' };

describe('renderReport', () => {
  const md = renderReport(meta, [
    outcome('example-upload', [f('Double submit', 'major'), f('Typo in heading', 'cosmetic', 'copy')]),
    outcome('example-download', [f('Double submit', 'major')]),
    outcome('example-account', [f('No edit button', 'info', 'gap', '/account')]),
    setupFailed('example-signup', 'happy', 'setup-failed: pool empty'),
  ], { 'example-upload-fuzz': { errors: ['[ERROR] TypeError'], failed: [] } });

  it('orders by severity and merges duplicates across scenarios', () => {
    expect(md.indexOf('Double submit')).toBeLessThan(md.indexOf('Typo in heading'));
    expect(md.match(/### .*Double submit/g)).toHaveLength(1);
    expect(md).toMatch(/example-upload \(fuzz\), example-download \(fuzz\)/);
  });
  it('a merged duplicate takes the worst severity seen', () => {
    const m = renderReport(meta, [
      outcome('example-dashboard', [f('Save does nothing', 'minor')]),
      outcome('dashboard-edit', [f('Save does nothing', 'blocker')]),
    ], {});
    expect(m).toMatch(/### \[blocker\] Save does nothing/);
    expect(m).toMatch(/\| blocker \| 1 \|/);
    expect(m).toMatch(/\| minor \| 0 \|/);
  });
  it('lists gaps separately from bugs', () => {
    expect(md.indexOf('## Gaps')).toBeGreaterThan(md.indexOf('## Bugs'));
    expect(md.slice(md.indexOf('## Gaps'))).toMatch(/No edit button/);
  });
  it('shows setup failures and coverage notes', () => {
    expect(md).toMatch(/example-signup.*setup-failed: pool empty/);
    expect(md).toMatch(/did not test drag-and-drop/);
  });
  it('passes the secret scan', () => {
    const d = mkdtempSync(join(tmpdir(), 'bh-rep-'));
    writeFileSync(join(d, 'report.md'), md);
    expect(scanDir(d, 'pw-not-present')).toEqual([]);
  });
});

describe('screenshot links (R4)', () => {
  it('resolves bare filenames under screens/ and leaves screens/ paths alone', () => {
    const o = outcome('s-one', [{ ...f('Bare', 'major'), evidence: ['s-one-fuzz-01.png', 'screens/s-one-fuzz-02.png'] }]);
    const out = renderReport(meta, [o], {});
    expect(out).toContain('![](screens/s-one-fuzz-01.png)');
    expect(out).toContain('![](screens/s-one-fuzz-02.png)');
    expect(out).not.toContain('screens/screens/');
  });
});

describe('loadRunReport', () => {
  it('skips unparseable files with a note instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-run-'));
    const paths = { findings: join(dir, 'findings'), network: join(dir, 'network') };
    mkdirSync(paths.findings); mkdirSync(paths.network);
    writeFileSync(join(paths.findings, 'a-b-fuzz.json'), JSON.stringify(outcome('a-b', [f('Real one', 'minor')])));
    writeFileSync(join(paths.findings, 'bad-fuzz.json'), '{not json');
    writeFileSync(join(paths.network, 'a-b-fuzz.json'), JSON.stringify({ errors: ['[ERROR] Boom'], failed: [] }));
    writeFileSync(join(paths.network, 'bad-net-fuzz.json'), 'nope');
    const md = loadRunReport(paths, meta);
    expect(md).toMatch(/Real one/);
    expect(md).toMatch(/\[ERROR\] Boom/);
    expect(md).toMatch(/bad-fuzz\.json/);
    expect(md).toMatch(/bad-net-fuzz\.json/);
  });
});

describe('fix round 1 report', () => {
  it('M1: collapses newlines and escapes pipes', () => {
    const o = outcome('s-one', [{ ...f('Line1\n## Injected | x', 'major'), actual: 'a\r\n# H', evidence: ['console: a\n## E'] }]);
    o.notes = 'n\n## N';
    const md = renderReport(meta, [{ ...o }, { ...setupFailed('s-two', 'happy', 'c\n## C | d') }], {});
    expect(md).not.toMatch(/^## (Injected|N\b|C\b|E\b)/m);
    expect(md).not.toMatch(/^# H/m);
    expect(md).toContain('| s-two | happy | setup-failed | no | c ## C \\| d |');
  });
  it('M2: every png renders under screens/ by basename', () => {
    const o = outcome('s-one', [{ ...f('P', 'major'), evidence: ['../x.png', 'screens/../../y.png'] }]);
    const md = renderReport(meta, [o], {});
    expect(md).toContain('![](screens/x.png)');
    expect(md).toContain('![](screens/y.png)');
    expect(md).not.toContain('..');
  });
});

describe('F2: orchestrator hand-edits are redacted', () => {
  it('redacts a hand-edited findings file and writes it back, so findings and report.md pass scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-f2-'));
    const paths = { findings: join(dir, 'findings'), network: join(dir, 'network') };
    mkdirSync(paths.findings); mkdirSync(paths.network);
    const o = outcome('a-b', [{ ...f('Login', 'minor'), actual: 'downgraded: only the password hint is wrong (signature=1)' }]);
    o.dropped = ['Leak — dropped by orchestrator: screenshot shows password field, signature=1'];
    const file = join(paths.findings, 'a-b-fuzz.json');
    writeFileSync(file, JSON.stringify(o, null, 2));
    expect(scanDir(dir, '')).not.toEqual([]);
    writeFileSync(join(dir, 'report.md'), loadRunReport(paths, meta));
    expect(scanDir(dir, '')).toEqual([]);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    expect(back.findings[0].actual).not.toMatch(/password|signature=1/);
    expect(back.dropped[0]).toMatch(/dropped by orchestrator/);
  });
});

describe('F6 report summary and dedupe', () => {
  it('counts info bugs and console/network errors in the summary table', () => {
    const md = renderReport(meta, [outcome('s-one', [f('FYI', 'info', 'ux'), f('Gap', 'info', 'gap')])], {
      's-one-fuzz': { errors: ['[ERROR] a', '[ERROR] b'], failed: [{ method: 'GET', url: 'https://s.test/x', status: 500 }] },
      's-two-happy': { errors: [], failed: [{ method: 'GET', url: 'https://s.test/y', status: 'failed' }] },
    });
    expect(md).toContain('| info | 1 |');
    expect(md).toContain('| errors | 4 |');
  });
  it('dedupe records scenario (mode) pairs and unions evidence', () => {
    const a = { ...outcome('s-one', [{ ...f('Same', 'major'), evidence: ['a.png', 'console: x'] }]), mode: 'happy' as const };
    const b = outcome('s-one', [{ ...f('Same', 'major'), evidence: ['a.png', 'b.png'] }]);
    const c = outcome('s-two', [{ ...f('Same', 'major'), evidence: ['c.png'] }]);
    const md = renderReport(meta, [a, b, c], {});
    expect(md.match(/### .*Same/g)).toHaveLength(1);
    expect(md).toContain('Scenarios: s-one (happy), s-one (fuzz), s-two (fuzz)');
    for (const e of ['![](screens/a.png)', '- console: x', '![](screens/b.png)', '![](screens/c.png)']) expect(md).toContain(e);
    expect(md.match(/screens\/a\.png/g)).toHaveLength(1);
  });
});

