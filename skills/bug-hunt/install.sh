#!/bin/sh
# One-time install, run by a human (auto mode refuses `claude mcp add` and writes to ~/.claude/agents):
# skill + agent symlinks, tooling deps, the browser state/output dirs and the dedicated browser MCP.
# Safe to re-run. Restart Claude Code afterwards.
set -eu
SKILL=$(cd "$(dirname "$0")" && pwd)
CACHE="$HOME/.cache/bug-hunt"

command -v jq >/dev/null || { echo "install jq: brew install jq" >&2; exit 1; }
command -v claude >/dev/null || { echo "the claude CLI must be on PATH" >&2; exit 1; }

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/agents"
ln -sfn "$SKILL" "$HOME/.claude/skills/bug-hunt"
ln -sfn "$SKILL/agents/bug-hunt-verifier.md" "$HOME/.claude/agents/bug-hunt-verifier.md"
chmod +x "$SKILL/hooks/verifier-guard.sh"

npm --prefix "$SKILL/tooling" ci
npx --prefix "$SKILL/tooling" playwright install chromium

# The MCP re-reads active/state.json for every new browser context; `session activate` swaps it per scenario.
mkdir -p "$CACHE/active" "$CACHE/mcp-out"
chmod 700 "$CACHE" "$CACHE/active" "$CACHE/mcp-out"
if [ ! -f "$CACHE/active/state.json" ]; then
  (umask 077; printf '%s' '{"cookies":[],"origins":[]}' > "$CACHE/active/state.json")
fi
chmod 600 "$CACHE/active/state.json"

# Remove-then-add so an older registration never survives with different args.
claude mcp remove --scope user bug-hunt-browser >/dev/null 2>&1 || true
claude mcp add --scope user bug-hunt-browser -- npx -y @playwright/mcp@0.0.83 --isolated --headless \
  --storage-state "$CACHE/active/state.json" --output-dir "$CACHE/mcp-out"

echo "✓ installed — create ~/.config/bug-hunt/.env and staging-origins.txt (see SKILL.md Setup), then restart Claude Code with BUG_HUNT_ALLOWED_ORIGIN set to one of the origins in staging-origins.txt"
