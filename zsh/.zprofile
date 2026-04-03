#!/bin/zsh

export EDITOR="vim"

# Path customizations
export PATH="/opt/homebrew/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.local/share/mise/shims:$PATH"
export PATH="$HOME/dotfiles/scripts:$PATH"

export FZF_DEFAULT_OPTS="--style minimal --color 16 --layout=reverse --height 30% --preview='bat -p --color=always {}'"
export FZF_CTRL_R_OPTS="--style minimal --color 16 --info inline --no-sort --no-preview" # separate opts for history widget
export MANPAGER="less -R --use-color -Dd+r -Du+b"                                        # colored man pages

# Erlang shell history
export ERL_AFLAGS="-kernel shell_history enabled"

# Prevent Homebrew from auto-updating at inopportune times
export HOMEBREW_NO_AUTO_UPDATE=1
