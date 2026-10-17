#!/bin/bash
# Diff scout for task-lifecycle: measures a git range and decides the mechanical security trigger.
#
#   bash scout.sh <repo> <range>        e.g. bash scout.sh /path/to/worktree main...HEAD
#
# Output (fixed format, copied verbatim by the agent into the "scout" result):
#   HEAD_SHA: <40-char sha>
#   FILES: <count>
#   F: <repo-relative path>            one per changed file
#   DIFF_LINES: <insertions + deletions, noise excluded>
#   FIRED: true|false
#   REASON: path: <path>               one per path trigger
#   REASON: line: <added line>         one per content match (capped at 40 per grep)
#
# This is the source of truth for the trigger (reference/security-triggers.md explains the intent).
# Deliberately no `set -e` / `pipefail`: grep exits 1 on "no match", which is a normal outcome here.
# Uses /usr/bin/grep -E throughout so it behaves the same under BSD grep, GNU grep and a shell that
# aliases `grep` to something else (ugrep rejects the BRE form of '^\+\+\+').

repo="$1"; range="$2"
if [ -z "$repo" ] || [ -z "$range" ]; then echo "usage: scout.sh <repo> <range>" >&2; exit 2; fi
cd "$repo" || { echo "ERROR: cannot cd to $repo" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERROR: $repo is not a git work tree" >&2; exit 2; }
GREP=/usr/bin/grep

# Pathspecs. Noise never counts (lockfiles, snapshots, generated, tests, fixtures, docs, svg).
# Client views are excluded from the server-side content grep only.
NOISE=(':(exclude)*lock*' ':(exclude)*.snap' ':(exclude)*generated*' ':(exclude)*.test.*' ':(exclude)*.spec.*' ':(exclude)*__tests__*' ':(exclude)*fixtures*' ':(exclude)*.md' ':(exclude)*.svg')
CLIENT=(':(exclude)*.tsx' ':(exclude)*.jsx' ':(exclude)*.css' ':(exclude)*.scss' ':(exclude)*.html' ':(exclude)*/components/*')

# Server-side definitions and sinks (auth/session, secrets, personal-data fields and audit helpers, raw SQL,
# webhooks, CORS/CSP, cloud/LLM calls, route definitions, authorisation words).
SERVER_REGEX='(^|[^a-z])(auth\(|getServerSession|requireAuth|session_token|set-cookie|cookies\(\)\.set|jwt|password|secret|api[_-]?key|\bpin\b|audit_log|gdpr|execute\(|cursor\.execute|raw sql|webhook|cors|csp|iam|kms|bedrock|anthropic|openai|presign|@(app|bp|[a-z_]+_bp)\.(route|get|post|put|delete|patch)|export (async )?function (GET|POST|PUT|PATCH|DELETE)|(router|app)\.(get|post|put|delete|patch)\(|use server|is_admin|authorize|has_?permission|check_?access|permission)|(^|[^a-z.])text\('
# Client sinks (any non-noise file).
CLIENT_SINK_REGEX='dangerouslySetInnerHTML|localStorage|sessionStorage|document\.cookie|innerHTML|\beval\(|new Function\(|window\.open\(|postMessage\('
# A log call on the same added line as a PII-ish word (any non-noise file).
LOG_PII_REGEX='(console|logger|logging|log)\.(log|info|warn|warning|error|debug|exception)\(.*(token|\bpin\b|password|secret|authorization)'
# Substring match on any changed path.
TRIGGER_PATHS=(
  'auth/' 'webhooks/' 'migrations/' 'db/' 'deploy' 'gdpr'
  '.github/workflows/' 'package.json' 'package-lock.json' 'pnpm-lock.yaml' 'yarn.lock' 'requirements' 'Dockerfile' 'terraform' 'cdk'
)

# Optional per-repo additions, read from the repo under review (one entry per line; blank lines and
# lines starting with # are ignored):
#   .claude/security-trigger-paths  substrings appended to TRIGGER_PATHS
#   .claude/security-trigger-regex  an ERE OR-ed into SERVER_REGEX
if [ -f .claude/security-trigger-paths ]; then
  while IFS= read -r p || [ -n "$p" ]; do
    case "$p" in ''|'#'*) ;; *) TRIGGER_PATHS+=("$p") ;; esac
  done < .claude/security-trigger-paths
fi
# A bad regex file must never switch the trigger off: an invalid ERE would make every content grep below
# exit 2 with no output, and an empty alternative (a stray "|") would match every line. Empty alternatives
# are stripped; a regex that is still invalid, or that matches an empty line, is left out and fires the
# trigger with a config reason instead.
config_reasons=("${config_reasons[@]}")
if [ -f .claude/security-trigger-regex ]; then
  extra=$($GREP -Ev '^[[:space:]]*(#|$)' .claude/security-trigger-regex | paste -sd'|' -)
  extra=$(printf '%s' "$extra" | sed -E 's/\|\|+/|/g; s/^\|//; s/\|$//')
  if [ -n "$extra" ]; then
    printf 'x\n' | $GREP -iE "$extra" >/dev/null 2>&1; rc=$?
    if [ "$rc" -eq 2 ] || printf '\n' | $GREP -iqE "$extra" 2>/dev/null; then
      config_reasons+=("config: invalid .claude/security-trigger-regex")
    else
      SERVER_REGEX="$SERVER_REGEX|$extra"
    fi
  fi
fi

added_lines() { $GREP -E '^\+' | $GREP -Ev '^\+\+\+'; }

echo "HEAD_SHA: $(git rev-parse HEAD)"

files=$(git diff --name-only "$range" 2>/dev/null)
if [ -n "$files" ]; then nfiles=$(printf '%s\n' "$files" | $GREP -c .); else nfiles=0; fi
echo "FILES: $nfiles"
[ -n "$files" ] && printf '%s\n' "$files" | sed 's/^/F: /'

shortstat=$(git diff --shortstat "$range" -- . "${NOISE[@]}" 2>/dev/null)
diff_lines=$(printf '%s' "$shortstat" | awk '{ for (i = 1; i <= NF; i++) if ($(i+1) ~ /^(insertion|deletion)/) s += $i } END { print s + 0 }')
echo "DIFF_LINES: $diff_lines"

reasons=("${config_reasons[@]}")
if [ -n "$files" ]; then
  while IFS= read -r f; do
    for p in "${TRIGGER_PATHS[@]}"; do
      case "$f" in *"$p"*) reasons+=("path: $f"); break ;; esac
    done
  done <<< "$files"
fi

while IFS= read -r l; do [ -n "$l" ] && reasons+=("line: $l"); done < <(
  git diff -U0 "$range" -- . "${NOISE[@]}" "${CLIENT[@]}" 2>/dev/null | added_lines | $GREP -iE "$SERVER_REGEX" | head -40)
while IFS= read -r l; do [ -n "$l" ] && reasons+=("line: $l"); done < <(
  git diff -U0 "$range" -- . "${NOISE[@]}" 2>/dev/null | added_lines | $GREP -iE "$CLIENT_SINK_REGEX|$LOG_PII_REGEX" | head -40)

if [ ${#reasons[@]} -gt 0 ]; then echo "FIRED: true"; else echo "FIRED: false"; fi
for r in "${reasons[@]}"; do echo "REASON: $r"; done
exit 0
