#!/bin/sh
# PreToolUse guard for the bug-hunt verifier sub-agent ONLY (declared in its
# frontmatter, never in global settings). Exit 2 denies; stderr goes to the agent.
# Defence in depth behind the agent's `tools:` allowlist.
# Fails closed: missing jq, unparsable input or an empty tool name all deny.
deny() { echo "bug-hunt verifier: $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || deny "jq is required"
input=$(cat)
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || deny "unparsable hook input"
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
[ -n "$tool" ] || deny "missing tool name"

# Staging origins come from ${BUG_HUNT_CONFIG_DIR:-~/.config/bug-hunt}/staging-origins.txt (one literal
# origin per line; blank and '#' lines ignored). src/allowlist.ts reads the same file with the same
# grammar; test/fixtures/origin-cases.json pins that the two agree. Fail closed: a missing, unreadable,
# empty or invalid file (any bad line, any CR) denies every navigation. The env var is not trusted:
# it must be listed verbatim (exact line match, no patterns), or localhost/127.0.0.1 only with
# BUG_HUNT_SELF_TEST=1 (and only once the file itself is valid).
ORIGIN_LINE_RE='^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
FORBIDDEN_HOST_RE='^https://([a-z0-9.-]*\.)?(localhost|[0-9]+|0x[a-z0-9-]*)(:[0-9]+)?$'
allowed_is_staging() {
  case "$BUG_HUNT_ALLOWED_ORIGIN" in *"
"*|*"$(printf '\r')"*) return 1 ;; esac
  origins_file="${BUG_HUNT_CONFIG_DIR:-$HOME/.config/bug-hunt}/staging-origins.txt"
  [ -f "$origins_file" ] && [ -r "$origins_file" ] || deny "staging origins not configured"
  # The first bad line is named by number, never by value: any CR, or a line that is not blank, not a
  # comment and not a well-formed, non-loopback origin. The regexes are re-anchored after grep -n's "N:".
  bad=$(grep -n "$(printf '\r')" "$origins_file" | head -1 | cut -d: -f1)
  if [ -z "$bad" ]; then
    numbered=$(grep -nEv '^(#.*)?$' "$origins_file")
    bad=$( { printf '%s\n' "$numbered" | grep -Ev "^[0-9]+:${ORIGIN_LINE_RE#^}"
             printf '%s\n' "$numbered" | grep -E "^[0-9]+:${FORBIDDEN_HOST_RE#^}"; } | cut -d: -f1 | grep -E '^[0-9]+$' | sort -n | head -1)
  fi
  [ -z "$bad" ] || deny "staging origins file invalid at line $bad"
  grep -Ev '^(#.*)?$' "$origins_file" | grep -Eq "$ORIGIN_LINE_RE" || deny "staging origins not configured"
  grep -Ev '^#' "$origins_file" | grep -Fxq -- "$BUG_HUNT_ALLOWED_ORIGIN" && return 0
  [ "$BUG_HUNT_SELF_TEST" = "1" ] && printf '%s' "$BUG_HUNT_ALLOWED_ORIGIN" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$'
}

# Navigation origin check, shared by browser_navigate and browser_tabs (with a url).
check_url() {
  url=$(printf '%s' "$input" | jq -r '.tool_input.url // empty')
  [ -n "$url" ] || return 0
  [ "$(printf '%s' "$input" | jq -r '(.tool_input.url // "") | test("[\r\n]")')" = "false" ] || deny "invalid url"
  origin=$(printf '%s' "$url" | sed -E 's|^(https?://[^/?#]+).*|\1|')
  [ -n "$BUG_HUNT_ALLOWED_ORIGIN" ] || deny "no allowed origin configured"
  allowed_is_staging || deny "allowed origin is not a staging host"
  [ "$origin" = "$BUG_HUNT_ALLOWED_ORIGIN" ] && return 0
  if [ "$BUG_HUNT_SELF_TEST" = "1" ] && printf '%s' "$origin" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$'; then return 0; fi
  deny "navigation to $origin is outside staging"
}

case "$tool" in
  *browser_evaluate|*browser_run_code_unsafe|*browser_network_request|*browser_drop|Read|Glob|Grep|Edit|Write|NotebookEdit|WebFetch|WebSearch|Agent|Task)
    deny "$tool is not something a member can do" ;;
  mcp__bug-hunt-browser__*)
    # A named file is written (overwriting) under Claude Code's project dir; auto-named files go to the MCP output dir.
    fname=$(printf '%s' "$input" | jq -r '.tool_input.filename // "" | tostring')
    [ -z "$fname" ] || deny "naming files is not something a member can do" ;;
  mcp__*)
    deny "$tool is not something a member can do" ;;
esac

case "$tool" in
  *browser_navigate)
    [ -n "$(printf '%s' "$input" | jq -r '.tool_input.url // empty')" ] || deny "navigate requires a url"
    check_url ;;
  *browser_tabs)
    check_url ;;
  *browser_file_upload)
    bad=$(printf '%s' "$input" | jq -r '(.tool_input.paths // []) | if type=="array" then .[] else "bad" end
      | select((type!="string") or (startswith("/")|not) or contains("/../") or endswith("/..") or test("[\r\n]") or (contains("/bug-hunt/scenarios/fixtures/")|not))')
    [ -z "$bad" ] || deny "upload only files from scenarios/fixtures/ (not something a member can do otherwise)" ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    # one line, no shell metacharacters, exactly the otp command
    case "$cmd" in *"
"*) deny "only the otp command is allowed" ;; esac
    # strict path (no spaces/quotes) starting with / or a literal "$HOME/"; address starts alnum
    printf '%s' "$cmd" | grep -Eq '^(sh (\$HOME)?/[A-Za-z0-9._/-]*/bug-hunt/tooling/bin/bug-hunt|bug-hunt) otp [a-z0-9][a-z0-9._-]*\+[a-z0-9-]+@[a-z0-9.-]+$' && exit 0
    deny "only the otp command is allowed" ;;
  # The rest of the agent's `tools:` allowlist. Anything else is denied, so a widened or ignored
  # allowlist can't reach an unchecked tool.
  mcp__bug-hunt-browser__browser_navigate_back|mcp__bug-hunt-browser__browser_click|\
  mcp__bug-hunt-browser__browser_type|mcp__bug-hunt-browser__browser_fill_form|\
  mcp__bug-hunt-browser__browser_select_option|mcp__bug-hunt-browser__browser_hover|\
  mcp__bug-hunt-browser__browser_press_key|mcp__bug-hunt-browser__browser_snapshot|\
  mcp__bug-hunt-browser__browser_take_screenshot|mcp__bug-hunt-browser__browser_console_messages|\
  mcp__bug-hunt-browser__browser_wait_for|mcp__bug-hunt-browser__browser_handle_dialog)
    exit 0 ;;
  # The harness's channel for the agent's final reply (writes nothing the agent names).
  SubagentHandback)
    exit 0 ;;
  *)
    deny "$tool is not something a member can do" ;;
esac
