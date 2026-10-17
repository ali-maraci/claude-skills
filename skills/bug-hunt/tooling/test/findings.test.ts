import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerifierOutput, setupFailed } from '../src/findings';

const screens = mkdtempSync(join(tmpdir(), 'bh-sh-'));
writeFileSync(join(screens, 'example-upload-fuzz-01.png'), 'x');
const finding = (evidence: string[]) => ({
  title: 'Double-click uploads twice', severity: 'major', kind: 'functional',
  steps: ['Choose file', 'Double-click Upload'], expected: 'One document', actual: 'Two documents', evidence,
});
const result = (findings: object[]) => JSON.stringify({ scenario: 'example-upload', mode: 'fuzz', goal_reached: true, findings, notes: '' });

describe('parseVerifierOutput', () => {
  it('accepts JSON wrapped in prose / a code fence', () => {
    const raw = 'Done.\n```json\n' + result([finding(['screens/example-upload-fuzz-01.png'])]) + '\n```';
    const o = parseVerifierOutput(raw, screens, 'example-upload', 'fuzz');
    expect(o.status).toBe('ok');
    expect(o.findings).toHaveLength(1);
  });
  it('drops a finding whose screenshot does not exist and has no console/network evidence', () => {
    const o = parseVerifierOutput(result([finding(['screens/nope.png'])]), screens, 'example-upload', 'fuzz');
    expect(o.findings).toHaveLength(0);
    expect(o.dropped[0]).toMatch(/Double-click uploads twice/);
  });
  it('keeps a finding backed by console evidence', () => {
    const o = parseVerifierOutput(result([finding(['console: TypeError x'])]), screens, 'example-upload', 'fuzz');
    expect(o.findings).toHaveLength(1);
  });
  it('marks malformed output incomplete instead of throwing', () => {
    const o = parseVerifierOutput('I ran out of turns', screens, 'example-upload', 'fuzz');
    expect(o.status).toBe('incomplete');
    expect(o.findings).toEqual([]);
  });
});

describe('redaction of verifier output (R17)', () => {
  it('leaves nothing the scan flags, in findings JSON or the report', async () => {
    const { readdirSync } = await import('node:fs');
    const { scanDir } = await import('../src/scan');
    const { renderReport } = await import('../src/report');
    const f = {
      ...finding(['console: boom Authorization: Bearer x', 'example-upload-fuzz-01.png']),
      title: 'Password field label is wrong',
      steps: ['Set signature=abc then retry'],
    };
    const o = parseVerifierOutput(result([f]), screens, 'example-upload', 'fuzz');
    expect(o.findings).toHaveLength(1);
    const d = mkdtempSync(join(tmpdir(), 'bh-red-'));
    writeFileSync(join(d, 'example-upload-fuzz.json'), JSON.stringify(o));
    const md = renderReport({ run: '2026-10-10-0930', baseUrl: 'https://s.example.test', started: 'x' }, [o], {});
    writeFileSync(join(d, 'report.md'), md);
    expect(readdirSync(d)).toHaveLength(2);
    expect(scanDir(d, 'pw-not-present')).toEqual([]);
    for (const text of [JSON.stringify(o), md]) {
      expect(text).not.toMatch(/abc|Bearer x/);
    }
  });
  it('redacts a setup-failed cause', () => {
    expect(setupFailed('a-b', 'happy', 'password=hunter2 bad').cause).not.toMatch(/hunter2/);
  });
});

describe('fix round 1', () => {
  const run = (raw: string) => parseVerifierOutput(raw, screens, 'example-upload', 'fuzz');
  it('I1: png name with a flagged term is dropped when missing; finding kept via console evidence; report scan-clean', async () => {
    const { scanDir } = await import('../src/scan');
    const { renderReport } = await import('../src/report');
    const { redactText } = await import('../src/redact');
    const o = run(result([finding(['console: x', 'password-reset.png'])]));
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0].evidence).toEqual(['console: x']);
    expect(o.dropped.join(' ')).toMatch(/dropped missing screenshot/);
    const d = mkdtempSync(join(tmpdir(), 'bh-i1-'));
    writeFileSync(join(d, 'report.md'), renderReport({ run: 'r', baseUrl: 'https://s.example.test', started: 'x' }, [o], {}));
    expect(scanDir(d, 'pw-not-present')).toEqual([]);
    expect(redactText('example-upload-fuzz-01.png')).toBe('example-upload-fuzz-01.png');
  });
  it('I2: keeps valid findings, records invalid ones without raw content', () => {
    const bad = { ...finding(['console: x']), severity: 'critical', title: 'SECRETTITLE' };
    const o = run(result([finding(['console: ok']), bad]));
    expect(o.status).toBe('ok');
    expect(o.findings).toHaveLength(1);
    expect(o.dropped).toHaveLength(1);
    expect(o.dropped[0]).toMatch(/^invalid finding #1: /);
    expect(o.dropped[0]).not.toMatch(/SECRETTITLE|critical/);
  });
  it('I2: invalid envelope is incomplete', () => {
    const o = run(JSON.stringify({ scenario: 'x', mode: 'fuzz', goal_reached: 'yes', findings: [] }));
    expect(o.status).toBe('incomplete');
  });
  const good = result([finding(['console: ok'])]);
  it('I3: object followed by prose with braces', () => {
    expect(run(good + '\nNote {see above} done').findings).toHaveLength(1);
  });
  it('I3: leading prose with braces', () => {
    expect(run('I tried {x} first.\n' + good).findings).toHaveLength(1);
  });
  it('I3: two JSON objects, result is the second', () => {
    expect(run('{"progress": 1}\n' + good).findings).toHaveLength(1);
  });
  it('I3: braces inside strings are respected', () => {
    const r = JSON.stringify({ scenario: 'example-upload', mode: 'fuzz', goal_reached: true, findings: [finding(['console: a } b'])], notes: 'x { y' });
    expect(run('pre ' + r + ' post').findings).toHaveLength(1);
  });
  it('I3: garbage is incomplete with a reason, not echoed', () => {
    const o = run('SECRETWORD no json here');
    expect(o.status).toBe('incomplete');
    expect(o.notes).toMatch(/no JSON object found/);
    expect(o.notes).not.toMatch(/SECRETWORD/);
    expect(run('{"a":1} {"b":2}').notes).toMatch(/no object matched the result shape/);
  });
  it('I3: large prose reply is fast', () => {
    const big = '{ '.repeat(100_000) + good;
    const t = Date.now();
    run(big);
    expect(Date.now() - t).toBeLessThan(200);
  });
  it('M3: empty console:/network: does not back a finding', () => {
    expect(run(result([finding(['console:'])])).findings).toHaveLength(0);
    expect(run(result([finding(['network:   '])])).findings).toHaveLength(0);
  });
});
