/**
 * Somewhere for a tab's work to happen.
 *
 * Was a single workspace built once for the whole session; it is now a factory, because a tab is
 * allowed to run somewhere else. "Run this one in a throwaway sandbox and that one against my
 * checkout" is the thing a control panel is for, and it is only a factory call away once the
 * construction stops being a straight line through `main`.
 *
 * Each remote workspace is a *separate* sandbox with its own lifetime, so closing a tab stops
 * paying for exactly that one. Errors are returned rather than thrown: a tab that cannot start a
 * sandbox must report why and leave the session alone, where the startup path used to be entitled
 * to exit the process.
 */
import { DockerWorkspace, E2BWorkspace, LocalWorkspace, uploadProject, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { SandboxBackend } from "../session/location";
import type { ParsedArgs } from "./args";
import type { Environment } from "./session-state";
import { out, style } from "./transcript";

export type WorkspaceRequest = { backend: SandboxBackend; upload?: boolean; dockerImage?: string; preset?: string; announce?: boolean };
export type WorkspaceFactory = (request: WorkspaceRequest) => Promise<{ workspace: ArchymedesWorkspace } | { error: string }>;

export function createWorkspaceFactory(args: ParsedArgs, environment: Environment): WorkspaceFactory {
  return async (request) => {
    const announce = (text: string) => { if (request.announce !== false) out.write(style.dim(`${text}\n`)); };
    const minutes = Math.max(1, Math.min(args.sandboxMinutes, 60));

    if (request.backend === "e2b") {
      // Imported here, not at the top: a local-only session should never load the E2B SDK, which is
      // what lets the published package treat it as an optional dependency.
      const { findWorkspacePreset } = await import("@archymedes/core/sandbox-templates");
      const { createE2BProvider } = await import("@archymedes/core/providers/factory");
      const preset = findWorkspacePreset(request.preset ?? args.preset);
      const sandbox = createE2BProvider(environment, preset.templateAlias);
      if (!sandbox) return { error: "Remote sandboxes need E2B. Set E2B_API_KEY (and E2B_CODING_TEMPLATE for a custom image)." };
      announce(`Starting an E2B sandbox (${preset.label}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `archymedes_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        return { error: `E2B could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
      const created = new E2BWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        // Stopped rather than suspended: a CLI session that ends has no next step to resume into,
        // and a sandbox left paused keeps costing the user something they cannot see.
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  sandbox ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    if (request.backend === "docker") {
      // Same late import as E2B above, for the same reason: a local session should not pay to load
      // a backend it will never use.
      const { createDockerProvider } = await import("@archymedes/core/providers/factory");
      const image = request.dockerImage || args.dockerImage || environment.DOCKER_CODING_IMAGE;
      // The flag wins over the environment variable, but either can name the image.
      const sandbox = createDockerProvider({ ...environment, DOCKER_CODING_IMAGE: image });
      if (!sandbox) return { error: "Could not start a Docker sandbox. Pass --docker-image or set DOCKER_CODING_IMAGE." };
      announce(`Starting a Docker container (${image}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `archymedes_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        // Docker missing, daemon not running, or image not pullable — all of them land here, and all
        // of them are worth saying plainly rather than as an unhandled rejection stack.
        return { error: `Docker could not start: ${error instanceof Error ? error.message : String(error)}. Check that Docker is installed and running, and that the image exists.` };
      }
      const created = new DockerWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  container ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    return { workspace: new LocalWorkspace(args.root) };
  };
}
