import { describe, expect, it } from 'vitest';
import { redactText, redactUrl } from '../src/redact';
import { SCAN_RULES } from '../src/terms';

describe('redact', () => {
  it('drops query strings and fragments', () => {
    expect(redactUrl('https://s.test/api/x?token=abc&user=9#f')).toBe('https://s.test/api/x');
  });
  it('masks JWTs, pin values and auth headers', () => {
    const s = redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl "pin": "123" Authorization: Bearer abc cookie: authjs.session-token=q');
    expect(s).not.toMatch(/eyJhbGci|"123"|Bearer abc|session-token=q/);
  });
  it('replaces whole matches', () => {
    expect(redactText('Authorization: Bearer abc')).toBe('[redacted-header]');
    expect(redactText('x __Secure-authjs.session-token=q; y')).toBe('x [redacted-cookie]; y');
  });
  it('strips query strings from URLs inside text, keeping the :line suffix', () => {
    expect(redactText('boom @ https://s.test/api/x?x=1&y=2:0')).toBe('boom @ https://s.test/api/x:0');
    expect(redactText('see https://s.test/a#frag now')).toBe('see https://s.test/a now');
  });

  it.each([
    ['url-encoded separator', 'signature%3DSECRET'],
    ['escaped-quote JSON', '{\\"signature\\":\\"SECRET\\"}'],
    ['JSON header key', '{"authorization":"Bearer SECRET"}'],
    ['bare bearer', 'got Bearer SECRET here'],
    ['single quotes spaced value', "{'signature': 'SECRET VAL'}"],
    ['password kv', 'IMAP_APP_PASSWORD=SECRET'],
    ['escaped pin', '{\\"pin\\": \\"SECRET\\"}'],
    ['padded jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SECRET='],
    ['upper-case cookie', 'AUTHJS.SESSION-TOKEN=SECRET'],
  ])('leaves no secret: %s', (_n, input) => {
    const out = redactText(input);
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('VAL');
    expect(SCAN_RULES.filter(([, re]) => re.test(out))).toEqual([]);
  });

  // every scan rule: flagged raw, clean after redaction (R15: one shared term list)
  it.each([
    ['pin', 'x "pin": y'],
    ['authorization', 'missing authorization header'],
    ['auth cookie', 'authjs.session-token cookie missing'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
    ['secret key', 'Password field is required, "current-password", app_password, IMAP_HOST'],
    ['signature', 'bad signature here'],
  ])('rule %s: flagged raw, clean after redactText', (rule, sample) => {
    const re = SCAN_RULES.find(([r]) => r === rule)![1];
    expect(re.test(sample)).toBe(true);
    expect(SCAN_RULES.filter(([, r]) => r.test(redactText(sample)))).toEqual([]);
  });

  // WebSocket URLs can carry a signature in the query
  const WSS = "[error] WebSocket connection to 'wss://realtime.example.test/v1/stream?session=s_42&signature=SECRETSIG' failed: Error in connection establishment @ https://s.test/_next/static/chunks/x.js?v=1:12";
  it('strips ws/wss query strings in text', () => {
    const out = redactText(WSS);
    expect(out).not.toMatch(/SECRETSIG|session=|signature/);
    expect(out).toContain('wss://realtime.example.test/v1/stream');
    expect(SCAN_RULES.filter(([, re]) => re.test(out))).toEqual([]);
    expect(redactText('ws://localhost:3000/socket?token=SECRET')).toBe('ws://localhost:3000/socket');
  });
  it('redactUrl handles ws/wss', () => {
    expect(redactUrl('wss://realtime.example.test/v1/stream?signature=S')).toBe('wss://realtime.example.test/v1/stream');
  });
  it('flags and neutralises a prefixed signature key (x_signature=, req_signature:)', () => {
    const re = SCAN_RULES.find(([r]) => r === 'signature')![1];
    for (const s of ['x_signature=SECRET', 'callback failed: req_signature: SECRET', '{"x_signature":"SECRET"}']) {
      expect(re.test(s), s).toBe(true);
      const out = redactText(s);
      expect(out).not.toContain('SECRET');
      expect(SCAN_RULES.filter(([, r]) => r.test(out))).toEqual([]);
    }
  });
  it('neutralises signature key/value pairs outside URLs', () => {
    for (const s of ['signature=SECRET', '{"signature":"SECRET"}', 'signature: SECRET']) {
      const out = redactText(s);
      expect(out).not.toContain('SECRET');
      expect(SCAN_RULES.filter(([, re]) => re.test(out))).toEqual([]);
    }
  });
});

