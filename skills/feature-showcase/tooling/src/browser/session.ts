import { existsSync, readFileSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { requireSurface, statePath, type Config } from '../config';
import type { Surface } from '../storyboard';

export const VIEWPORT = { width: 1920, height: 1080 };

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export function isLoginUrl(url: string): boolean {
  return /(^|\/)(login|signin|sign-in)(\/|$)/i.test(new URL(url).pathname);
}

// On baseUrl's origin and off its login page: what a signed-in session looks like.
export function isSignedInUrl(url: string, baseUrl: string): boolean {
  return new URL(url).origin === new URL(baseUrl).origin && !isLoginUrl(url);
}

export function mergedStorageState(cfg: Config, surfaces: Surface[]): StorageState {
  const merged: StorageState = { cookies: [], origins: [] };
  for (const s of surfaces) {
    const p = statePath(cfg, s);
    if (!existsSync(p)) throw new Error(`no saved session for ${s} — run: feature-showcase auth ${s}`);
    const st = JSON.parse(readFileSync(p, 'utf8')) as Partial<StorageState>;
    merged.cookies.push(...(st.cookies ?? []));
    merged.origins.push(...(st.origins ?? []));
  }
  return merged;
}

// A headless browser context signed in to the given surfaces; closed when fn settles.
export async function withStagingContext<T>(cfg: Config, surfaces: Surface[], fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  for (const s of surfaces) requireSurface(cfg, s);
  const storageState = mergedStorageState(cfg, surfaces);
  const browser = await chromium.launch();
  try {
    return await fn(await browser.newContext({ storageState, viewport: VIEWPORT }));
  } finally {
    await browser.close();
  }
}

// The Auth.js / NextAuth session cookie (plain or __Secure- prefixed, chunked as .0, .1… when
// large). Other auth stacks fall back to the page check in isSignedIn.
const AUTH_SESSION_COOKIE = /^(__Secure-)?(authjs|next-auth)\.session-token(\.\d+)?$/;

type Cookie = StorageState['cookies'][number];

// An unexpired session cookie (expires -1 = browser-session cookie).
export function hasAuthSessionCookie(cookies: Cookie[], nowSeconds = Date.now() / 1000): boolean {
  return cookies.some((c) => AUTH_SESSION_COOKIE.test(c.name) && (c.expires === -1 || c.expires > nowSeconds));
}

export async function isSignedIn(ctx: BrowserContext, url: string): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    return isSignedInUrl(page.url(), url) || hasAuthSessionCookie(await ctx.cookies(url));
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

// Every shown step must stay on a staging origin and off its login page; otherwise the
// session expired (or an SSO redirect fired) and a login screen would be recorded.
export function assertOnSurface(url: string, surfaces: Config['surfaces'], fallback: Surface): void {
  const u = new URL(url);
  const match = (Object.keys(surfaces) as Surface[]).find((s) => surfaces[s] && new URL(surfaces[s]!.baseUrl).origin === u.origin);
  if (!match) throw new Error(`left staging for ${u.origin} (likely a login redirect) — the saved session expired; run: feature-showcase auth ${fallback}`);
  if (isLoginUrl(url)) throw new Error(`${match} redirected to a login page (${u.pathname}) — the saved session expired; run: feature-showcase auth ${match}`);
}
