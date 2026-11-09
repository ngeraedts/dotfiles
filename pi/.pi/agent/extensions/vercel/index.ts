/**
 * Vercel MCP integration for Pi.
 *
 * Commands:
 *   /vercel-auth    Connect a Vercel account in the browser
 *   /vercel-logout  Remove local OAuth credentials
 *   /vercel-tools   Inspect the remote MCP tool catalog
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const MCP_ENDPOINT = process.env.VERCEL_MCP_ENDPOINT ?? "https://mcp.vercel.com/";
const TOKEN_FILE = path.join(os.homedir(), ".pi", "agent", "vercel-tokens.json");
const CALLBACK_PORT = 9879;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const CLIENT_NAME = "pi-vercel";
const MAX_RESULT_CHARS = 20_000;

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenEndpoint: string;
}

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { message?: string };
}

let sessionId: string | undefined;
let toolsCache: McpTool[] | undefined;

function loadTokens(): TokenData | undefined {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as TokenData;
  } catch {
    return undefined;
  }
}

function saveTokens(tokens: TokenData): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function clearTokens(): void {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

function resetSession(): void {
  sessionId = undefined;
  toolsCache = undefined;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOAuthMetadata(value: unknown): OAuthMetadata {
  if (!isRecord(value) || typeof value.authorization_endpoint !== "string" ||
    typeof value.token_endpoint !== "string" || typeof value.registration_endpoint !== "string") {
    throw new Error("Vercel OAuth metadata is incomplete.");
  }
  return {
    authorization_endpoint: value.authorization_endpoint,
    token_endpoint: value.token_endpoint,
    registration_endpoint: value.registration_endpoint,
    scopes_supported: Array.isArray(value.scopes_supported)
      ? value.scopes_supported.filter((scope): scope is string => typeof scope === "string")
      : undefined,
  };
}

async function discoverOAuth(): Promise<OAuthMetadata> {
  const endpoint = new URL(MCP_ENDPOINT);
  const endpointPath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
  const resourceMetadataUrl = new URL(
    `/.well-known/oauth-protected-resource${endpointPath}`,
    endpoint.origin,
  );
  const resourceMetadata = await fetchJson(resourceMetadataUrl.toString());
  if (!isRecord(resourceMetadata) || !Array.isArray(resourceMetadata.authorization_servers) ||
    typeof resourceMetadata.authorization_servers[0] !== "string") {
    throw new Error("Vercel MCP did not advertise an OAuth authorization server.");
  }
  const issuer = resourceMetadata.authorization_servers[0].replace(/\/$/, "");
  return asOAuthMetadata(await fetchJson(`${issuer}/.well-known/oauth-authorization-server`));
}

function requestedScopes(metadata: OAuthMetadata): string[] {
  const desired = ["openid", "offline_access"];
  if (!metadata.scopes_supported) return desired;
  const supported = new Set(metadata.scopes_supported);
  return desired.filter((scope) => supported.has(scope));
}

async function registerClient(metadata: OAuthMetadata, scopes: string[]): Promise<string> {
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [CALLBACK_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes.join(" "),
    }),
  });
  if (!response.ok) throw new Error(`OAuth client registration failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!isRecord(result) || typeof result.client_id !== "string") {
    throw new Error("Vercel OAuth registration did not return a client ID.");
  }
  return result.client_id;
}

async function exchangeCode(
  metadata: OAuthMetadata,
  clientId: string,
  code: string,
  verifier: string,
): Promise<TokenData> {
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_ENDPOINT,
    }),
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!isRecord(result) || typeof result.access_token !== "string") {
    throw new Error("Vercel OAuth token exchange did not return an access token.");
  }
  return {
    accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : undefined,
    expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1_000 : undefined,
    clientId,
    tokenEndpoint: metadata.token_endpoint,
  };
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  if (!tokens.refreshToken) throw new Error("No OAuth refresh token is available.");
  const response = await fetch(tokens.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: MCP_ENDPOINT,
    }),
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!isRecord(result) || typeof result.access_token !== "string") {
    throw new Error("Vercel OAuth refresh did not return an access token.");
  }
  return {
    ...tokens,
    accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : tokens.refreshToken,
    expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1_000 : undefined,
  };
}

function authenticateInBrowser(metadata: OAuthMetadata, clientId: string, scopes: string[]): Promise<TokenData> {
  return new Promise((resolve, reject) => {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", CALLBACK_URI);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("scope", scopes.join(" "));
    authorizationUrl.searchParams.set("resource", MCP_ENDPOINT);

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      callback();
    };
    const server = http.createServer(async (request, response) => {
      const callbackUrl = new URL(request.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (callbackUrl.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = callbackUrl.searchParams.get("code");
      const error = callbackUrl.searchParams.get("error");
      if (error || !code || callbackUrl.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end("<h2>Vercel authorization failed</h2><p>You can close this tab.</p>");
        finish(() => reject(new Error(error ?? "OAuth callback was invalid.")));
        return;
      }
      try {
        const tokens = await exchangeCode(metadata, clientId, code, verifier);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<h2>Vercel authorized</h2><p>You can close this tab and return to Pi.</p>");
        finish(() => resolve(tokens));
      } catch (error: unknown) {
        response.writeHead(500, { "Content-Type": "text/html" });
        response.end("<h2>Vercel token exchange failed</h2><p>You can close this tab.</p>");
        finish(() => reject(error));
      }
    });
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Vercel authorization timed out after two minutes."))),
      120_000,
    );

    server.once("error", (error) => finish(() => reject(error)));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32"
        ? ["/c", "start", "", authorizationUrl.toString()]
        : [authorizationUrl.toString()];
      execFile(opener, args, (error) => {
        if (error) finish(() => reject(new Error(`Could not open the browser: ${error.message}`)));
      });
    });
  });
}

async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run /vercel-auth first.");
  if (tokens.expiresAt && Date.now() >= tokens.expiresAt - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      saveTokens(tokens);
    } catch (error: unknown) {
      clearTokens();
      resetSession();
      throw new Error(`Vercel authentication expired and refresh failed. Run /vercel-auth again. ${String(error)}`);
    }
  }
  return tokens.accessToken;
}

function parseSse(text: string, requestId: string): JsonRpcResponse {
  const messages = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRpcResponse & { id?: string }];
      } catch {
        return [];
      }
    });
  return messages.find((message) => message.id === requestId) ?? messages.at(-1) ?? {};
}

async function mcpRequest(method: string, params: unknown = {}): Promise<unknown> {
  const token = await getAccessToken();
  const requestId = crypto.randomUUID();
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  });
  const responseSessionId = response.headers.get("mcp-session-id");
  if (responseSessionId) sessionId = responseSessionId;
  if (!response.ok) {
    if (response.status === 401) resetSession();
    throw new Error(`MCP request failed: ${response.status} ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? parseSse(await response.text(), requestId)
    : await response.json() as JsonRpcResponse;
  if (payload.error) throw new Error(payload.error.message ?? "Vercel MCP returned an error.");
  return payload.result ?? payload;
}

async function ensureInitialized(): Promise<void> {
  if (sessionId) return;
  await mcpRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
  });
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
}

function toolsFromResult(value: unknown): McpTool[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) return [];
  return value.tools.filter((tool): tool is McpTool => isRecord(tool) && typeof tool.name === "string");
}

async function getTools(): Promise<McpTool[]> {
  if (!toolsCache) {
    await ensureInitialized();
    toolsCache = toolsFromResult(await mcpRequest("tools/list"));
  }
  return toolsCache;
}

async function callTool(name: string, args: unknown): Promise<unknown> {
  await ensureInitialized();
  return mcpRequest("tools/call", { name, arguments: args });
}

function compact(text: string, limit = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function capResult(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated at ${MAX_RESULT_CHARS.toLocaleString()} characters. Narrow the Vercel query before retrying.]`;
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return JSON.stringify(result, null, 2);
  const text = result.content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []);
  return text.join("\n") || JSON.stringify(result, null, 2);
}

export default function vercelExtension(pi: ExtensionAPI) {
  pi.registerCommand("vercel-auth", {
    description: "Authenticate with Vercel for deployment troubleshooting",
    handler: async (_args, ctx) => {
      try {
        if (loadTokens() && !await ctx.ui.confirm("Vercel is already authenticated", "Re-authenticate?")) return;
        ctx.ui.notify("Discovering Vercel OAuth configuration…", "info");
        const metadata = await discoverOAuth();
        const scopes = requestedScopes(metadata);
        const clientId = await registerClient(metadata, scopes);
        ctx.ui.notify("Opening Vercel authorization in your browser…", "info");
        saveTokens(await authenticateInBrowser(metadata, clientId, scopes));
        resetSession();
        ctx.ui.notify("Vercel authenticated. Deployment troubleshooting tools are ready.", "success");
      } catch (error: unknown) {
        ctx.ui.notify(`Vercel authentication failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("vercel-logout", {
    description: "Remove stored Vercel OAuth credentials",
    handler: async (_args, ctx) => {
      clearTokens();
      resetSession();
      ctx.ui.notify("Stored Vercel credentials removed.", "info");
    },
  });

  pi.registerCommand("vercel-tools", {
    description: "List tools exposed by the Vercel MCP server",
    handler: async (_args, ctx) => {
      try {
        const tools = await getTools();
        ctx.ui.notify(tools.map((tool) => `• ${tool.name}: ${compact(tool.description ?? "")}`).join("\n"), "info");
      } catch (error: unknown) {
        ctx.ui.notify(`Could not list Vercel tools: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "vercel",
    label: "Vercel",
    description: "Troubleshoot Vercel deployments through Vercel's remote MCP server. Discover available tools before calling one.",
    promptSnippet: "Inspect Vercel deployments, build logs, projects, and platform documentation",
    promptGuidelines: [
      "Use the vercel tool for Vercel deployment troubleshooting. Call tool='list_tools' first, then tool='describe_tool' before calling an unfamiliar Vercel MCP tool.",
      "Prefer narrow, read-only Vercel queries for deployment investigations: identify the affected deployment, inspect its status and logs, then report the verified failure.",
      "Do not invoke Vercel mutation, deployment, deletion, environment-variable, or project-setting tools unless the user explicitly requests that action.",
      "If Vercel is not authenticated, ask the user to run /vercel-auth.",
    ],
    parameters: Type.Object({
      tool: Type.String({ description: "Vercel MCP tool name, or 'list_tools'/'describe_tool' for discovery." }),
      args: Type.Optional(Type.Unknown({ description: "Arguments for the selected Vercel MCP tool." })),
    }),
    async execute(_toolCallId, params) {
      if (!loadTokens()) {
        throw new Error("Vercel is not authenticated. Ask the user to run /vercel-auth.");
      }
      try {
        if (params.tool === "list_tools") {
          const tools = await getTools();
          return {
            content: [{ type: "text", text: tools.map((tool) => `${tool.name}: ${compact(tool.description ?? "")}`).join("\n") }],
            details: { count: tools.length },
          };
        }
        if (params.tool === "describe_tool") {
          if (!isRecord(params.args) || typeof params.args.name !== "string") {
            throw new Error("describe_tool requires args={ name: '<tool name>' }.");
          }
          const tool = (await getTools()).find((candidate) => candidate.name === params.args.name);
          if (!tool) throw new Error(`Unknown Vercel MCP tool: ${params.args.name}`);
          return {
            content: [{ type: "text", text: JSON.stringify(tool, null, 2) }],
            details: { tool: tool.name },
          };
        }
        const result = await callTool(params.tool, params.args ?? {});
        return {
          content: [{ type: "text", text: capResult(resultText(result)) }],
          details: { tool: params.tool },
        };
      } catch (error: unknown) {
        throw new Error(`Vercel MCP error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
