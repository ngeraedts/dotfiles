import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "git-status";
const REFRESH_INTERVAL_MS = 2_000;

type GitStatus = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
};

/** Show the current repository state in pi's footer. */
export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight = false;

  const refresh = async (ctx: ExtensionContext) => {
    if (refreshInFlight) return;
    refreshInFlight = true;

    try {
      const result = await pi.exec(
        "git",
        ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
        { cwd: ctx.cwd, timeout: 1_500 },
      );

      if (result.code !== 0) {
        ctx.ui.setStatus(STATUS_ID, "git: not a repository");
        return;
      }

      ctx.ui.setStatus(STATUS_ID, formatStatus(parseStatus(result.stdout)));
    } catch {
      // Git status is ancillary UI; do not interrupt the current session if it fails.
      ctx.ui.setStatus(STATUS_ID, "git: unavailable");
    } finally {
      refreshInFlight = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
    refreshTimer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
  });

  // Refresh promptly after pi or the user runs a command that may change the tree.
  pi.on("tool_execution_end", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("user_bash", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    ctx.ui.setStatus(STATUS_ID, undefined);
  });

  pi.registerCommand("git-status", {
    description: "Refresh the git status footer",
    handler: async (_args, ctx) => {
      await refresh(ctx);
      ctx.ui.notify("Git status refreshed", "info");
    },
  });
}

function parseStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: "(detached)",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      status.branch = line.slice("# branch.head ".length) || "(detached)";
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+?(\d+)\s+-(\d+)/);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("u ")) {
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const index = xy[0];
      const worktree = xy[1];

      if (line.startsWith("u ") || (index === "U" && worktree === "U")) {
        status.conflicts += 1;
      }
      if (index !== "." && index !== "U") status.staged += 1;
      if (worktree !== "." && worktree !== "U") status.unstaged += 1;
    } else if (line.startsWith("? ")) {
      status.untracked += 1;
    }
  }

  return status;
}

function formatStatus(status: GitStatus): string {
  const parts = [`git: ${status.branch}`];

  if (status.upstream) {
    if (status.ahead) parts.push(`↑${status.ahead}`);
    if (status.behind) parts.push(`↓${status.behind}`);
    if (!status.ahead && !status.behind) parts.push("up to date");
  } else {
    parts.push("no upstream");
  }

  if (status.staged) parts.push(`${status.staged} staged`);
  if (status.unstaged) parts.push(`${status.unstaged} unstaged`);
  if (status.untracked) parts.push(`${status.untracked} untracked`);
  if (status.conflicts) parts.push(`⚠ ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`);
  if (!status.staged && !status.unstaged && !status.untracked && !status.conflicts) {
    parts.push("clean");
  }

  return parts.join(" · ");
}
