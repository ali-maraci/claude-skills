import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSessionCookie, assertSignedInUrl, isLoginUrl, signInMember } from '../src/session';
import { stubConfig } from './cfg-stub';

describe('assertSignedInUrl', () => {
  const base = 'https://app-staging.ab12.example.test';
  it('passes on the signed-in page', () => expect(() => assertSignedInUrl(`${base}/account`, base, '/account')).not.toThrow());
  it.each([
    [`${base}/login?reason=expired`, 'login redirect'],
    [`${base}/register`, 'another page'],
    ['https://accounts.example.test/x', 'another origin'],
  ])('fails on %s (%s) and says to finish registration by hand', (u) => {
    expect(() => assertSignedInUrl(u, base, '/account')).toThrow(/setup-failed: .*finish registration by hand/);
  });
  it('requires some cookie after sign-in', () => {
    expect(() => assertSessionCookie([])).toThrow(/setup-failed: no session cookie/);
    expect(() => assertSessionCookie(['sid'])).not.toThrow();
  });
  it('isLoginUrl compares against the configured login path only', () => {
    expect(isLoginUrl(`${base}/login`, '/login')).toBe(true);
    expect(isLoginUrl(`${base}/login/code`, '/login')).toBe(true);
    expect(isLoginUrl(`${base}/blogin`, '/login')).toBe(false);
    expect(isLoginUrl(`${base}/signin`, '/login')).toBe(false);
    expect(isLoginUrl(`${base}/signin`, '/signin')).toBe(true);
  });
  it('isLoginUrl with LOGIN_PATH=/ matches only the root, so sign-in can move on to any other page', () => {
    expect(isLoginUrl(`${base}/`, '/')).toBe(true);
    expect(isLoginUrl(`${base}/?next=/account`, '/')).toBe(true);
    expect(isLoginUrl(`${base}/account`, '/')).toBe(false);
    expect(isLoginUrl(`${base}/verify`, '/')).toBe(false);
  });
});

// A local stand-in app (self-test origin): /login is the email step, then the code step, then it
// navigates to /home?c=<code>. `held` redirects the signed-in page elsewhere, as an unregistered account would be.
interface Opts { codeLabel: string; boxes: boolean; verifyPath?: boolean; limited?: string; held?: boolean }
const page = (o: Opts) => `<!doctype html><title>Sign in</title><main id="m"></main><script>
const m = document.getElementById('m');
m.innerHTML = '<label>Email address <input type="email"></label><button id="go">Continue</button><button>Continue with Google</button><p id="e"></p>';
document.getElementById('go').onclick = () => {
  ${o.limited ? `const e = document.getElementById('e'); e.setAttribute('role', 'alert'); e.textContent = ${JSON.stringify(o.limited)}; return;` : ''}
  ${o.verifyPath ? "history.pushState({}, '', '/verify');" : ''}
  const n = ${o.boxes ? 6 : 1};
  m.innerHTML = Array.from({ length: n }, (_, i) => '<input aria-label="' + ${JSON.stringify(o.codeLabel)}.replace('{n}', i + 1) + '">').join('') + '<button id="ok">Continue</button>';
  document.getElementById('ok').onclick = () => { location.href = '/home?c=' + [...m.querySelectorAll('input')].map((i) => i.value).join(''); };
};
</script>`;

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); vi.unstubAllEnvs(); });

async function stand(o: Opts) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    seen.push(url);
    res.setHeader('set-cookie', 'sid=1; Path=/');
    if (url.startsWith('/account') && o.held) { res.statusCode = 302; res.setHeader('location', '/register'); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(url.startsWith('/login') ? page(o) : `<!doctype html><title>x</title><h1>${url.split('?')[0]}</h1>`);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = mkdtempSync(join(tmpdir(), 'bh-sess-'));
  const cfg = stubConfig({
    baseUrl: base, runsRoot: join(root, 'runs'), cacheRoot: join(root, 'cache'),
    signIn: { ...stubConfig().signIn, codeLabel: o.codeLabel, rateLimitedText: o.limited ?? '' },
  });
  return { cfg, seen, base };
}
const code = async () => '123456';

describe('signInMember', () => {
  it('fills CODE_LABEL once when it has no {n}, and saves a 0600 storage state', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg, seen } = await stand({ codeLabel: 'Code', boxes: false });
    const out = await signInMember(cfg, '2026-10-10-0930', { getCode: code });
    expect(seen).toContain('/home?c=123456');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf8')).cookies.length).toBeGreaterThan(0);
  }, 60_000);

  it('fills six per-digit boxes when CODE_LABEL contains {n}', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg, seen } = await stand({ codeLabel: 'Digit {n}', boxes: true });
    await signInMember(cfg, '2026-10-10-0930', { getCode: code });
    expect(seen).toContain('/home?c=123456');
  }, 60_000);

  it('waits for the final submit when the code step is on its own path', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg, seen } = await stand({ codeLabel: 'Code', boxes: false, verifyPath: true });
    await signInMember(cfg, '2026-10-10-0930', { getCode: code });
    expect(seen).toContain('/home?c=123456');
  }, 60_000);

  it('refuses to navigate to a signed-in URL outside the allowlist', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg } = await stand({ codeLabel: 'Code', boxes: false });
    cfg.signIn.signedInPath = '//evil.example.test/x';
    await expect(signInMember(cfg, '2026-10-10-0930', { getCode: code })).rejects.toThrow(/not an allowed bug-hunt origin/);
  }, 60_000);

  it('fails setup when sign-in does not end on SIGNED_IN_PATH', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg } = await stand({ codeLabel: 'Code', boxes: false, held: true });
    await expect(signInMember(cfg, '2026-10-10-0930', { getCode: code })).rejects.toThrow(/^setup-failed: .*finish registration by hand/);
  }, 60_000);

  it('fails setup as rate-limited instead of timing out, and records the send', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg } = await stand({ codeLabel: 'Code', boxes: false, limited: 'Too many codes. Try again later.' });
    await expect(signInMember(cfg, '2026-10-10-0930', { getCode: code })).rejects.toThrow('setup-failed: rate-limited — wait and retry');
    const ledger = join(cfg.cacheRoot, 'otp-sends.log');
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('refuses before sending once the configured hourly OTP budget is spent', async () => {
    vi.stubEnv('BUG_HUNT_SELF_TEST', '1');
    const { cfg } = await stand({ codeLabel: 'Code', boxes: false });
    cfg.otpBudget = { perHour: 2, perEmail: 3 };
    mkdirSync(cfg.cacheRoot, { recursive: true });
    const ledger = join(cfg.cacheRoot, 'otp-sends.log');
    writeFileSync(ledger, Array.from({ length: 2 }, () => new Date().toISOString()).join('\n') + '\n');
    await expect(signInMember(cfg, '2026-10-10-0930', { getCode: code })).rejects.toThrow(/OTP budget — 2 codes/);
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);
});
