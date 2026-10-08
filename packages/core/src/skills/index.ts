/**
 * Skills: reusable, project-local capabilities declared as data (`.archymedes/skills/<name>/skill.json`)
 * and executed as ordinary tools through the workspace.
 *
 * Module map:
 * - `manifest.ts` — the `SkillManifest` shape, parsing, discovery and argument substitution.
 * - `provider.ts` — `SkillToolProvider`, which turns discovered skills into agent tools.
 */

export { SKILLS_DIRECTORY, parseSkillManifest, discoverSkillManifests, discoverSkillManifestsIn, substitutePlaceholders } from "./manifest";
export type { SkillManifest } from "./manifest";
export { SkillToolProvider } from "./provider";
