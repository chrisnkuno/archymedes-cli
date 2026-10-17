import type { ProviderOverview, SetupStatus } from "../acp-setup";
import { claudeIsDefault, claudeModels, claudeReadiness, type BackendDependencies } from "./backend";
import { CLAUDE_LABEL, CLAUDE_PROVIDER } from "./identity";

/**
 * Claude in the lists the interface draws — the Providers app, the model picker, first-run setup —
 * beside the model providers, without making it one of them (it has no key, no price list, no
 * models endpoint: it is Claude Code, signed in or not).
 */

/** The providers, with Claude second: after free, which needs nothing at all. */
export function withClaude<T extends { id: string }>(providers: T[], claude: T): T[] {
  const free = providers.findIndex((provider) => provider.id === "free");
  return [...providers.slice(0, free + 1), claude, ...providers.slice(free + 1)];
}

type ModelListing = {
  choices: Array<Record<string, unknown> & { provider: string }>;
  unconfigured: Array<{ provider: string; label: string; missing: string[] }>;
};

/** The model picker's list, with Claude's models: usable once Claude is ready, shown (locked) before. */
export function withClaudeModels<T extends ModelListing>(listing: T, claude: ProviderOverview): T {
  const preferred = claude.model || "default";
  const choices = claudeModels().map((model) => ({
    provider: CLAUDE_PROVIDER, providerLabel: CLAUDE_LABEL, model, isDefault: model === preferred, live: false,
    price: "your Claude plan", free: false, locked: !claude.configured, missing: claude.missing, small: model === "haiku",
  }));
  const ready = listing.choices.filter((choice) => choice.locked !== true);
  const locked = listing.choices.filter((choice) => choice.locked === true);
  return {
    ...listing,
    choices: claude.configured ? [...ready, ...choices, ...locked] : [...ready, ...locked, ...choices],
    unconfigured: claude.configured ? listing.unconfigured : [...listing.unconfigured, { provider: CLAUDE_PROVIDER, label: CLAUDE_LABEL, missing: claude.missing }],
  };
}

/**
 * First-run setup asks "is anything usable?". Claude as the default provider is usable when it is
 * ready, even with no model provider configured; otherwise the answer is the model providers'.
 */
export async function claudeSetupStatus(status: SetupStatus, requested: { provider?: string }, deps: BackendDependencies): Promise<SetupStatus> {
  const wanted = requested.provider ? requested.provider === CLAUDE_PROVIDER : claudeIsDefault(deps.environment);
  if (!wanted) return status;
  const readiness = await claudeReadiness(deps);
  if (readiness.ready) return { ...status, configured: true, reason: undefined };
  return { ...status, configured: false, reason: `Claude needs ${readiness.missing}.` };
}
