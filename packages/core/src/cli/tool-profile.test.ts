import { describe, expect, it } from "vitest";
import { toolProfileForObjective, toolsForProfile } from "./tool-profile";
import type { AgentTool } from "../agent-runtime";

describe("intent-aware tool profiles", () => {
  it("uses no tools for direct conversational replies", () => {
    expect(toolProfileForObjective("Hello!", "build")).toBe("chat");
    expect(toolProfileForObjective("Reply with exactly: READY", "auto")).toBe("chat");
  });

  it("keeps tools when an exact-reply request still needs the workspace", () => {
    // Found live: this prompt used to get no tools, so the model could only pretend to read the file.
    expect(toolProfileForObjective("Read note.txt with your file tool and reply with only the secret word.", "build")).toBe("read");
    expect(toolProfileForObjective("What is in config.yaml? Reply with only the port.", "build")).toBe("read");
    expect(toolProfileForObjective("Reply with only the version from ./package.json", "auto")).toBe("read");
    expect(toolProfileForObjective("Update version.ts and reply with only OK", "build")).toBe("full");
    expect(toolProfileForObjective("Reply with only yes or no: is 7 prime?", "build")).toBe("chat");
  });

  it("keeps read-only tools for repository questions", () => {
    expect(toolProfileForObjective("Review the authentication code and explain the bug", "build")).toBe("read");
  });

  it("keeps the full profile for changes and defender work", () => {
    expect(toolProfileForObjective("Fix the authentication bug", "build")).toBe("full");
    // These used to get read-only tools, so the agent could explain the change but not make it.
    for (const objective of ["Update the README", "Add a test for parser.ts", "Refactor the auth module", "Bump the version"]) {
      expect(toolProfileForObjective(objective, "build"), objective).toBe("full");
    }
    expect(toolProfileForObjective("review auth", "defender")).toBe("full");
    expect(toolProfileForObjective("something ambiguous", "build")).toBe("full");
  });

  it("gives write tools for the everyday ways people ask for a change, not only the verbs on the first list", () => {
    // Found by the cloud harness: "make a file" went to the read-only profile, so the agent could never make it.
    for (const objective of [
      "please make a file hello.txt", "make a new component for the navbar", "put a loading spinner in app.tsx", "convert this file to TypeScript",
      "clean up utils.ts", "tidy the imports in src/index.ts", "configure eslint for the project", "enable strict mode in tsconfig.json",
      "extract this into a function in src/a.ts", "split parser.ts into two files", "merge these two modules", "wire the button to the api",
      "hook up the form to the backend", "optimise the query in db.ts", "optimize the render loop", "simplify the reducer", "swap axios for fetch in client.ts",
    ]) {
      expect(toolProfileForObjective(objective, "build"), objective).toBe("full");
    }
  });

  it("still keeps questions about code read-only", () => {
    for (const objective of ["what does this function do in app.ts", "explain how the router works", "where is the login handled in the code", "why does parser.ts return null here", "summarize the architecture of this project"]) {
      expect(toolProfileForObjective(objective, "build"), objective).toBe("read");
    }
  });

  it("filters by effect without trusting tool names", () => {
    const tools = [
      { name: "read", effect: "none" },
      { name: "edit", effect: "workspace" },
      { name: "send", effect: "external" },
    ] as AgentTool[];
    expect(toolsForProfile(tools, "chat")).toEqual([]);
    expect(toolsForProfile(tools, "read").map((tool) => tool.name)).toEqual(["read"]);
    expect(toolsForProfile(tools, "full")).toHaveLength(3);
  });
});
