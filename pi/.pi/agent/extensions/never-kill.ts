/**
 * Global process-safety gate.
 *
 * Never let Pi execute process-termination commands. This protects services
 * already running on the workstation, whether a command comes from the agent's
 * bash tool or a user-entered `!` / `!!` shell command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Match a command-name token (including common absolute paths), but not prose
// such as `echo kill` or a filename such as `skill.ts`.
const processTerminationCommand = /(?:^|[;&|()]+|\$\(|\n)\s*(?:(?:command|env|sudo|nohup|nice|time)\s+)*(?:\S+\/)?(?:kill|pkill|killall)(?=\s|$|[;&|()])/i;

function blockReason(command: string): string {
  return `Process termination is not permissible: blocked to protect user-owned running services. Command: ${command}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (processTerminationCommand.test(command)) {
      return {
        block: true,
        reason: `${blockReason(command)}\nOnly this command was denied. Continue the task with a safe alternative that does not terminate processes. Do not retry process termination through another tool or command.`,
      };
    }
  });

  // The bash tool gate does not cover commands typed directly with `!` or `!!`.
  pi.on("user_bash", (event) => {
    if (!processTerminationCommand.test(event.command)) return;

    return {
      result: {
        output: blockReason(event.command),
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
