import type { AgentTool } from "../../agent-runtime";
import { imageMediaType, MAX_IMAGE_BYTES } from "../image-attachments";
import { ARCHYMEDES_CAPABILITIES } from "../permissions";
import { readBinaryFile, WorkspaceViolation } from "../workspace";
import { requiredString, resolvedLimits, type ExtraToolOptions } from "./shared";

/**
 * `view_image`: lets the model look at an image file in the workspace — a screenshot, a rendered
 * chart, a UI snapshot a test wrote — rather than only being told its path.
 *
 * The bytes go back as an image on the tool result (`AgentToolResult.images`), which each provider
 * adapter sends in its own way; the text content is just a caption. The type comes from the file's
 * signature, not its extension, and the size is capped at the same limit as `@image` attachments,
 * because every provider rejects oversized image payloads outright.
 */
export function createImageTools(options: ExtraToolOptions): AgentTool[] {
  const { root } = options;
  // The image cap replaces the text read limit: a 2 MB screenshot is ordinary, a 2 MB text file is not.
  const limits = { ...resolvedLimits(options), maxReadBytes: MAX_IMAGE_BYTES };
  return [
    {
      name: "view_image",
      description:
        "Look at an image file in the project (PNG, JPEG, GIF or WebP, up to 5 MB): the image itself is returned for you to see. "
        + "Use it for screenshots, rendered output, diagrams or UI snapshots — read_file cannot show image contents.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image file path, relative to the project root." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const { path, bytes } = await readBinaryFile(root, requiredString(args.path, "path"), limits);
        const mediaType = imageMediaType(bytes);
        if (!mediaType) throw new WorkspaceViolation(`${path} is not a PNG, JPEG, GIF or WebP image`);
        return {
          content: `Image ${path} (${mediaType}, ${bytes.byteLength} bytes) is attached below.`,
          images: [{ path, mediaType, data: Buffer.from(bytes).toString("base64") }],
          data: { path, mediaType, bytes: bytes.byteLength },
        };
      },
    },
  ];
}
