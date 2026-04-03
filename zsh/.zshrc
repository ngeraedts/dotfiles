#!/bin/zsh

# source global shell alias & variables files
[ -f "$HOME/dotfiles/shell/alias" ] && source "$HOME/dotfiles/shell/alias"
[ -f "$HOME/dotfiles/shell/vars" ] && source "$HOME/dotfiles/shell/vars"

zstyle ':omz:update' mode disabled

export ZSH="$HOME/.oh-my-zsh"
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh
plugins=(git mix mise)

ZSH_THEME="pi"
ENABLE_CORRECTION="true"
HYPHEN_INSENSITIVE="true"
DISABLE_UNTRACKED_FILES_DIRTY="true"
HIST_STAMPS="yyyy-mm-dd"
ZSH_CUSTOM="${HOME}/dotfiles/zsh/custom"

source "$ZSH/oh-my-zsh.sh"

# load modules
zmodload zsh/complist
autoload -U compinit && compinit
autoload -U colors && colors

# cmp opts
zstyle ':completion:*' menu select       # tab opens cmp menu
zstyle ':completion:*' special-dirs true # force . and .. to show in cmp menu

# Only autocorrect commands, not arguments
unsetopt correct_all
setopt correct

setopt append_history inc_append_history share_history # better history
# on exit, history appends rather than overwrites; history is appended as soon as cmds executed; history shared across sessions
setopt auto_menu menu_complete    # autocmp first menu match
setopt autocd                     # type a dir to cd
setopt auto_param_slash           # when a dir is completed, add a / instead of a trailing space
setopt no_case_glob no_case_match # make cmp case insensitive
setopt globdots                   # include dotfiles
setopt extended_glob              # match ~ # ^
setopt interactive_comments       # allow comments in shell

# history opts
HISTSIZE=1000000
SAVEHIST=1000000
HISTFILE="$HOME/.cache/zsh/zsh_history" # move histfile to cache
HISTCONTROL=ignoreboth                 # consecutive duplicates & commands starting with space are not saved



export KERL_CONFIGURE_OPTIONS="--with-wx-config=$(brew --prefix wxwidgets)/bin/wx-config --enable-wx"
export KERL_BUILD_DOCS="yes"


source "/Users/nicholas/.config/hiive/scripts/warp-hooks.zsh"
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

# pnpm
export PNPM_HOME="/Users/nicholas/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# Homebrew
source <(/opt/homebrew/bin/brew shellenv)
source <(fzf --zsh)
source <(zoxide init --cmd=cd zsh)
source <(mise activate zsh)

# Initialize Hiive environment
[[ -f "$HOME/.config/hiive/init.zsh" ]] && source "$HOME/.config/hiive/init.zsh"

# opencode
export PATH=/Users/nicholas/.opencode/bin:$PATH
