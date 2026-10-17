import { chmodSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { requireSurface, statePath, type Config } from './config';
import type { Surface } from './storyboard';
import { hasAuthSessionCookie, isSignedIn, isSignedInUrl } from './browser/session';

const TIMEOUT_MS = 5 * 60_000;

// Confirm (in a second tab) only once the human's own tab is on a new same-origin, non-login URL,
// so polling never steals focus mid-OTP — not even on a post-submit page like /verify-request.
export function readyToConfirm(url: string, baseUrl: string, lastChecked: string | undefined): boolean {
  return isSignedInUrl(url, baseUrl) && url !== lastChecked;
}

export async function runAuth(cfg: Config, surface: Surface, log: (s: string) => void = console.log): Promise<string> {
  const { baseUrl, signedInPath } = requireSurface(cfg, surface);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: false });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(baseUrl + signedInPath);
    log(`Sign in to ${surface} as the synthetic showcase persona in the browser window (5 min)…`);
    const deadline = Date.now() + TIMEOUT_MS;
    let lastChecked: string | undefined;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const url = page.url();
      // Reading cookies opens no tab, so it runs every poll: a sign-in that renders at
      // /login itself is a URL readyToConfirm never confirms.
      const cookieSignedIn = hasAuthSessionCookie(await ctx.cookies(baseUrl));
      if (!cookieSignedIn && !readyToConfirm(url, baseUrl, lastChecked)) continue;
      lastChecked = url;
      if (cookieSignedIn || (await isSignedIn(ctx, baseUrl + signedInPath))) {
        const out = statePath(cfg, surface);
        await ctx.storageState({ path: out });
        chmodSync(out, 0o600);
        log(`saved ${out}`);
        return out;
      }
    }
    throw new Error(`timed out waiting for ${surface} sign-in`);
  } finally {
    await browser.close();
  }
}
