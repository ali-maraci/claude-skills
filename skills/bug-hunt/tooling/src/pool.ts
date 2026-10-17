import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';

// Every reservation burns the address: a signup attempt can't be undone.
export function reserveSignup(cfg: Pick<Config, 'configDir'>): string {
  const poolPath = join(cfg.configDir, 'signup-pool.txt');
  const lines = existsSync(poolPath) ? readFileSync(poolPath, 'utf8').split('\n') : [];
  const i = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (i < 0) throw new Error(`setup-failed: pool empty — add more unregistered <mailbox>+qa-signup-NNN addresses to ${poolPath}`);
  const address = lines[i].trim();
  lines.splice(i, 1);
  writeFileSync(poolPath, lines.join('\n'));
  appendFileSync(join(cfg.configDir, 'used.txt'), `${address}\t${new Date().toISOString()}\n`);
  return address;
}
