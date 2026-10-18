import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { settingsDirectory } from "../../platform/settings";

/**
 * The part of Anthropic's Claude Agent SDK this integration uses, and how it is found.
 *
 * The SDK is not bundled. It is Anthropic's code, "all rights reserved", so Archymedes does not
 * redistribute it: the person's machine installs it from npm (see `install.ts`) into Friday's
 * own folder, and this file imports it from there at run time. Nothing here imports it at build
 * time, which is also what keeps it out of the bundle for everyone who never uses Claude.
 *
 * The types below are transcribed from `sdk.d.ts` of the pinned version, and only as wide as this
 * integration reads. A field the SDK adds is ignored; a field it renames fails a test here before
 * it can fail a session.
 */

/** The version installed and tested against. A different one may work; this one is known to. */
export const CLAUDE_SDK_VERSION = "0.3.301";
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/** A permission rule change Claude Code proposes with a request ("always allow this"). */
export type PermissionUpdate = { type: string; destination?: string; [key: string]: unknown };

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string; decisionReason?: string },
) => Promise<PermissionResult>;

export type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  /** Set by us, so a turn's files can be rewound to the moment it was asked (`rewindFiles`). */
  uuid: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

/** The Messages API's usage block, as Claude Code reports it per call and per turn. */
export type ApiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
};

export type StreamEvent =
  | { type: "message_start"; message: { id: string; model?: string; usage?: ApiUsage } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string } }
  | { type: "message_delta"; usage?: ApiUsage }
  | { type: "message_stop" }
  | { type: string; [key: string]: unknown };

export type RateLimitInfo = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
};

/** The messages a query yields that this integration acts on; anything else is skipped by `type`. */
export type SdkMessage =
  | { type: "system"; subtype: "init"; session_id: string; model: string; tools: string[]; apiKeySource?: string; claude_code_version?: string }
  | { type: "system"; subtype: "api_retry"; attempt: number; max_retries: number; retry_delay_ms: number; error_status: number | null; error: string }
  | { type: "system"; subtype: "compact_boundary"; compact_metadata: { trigger: string; pre_tokens: number; post_tokens?: number } }
  | { type: "stream_event"; event: StreamEvent; parent_tool_use_id: string | null }
  | { type: "assistant"; message: { id: string; model?: string; content: ContentBlock[] }; parent_tool_use_id: string | null; error?: string }
  | { type: "user"; message: { role: "user"; content: string | ContentBlock[] }; parent_tool_use_id: string | null; isSynthetic?: boolean }
  | {
    type: "result";
    subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
    is_error: boolean;
    result?: string;
    errors?: string[];
    num_turns: number;
    total_cost_usd: number;
    usage: ApiUsage;
    session_id: string;
  }
  | { type: "rate_limit_event"; rate_limit_info: RateLimitInfo }
  | { type: string; subtype?: string; [key: string]: unknown };

export type ModelInfo = { value: string; displayName: string; description: string };

export type RewindFilesResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };

export interface Query extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  close(): void;
}

export interface WarmQuery {
  query(prompt: AsyncIterable<SdkUserMessage>): Query;
  close(): void;
}

export type ClaudeOptions = {
  cwd: string;
  pathToClaudeCodeExecutable: string;
  env: Record<string, string | undefined>;
  model?: string;
  permissionMode: PermissionMode;
  canUseTool: CanUseTool;
  includePartialMessages: true;
  enableFileCheckpointing: true;
  systemPrompt: { type: "preset"; preset: "claude_code"; append?: string };
  resume?: string;
  stderr?: (data: string) => void;
};

/** What the module exports, as far as this integration calls it. */
export type ClaudeSdk = {
  startup(params: { options: ClaudeOptions; initializeTimeoutMs?: number }): Promise<WarmQuery>;
};

/** Where Archymedes installs the SDK for this person: beside its settings, never in a project. */
export function managedSdkDirectory(environment: Record<string, string | undefined>): string {
  return path.join(settingsDirectory(environment), "claude-agent-sdk");
}

/** The entry module inside an install prefix. */
export function sdkEntry(prefix: string): string {
  return path.join(prefix, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"), "sdk.mjs");
}

/**
 * The SDK's entry module on this machine: `ARCHYMEDES_CLAUDE_SDK` (a path to `sdk.mjs` or to an
 * install prefix) first, then Archymedes's own install. Undefined when neither is there.
 */
export function findSdk(environment: Record<string, string | undefined>, exists: (file: string) => boolean = existsSync): string | undefined {
  const override = environment.ARCHYMEDES_CLAUDE_SDK?.trim();
  const candidates = override
    ? [override.endsWith(".mjs") ? override : sdkEntry(override)]
    : [sdkEntry(managedSdkDirectory(environment))];
  return candidates.find((candidate) => exists(candidate));
}

/** Imports the SDK, once per entry path for the life of the process. */
const loaded = new Map<string, Promise<ClaudeSdk>>();

export function loadSdk(entry: string): Promise<ClaudeSdk> {
  let module = loaded.get(entry);
  if (!module) {
    module = (import(pathToFileURL(entry).href) as Promise<ClaudeSdk>).then((value) => {
      if (typeof value.startup !== "function") throw new Error(`${entry} is not the Claude Agent SDK (no startup export)`);
      return value;
    });
    // A failed import is not cached: installing the SDK and trying again must work in this process.
    module.catch(() => loaded.delete(entry));
    loaded.set(entry, module);
  }
  return module;
}
