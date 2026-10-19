import { describe, expect, it } from "vitest";
import { COMMANDS, renderCommandHelp, renderKeyboardShortcuts } from "./commands";

describe("command registry", () => {
  it("lists every command exactly once, each starting with a slash", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("/")).toBe(true);
  });

  it("renders help from the same table completion reads, so they can't drift apart", () => {
    const help = renderCommandHelp();
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.description);
    }
  });

  it("inlines a command's keyboard shortcut when one is given, and leaves commands without one alone", () => {
    const help = renderCommandHelp("en", new Map([["/model", "F3, Alt+M"]]));
    expect(help).toMatch(/\/model.*F3, Alt\+M/);
    // A command with no shortcut still lines up — no dangling gap or misaligned description.
    expect(help).toContain("/undo");
  });

  it("omits the shortcut column entirely when nothing was given, unchanged from before shortcuts existed", () => {
    expect(renderCommandHelp()).toBe(renderCommandHelp("en", new Map()));
  });
});

describe("keyboard shortcuts", () => {
  it("documents at least the interrupt and completion keys", () => {
    const rendered = renderKeyboardShortcuts();
    expect(rendered).toContain("Ctrl-C");
    expect(rendered).toContain("Tab");
  });
});
