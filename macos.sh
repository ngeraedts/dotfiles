#!/bin/bash
set -e

# Absolute path to this script, e.g. /home/user/bin/foo.sh
SCRIPT=$(readlink -f "$0")
# Absolute path this script is in, thus /home/user/bin
DOTFILES=$(dirname "$SCRIPT")

################################################################################
#   ZSH
################################################################################
# clear out unwanted config, then link from dotfiles
rm -f ~/.zshrc ~/.zprofile
ln -sf "${DOTFILES}/zsh/.zshrc" ~/.zshrc
ln -sf "${DOTFILES}/zsh/.zprofile" ~/.zprofile

################################################################################
#   MacOS Specific Stuff
################################################################################

# Enable key repeat for VSCode + Vim plugin
defaults write com.microsoft.VSCode ApplePressAndHoldEnabled -bool false

# Disable delay when showing/hiding dock
defaults write com.apple.dock autohide-delay -float 0.001

# Disable animation when showing/hiding dock
defaults write com.apple.dock autohide-time-modifier -int 0

# Kill the dock to apply above settings
killall Dock
