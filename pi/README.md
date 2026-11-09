# Pi configuration

This Stow package contains Pi settings, custom model definitions, portable
extensions, and general-purpose skills. It requires Pi, GNU Stow, mise, and
GitHub CLI. The shell configuration expects this repository at `~/dotfiles`.

## Install on another Mac

1. Clone this repository to `~/dotfiles` and install the required tools.
2. Preview the links:

   ```bash
   stow --dir="$HOME/dotfiles" --target="$HOME" --no-folding --simulate pi zsh
   ```

3. Move any conflicting files to a private backup outside the repository. Do not
   use `stow --adopt`, which can copy local credentials into the repository.
4. Run the same command without `--simulate`.
5. Open a new terminal and start Pi. Authenticate providers with `/login`.

Use `--no-folding` to keep the Pi and skills directories real. Credentials,
sessions, work-specific extensions, and other local files can then coexist with
the tracked file links.

## Environment

`shell/env.sh` loads Homebrew, tool paths, optional local environment files,
GitHub package authentication, and WARP certificate settings. Zsh loads it at
startup and refreshes WARP settings before each prompt.

Pi's `shellCommandPrefix` sources `shell/agent-env.sh` before each shell command.
That script loads the shared environment, applies the current project's mise
configuration, and refreshes WARP certificate settings. If a command changes to
another project, use `mise exec -- <command>` there to load its environment.

Keep private or machine-specific exports in `~/.config/shell/env.local`.
Keep interactive, machine-specific zsh setup in `~/.config/zsh/local.zsh`.
The legacy `shell/vars` file is also loaded but is ignored by Git.

When WARP is connected, its certificate must be readable at
`/Library/Application Support/Cloudflare/installed_cert.pem`. The shared script
sets the CA variables for curl, Python Requests, OpenSSL, Node, and Git. When
WARP disconnects, it removes only variables that still point to that certificate.
It does not disable TLS verification.

## Credentials and local configuration

Linear and Figma read `LINEAR_API_KEY` and `FIGMA_TOKEN` from the Pi process's
environment, or from `~/.config/pi/credentials.json`:

```json
{
  "LINEAR_API_KEY": "replace-with-your-key",
  "FIGMA_TOKEN": "replace-with-your-token"
}
```

Protect that file with `chmod 600 ~/.config/pi/credentials.json`. Do not put it
in this repository. The Anthropic API-key provider uses `ANTHROPIC_API_KEY` from
the process environment. Restart Pi after changing inherited environment
variables. A shell command prefix changes child shells, not Pi's own environment.

Vercel provides `/vercel-auth`. The Datadog, Notion, and PostHog extensions are
disabled in settings. Enable them only when needed and use their login commands.

Work-specific `AGENTS.md`, MCP configuration, skills, and extensions remain
local. Authentication files, device trust, sessions, caches, downloaded binaries,
and service tokens are not part of this package. Authenticate each laptop
separately. Run `/reload` after changing linked settings or extensions.
