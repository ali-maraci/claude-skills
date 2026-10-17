import type { Config } from '../src/config';

// A complete, typed Config for tests; override only what the case cares about.
export function stubConfig(over: Partial<Config> = {}): Config {
  return {
    baseUrl: 'https://app-staging.ab12.example.test',
    stagingOrigins: [],
    imap: { host: 'imap.example.test', port: 993, user: 'qa@example.test', password: 'not-a-real-password' },
    mailboxBase: 'qa@example.test',
    memberEmail: 'qa+member@example.test',
    otpSubject: 'Your sign-in code',
    otpBudget: { perHour: 8, perEmail: 3 },
    signIn: {
      loginPath: '/login', emailLabel: 'Email address', submitLabel: 'Continue',
      codeLabel: 'Code', signedInPath: '/account', rateLimitedText: '',
    },
    configDir: '/nonexistent/bug-hunt-config',
    cacheRoot: '/nonexistent/bug-hunt-cache',
    runsRoot: '/nonexistent/bug-hunt-runs',
    ...over,
  };
}
