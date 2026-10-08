import type { ArchymedesWorkspace } from "../cli/backends";
import type { ExternalTool, ToolProvider } from "../cli/tool-providers";
import { validateToolArguments } from "../cli/tool-schema";
import { discoverSkillManifestsIn, substitutePlaceholders, type SkillManifest } from "./manifest";

/**
 * Exposes every discovered skill as a `ToolProvider`, executed through the workspace's own
 * `runCommand` — the same containment a `run_command` tool call gets, so a skill is a tool the
 * project can gate exactly like any other.
 *
 * `skillsDirectory` is workspace-root-relative — `.archymedes/skills`, or a specific plugin's own.
 */
export class SkillToolProvider implements ToolProvider {
  readonly kind = "skill" as const;

  constructor(readonly id: string, private readonly skillsDirectory: string, private readonly workspace: ArchymedesWorkspace) {}

  async listTools(): Promise<ExternalTool[]> {
    const manifests = await discoverSkillManifestsIn(this.workspace, this.skillsDirectory);
    return manifests.map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      inputSchema: manifest.inputSchema,
      invoke: async (argumentsValue) => {
        const validated = validateToolArguments(manifest.name, manifest.inputSchema, argumentsValue);
        const command = substitutePlaceholders(manifest.command, validated, this.workspace.commandPlatform);
        const result = await this.workspace.runCommand(command, manifest.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS);
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        return { content: `exit ${result.exitCode}\n${body}`, isError: result.exitCode !== 0 };
      },
    }));
  }
}

export type { SkillManifest };

const DEFAULT_SKILL_TIMEOUT_MS = 60_000;
