import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Covers raster screenshots and the common image formats that should live in a
// PR description or external asset store rather than in source control.
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|ico|jpe?g|png|svg|tiff?|webp)$/i;

function invokesGitCommit(command: string): boolean {
  // Match a git shell segment that invokes `commit`, including global flags
  // such as `git -C app commit` and chained shell commands.
  return /(?:^|[;&|]\s*)(?:command\s+)?(?:\S+\/)?git\b[^;&|\n]*\bcommit(?:\s|$)/m.test(command);
}

function targetsAnotherDirectory(command: string): boolean {
  // This extension can safely inspect the session cwd. Fail closed rather than
  // letting an agent evade the guard by committing from a different checkout.
  return /\bgit\s+-C\s+/.test(command) || /\bcd\s+[^;&|]+&&/.test(command);
}

async function stagedImagePaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"],
    { cwd, encoding: "utf8" },
  );

  return stdout.split("\0").filter((path) => IMAGE_EXTENSION.test(path));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string | undefined;
    if (!command || !invokesGitCommit(command)) return;

    if (targetsAnotherDirectory(command)) {
      return {
        block: true,
        reason: "Blocked git commit from another directory because staged files cannot be verified for images. Run the commit from Pi's working directory.",
      };
    }

    try {
      const images = await stagedImagePaths(ctx.cwd);
      if (images.length === 0) return;

      const reason = [
        "Blocked commit containing image files:",
        ...images.map((path) => `  - ${path}`),
        "Upload screenshots outside the repository and reference them in the PR description instead.",
      ].join("\n");

      if (ctx.hasUI) ctx.ui.notify("Blocked a commit containing image files.", "warning");
      return { block: true, reason };
    } catch (error) {
      // A guard must fail closed: committing is unsafe when staged files could
      // not be inspected.
      return {
        block: true,
        reason: `Blocked git commit because staged files could not be checked for images: ${String(error)}`,
      };
    }
  });
}
