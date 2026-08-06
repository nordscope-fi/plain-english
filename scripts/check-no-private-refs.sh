#!/usr/bin/env bash
# Release blocker: this repo is public and must contain no reference to the
# private repo it was extracted from, no personal usernames, and no absolute
# home paths.
#
#   check-no-private-refs.sh              scan the working tree
#   check-no-private-refs.sh --history    scan every commit in every branch
#
# Exit 0 = clean. Exit 1 = at least one hit. Exit 2 = usage/internal error.
#
# Runs in three places so a single skipped gate cannot let a hit through:
#   - npm "pretest"        (fires locally on every test run)
#   - CI required job      (fires on every pull request)
#   - npm "prepublishOnly" (fires on release even if CI was bypassed)
set -uo pipefail

MODE="${1:-tree}"
case "$MODE" in
  tree|--tree)     MODE=tree ;;
  --history)       MODE=history ;;
  -h|--help)       sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) printf 'usage: %s [--history]\n' "$(basename "$0")" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.." || exit 2

# One pattern per line. Case-insensitive, extended regex.
# Keep this list conservative: a false positive here costs one rename, a miss
# costs a permanent public commit.
read -r -d '' DENY <<'EOF'
hamina
peterhamina
wireless
/Users/
/home/
knowledge/writing-style\.md
EOF

# This script necessarily contains the denylist itself, so it is never scanned.
SELF="scripts/check-no-private-refs.sh"

pattern=$(printf '%s' "$DENY" | grep -v '^[[:space:]]*$' | paste -sd'|' -)
status=0

scan_tree() {
  local hits
  # --untracked is what makes this correct: a plain `git grep` searches only
  # tracked files, so a new file carrying a private reference would pass the
  # check and then be committed by the very next `git add`. Ignored files stay
  # out of scope, which is what --exclude-standard preserves.
  # -I skips binaries; the pathspec drops this script, which holds the denylist.
  hits=$(git grep -n -I -E -i --untracked --exclude-standard \
           -- "$pattern" -- . ":(exclude)$SELF" 2>/dev/null)
  # Fall back to plain grep outside a git repo entirely.
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    hits=$(grep -rn -I -E -i --exclude-dir=.git --exclude-dir=node_modules \
             --exclude-dir=dist --exclude="$(basename "$SELF")" \
             -- "$pattern" . 2>/dev/null)
  fi
  if [ -n "$hits" ]; then
    printf 'FAIL: private reference(s) in the working tree\n\n%s\n\n' "$hits" >&2
    status=1
  else
    printf 'ok: working tree clean\n'
  fi
}

scan_history() {
  if [ -z "$(git rev-list --all 2>/dev/null | head -1)" ]; then
    printf 'ok: no commits yet, nothing to scan\n'
    return
  fi
  local hits
  # Scan every commit message and every patch body across all refs.
  hits=$(
    { git log --all --format='%H %s%n%b'
      git log --all -p --no-color -- . ":(exclude)$SELF"
    } 2>/dev/null | grep -n -E -i -- "$pattern"
  )
  if [ -n "$hits" ]; then
    printf 'FAIL: private reference(s) in git history\n\n%s\n\n' "$(printf '%s' "$hits" | head -40)" >&2
    printf 'History is rewritable only before the first push to a public remote.\n' >&2
    status=1
  else
    printf 'ok: history clean (%s commits)\n' "$(git rev-list --all --count)"
  fi
}

case "$MODE" in
  tree)    scan_tree ;;
  history) scan_history ;;
esac

exit "$status"
