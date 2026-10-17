import { redactText, redactUrl } from './redact';

export interface NetEntry { method: string; url: string; status: number | 'failed' }
// Real Playwright MCP lines: `12. [GET] https://… => [404] ` (index prefix, status text often empty).
const LINE = /^(?:\d+\.\s+)?\[(\w+)\]\s+(\S+)\s+=>\s+\[(\d{3}|FAILED)\]/;

export function parseNetworkList(text: string): NetEntry[] {
  return text.split('\n').flatMap((l) => {
    const m = l.trim().match(LINE);
    if (!m) return [];
    return [{ method: m[1], url: redactText(redactUrl(m[2])), status: m[3] === 'FAILED' ? ('failed' as const) : Number(m[3]) }];
  });
}
export function parseConsoleList(text: string): string[] {
  return text.split('\n').filter((l) => /^\[error\]/i.test(l.trim()));
}
export function collect(input: { console: string; network: string }): { errors: string[]; failed: NetEntry[] } {
  return {
    errors: parseConsoleList(input.console).map((l) => redactText(l.trim())),
    failed: parseNetworkList(input.network).filter((n) => n.status === 'failed' || n.status >= 400),
  };
}
