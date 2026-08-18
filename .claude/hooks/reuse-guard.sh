#!/usr/bin/env bash
# reuse-guard.sh -- PreToolUse hook for Write.
#
# Fires once per NEW file created under src/ in a session and prints a
# reminder to search for an existing helper before adding a new one.
#
# Fail-open: any error (missing tool, unexpected input, disabled) exits 0
# so a broken guard cannot block a Write. Escape hatches:
#   PE_REUSE_GUARD_MODE=observe            log-only, no reminder printed
#   touch .claude/hooks/REUSE_GUARD_DISABLED   disable entirely
#
# Not a security control; a nudge. Contract: read one JSON payload on
# stdin, exit 0. Any stdout is shown to the model as a system reminder.
set -uo pipefail

if [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/REUSE_GUARD_DISABLED" ]; then
  exit 0
fi

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -z "$FILE_PATH" ] && exit 0

if [ -e "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  */src/*|src/*) ;;
  *) exit 0 ;;
esac

SESSION_ID="${CLAUDE_SESSION_ID:-$$}"
MARKER_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/.reuse-guard-fired"
mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
MARKER="$MARKER_DIR/$SESSION_ID"
if [ -f "$MARKER" ]; then
  exit 0
fi
: > "$MARKER"

if [ "${PE_REUSE_GUARD_MODE:-enforce}" = "observe" ]; then
  exit 0
fi

cat <<EOMSG
Reuse-before-write check (first new src/ file this session).

Before adding "$FILE_PATH", confirm no existing helper covers this need.
  rg -n "^export (const|function|class|type|interface)" src/
  rg -n "<candidate-name>" src/

If nothing exists, proceed. Rule: .claude/rules/code-conventions.md, "Reuse before write".
Escape: PE_REUSE_GUARD_MODE=observe or .claude/hooks/REUSE_GUARD_DISABLED.
EOMSG

exit 0
