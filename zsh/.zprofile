#!/bin/zsh

# Environment variables
export EDITOR="vim"
export FZF_DEFAULT_OPTS="--style minimal --color 16 --layout=reverse --height 30% --preview='bat -p --color=always {}'"
export FZF_CTRL_R_OPTS="--style minimal --color 16 --info inline --no-sort --no-preview"
export MANPAGER="less -R --use-color -Dd+r -Du+b"
export ERL_AFLAGS="-kernel shell_history enabled"
export HOMEBREW_NO_AUTO_UPDATE=1

source "$HOME/dotfiles/shell/env.sh"
