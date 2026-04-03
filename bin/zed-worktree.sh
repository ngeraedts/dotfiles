#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
usage: zed-worktree [branch-name] [base-branch]

Creates or reuses a git worktree for the current repository and opens it in a
new Zed window.

Arguments:
  branch-name  Git branch name to create or open. If omitted, a macOS prompt is shown.
  base-branch  Base branch to create from when the branch does not yet exist.
               If omitted, the script will try origin/HEAD, then main, then master,
               then develop.

Examples:
  zed-worktree nick/HIIVE-123-do-a-thing
  zed-worktree nick/HIIVE-123-do-a-thing main
EOF
}

prompt_for_branch_name() {
  osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set user_input to text returned of (display dialog "Enter branch name" default answer "" with title "Create Git Worktree")
end tell
return user_input
APPLESCRIPT
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

sanitize_branch_name() {
  printf '%s' "$1" \
    | tr '/[:space:]' '--' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cd '[:alnum:]._-' \
    | sed 's/--*/-/g; s/^-//; s/-$//'
}

resolve_base_branch() {
  if [ -n "${1:-}" ]; then
    printf '%s\n' "$1"
    return 0
  fi

  remote_head_ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"

  if [ -n "$remote_head_ref" ]; then
    printf '%s\n' "${remote_head_ref#refs/remotes/origin/}"
    return 0
  fi

  for candidate in main master develop; do
    if git show-ref --verify --quiet "refs/heads/$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi

    if git ls-remote --exit-code --heads origin "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "Could not determine a base branch. Pass one explicitly." >&2
  exit 1
}

ensure_branch_available() {
  branch_name="$1"
  base_branch="$2"

  if git show-ref --verify --quiet "refs/heads/$branch_name"; then
    return 0
  fi

  if git ls-remote --exit-code --heads origin "$branch_name" >/dev/null 2>&1; then
    git fetch origin "$branch_name:$branch_name" >/dev/null 2>&1
    return 0
  fi

  if ! git show-ref --verify --quiet "refs/heads/$base_branch"; then
    git fetch origin "$base_branch:$base_branch" >/dev/null 2>&1
  fi
}

worktree_exists_at_path() {
  worktree_path="$1"
  [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]
}

branch_is_checked_out_elsewhere() {
  branch_name="$1"

  git worktree list --porcelain \
    | awk '
      /^branch / { current_branch = substr($0, 8) }
      /^worktree / { current_worktree = substr($0, 10) }
      /^$/ {
        if (current_branch == "refs/heads/'"$branch_name"'") {
          print current_worktree
          exit
        }
        current_branch = ""
        current_worktree = ""
      }
      END {
        if (current_branch == "refs/heads/'"$branch_name"'") {
          print current_worktree
        }
      }
    '
}

open_in_zed() {
  worktree_path="$1"

  if command -v zed >/dev/null 2>&1; then
    zed "$worktree_path"
    return 0
  fi

  open -a Zed "$worktree_path"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

require_command git
require_command osascript
require_command open

branch_name="${1:-}"

if [ -z "$branch_name" ]; then
  branch_name="$(prompt_for_branch_name)"
fi

if [ -z "$branch_name" ]; then
  echo "No branch name provided." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [ -z "$repo_root" ]; then
  echo "Run this script from inside a git repository." >&2
  exit 1
fi

base_branch="$(resolve_base_branch "${2:-}")"
repo_name="$(basename "$repo_root")"
parent_dir="$(dirname "$repo_root")"
worktrees_dir="$parent_dir/${repo_name}-worktrees"
safe_name="$(sanitize_branch_name "$branch_name")"
worktree_path="$worktrees_dir/$safe_name"

if [ -z "$safe_name" ]; then
  echo "Could not derive a safe folder name from branch: $branch_name" >&2
  exit 1
fi

mkdir -p "$worktrees_dir"

if worktree_exists_at_path "$worktree_path"; then
  echo "Reusing existing worktree: $worktree_path"
  open_in_zed "$worktree_path"
  exit 0
fi

existing_worktree="$(branch_is_checked_out_elsewhere "$branch_name" || true)"

if [ -n "$existing_worktree" ]; then
  echo "Branch is already checked out in another worktree: $existing_worktree" >&2
  exit 1
fi

ensure_branch_available "$branch_name" "$base_branch"

if git show-ref --verify --quiet "refs/heads/$branch_name"; then
  git worktree add "$worktree_path" "$branch_name"
else
  git worktree add "$worktree_path" -b "$branch_name" "$base_branch"
fi

open_in_zed "$worktree_path"
