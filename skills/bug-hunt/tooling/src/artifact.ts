import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { SCREEN_RE } from './html';

// The Artifact tool publishes supporting files only from the working directory or Claude's scratchpad,
// so the page and the screenshots it links are copied there. Only run after `scan` is clean.
const MAX_FILES = 250; // the Artifact tool sends at most 255 files per publish

export function stageArtifact(p: { dir: string; html: string; screens: string }, run: string, destRoot: string) {
  if (!isAbsolute(destRoot)) throw new Error(`destination must be an absolute path, got "${destRoot}"`);
  const rel = relative(p.dir, destRoot);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('destination must be outside the run folder');
  if (!existsSync(p.html)) throw new Error(`no report.html for run ${run} — run \`bug-hunt report ${run}\` first`);
  const html = readFileSync(p.html, 'utf8');
  const linked = [...new Set([...html.matchAll(/src="screens\/([^"]+)"/g)].map((m) => m[1]!))]
    .filter((n) => SCREEN_RE.test(n) && existsSync(join(p.screens, n)));
  const out = join(destRoot, `bug-hunt-${run}`);
  mkdirSync(join(out, 'screens'), { recursive: true });
  const page = join(out, 'report.html');
  copyFileSync(p.html, page);
  const files: string[] = [];
  for (const n of linked.slice(0, MAX_FILES)) {
    copyFileSync(join(p.screens, n), join(out, 'screens', n));
    files.push(`screens/${n}`);
  }
  // `root` + relative `files` is the Artifact tool's publish shape: each file is served at its own path
  return { file_path: page, root: out, files, omitted: Math.max(0, linked.length - MAX_FILES) };
}
