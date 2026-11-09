# Sourced before each Pi shell command. Do not load interactive shell setup.
. "$HOME/dotfiles/shell/env.sh" || exit $?

if command -v mise >/dev/null 2>&1; then
  _dotfiles_mise_env=$(mise env --shell bash) || exit $?
  eval "$_dotfiles_mise_env"
  unset _dotfiles_mise_env
fi

# Project configuration can change certificate variables.
dotfiles_refresh_warp || exit $?
