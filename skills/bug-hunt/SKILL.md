---
name: bug-hunt
description: Use when asked to bug-hunt, explore, fuzz or click through your web app on staging to find bugs — /bug-hunt [scenarios|area] [--mode]. Staging only; not for prod, iOS or per-PR verification.
---

# Bug Hunt

An on-demand sweep of your web app on **staging**. For each scenario in `scenarios/*.md` you (the orchestrator) prepare a fresh browser session, dispatch the restricted `bug-hunt-verifier` sub-agent to pursue the scenario's goal like a real user (happy path and/or chaotic-user fuzz), then check its evidence and write a triage-ready report with screenshots: `report.md` on disk and the same report as a private claude.ai Artifact page. The user triages the report. Nothing is filed to a tracker.

`$BH` below means `sh ~/.claude/skills/bug-hunt/tooling/bin/bug-hunt`. Shell variables don't persist between calls, so write the full command and the literal run id (`<RUN>`) every time.

**Usage:** `/bug-hunt [scenario-ids|area] [--mode happy|fuzz|both]`
- No selection = every scenario. Ids are filenames without `.md`, comma or space separated. An area is one of the distinct `area:` values in the `scenarios/*.md` front-matter. An unknown id or area → stop and list the valid ones (`ls ~/.claude/skills/bug-hunt/scenarios/*.md`).
- `--mode` defaults to `both`. A scenario runs only the modes listed in its own `modes:`.

## Setup (once per machine, done by the user)

1. **Staging identities.**
   - A mailbox with plus-addressing, 2-step verification and an IMAP app password (a Google Workspace or Gmail mailbox works). Call its address `QA_MAILBOX_BASE`. The tool only reads messages with the sign-in-code subject (`OTP_SUBJECT`) sent to the exact test address.
   - In your app, create a test account as `<QA_MAILBOX_BASE>+qa-member` (for example `qa+qa-member@example.test`) and finish its registration by hand. `session member` signs it in with an email + one-time code and checks that `SIGNED_IN_PATH` opens; it does not register accounts. This is the finished member every `finished-member` scenario uses.
   - Prepare a batch of unregistered addresses `<QA_MAILBOX_BASE>+qa-signup-NNN` (`001`, `002`, …) that your staging accepts (invite them first if your app requires it), list them one per line in `~/.config/bug-hunt/signup-pool.txt`, and leave them **unregistered**. Each sign-up run burns one.
2. **Config folder.** From this skill's directory: `mkdir -p ~/.config/bug-hunt && cp -R config.example/. ~/.config/bug-hunt/ && mv ~/.config/bug-hunt/env.example ~/.config/bug-hunt/.env && chmod 600 ~/.config/bug-hunt/.env`, then edit both files.
   - **`~/.config/bug-hunt/staging-origins.txt`**: one exact origin per line (`https://staging.example.test`; scheme + host[:port], no path or trailing slash). `#` comments and blank lines are ignored. List **only hosts that never serve production data**. Comparison is exact string equality, so there is no pattern to widen. `http://`, `localhost`, IP literals, paths and trailing slashes are rejected. It **fails closed**: if the file is missing, empty or unreadable, or any one line is invalid, the tooling and the verifier's guard hook refuse every origin (they never fall back to allowing). **What is checked, exactly:** the URLs the tooling opens itself (sign-in and `SIGNED_IN_PATH`) and the URLs the verifier types into `browser_navigate` or `browser_tabs`. Links it clicks, server redirects, form posts and requests the page makes on its own are **not** checked and can reach any origin. So list only a staging that doesn't link or redirect into production: no links to a production marketing site or app ("open the app" buttons), and no production sign-in provider.
   - **`~/.config/bug-hunt/.env`** (mode 600):
     ```
     APP_WEB_STAGING_URL=https://<one of the origins listed above>
     IMAP_HOST=imap.gmail.com
     IMAP_PORT=993
     IMAP_USER=<mailbox>
     IMAP_APP_PASSWORD=<app password>
     QA_MAILBOX_BASE=<mailbox>
     RUNS_DIR=~/bug-hunt/runs
     OTP_SUBJECT=<exact subject line of your sign-in-code email>
     SIGNED_IN_PATH=<a page that redirects to login when signed out>
     ```
     `SIGNED_IN_PATH` is required and has no default, because a public `/` would pass while signed out. Optional, with defaults: `LOGIN_PATH=/login`, `EMAIL_LABEL=Email address`, `SUBMIT_LABEL=Continue`, `CODE_LABEL=Code` (if it contains `{n}` the code goes into six boxes named with `{n}`=1..6, e.g. `Digit {n}`), `RATE_LIMITED_TEXT` (the text your app shows when it throttles code requests; empty = no rate-limit retry), `OTP_BUDGET_PER_HOUR=8`, `OTP_BUDGET_PER_EMAIL=3` (keep these below your app's own send limits). `config.example/env.example` lists every key.
   - `QA_MAILBOX_BASE` has no `+tag`. `RUNS_DIR` must be a gitignored folder; `new-run` refuses one inside a git work tree that isn't ignored. `new-run` also refuses if a run with the same minute's id already exists (wait a minute), and deletes session caches left in `~/.cache/bug-hunt/<old run id>/` by runs that never reached cleanup.
   - `APP_WEB_STAGING_URL` must be listed in `staging-origins.txt`; anything else, prod included, is refused. There is deliberately no `--base-url` argument: the origin is fixed by these files plus `BUG_HUNT_ALLOWED_ORIGIN`.
3. **`~/.config/bug-hunt/signup-pool.txt`**: unregistered addresses your staging accepts, one per line; blank lines and lines starting with `#` are ignored. `session reserve-signup` takes the first address, removes it from the pool and appends it to `used.txt`, whatever the outcome.
4. **Install:** run `sh <this skill's directory>/install.sh` yourself in a terminal (auto mode refuses to register MCP servers or write `~/.claude/agents/`). It links the skill and the agent, installs the tooling, creates `~/.cache/bug-hunt/{active,mcp-out}` and registers the `bug-hunt-browser` MCP (`--isolated --headless --storage-state ~/.cache/bug-hunt/active/state.json --output-dir ~/.cache/bug-hunt/mcp-out`).
5. **Permissions outside auto mode.** Add allow rules (in `~/.claude/settings.json`) for the verifier's otp command, `Bash(sh $HOME/.claude/skills/bug-hunt/tooling/bin/bug-hunt otp:*)`, and for the orchestrator's `$BH` calls, `Bash(sh ~/.claude/skills/bug-hunt/tooling/bin/bug-hunt:*)`; otherwise every call prompts.
6. **Start Claude Code with the allowed origin exported** (the verifier's guard hook reads it, and it must be one of the origins in `staging-origins.txt`; any other value makes the hook refuse every typed navigation): `BUG_HUNT_ALLOWED_ORIGIN=<one of the listed origins> claude`. The origin has no trailing slash or path. `BUG_HUNT_SELF_TEST=1` is only for a self-test: run a local build of your app with a few bugs you planted on purpose, point the hunt at it and check the report finds them. The variable does nothing else than unlock localhost as a target: then `APP_WEB_STAGING_URL` and `BUG_HUNT_ALLOWED_ORIGIN` may be `http://localhost[:port]` or `http://127.0.0.1[:port]`. Never set it otherwise.

## Rules

- **Staging only.** Never point a run at production or any host not listed in `staging-origins.txt`. The one exception is the self-test: with `BUG_HUNT_SELF_TEST=1`, `http://localhost[:port]` or `http://127.0.0.1[:port]`, and nothing else.
- **Synthetic data only.** Only the test mailbox's plus-addresses, the scenario's synthetic details and the fixtures in `scenarios/fixtures/`.
- **Never print secrets.** Don't `cat` or Read `~/.config/bug-hunt/.env`, any state file under `~/.cache/bug-hunt/`, or cookies. The one exception is step 1's `grep` of the `APP_WEB_STAGING_URL=` and `LOGIN_PATH=` lines.
- **Never give the verifier a path to a secret**, a run id, or anything under `~/.config`, or under `~/.cache` other than the uploads folder `<FIXTURES>`. Its prompt holds only what's listed in step 2b.
- **Only the bug-hunt browser.** Use `mcp__bug-hunt-browser__*` tools, never the everyday Playwright or Chrome MCP. Never load any other session file into it, in particular a saved login of a real account. The only member is the one `session member` signs in.
- **Never file tickets.** Report to the user only.
- **The report Artifact is private and published only after `scan` is clean.** Publish it from your session scratchpad (never from a repo folder), don't share it, and don't publish anything else from the run.

## Procedure

Follow it literally.

1. **Start.**
   - Load the browser tools you need in one go: ToolSearch `select:mcp__bug-hunt-browser__browser_close,mcp__bug-hunt-browser__browser_navigate,mcp__bug-hunt-browser__browser_snapshot,mcp__bug-hunt-browser__browser_console_messages,mcp__bug-hunt-browser__browser_network_requests`. If they don't exist → **stop**: `install.sh` hasn't been run, or Claude Code wasn't restarted.
   - Check the origin: `printenv BUG_HUNT_ALLOWED_ORIGIN`, `printenv BUG_HUNT_SELF_TEST` and `grep -E '^(APP_WEB_STAGING_URL|LOGIN_PATH)=' ~/.config/bug-hunt/.env` (no `LOGIN_PATH` line means the default `/login`). Continue only if the variable is exactly the origin (scheme + host[:port], no trailing slash) of the configured URL **and** that origin is listed in `~/.config/bug-hunt/staging-origins.txt` (the one other config file you may read), or, only when `BUG_HUNT_SELF_TEST` is exactly `1`, `http://localhost[:port]` or `http://127.0.0.1[:port]` (the tooling and the guard allow the same; no other host, ever). Otherwise → **stop** and tell the user to restart Claude Code as in Setup step 6. Below, `<BASE>` is that origin.
   - `$BH validate`, then `$BH new-run` (prints `<RUN>`, e.g. `2026-10-10-0930`; a `! N OTP codes sent in the last hour` line on stderr is only a warning; `setup-failed: OTP budget …` means the hourly budget (default 8) was reached → stop and tell the user to wait), then `$BH session member <RUN>` (signs the member in once for the whole run; prints the state path, which you don't need). Any failure → **stop** with the printed cause (from `session member` onwards, run the end-of-run cleanup first).
   - Work out absolute paths (Write and the verifier need them, not `~`): `printf '%s\n' "$HOME/.cache/bug-hunt"` → `<CACHE>`; the browser output folder is `<CACHE>/mcp-out`; the uploads folder `<FIXTURES>` is `<CACHE>/mcp-out/bug-hunt/scenarios/fixtures`. The browser MCP only uploads files from inside its output folder, and the verifier's guard only allows paths containing `/bug-hunt/scenarios/fixtures/`; this copy satisfies both (step 2a.0 fills it).
   - Read the selected scenario files. From each, take `id`, `persona`, `start`, `modes` and `budget.max_turns` from the front-matter, and the body (everything after the closing `---`).
2. **For each selected scenario, in filename order, except that scenarios that sign out or burn a pool address (a `fresh-signup` run) run last; for each of its modes, happy before fuzz:**

   **a. Setup.**
   0. Reset the browser output folder and stage the upload fixtures in it:
      `find <CACHE>/mcp-out -mindepth 1 -delete` then `mkdir -p <FIXTURES> && cp ~/.claude/skills/bug-hunt/scenarios/fixtures/* <FIXTURES>/`.
   1. `$BH session activate <RUN> member` (persona `finished-member`) or `$BH session activate <RUN> empty` (persona `fresh-signup`).
   2. `browser_close`. If it doesn't return (it sometimes hangs and gets backgrounded after ~120 s), carry on: the check in step 4 is what proves the new context. Stop the backgrounded call if the harness offers that. Remember that it timed out: after step c.3, add `browser_close timed out: context may be reused from the previous scenario` to the end of that findings file's `notes` (Edit, then `jq empty`). The run still proceeds.
   3. `browser_navigate` to `<BASE><start>`.
   4. Check the landed URL:
      - `finished-member`: the path is not the login page (`LOGIN_PATH`) and not an onboarding or sign-up page. If it is, run `$BH session member <RUN>` once, then repeat 1–4. If that command fails or the path is still a sign-in page, run `$BH findings <RUN> <id> <mode> --setup-failed "<cause>"` and go to the next scenario run.
      - `fresh-signup`: the page is signed out (the sign-in screen with its email box, not a signed-in page). If not, repeat 1–4 once, then setup-failed as above.
   5. `fresh-signup` only, after the check passes: `$BH session reserve-signup <RUN>` prints `<ADDR>`. On failure (pool empty) → setup-failed with the printed cause.

   **OTP budget.** Apps usually limit code sends per address and per IP (set `OTP_BUDGET_PER_HOUR` / `OTP_BUDGET_PER_EMAIL` below yours). `session member` and `session reserve-signup` log each code they cause to `~/.cache/bug-hunt/otp-sends.log` (with a short hash of the address, never the address), and `new-run`, `session member` and `session reserve-signup` all refuse at `OTP_BUDGET_PER_HOUR` in the last hour; `session member` also refuses once `OTP_BUDGET_PER_EMAIL` codes went to the member within 15 minutes (so a mid-sweep re-sign-in can't trip the app's limit). The verifier's own in-scenario "Resend code" clicks count against the app's limit too, but are not in that log. If `session member` fails with `setup-failed: rate-limited — wait and retry`, record it as setup-failed like any other cause. If a sign-up run hit the app's "too many codes" message (or `otp` timed out right after it), the address was never used: tell the user to move it from `~/.config/bug-hunt/used.txt` back to the top of `signup-pool.txt`.

   After a setup-failed, empty the browser output folder (`find <CACHE>/mcp-out -mindepth 1 -delete`) and skip b and c. **Three setup failures in a row → stop the sweep** (staging or the mailbox is down): skip the remaining scenarios, do step 3, and tell the user. A setup that succeeds resets the count.

   **b. Verify.** Dispatch the Agent tool with `subagent_type: "bug-hunt-verifier"` and this prompt, filled in:
   ```
   Scenario: <id>
   Mode: <happy|fuzz>   (happy: ignore the "Fuzz twists" section)
   Base URL: <BASE>
   Start path: <start>
   Turn budget: about <max_turns> tool calls
   Uploads folder: <FIXTURES>/
   Sign-up address: <ADDR>          ← fresh-signup only; omit the line otherwise

   <the scenario body, verbatim>
   ```
   Nothing else: no run id, no other path under `~/.config` or `~/.cache`, no findings from earlier scenarios. If the agent type doesn't exist → **stop** (install not done). Keep its reply text exactly as returned.

   **c. Check.**
   1. Call `browser_console_messages` with `level: "error"` and `all: true` (every error since the context opened; the default is only since the last navigation), and `browser_network_requests` with `static: false`. The network list covers only the current tab, since the last explicit navigation, so it is partial by nature. Write each raw output, unchanged, to `<CACHE>/<RUN>/console.txt` and `<CACHE>/<RUN>/network.txt`, then:
      `jq -n --rawfile console <CACHE>/<RUN>/console.txt --rawfile network <CACHE>/<RUN>/network.txt '{console: $console, network: $network}' | $BH collect <RUN> <id> <mode>`
      It redacts and keeps only errors and failed requests. It prints `<RUNS_DIR>/<RUN>/network/<id>-<mode>.json`; the run folder `<RUNDIR>` is the folder above `network/`. Then `rm <CACHE>/<RUN>/console.txt <CACHE>/<RUN>/network.txt`.
   2. Move this run's screenshots into the run, then empty the browser output folder (it also holds page snapshots and console logs with signed-in content). The verifier's screenshots are auto-named `page-<timestamp>.png` or `element-<timestamp>.png` at the top of the folder. Files the verifier downloaded land there too under their own names; they are not moved and are wiped with the folder. The staged fixtures sit in a subfolder and aren't moved either:
      `find <CACHE>/mcp-out -maxdepth 1 -type f \( -name 'page-*.png' -o -name 'element-*.png' \) -exec mv {} <RUNDIR>/screens/ \;` then `find <CACHE>/mcp-out -mindepth 1 -delete`.
   3. Write the verifier's reply, unchanged, to `<CACHE>/<RUN>/reply.txt`, then `$BH findings <RUN> <id> <mode> < <CACHE>/<RUN>/reply.txt` and `rm <CACHE>/<RUN>/reply.txt`. It writes `<RUNDIR>/findings/<id>-<mode>.json` and drops findings whose screenshots aren't on disk. A reply with no valid JSON is recorded as `incomplete`, not an error.
   4. Review the evidence. Read `<RUNDIR>/findings/<id>-<mode>.json`. For each finding, open every cited screenshot (Read `<RUNDIR>/screens/<name>`). Drop or downgrade a finding **only** on screenshot grounds. If a cited screenshot contradicts the claim, Edit the JSON: remove the finding and add `"<title> — dropped by orchestrator: <reason>"` to `dropped`. If it shows a lesser problem, lower `severity` and say so in the finding's `actual`. A cited evidence line missing from `<RUNDIR>/network/<id>-<mode>.json` is never grounds to drop or downgrade. A `network:` line: keep the finding as it is, because the network list is partial (current tab only, since the last navigation). A `console:` line: the console list from step 1 (`all: true`) is complete for this context, so a cited error that isn't in it marks the finding unconfirmed: keep it, and append ` (unconfirmed: the cited console error is not in the collected console list)` to its `actual`. Then `jq empty <RUNDIR>/findings/<id>-<mode>.json` to confirm the file is still valid JSON. Your edits are redacted again (and the file rewritten) by `$BH report`, so `scan` won't delete the report over them; still keep secrets and member details out of your notes. Don't add findings of your own; console errors and failed requests already get their own section in the report.
3. **Finish.**
   1. `$BH report <RUN>` prints two paths: `report.md` and `report.html`. Both are rendered from the same findings; the HTML adds a run diagram, severity bars, finding cards with their screenshots and a scenario status grid.
   2. `$BH scan <RUN>`. On failure, stop here and don't publish anything (Stop conditions).
   3. The end-of-run cleanup: `$BH cleanup <RUN>` (deletes the run's session state and resets the browser to signed out), `find <CACHE>/mcp-out -mindepth 1 -delete` and `browser_close`.
   4. **Publish the report Artifact.** `$BH artifact <RUN> <SCRATCH>`, where `<SCRATCH>` is your session scratchpad directory (absolute, from your system prompt). It copies `report.html` and only the screenshots it links into `<SCRATCH>/bug-hunt-<RUN>/` and prints one JSON line `{"file_path", "root", "files"}`. Call the Artifact tool once with exactly those three values, `icon: "bug"` and a one-sentence `description` (run id, scenario count, headline count such as "0 blocker or major, 11 minor"). Don't edit the staged HTML. A `! N screenshots left out` warning means the 250-file publish limit was hit: say so. No scratchpad, or the Artifact tool unavailable → skip this step and say so; `report.md` is still the record.
   5. Show the user the Artifact link, the `report.md` path and its severity table, plus any scenario that was `setup-failed` or `incomplete`. The page is private until the user shares it from its Share menu.

## Stop conditions

Config missing or invalid · `staging-origins.txt` missing, empty or invalid · `BUG_HUNT_ALLOWED_ORIGIN` unset or not the configured staging origin (or localhost under `BUG_HUNT_SELF_TEST=1`) · browser tools or the verifier agent missing · `validate`, `new-run` or `session member` failing in step 1 · three setup failures in a row · `scan` failure (it deletes the offending files; tell the user which ones it printed).

Report the step, the cause and the fix, then end. Once `session member` has run, **always run the end-of-run cleanup before ending**, whatever the reason: session state must not outlive the run. Don't work around a failure, and never deploy to staging.

## Writing scenarios

Write your own scenarios in `scenarios/` — see `example-sign-out.md` for the format (front-matter with `id`, `area`, `persona`, `start`, `modes`, `budget`, then `## Goal`, `## Success criteria`, `## Fuzz twists`, `## Out of bounds`). `id` must match the filename; `area` is any kebab-case word you choose to group scenarios. Personas: `finished-member` (starts signed in as the test member) and `fresh-signup` (starts signed out; the verifier drives your sign-up itself with a pool address).

## Limitations

- Sign-in supports email + one-time code only. A password or SSO app needs `tooling/src/session.ts` adapted.
- Redaction terms are edited in code: add your app's sensitive field names to `TERMS` in `tooling/src/terms.ts`; scan and redaction share that one list.
