import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { fetchRecent } from '../../src/otp';

// Needs the real QA mailbox + app password in ~/.config/bug-hunt/.env.
it('connects over IMAP and lists recent sign-in mail without throwing', async () => {
  const cfg = loadConfig();
  const msgs = await fetchRecent(cfg, new Date(Date.now() - 7 * 86_400_000), cfg.memberEmail);
  expect(Array.isArray(msgs)).toBe(true);
});
