import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStagingWorkflows, parseConfig } from '../src/config';

const base = {
  ELEVENLABS_API_KEY: 'sk_test_123',
  ELEVENLABS_BASE_URL: 'https://api.elevenlabs.io',
  ELEVENLABS_VOICE_ID: 'voice1',
  APP_WEB_STAGING_URL: 'https://staging.example.test/',
  PORTAL_STAGING_URL: 'https://portal.example.test/admin',
  SHOWCASE_OUTPUT_DIR: '~/showcases',
  APP_WEB_SIGNED_IN_PATH: '/',
  PORTAL_SIGNED_IN_PATH: '/dashboard',
};

describe('parseConfig', () => {
  it('normalises URLs, applies defaults and expands ~', () => {
    const c = parseConfig({ ...base, ELEVENLABS_MODEL_ID: '' }, '/cfg');
    expect(c.surfaces['app-web']!.baseUrl).toBe('https://staging.example.test');
    expect(c.surfaces.portal!.baseUrl).toBe('https://portal.example.test/admin');
    expect(c.surfaces['app-web']!.signedInPath).toBe('/');
    expect(c.surfaces.portal!.signedInPath).toBe('/dashboard');
    expect(c.elevenlabs.modelId).toBe('eleven_multilingual_v2');
    expect(c.outputDir).toBe(`${homedir()}/showcases`);
    expect(c.stateDir).toBe('/cfg/state');
  });

  it('accepts any ElevenLabs endpoint URL, EU included', () => {
    const c = parseConfig({ ...base, ELEVENLABS_BASE_URL: 'https://api.eu.residency.elevenlabs.io/' }, '/cfg');
    expect(c.elevenlabs.baseUrl).toBe('https://api.eu.residency.elevenlabs.io');
  });

  it('treats the portal surface as optional and brand as optional', () => {
    const { PORTAL_STAGING_URL: _u, PORTAL_SIGNED_IN_PATH: _p, ...rest } = base;
    const c = parseConfig(rest, '/cfg');
    expect(c.surfaces.portal).toBeUndefined();
    expect(c.surfaces['app-web']!.baseUrl).toBe('https://staging.example.test');
    expect(c.brand).toBeUndefined();
    expect(parseConfig({ ...rest, SHOWCASE_BRAND: 'Example App' }, '/cfg').brand).toBe('Example App');
  });

  it('rejects a portal URL without its signed-in path, and the reverse', () => {
    const { PORTAL_SIGNED_IN_PATH: _p, ...onlyUrl } = base;
    expect(() => parseConfig(onlyUrl, '/cfg')).toThrow(/PORTAL_SIGNED_IN_PATH/);
    const { PORTAL_STAGING_URL: _u, ...onlyPath } = base;
    expect(() => parseConfig(onlyPath, '/cfg')).toThrow(/PORTAL_STAGING_URL/);
  });

  it('names bad variables without echoing their values', () => {
    let msg = '';
    try {
      parseConfig({ ...base, ELEVENLABS_API_KEY: 'not-a-key-SECRETVALUE', APP_WEB_STAGING_URL: '' }, '/cfg');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/ELEVENLABS_API_KEY/);
    expect(msg).toMatch(/APP_WEB_STAGING_URL/);
    expect(msg).not.toContain('SECRETVALUE');
  });

  it('requires an explicit signed-in path per surface (a public / would save a signed-out session)', () => {
    const { APP_WEB_SIGNED_IN_PATH: _a, ...rest } = base;
    expect(() => parseConfig(rest, '/cfg')).toThrow(/APP_WEB_SIGNED_IN_PATH/);
  });
});

describe('loadStagingWorkflows', () => {
  const dirWith = (content?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-cfg-'));
    mkdirSync(dir, { recursive: true });
    if (content !== undefined) writeFileSync(join(dir, 'staging-workflows.json'), content);
    return dir;
  };

  it('returns {} when the file is missing', () => {
    expect(loadStagingWorkflows(dirWith())).toEqual({});
  });

  it('reads repo -> { workflow, hasDryRun }', () => {
    const wf = { 'acme/web': { workflow: 'deploy-staging.yml', hasDryRun: false } };
    expect(loadStagingWorkflows(dirWith(JSON.stringify(wf)))).toEqual(wf);
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a non-object', '[]'],
    ['a missing workflow', '{"acme/web":{"hasDryRun":false}}'],
    ['a non-boolean hasDryRun', '{"acme/web":{"workflow":"d.yml","hasDryRun":"no"}}'],
  ])('throws naming the file for %s', (_n, content) => {
    expect(() => loadStagingWorkflows(dirWith(content))).toThrow(/staging-workflows\.json/);
  });
});
