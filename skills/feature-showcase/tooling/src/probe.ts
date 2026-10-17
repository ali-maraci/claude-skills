import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import type { Surface } from './storyboard';
import { FAST, perform } from './browser/actions';
import { withStagingContext } from './browser/session';

export async function runProbe(cfg: Config, surface: Surface, path: string, outDir: string) {
  return withStagingContext(cfg, [surface], async (ctx) => {
    const page = await ctx.newPage();
    await perform({ page, surfaces: cfg.surfaces, defaultSurface: surface, mouse: { x: 0, y: 0 }, pace: FAST }, { do: 'goto', path });
    const snapshot = await page.locator('body').ariaSnapshot();
    mkdirSync(outDir, { recursive: true });
    const slug = `${surface}${path.replace(/[^a-z0-9]+/gi, '-')}`.replace(/-+$/, '');
    const snapshotPath = join(outDir, `${slug}.aria.yml`);
    writeFileSync(snapshotPath, snapshot);
    await page.screenshot({ path: join(outDir, `${slug}.png`) });
    return { snapshotPath, snapshot };
  });
}
