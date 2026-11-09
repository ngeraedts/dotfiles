import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getCredential } from "../shared/credentials.cjs";
const FIGMA_API = "https://api.figma.com";

async function figmaGet(path: string) {
  const response = await fetch(`${FIGMA_API}${path}`, {
    headers: { "X-Figma-Token": getCredential("FIGMA_TOKEN") },
  });
  if (!response.ok) {
    throw new Error(`Figma API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function parseFileKey(input: string): string {
  const match = input.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : input;
}

function parseNodeId(input: string): string | null {
  const match = input.match(/node-id=([^&]+)/);
  if (match) return decodeURIComponent(match[1]).replace(/-/g, ":");
  return null;
}

// Figma URLs use dashes (33804-18676) but the API expects colons (33804:18676)
function normalizeNodeId(id: string): string {
  return id.replace(/-/g, ":");
}

// --- Node simplification (like Framelink MCP) ---

function rgbaToHex(color: any): string {
  if (!color) return "";
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const a = color.a ?? 1;
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

const MAX_OUTPUT_CHARS = 50_000; // hard cap on output size

function simplifyNode(node: any, depth = 0, maxDepth = 8): any {
  if (depth > maxDepth) return { name: node.name, type: node.type, _truncated: true };

  const r: any = { name: node.name, type: node.type };

  // Size only (no absolute position — not useful for CSS)
  const bb = node.absoluteBoundingBox;
  if (bb) { r.w = Math.round(bb.width); r.h = Math.round(bb.height); }

  // Auto-layout → flexbox
  if (node.layoutMode) {
    r.layout = node.layoutMode; // HORIZONTAL | VERTICAL
    if (node.itemSpacing) r.gap = node.itemSpacing;
    const pt = node.paddingTop ?? 0, pr = node.paddingRight ?? 0,
          pb = node.paddingBottom ?? 0, pl = node.paddingLeft ?? 0;
    if (pt || pr || pb || pl) r.padding = [pt, pr, pb, pl];
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN") r.mainAlign = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN") r.crossAlign = node.counterAxisAlignItems;
    if (node.layoutWrap === "WRAP") r.wrap = true;
  }

  // Sizing
  if (node.layoutSizingHorizontal === "FILL") r.hFill = true;
  if (node.layoutSizingVertical === "FILL") r.vFill = true;

  // Corner radius
  if (node.cornerRadius) r.radius = node.cornerRadius;
  else if (node.rectangleCornerRadii?.some((v: number) => v > 0)) r.radius = node.rectangleCornerRadii;

  // Fills — just colors
  const solidFills = (node.fills ?? []).filter((f: any) => f.visible !== false && f.color);
  if (solidFills.length === 1) r.fill = rgbaToHex(solidFills[0].color);
  else if (solidFills.length > 1) r.fills = solidFills.map((f: any) => rgbaToHex(f.color));

  // Stroke — simplified
  const visStrokes = (node.strokes ?? []).filter((s: any) => s.visible !== false && s.color);
  if (visStrokes.length && node.strokeWeight) {
    r.stroke = { color: rgbaToHex(visStrokes[0].color), weight: node.strokeWeight };
  }

  // Effects — only shadows and blurs
  const visEffects = (node.effects ?? []).filter((e: any) => e.visible !== false);
  if (visEffects.length) {
    r.effects = visEffects.map((e: any) => {
      const eff: any = { type: e.type };
      if (e.color) eff.color = rgbaToHex(e.color);
      if (e.radius) eff.radius = e.radius;
      if (e.offset && (e.offset.x || e.offset.y)) eff.offset = [e.offset.x, e.offset.y];
      return eff;
    });
  }

  // Opacity
  if (node.opacity != null && node.opacity < 1) r.opacity = +node.opacity.toFixed(2);

  // Clip
  if (node.clipsContent) r.clip = true;

  // Text
  if (node.type === "TEXT") {
    r.text = node.characters ?? "";
    const s = node.style;
    if (s) {
      if (s.fontFamily) r.font = s.fontFamily;
      if (s.fontSize) r.fontSize = s.fontSize;
      if (s.fontWeight && s.fontWeight !== 400) r.fontWeight = s.fontWeight;
      if (s.lineHeightPx) r.lineHeight = Math.round(s.lineHeightPx);
      if (s.letterSpacing) r.letterSpacing = +s.letterSpacing.toFixed(1);
      if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") r.textAlign = s.textAlignHorizontal;
    }
  }

  // Component info
  if (node.componentId) r.componentId = node.componentId;

  // Children
  if (node.children?.length) {
    r.children = node.children
      .filter((c: any) => c.visible !== false)
      .map((c: any) => simplifyNode(c, depth + 1, maxDepth));
  }

  return r;
}

function truncateOutput(obj: any): string {
  const full = JSON.stringify(obj);
  if (full.length <= MAX_OUTPUT_CHARS) return full;
  // Truncate and indicate
  return full.slice(0, MAX_OUTPUT_CHARS) + "\n... [truncated — use a smaller node or lower depth]";
}

// Recursively collect nodes for browsing
function collectNodes(node: any, depth = 0, maxDepth = 3): any[] {
  if (depth > maxDepth) return [];
  const result: any[] = [];
  const container = ["DOCUMENT", "CANVAS", "FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "GROUP"];
  if (container.includes(node.type) || depth === 0) {
    result.push({
      id: node.id,
      name: node.name,
      type: node.type,
      childCount: node.children?.length ?? 0,
    });
    if (node.children) {
      for (const child of node.children) {
        result.push(...collectNodes(child, depth + 1, maxDepth));
      }
    }
  }
  return result;
}

export default function (pi: ExtensionAPI) {
  // Tool: Browse file structure
  pi.registerTool({
    name: "figma_browse",
    label: "Figma: Browse File",
    description:
      "Browse a Figma file's structure — list pages, frames, and components. Accepts a file key or full Figma URL.",
    promptSnippet: "Browse a Figma file's pages, frames, and components",
    parameters: Type.Object({
      fileKey: Type.String({ description: "Figma file key or full URL (e.g. 'abc123' or 'https://www.figma.com/design/abc123/...')" }),
      depth: Type.Optional(Type.Number({ description: "Max depth to traverse (default 2)", default: 2 })),
    }),
    async execute(_toolCallId, params, _signal) {
      const key = parseFileKey(params.fileKey);
      const data = await figmaGet(`/v1/files/${key}?depth=${params.depth ?? 2}`);

      const nodes = collectNodes(data.document, 0, params.depth ?? 2);
      const result = {
        name: data.name,
        lastModified: data.lastModified,
        version: data.version,
        nodes,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { nodeCount: nodes.length },
      };
    },
  });

  // Tool: Get structured design data for nodes (the main workhorse)
  pi.registerTool({
    name: "figma_get_figma_data",
    label: "Figma: Get Design Data",
    description:
      "Get structured design data for a Figma node — layout, styles, colors, typography, spacing, and children. " +
      "Returns simplified node tree with all properties needed to implement the design in code. " +
      "Accepts a file key or full Figma URL. Use figma_browse first to find node IDs.",
    promptSnippet: "Get structured Figma design data (layout, styles, colors, typography) for a node",
    parameters: Type.Object({
      fileKey: Type.String({ description: "Figma file key or URL" }),
      nodeId: Type.String({ description: "Node ID to fetch (e.g. '1:2'). Can also be extracted from a Figma URL." }),
      depth: Type.Optional(Type.Number({ description: "Max depth for child traversal (default 10)", default: 10 })),
    }),
    async execute(_toolCallId, params, _signal) {
      const key = parseFileKey(params.fileKey);
      let nodeId = params.nodeId;

      // Auto-extract from URL if nodeId looks like a URL
      if (!nodeId || nodeId.includes("figma.com")) {
        const extracted = parseNodeId(nodeId || params.fileKey);
        if (extracted) nodeId = extracted;
      }
      nodeId = normalizeNodeId(nodeId);

      if (!nodeId) {
        return {
          content: [{ type: "text", text: "Please provide a nodeId. Use figma_browse to find node IDs." }],
          isError: true,
        };
      }

      const data = await figmaGet(`/v1/files/${key}/nodes?ids=${encodeURIComponent(nodeId)}`);
      const nodeData = data.nodes?.[nodeId];

      if (!nodeData?.document) {
        return {
          content: [{ type: "text", text: `Node ${nodeId} not found.` }],
          isError: true,
        };
      }

      const simplified = simplifyNode(nodeData.document, 0, params.depth ?? 8);

      return {
        content: [{ type: "text", text: truncateOutput(simplified) }],
        details: { nodeId },
      };
    },
  });

  // Tool: Render image — returns URLs only, no inline images
  pi.registerTool({
    name: "figma_image",
    label: "Figma: Get Image URL",
    description:
      "Get a temporary render URL for Figma nodes. Returns URLs only (does not inline images). " +
      "Use this when you need a visual reference — the URL can be opened in a browser.",
    promptSnippet: "Get render URLs for Figma nodes",
    parameters: Type.Object({
      fileKey: Type.String({ description: "Figma file key or URL" }),
      nodeIds: Type.Optional(Type.Array(Type.String(), { description: "Node IDs to render. Auto-extracted from URL if omitted." })),
      format: Type.Optional(Type.String({ description: "Image format: 'png' (default), 'svg', 'jpg', 'pdf'" })),
      scale: Type.Optional(Type.Number({ description: "Scale factor 0.01-4 (default 1)" })),
    }),
    async execute(_toolCallId, params, _signal) {
      const key = parseFileKey(params.fileKey);
      let nodeIds = params.nodeIds;

      if (!nodeIds?.length) {
        const urlNodeId = parseNodeId(params.fileKey);
        if (urlNodeId) {
          nodeIds = [urlNodeId];
        } else {
          return {
            content: [{ type: "text", text: "Please provide nodeIds or a Figma URL with a node-id parameter." }],
            isError: true,
          };
        }
      }

      const ids = nodeIds.map(normalizeNodeId).join(",");
      const format = params.format ?? "png";
      const scale = params.scale ?? 1;

      const data = await figmaGet(
        `/v1/images/${key}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`
      );

      if (data.err) {
        return { content: [{ type: "text", text: `Figma render error: ${data.err}` }], isError: true };
      }

      const images = data.images ?? {};
      const entries = Object.entries(images);

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No images returned." }], isError: true };
      }

      const lines = entries.map(([nodeId, url]) =>
        url ? `Node ${nodeId}: ${url}` : `Node ${nodeId}: no image available`
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { nodeCount: entries.length },
      };
    },
  });

  // Tool: List project files
  pi.registerTool({
    name: "figma_project_files",
    label: "Figma: List Project Files",
    description: "List all files in a Figma project.",
    promptSnippet: "List all files in a Figma project",
    parameters: Type.Object({
      projectId: Type.String({ description: "Figma project ID" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const data = await figmaGet(`/v1/projects/${params.projectId}/files`);

      const files = (data.files ?? []).map((f: any) => ({
        key: f.key,
        name: f.name,
        lastModified: f.last_modified,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
        details: { count: files.length },
      };
    },
  });

  // Tool: List team projects
  pi.registerTool({
    name: "figma_team_projects",
    label: "Figma: List Team Projects",
    description: "List all projects for a Figma team.",
    promptSnippet: "List all projects for a Figma team",
    parameters: Type.Object({
      teamId: Type.String({ description: "Figma team ID" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const data = await figmaGet(`/v1/teams/${params.teamId}/projects`);

      const projects = (data.projects ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
        details: { count: projects.length },
      };
    },
  });

  // Tool: Get file comments
  pi.registerTool({
    name: "figma_comments",
    label: "Figma: Get Comments",
    description: "Get comments on a Figma file.",
    promptSnippet: "Get comments on a Figma file",
    parameters: Type.Object({
      fileKey: Type.String({ description: "Figma file key or URL" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const key = parseFileKey(params.fileKey);
      const data = await figmaGet(`/v1/files/${key}/comments`);

      const comments = (data.comments ?? []).map((c: any) => ({
        id: c.id,
        message: c.message,
        user: c.user?.handle,
        createdAt: c.created_at,
        resolvedAt: c.resolved_at,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
        details: { count: comments.length },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Figma integration loaded ✓", "info");
  });
}
