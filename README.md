# Claude Skills — Ali Maraci's personal collection

A set of [Claude Code](https://claude.com/claude-code) skills I use to plan, build, check and demo software. They are written to be repo-agnostic: anything specific to a project (hosts, mailboxes, ticket keys, brand names) lives in your own config, not in the skills.

## What's in here

| Skill | What it does |
|-------|--------------|
| [`task-lifecycle`](skills/task-lifecycle/SKILL.md) | Takes one task from seams, build, review, fix, verify and final review through to an open PR. The pipeline is a Workflow script shipped with the skill; the main session resolves inputs, runs the stages and opens the PR. |
| [`tech-design`](skills/tech-design/SKILL.md) | Adds the technical layer to a product-approved ticket: architecture and program design worked out on paper and written back into the Jira ticket, before it goes to `task-lifecycle`. |
| [`appstore-preflight`](skills/appstore-preflight/SKILL.md) | Checks a built Release iOS app (local build, EAS `.ipa` or `.app`) against the App Store pre-submit checklist, and lists the manual App Review items a script can't check. |
| [`feature-showcase`](skills/feature-showcase/SKILL.md) | Turns a Done ticket or epic into a short narrated showcase video of the feature on staging: drafts a storyboard, records it headlessly with Playwright, voices it with ElevenLabs. |
| [`bug-hunt`](skills/bug-hunt/SKILL.md) | On-demand agentic bug hunt of a web app on staging: a restricted sub-agent works through goal-based scenarios and the skill writes a triage-ready report with screenshots. |

## Installing

Claude Code loads skills from `~/.claude/skills/`. Clone this repo once, then symlink (or copy) the skills you want:

```bash
git clone https://github.com/ali-maraci/claude-skills.git claude-skills
cd claude-skills

# symlink: stays up to date with a `git pull`
ln -s "$PWD/skills/task-lifecycle" ~/.claude/skills/task-lifecycle

# ...or copy if you'd rather pin your own version
cp -R skills/task-lifecycle ~/.claude/skills/task-lifecycle
```

Restart Claude Code (or start a new session) and the skill shows up.

`bug-hunt` is the exception: don't symlink it by hand. Run its `skills/bug-hunt/install.sh` yourself in a terminal. It links the skill and its verifier agent, installs the tooling and registers the `bug-hunt-browser` MCP server. Read the script first.

## Prerequisites per skill

Each `SKILL.md` lists its assumptions and is the authoritative source. In short:

- **`task-lifecycle`**
  - A Claude Code version with the **Workflow** tool. Set `/config` "Dynamic workflow size" to at least medium; a verify run spawns up to about 10 agents.
  - Companion skills: `mattpocock-skills:tdd` and `superpowers:receiving-code-review` (required); a strict maintainability-review skill and `superpowers:brainstorming` (optional).
  - `gh` authenticated for the PR; Atlassian MCP to read tickets; Slack MCP for the optional report DM.
  - On a new machine, run `workflows/probe.js` once (see the skill's `README.md`).
- **`tech-design`**: Atlassian MCP to write the design back into the Jira ticket (without it the design can still be drafted locally), and the companion skill `mattpocock-skills:tdd`.
- **`appstore-preflight`**: a Mac with Python 3 and the Xcode command-line tools, run from inside an Expo app repo (or pass `--repo PATH`). The default mode also needs Xcode and CocoaPods for a local Release build; `--ipa` and `--app` inspect an existing binary.
- **`feature-showcase`**
  - Atlassian MCP, `gh` authenticated to your org, `ffmpeg`, Node 22, and an ElevenLabs API key (starts with `sk_`).
  - Staging deployed by a GitHub Actions workflow, named per repo in `staging-workflows.json`.
  - Config in `~/.config/feature-showcase/`: copy `skills/feature-showcase/config.example/`, rename `env.example` to `.env`, and edit it and `staging-workflows.json`.
  - First run: `npm --prefix skills/feature-showcase/tooling ci` and install Playwright's Chromium, then save a signed-in session per surface with `$FS auth app-web` (and `$FS auth portal` if you use it), where `$FS` is `sh skills/feature-showcase/tooling/bin/feature-showcase`. See the skill's `SKILL.md`.
- **`bug-hunt`**
  - Node 22, `jq` (used by `install.sh` and the guard hook), the `claude` CLI on your PATH, a plus-addressed IMAP mailbox for sign-in codes (with an IMAP app password), and test accounts on your staging.
  - Config in `~/.config/bug-hunt/`: copy `skills/bug-hunt/config.example/`, rename `env.example` to `.env`, and edit it and `staging-origins.txt` (the exact staging origins the agent may open; a typed navigation anywhere else is refused, but links and redirects the page follows are not checked, so list only a staging that never links or redirects into production). List unregistered sign-up addresses in `~/.config/bug-hunt/signup-pool.txt`.
  - Start Claude Code with the allowed origin exported: `BUG_HUNT_ALLOWED_ORIGIN=<origin> claude`. Full steps in the skill's `SKILL.md` Setup.

## Licence

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
