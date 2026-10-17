import { runTool } from './exec';
import { CONFIG_DIR, loadStagingWorkflows, requireSurface, surfaceMissingDetail, type Config, type StagingWorkflows } from './config';
import { join } from 'node:path';
import type { Surface } from './storyboard';
import { isSignedIn, withStagingContext } from './browser/session';

export interface Check {
  ok: boolean;
  detail: string;
}

export interface CheckResult extends Check {
  name: string;
}

const short = (sha: string) => sha.slice(0, 7);

export type Exec = (cmd: string, args: string[]) => Promise<string>;

interface Run {
  databaseId: number;
  headSha: string;
  headBranch: string;
  createdAt: string;
}

async function latestRealDeploy(exec: Exec, repo: string, wf: StagingWorkflows[string]): Promise<Run | undefined> {
  const runs = JSON.parse(
    await exec('gh', ['run', 'list', '-R', repo, '--workflow', wf.workflow, '--status', 'success', '-L', '10', '--json', 'databaseId,headSha,headBranch,createdAt']),
  ) as Run[];
  for (const run of runs) {
    if (!wf.hasDryRun) return run;
    const log = await exec('gh', ['run', 'view', String(run.databaseId), '-R', repo, '--log']);
    if (!/DRY_RUN:\s*true/.test(log)) return run;
  }
  return undefined;
}

export async function checkStagingHas(exec: Exec, repo: string, mergeSha: string, workflows: StagingWorkflows): Promise<Check> {
  const file = join(CONFIG_DIR, 'staging-workflows.json');
  const wf = workflows[repo];
  if (!wf) return { ok: false, detail: `no staging deploy workflow known for ${repo} — add it to ${file}` };
  const run = await latestRealDeploy(exec, repo, wf);
  if (!run) return { ok: false, detail: `no successful non-dry-run ${wf.workflow} run in the last 10` };
  const status = (await exec('gh', ['api', `repos/${repo}/compare/${mergeSha}...${run.headSha}`, '--jq', '.status'])).trim();
  const ok = status === 'identical' || status === 'ahead';
  return {
    ok,
    detail: ok
      ? `deployed ${run.headBranch}@${short(run.headSha)} (${run.createdAt}) contains it`
      : `staging is on ${run.headBranch}@${short(run.headSha)} (deployed ${run.createdAt}), which does not contain ${short(mergeSha)} — deploy it with ${wf.workflow} first`,
  };
}

export async function checkElevenLabs(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const base = cfg.elevenlabs.baseUrl;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/user`, { headers: { 'xi-api-key': cfg.elevenlabs.apiKey } });
  } catch (e) {
    return { ok: false, detail: `could not reach ${base}: ${(e as Error).message}` };
  }
  if (res.ok) return { ok: true, detail: `valid on ${base}` };
  // A scoped key (e.g. text-to-speech only) is authenticated but refused user_read; that is still usable.
  const body = (await res.json().catch(() => ({}))) as { detail?: { status?: string } };
  if (body.detail?.status === 'missing_permissions') return { ok: true, detail: `valid (scoped key) on ${base}` };
  return { ok: false, detail: `HTTP ${res.status} from ${base} — replace ELEVENLABS_API_KEY in ~/.config/feature-showcase/.env` };
}

export async function checkTools(exec: Exec): Promise<Check> {
  const missing: string[] = [];
  for (const t of ['ffmpeg', 'ffprobe']) await exec(t, ['-version']).catch(() => missing.push(t));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing ${missing.join(', ')} — brew install ffmpeg` : 'present',
  };
}

export async function checkSession(cfg: Config, surface: Surface): Promise<Check> {
  const { baseUrl, signedInPath } = requireSurface(cfg, surface);
  const ok = await withStagingContext(cfg, [surface], (ctx) => isSignedIn(ctx, baseUrl + signedInPath));
  return { ok, detail: ok ? 'signed in' : `expired — run: feature-showcase auth ${surface}` };
}

export function surfaceConfigured(cfg: Pick<Config, 'surfaces'>, surface: Surface, configDir = CONFIG_DIR): Check {
  return cfg.surfaces[surface]
    ? { ok: true, detail: 'configured' }
    : { ok: false, detail: surfaceMissingDetail(surface, configDir) };
}

async function named(name: string, run: () => Promise<Check>): Promise<CheckResult> {
  return { name, ...(await run().catch((e: Error) => ({ ok: false, detail: e.message }))) };
}

// Every check runs, in parallel; one that throws is reported as ✗ rather than hiding the others.
export async function runPreflight(
  cfg: Config,
  input: { merges: { repo: string; sha: string }[]; surfaces: Surface[] },
  deps: { exec?: Exec; fetchImpl?: typeof fetch; session?: typeof checkSession; workflows?: StagingWorkflows } = {},
): Promise<CheckResult[]> {
  const exec = deps.exec ?? ((cmd, args) => runTool(cmd, args));
  const session = deps.session ?? checkSession;
  return Promise.all([
    named('ffmpeg/ffprobe', () => checkTools(exec)),
    named('ElevenLabs key', () => checkElevenLabs(cfg, deps.fetchImpl)),
    ...input.merges.map((m) => named(`staging has ${m.repo}@${short(m.sha)}`, async () => checkStagingHas(exec, m.repo, m.sha, deps.workflows ?? loadStagingWorkflows()))),
    ...input.surfaces.map((s) => named(`session ${s}`, async () => {
      const c = surfaceConfigured(cfg, s);
      return c.ok ? session(cfg, s) : c;
    })),
  ]);
}
