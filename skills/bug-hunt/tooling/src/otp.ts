import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from './config';

export interface MailMeta { to: string[]; date: Date; subject: string; text: string }

export function extractCode(text: string): string | null {
  return text.match(/\b(\d{6})\b/)?.[1] ?? null;
}

export function pickCode(msgs: MailMeta[], address: string, since: Date, subject: string): string | null {
  const want = address.toLowerCase();
  const hits = msgs
    .filter((m) => m.subject === subject && m.date >= since && m.to.some((t) => t.toLowerCase() === want))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  for (const m of hits) {
    const c = extractCode(m.text);
    if (c) return c;
  }
  return null;
}

type Imap = Pick<ImapFlow, 'connect' | 'getMailboxLock' | 'search' | 'fetch' | 'logout' | 'close' | 'on'>;
const imapClient = (cfg: Config): Imap => new ImapFlow({
  host: cfg.imap.host, port: cfg.imap.port, secure: true,
  auth: { user: cfg.imap.user, pass: cfg.imap.password }, logger: false,
});

// Gmail stamps INTERNALDATE at receipt; search a 1-day window then filter precisely in pickCode.
async function readInbox(client: Imap, since: Date, address: string, subject: string): Promise<MailMeta[]> {
  await client.connect();
  const out: MailMeta[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const query = { since: new Date(since.getTime() - 86_400_000), subject, to: address };
    const uids = await client.search(query, { uid: true });
    if (uids && uids.length > 0) {
      for await (const msg of client.fetch(uids, { source: true, internalDate: true }, { uid: true })) {
        const p = await simpleParser(msg.source as Buffer);
        const to = [p.to].flat().flatMap((a) => (a ? a.value.map((v) => v.address ?? '') : []));
        out.push({ to, date: new Date(msg.internalDate as Date | string), subject: p.subject ?? '', text: p.text ?? '' });
      }
    }
  } finally {
    lock.release();
  }
  return out;
}

export async function fetchRecent(cfg: Config, since: Date, address: string, makeClient: (cfg: Config) => Imap = imapClient): Promise<MailMeta[]> {
  const client = makeClient(cfg);
  // imapflow reports socket failures as async 'error' events; unlistened, they crash the process.
  let fail: (e: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  failed.catch(() => {});
  client.on('error', (e: unknown) => fail(e));
  const work = readInbox(client, since, address, cfg.otpSubject);
  work.catch(() => {}); // settled via the race below; don't let a late rejection go unhandled
  try {
    return await Promise.race([work, failed]);
  } finally {
    // a failing logout must never mask the original error (or a good result)
    try { await client.logout(); } catch { try { client.close(); } catch { /* already closed */ } }
  }
}

export async function waitForCode(
  cfg: Config, address: string,
  { since, timeoutMs = 90_000, pollMs = 4_000, fetch = fetchRecent }:
  { since: Date; timeoutMs?: number; pollMs?: number; fetch?: (cfg: Config, since: Date, address: string) => Promise<MailMeta[]> },
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = pickCode(await fetch(cfg, since, address), address, since, cfg.otpSubject);
    if (code) return code;
    if (Date.now() >= deadline) {
      throw new Error(`no code within ${Math.round(timeoutMs / 1000)}s for ${address} — the address may not be accepted by the app, the send may have been rate-limited, or the mailbox is unreachable; check the pool`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
