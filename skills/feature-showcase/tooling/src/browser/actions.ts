import type { Locator, Page } from 'playwright';
import { requireSurface, type Config } from '../config';
import type { Action, Surface, Target } from '../storyboard';
import { assertOnSurface } from './session';

// How actions move: a recording moves like a person and restarts the screencast after a
// navigation; everything else (setup, dry run, probe) goes as fast as it can.
export interface Pace {
  humanize: boolean;
  onNavigate(): Promise<void>;
}

export const FAST: Pace = { humanize: false, onNavigate: async () => {} };

export interface ActionContext {
  page: Page;
  surfaces: Config['surfaces'];
  defaultSurface: Surface;
  mouse: { x: number; y: number };
  pace: Pace;
}

const TIMEOUT_MS = 15_000;

export function locate(page: Page, t: Target): Locator {
  if ('role' in t) return page.getByRole(t.role as Parameters<Page['getByRole']>[0], { name: t.name }).first();
  if ('label' in t) return page.getByLabel(t.label).first();
  if ('text' in t) return page.getByText(t.text).first();
  return page.getByTestId(t.testId).first();
}

async function settle(ctx: ActionContext) {
  await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

async function moveTo(ctx: ActionContext, x: number, y: number) {
  await ctx.page.mouse.move(x, y, { steps: ctx.pace.humanize ? 25 : 1 });
  ctx.mouse.x = x;
  ctx.mouse.y = y;
}

async function pointAt(ctx: ActionContext, t: Target): Promise<Locator> {
  const loc = locate(ctx.page, t);
  await loc.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`target ${JSON.stringify(t)} has no bounding box`);
  await moveTo(ctx, box.x + box.width / 2, box.y + box.height / 2);
  return loc;
}

export async function perform(ctx: ActionContext, a: Action): Promise<void> {
  const { page } = ctx;
  switch (a.do) {
    case 'goto': {
      const surface = a.surface ?? ctx.defaultSurface;
      await page.goto(requireSurface(ctx, surface).baseUrl + a.path, { waitUntil: 'load' });
      await settle(ctx);
      assertOnSurface(page.url(), ctx.surfaces, surface);
      await ctx.pace.onNavigate();
      await page.mouse.move(ctx.mouse.x, ctx.mouse.y); // re-show the cursor on the new document
      return;
    }
    case 'click': {
      const before = page.url();
      const loc = await pointAt(ctx, a.target);
      if (ctx.pace.humanize) await page.waitForTimeout(150);
      // locator.click (not a raw mouse.down/up at the old coordinates) waits until the target is
      // stable and actually receives the click; the cursor is already at its centre.
      await loc.click({ timeout: TIMEOUT_MS });
      await settle(ctx);
      if (page.url() !== before) {
        await ctx.pace.onNavigate();
        await page.mouse.move(ctx.mouse.x, ctx.mouse.y); // re-show the cursor on the new document
      }
      if (ctx.pace.humanize) await page.waitForTimeout(400);
      return;
    }
    case 'hover':
      await pointAt(ctx, a.target);
      if (ctx.pace.humanize) await page.waitForTimeout(600);
      return;
    case 'fill': {
      const loc = await pointAt(ctx, a.target);
      await loc.click({ timeout: TIMEOUT_MS });
      await loc.fill('');
      await loc.pressSequentially(a.value, { delay: ctx.pace.humanize ? 45 : 0 });
      return;
    }
    case 'scroll':
      await page.mouse.wheel(0, a.y);
      await page.waitForTimeout(ctx.pace.humanize ? 700 : 100);
      return;
    case 'waitFor':
      await locate(page, a.target).waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      return;
    case 'pause':
      await page.waitForTimeout(a.ms);
      return;
  }
}
