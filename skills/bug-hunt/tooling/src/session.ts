import { chmodSync } from 'node:fs';
import { chromium } from 'playwright';
import { assertAllowedUrl } from './allowlist';
import { checkOtpBudget, readOtpLedger, recordOtpSend } from './budget';
import type { Config } from './config';
import { waitForCode } from './otp';
import { ensureRunDirs, runPaths } from './paths';

export function isLoginUrl(url: string, loginPath: string): boolean {
  const p = new URL(url).pathname;
  // A root login page must not make every path count as "still on login".
  if (loginPath === '/') return p === '/';
  return p === loginPath || p.startsWith(`${loginPath.replace(/\/$/, '')}/`);
}

// After sign-in the member must be able to open SIGNED_IN_PATH (a page that sends a signed-out visitor to
// login). Anywhere else means the account is unregistered, onboarding is pending, or the session was not issued.
export function assertSignedInUrl(url: string, baseUrl: string, signedInPath: string): void {
  const u = new URL(url);
  const want = new URL(signedInPath, baseUrl);
  if (u.origin !== want.origin || u.pathname !== want.pathname) {
    throw new Error(`setup-failed: after sign-in ${signedInPath} led to ${u.origin}${u.pathname} — finish registration by hand, or check SIGNED_IN_PATH`);
  }
}

export function assertSessionCookie(names: string[]): void {
  if (names.length === 0) throw new Error('setup-failed: no session cookie after sign-in — the member is not signed in');
}

export interface SignInDeps { getCode?: typeof waitForCode }

// Plain Playwright, not the agent: setup is allowed to script. The code is read from the qa
// mailbox; neither the code nor any cookie is printed.
export async function signInMember(cfg: Config, run: string, { getCode = waitForCode }: SignInDeps = {}): Promise<string> {
  const si = cfg.signIn;
  ensureRunDirs(cfg, run);
  const out = runPaths(cfg, run).state('member');
  const loginUrl = `${cfg.baseUrl}${si.loginPath}`;
  assertAllowedUrl(loginUrl, cfg);
  const perDigit = si.codeLabel.includes('{n}');
  const codeBox = (n: number) => ({ name: si.codeLabel.replace('{n}', String(n)) });
  const submit = { name: si.submitLabel, exact: true } as const; // exact: "Continue with …" buttons must not match
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(loginUrl);
    // Mail servers stamp received time at whole seconds: allow for a laptop clock running fast.
    const since = new Date(Date.now() - 30_000);
    await page.getByRole('textbox', { name: si.emailLabel }).fill(cfg.memberEmail);
    // re-sign-ins mid-sweep count too: refuse before tripping the app's per-IP limit
    checkOtpBudget(readOtpLedger(cfg), new Date(), cfg.otpBudget, cfg.memberEmail);
    recordOtpSend(cfg, new Date(), cfg.memberEmail);
    await page.getByRole('button', submit).click();
    const firstBox = page.getByRole('textbox', codeBox(1));
    if (si.rateLimitedText) {
      // A throttled request stays on the email step with the rate-limit text: say so, don't time out.
      const limited = page.getByText(si.rateLimitedText);
      await firstBox.or(limited).first().waitFor();
      if (await limited.isVisible()) throw new Error('setup-failed: rate-limited — wait and retry');
    } else {
      await firstBox.waitFor();
    }
    const code = await getCode(cfg, cfg.memberEmail, { since });
    if (perDigit) for (let i = 0; i < 6; i++) await page.getByRole('textbox', codeBox(i + 1)).fill(code[i]);
    else await firstBox.fill(code);
    // The code step may live on its own path: wait for a move away from where we submit, not just away from login.
    const beforeSubmit = page.url();
    await page.getByRole('button', submit).click();
    await page.waitForURL((u) => u.toString() !== beforeSubmit && !isLoginUrl(u.toString(), si.loginPath), { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    const signedInUrl = new URL(si.signedInPath, cfg.baseUrl).toString();
    assertAllowedUrl(signedInUrl, cfg);
    await page.goto(signedInUrl);
    await page.waitForLoadState('networkidle');
    assertSignedInUrl(page.url(), cfg.baseUrl, si.signedInPath);
    assertSessionCookie((await ctx.cookies()).map((c) => c.name));
    await ctx.storageState({ path: out });
    chmodSync(out, 0o600);
    return out;
  } finally {
    await browser.close();
  }
}
