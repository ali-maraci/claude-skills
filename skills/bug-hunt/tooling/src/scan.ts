import { lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { SCAN_RULES } from './terms';

// Fail closed: every regular file is scanned except known binary images.
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

interface Hit { file: string; rule: string }

function* files(dir: string, hits: Hit[]): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) hits.push({ file: p, rule: 'symlink in run dir' });
    else if (st.isDirectory()) yield* files(p, hits);
    else if (st.isFile() && !BINARY.has(extname(p).toLowerCase())) yield p;
  }
}
export function scanDir(dir: string, imapPassword: string): Hit[] {
  const hits: Hit[] = [];
  const pwForms = imapPassword ? [imapPassword, JSON.stringify(imapPassword).slice(1, -1)] : [];
  for (const f of files(dir, hits)) {
    const body = readFileSync(f, 'utf8');
    for (const [rule, re] of SCAN_RULES) if (re.test(body)) hits.push({ file: f, rule });
    if (pwForms.some((pw) => body.includes(pw))) hits.push({ file: f, rule: 'imap password' });
  }
  return hits;
}
export function scanAndPurge(dir: string, imapPassword: string): void {
  const hits = scanDir(dir, imapPassword);
  if (!hits.length) return;
  for (const f of new Set(hits.map((h) => h.file))) {
    // symlinks: remove only the link itself, never anything it points to
    if (lstatSync(f).isSymbolicLink()) unlinkSync(f);
    else rmSync(f, { force: true });
  }
  throw new Error(`scan failed — deleted:\n${hits.map((h) => `  ${h.file} (${h.rule})`).join('\n')}`);
}
