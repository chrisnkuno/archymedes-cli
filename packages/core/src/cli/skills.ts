/**
 * Compatibility shim: skills now live in `../skills/`, and this module re-exports them unchanged.
 *
 * The implementation moved so that skills share one layer under `src/` with MCP and hooks, rather
 * than sitting beside the CLI's own command handlers. Existing imports — this package's `index.ts`,
 * `external-tools.ts` and the tests that pin skill discovery and execution — keep working against
 * the same names.
 */
export { SKILLS_DIRECTORY, parseSkillManifest, discoverSkillManifests, discoverSkillManifestsIn, substitutePlaceholders, SkillToolProvider } from "../skills";
export type { SkillManifest } from "../skills";
