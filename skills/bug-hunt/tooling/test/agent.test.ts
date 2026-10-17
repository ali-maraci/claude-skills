import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const md = readFileSync(join(__dirname, '../../agents/bug-hunt-verifier.md'), 'utf8');
const fm = parse(md.split('---')[1]);

describe('bug-hunt-verifier agent', () => {
  const tools: string[] = fm.tools.split(',').map((t: string) => t.trim());
  it('allowlists no file or script tools', () => {
    for (const bad of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      expect(tools).not.toContain(bad);
    }
    expect(tools.some((t) => /browser_(evaluate|run_code_unsafe)/.test(t))).toBe(false);
  });
  it('allowlists no tool that reads request bodies or drops data', () => {
    // browser_network_request (singular) returns headers and bodies; the orchestrator collects network itself
    expect(tools.some((t) => /browser_network_requests?$/.test(t))).toBe(false);
    expect(tools.some((t) => /browser_drop$/.test(t))).toBe(false);
  });
  it('allowlists exactly Bash and the 15 human-like browser tools', () => {
    const allowed = ['navigate', 'navigate_back', 'click', 'type', 'fill_form', 'select_option', 'hover', 'press_key',
      'file_upload', 'snapshot', 'take_screenshot', 'console_messages', 'tabs', 'wait_for', 'handle_dialog']
      .map((t) => `mcp__bug-hunt-browser__browser_${t}`);
    for (const t of tools) expect(['Bash', ...allowed]).toContain(t);
    expect(new Set(tools).size).toBe(tools.length);
  });
  it('tells the verifier never to name files', () => {
    expect(md).toMatch(/never pass `filename`/i);
  });
  it('only uses the dedicated browser server', () => {
    expect(tools.filter((t) => t.startsWith('mcp__')).every((t) => t.startsWith('mcp__bug-hunt-browser__'))).toBe(true);
  });
  it('declares the guard as a PreToolUse hook on every tool', () => {
    const h = fm.hooks.PreToolUse[0];
    expect(h.matcher).toBe('.*');
    expect(h.hooks[0].command).toMatch(/bug-hunt\/hooks\/verifier-guard\.sh$/);
  });
});
