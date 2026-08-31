/**
 * The public surface of the agent core.
 *
 * Deliberately a short list of entry points rather than a re-export of everything: a package whose
 * index exposes every internal module has no seam to change behind. Anything not named here is
 * still reachable at its own subpath (`@archymedes/core/providers/e2b`), which keeps the boundary
 * honest without making internals unreachable during the transition.
 */

export { BoundedAgentRuntime, ProviderRequestError, isRetryableProviderError, providerFailureKind, validateHistory } from "./agent-runtime";
export type {
  AgentMessage,
  AgentModelRequest,
  AgentModelTurn,
  AgentRuntimeControl,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  ProviderFailureKind,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentTurnProvider,
  ToolProvenance,
  StoredToolArtifact,
  ToolResultArtifactStore,
} from "./agent-runtime";
export { evictedToolResult } from "./agent-runtime";
export { WorkspaceArtifactStore, artifactPathFor, ARTIFACT_DIRECTORY, MAX_ARTIFACT_BYTES } from "./cli/artifacts";

export { ArchymedesAgent, DEFAULT_ARCHYMEDES_BUDGETS } from "./cli/agent";
export type { ArchymedesAgentOptions, ArchymedesBudgets, ArchymedesEvent, ArchymedesTurnResult } from "./cli/agent";

export { LocalWorkspace, E2BWorkspace, DockerWorkspace, uploadProject, downloadProject } from "./cli/backends";
export type { ArchymedesWorkspace } from "./cli/backends";

export { createArchymedesTools, TodoList } from "./cli/tools";
export type { TodoItem } from "./cli/tools";

// Tools Archymedes did not ship with: skills, hooks, plugins and MCP servers. Exported because
// implementing a `ToolProvider` is the supported way for a consumer of this package to add its own
// tool source — without these an embedder can only use the built-in set.
export { collectExternalTools, toolsFromProvider } from "./cli/tool-providers";
export type { ExternalTool, ToolProvider, ToolProviderKind } from "./cli/tool-providers";
export { discoverSkillManifests, discoverSkillManifestsIn, parseSkillManifest, substitutePlaceholders, SkillToolProvider, SKILLS_DIRECTORY } from "./cli/skills";
export type { SkillManifest } from "./cli/skills";
export { HookRegistry, HOOKS_DIRECTORY } from "./cli/hooks";
export type { HookEvent, HookSource, PreToolUseOutcome } from "./cli/hooks";
export { discoverMcpServers, parseMcpServerConfig, McpConnection, McpToolProvider } from "./cli/mcp-provider";
export type { McpServerConfig } from "./cli/mcp-provider";
export { discoverPlugins, parsePluginManifest, PLUGINS_DIRECTORY } from "./cli/plugins";
export type { PluginManifest } from "./cli/plugins";
export { loadLocalExternalTooling, IMPLICIT_SKILL_PROVIDER_ID } from "./cli/external-tools";
export type { LocalExternalTooling } from "./cli/external-tools";
export { PermissionLedger, actionDigest, approvalScopeKey, capabilitiesForMode } from "./cli/permissions";
export type { ArchymedesMode, PermissionDecision, ToolApprovalOutcome } from "./cli/permissions";
export { assessTaskSafety, assessToolSafety } from "./cli/safety";
export type { SafetyAssessment, SensitiveCategory } from "./cli/safety";
export { CheckpointStore } from "./cli/checkpoints";
export { scoreReliability, type ReliabilityCase, type ReliabilityReport } from "./cli/reliability";
export { scoreExaReliability, type ExaReliabilityCase, type ExaReliabilityReport } from "./cli/exa-reliability";
export { CostLedger } from "./cli/cost";
export { CircuitPayGateway, BillingError, billingFromEnvironment, parseAmountRwf, assertTopUpAmount, newIdempotencyKey, waitForPayment, isPaymentSettled, MINIMUM_TOP_UP_RWF, MAXIMUM_TOP_UP_RWF } from "./cli/billing";
export type { Balance, BillingGateway, Checkout, CheckoutRequest, Payment, PaymentStatus, WaitResult } from "./cli/billing";
export { listSessions, loadSession, saveSession } from "./cli/session";
export { ArchymedesStateClient, ArchymedesStateError, resolveArchymedesStateBinary, statePlatformKey, tryConnectArchymedesState, ARCHYMEDES_STATE_PROTOCOL_VERSION } from "./cli/state-client";
export type { ArchymedesStateClientOptions, StateContextDocument, StateEvidenceSource, StateIndexReport, StateSearchHit, StateSessionSummary } from "./cli/state-client";
export { assertTurnTransition, EventJournal, readEventJournal, runtimeEventForJournal, ARCHYMEDES_PROTOCOL_VERSION } from "./cli/protocol";
export type { ArchymedesEventEnvelope, ArchymedesProtocolPayload, TurnStatus } from "./cli/protocol";
export { ArchymedesDaemonClient, ArchymedesSessionDaemon, ARCHYMEDES_DAEMON_PROTOCOL_VERSION } from "./cli/daemon";
export type {
  DaemonAgentFactory,
  DaemonAgentFactoryContext,
  DaemonApprovalRequest,
  DaemonNotification,
  DaemonSessionInfo,
} from "./cli/daemon";

export { resolveProvider, describeProviders, availableProviders, PROVIDERS, PROVIDER_IDS } from "./providers/agent-matrix";
export type { ProviderId, ProviderSpec, ProviderStatus } from "./providers/agent-matrix";

export { convertTo, formatMoney, fromUnits, priceUsage, tokenPrices } from "./money";
export type { Currency, FxRate, Money, TokenPrices } from "./money";

export { cancel, claim, consumeApproval, detach, emptyStore, enqueue, finish, heartbeat, isTerminal, recoverStale, requestApproval, resolveApproval, summarize, MAX_ATTEMPTS } from "./cli/jobs";
export type { ApprovalRequest, Job, JobLease, JobStatus, JobStore, JobSummary } from "./cli/jobs";

export {
  appendJobLog,
  cancelJob,
  claimJob,
  consumeJobApproval,
  detachJob,
  enqueueJob,
  finishJob,
  getJob,
  heartbeatJob,
  jobLogPath,
  jobStoreFile,
  listJobs,
  newJobId,
  readJobLog,
  requestJobApproval,
  resolveJobApproval,
  withJobs,
} from "./cli/job-store";

export { definePrices, priceAliases, selectPrice, tokenPricesAt, tokenPricesFor, validatePriceRecord } from "./pricing";
export type { BillingUnit, PriceModality, PriceQuery, PriceRecord } from "./pricing";
export { PRICE_CATALOG } from "./providers/price-catalog";

// The suggestion engine both front ends read: what to do next, why now, and the ambient hints that
// teach the rest of the product. Exported because a suggestion that exists only in the CLI is the
// exact failure the shared rules were written to end.
export {
  CATEGORY_ORDER,
  classifyFailure,
  defaultSignals,
  mergeModelSuggestions,
  shouldOfferStarters,
  starterSuggestions,
  suggest,
  suggestionIds,
} from "./cli/suggestions";
export type {
  DesktopActionId,
  FailureKind,
  SessionSignals,
  Suggestion,
  SuggestionAction,
  SuggestionCategory,
  SuggestionSurface,
  SuggestOptions,
} from "./cli/suggestions";
