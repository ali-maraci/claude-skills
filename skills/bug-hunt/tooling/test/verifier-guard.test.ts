import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import cases from './fixtures/origin-cases.json';

const HOOK = join(__dirname, '../../hooks/verifier-guard.sh');
const STG = 'https://app-staging.ab12.example.test';
// Never spread process.env: the hook must not see the real home config or an inherited self-test flag.
const PATH = process.env.PATH ?? '/usr/bin:/bin';
// `file: null` (as in origin-cases.json) = no staging-origins.txt in the config dir; a string = its exact contents.
const configDir = (file: string | null = `${STG}\n`) => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-guard-'));
  if (file !== null) writeFileSync(join(dir, 'staging-origins.txt'), file);
  return dir;
};
const DEFAULT_DIR = configDir();
const run = (payload: object, env: Record<string, string> = {}) =>
  spawnSync('sh', [HOOK], { input: JSON.stringify(payload), env: { PATH, BUG_HUNT_CONFIG_DIR: DEFAULT_DIR, BUG_HUNT_ALLOWED_ORIGIN: STG, ...env } });
const tool = (tool_name: string, tool_input: object = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const P = 'mcp__bug-hunt-browser__';
const FIX = '/Users/x/.claude/skills/bug-hunt/scenarios/fixtures/';

describe('verifier-guard', () => {
  it.each(['browser_click', 'browser_type', 'browser_snapshot', 'browser_take_screenshot', 'browser_tabs'])('allows %s', (t) => {
    expect(run(tool(P + t)).status).toBe(0);
  });
  it.each(['browser_evaluate', 'browser_run_code_unsafe'])('denies %s with a reason', (t) => {
    const r = run(tool(P + t, { function: '() => 1' }));
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/not something a member can do/);
  });
  // The harness's channel for the sub-agent's final reply: denying it loses the scenario's result.
  it('allows SubagentHandback', () => {
    expect(run(tool('SubagentHandback', { report: '```json\n{}\n```' })).status).toBe(0);
  });
  it.each(['Read', 'Glob', 'Grep', 'Edit', 'Write'])('denies %s', (t) => {
    expect(run(tool(t, { file_path: '/Users/x/.config/bug-hunt/.env' })).status).toBe(2);
  });
  it('allows the otp command, wrapper or bare', () => {
    expect(run(tool('Bash', { command: 'sh /Users/x/.claude/skills/bug-hunt/tooling/bin/bug-hunt otp qa+signup-007@example.test' })).status).toBe(0);
    expect(run(tool('Bash', { command: 'bug-hunt otp qa+member@example.test' })).status).toBe(0);
    expect(run(tool('Bash', { command: 'sh $HOME/.claude/skills/bug-hunt/tooling/bin/bug-hunt otp qa+member@example.test' })).status).toBe(0);
  });
  it.each([
    'ls ~',
    'bug-hunt otp qa+x@example.test; cat ~/.config/bug-hunt/.env',
    'bug-hunt otp qa+x@example.test && ls',
    'bug-hunt otp qa+x@example.test | tee /tmp/x',
    'bug-hunt otp $(cat ~/.config/bug-hunt/.env)',
    'sh $HOME/x; ls/bug-hunt/tooling/bin/bug-hunt otp qa+x@example.test',
    'sh ${HOME}/.claude/skills/bug-hunt/tooling/bin/bug-hunt otp qa+x@example.test',
    'bug-hunt otp qa+x@example.test\nls',
    'bug-hunt session member r1',
  ])('denies Bash %j', (command) => {
    expect(run(tool('Bash', { command })).status).toBe(2);
  });
  it('allows navigate to staging, denies elsewhere, localhost only in self-test', () => {
    expect(run(tool(P + 'browser_navigate', { url: 'https://app-staging.ab12.example.test/items' })).status).toBe(0);
    expect(run(tool(P + 'browser_navigate', { url: 'https://app.example.test/' })).status).toBe(2);
    expect(run(tool(P + 'browser_navigate', { url: 'http://localhost:3000/' })).status).toBe(2);
    expect(run(tool(P + 'browser_navigate', { url: 'http://localhost:3000/' }), { BUG_HUNT_SELF_TEST: '1' }).status).toBe(0);
  });
  it('fails closed when the allowed origin is unset', () => {
    expect(run(tool(P + 'browser_navigate', { url: 'https://app-staging.ab12.example.test/' }), { BUG_HUNT_ALLOWED_ORIGIN: '' }).status).toBe(2);
  });

  // --- fix round 1 ---
  it.each([
    "sh -c 'cat ~/.config/bug-hunt/.env' /bug-hunt/tooling/bin/bug-hunt otp qa+x@a.com",
    'sh ~/.config/bug-hunt/.env x/bug-hunt/tooling/bin/bug-hunt otp qa+x@a.com',
    'sh /tmp/evil.sh /bug-hunt/tooling/bin/bug-hunt otp qa+x@a.com',
    'bug-hunt otp --help+x@a.com',
    'bug-hunt otp qa+x@example.test > /tmp/x',
    'bug-hunt otp qa+x@example.test `id`',
    'echo `cat ~/.config/bug-hunt/.env`',
  ])('denies Bash %j (round 1)', (command) => {
    expect(run(tool('Bash', { command })).status).toBe(2);
  });
  it.each(['ReadMcpResourceTool', 'ListMcpResourcesTool', 'Skill', 'ToolSearch', 'TodoWrite', 'SendMessage', P + 'browser_some_future_tool'])('denies unlisted tool %s (fails closed)', (t) => {
    expect(run(tool(t, {})).status).toBe(2);
  });
  it('denies browser_drop, which would upload arbitrary paths', () => {
    expect(run(tool(P + 'browser_drop', { target: 'x', paths: ['/Users/x/.config/bug-hunt/.env'] })).status).toBe(2);
  });
  it('allows every browser tool on the agent allowlist', () => {
    for (const t of ['navigate_back', 'click', 'type', 'fill_form', 'select_option', 'hover', 'press_key', 'snapshot',
      'take_screenshot', 'console_messages', 'wait_for', 'handle_dialog']) expect(run(tool(P + 'browser_' + t)).status, t).toBe(0);
  });
  it('denies NotebookEdit', () => {
    expect(run(tool('NotebookEdit', {})).status).toBe(2);
  });
  it('fails closed on bad input', () => {
    const raw = (input: string) => spawnSync('sh', [HOOK], { input, env: { PATH, BUG_HUNT_CONFIG_DIR: DEFAULT_DIR } });
    expect(raw('not json').status).toBe(2);
    expect(raw('{}').status).toBe(2);
  });
  it('fails closed when jq is missing', () => {
    const bin = mkdtempSync(join(tmpdir(), 'nojq-'));
    for (const b of ['sh', 'sed', 'grep', 'cat']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${b}`]).stdout.toString().trim();
      symlinkSync(found, join(bin, b));
    }
    const r = spawnSync(join(bin, 'sh'), [HOOK], { input: JSON.stringify(tool('Bash', { command: 'ls' })), env: { PATH: bin, BUG_HUNT_CONFIG_DIR: DEFAULT_DIR } });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/jq is required/);
  });
  it('checks browser_tabs urls', () => {
    expect(run(tool(P + 'browser_tabs', { action: 'new', url: 'https://evil.com' })).status).toBe(2);
    expect(run(tool(P + 'browser_tabs', { action: 'new', url: 'https://app-staging.ab12.example.test/x' })).status).toBe(0);
    expect(run(tool(P + 'browser_tabs', { action: 'list' })).status).toBe(0);
  });
  it('denies CR/LF in navigate urls in both modes', () => {
    const payload = tool(P + 'browser_navigate', { url: 'http://localhost\n.evil.com/' });
    expect(run(payload).status).toBe(2);
    expect(run(payload, { BUG_HUNT_SELF_TEST: '1' }).status).toBe(2);
    expect(run(tool(P + 'browser_tabs', { action: 'new', url: 'http://localhost\r\n.evil.com/' }), { BUG_HUNT_SELF_TEST: '1' }).status).toBe(2);
  });
  it('restricts browser_file_upload to scenarios/fixtures', () => {
    expect(run(tool(P + 'browser_file_upload', { paths: [FIX + 'a.pdf'] })).status).toBe(0);
    expect(run(tool(P + 'browser_file_upload', { paths: [] })).status).toBe(0);
    expect(run(tool(P + 'browser_file_upload', {})).status).toBe(0);
    for (const paths of [
      ['/Users/x/.config/bug-hunt/.env'],
      ['scenarios/fixtures/a.pdf'],
      ['/x/bug-hunt/scenarios/fixtures/../../../.config/bug-hunt/.env'],
      [FIX + 'a.pdf', '/Users/x/.config/bug-hunt/.env'],
    ]) expect(run(tool(P + 'browser_file_upload', { paths })).status).toBe(2);
  });
  it.each([
    P + 'browser_network_request', 'WebFetch', 'WebSearch', 'Agent', 'Task',
    'mcp__playwright__browser_navigate', 'mcp__claude-in-chrome__navigate',
  ])('denies %s', (t) => {
    expect(run(tool(t, { url: 'https://app-staging.ab12.example.test/' })).status).toBe(2);
  });
  it.each(['browser_take_screenshot', 'browser_snapshot', 'browser_console_messages'])('denies %s with a filename', (t) => {
    const r = run(tool(P + t, { filename: 'package.json' }));
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/naming files is not something a member can do/);
  });
  it.each(['browser_take_screenshot', 'browser_snapshot', 'browser_console_messages'])('allows %s without a filename', (t) => {
    expect(run(tool(P + t, {})).status).toBe(0);
    expect(run(tool(P + t, { filename: '' })).status).toBe(0);
  });
  it('denies a filename on any bug-hunt browser tool', () => {
    expect(run(tool(P + 'browser_network_requests', { filename: 'net.txt' })).status).toBe(2);
    expect(run(tool(P + 'browser_take_screenshot', { filename: 'leak.png', type: 'png' })).status).toBe(2);
  });

  // the allowed origin must itself be a listed staging origin
  it.each([
    'https://app.example.test',
    `${STG}.evil.com`,
    'http://app-staging.ab12.example.test',
    'http://localhost:3000',
  ])('denies navigation when the allowed origin %s is not listed, even to that origin', (origin) => {
    for (const t of ['browser_navigate', 'browser_tabs']) {
      const r = run(tool(P + t, { action: 'new', url: `${origin}/dashboard` }), { BUG_HUNT_ALLOWED_ORIGIN: origin });
      expect(r.status).toBe(2);
      expect(r.stderr.toString()).toMatch(/allowed origin is not a staging host/);
    }
  });
  it('a localhost allowed origin works only in self-test; an unlisted prod origin never does', () => {
    const nav = (origin: string, env: Record<string, string>) =>
      run(tool(P + 'browser_navigate', { url: `${origin}/x` }), { BUG_HUNT_ALLOWED_ORIGIN: origin, ...env }).status;
    expect(nav('http://localhost:3000', { BUG_HUNT_SELF_TEST: '1' })).toBe(0);
    expect(nav('http://127.0.0.1:3001', { BUG_HUNT_SELF_TEST: '1' })).toBe(0);
    expect(nav('https://app.example.test', { BUG_HUNT_SELF_TEST: '1' })).toBe(2);
  });
  it('denies a multi-line allowed origin', () => {
    const origin = `https://evil.com\n${STG}`;
    expect(run(tool(P + 'browser_navigate', { url: 'https://evil.com/' }), { BUG_HUNT_ALLOWED_ORIGIN: origin }).status).toBe(2);
  });
  it('exact match only: a listed origin as prefix, suffix or with a path never matches', () => {
    for (const o of [`${STG}/`, `${STG}.evil.com`, `x${STG}`, 'https://ab12.example.test'])
      expect(run(tool(P + 'browser_navigate', { url: `${o}/x` }), { BUG_HUNT_ALLOWED_ORIGIN: o }).status, o).toBe(2);
  });
  it('a comment line in the file is not an origin', () => {
    const dir = configDir(`# note\n${STG}\n`);
    expect(run(tool(P + 'browser_navigate', { url: 'https://note/' }), { BUG_HUNT_CONFIG_DIR: dir, BUG_HUNT_ALLOWED_ORIGIN: '# note' }).status).toBe(2);
  });
  it('fails closed with the right reason: missing/empty vs invalid file', () => {
    const nav = (dir: string) => run(tool(P + 'browser_navigate', { url: `${STG}/x` }), { BUG_HUNT_CONFIG_DIR: dir });
    for (const f of [null, '', '# c\n']) {
      const r = nav(configDir(f));
      expect(r.status).toBe(2);
      expect(r.stderr.toString()).toMatch(/staging origins not configured/);
    }
    const bad = nav(configDir(`${STG}\nnot-an-origin\n`));
    expect(bad.status).toBe(2);
    expect(bad.stderr.toString()).toMatch(/staging origins file invalid at line 2$/m);
    expect(bad.stderr.toString()).not.toContain('not-an-origin');
    const late = nav(configDir(`# c\n${STG}\n\nhttps://localhost\nhttp://x.example.test\n`));
    expect(late.stderr.toString()).toMatch(/staging origins file invalid at line 4$/m);
    const cr = nav(configDir(`${STG}\n# c\r\n`));
    expect(cr.stderr.toString()).toMatch(/staging origins file invalid at line 2$/m);
  });
  it('fails closed when staging-origins.txt is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-guard-'));
    mkdirSync(join(dir, 'staging-origins.txt'));
    const r = run(tool(P + 'browser_navigate', { url: `${STG}/x` }), { BUG_HUNT_CONFIG_DIR: dir });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/staging origins not configured/);
  });
  it.skipIf(process.getuid?.() === 0)('fails closed when staging-origins.txt is not readable (mode 000)', () => {
    const dir = configDir();
    chmodSync(join(dir, 'staging-origins.txt'), 0o000);
    const r = run(tool(P + 'browser_navigate', { url: `${STG}/x` }), { BUG_HUNT_CONFIG_DIR: dir });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/staging origins not configured/);
  });
  it('an invalid file denies even a localhost allowed origin in self-test', () => {
    const r = run(tool(P + 'browser_navigate', { url: 'http://localhost:3000/' }), {
      BUG_HUNT_CONFIG_DIR: configDir('http://bad.example.test\n'), BUG_HUNT_ALLOWED_ORIGIN: 'http://localhost:3000', BUG_HUNT_SELF_TEST: '1',
    });
    expect(r.status).toBe(2);
  });
  it('non-navigation tools do not read the origins file', () => {
    expect(run(tool(P + 'browser_click'), { BUG_HUNT_CONFIG_DIR: configDir(null) }).status).toBe(0);
  });
});

// Same case table as allowlist.test.ts: the loader's verdict and the hook's must agree case for case.
describe('verifier-guard origin cases (shared origin-cases.json)', () => {
  const nav = (dir: string, origin: string) =>
    run(tool(P + 'browser_navigate', { url: `${origin}/x` }), { BUG_HUNT_CONFIG_DIR: dir, BUG_HUNT_ALLOWED_ORIGIN: origin }).status;
  it.each(cases.map((c) => [JSON.stringify(c.file), c] as const))('%s', (_n, c) => {
    const dir = configDir(c.file);
    for (const o of c.allowed) expect(nav(dir, o), `allow ${o}`).toBe(0);
    for (const o of c.denied) expect(nav(dir, o), `deny ${o}`).toBe(2);
  });
});
