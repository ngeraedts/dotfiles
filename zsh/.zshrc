#!/bin/zsh

# Shared aliases and variables
[ -f "$HOME/dotfiles/shell/alias" ] && source "$HOME/dotfiles/shell/alias"
[ -f "$HOME/dotfiles/shell/vars" ] && source "$HOME/dotfiles/shell/vars"

# Homebrew environment
[[ -x /opt/homebrew/bin/brew ]] && source <(/opt/homebrew/bin/brew shellenv)

# Prompt
autoload -U colors && colors
setopt prompt_subst
source "$HOME/dotfiles/zsh/themes/pi.zsh-theme"

# Completion and shell behavior
autoload -U compinit && compinit
zmodload zsh/complist

zstyle ':completion:*' menu select
zstyle ':completion:*' special-dirs true

unsetopt correct_all
setopt correct

setopt append_history inc_append_history share_history
setopt auto_menu menu_complete
setopt autocd
setopt auto_param_slash
setopt no_case_glob no_case_match
setopt globdots
setopt extended_glob
setopt interactive_comments
setopt hist_ignore_dups
setopt hist_ignore_space
setopt hist_save_no_dups

# History
HISTSIZE=1000000
SAVEHIST=1000000
HISTFILE="$HOME/.cache/zsh/zsh_history"

# Environment variables
export KERL_CONFIGURE_OPTIONS="--with-wx-config=$(brew --prefix wxwidgets)/bin/wx-config --enable-wx"
export KERL_BUILD_DOCS="yes"
export PNPM_HOME="$HOME/Library/pnpm"

# PATH
typeset -U path PATH
path=(
  "$HOME/dotfiles/bin"
  "$HOME/.opencode/bin"
  "$PNPM_HOME"
  "/Applications/Postgres.app/Contents/Versions/latest/bin"
  $path
)

# Tool integrations
[ -f "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ] && source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
command -v fzf >/dev/null && source <(fzf --zsh)
command -v zoxide >/dev/null && source <(zoxide init --cmd=cd zsh)
command -v mise >/dev/null && source <(mise activate zsh)
[ -f "$HOME/dotfiles/zsh/worktree-completion.zsh" ] && source "$HOME/dotfiles/zsh/worktree-completion.zsh"

# Hiive environment
[ -f "$HOME/.config/hiive/scripts/warp-hooks.zsh" ] && source "$HOME/.config/hiive/scripts/warp-hooks.zsh"
[ -f "$HOME/.config/hiive/init.zsh" ] && source "$HOME/.config/hiive/init.zsh"
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
