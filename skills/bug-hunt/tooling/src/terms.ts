// Generic built-ins only. Add your app's own sensitive field names to TERMS below: scan and redaction share this one list.
// ONE term list shared by scan.ts (flags) and redact.ts (neutralises): whatever scan flags, redaction removes.
export interface Term {
  rule: string;
  /** regex source (non-capturing groups only) for the bare name, used for scan and for redaction */
  name: string;
  /** extra source appended for the scan match only (e.g. the `:` after a "pin" key) */
  scanSuffix?: string;
  /** wider name source used when redacting (e.g. cookie prefixes) */
  redactName?: string;
  replacement: string;
  /** whether `name<sep>value` pairs are removed as a unit */
  kv: boolean;
}

export const TERMS: Term[] = [
  { rule: 'pin', name: '\\\\?"pin\\\\?"', scanSuffix: '\\s*:', replacement: '[redacted-term]', kv: true },
  { rule: 'authorization', name: 'authorization', replacement: '[redacted-header]', kv: true },
  { rule: 'auth cookie', name: '(?:authjs|next-auth)\\.', redactName: '(?:__Secure-|__Host-)?(?:authjs|next-auth)\\.[\\w.-]*', replacement: '[redacted-cookie]', kv: true },
  { rule: 'signature', name: '\\w*signature', replacement: '[redacted-term]', kv: true },
  { rule: 'secret key', name: '\\b(?:app_password|password|IMAP_\\w+)\\b', replacement: '[redacted-term]', kv: true },
];
export const JWT_SOURCE = '\\beyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+=*';
export const JWT_REPLACEMENT = '[redacted-jwt]';

export const SCAN_RULES: [string, RegExp][] = [
  ...TERMS.map((t): [string, RegExp] => [t.rule, new RegExp(t.name + (t.scanSuffix ?? ''), 'i')]),
  ['jwt', new RegExp(JWT_SOURCE)],
];
