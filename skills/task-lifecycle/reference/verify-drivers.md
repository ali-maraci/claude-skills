# Verify drivers (read by the verify agents only)

One verify agent per surface × group of ≤4 acceptance criteria. Exercise only the flows your criteria need; another agent covers the rest. Append to your evidence file after every flow.

## Server-identity check (every surface, before anything else)

The running server must be serving **this worktree and branch**, or you are verifying someone else's code and a pass is a false pass.

1. Find the listener: `lsof -nP -iTCP:<port> -sTCP:LISTEN` (port from the brief or the repo docs) → PID.
2. `lsof -p <PID> | grep cwd` → the process cwd must be inside the `repo` path you were given (the worktree), and `git -C <that cwd> rev-parse --abbrev-ref HEAD` must equal the task branch.
3. Either check fails, or nothing listens → **setup failure**: report the port, the cwd you found and the branch it is on. Do not start or restart services you were not told to start.

## Project setup comes from the repo

Ports, start commands, seeded logins, API keys and any developer-login bypass are **not** defined here. Read them from the brief, then the repo's `CLAUDE.md` / README. A value you need that none of them names is a setup failure — never guess, never use real credentials, never seed data through the running app.

## Web (surface `web`) → Playwright MCP

- Drive the **running** web app through the Playwright MCP (load its tools with ToolSearch: `select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_close`). The port comes from the brief or the repo docs.
- Navigate with accessibility snapshots; snapshots are large, so take one per page state you need, not after every click; take screenshots only as evidence frames.
- **Recording:** if the Playwright MCP is configured to record video, the output directory may be **shared by every session and worktree on the machine**, so "the newest file" may belong to another task. Note the time (`date +%s`) immediately before `browser_close`, call it, then take the newest `.webm` whose mtime is after that time; copy it to `<repo>/.scratch/<TICKET>/lifecycle/recordings/` and report that path. If recording is not configured, see the evidence rules below.

## Staff / admin UI (surface `portal`) → Playwright MCP

- A server-rendered back-office UI, driven like `web` with the same Playwright tools and recording. Port and base path come from the brief or the repo docs.
- Log in with the seeded test user the brief names. No seeded user named is a setup failure.

## Backend-only (surface `api`)

- No browser. Evidence for each criterion is the **named test and the assertion in it that proves the specific outcome**, plus its passing run (`<testCmd> <file> 2>&1 | tail -20`), or a `curl` against the running server with the response body as evidence where the criterion is about an HTTP contract. Routes that need an API key use the key from the brief; a missing key is a setup failure.

## iOS (surface `ios`) → Maestro (Apple XCUITest under the hood)

- Drive the dev build in a booted simulator through the **Maestro MCP** (ships inside the Maestro CLI): inspect the live view hierarchy, tap, type, scroll, assert. Full interaction, every screen and flow in your criteria, not just navigation. Dev build only, never Expo Go, never a TestFlight build.
- **Recording:** `maestro record <flow.yaml> <abs>.mp4` for a scripted flow, or capture the MCP-driven session. Fallback screen-recorder: `xcrun simctl io booted recordVideo <abs>.mov`. Write recordings and any flow `.yaml` you script under `<repo>/.scratch/<TICKET>/lifecycle/recordings/` — anywhere else inside the repo fails the test gate as an uncommitted change. If a flow is worth keeping in CI, say so in your evidence; do not add it to the repo yourself.
- **Auth:** use whatever sign-in path the brief or the repo docs name for simulator runs (a dev-only login, a seeded test account). No typing of real one-time codes. Prefer `testID`/accessibility labels.
- **Prereqs** (any missing one is a setup failure): Maestro installed; a booted simulator with the dev build installed (install command from the repo docs); the backend the app talks to is up and passes the server-identity check; the sign-in path from the brief works.
- **Device-only features cannot be simulator-verified:** device-sensor APIs, live microphone capture, Apple Sign-In, push. Mark them `device_only`. Never fake them.
- Never reach for an idb-based driver; idb is abandoned.

## Evidence rules (all surfaces)

- A user-facing criterion → recording path + timestamp, or the screenshot step that shows it.
- A backend-only criterion → the named test, the assertion in it that proves the specific outcome, and its passing run. A test that passes without asserting that outcome is `missing`.
- Appearance (surfaces `web`, `portal`, `ios`): for each page the ticket adds or changes, one screenshot is also appearance evidence. Compare it with a neighbouring existing page of the same app. Browser-default controls or missing styles are a failing flow named `appearance: <page>`, and the failure text names the reference page and the stylesheet it uses.
- No evidence → status `missing`. "Looks implemented" is not evidence.
- If recording is unavailable, capture an ordered screenshot walkthrough and call it that. Never describe screenshots as a recording.
- Evidence file: `<repo>/.scratch/<TICKET>/lifecycle/verify-<surface>-<group>.md`, one line per flow (name · pass/fail · evidence path), appended as you go. Recordings and screenshots live beside it under `lifecycle/recordings/`. All of it is scratch, never committed.
- Other surfaces have their own agents. If a criterion can only be shown on a surface that is not yours (a UI criterion on the `api` surface, say), report it `missing` with that as the evidence text — do not try to evidence it another way.
