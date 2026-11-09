import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Type } from "typebox";

import { getCredential } from "../shared/credentials.cjs";
const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_UPLOADS_HOST = "uploads.linear.app";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 50_000;

interface LinearImage {
  alt: string;
  url: string;
}

function imagesInMarkdown(markdown: string | null | undefined): LinearImage[] {
  if (!markdown) return [];

  const images: LinearImage[] = [];
  const imagePattern = /!\[([^\]]*)\]\(<?(https:\/\/uploads\.linear\.app\/[^\s)>]+)>?\)/g;

  for (const match of markdown.matchAll(imagePattern)) {
    const [, alt, url] = match;
    if (url) images.push({ alt: alt || "Untitled image", url });
  }

  return images;
}

interface LinearAttachment {
  name: string;
  url: string;
  image: boolean;
}

interface DownloadedAttachment extends LinearAttachment {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

function attachmentsInMarkdown(markdown: string | null | undefined): LinearAttachment[] {
  if (!markdown) return [];

  const attachments: LinearAttachment[] = [];
  const seenUrls = new Set<string>();
  const attachmentPattern = /(!?)\[([^\]]*)\]\(<?(https:\/\/uploads\.linear\.app\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g;

  for (const match of markdown.matchAll(attachmentPattern)) {
    const [, imageMarker, name, url] = match;
    if (!url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    attachments.push({
      name: name || `Attachment ${attachments.length + 1}`,
      url,
      image: imageMarker === "!",
    });
  }

  return attachments;
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain filename form.
    }
  }

  return disposition.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim()
    ?? null;
}

function extensionForMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/json": ".json",
  };
  return extensions[mimeType] ?? "";
}

function safeFilename(name: string, mimeType: string, index: number): string {
  const sanitized = name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_\.]+|[_\.]+$/g, "");
  const fallback = `attachment-${index}${extensionForMimeType(mimeType)}`;
  const filename = sanitized || fallback;
  return extname(filename) || !extensionForMimeType(mimeType)
    ? filename
    : `${filename}${extensionForMimeType(mimeType)}`;
}

async function downloadLinearAttachment(
  attachment: LinearAttachment,
  index: number,
  signal?: AbortSignal,
): Promise<DownloadedAttachment> {
  const parsedUrl = new URL(attachment.url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== LINEAR_UPLOADS_HOST) {
    throw new Error("Attachment URL is not a Linear upload.");
  }

  const response = await fetch(parsedUrl, {
    headers: { Authorization: getCredential("LINEAR_API_KEY") },
    signal,
  });
  if (!response.ok) throw new Error(`Linear upload returned ${response.status}.`);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit.`);
  }

  const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    || "application/octet-stream";
  const dispositionFilename = filenameFromDisposition(response.headers.get("content-disposition"));
  const filename = safeFilename(dispositionFilename || attachment.name, mimeType, index);

  return { ...attachment, bytes, mimeType, filename };
}

async function fetchLinearImage(url: string, signal?: AbortSignal): Promise<{ data: string; mimeType: string }> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== LINEAR_UPLOADS_HOST) {
    throw new Error("Image URL is not a Linear upload.");
  }

  const response = await fetch(parsedUrl, {
    headers: { Authorization: getCredential("LINEAR_API_KEY") },
    signal,
  });
  if (!response.ok) throw new Error(`Linear upload returned ${response.status}.`);

  const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Linear upload returned unsupported content type '${mimeType || "unknown"}'.`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is larger than the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is larger than the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit.`);
  }

  return { data: bytes.toString("base64"), mimeType };
}

async function linearQuery(query: string, variables: Record<string, any> = {}) {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getCredential("LINEAR_API_KEY"),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

// Helper: resolve issue by identifier (e.g. "ISS-3617") using the issue(id:) query
async function resolveIssue(identifier: string, fields: string) {
  const data = await linearQuery(
    `query($id: String!) { issue(id: $id) { ${fields} } }`,
    { id: identifier }
  );
  return data.issue;
}

// Helper: resolve a project to its UUID from either a UUID or a project name
async function resolveProjectId(idOrName: string): Promise<string | null> {
  // A Linear project ID is a UUID; if it already looks like one, try it directly.
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
  if (looksLikeUuid) {
    const data = await linearQuery(`query($id: String!) { project(id: $id) { id } }`, { id: idOrName });
    if (data.project?.id) return data.project.id;
  }

  // Otherwise (or if the UUID lookup failed) match by name.
  const data = await linearQuery(
    `query($name: String!) { projects(filter: { name: { containsIgnoreCase: $name } }, first: 2) { nodes { id name } } }`,
    { name: idOrName }
  );
  return data.projects?.nodes?.[0]?.id ?? null;
}

// Linear has more labels than one API page. Always paginate so older labels near
// the end of the collection (including `client` and `server`) remain resolvable.
async function listIssueLabels(): Promise<any[]> {
  const labels: any[] = [];
  let after: string | null = null;

  do {
    const data = await linearQuery(
      `query($after: String) {
        issueLabels(first: 250, after: $after) {
          nodes { id name description color isGroup }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    const page = data.issueLabels;
    labels.push(...(page?.nodes ?? []));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return labels;
}

// Resolve a project milestone from an ID, or from a name within a project.
// Milestone names are only unique within a project, so name lookup requires one.
async function resolveProjectMilestone(
  idOrName: string,
  projectId?: string,
): Promise<{ id: string; projectId: string; name: string } | null> {
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
  if (looksLikeUuid) {
    const data = await linearQuery(
      `query($id: String!) { projectMilestone(id: $id) { id name project { id } } }`,
      { id: idOrName },
    );
    return data.projectMilestone
      ? { ...data.projectMilestone, projectId: data.projectMilestone.project.id }
      : null;
  }

  if (!projectId) return null;

  const data = await linearQuery(
    `query($id: String!) { project(id: $id) { projectMilestones(first: 250) { nodes { id name project { id } } } } }`,
    { id: projectId },
  );
  const milestone = data.project?.projectMilestones?.nodes?.find(
    (item: any) => item.name.toLowerCase() === idOrName.toLowerCase(),
  );
  return milestone
    ? { ...milestone, projectId: milestone.project.id }
    : null;
}

export default function (pi: ExtensionAPI) {
  // Tool: Search/list issues
  pi.registerTool({
    name: "linear_search_issues",
    label: "Linear: Search Issues",
    description:
      "Search and list Linear issues. Can filter by team, status, assignee, label, or free-text query.",
    promptSnippet: "Search and filter Linear issues by team, status, assignee, label, or query text",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Free-text search query" })),
      teamKey: Type.Optional(Type.String({ description: "Team key (e.g. 'ENG')" })),
      status: Type.Optional(Type.String({ description: "Status name filter (e.g. 'In Progress', 'Todo', 'Done')" })),
      assignee: Type.Optional(Type.String({ description: "Assignee display name or email" })),
      label: Type.Optional(Type.String({ description: "Label name" })),
      project: Type.Optional(Type.String({ description: "Project name (matches issues belonging to the project)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)", default: 20 })),
    }),
    async execute(_toolCallId, params, _signal) {
      const filters: string[] = [];
      if (params.teamKey) filters.push(`team: { key: { eq: "${params.teamKey}" } }`);
      if (params.status) filters.push(`state: { name: { eqCaseInsensitive: "${params.status}" } }`);
      if (params.assignee) {
        filters.push(
          `assignee: { or: [{ name: { containsIgnoreCase: "${params.assignee}" } }, { email: { containsIgnoreCase: "${params.assignee}" } }] }`
        );
      }
      if (params.label) filters.push(`labels: { name: { eq: "${params.label}" } }`);
      if (params.project) filters.push(`project: { name: { containsIgnoreCase: "${params.project}" } }`);

      const filterStr = filters.length > 0 ? `filter: { ${filters.join(", ")} },` : "";
      const limit = params.limit ?? 20;

      const issueFields = `id identifier title priority priorityLabel
        state { name } team { key name } assignee { name email }
        project { id name state url }
        projectMilestone { id name targetDate }
        labels { nodes { name } } estimate dueDate url createdAt updatedAt`;

      let queryStr: string;
      if (params.query) {
        queryStr = `query { searchIssues(term: "${params.query}", ${filterStr} first: ${limit}) { nodes { ${issueFields} } } }`;
      } else {
        queryStr = `query { issues(${filterStr} first: ${limit}, orderBy: updatedAt) { nodes { ${issueFields} } } }`;
      }

      try {
        const data = await linearQuery(queryStr);
        const issues = data.searchIssues?.nodes ?? data.issues?.nodes ?? [];

        const formatted = issues.map((i: any) => ({
          id: i.identifier, title: i.title, status: i.state?.name,
          priority: i.priorityLabel, team: i.team?.key,
          assignee: i.assignee?.name ?? "Unassigned",
          project: i.project ? { id: i.project.id, name: i.project.name } : null,
          projectMilestone: i.projectMilestone ? { id: i.projectMilestone.id, name: i.projectMilestone.name } : null,
          labels: i.labels?.nodes?.map((l: any) => l.name) ?? [],
          estimate: i.estimate, dueDate: i.dueDate, url: i.url, updatedAt: i.updatedAt,
        }));

        return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }], details: { count: formatted.length } };
      } catch (e: any) {
        // If searchIssues fails, fall back to issues with filter only
        if (params.query && !filters.length) {
          return { content: [{ type: "text", text: `Search failed: ${e.message}. Try filtering by team/status/assignee instead.` }], isError: true };
        }
        throw e;
      }
    },
  });

  // Tool: Get issue details
  pi.registerTool({
    name: "linear_get_issue",
    label: "Linear: Get Issue",
    description: "Get full details of a Linear issue by its identifier (e.g. ENG-123), including description and comments. Use linear_view_issue_attachments to inspect files linked in the description.",
    promptSnippet: "Get full details, description, and comments for a Linear issue by identifier",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.identifier,
        `id identifier title description priority priorityLabel
         state { name } team { key name } assignee { name email }
         project { id name state url }
         projectMilestone { id name targetDate }
         labels { nodes { name } } estimate dueDate url createdAt updatedAt
         comments { nodes { body user { name } createdAt } }
         parent { identifier title }
         children { nodes { identifier title state { name } } }
         relations { nodes { type relatedIssue { identifier title } } }`
      );

      if (!issue) {
        return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };
      }

      return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }], details: {} };
    },
  });

  // Tool: Download and inspect attachments linked in an issue description.
  pi.registerTool({
    name: "linear_view_issue_attachments",
    label: "Linear: View Issue Attachments",
    description:
      "Download attachments linked in a Linear issue description. Images are displayed inline, videos are sampled into frames for visual review, text files are previewed, and every attachment is saved to a temporary local path. Supports Linear uploads up to 100MB.",
    promptSnippet: "Download and inspect screenshots, videos, and other files in a Linear issue description",
    promptGuidelines: [
      "Use linear_view_issue_attachments when a Linear issue description contains a screenshot, video, or other uploaded file that must be reviewed.",
    ],
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
      attachmentIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "One-based indexes of attachments to inspect. Omit to inspect the first attachments." })),
      maxAttachments: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 5, description: "Maximum attachments to inspect when indexes are omitted (default 5, max 5)" })),
      videoFrameCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 6, description: "Frames to sample from each video (default 6, max 8)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const issue = await resolveIssue(params.identifier, "id identifier title description url");
      if (!issue) {
        return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };
      }

      const allAttachments = attachmentsInMarkdown(issue.description);
      if (allAttachments.length === 0) {
        return {
          content: [{ type: "text", text: `No Linear-upload attachments found in the description of ${issue.identifier}.` }],
          details: { issueIdentifier: issue.identifier, attachmentCount: 0 },
        };
      }

      const selected = params.attachmentIndexes
        ? [...new Set(params.attachmentIndexes)].map((index) => ({ index, attachment: allAttachments[index - 1] })).filter(
            (item): item is { index: number; attachment: LinearAttachment } => item.attachment !== undefined,
          )
        : allAttachments.slice(0, params.maxAttachments ?? 5).map((attachment, index) => ({ index: index + 1, attachment }));

      if (selected.length === 0) {
        return {
          content: [{ type: "text", text: `No requested attachment indexes exist. ${issue.identifier} has ${allAttachments.length} attachment(s) in its description.` }],
          details: { issueIdentifier: issue.identifier, attachmentCount: allAttachments.length },
          isError: true,
        };
      }

      const outputDirectory = await mkdtemp(join(tmpdir(), `pi-linear-${issue.identifier}-`));
      await mkdir(outputDirectory, { recursive: true });
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
        type: "text",
        text: `Attachments from ${issue.identifier} — ${issue.title} (${allAttachments.length} total):`,
      }];
      const details: Array<Record<string, unknown>> = [];

      for (const { index, attachment } of selected) {
        try {
          const downloaded = await downloadLinearAttachment(attachment, index, signal);
          const localPath = join(outputDirectory, `${index}-${downloaded.filename}`);
          await writeFile(localPath, downloaded.bytes);
          const metadata: Record<string, unknown> = {
            index,
            name: downloaded.name,
            url: downloaded.url,
            mimeType: downloaded.mimeType,
            bytes: downloaded.bytes.byteLength,
            localPath,
          };
          details.push(metadata);
          content.push({
            type: "text",
            text: `${index}. ${downloaded.name} (${downloaded.mimeType}, ${(downloaded.bytes.byteLength / 1024 / 1024).toFixed(1)}MB)\nSaved to: ${localPath}`,
          });

          if (downloaded.mimeType.startsWith("image/")) {
            if (downloaded.bytes.byteLength <= MAX_IMAGE_BYTES) {
              content.push({ type: "image", data: downloaded.bytes.toString("base64"), mimeType: downloaded.mimeType });
            } else {
              const previewPath = join(outputDirectory, `${index}-preview.jpg`);
              const preview = await pi.exec("ffmpeg", [
                "-v", "error", "-y", "-i", localPath,
                "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease",
                "-q:v", "3", previewPath,
              ], { signal });
              if (preview.code === 0) {
                const previewBytes = await readFile(previewPath);
                content.push({ type: "text", text: "Scaled preview:" });
                content.push({ type: "image", data: previewBytes.toString("base64"), mimeType: "image/jpeg" });
              } else {
                content.push({ type: "text", text: "Image is too large to display inline; use the saved local file." });
              }
            }
          } else if (downloaded.mimeType.startsWith("video/")) {
            const probe = await pi.exec("ffprobe", [
              "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", localPath,
            ], { signal });
            const duration = Number.parseFloat(probe.stdout.trim());
            const frameCount = params.videoFrameCount ?? 6;
            const timestamps = Number.isFinite(duration) && duration > 0
              ? Array.from({ length: frameCount }, (_, frameIndex) => duration * (frameIndex + 0.5) / frameCount)
              : [0, 2, 5, 10].slice(0, frameCount);
            metadata.durationSeconds = Number.isFinite(duration) ? duration : null;
            metadata.sampledFrames = timestamps.length;
            content.push({
              type: "text",
              text: `Video frame samples${Number.isFinite(duration) ? ` across ${duration.toFixed(1)}s` : ""}:`,
            });

            for (const [frameIndex, timestamp] of timestamps.entries()) {
              const framePath = join(outputDirectory, `${index}-frame-${frameIndex + 1}.jpg`);
              const frame = await pi.exec("ffmpeg", [
                "-v", "error", "-y", "-ss", timestamp.toFixed(3), "-i", localPath,
                "-frames:v", "1", "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease",
                "-q:v", "3", framePath,
              ], { signal });
              if (frame.code !== 0) {
                content.push({ type: "text", text: `Frame ${frameIndex + 1} at ${timestamp.toFixed(1)}s could not be extracted.` });
                continue;
              }

              const frameBytes = await readFile(framePath);
              content.push({ type: "text", text: `Frame ${frameIndex + 1} — ${timestamp.toFixed(1)}s` });
              content.push({ type: "image", data: frameBytes.toString("base64"), mimeType: "image/jpeg" });
            }
          } else if (downloaded.mimeType.startsWith("text/") || downloaded.mimeType === "application/json") {
            const text = downloaded.bytes.toString("utf8");
            const truncated = text.length > MAX_TEXT_PREVIEW_CHARS;
            content.push({
              type: "text",
              text: `File preview:\n${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}${truncated ? "\n[Preview truncated; full file is available at the saved path.]" : ""}`,
            });
          } else {
            content.push({ type: "text", text: "This file type cannot be displayed inline; inspect the saved local file." });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          details.push({ index, name: attachment.name, url: attachment.url, error: message });
          content.push({ type: "text", text: `${index}. ${attachment.name}: unavailable (${message})` });
        }
      }

      return {
        content,
        details: {
          issueIdentifier: issue.identifier,
          issueUrl: issue.url,
          attachmentCount: allAttachments.length,
          outputDirectory,
          attachments: details,
        },
      };
    },
  });

  // Tool: Create issue
  pi.registerTool({
    name: "linear_create_issue",
    label: "Linear: Create Issue",
    description: "Create a new Linear issue.",
    promptSnippet: "Create a new Linear issue with title, description, team, and optional fields",
    parameters: Type.Object({
      title: Type.String({ description: "Issue title" }),
      teamKey: Type.String({ description: "Team key (e.g. 'ENG')" }),
      description: Type.Optional(Type.String({ description: "Issue description (markdown)" })),
      priority: Type.Optional(Type.Number({ description: "Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" })),
      status: Type.Optional(Type.String({ description: "Status name (e.g. 'Todo', 'In Progress')" })),
      assigneeEmail: Type.Optional(Type.String({ description: "Assignee email" })),
      labelNames: Type.Optional(Type.Array(Type.String(), { description: "Label names to apply" })),
      estimate: Type.Optional(Type.Number({ description: "Estimate points" })),
      parentIdentifier: Type.Optional(Type.String({ description: "Parent issue identifier (e.g. 'ENG-123') to create this as a sub-issue" })),
      project: Type.Optional(Type.String({ description: "Project to add the issue to — either a project ID (UUID) or a project name" })),
      projectMilestone: Type.Optional(Type.String({ description: "Project milestone to assign — a milestone ID (UUID), or its name when project is supplied" })),
    }),
    async execute(_toolCallId, params, _signal) {
      const teamData = await linearQuery(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
        { key: params.teamKey }
      );
      const teamId = teamData.teams?.nodes?.[0]?.id;
      if (!teamId) return { content: [{ type: "text", text: `Team '${params.teamKey}' not found.` }], isError: true };

      const input: Record<string, any> = { title: params.title, teamId };
      if (params.description) input.description = params.description;
      if (params.priority !== undefined) input.priority = params.priority;
      if (params.estimate !== undefined) input.estimate = params.estimate;

      if (params.status) {
        const stateData = await linearQuery(
          `query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }`,
          { teamId }
        );
        const state = stateData.workflowStates?.nodes?.find((s: any) => s.name.toLowerCase() === params.status!.toLowerCase());
        if (state) input.stateId = state.id;
      }

      if (params.assigneeEmail) {
        const userData = await linearQuery(`query { users(filter: { email: { eq: "${params.assigneeEmail}" } }) { nodes { id } } }`);
        const user = userData.users?.nodes?.[0];
        if (user) input.assigneeId = user.id;
      }

      if (params.parentIdentifier) {
        const parentIssue = await resolveIssue(params.parentIdentifier, "id");
        if (!parentIssue) return { content: [{ type: "text", text: `Parent issue '${params.parentIdentifier}' not found.` }], isError: true };
        input.parentId = parentIssue.id;
      }

      if (params.labelNames?.length) {
        const labels = await listIssueLabels();
        const labelsByName = new Map(
          labels.map((label: any) => [label.name.toLowerCase(), label]),
        );
        const unknownLabels = params.labelNames.filter(
          (name) => !labelsByName.has(name.toLowerCase()),
        );
        if (unknownLabels.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Label${unknownLabels.length === 1 ? "" : "s"} not found: ${unknownLabels.join(", ")}.`,
            }],
            isError: true,
          };
        }
        input.labelIds = params.labelNames.map(
          (name) => labelsByName.get(name.toLowerCase()).id,
        );
      }

      let projectId: string | undefined;
      if (params.project) {
        projectId = await resolveProjectId(params.project) ?? undefined;
        if (!projectId) return { content: [{ type: "text", text: `Project '${params.project}' not found.` }], isError: true };
        input.projectId = projectId;
      }

      if (params.projectMilestone) {
        const milestone = await resolveProjectMilestone(params.projectMilestone, projectId);
        if (!milestone) {
          const hint = projectId ? "" : " Supply project when referring to a milestone by name.";
          return { content: [{ type: "text", text: `Project milestone '${params.projectMilestone}' not found.${hint}` }], isError: true };
        }
        if (projectId && milestone.projectId !== projectId) {
          return { content: [{ type: "text", text: `Project milestone '${milestone.name}' does not belong to project '${params.project}'.` }], isError: true };
        }
        input.projectId = milestone.projectId;
        input.projectMilestoneId = milestone.id;
      }

      const data = await linearQuery(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title url state { name } project { id name } projectMilestone { id name } } } }`,
        { input }
      );

      if (!data.issueCreate?.success) return { content: [{ type: "text", text: "Failed to create issue." }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(data.issueCreate.issue, null, 2) }], details: {} };
    },
  });

  // Tool: Update issue
  pi.registerTool({
    name: "linear_update_issue",
    label: "Linear: Update Issue",
    description: "Update an existing Linear issue's status, assignee, priority, title, description, labels, team, project, or project milestone.",
    promptSnippet: "Update a Linear issue's status, assignee, priority, title, description, labels, team, project, or project milestone",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description (markdown)" })),
      status: Type.Optional(Type.String({ description: "New status name" })),
      priority: Type.Optional(Type.Number({ description: "Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" })),
      assigneeEmail: Type.Optional(Type.String({ description: "New assignee email" })),
      labelNames: Type.Optional(Type.Array(Type.String(), { description: "Complete list of labels to apply. Replaces all existing labels; pass [] to remove every label." })),
      estimate: Type.Optional(Type.Number({ description: "Estimate points" })),
      parentIdentifier: Type.Optional(Type.String({ description: "Parent issue identifier (e.g. 'ENG-123') to make this a sub-issue" })),
      teamKey: Type.Optional(Type.String({ description: "Move the issue to another team by team key (e.g. 'FDN'). The issue identifier will change (e.g. ISS-3637 -> FDN-1642)." })),
      project: Type.Optional(Type.String({ description: "Project to assign — a project ID (UUID) or project name" })),
      projectMilestone: Type.Optional(Type.String({ description: "Project milestone to assign — a milestone ID (UUID) or its name. Use 'none' to remove the current milestone." })),

    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.identifier, "id team { id } project { id name }");
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };

      const input: Record<string, any> = {};
      if (params.title) input.title = params.title;
      if (params.description) input.description = params.description;
      if (params.priority !== undefined) input.priority = params.priority;
      if (params.estimate !== undefined) input.estimate = params.estimate;

      // Team move: resolve the target team and record it so status resolution
      // below runs against the destination team's workflow states.
      let stateTeamId = issue.team.id;
      if (params.teamKey) {
        const teamData = await linearQuery(
          `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
          { key: params.teamKey }
        );
        const teamId = teamData.teams?.nodes?.[0]?.id;
        if (!teamId) return { content: [{ type: "text", text: `Team '${params.teamKey}' not found.` }], isError: true };
        input.teamId = teamId;
        stateTeamId = teamId;
      }

      if (params.parentIdentifier === null || params.parentIdentifier === "none") {
        input.parentId = null;
      } else if (params.parentIdentifier) {
        const parentIssue = await resolveIssue(params.parentIdentifier, "id");
        if (!parentIssue) return { content: [{ type: "text", text: `Parent issue '${params.parentIdentifier}' not found.` }], isError: true };
        input.parentId = parentIssue.id;
      }

      let projectId = issue.project?.id as string | undefined;
      if (params.project) {
        projectId = await resolveProjectId(params.project) ?? undefined;
        if (!projectId) return { content: [{ type: "text", text: `Project '${params.project}' not found.` }], isError: true };
        input.projectId = projectId;
      }

      if (params.projectMilestone === "none") {
        input.projectMilestoneId = null;
      } else if (params.projectMilestone) {
        const milestone = await resolveProjectMilestone(params.projectMilestone, projectId);
        if (!milestone) {
          const hint = projectId ? "" : " Supply project when referring to a milestone by name.";
          return { content: [{ type: "text", text: `Project milestone '${params.projectMilestone}' not found.${hint}` }], isError: true };
        }
        if (params.project && milestone.projectId !== projectId) {
          return { content: [{ type: "text", text: `Project milestone '${milestone.name}' does not belong to project '${params.project}'.` }], isError: true };
        }
        // A milestone belongs to one project. Set that project as well so an issue
        // without a project (or in a different one) can be assigned in one mutation.
        input.projectId = milestone.projectId;
        input.projectMilestoneId = milestone.id;
      }

      // Resolve a workflow state when a status is given, OR pick a default state
      // for the destination team when moving teams without an explicit status
      // (Linear rejects a team move that leaves the issue in the old team's state).
      if (params.status || params.teamKey) {
        const stateData = await linearQuery(
          `query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type position } } }`,
          { teamId: stateTeamId }
        );
        const states = stateData.workflowStates?.nodes ?? [];
        if (params.status) {
          const state = states.find((s: any) => s.name.toLowerCase() === params.status!.toLowerCase());
          if (state) input.stateId = state.id;
        } else if (params.teamKey) {
          // No explicit status on a team move: default to the destination team's
          // first "unstarted" (backlog/todo) state, falling back to first by position.
          const sorted = [...states].sort((a: any, b: any) => a.position - b.position);
          const preferred = sorted.find((s: any) => s.type === "unstarted") ?? sorted.find((s: any) => s.type === "backlog") ?? sorted[0];
          if (preferred) input.stateId = preferred.id;
        }
      }

      if (params.assigneeEmail) {
        const userData = await linearQuery(`query { users(filter: { email: { eq: "${params.assigneeEmail}" } }) { nodes { id } } }`);
        const user = userData.users?.nodes?.[0];
        if (user) input.assigneeId = user.id;
      }

      // labelIds replaces the issue's complete label set. Resolve names first so
      // callers can use the same friendly label names as issue creation.
      if (params.labelNames !== undefined) {
        const labels = await listIssueLabels();
        const labelsByName = new Map(
          labels.map((label: any) => [label.name.toLowerCase(), label]),
        );
        const unknownLabels = params.labelNames.filter(
          (name) => !labelsByName.has(name.toLowerCase()),
        );
        if (unknownLabels.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Label${unknownLabels.length === 1 ? "" : "s"} not found: ${unknownLabels.join(", ")}.`,
            }],
            isError: true,
          };
        }
        input.labelIds = params.labelNames.map(
          (name) => labelsByName.get(name.toLowerCase()).id,
        );
      }

      const data = await linearQuery(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier title url state { name } team { key } assignee { name } priority priorityLabel labels { nodes { name } } project { id name } projectMilestone { id name targetDate } } } }`,
        { id: issue.id, input }
      );

      if (!data.issueUpdate?.success) return { content: [{ type: "text", text: "Failed to update issue." }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(data.issueUpdate.issue, null, 2) }], details: {} };
    },
  });

  // Tool: Add comment
  pi.registerTool({
    name: "linear_add_comment",
    label: "Linear: Add Comment",
    description: "Add a comment to a Linear issue.",
    promptSnippet: "Add a comment to a Linear issue",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
      body: Type.String({ description: "Comment body (markdown)" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.identifier, "id");
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };

      const data = await linearQuery(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt } } }`,
        { input: { issueId: issue.id, body: params.body } }
      );

      if (!data.commentCreate?.success) return { content: [{ type: "text", text: "Failed to add comment." }], isError: true };
      return { content: [{ type: "text", text: `Comment added to ${params.identifier}.` }], details: {} };
    },
  });

  // Tool: Archive issue
  pi.registerTool({
    name: "linear_archive_issue",
    label: "Linear: Archive Issue",
    description: "Archive a Linear issue (soft delete, recoverable).",
    promptSnippet: "Archive a Linear issue (soft delete, recoverable)",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.identifier, "id");
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };

      const data = await linearQuery(
        `mutation($id: String!) { issueArchive(id: $id) { success } }`,
        { id: issue.id }
      );

      if (!data.issueArchive?.success) return { content: [{ type: "text", text: `Failed to archive ${params.identifier}.` }], isError: true };
      return { content: [{ type: "text", text: `Issue ${params.identifier} archived.` }], details: {} };
    },
  });

  // Tool: Delete issue
  pi.registerTool({
    name: "linear_delete_issue",
    label: "Linear: Delete Issue",
    description: "Permanently delete a Linear issue. This is irreversible.",
    promptSnippet: "Permanently delete a Linear issue (irreversible)",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.identifier, "id");
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.identifier} not found.` }], isError: true };

      const data = await linearQuery(
        `mutation($id: String!) { issueDelete(id: $id) { success } }`,
        { id: issue.id }
      );

      if (!data.issueDelete?.success) return { content: [{ type: "text", text: `Failed to delete ${params.identifier}.` }], isError: true };
      return { content: [{ type: "text", text: `Issue ${params.identifier} permanently deleted.` }], details: {} };
    },
  });

  // Tool: Create issue relation
  pi.registerTool({
    name: "linear_create_relation",
    label: "Linear: Create Relation",
    description: "Create a relation between two Linear issues (e.g. blocks, duplicate, related).",
    promptSnippet: "Create a relation (blocks, duplicate, related) between two Linear issues",
    parameters: Type.Object({
      issueIdentifier: Type.String({ description: "The issue identifier (e.g. 'ENG-123')" }),
      relatedIssueIdentifier: Type.String({ description: "The related issue identifier (e.g. 'ENG-456')" }),
      type: Type.Union([
        Type.Literal("blocks"),
        Type.Literal("duplicate"),
        Type.Literal("related"),
      ], { description: "Relation type: 'blocks' (issueIdentifier blocks relatedIssueIdentifier), 'duplicate', or 'related'" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.issueIdentifier, "id");
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.issueIdentifier} not found.` }], isError: true };

      const relatedIssue = await resolveIssue(params.relatedIssueIdentifier, "id");
      if (!relatedIssue) return { content: [{ type: "text", text: `Issue ${params.relatedIssueIdentifier} not found.` }], isError: true };

      const data = await linearQuery(
        `mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id type issue { identifier } relatedIssue { identifier } } } }`,
        { input: { issueId: issue.id, relatedIssueId: relatedIssue.id, type: params.type } }
      );

      if (!data.issueRelationCreate?.success) return { content: [{ type: "text", text: "Failed to create relation." }], isError: true };
      const rel = data.issueRelationCreate.issueRelation;
      return { content: [{ type: "text", text: `Relation created: ${rel.issue.identifier} ${rel.type} ${rel.relatedIssue.identifier}` }], details: {} };
    },
  });

  // Tool: Delete relation
  pi.registerTool({
    name: "linear_delete_relation",
    label: "Linear: Delete Relation",
    description: "Delete a relation between two Linear issues. Finds and removes the relation by the two issue identifiers.",
    promptSnippet: "Delete a relation between two Linear issues",
    parameters: Type.Object({
      issueIdentifier: Type.String({ description: "The issue identifier (e.g. 'ENG-123')" }),
      relatedIssueIdentifier: Type.String({ description: "The related issue identifier (e.g. 'ENG-456')" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const issue = await resolveIssue(params.issueIdentifier, `id relations { nodes { id type issue { identifier } relatedIssue { identifier } } }`);
      if (!issue) return { content: [{ type: "text", text: `Issue ${params.issueIdentifier} not found.` }], isError: true };

      const relation = issue.relations?.nodes?.find((r: any) =>
        r.relatedIssue?.identifier === params.relatedIssueIdentifier ||
        r.issue?.identifier === params.relatedIssueIdentifier
      );
      if (!relation) return { content: [{ type: "text", text: `No relation found between ${params.issueIdentifier} and ${params.relatedIssueIdentifier}.` }], isError: true };

      const data = await linearQuery(
        `mutation($id: String!) { issueRelationDelete(id: $id) { success } }`,
        { id: relation.id }
      );

      if (!data.issueRelationDelete?.success) return { content: [{ type: "text", text: "Failed to delete relation." }], isError: true };
      return { content: [{ type: "text", text: `Relation between ${params.issueIdentifier} and ${params.relatedIssueIdentifier} deleted.` }], details: {} };
    },
  });

  // Tool: List issue labels
  pi.registerTool({
    name: "linear_list_labels",
    label: "Linear: List Labels",
    description: "List all issue labels available in the Linear workspace.",
    promptSnippet: "List all available Linear issue labels",
    parameters: Type.Object({}),
    async execute() {
      const labels = (await listIssueLabels()).map((label: any) => ({
        id: label.id,
        name: label.name,
        description: label.description,
        color: label.color,
        isGroup: label.isGroup,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(labels, null, 2) }],
        details: { count: labels.length },
      };
    },
  });

  // Tool: List teams
  pi.registerTool({
    name: "linear_list_teams",
    label: "Linear: List Teams",
    description: "List all teams in the Linear workspace.",
    promptSnippet: "List all teams in the Linear workspace",
    parameters: Type.Object({}),
    async execute() {
      const data = await linearQuery(`query { teams { nodes { id key name description } } }`);
      return { content: [{ type: "text", text: JSON.stringify(data.teams.nodes, null, 2) }], details: { count: data.teams.nodes.length } };
    },
  });

  // Tool: Get my issues
  pi.registerTool({
    name: "linear_my_issues",
    label: "Linear: My Issues",
    description: "Get issues assigned to the authenticated user (me), optionally filtered by status.",
    promptSnippet: "Get issues assigned to me, optionally filtered by status",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status name" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)", default: 20 })),
    }),
    async execute(_toolCallId, params, _signal) {
      const limit = params.limit ?? 20;
      let filter = `assignee: { isMe: { eq: true } }`;
      if (params.status) filter += `, state: { name: { eqCaseInsensitive: "${params.status}" } }`;

      const data = await linearQuery(
        `query { issues(filter: { ${filter} }, first: ${limit}, orderBy: updatedAt) {
          nodes { identifier title priority priorityLabel state { name } team { key }
            project { id name } projectMilestone { id name targetDate } labels { nodes { name } } estimate dueDate url updatedAt } } }`
      );

      const issues = data.issues?.nodes ?? [];
      const formatted = issues.map((i: any) => ({
        id: i.identifier, title: i.title, status: i.state?.name,
        priority: i.priorityLabel, team: i.team?.key,
        project: i.project ? { id: i.project.id, name: i.project.name } : null,
        projectMilestone: i.projectMilestone ? { id: i.projectMilestone.id, name: i.projectMilestone.name } : null,
        labels: i.labels?.nodes?.map((l: any) => l.name) ?? [],
        dueDate: i.dueDate, url: i.url,
      }));

      return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }], details: { count: formatted.length } };
    },
  });

  // Tool: Create project
  pi.registerTool({
    name: "linear_create_project",
    label: "Linear: Create Project",
    description: "Create a new Linear project. Can optionally associate it with a team and set status/description.",
    promptSnippet: "Create a new Linear project with name, description, team, and optional fields",
    parameters: Type.Object({
      name: Type.String({ description: "Project name" }),
      description: Type.Optional(Type.String({ description: "Project description (markdown)" })),
      teamKeys: Type.Optional(Type.Array(Type.String(), { description: "Team keys to associate (e.g. ['ENG', 'FDN'])" })),
      state: Type.Optional(Type.String({ description: "Project state: 'planned', 'started', 'paused', 'completed', 'canceled' (default: 'planned')" })),
      targetDate: Type.Optional(Type.String({ description: "Target completion date (ISO 8601, e.g. '2026-07-01')" })),
      leadEmail: Type.Optional(Type.String({ description: "Project lead email" })),
    }),
    async execute(_toolCallId, params, _signal) {
      const input: Record<string, any> = { name: params.name };
      if (params.description) input.description = params.description;
      if (params.state) input.state = params.state;
      if (params.targetDate) input.targetDate = params.targetDate;

      if (params.teamKeys?.length) {
        const teamData = await linearQuery(`query { teams { nodes { id key } } }`);
        const teamIds = params.teamKeys
          .map((key) => teamData.teams?.nodes?.find((t: any) => t.key === key))
          .filter(Boolean)
          .map((t: any) => t.id);
        if (teamIds.length) input.teamIds = teamIds;
      }

      if (params.leadEmail) {
        const userData = await linearQuery(`query { users(filter: { email: { eq: "${params.leadEmail}" } }) { nodes { id } } }`);
        const user = userData.users?.nodes?.[0];
        if (user) input.leadId = user.id;
      }

      const data = await linearQuery(
        `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name description state url targetDate lead { name email } teams { nodes { key name } } } } }`,
        { input }
      );

      if (!data.projectCreate?.success) return { content: [{ type: "text", text: "Failed to create project." }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(data.projectCreate.project, null, 2) }], details: {} };
    },
  });

  // Tool: Get project
  pi.registerTool({
    name: "linear_get_project",
    label: "Linear: Get Project",
    description: "Get full details of a Linear project by its ID or URL slug, including description, status, lead, teams, and member issues.",
    promptSnippet: "Get full details of a Linear project including description, status, and issues",
    parameters: Type.Object({
      projectId: Type.String({ description: "Project ID (UUID) or project slug URL" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const data = await linearQuery(
        `query($id: String!) { project(id: $id) { id name description content state url targetDate startDate lead { name email } teams { nodes { key name } } members { nodes { name email } } projectMilestones(first: 250) { nodes { id name description targetDate status progress } } projectUpdates(first: 5) { nodes { body createdAt user { name } } } issues { nodes { identifier title state { name } assignee { name } priority priorityLabel projectMilestone { id name } } } } }`,
        { id: params.projectId }
      );

      if (!data.project) {
        return { content: [{ type: "text", text: `Project not found.` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(data.project, null, 2) }], details: {} };
    },
  });

  // Tool: View images embedded in a project's markdown content.
  pi.registerTool({
    name: "linear_view_project_images",
    label: "Linear: View Project Images",
    description: "Download and display images embedded in a Linear project's content. The returned images are available to image-capable models and render inline in supported terminals.",
    promptSnippet: "View images embedded in a Linear project page",
    promptGuidelines: [
      "Use linear_view_project_images when a Linear project page contains screenshots or other embedded images that must be inspected.",
    ],
    parameters: Type.Object({
      projectId: Type.String({ description: "Project ID, URL slug, or full Linear project URL" }),
      imageIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "One-based indexes of images to view. Omit to view the first images." })),
      maxImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 5, description: "Maximum images to return when imageIndexes is omitted (default 5, max 5)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await linearQuery(
        `query($id: String!) { project(id: $id) { id name content url } }`,
        { id: params.projectId },
      );
      const project = data.project;
      if (!project) {
        return { content: [{ type: "text", text: "Project not found." }], isError: true };
      }

      const allImages = imagesInMarkdown(project.content);
      if (allImages.length === 0) {
        return {
          content: [{ type: "text", text: `No embedded Linear-upload images found in '${project.name}'.` }],
          details: { projectId: project.id, imageCount: 0 },
        };
      }

      const selected = params.imageIndexes
        ? [...new Set(params.imageIndexes)].map((index) => ({ index, image: allImages[index - 1] })).filter(
            (item): item is { index: number; image: LinearImage } => item.image !== undefined,
          )
        : allImages.slice(0, params.maxImages ?? 5).map((image, index) => ({ index: index + 1, image }));

      if (selected.length === 0) {
        return {
          content: [{ type: "text", text: `No requested image indexes exist. This project has ${allImages.length} image(s).` }],
          details: { projectId: project.id, imageCount: allImages.length },
          isError: true,
        };
      }

      const results = await Promise.all(selected.map(async ({ index, image }) => {
        try {
          return { index, alt: image.alt, url: image.url, image: await fetchLinearImage(image.url, signal) };
        } catch (error) {
          return { index, alt: image.alt, url: image.url, error: error instanceof Error ? error.message : String(error) };
        }
      }));

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: `Images from '${project.name}' (${allImages.length} total):` },
      ];

      for (const result of results) {
        if ("error" in result) {
          content.push({ type: "text", text: `${result.index}. ${result.alt}: unavailable (${result.error})` });
        } else {
          content.push({ type: "text", text: `${result.index}. ${result.alt}` });
          content.push({ type: "image", ...result.image });
        }
      }

      return {
        content,
        details: {
          projectId: project.id,
          projectUrl: project.url,
          imageCount: allImages.length,
          images: results.map(({ index, alt, url, error }) => ({ index, alt, url, error })),
        },
      };
    },
  });

  // Tool: Update project
  pi.registerTool({
    name: "linear_update_project",
    label: "Linear: Update Project",
    description: "Update a Linear project's name, description, state, target date, or lead.",
    promptSnippet: "Update a Linear project's name, description, state, or target date",
    parameters: Type.Object({
      projectId: Type.String({ description: "Project ID (UUID from project creation or search)" }),
      name: Type.Optional(Type.String({ description: "New project name" })),
      description: Type.Optional(Type.String({ description: "Short description, max 255 chars" })),
      content: Type.Optional(Type.String({ description: "Full project document/content (markdown, no length limit)" })),
      state: Type.Optional(Type.String({ description: "Project state: 'planned', 'started', 'paused', 'completed', 'canceled'" })),
      targetDate: Type.Optional(Type.String({ description: "Target completion date (ISO 8601)" })),
      leadEmail: Type.Optional(Type.String({ description: "Project lead email" })),
    }),
    async execute(_toolCallId, params, _signal) {
      const input: Record<string, any> = {};
      if (params.name) input.name = params.name;
      if (params.description) input.description = params.description;
      if (params.content) input.content = params.content;
      if (params.state) input.state = params.state;
      if (params.targetDate) input.targetDate = params.targetDate;

      if (params.leadEmail) {
        const userData = await linearQuery(`query { users(filter: { email: { eq: "${params.leadEmail}" } }) { nodes { id } } }`);
        const user = userData.users?.nodes?.[0];
        if (user) input.leadId = user.id;
      }

      const data = await linearQuery(
        `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name description state url targetDate lead { name email } } } }`,
        { id: params.projectId, input }
      );

      if (!data.projectUpdate?.success) return { content: [{ type: "text", text: "Failed to update project." }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(data.projectUpdate.project, null, 2) }], details: {} };
    },
  });

  // Tool: Add issues to project
  pi.registerTool({
    name: "linear_add_issues_to_project",
    label: "Linear: Add Issues to Project",
    description: "Add one or more issues to a Linear project by updating each issue's projectId.",
    promptSnippet: "Add issues to a Linear project",
    parameters: Type.Object({
      projectId: Type.String({ description: "Project ID (UUID)" }),
      issueIdentifiers: Type.Array(Type.String(), { description: "Issue identifiers to add (e.g. ['FDN-1362', 'FDN-1363'])" }),
    }),
    async execute(_toolCallId, params, _signal) {
      const results: string[] = [];
      for (const identifier of params.issueIdentifiers) {
        const issue = await resolveIssue(identifier, "id");
        if (!issue) {
          results.push(`${identifier}: not found`);
          continue;
        }
        const data = await linearQuery(
          `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
          { id: issue.id, input: { projectId: params.projectId } }
        );
        results.push(`${identifier}: ${data.issueUpdate?.success ? "added" : "failed"}`);
      }
      return { content: [{ type: "text", text: results.join("\n") }], details: {} };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Linear integration loaded ✓", "info");
  });
}
