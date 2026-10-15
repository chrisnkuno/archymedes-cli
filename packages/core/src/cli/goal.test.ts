import { describe, expect, it } from "vitest";
import { goalContinuation, goalJudgePrompt, goalPrompt, parseGoalVerdict, recentEvidence } from "./goal";

describe("/goal", () => {
  it("asks the working model to verify, and carries what is missing into the next turn", () => {
    expect(goalPrompt("the suite passes")).toContain("verify the condition yourself");
    expect(goalContinuation("the suite passes", "two tests fail")).toBe("Continue toward the goal: the suite passes\n\nNot met yet: two tests fail");
  });

  it("judges from evidence: the newest messages that fit, tool output included, system left out", () => {
    const messages = [
      { role: "system" as const, content: "you are" },
      { role: "user" as const, content: "old ".repeat(5_000) },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "c", name: "run_command", arguments: {} }] },
      { role: "tool" as const, content: "12 passed", toolCallId: "c", name: "run_command" },
      { role: "assistant" as const, content: "All green." },
    ];
    const evidence = recentEvidence(messages, 1_000);
    expect(evidence).toBe("[tool run_command] 12 passed\n\n[assistant] All green.");
    const prompt = goalJudgePrompt("the suite passes", messages);
    expect(prompt).toContain("The goal: the suite passes");
    expect(prompt).not.toContain("you are");
  });

  it("reads a verdict, and never ends a goal on one it cannot read", () => {
    expect(parseGoalVerdict('{"status":"met","reason":"12 passed"}')).toEqual({ status: "met", reason: "12 passed" });
    expect(parseGoalVerdict('Sure: {"status":"impossible","reason":"no network"}')).toEqual({ status: "impossible", reason: "no network" });
    expect(parseGoalVerdict('{"status":"done"}')).toEqual({ status: "continue", reason: "the verdict gave no reason" });
    expect(parseGoalVerdict("I think it is met")).toEqual({ status: "continue", reason: "I think it is met" });
  });
});
