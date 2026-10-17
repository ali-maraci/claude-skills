import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import type { Surface } from './storyboard';

export const CONFIG_DIR = process.env.FEATURE_SHOWCASE_CONFIG_DIR ?? join(homedir(), '.config', 'feature-showcase');

export interface Config {
  elevenlabs: { apiKey: string; baseUrl: string; voiceId: string; modelId: string };
  surfaces: Partial<Record<Surface, { baseUrl: string; signedInPath: string }>>;
  brand?: string;
  outputDir: string;
  stateDir: string;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const optional = (fallback: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).default(fallback));

const optionalUnset = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const EnvSchema = z.object({
  ELEVENLABS_API_KEY: z.string().startsWith('sk_'),
  ELEVENLABS_BASE_URL: z.string().url(),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL_ID: optional('eleven_multilingual_v2'),
  APP_WEB_STAGING_URL: z.string().url(),
  // Required: a page that redirects to login when signed out (a public / would pass while signed out).
  APP_WEB_SIGNED_IN_PATH: z.string().startsWith('/'),
  // The portal surface is optional; its URL and signed-in path come as a pair.
  PORTAL_STAGING_URL: optionalUnset(z.string().url()),
  PORTAL_SIGNED_IN_PATH: optionalUnset(z.string().startsWith('/')),
  SHOWCASE_BRAND: optionalUnset(z.string().min(1)),
  SHOWCASE_OUTPUT_DIR: z.string().min(1),
}).superRefine((e, ctx) => {
  if (e.PORTAL_STAGING_URL && !e.PORTAL_SIGNED_IN_PATH) {
    ctx.addIssue({ code: 'custom', path: ['PORTAL_SIGNED_IN_PATH'], message: 'required when PORTAL_STAGING_URL is set' });
  }
  if (e.PORTAL_SIGNED_IN_PATH && !e.PORTAL_STAGING_URL) {
    ctx.addIssue({ code: 'custom', path: ['PORTAL_STAGING_URL'], message: 'required when PORTAL_SIGNED_IN_PATH is set' });
  }
});

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function parseConfig(env: Record<string, string | undefined>, configDir = CONFIG_DIR): Config {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    // Only path + message — Zod messages never include the offending value.
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid ${join(configDir, '.env')}:\n${lines.join('\n')}`);
  }
  const e = r.data;
  return {
    elevenlabs: {
      apiKey: e.ELEVENLABS_API_KEY,
      baseUrl: trimSlash(e.ELEVENLABS_BASE_URL),
      voiceId: e.ELEVENLABS_VOICE_ID,
      modelId: e.ELEVENLABS_MODEL_ID,
    },
    surfaces: {
      'app-web': { baseUrl: trimSlash(e.APP_WEB_STAGING_URL), signedInPath: e.APP_WEB_SIGNED_IN_PATH },
      ...(e.PORTAL_STAGING_URL && e.PORTAL_SIGNED_IN_PATH
        ? { portal: { baseUrl: trimSlash(e.PORTAL_STAGING_URL), signedInPath: e.PORTAL_SIGNED_IN_PATH } }
        : {}),
    },
    brand: e.SHOWCASE_BRAND,
    outputDir: expandHome(e.SHOWCASE_OUTPUT_DIR),
    stateDir: join(configDir, 'state'),
  };
}

export function loadConfig(configDir = CONFIG_DIR): Config {
  const p = join(configDir, '.env');
  if (!existsSync(p)) throw new Error(`missing ${p} — see skills/feature-showcase/SKILL.md "Assumes"`);
  return parseConfig(parseEnv(readFileSync(p, 'utf8')), configDir);
}

export function statePath(cfg: Config, s: Surface): string {
  return join(cfg.stateDir, `${s}.json`);
}

export type StagingWorkflows = Record<string, { workflow: string; hasDryRun: boolean }>;

export const SURFACE_ENV_VAR: Record<Surface, string> = {
  'app-web': 'APP_WEB_STAGING_URL',
  portal: 'PORTAL_STAGING_URL',
};

export function surfaceMissingDetail(surface: Surface, configDir = CONFIG_DIR): string {
  return `storyboard/--surface uses '${surface}' but ${SURFACE_ENV_VAR[surface]} is not set in ${join(configDir, '.env')}`;
}

// The configured surface, or an error naming the missing variable and the env file.
export function requireSurface(cfg: Pick<Config, 'surfaces'>, surface: Surface, configDir = CONFIG_DIR) {
  const s = cfg.surfaces[surface];
  if (!s) throw new Error(surfaceMissingDetail(surface, configDir));
  return s;
}

// repo -> staging deploy workflow, from <configDir>/staging-workflows.json. Missing file -> {}.
export function loadStagingWorkflows(configDir = CONFIG_DIR): StagingWorkflows {
  const p = join(configDir, 'staging-workflows.json');
  if (!existsSync(p)) return {};
  const bad = (why: string) => new Error(`invalid ${p}: ${why}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw bad(`not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('expected an object keyed by "owner/repo"');
  for (const [repo, v] of Object.entries(raw)) {
    const w = v as { workflow?: unknown; hasDryRun?: unknown } | null;
    if (typeof w?.workflow !== 'string' || w.workflow === '' || typeof w.hasDryRun !== 'boolean') {
      throw bad(`"${repo}" must be { "workflow": string, "hasDryRun": boolean }`);
    }
  }
  return raw as StagingWorkflows;
}
