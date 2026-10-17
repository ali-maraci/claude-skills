import { describe, expect, it } from 'vitest';
import { checkElevenLabs, checkStagingHas, checkTools, runPreflight, surfaceConfigured, type Exec } from '../src/preflight';
import type { Config } from '../src/config';

const MERGE = 'a'.repeat(40);
const DEPLOYED = 'b'.repeat(40);
const DRY = 'c'.repeat(40);

function fakeExec(map: Record<string, string | Error>): Exec & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    for (const [k, v] of Object.entries(map)) {
      if (key.includes(k)) {
        if (v instanceof Error) throw v;
        return v;
      }
    }
    throw new Error(`unexpected: ${key}`);
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const WORKFLOWS = {
  'acme/web': { workflow: 'deploy-staging.yml', hasDryRun: false },
  'acme/portal': { workflow: 'deploy-staging.yml', hasDryRun: true },
};

const run = (id: number, sha: string, branch = 'main') => ({ databaseId: id, headSha: sha, headBranch: branch, createdAt: '2026-10-01T00:00:00Z' });

describe('checkStagingHas', () => {
  it('passes when the deployed commit contains the merge commit', async () => {
    const exec = fakeExec({ 'run list': JSON.stringify([run(1, DEPLOYED)]), [`compare/${MERGE}...${DEPLOYED}`]: 'ahead\n' });
    const r = await checkStagingHas(exec, 'acme/web', MERGE, WORKFLOWS);
    expect(r.ok).toBe(true);
  });

  it('fails with the deployed branch and sha when it does not', async () => {
    const exec = fakeExec({ 'run list': JSON.stringify([run(1, DEPLOYED, 'feat/other')]), compare: 'behind\n' });
    const r = await checkStagingHas(exec, 'acme/web', MERGE, WORKFLOWS);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('feat/other@bbbbbbb');
    expect(r.detail).toContain('aaaaaaa');
  });

  it('skips dry-run deploys', async () => {
    const exec = fakeExec({
      'run list': JSON.stringify([run(2, DRY), run(1, DEPLOYED)]),
      'run view 2': 'deploy\tSend deploy command\t  DRY_RUN: true\n',
      'run view 1': 'deploy\tSend deploy command\t  DRY_RUN: false\n',
      [`compare/${MERGE}...${DEPLOYED}`]: 'identical\n',
    });
    const r = await checkStagingHas(exec, 'acme/portal', MERGE, WORKFLOWS);
    expect(r.ok).toBe(true);
    expect(exec.calls.some((c) => c.includes(`compare/${MERGE}...${DRY}`))).toBe(false);
  });

  it('fails for a repo with no known staging workflow', async () => {
    const r = await checkStagingHas(fakeExec({}), 'acme/unlisted', MERGE, WORKFLOWS);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('acme/unlisted');
  });

  it('points at staging-workflows.json when no workflows are configured', async () => {
    const r = await checkStagingHas(fakeExec({}), 'acme/web', MERGE, {});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/staging-workflows\.json/);
  });
});

describe('checkElevenLabs / checkTools', () => {
  const cfg = { elevenlabs: { apiKey: 'sk_x', baseUrl: 'https://api.elevenlabs.io', voiceId: 'v', modelId: 'm' } } as Config;

  it('reports key validity from GET /v1/user', async () => {
    const ok = await checkElevenLabs(cfg, (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    const bad = await checkElevenLabs(cfg, (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch);
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });

  it('accepts a scoped key that only lacks user_read', async () => {
    const body = JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing the permission user_read' } });
    const r = await checkElevenLabs(cfg, (async () => new Response(body, { status: 401 })) as unknown as typeof fetch);
    expect(r.ok).toBe(true);
  });

  it('reports a network failure instead of throwing', async () => {
    const r = await checkElevenLabs(cfg, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/fetch failed/);
  });

  it('fails when ffmpeg is missing', async () => {
    const r = await checkTools(fakeExec({ 'ffmpeg -version': new Error('ENOENT'), 'ffprobe -version': 'ok' }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/brew install ffmpeg/);
  });
});

describe('surfaceConfigured', () => {
  const cfg = { surfaces: { 'app-web': { baseUrl: 'https://app.test', signedInPath: '/' } } } as Config;

  it('passes for a configured surface', () => {
    expect(surfaceConfigured(cfg, 'app-web', '/cfg').ok).toBe(true);
  });

  it('names the missing variable and the env path for an unconfigured surface', () => {
    const r = surfaceConfigured(cfg, 'portal', '/cfg');
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("storyboard/--surface uses 'portal' but PORTAL_STAGING_URL is not set in /cfg/.env");
  });
});

describe('runPreflight', () => {
  it('runs every check and returns all results', async () => {
    const cfg = { elevenlabs: { apiKey: 'sk_x', baseUrl: 'https://api.elevenlabs.io', voiceId: 'v', modelId: 'm' }, surfaces: { 'app-web': { baseUrl: 'https://app.test', signedInPath: '/' } } } as Config;
    const exec = fakeExec({
      'ffmpeg -version': 'ok', 'ffprobe -version': 'ok',
      'run list': JSON.stringify([run(1, DEPLOYED)]), compare: 'ahead',
    });
    const results = await runPreflight(cfg, { merges: [{ repo: 'acme/web', sha: MERGE }], surfaces: ['app-web'] }, {
      exec,
      workflows: WORKFLOWS,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      session: async () => ({ ok: true, detail: 'signed in' }),
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it('reports a check that throws as ✗ and still reports the others', async () => {
    const cfg = { elevenlabs: { apiKey: 'sk_x', baseUrl: 'https://api.elevenlabs.io', voiceId: 'v', modelId: 'm' }, surfaces: {} } as Config;
    const exec = fakeExec({ 'ffmpeg -version': 'ok', 'ffprobe -version': 'ok', 'run list': new Error('gh: not logged in') });
    const results = await runPreflight(cfg, { merges: [{ repo: 'acme/web', sha: MERGE }], surfaces: ['portal'] }, {
      exec,
      workflows: WORKFLOWS,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      session: async () => ({ ok: true, detail: 'signed in' }),
    });
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['ffmpeg/ffprobe', true],
      ['ElevenLabs key', true],
      ['staging has acme/web@aaaaaaa', false],
      ['session portal', false],
    ]);
    expect(results[2].detail).toContain('gh: not logged in');
    expect(results[3].detail).toMatch(/PORTAL_STAGING_URL/);
  });
});
