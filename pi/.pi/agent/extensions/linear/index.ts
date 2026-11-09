import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  const attachmentPattern = /!?\[([^\]]*)\]\(<?(https:\/\/uploads\.linear\.app\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g;

  for (const match of markdown.matchAll(attachmentPattern)) {
    const [, name, url] = match;
    if (!url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    attachments.push({ name: name || `Attachment ${attachments.length + 1}`, url });
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

async function linearQuery(query: string, variables: Record<string, any> = {}, signal?: AbortSignal) {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getCredential("LINEAR_API_KEY"),
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!response.ok) throw new Error(`Linear API returned ${response.status}.`);
  const json = await response.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

async function resolveIssue(identifier: string, fields: string, signal?: AbortSignal) {
  const data = await linearQuery(
    `query($id: String!) { issue(id: $id) { ${fields} } }`,
    { id: identifier },
    signal,
  );
  return data.issue;
}

export default function (pi: ExtensionAPI) {
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
      const issue = await resolveIssue(params.identifier, "id identifier title description url", signal);
      if (!issue) throw new Error(`Issue ${params.identifier} not found.`);

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

      if (selected.length === 0) throw new Error(`No requested attachment indexes exist. ${issue.identifier} has ${allAttachments.length} attachment(s) in its description.`);

      const outputDirectory = await mkdtemp(join(tmpdir(), `pi-linear-${issue.identifier}-`));
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
            content.push({ type: "text", text: `Video frame samples${Number.isFinite(duration) ? ` across ${duration.toFixed(1)}s` : ""}:` });

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
            content.push({ type: "text", text: `File preview:\n${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}${truncated ? "\n[Preview truncated; full file is available at the saved path.]" : ""}` });
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
        details: { issueIdentifier: issue.identifier, issueUrl: issue.url, attachmentCount: allAttachments.length, outputDirectory, attachments: details },
      };
    },
  });

  pi.registerTool({
    name: "linear_archive_issue",
    label: "Linear: Archive Issue",
    description: "Archive a Linear issue (soft delete, recoverable).",
    promptSnippet: "Archive a Linear issue (soft delete, recoverable)",
    parameters: Type.Object({ identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }) }),
    async execute(_toolCallId, params, signal) {
      const issue = await resolveIssue(params.identifier, "id", signal);
      if (!issue) throw new Error(`Issue ${params.identifier} not found.`);
      const data = await linearQuery(
        `mutation($id: String!) { issueArchive(id: $id) { success } }`,
        { id: issue.id },
        signal,
      );
      if (!data.issueArchive?.success) throw new Error(`Failed to archive ${params.identifier}.`);
      return { content: [{ type: "text", text: `Issue ${params.identifier} archived.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "linear_delete_issue",
    label: "Linear: Delete Issue",
    description: "Permanently delete a Linear issue. This is irreversible.",
    promptSnippet: "Permanently delete a Linear issue (irreversible)",
    parameters: Type.Object({ identifier: Type.String({ description: "Issue identifier like 'ENG-123'" }) }),
    async execute(_toolCallId, params, signal) {
      const issue = await resolveIssue(params.identifier, "id", signal);
      if (!issue) throw new Error(`Issue ${params.identifier} not found.`);
      const data = await linearQuery(
        `mutation($id: String!) { issueDelete(id: $id) { success } }`,
        { id: issue.id },
        signal,
      );
      if (!data.issueDelete?.success) throw new Error(`Failed to delete ${params.identifier}.`);
      return { content: [{ type: "text", text: `Issue ${params.identifier} permanently deleted.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "linear_view_project_images",
    label: "Linear: View Project Images",
    description: "Download and display images embedded in a Linear project's content. The returned images are available to image-capable models and render inline in supported terminals.",
    promptSnippet: "View images embedded in a Linear project page",
    promptGuidelines: ["Use linear_view_project_images when a Linear project page contains screenshots or other embedded images that must be inspected."],
    parameters: Type.Object({
      projectId: Type.String({ description: "Project ID, URL slug, or full Linear project URL" }),
      imageIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "One-based indexes of images to view. Omit to view the first images." })),
      maxImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 5, description: "Maximum images to return when imageIndexes is omitted (default 5, max 5)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await linearQuery(
        `query($id: String!) { project(id: $id) { id name content url } }`,
        { id: params.projectId },
        signal,
      );
      const project = data.project;
      if (!project) throw new Error("Project not found.");
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
      if (selected.length === 0) throw new Error(`No requested image indexes exist. This project has ${allImages.length} image(s).`);
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
        if ("error" in result) content.push({ type: "text", text: `${result.index}. ${result.alt}: unavailable (${result.error})` });
        else {
          content.push({ type: "text", text: `${result.index}. ${result.alt}` });
          content.push({ type: "image", ...result.image });
        }
      }
      return {
        content,
        details: { projectId: project.id, projectUrl: project.url, imageCount: allImages.length, images: results.map(({ index, alt, url, error }) => ({ index, alt, url, error })) },
      };
    },
  });
}
