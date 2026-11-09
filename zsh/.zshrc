#!/bin/zsh

# Shared environment and aliases
source "$HOME/dotfiles/shell/env.sh"
[ -f "$HOME/dotfiles/shell/alias" ] && source "$HOME/dotfiles/shell/alias"

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

# Tool integrations
[ -f "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ] && source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
[ -f "$HOME/dotfiles/zsh/worktree-completion.zsh" ] && source "$HOME/dotfiles/zsh/worktree-completion.zsh"

# Refresh certificate settings when the VPN state changes between commands.
autoload -Uz add-zsh-hook
add-zsh-hook -d precmd dotfiles_refresh_warp
add-zsh-hook precmd dotfiles_refresh_warp

[[ ! -f "$HOME/.config/zsh/local.zsh" ]] || source "$HOME/.config/zsh/local.zsh"

command -v fzf >/dev/null && source <(fzf --zsh)
command -v mise >/dev/null && source <(mise activate zsh)
command -v zoxide >/dev/null && source <(zoxide init --cmd=cd zsh)
