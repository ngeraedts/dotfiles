/**
 * PostHog Extension for Pi — proxies PostHog's remote MCP server.
 *
 * Usage:
 *   /posthog-auth    Authenticate in the browser with read-only analysis scopes
 *   /posthog-tools   List available MCP tools
 *   /posthog-logout  Remove stored OAuth credentials
 *
 * A POSTHOG_PERSONAL_API_KEY (phx_...) may be used instead of OAuth.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const MCP_ENDPOINT = process.env.POSTHOG_MCP_ENDPOINT || "https://mcp.posthog.com/mcp";
const TOKEN_FILE = path.join(os.homedir(), ".pi", "posthog-tokens.json");
const CALLBACK_PORT = 9878;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const CLIENT_NAME = "pi-posthog";

// Keep OAuth access read-only. HogQL and analytics execution use query:read.
const REQUESTED_SCOPES = [
  "account:read",
  "action:read",
  "alert:read",
  "annotation:read",
  "cohort:read",
  "customer_analytics:read",
  "dashboard:read",
  "data_catalog:read",
  "dataset:read",
  "early_access_feature:read",
  "engineering_analytics:read",
  "error_tracking:read",
  "event_definition:read",
  "experiment:read",
  "feature_flag:read",
  "group:read",
  "insight:read",
  "llm_analytics:read",
  "logs:read",
  "metrics:read",
  "organization:read",
  "organization_member:read",
  "person:read",
  "project:read",
  "property_definition:read",
  "query:read",
  "session_recording:read",
  "session_recording_playlist:read",
  "survey:read",
  "tracing:read",
  "usage_metric:read",
  "user:read",
  "warehouse_table:read",
  "warehouse_view:read",
  "web_analytics:read",
];

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  client_id: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
}

let sessionId: string | undefined;
let toolsCache: any[] | undefined;

function loadTokens(): TokenData | null {
  try {
    return fs.existsSync(TOKEN_FILE)
      ? (JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as TokenData)
      : null;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenData): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function clearTokens(): void {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function resetSession(): void {
  sessionId = undefined;
  toolsCache = undefined;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function discoverOAuth(): Promise<OAuthMetadata> {
  const endpoint = new URL(MCP_ENDPOINT);
  const resourceMetadataUrl = `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname}`;
  const resourceMetadata = await fetchJson(resourceMetadataUrl);
  const issuer = resourceMetadata.authorization_servers?.[0];
  if (!issuer) throw new Error("PostHog did not advertise an OAuth authorization server.");

  const metadata = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) {
    throw new Error("PostHog OAuth metadata is incomplete.");
  }
  return metadata as OAuthMetadata;
}

function oauthScopes(metadata: OAuthMetadata): string[] {
  if (!metadata.scopes_supported) return REQUESTED_SCOPES;
  const supported = new Set(metadata.scopes_supported);
  return REQUESTED_SCOPES.filter((scope) => supported.has(scope));
}

async function registerClient(
  metadata: OAuthMetadata,
  scopes: string[],
): Promise<{ clientId: string; scopes: string[] }> {
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
  const body = (await response.json()) as any;
  return {
    clientId: body.client_id,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : scopes,
  };
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
  const body = (await response.json()) as any;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    client_id: clientId,
    token_endpoint: metadata.token_endpoint,
    revocation_endpoint: metadata.revocation_endpoint,
  };
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  if (!tokens.refresh_token) throw new Error("No OAuth refresh token is available.");
  const response = await fetch(tokens.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
      resource: MCP_ENDPOINT,
    }),
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as any;
  return {
    ...tokens,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
  };
}

function authenticateInBrowser(
  metadata: OAuthMetadata,
  clientId: string,
  scopes: string[],
): Promise<TokenData> {
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

      const error = callbackUrl.searchParams.get("error");
      const code = callbackUrl.searchParams.get("code");
      if (error || !code || callbackUrl.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end("<h2>PostHog authorization failed</h2><p>You can close this tab.</p>");
        finish(() => reject(new Error(error || "OAuth callback was invalid.")));
        return;
      }

      try {
        const tokens = await exchangeCode(metadata, clientId, code, verifier);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<h2>PostHog authorized</h2><p>You can close this tab and return to Pi.</p>");
        finish(() => resolve(tokens));
      } catch (exchangeError) {
        response.writeHead(500, { "Content-Type": "text/html" });
        response.end("<h2>PostHog token exchange failed</h2><p>You can close this tab.</p>");
        finish(() => reject(exchangeError));
      }
    });

    const timeout = setTimeout(
      () => finish(() => reject(new Error("PostHog authorization timed out after two minutes."))),
      120_000,
    );

    server.once("error", (error) => finish(() => reject(error)));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", authorizationUrl.toString()] : [authorizationUrl.toString()];
      execFile(opener, args, (error) => {
        if (error) finish(() => reject(new Error(`Could not open the browser: ${error.message}`)));
      });
    });
  });
}

async function getAccessToken(): Promise<string> {
  // Prefer explicitly authorized OAuth credentials. An ambient personal key may
  // have narrower scopes and should only be the fallback when OAuth is absent.
  let tokens = loadTokens();
  if (!tokens) {
    const environmentToken = process.env.POSTHOG_PERSONAL_API_KEY;
    if (environmentToken) return environmentToken;
    throw new Error("Not authenticated. Run /posthog-auth first.");
  }
  if (tokens.expires_at && Date.now() >= tokens.expires_at - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      saveTokens(tokens);
    } catch (error) {
      clearTokens();
      resetSession();
      throw new Error(`PostHog authentication expired and refresh failed. Run /posthog-auth again. ${String(error)}`);
    }
  }
  return tokens.access_token;
}

function parseSse(text: string, requestId: string): any {
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((value) => JSON.parse(value));
  return payloads.find((payload) => payload.id === requestId) ?? payloads.at(-1);
}

async function mcpRequest(method: string, params: any = {}): Promise<any> {
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
    : await response.json();
  if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  return payload?.result ?? payload;
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

async function listTools(): Promise<any[]> {
  await ensureInitialized();
  const result = await mcpRequest("tools/list");
  return result?.tools ?? [];
}

async function getTools(): Promise<any[]> {
  if (!toolsCache) toolsCache = await listTools();
  return toolsCache;
}

async function callTool(name: string, args: any): Promise<any> {
  await ensureInitialized();
  return mcpRequest("tools/call", { name, arguments: args });
}

function firstSentence(text?: string, limit = 180): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  const sentenceEnd = compact.indexOf(". ");
  const sentence = sentenceEnd === -1 ? compact : compact.slice(0, sentenceEnd + 1);
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

const MAX_RESULT_CHARS = 16_000;
const EXEC_USAGE = `PostHog exposes one gateway tool: exec.
Call it with args={"command":"<command>","context":"15-25 word third-person purpose"}.
Commands: search <terms>; info <tool>; schema <tool> <field>; call <tool> <json>.
Use search for unknown tools, info once per selected tool, and schema for fields marked with a hint.`;

function schemaType(schema: any): string {
  if (schema?.const !== undefined) return JSON.stringify(schema.const);
  if (schema?.type) return Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
  if (schema?.oneOf) return `oneOf(${schema.oneOf.length})`;
  if (schema?.anyOf) return `anyOf(${schema.anyOf.length})`;
  return "any";
}

function compactSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const required = new Set<string>(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([name, value]: [string, any]) => {
    const field: Record<string, any> = { name, type: schemaType(value) };
    if (required.has(name)) field.required = true;
    if (value.enum) field.enum = value.enum;
    if (value.default !== undefined) field.default = value.default;
    if (value.description) field.description = firstSentence(value.description, 220);
    if (value.properties || value.items || value.oneOf || value.anyOf) {
      field.hint = `Run schema <tool> ${name} before populating this complex field.`;
    }
    return field;
  });
  return { type: schemaType(schema), fields };
}

function parseInfoSchema(text: string): any | undefined {
  const marker = "inputSchema: ";
  const index = text.lastIndexOf(marker);
  if (index < 0) return undefined;
  let raw = text.slice(index + marker.length).trim();
  try {
    if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    let parsed = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function compactInfo(text: string): string {
  const name = text.match(/^name:\s*(.+)$/m)?.[1];
  const title = text.match(/^title:\s*(.+)$/m)?.[1];
  const schema = parseInfoSchema(text);
  if (!name || !schema) return text;

  return JSON.stringify(
    {
      name,
      title,
      description: firstSentence(text.match(/description:\s*(?:\|-\s*)?([\s\S]*?)(?:\nannotations:|\ninputSchema:)/)?.[1], 500),
      parameters: compactSchema(schema),
      note: "Fields with hints require a schema command before use.",
    },
    null,
    2,
  );
}

function compactSearch(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.matches)) return text;
    return JSON.stringify(
      {
        matches: parsed.matches,
        hidden_scope_gated_matches: parsed.scope_gated_matches?.length ?? 0,
      },
      null,
      2,
    );
  } catch {
    return text;
  }
}

function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated by the Pi PostHog extension at ${MAX_RESULT_CHARS.toLocaleString()} characters. Rerun with a narrower date range, filter, or lower limit.]`;
}

function compactExecOutput(command: string | undefined, text: string): string {
  const normalized = command?.trim() ?? "";
  if (normalized.startsWith("search ")) return capResult(compactSearch(text));
  if (/^info(?:\s+--json)?\s+/.test(normalized)) return capResult(compactInfo(text));
  return capResult(text);
}

function authenticated(): boolean {
  return Boolean(process.env.POSTHOG_PERSONAL_API_KEY || loadTokens());
}

export default function posthogExtension(pi: ExtensionAPI) {
  pi.registerCommand("posthog-auth", {
    description: "Authenticate with PostHog using read-only analysis scopes",
    handler: async (_args, ctx) => {
      try {
        if (loadTokens()) {
          const proceed = await ctx.ui.confirm("PostHog is already authenticated", "Re-authenticate?");
          if (!proceed) return;
        }
        ctx.ui.notify("Discovering PostHog OAuth configuration…", "info");
        const metadata = await discoverOAuth();
        const registration = await registerClient(metadata, oauthScopes(metadata));
        ctx.ui.notify("Opening PostHog authorization in your browser…", "info");
        const tokens = await authenticateInBrowser(
          metadata,
          registration.clientId,
          registration.scopes,
        );
        saveTokens(tokens);
        resetSession();
        ctx.ui.notify("PostHog authenticated with read-only analysis access.", "success");
      } catch (error: any) {
        ctx.ui.notify(`PostHog authentication failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("posthog-logout", {
    description: "Remove stored PostHog OAuth credentials",
    handler: async (_args, ctx) => {
      clearTokens();
      resetSession();
      ctx.ui.notify("Stored PostHog credentials removed.", "info");
    },
  });

  pi.registerCommand("posthog-tools", {
    description: "List tools exposed by the PostHog MCP server",
    handler: async (_args, ctx) => {
      try {
        const tools = await getTools();
        ctx.ui.notify(tools.map((tool) => `• ${tool.name}: ${firstSentence(tool.description)}`).join("\n"), "info");
      } catch (error: any) {
        ctx.ui.notify(`Could not list PostHog tools: ${error.message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "posthog",
    label: "PostHog",
    description:
      "Analyze PostHog through its remote MCP server. The server exposes an exec gateway: pass CLI-style commands in args.command (search, info, schema, call) and a 15-25 word third-person args.context. Use tool='list_tools' for concise usage.",
    promptSnippet: "Analyze product analytics, events, funnels, retention, users, flags, experiments, and recordings in PostHog",
    promptGuidelines: [
      "Use the posthog tool to analyze product behavior and PostHog data. Call tool='list_tools' once for the exec gateway syntax; then use exec search/info/schema/call commands.",
      "Prefer aggregate analytics and narrow time ranges before requesting raw events, persons, or recordings. Keep list limits at 5 by default and increase only when needed. Avoid exposing unnecessary personal data in responses.",
      "PostHog exec search results are stripped of verbose scope-gated catalogs, info schemas are summarized, and all results are capped. If output is truncated, narrow the query instead of requesting a larger dump.",
      "The OAuth integration intentionally requests read-only scopes. Do not attempt mutations unless the user explicitly configures a separate token with the required access.",
      "If PostHog is not authenticated, ask the user to run /posthog-auth.",
    ],
    parameters: Type.Object({
      tool: Type.String({ description: "PostHog MCP tool name, or 'list_tools'/'describe_tool' for discovery." }),
      args: Type.Optional(Type.Any({ description: "Arguments for the selected PostHog MCP tool." })),
    }),
    async execute(_toolCallId, params) {
      if (!authenticated()) {
        return {
          content: [{ type: "text", text: "PostHog is not authenticated. Ask the user to run /posthog-auth." }],
          isError: true,
        };
      }

      try {
        if (params.tool === "list_tools") {
          const tools = await getTools();
          const hasExecGateway = tools.some((tool) => tool.name === "exec");
          const catalog = hasExecGateway
            ? EXEC_USAGE
            : tools.map((tool) => `${tool.name}: ${firstSentence(tool.description)}`).sort().join("\n");
          return {
            content: [{ type: "text", text: catalog }],
            details: { count: tools.length },
          };
        }

        let args = params.args ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            // Some MCP tools legitimately accept a string payload.
          }
        }

        if (params.tool === "describe_tool") {
          const name = args?.name;
          const tool = name && (await getTools()).find((candidate) => candidate.name === name);
          if (!tool) {
            return {
              content: [{ type: "text", text: name ? `Unknown PostHog tool: ${name}` : "describe_tool requires args={\"name\":\"<tool>\"}." }],
              isError: true,
            };
          }
          const description = name === "exec" ? EXEC_USAGE : firstSentence(tool.description, 500);
          return {
            content: [{ type: "text", text: JSON.stringify({ name: tool.name, description, parameters: compactSchema(tool.inputSchema) }, null, 2) }],
            details: { tool: name },
          };
        }

        const result = await callTool(params.tool, args);
        const text = (result?.content ?? [])
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text)
          .join("\n");
        const output = text || JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text: params.tool === "exec" ? compactExecOutput(args?.command, output) : capResult(output) }],
          details: { tool: params.tool, isError: result?.isError ?? false },
          isError: result?.isError ?? false,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `PostHog MCP error: ${error.message}` }],
          isError: true,
        };
      }
    },
  });
}
