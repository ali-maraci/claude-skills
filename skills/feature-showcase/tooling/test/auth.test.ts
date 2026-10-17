import { describe, expect, it } from 'vitest';
import { readyToConfirm } from '../src/auth';

describe('readyToConfirm', () => {
  const base = 'https://app.test';
  it('waits while the human is on a login page or another origin', () => {
    expect(readyToConfirm('https://app.test/login', base, undefined)).toBe(false);
    expect(readyToConfirm('https://accounts.google.com/o/oauth2', base, undefined)).toBe(false);
  });

  it('confirms once per new same-origin URL, so a post-submit page (e.g. /verify-request) is not re-checked every poll', () => {
    expect(readyToConfirm('https://app.test/verify-request', base, undefined)).toBe(true);
    expect(readyToConfirm('https://app.test/verify-request', base, 'https://app.test/verify-request')).toBe(false);
    expect(readyToConfirm('https://app.test/items', base, 'https://app.test/verify-request')).toBe(true);
  });
});
