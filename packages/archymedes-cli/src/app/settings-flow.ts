/**
 * The settings menu, and everything that has to happen once it closes.
 *
 * A function rather than an inline block because `/settings` is no longer the only way in: the
 * model picker's "add a key" row opens the same flow, and a second copy would be a second place
 * for "reload the environment and rebuild the client" to be got wrong.
 */
import type { Interface } from "node:readline/promises";
import type { Balance } from "@archymedes/core/cli/balance";
import type { FxRate } from "@archymedes/core/money";
import { resolveControlLanguage } from "../platform/i18n";
import { SETTING_FIELDS, mergedEnvironment, runSettingsMenu, saveSettings, type ArchymedesSettings } from "../platform/settings";
import type { OpenClient } from "./agent-factory";
import type { ParsedArgs } from "./args";
import { hiddenQuestion, isReadlineExit, questionWithEscape, settingsChooser } from "./prompts";
import { builtinThemeChoices } from "../theme/theme";
import { codeStyleFromEnvironment, setCodeStyle } from "../render/syntax";
import { modelChoicesForSettingsField } from "./providers";
import type { Environment, SessionState } from "./session-state";
import { out, style } from "./transcript";

export function createSettingsFlow(options: {
  args: ParsedArgs;
  environment: Environment;
  processEnvironment: Environment;
  readline: Interface;
  interactive: boolean;
  rates: FxRate[];
  state: Pick<SessionState, "savedSettings" | "manualBalance" | "language" | "agent" | "display" | "exitRequested">;
  parseManualBalance: (value: string | undefined, currencyValue?: string) => Balance | undefined;
  openClient: OpenClient;
  applyCurrencyPreference: () => Promise<void>;
  /** Applies appearance settings (theme) to the running session once they are saved. */
  applyAppearance?: (environment: Environment) => Promise<void>;
}): (focus?: "providers") => Promise<"saved" | "cancelled" | "exit"> {
  const { args, environment, processEnvironment, readline, interactive, rates, state } = options;
  return async (focus) => {
    let nextSettings: ArchymedesSettings;
    try {
      nextSettings = await runSettingsMenu(state.savedSettings, {
        // Esc while typing a value leaves that one field alone and returns to the list, rather than
        // abandoning the whole menu — the menu itself is left with Esc from the list.
        ask: (question) => interactive ? questionWithEscape((signal) => readline.question(question, { signal })) : readline.question(question),
        askSecret: (question) => interactive ? questionWithEscape((signal) => hiddenQuestion(readline, question, signal)) : hiddenQuestion(readline, question),
        write: (text) => out.write(text),
        ...(interactive ? { choose: settingsChooser(readline) } : {}),
      }, {
        ...(focus ? { focus } : {}),
        // Prices in the currency this session is already reporting in, rather than the provider's.
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, state.display, rates),
        themeChoices: builtinThemeChoices(),
      });
    } catch (error) {
      if (!isReadlineExit(error)) throw error;
      out.write(style.dim("\n  settings cancelled — no changes were saved\n"));
      return state.exitRequested ? "exit" : "cancelled";
    }
    state.savedSettings = nextSettings;
    const file = await saveSettings(state.savedSettings, processEnvironment);
    for (const field of SETTING_FIELDS) delete environment[field.key];
    Object.assign(environment, mergedEnvironment(state.savedSettings, processEnvironment));
    state.manualBalance = options.parseManualBalance(environment.ARCHYMEDES_ACCOUNT_BALANCE, environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY);
    state.language = resolveControlLanguage(args.language ?? environment.ARCHYMEDES_LANGUAGE ?? environment.LANG);
    // Code colours and line numbers take effect on the next thing printed; the theme repaints now.
    setCodeStyle(codeStyleFromEnvironment(environment));
    await options.applyAppearance?.(environment).catch(() => undefined);
    const previous = state.agent;
    const carried = await previous.relinquish();
    state.agent = await options.openClient(carried);
    out.write(style.green(`  settings saved to ${file}\n`));
    await options.applyCurrencyPreference();
    out.write(style.dim(`  Settings are active now${environment.EXA_API_KEY?.trim() ? "; Exa web_search is available" : ""}. Use /model only to change the selected model.\n`));
    return "saved";
  };
}
