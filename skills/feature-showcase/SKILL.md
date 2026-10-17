---
name: feature-showcase
description: Use when a Done ticket or epic needs a short, shareable showcase or training video of the feature on web staging — "/feature-showcase PROJ-123", "make a showcase video for PROJ-123", "record a demo of this feature with a voice-over". Not for iOS, local dev or production.
---

# Feature Showcase

Turns one Done ticket (or an epic's Done children) into a ≤2-minute narrated 1080p MP4 of the feature running on **staging**, for the internal team and stakeholders. Fully automatic — no checkpoints; the human reviews only the final video.

`$FS` below means `sh <this skill's directory>/tooling/bin/feature-showcase`. Shell variables don't persist between calls, so write the full command each time.

## Assumes

- Atlassian MCP (Jira), `gh` authenticated to your org, ffmpeg (`brew install ffmpeg`), Node 22.
- Config in `~/.config/feature-showcase/`: `mkdir -p ~/.config/feature-showcase && cp -R <skill>/config.example/. ~/.config/feature-showcase/ && mv ~/.config/feature-showcase/env.example ~/.config/feature-showcase/.env`, then fill in `.env` (ElevenLabs API key and voice, staging URL, `APP_WEB_SIGNED_IN_PATH`, output dir) and `staging-workflows.json` (each repo's staging deploy workflow, `{ "<owner>/<repo>": { "workflow": "deploy-staging.yml", "hasDryRun": false } }`; set `hasDryRun: true` if that workflow can also run as a dry run that logs `DRY_RUN: true`, so preflight skips those runs when checking what staging has). The `portal` surface is optional: set `PORTAL_STAGING_URL` and `PORTAL_SIGNED_IN_PATH` together, or neither. `SHOWCASE_BRAND` is an optional card label.
- Sessions saved with `$FS auth app-web` (and `$FS auth portal` if configured).
- First run only: `npm --prefix <skill>/tooling ci && npx --prefix <skill>/tooling playwright install chromium`.

## Personas and sessions

- **`auth` opens its own Chromium window**, not the user's Chrome. When asking the user to run it, say so: a sign-in in their everyday browser is never seen, and `auth` just times out after 5 minutes. Prefer starting `$FS auth app-web` yourself in the background so the right window opens and you can read its output.
- **Pick a persona whose state matches the screens.** A finished account is redirected away from sign-up screens, so those can't be shown with it. Each sign-up step needs a persona left at that step.
- **`APP_WEB_SIGNED_IN_PATH` (and `PORTAL_SIGNED_IN_PATH`) must be a page that redirects to login when signed out.** A public page (including `/`, if it is public) can't tell signed-in apart from signed-out.
- **Email codes may be rate-limited on your staging.** Every `auth` run can spend one, so don't have the user retry sign-in in a loop; work out why it failed first.
- **One-shot flows** (each step saves, or triggers emails or other side effects) can only run once per persona. To record one, dry-run against one persona, then `produce --once` with a second persona left at the same step (see step 7).

## Rules

- **Synthetic data only.** Staging personas are synthetic, but never put record values (names, dates of birth, national ID numbers, account or record values, addresses) in narration or `fill` values. A `target` may name a UI label, never a person or a value. Narration goes to ElevenLabs — acceptable only because it describes the feature, not a person.
- **Never** read product `.env` files for keys; the tooling reads its own config.
- Stop on any stop condition below: report stage, cause, fix — then end. Don't improvise around a failure, and don't perform the fix yourself. In particular, never trigger a staging deploy: staging is shared, and a deploy replaces whatever branch is on it.
- Show only the web part of a ticket. If it also changed iOS, leave that out.

## Procedure

1. **Gather (read-only).**
   - Jira (Rovo): summary, description, acceptance criteria. Epic → its children with `statusCategory = Done` (skip the others). If the ticket isn't Done, or an epic has no Done children → **stop**.
   - Merged PRs: for each repo in `~/.config/feature-showcase/staging-workflows.json`, `gh pr list -R <repo> --state merged --search "<KEY>" --json number,title,mergeCommit,url`. Note each PR's full `mergeCommit.oid`; every merged PR becomes one `--merge` in step 2. Skim `gh pr diff <n> -R <repo> --name-only` (and the diff where needed) to learn which routes/screens changed and which surface (`app-web` or `portal`) shows them.
2. **Preflight.** `$FS preflight <KEY> --merge <repo>@<sha> … --surface <s> …`. Any ✗ → **stop** with its fix line.
3. **Probe.** For each route you'll show: `$FS probe <KEY> <surface> <path>`. Write selectors only from these snapshots — `role`+`name`, `label`, `text`, or `testId`. Never guess.
4. **Storyboard.** Write `<SHOWCASE_OUTPUT_DIR>/<KEY>/storyboard.json` per [references/storyboard-format.md](references/storyboard-format.md). Then `$FS validate <KEY>`; fix until ✓.
5. **Claim self-check.** For every narration sentence, name the acceptance criterion or the on-screen moment that supports it. Cut or rewrite any sentence you can't support. Re-validate.
6. **Dry run.** `$FS dry-run <KEY>`. On failure: re-probe the failing route, fix that scene, retry — at most **3** repairs after the first failure, then **stop** and report the scene, step and `work/failure-*.png`.
7. **Produce.** `$FS produce <KEY>`. Add `--captions` only if asked for burned-in subtitles; it needs an ffmpeg with libass (`brew install ffmpeg-full`). Add `--once` only when the user asked to record a flow that can only run once (e.g. a full sign-up): it skips produce's own dry run, so step 6 must have run against a *different* identical persona, and a failure uses up the recording persona.
8. **Report.** Paths to `showcase.mp4` and `transcript.md`, duration, ElevenLabs characters used. Done.

## Stop conditions

Ticket not Done · preflight ✗ (staging lacks the merge, session expired, key invalid, ffmpeg missing) · 3 failed dry-run repairs · TTS 401/403 or 3 failed retries · recording or compose failure. Re-invoking starts again at step 1 with a fresh repair count. Narration is cached by script hash, so a re-run never re-spends ElevenLabs credit for unchanged narration.
