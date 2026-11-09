/**
 * Notion Extension for Pi — uses Notion's remote MCP server
 *
 * Authenticates via OAuth (browser-based, no admin permissions needed).
 * Talks to https://mcp.notion.com/mcp using MCP Streamable HTTP protocol.
 *
 * Usage:
 *   /notion-auth   — Authenticate with Notion via browser
 *   Then use notion_* tools normally
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MCP_ENDPOINT = "https://mcp.notion.com/mcp";
const AUTH_SERVER = "https://mcp.notion.com";
const TOKEN_FILE = path.join(os.homedir(), ".pi", "notion-tokens.json");
const CALLBACK_PORT = 9876;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

// --- Token storage ---

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  client_id: string;
}

function loadTokens(): TokenData | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveTokens(data: TokenData): void {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearTokens(): void {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

// --- OAuth helpers ---

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function registerClient(): Promise<string> {
  const res = await fetch(`${AUTH_SERVER}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pi-notion",
      redirect_uris: [CALLBACK_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.client_id;
}

async function exchangeCode(
  code: string,
  clientId: string,
  codeVerifier: string
): Promise<TokenData> {
  const res = await fetch(`${AUTH_SERVER}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    client_id: clientId,
  };
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const res = await fetch(`${AUTH_SERVER}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    client_id: tokens.client_id,
  };
}

// --- OAuth browser flow ---

function runOAuthFlow(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePKCE();
    const state = base64url(crypto.randomBytes(16));

    const authUrl = new URL(`${AUTH_SERVER}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", CALLBACK_URI);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>State mismatch</h2><p>Please try again.</p></body></html>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>✓ Authorized!</h2><p>You can close this tab and return to Pi.</p></body></html>");
      server.close();

      exchangeCode(code!, clientId, verifier).then(
        (tokens) => {
          saveTokens(tokens);
          resolve(tokens.access_token);
        },
        reject
      );
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      // Open browser
      const open =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      require("node:child_process").exec(`${open} "${authUrl.toString()}"`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out (2 minutes)"));
    }, 120_000);
  });
}

// --- MCP client ---

let sessionId: string | undefined;

async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run /notion-auth first.");

  // Refresh if expired (with 60s buffer)
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      saveTokens(tokens);
    } catch {
      clearTokens();
      throw new Error("Token expired and refresh failed. Run /notion-auth to re-authenticate.");
    }
  }

  return tokens.access_token;
}

async function mcpRequest(method: string, params: any = {}): Promise<any> {
  const token = await getAccessToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params,
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (!res.ok) {
    if (res.status === 401) {
      clearTokens();
      sessionId = undefined;
      throw new Error("Authentication expired. Run /notion-auth to re-authenticate.");
    }
    throw new Error(`MCP request failed: ${res.status} ${await res.text()}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Handle SSE responses
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }
    if (lastData) {
      const parsed = JSON.parse(lastData);
      return parsed.result ?? parsed;
    }
    return null;
  }

  const json = await res.json() as any;
  if (json.error) {
    throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result ?? json;
}

async function ensureInitialized(): Promise<void> {
  if (!sessionId) {
    await mcpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pi-notion", version: "1.0.0" },
    });
    // Send initialized notification (no id, no response expected)
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }
}

async function callTool(name: string, args: any): Promise<any> {
  await ensureInitialized();
  return mcpRequest("tools/call", { name, arguments: args });
}

async function listTools(): Promise<any[]> {
  await ensureInitialized();
  const result = await mcpRequest("tools/list", {});
  return result?.tools ?? [];
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Auth command
  pi.registerCommand("notion-auth", {
    description: "Authenticate with Notion via browser (OAuth)",
    handler: async (_args, ctx) => {
      try {
        const existing = loadTokens();
        if (existing) {
          const reauth = await ctx.ui.confirm(
            "Already authenticated",
            "You already have Notion credentials stored. Re-authenticate?"
          );
          if (!reauth) return;
        }

        ctx.ui.notify("Registering OAuth client...", "info");
        const clientId = await registerClient();

        ctx.ui.notify("Opening browser for Notion authorization...", "info");
        await runOAuthFlow(clientId);

        sessionId = undefined; // Reset MCP session
        ctx.ui.notify("✓ Notion authenticated successfully!", "success");
      } catch (err: any) {
        ctx.ui.notify(`Auth failed: ${err.message}`, "error");
      }
    },
  });

  // Logout command
  pi.registerCommand("notion-logout", {
    description: "Remove stored Notion credentials",
    handler: async (_args, ctx) => {
      clearTokens();
      sessionId = undefined;
      ctx.ui.notify("Notion credentials removed.", "info");
    },
  });

  // Command to discover available tools
  pi.registerCommand("notion-tools", {
    description: "List available Notion MCP tools",
    handler: async (_args, ctx) => {
      try {
        const tools = await listTools();
        const lines = tools.map(
          (t: any) => `• ${t.name}: ${t.description ?? "(no description)"}`
        );
        ctx.ui.notify(`Notion MCP tools (${tools.length}):\n${lines.join("\n")}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // Generic tool that proxies any Notion MCP tool call
  pi.registerTool({
    name: "notion",
    label: "Notion",
    description:
      "Call any Notion MCP tool. First run /notion-tools to discover available tools and their parameters. " +
      "Common tools: notion_search (search pages/databases), notion_read_page (read page content), " +
      "notion_create_page (create a page), notion_update_page (update a page), " +
      "notion_append_blocks (add content to a page), notion_read_comments, notion_add_comment.",
    promptSnippet: "Read and write Notion docs via the Notion MCP server. Run /notion-tools to discover available tools.",
    promptGuidelines: [
      "Use the notion tool to interact with Notion. The 'tool' parameter specifies which Notion MCP tool to call, and 'args' contains tool-specific parameters.",
      "Before using the notion tool, if you don't know which tools are available, call it with tool='list_tools' and empty args to discover them.",
    ],
    parameters: Type.Object({
      tool: Type.String({
        description:
          "Notion MCP tool name to call (e.g. 'notion_search', 'notion_read_page'). Use 'list_tools' to discover available tools.",
      }),
      args: Type.Optional(
        Type.Any({
          description: "Arguments for the tool (tool-specific). Check /notion-tools for available parameters.",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const tokens = loadTokens();
      if (!tokens) {
        return {
          content: [
            {
              type: "text",
              text: "Not authenticated with Notion. Ask the user to run /notion-auth first.",
            },
          ],
          isError: true,
        };
      }

      try {
        if (params.tool === "list_tools") {
          const tools = await listTools();
          const result = tools.map((t: any) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { count: result.length },
          };
        }

        let args = params.args ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { /* leave as-is */ }
        }

        const result = await callTool(params.tool, args);

        // Extract text content from MCP tool result
        const content = result?.content ?? [];
        const textParts = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);

        return {
          content: [
            {
              type: "text",
              text: textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result, null, 2),
            },
          ],
          details: { tool: params.tool },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Notion MCP error: ${err.message}` }],
          isError: true,
        };
      }
    },
  });
}
