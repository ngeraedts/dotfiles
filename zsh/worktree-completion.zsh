# Worktree helpers and completions

gwtrm() {
  git worktree remove "$@"
}

_gwtrm_worktrees() {
  local -a worktrees
  local repo_root current_worktree

  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  current_worktree="$(pwd -P)"

  worktrees=(${(f)"$(
    git worktree list --porcelain 2>/dev/null \
      | awk '
          /^worktree / { worktree = substr($0, 10) }
          /^$/ {
            if (worktree != "") {
              print worktree
            }
            worktree = ""
          }
          END {
            if (worktree != "") {
              print worktree
            }
          }
        ' \
      | grep -vx -- "$repo_root" \
      | grep -vx -- "$current_worktree"
  )"})

  _describe 'worktree' worktrees
}

compdef _gwtrm_worktrees gwtrm
compdef _git ggwt=git

_setup_worktree_branches() {
  local -a branches
  branches=(${(f)"$(git branch --sort=-committerdate --format='%(refname:short)' 2>/dev/null)"})
  _describe 'branch' branches
}

compdef _setup_worktree_branches setup-worktree
