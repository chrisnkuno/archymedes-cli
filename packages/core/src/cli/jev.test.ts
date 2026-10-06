import { describe, expect, it } from "vitest";
import {
  JEV_DEFAULT_MODEL,
  JEV_MAX_STATE_CHARS,
  JevError,
  TURN_VERDICT_QUESTIONS,
  parseJevResponse,
  requestJevVerdict,
  turnVerdictState,
  verdictFromResponse,
  type JevFetch,
} from "./jev";

function ok(body: unknown): JevFetch {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function verdictBody() {
  return {
    model: "jev-1.13.0",
    answers: {
      outcome: {
        type: "choice",
        choice: "follow_up",
        confidence: 0.78,
        probabilities: { complete: 0.1, follow_up: 0.78, blocked: 0.12 },
      },
      sensitive_action: { type: "noul", noul: 0.05 },
    },
    usage: { input_tokens: 392, output_tokens: 65 },
  };
}

const questions = TURN_VERDICT_QUESTIONS;

describe("reading a Jev verdict", () => {
  it("parses the documented response shape, probabilities included", () => {
    const response = parseJevResponse(verdictBody());
    expect(response.model).toBe("jev-1.13.0");
    expect(response.answers.outcome).toMatchObject({ type: "choice", choice: "follow_up" });
    expect(response.usage).toEqual({ inputTokens: 392, outputTokens: 65 });
    expect(verdictFromResponse(response)).toMatchObject({
      status: "verdict",
      outcome: "follow_up",
      sensitiveAction: 0.05,
      outcomeProbabilities: { complete: 0.1, follow_up: 0.78, blocked: 0.12 },
    });
  });

  it("fails closed on a body that is not a verdict, rather than inventing one", () => {
    for (const body of [
      null,
      {},
      { model: "jev-1.13.0" },
      { model: "jev-1.13.0", answers: null, usage: { input_tokens: 1, output_tokens: 1 } },
      { model: "jev-1.13.0", answers: { outcome: { type: "choice" } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { model: "jev-1.13.0", answers: verdictBody().answers, usage: { input_tokens: -1, output_tokens: 1 } },
      { model: "jev-1.13.0", answers: { outcome: { type: "noul", noul: 2 }, sensitive_action: { type: "noul", noul: 0 } }, usage: { input_tokens: 1, output_tokens: 1 } },
    ]) {
      expect(() => parseJevResponse(body), JSON.stringify(body)).toThrow(JevError);
    }
  });

  it("admits a response without the turn verdict instead of forcing one", () => {
    const response = parseJevResponse({
      model: "jev-1.13.0",
      answers: { other: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(verdictFromResponse(response)).toMatchObject({ status: "unavailable" });
  });
});

describe("asking Jev", () => {
  it("posts state, model and questions with a Bearer key", async () => {
    let url = "";
    let init: { headers: Record<string, string>; body: string } | undefined;
    const fetchImpl: JevFetch = async (requestUrl, requestInit) => {
      url = requestUrl;
      init = requestInit;
      return { ok: true, status: 200, json: async () => verdictBody() };
    };
    const response = await requestJevVerdict({ apiKey: "ts-key", state: "turn summary", questions, fetchImpl });
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init!.headers.authorization).toBe("Bearer ts-key");
    expect(JSON.stringify(init!.body)).not.toContain("ts-key");
    const sent = JSON.parse(init!.body) as { model: string; state: string };
    expect(sent.model).toBe(JEV_DEFAULT_MODEL);
    expect(sent.state).toBe("turn summary");
    expect(response.model).toBe("jev-1.13.0");
  });

  it("bounds the state it sends", async () => {
    let sent = "";
    const fetchImpl: JevFetch = async (_url, requestInit) => {
      sent = (JSON.parse(requestInit.body) as { state: string }).state;
      return { ok: true, status: 200, json: async () => verdictBody() };
    };
    await requestJevVerdict({ apiKey: "k", state: "x".repeat(JEV_MAX_STATE_CHARS + 500), questions, fetchImpl });
    expect(sent.length).toBeLessThanOrEqual(JEV_MAX_STATE_CHARS);
  });

  it("names authentication and quota failures instead of leaking the wire error", async () => {
    const denied: JevFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(requestJevVerdict({ apiKey: "bad", state: "s", questions, fetchImpl: denied })).rejects.toThrow("TYPESAFE_API_KEY");
    const limited: JevFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const error = await requestJevVerdict({ apiKey: "k", state: "s", questions, fetchImpl: limited }).catch((value) => value);
    expect(error).toBeInstanceOf(JevError);
    expect(error.retryable).toBe(true);
  });

  it("requires a key and something to judge", async () => {
    await expect(requestJevVerdict({ apiKey: "  ", state: "s", questions, fetchImpl: ok({}) })).rejects.toThrow("TYPESAFE_API_KEY");
    await expect(requestJevVerdict({ apiKey: "k", state: "  ", questions, fetchImpl: ok({}) })).rejects.toThrow("non-empty");
  });

  it("propagates cancellation instead of reporting it as a Jev failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(requestJevVerdict({ apiKey: "k", state: "s", questions, signal: controller.signal, fetchImpl: ok({}) })).rejects.toThrow("cancelled");
  });
});

describe("the turn summary Jev judges", () => {
  it("carries what was asked, what was said, and which tools ran — not their outputs", () => {
    const state = turnVerdictState({ objective: "Fix the test", assistantText: "Done.", toolNames: ["read_file", "edit_file", "read_file"] });
    expect(state).toContain("Fix the test");
    expect(state).toContain("read_file, edit_file");
    expect(state.length).toBeLessThanOrEqual(JEV_MAX_STATE_CHARS);
  });

  it("says plainly when no tools ran", () => {
    expect(turnVerdictState({ objective: "hi", assistantText: "hello", toolNames: [] })).toContain("No tools used");
  });

  it("tells the judge which commands ran and how they exited — including the failures", () => {
    // The benchmark produced a judge that could not see tests exiting 1, while the CLI
    // box reported success. The verdict state must carry the test evidence, not just
    // the names of the tools.
    const state = turnVerdictState({
      objective: "Add tests", assistantText: "Done.", toolNames: ["write_file", "run_command"],
      evidence: [
        { tool: "write_file", isError: false },
        { tool: "run_command", command: "bun test", exitCode: 1, isError: true },
        { tool: "run_command", command: "bun test", exitCode: 0, kind: "tests", isError: false },
      ],
    });
    expect(state).toContain('"bun test" → exit 1');
    expect(state).toContain('"bun test" → exit 0 (tests)');
    expect(state.length).toBeLessThanOrEqual(JEV_MAX_STATE_CHARS);
  });
});

describe("the standing question set", () => {
  it("asks an outcome choice and a sensitivity noul", () => {
    expect(questions.outcome).toMatchObject({ type: "choice" });
    expect(questions.sensitive_action).toMatchObject({ type: "noul" });
    const criteria = (questions.outcome as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["blocked", "complete", "follow_up"]);
  });

  it("asks a fixed tool-fit choice before effectful tools", async () => {
    const { TOOL_CHECK_QUESTIONS, createJevJudge, toolCheckState } = await import("./jev");
    expect(TOOL_CHECK_QUESTIONS.tool_fit).toMatchObject({ type: "choice" });
    const state = toolCheckState({ taskHint: "Run tests", toolName: "run_command", toolDescription: "Run a shell command", toolArguments: { command: "bun test" } });
    expect(state).toContain("run_command");
    expect(state).toContain("bun test");

    const judge = createJevJudge({
      apiKey: "k",
      fetchImpl: ok({
        model: "jev-1.13.0",
        answers: { tool_fit: { type: "choice", choice: "proceed", confidence: 0.9, probabilities: { proceed: 0.9, reconsider: 0.08, stop: 0.02 } } },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    expect(await judge.checkTool({ taskHint: "Run tests", toolName: "run_command", toolDescription: "Run a shell command", toolArguments: {} }))
      .toMatchObject({ fit: "proceed" });
  });

  it("fails a tool check open when Jev is unreachable", async () => {
    const { createJevJudge } = await import("./jev");
    const failing: JevFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const judge = createJevJudge({ apiKey: "k", fetchImpl: failing });
    await expect(judge.checkTool({ taskHint: "t", toolName: "run_command", toolDescription: "d", toolArguments: {} })).resolves.toBeUndefined();
  });
});
