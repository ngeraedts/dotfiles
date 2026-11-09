# Shared environment for interactive shells and non-interactive agent commands.

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

_dotfiles_prepend_path() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
}

for _dotfiles_bin in \
  "$HOME/dotfiles/scripts" \
  "$HOME/.cargo/bin" \
  "$HOME/.opencode/bin" \
  "$HOME/dotfiles/bin" \
  "$HOME/.local/bin" \
  "$HOME/.local/share/mise/shims" \
  "/Applications/Postgres.app/Contents/Versions/latest/bin"; do
  [ ! -d "$_dotfiles_bin" ] || _dotfiles_prepend_path "$_dotfiles_bin"
done
export PATH
unset _dotfiles_bin
unset -f _dotfiles_prepend_path

# Local files can contain credentials and machine-specific settings.
[ ! -f "$HOME/dotfiles/shell/vars" ] || . "$HOME/dotfiles/shell/vars"
[ ! -f "$HOME/.config/shell/env.local" ] || . "$HOME/.config/shell/env.local"

if [ -z "${GH_NPM_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  if GH_NPM_TOKEN=$(gh auth token 2>/dev/null); then
    export GH_NPM_TOKEN
  fi
fi

dotfiles_refresh_warp() {
  local cert="/Library/Application Support/Cloudflare/installed_cert.pem"
  local cli="/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli"
  local ca_var

  if [ -x "$cli" ] && "$cli" status 2>/dev/null | grep -q 'Status update: Connected'; then
    export WARP_CONNECTED=true
    if [ ! -r "$cert" ]; then
      printf 'WARP is connected, but its CA certificate is not readable: %s\n' "$cert" >&2
      return 1
    fi
    export CURL_CA_BUNDLE="$cert"
    export REQUESTS_CA_BUNDLE="$cert"
    export SSL_CERT_FILE="$cert"
    export NODE_EXTRA_CA_CERTS="$cert"
    export GIT_SSL_CAINFO="$cert"
  else
    export WARP_CONNECTED=false
    for ca_var in CURL_CA_BUNDLE REQUESTS_CA_BUNDLE SSL_CERT_FILE NODE_EXTRA_CA_CERTS GIT_SSL_CAINFO; do
      if [ "$(printenv "$ca_var")" = "$cert" ]; then
        unset "$ca_var"
      fi
    done
  fi
}

dotfiles_refresh_warp
