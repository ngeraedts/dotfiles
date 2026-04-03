# vim: ft=zsh
git_prompt_info() {
  local ref dirty

  if ! command -v git >/dev/null || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  ref=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) || return

  if ! git diff --no-ext-diff --quiet --exit-code 2>/dev/null || ! git diff --no-ext-diff --cached --quiet --exit-code 2>/dev/null; then
    dirty=" %{$fg[yellow]%}✗"
  fi

  echo "[%{$fg_bold[white]%}${ref}${dirty}%{$reset_color%}] "
}

return_status="%(?:%{$fg_bold[green]%}π:%{$fg_bold[red]%}π)"
prompt_suffix=" %{$reset_color%}➜ "

PROMPT=" ${return_status} %{$fg[blue]%}%~%{$reset_color%} \$(git_prompt_info)
${prompt_suffix}"
