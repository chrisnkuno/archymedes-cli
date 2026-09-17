/**
 * Images the user points at, sent to the model as images rather than as a path it cannot see.
 *
 * `@screenshot.png` in a request attaches that file to the turn. Only real image bytes qualify (the
 * type comes from the file's signature, not its extension), sizes and counts are capped because every
 * provider rejects oversized image payloads outright, and anything that cannot be attached is said in
 * the request itself so the model can tell the user rather than silently answering without it.
 *
 * Attached images belong to one turn. `withoutImageData` swaps them for a one-line note before the
 * conversation is saved: base64 screenshots would otherwise bloat every session file and be resent
 * in full on every later turn.
 */
import type { AgentImage, AgentMessage } from "../agent-runtime";

export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MENTION = /(?:^|\s)@((?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|gif|webp))(?=$|[\s,;:!?)])/gi;

export function mentionedImagePaths(objective: string): string[] {
  return [...new Set([...objective.matchAll(MENTION)].map((match) => match[1]))];
}

export function imageMediaType(bytes: Uint8Array): AgentImage["mediaType"] | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

/** Only local workspaces can read raw bytes today; a sandbox reports that images cannot be attached. */
type ByteReader = { readBytes?: (path: string) => Promise<{ path: string; bytes: Uint8Array }> };

export async function attachMentionedImages(workspace: object, objective: string): Promise<{ images: AgentImage[]; problems: string[] }> {
  const images: AgentImage[] = [];
  const problems: string[] = [];
  const paths = mentionedImagePaths(objective);
  if (paths.length === 0) return { images, problems };
  const readBytes = (workspace as ByteReader).readBytes?.bind(workspace);
  if (!readBytes) return { images, problems: paths.map((path) => `@${path}: images can only be attached from a local workspace`) };
  for (const path of paths) {
    if (images.length >= MAX_IMAGES_PER_TURN) {
      problems.push(`@${path}: at most ${MAX_IMAGES_PER_TURN} images per request`);
      continue;
    }
    try {
      const { path: resolved, bytes } = await readBytes(path);
      const mediaType = imageMediaType(bytes);
      if (!mediaType) problems.push(`@${path}: not a PNG, JPEG, GIF or WebP image`);
      else if (bytes.byteLength > MAX_IMAGE_BYTES) problems.push(`@${path}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      else images.push({ path: resolved, mediaType, data: Buffer.from(bytes).toString("base64") });
    } catch (error) {
      problems.push(`@${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { images, problems };
}

/** The request text the model receives: the user's words, plus a line for each image that did not attach. */
export function objectiveWithImageProblems(objective: string, problems: readonly string[]): string {
  return problems.length ? `${objective}\n\n(Not attached — ${problems.join("; ")}.)` : objective;
}

export function withoutImageData(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!("images" in message) || !message.images?.length) return message;
    const { images, ...rest } = message;
    return { ...rest, content: `${message.content}\n\n[${images.map((image) => `image attached: ${image.path}`).join("; ")}]` };
  });
}
