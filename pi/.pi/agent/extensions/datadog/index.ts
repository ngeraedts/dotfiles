/**
 * Datadog Extension for Pi — uses Datadog's remote MCP server
 *
 * Authenticates via OAuth 2.0 (browser-based, PKCE, dynamic client
 * registration — no API/App keys and no client secret needed).
 * Talks to https://mcp.datadoghq.com/v1/mcp using the MCP Streamable HTTP
 * protocol and proxies the server's tools (logs, metrics, APM, monitors, …).
 *
 * Usage:
 *   /datadog-auth    — Authenticate with Datadog via browser
 *   /datadog-tools   — List the tools the MCP server exposes
 *   /datadog-logout  — Remove stored credentials
 *   Then use the `datadog` tool normally.
 *
 * Config (optional, via env):
 *   DD_MCP_ENDPOINT  — override the MCP endpoint
 *                      (default https://mcp.datadoghq.com/v1/mcp)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";

const MCP_ENDPOINT = process.env.DD_MCP_ENDPOINT || "https://mcp.datadoghq.com/v1/mcp";
const TOKEN_FILE = path.join(os.homedir(), ".pi", "datadog-tokens.json");
const CALLBACK_PORT = 9877;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const CLIENT_NAME = "pi-datadog";

// --- Token storage ---

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  client_id: string;
  // Discovered OAuth endpoints, cached alongside the tokens so refresh works
  // without re-discovery.
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
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

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

/**
 * Build the candidate authorization-server metadata URLs for an issuer, in
 * priority order. Per RFC 8414, when the issuer has a path component the
 * well-known segment is inserted between host and path
 * (https://host/.well-known/oauth-authorization-server/PATH); we also try the
 * path-appended and origin-level variants, plus the OpenID Connect equivalents,
 * since deployments differ (Datadog serves several of these).
 */
function metadataCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const pathPart = u.pathname.replace(/\/$/, ""); // "" or "/v1/mcp"
  const candidates: string[] = [];
  for (const wk of ["oauth-authorization-server", "openid-configuration"]) {
    if (pathPart) {
      candidates.push(`${u.origin}/.well-known/${wk}${pathPart}`); // RFC 8414 insertion
      candidates.push(`${u.origin}${pathPart}/.well-known/${wk}`); // path-appended
    }
    candidates.push(`${u.origin}/.well-known/${wk}`); // origin-level
  }
  return [...new Set(candidates)];
}

/**
 * Discover the OAuth endpoints for the MCP server.
 *
 * Per the MCP authorization spec, the resource server advertises its
 * authorization server via RFC 9728 (protected-resource metadata); the
 * authorization server then advertises its endpoints via RFC 8414.
 */
async function discoverOAuth(): Promise<OAuthMetadata> {
  const url = new URL(MCP_ENDPOINT);

  // 1) Find the authorization server via protected-resource metadata.
  //    Try both the origin-level and path-scoped well-known locations.
  let issuer = url.origin;
  for (const prmUrl of [
    `${url.origin}/.well-known/oauth-protected-resource`,
    `${url.origin}${url.pathname.replace(/\/$/, "")}/.well-known/oauth-protected-resource`,
  ]) {
    try {
      const prm = await fetch(prmUrl, { headers: { Accept: "application/json" } });
      if (prm.ok) {
        const data = (await prm.json()) as any;
        const servers: string[] = data.authorization_servers ?? [];
        if (servers.length > 0) {
          issuer = servers[0].replace(/\/$/, "");
          break;
        }
      }
    } catch {}
  }

  // 2) Fetch authorization-server metadata (RFC 8414 / OIDC discovery).
  for (const wellKnown of metadataCandidates(issuer)) {
    try {
      const res = await fetch(wellKnown, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.authorization_endpoint && data.token_endpoint) {
          return {
            authorization_endpoint: data.authorization_endpoint,
            token_endpoint: data.token_endpoint,
            registration_endpoint: data.registration_endpoint,
            scopes_supported: data.scopes_supported,
          };
        }
      }
    } catch {}
  }

  throw new Error(
    `Could not discover Datadog OAuth endpoints from ${issuer}. ` +
      "The MCP server may be unreachable, or DD_MCP_ENDPOINT may be misconfigured.",
  );
}

async function registerClient(meta: OAuthMetadata): Promise<string> {
  if (!meta.registration_endpoint) {
    throw new Error(
      "This Datadog authorization server does not support dynamic client registration. " +
        "Set DD_OAUTH_CLIENT_ID to a pre-registered client_id.",
    );
  }
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [CALLBACK_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.client_id;
}

async function exchangeCode(
  meta: OAuthMetadata,
  code: string,
  clientId: string,
  codeVerifier: string,
): Promise<TokenData> {
  const res = await fetch(meta.token_endpoint, {
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
  const data = (await res.json()) as any;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    client_id: clientId,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
  };
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const res = await fetch(tokens.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

// --- OAuth browser flow ---

function runOAuthFlow(meta: OAuthMetadata, clientId: string): Promise<TokenData> {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePKCE();
    const state = base64url(crypto.randomBytes(16));

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", CALLBACK_URI);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (meta.scopes_supported?.length) {
      authUrl.searchParams.set("scope", meta.scopes_supported.join(" "));
    }

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

      exchangeCode(meta, code!, clientId, verifier).then(resolve, reject);
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${opener} "${authUrl.toString()}"`);
    });

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
  if (!tokens) throw new Error("Not authenticated. Run /datadog-auth first.");

  // Refresh if expired (with 60s buffer)
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      saveTokens(tokens);
    } catch {
      clearTokens();
      throw new Error("Token expired and refresh failed. Run /datadog-auth to re-authenticate.");
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

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (!res.ok) {
    if (res.status === 401) {
      clearTokens();
      sessionId = undefined;
      throw new Error("Authentication expired. Run /datadog-auth to re-authenticate.");
    }
    throw new Error(`MCP request failed: ${res.status} ${await res.text()}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Handle SSE responses
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    let lastData = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) lastData = line.slice(6);
    }
    if (lastData) {
      const parsed = JSON.parse(lastData);
      if (parsed.error) {
        throw new Error(`MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
      }
      return parsed.result ?? parsed;
    }
    return null;
  }

  const json = (await res.json()) as any;
  if (json.error) {
    throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result ?? json;
}

async function ensureInitialized(): Promise<void> {
  if (sessionId) return;

  await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
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

async function callTool(name: string, args: any): Promise<any> {
  await ensureInitialized();
  return mcpRequest("tools/call", { name, arguments: args });
}

async function listTools(): Promise<any[]> {
  await ensureInitialized();
  const result = await mcpRequest("tools/list", {});
  return result?.tools ?? [];
}

// Cache the tool catalog for the lifetime of the session so list_tools /
// describe_tool / max_tokens defaulting don't each re-fetch the full schema.
let toolsCache: any[] | undefined;
async function getTools(): Promise<any[]> {
  if (!toolsCache) toolsCache = await listTools();
  return toolsCache;
}

// Default max_tokens we inject when the caller omits it, to keep responses lean.
// Datadog's own defaults are 5000–10000; callers can always pass a larger value
// explicitly when they genuinely need more.
const DEFAULT_MAX_TOKENS = 4000;

function firstSentence(text: string | undefined, cap = 160): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  const end = oneLine.indexOf(". ");
  const sentence = end === -1 ? oneLine : oneLine.slice(0, end + 1);
  return sentence.length > cap ? sentence.slice(0, cap - 1) + "…" : sentence;
}

// --- Extension ---

export default function datadogExtension(pi: ExtensionAPI) {
  // Auth command
  pi.registerCommand("datadog-auth", {
    description: "Authenticate with Datadog via browser (OAuth)",
    handler: async (_args, ctx) => {
      try {
        const existing = loadTokens();
        if (existing) {
          const reauth = await ctx.ui.confirm(
            "Already authenticated",
            "You already have Datadog credentials stored. Re-authenticate?",
          );
          if (!reauth) return;
        }

        ctx.ui.notify("Discovering Datadog OAuth endpoints...", "info");
        const meta = await discoverOAuth();

        let clientId = process.env.DD_OAUTH_CLIENT_ID;
        if (!clientId) {
          ctx.ui.notify("Registering OAuth client...", "info");
          clientId = await registerClient(meta);
        }

        ctx.ui.notify("Opening browser for Datadog authorization...", "info");
        const tokens = await runOAuthFlow(meta, clientId);
        saveTokens(tokens);

        sessionId = undefined; // Reset MCP session
        ctx.ui.notify("✓ Datadog authenticated successfully!", "success");
      } catch (err: any) {
        ctx.ui.notify(`Auth failed: ${err.message}`, "error");
      }
    },
  });

  // Logout command
  pi.registerCommand("datadog-logout", {
    description: "Remove stored Datadog credentials",
    handler: async (_args, ctx) => {
      clearTokens();
      sessionId = undefined;
      ctx.ui.notify("Datadog credentials removed.", "info");
    },
  });

  // Discover available tools
  pi.registerCommand("datadog-tools", {
    description: "List available Datadog MCP tools",
    handler: async (_args, ctx) => {
      try {
        const tools = await listTools();
        const lines = tools.map((t: any) => `• ${t.name}: ${t.description ?? "(no description)"}`);
        ctx.ui.notify(`Datadog MCP tools (${tools.length}):\n${lines.join("\n")}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // Generic tool that proxies any Datadog MCP tool call
  pi.registerTool({
    name: "datadog",
    label: "Datadog",
    description:
      "Call any Datadog MCP tool for debugging — search logs, query metrics, " +
      "inspect APM traces/spans, list monitors, search events, and more. First " +
      "call with tool='list_tools' (or run /datadog-tools) for a terse one-line " +
      "catalog, then tool='describe_tool' with args={name} for one tool's full " +
      "parameter schema, then call the tool by name.",
    promptSnippet:
      "Query Datadog (logs, metrics, APM, monitors) via the Datadog MCP server. Discover tools with tool='list_tools'.",
    promptGuidelines: [
      "Use the datadog tool to investigate production behaviour — logs, metrics, APM spans/traces, and monitors. The 'tool' parameter selects which Datadog MCP tool to call, and 'args' carries its parameters.",
      "Before calling a specific datadog tool, if you don't know what's available, call the datadog tool with tool='list_tools' and empty args to discover them and their schemas.",
      "If the datadog tool reports it is not authenticated, ask the user to run /datadog-auth.",
      "When the datadog tool returns zero results for a specific identifier (issue id, trace id, error type), NEVER substitute a different error from the same service/time window and present it as the answer. Either widen the search for that exact identifier, switch data sources (logs vs spans), or report that you could not find it — do not fabricate a root cause from adjacent data.",
      "When investigating a datadog error/issue, search BOTH logs and APM spans for the identifier in parallel before drawing conclusions. Many backend errors (EventBus/queue consumers, Oban jobs, async workers) are only emitted as logs and never become indexed APM error spans, so a spans-only search will return nothing.",
      "For Datadog error-tracking monitors, the alerting group exposes an issue id. That issue id appears as the bare attribute 'issue.id' on logs and as '@issue.id' on spans/RUM (no '@' for logs). If error-tracking issue lookup tools are unavailable, find the issue by querying logs for 'issue.id:<uuid>' and spans for '@issue.id:<uuid>'.",
      "Before claiming a datadog finding is the root cause, verify the identifier on the matched telemetry actually equals the one you were asked about. If it differs, say so explicitly rather than presenting it as the answer.",
      "Keep datadog responses lean to conserve context: prefer aggregate_* tools (counts/group-bys) over raw search_* dumps when you only need to locate or quantify; reach for raw spans/logs only once you've narrowed to a specific issue. The wrapper injects a small max_tokens default — only pass a larger max_tokens when you genuinely need more rows.",
      "Avoid broad attribute wildcards on datadog span/log searches (e.g. custom_attributes=['*'] or extra_fields=['*']). APM spans repeat large infrastructure tag blocks; request only the specific attributes you need (e.g. ['error.*','issue.*','graphql*']) to avoid flooding context.",
    ],
    parameters: Type.Object({
      tool: Type.String({
        description:
          "Datadog MCP tool name to call. Use 'list_tools' to discover available tools and their parameters.",
      }),
      args: Type.Optional(
        Type.Any({ description: "Arguments for the tool (tool-specific). Use 'list_tools' to see schemas." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const tokens = loadTokens();
      if (!tokens) {
        return {
          content: [
            { type: "text", text: "Not authenticated with Datadog. Ask the user to run /datadog-auth first." },
          ],
          isError: true,
        };
      }

      try {
        // Terse catalog: one line per tool (name + first sentence). Keeps the
        // discovery call from dumping ~25 full parameter schemas into context.
        if (params.tool === "list_tools") {
          const tools = await getTools();
          const lines = tools
            .map((t: any) => `${t.name}: ${firstSentence(t.description)}`)
            .sort();
          return {
            content: [
              {
                type: "text",
                text:
                  lines.join("\n") +
                  "\n\nFor a tool's full parameter schema, call tool='describe_tool' with args={\"name\":\"<tool>\"}.",
              },
            ],
            details: { count: lines.length },
          };
        }

        let args = params.args ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            /* leave as-is */
          }
        }

        // Full schema for a single tool, on demand.
        if (params.tool === "describe_tool") {
          const name = args?.name;
          if (!name) {
            return {
              content: [{ type: "text", text: "describe_tool requires args={\"name\":\"<tool>\"}." }],
              isError: true,
            };
          }
          const tool = (await getTools()).find((t: any) => t.name === name);
          if (!tool) {
            return {
              content: [{ type: "text", text: `Unknown Datadog tool: ${name}. Use tool='list_tools' to see available tools.` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                  null,
                  2,
                ),
              },
            ],
            details: { tool: name },
          };
        }

        // Inject a lean max_tokens default when the caller omitted it and the
        // target tool actually accepts max_tokens. Explicit caller values win.
        if (args && typeof args === "object" && args.max_tokens === undefined) {
          const tool = (await getTools()).find((t: any) => t.name === params.tool);
          if (tool?.inputSchema?.properties?.max_tokens) {
            args = { ...args, max_tokens: DEFAULT_MAX_TOKENS };
          }
        }

        const result = await callTool(params.tool, args);

        const content = result?.content ?? [];
        const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);

        return {
          content: [
            {
              type: "text",
              text: textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result, null, 2),
            },
          ],
          details: { tool: params.tool, isError: result?.isError ?? false },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Datadog MCP error: ${err.message}` }],
          isError: true,
        };
      }
    },
  });
}
