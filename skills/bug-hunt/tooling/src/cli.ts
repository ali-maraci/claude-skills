import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkOtpBudget, readOtpLedger, recordOtpSend } from './budget';
import { loadConfig } from './config';
import { collect } from './collect';
import { parseVerifierOutput, setupFailed } from './findings';
import { stageArtifact } from './artifact';
import { renderHtml } from './html';
import { loadRun, renderReport } from './report';
import { waitForCode } from './otp';
import { startRun } from './newrun';
import { activateState, cleanupRun, runPaths } from './paths';
import { reserveSignup } from './pool';
import { loadScenarios } from './scenario';
import { scanAndPurge } from './scan';
import { signInMember } from './session';

export const HELP = `bug-hunt <command>
  otp <address>                      print the newest code sent to <address> in the last 10 min (waits ≤90s)
  session member <run>               sign the qa member in; save state under ~/.cache/bug-hunt/<run>/
  session reserve-signup <run>       take the next address from signup-pool.txt; print it
  session activate <run> <member|empty>  load a persona into the browser's state file
  new-run                            create a run id and its directories; print the id (refuses at 8 OTP sends/hour,
                                     an existing run dir, or a RUNS_DIR git could commit)
  collect <run> <scenario> <mode>    stdin: {console, network} from the MCP → network/<scenario>-<mode>.json
  findings <run> <scenario> <mode>   stdin: verifier output → findings/<scenario>-<mode>.json
  validate                           check every scenarios/*.md
  report <run>                       merge findings → report.md and report.html
  artifact <run> <dest>              copy report.html + the screenshots it links to <dest>/bug-hunt-<run>/;
                                     print {file_path, root, files} for the Artifact tool (after a clean scan)
  scan <run>                         fail if any artifact holds a secret; delete offenders
  cleanup <run>                      delete ~/.cache/bug-hunt/<run>/`;

function assertScenarioMode(scenario: string, mode: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(scenario)) throw new Error(`invalid scenario "${scenario}" (kebab-case only)`);
  if (mode !== 'happy' && mode !== 'fuzz') throw new Error(`invalid mode "${mode}" (happy|fuzz)`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean' }, since: { type: 'string' }, 'setup-failed': { type: 'string' } } });
  const [cmd] = positionals;
  if (!cmd || values.help) return void console.log(HELP);
  switch (cmd) {
    case 'otp': {
      const address = positionals[1];
      if (!address) throw new Error('usage: bug-hunt otp <address> [--since <iso>]');
      // The verifier can't pass --since (the guard allows only `otp <address>`) and may take minutes of
      // turns before asking, so look back over the code's 10-minute life; pickCode takes the newest.
      const since = values.since ? new Date(values.since) : new Date(Date.now() - 600_000);
      if (Number.isNaN(since.getTime())) throw new Error(`invalid --since "${values.since}"`);
      console.log(await waitForCode(loadConfig(), address, { since }));
      return;
    }
    case 'new-run': {
      const { id, warnings } = startRun(loadConfig());
      for (const w of warnings) console.error(`! ${w}`);
      console.log(id);
      return;
    }
    case 'session': {
      const [, sub, run, persona] = positionals;
      if (!sub || !run) throw new Error('usage: bug-hunt session <member|reserve-signup|activate> <run> [persona]');
      const cfg = loadConfig();
      if (sub === 'member') console.log(await signInMember(cfg, run));
      else if (sub === 'reserve-signup') {
        checkOtpBudget(readOtpLedger(cfg), new Date(), cfg.otpBudget);
        const address = reserveSignup(cfg);
        recordOtpSend(cfg, new Date(), address); // the verifier requests this address's code next
        console.log(address);
      }
      else if (sub === 'activate') {
        if (persona !== 'member' && persona !== 'empty') throw new Error('usage: bug-hunt session activate <run> <member|empty>');
        console.log(activateState(cfg, run, persona));
      } else throw new Error(`unknown session command "${sub}"`);
      return;
    }
    case 'collect': {
      const [, run, scenario, mode] = positionals;
      if (!run || !scenario || !mode) throw new Error('usage: bug-hunt collect <run> <scenario> <happy|fuzz>  (JSON {console, network} on stdin)');
      assertScenarioMode(scenario, mode);
      let input: { console?: unknown; network?: unknown };
      try { input = JSON.parse(await readStdin()); } catch { throw new Error('stdin is not valid JSON {console, network}'); }
      if (!input || typeof input !== 'object') throw new Error('stdin is not valid JSON {console, network}');
      if (typeof input.console !== 'string' || typeof input.network !== 'string') throw new Error('stdin must be JSON {console: string, network: string}');
      const out = join(runPaths(loadConfig(), run).network, `${scenario}-${mode}.json`);
      writeFileSync(out, JSON.stringify(collect({ console: input.console, network: input.network }), null, 2));
      console.log(out);
      return;
    }
    case 'findings': {
      const [, run, scenario, mode] = positionals;
      if (!run || !scenario || !mode) throw new Error('usage: bug-hunt findings <run> <scenario> <happy|fuzz> [--setup-failed "<cause>"]  (verifier output on stdin)');
      assertScenarioMode(scenario, mode);
      const paths = runPaths(loadConfig(), run);
      const cause = values['setup-failed'];
      let outcome;
      if (cause !== undefined) outcome = setupFailed(scenario, mode, cause);
      else {
        const raw = await readStdin();
        if (!raw.trim()) throw new Error('stdin is empty — pipe the verifier output in');
        outcome = parseVerifierOutput(raw, paths.screens, scenario, mode);
      }
      const out = join(paths.findings, `${scenario}-${mode}.json`);
      writeFileSync(out, JSON.stringify(outcome, null, 2));
      console.log(`${out} (${outcome.status}, ${outcome.findings.length} findings${outcome.dropped.length ? `, ${outcome.dropped.length} dropped` : ''})`);
      return;
    }
    case 'report': {
      const run = positionals[1];
      if (!run) throw new Error('usage: bug-hunt report <run>');
      const cfg = loadConfig();
      const paths = runPaths(cfg, run);
      const meta = { run, baseUrl: cfg.baseUrl, started: run };
      const { outcomes, network, skipped } = loadRun(paths);
      writeFileSync(paths.report, renderReport(meta, outcomes, network, skipped));
      writeFileSync(paths.html, renderHtml(meta, outcomes, network, skipped, (n) => existsSync(join(paths.screens, n))));
      console.log(paths.report);
      console.log(paths.html);
      return;
    }
    case 'artifact': {
      const [, run, dest] = positionals;
      if (!run || !dest) throw new Error('usage: bug-hunt artifact <run> <dest>');
      const staged = stageArtifact(runPaths(loadConfig(), run), run, dest);
      if (staged.omitted) console.error(`! ${staged.omitted} screenshots left out (Artifact publish limit)`);
      console.log(JSON.stringify({ file_path: staged.file_path, root: staged.root, files: staged.files }));
      return;
    }
    case 'validate': {
      const n = loadScenarios(fileURLToPath(new URL('../../scenarios', import.meta.url))).length;
      console.log(`✓ ${n} scenarios`);
      return;
    }
    case 'scan': {
      const run = positionals[1];
      if (!run) throw new Error('usage: bug-hunt scan <run>');
      const cfg = loadConfig();
      scanAndPurge(runPaths(cfg, run).dir, cfg.imap.password);
      console.log('✓ scan clean');
      return;
    }
    case 'cleanup': {
      const run = positionals[1];
      if (!run) throw new Error('usage: bug-hunt cleanup <run>');
      cleanupRun(loadConfig(), run);
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n${HELP}`);
  }
}
