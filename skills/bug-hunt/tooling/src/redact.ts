import { JWT_REPLACEMENT, JWT_SOURCE, TERMS } from './terms';

const TEXT_URL = /(?:https?|wss?):\/\/[^\s"'<>)]+/g;
const HEADER_LINE = /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\n]+/gi;
const BEARER = /\bBearer\s+[^\s"'\\,;}]+/gi;
// key (optionally quoted/escaped) + separator (: = %3D) + value (quoted in any style, or the next token)
const SEP = String.raw`(?:\\?["'])?\s*(?::|=|%3[dD])\s*`;
const VALUE = String.raw`(?:\\?(["'])[^\n]*?\\?\1|\\?["'][^\n"']*|[^\s,&"'}\;]+)`;

const kvRules = TERMS.filter((t) => t.kv).map((t) => ({
  kv: new RegExp(String.raw`(?:\\?["'])?(?:${t.redactName ?? t.name})${SEP}${VALUE}`, 'gi'),
  bare: new RegExp(t.redactName ?? t.name, 'gi'),
  replacement: t.replacement,
}));

export function redactUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '[unparseable url]'; }
}
function redactUrlsInText(s: string): string {
  return s.replace(TEXT_URL, (u) => u.replace(/^([^?#]*)([?#].*?)?(:\d+)?$/, '$1$3'));
}
// Redacted output must itself pass scan.ts, and a key name is never removed while its value stays.
export function redactText(s: string): string {
  let out = redactUrlsInText(s)
    .replace(new RegExp(JWT_SOURCE, 'g'), JWT_REPLACEMENT)
    .replace(HEADER_LINE, '[redacted-header]')
    .replace(BEARER, '[redacted-header]');
  for (const r of kvRules) out = out.replace(r.kv, r.replacement);
  for (const r of kvRules) out = out.replace(r.bare, r.replacement);
  return out;
}
