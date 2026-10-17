import { describe, expect, it } from 'vitest';
import { assertTicketMatches, parseMerge } from '../src/cli';
import { assertKey } from '../src/paths';
import { parseStoryboard } from '../src/storyboard';
import { sampleStoryboard } from './fixtures/storyboard';

describe('cli helpers', () => {
  it('parses --merge owner/repo@sha', () => {
    expect(parseMerge('acme/web@abc1234')).toEqual({ repo: 'acme/web', sha: 'abc1234' });
    expect(() => parseMerge('app')).toThrow(/owner\/repo@sha/);
  });

  it('refuses a storyboard written for a different ticket', () => {
    const sb = parseStoryboard(sampleStoryboard());
    expect(() => assertTicketMatches(sb, 'PROJ-123')).not.toThrow();
    expect(() => assertTicketMatches(sb, 'PROJ-999')).toThrow(/storyboard is for PROJ-123, not PROJ-999/);
  });

  it('mentions an example ticket key when the key is malformed', () => {
    expect(() => assertKey('x')).toThrow(/PROJ-123/);
  });
});
