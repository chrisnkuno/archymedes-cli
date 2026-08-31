import { describe, expect, it } from "vitest";
import { CONTROL_LANGUAGES, TRANSLATED_KEYBOARD_IDS, commandDescription, controlLabel, keyboardDescription, resolveControlLanguage, t, type ControlLanguage } from "./i18n";
import { KEYBOARD_SHORTCUTS } from "./commands";

describe("localized controls", () => {
  it("accepts locale variants and falls back safely", () => {
    expect(resolveControlLanguage("zh-CN")).toBe("zh");
    expect(resolveControlLanguage("ar_EG")).toBe("ar");
    expect(resolveControlLanguage("unknown")).toBe("en");
  });

  it("translates control descriptions while command names stay stable", () => {
    expect(commandDescription("es", "/voice", "fallback")).toContain("Grabar");
    expect(commandDescription("en", "/voice", "fallback")).toBe("fallback");
  });

  it("looks keyboard help up by id, so reordering the list cannot mistranslate it", () => {
    // The bug this closes: the table was positional, so inserting a shortcut at the top moved every
    // translation one row down in nine languages at once, and nothing in English would have shown
    // it. Ctrl-C's description must follow Ctrl-C, wherever Ctrl-C sits in the list.
    expect(keyboardDescription("es", "interrupt", "fallback")).toContain("Interrumpir");
    expect(keyboardDescription("zh", "complete-command", "fallback")).toBe("补全斜杠命令");
  });

  it("falls back to English for a shortcut no language has translated yet", () => {
    // Untranslated is the honest outcome for a new row; mislabelled is not.
    expect(keyboardDescription("es", "menu-move", "Move through any menu")).toBe("Move through any menu");
  });

  it("keeps every translated id pointing at a shortcut that still exists", () => {
    // A renamed or removed shortcut leaves an orphan translation that silently never renders.
    const ids = new Set(KEYBOARD_SHORTCUTS.map(([id]) => id));
    for (const language of Object.keys(CONTROL_LANGUAGES) as ControlLanguage[]) {
      for (const id of Object.keys(TRANSLATED_KEYBOARD_IDS[language] ?? {})) {
        expect(ids, `${language} translates unknown shortcut "${id}"`).toContain(id);
      }
    }
  });

  it("covers every one of the sixteen control languages, in the labels and both tables", () => {
    const languages = Object.keys(CONTROL_LANGUAGES) as ControlLanguage[];
    expect(languages).toHaveLength(16);
    expect(languages).toEqual(expect.arrayContaining(["en", "ja", "ko", "de", "id", "vi", "tr"]));
    for (const language of languages) {
      expect(controlLabel(language, "settings").length, `${language} labels`).toBeGreaterThan(0);
      if (language === "en") continue;
      // Every non-English language translates the essential slash commands and shortcut ids.
      expect(commandDescription(language, "/help", "FALLBACK"), `${language} /help`).not.toBe("FALLBACK");
      expect(keyboardDescription(language, "interrupt", "FALLBACK"), `${language} interrupt`).not.toBe("FALLBACK");
    }
  });

  it("returns a localized core message, and falls back to English per key", () => {
    expect(t("ja", "help.startHere")).toBe("ここから始める");
    expect(t("de", "doctor.header")).toContain("Archymedes");
    // A key with no translation for a language yields the English source, never an empty string.
    for (const language of Object.keys(CONTROL_LANGUAGES) as ControlLanguage[]) {
      expect(t(language, "tagline").length, `${language} tagline`).toBeGreaterThan(0);
      expect(t(language, "mode.plan").length, `${language} mode.plan`).toBeGreaterThan(0);
    }
  });
});
