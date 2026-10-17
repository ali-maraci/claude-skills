import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios } from '../src/scenario';

const good = `---
id: example-upload
area: member-core
persona: finished-member
start: /items
modes: [happy, fuzz]
budget: { max_turns: 60 }
---
## Goal
Upload a file and see it in the list.

## Success criteria
- It appears.

## Fuzz twists
- Double-click Upload.

## Out of bounds
- Staging only.
`;
const dirWith = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'bh-sc-'));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
  return d;
};

describe('loadScenarios', () => {
  it('parses a valid scenario', () => {
    const [s] = loadScenarios(dirWith({ 'example-upload.md': good }));
    expect(s.meta.modes).toEqual(['happy', 'fuzz']);
    expect(s.body).toMatch(/## Goal/);
  });
  it('requires id to match the filename', () => {
    expect(() => loadScenarios(dirWith({ 'other.md': good }))).toThrow(/other\.md: id/);
  });
  it('requires the three sections', () => {
    expect(() => loadScenarios(dirWith({ 'example-upload.md': good.replace('## Fuzz twists', '## Notes') }))).toThrow(/Fuzz twists/);
  });
  it('requires an Out of bounds heading (F6)', () => {
    expect(() => loadScenarios(dirWith({ 'example-upload.md': good.replace('## Out of bounds', '## Limits') }))).toThrow(/Out of bounds/);
  });
  it.each([
    ['inline mention', good.replace('## Out of bounds\n', 'See ## Out of bounds below.\n')],
    ['longer heading', good.replace('## Goal\n', '## Goals\n')],
    ['h3', good.replace('## Success criteria', '### Success criteria')],
  ])('section headings are line-anchored (%s)', (_n, text) => {
    expect(() => loadScenarios(dirWith({ 'example-upload.md': text }))).toThrow(/missing/);
  });
  it('accepts any kebab-case area', () => {
    const [s] = loadScenarios(dirWith({ 'example-upload.md': good.replace('area: member-core', 'area: billing') }));
    expect(s.meta.area).toBe('billing');
  });
  it.each(['Billing', 'two words', 'a_b', '-x', 'x-'])('rejects the area "%s"', (area) => {
    expect(() => loadScenarios(dirWith({ 'example-upload.md': good.replace('area: member-core', `area: ${area}`) }))).toThrow(/area/);
  });
  it('rejects an unknown persona', () => {
    expect(() => loadScenarios(dirWith({ 'example-upload.md': good.replace('finished-member', 'admin') }))).toThrow(/persona/);
  });
  it('validates the real scenarios directory', () => {
    expect(loadScenarios(join(__dirname, '../../scenarios')).length).toBe(1);
  });
});
