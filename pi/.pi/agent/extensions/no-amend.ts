import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/**
 * Guardrails for git operations that should never happen by default.
 *
 * Blocks:
 *  - git commit --amend (create a new commit instead)
 *  - git push --force / --force-with-lease, except one leased push of the
 *    same feature branch after a successful rebase in the current request
 *  - --no-gpg-sign / commit.gpgSign=false (never disable commit signing)
 *
 * Other amendments and force pushes require confirmation. Signing protection
 * cannot be overridden here. Validation before a rebase push is the rebase
 * skill's responsibility.
 */
export default function (pi: ExtensionAPI) {
  let rebasePush: { cwd: string; branch: string } | undefined;

  pi.on("before_agent_start", () => {
    rebasePush = undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    // Recognize the standalone commands used by the rebase skill, not shell
    // scripts whose final exit status could hide a failed rebase.
    const command = String(event.input.command ?? "").trim();
    if (!/^(?:GIT_EDITOR=true\s+)?git\s+rebase\s+(?:--continue|--skip|[\w][\w./@{}~^:+-]*)$/.test(command)) return;

    const branch = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
    const defaultBranch = await pi.exec("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: ctx.cwd });
    const name = branch.stdout.trim();
    if (branch.code !== 0 || !/^[\w][\w./-]*$/.test(name) || name === "main" || name === "master" ||
        defaultBranch.stdout.trim() === `refs/remotes/origin/${name}`) return;

    rebasePush = { cwd: ctx.cwd, branch: name };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command ?? "";

    if (/\bgit\s+rebase\b/.test(cmd)) rebasePush = undefined;

    // --- git commit --amend ---
    if (/\bgit\s+commit\b/.test(cmd) && /--amend\b/.test(cmd)) {
      const ok = await confirmOverride(
        ctx,
        "git commit --amend detected",
        "Amending commits is forbidden by default. Create a new commit instead.\n\nDid the user explicitly ask to amend?",
      );
      if (!ok) {
        return {
          block: true,
          reason:
            "Amending commits is forbidden. Create a new commit instead. " +
            "If the user explicitly asked to amend, ask them to confirm.",
        };
      }
    }

    // --- git push --force / --force-with-lease ---
    if (/\bgit\s+push\b/.test(cmd) && /(--force\b|-f\b|--force-with-lease\b)/.test(cmd)) {
      const allowed = rebasePush;
      // An explicit destination prevents push.default or remote push refspecs
      // from rewriting another branch. Consume approval even if the push fails.
      if (allowed?.cwd === ctx.cwd &&
          cmd.trim() === `git push --force-with-lease origin HEAD:refs/heads/${allowed.branch}`) {
        rebasePush = undefined;
        const branch = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
        if (branch.code === 0 && branch.stdout.trim() === allowed.branch) return;
      }

      const ok = await confirmOverride(
        ctx,
        "git push --force detected",
        "Force pushing is forbidden by default. It rewrites shared history.\n\nDid the user explicitly ask to force push?",
      );
      if (!ok) {
        return {
          block: true,
          reason:
            "Force pushing is forbidden. Tell the user the push was rejected and ask how to proceed. " +
            "If the user explicitly asked to force push, ask them to confirm.",
        };
      }
    }

    // --- disable GPG/SSH signing ---
    if (/\bgit\s+commit\b/.test(cmd) && /(--no-gpg-sign\b|-n\b)/.test(cmd)) {
      return {
        block: true,
        reason:
          "Disabling commit signing is forbidden. The signing key is managed via 1Password. " +
          "If the commit fails due to signing, stop and ask the user to unlock 1Password.",
      };
    }
    if (/\bgit\b/.test(cmd) && /commit\.gpgSign\s*=\s*false/.test(cmd)) {
      return {
        block: true,
        reason:
          "Disabling commit signing via commit.gpgSign=false is forbidden. " +
          "Ask the user to resolve any signing issues instead.",
      };
    }
  });
}

async function confirmOverride(
  ctx: { hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> } },
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(title, message);
}
