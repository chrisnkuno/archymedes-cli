import os from "node:os";
import { AccountClient, AccountError, type Fetcher } from "./client";
import { linkThisComputer } from "./link";
import { pullKeys, pushKeys, SLOT_SETTINGS, type KeyResult } from "./keys";
import { clearLink, loadLink, saveLink, serverUrl, type AccountLink } from "./store";

/**
 * `friday login`, `logout`, `account` and `keys`: a Friday account on this computer.
 *
 * One account follows a person everywhere: sign in once on a phone, link each computer with a short code,
 * and the provider keys put in either place are available in every cloud session and, if the person allows
 * it, on every computer. Nothing here prints a key: only the last four characters.
 */

export type AccountDeps = {
  environment: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  computerName?: string;
};

const HELP = [
  "friday login [--server <url>]          link this computer to your Friday account (a code you confirm on your phone)",
  "friday logout                          unlink this computer",
  "friday account                         who this computer is linked as, and your balance",
  "friday keys                            which provider keys your account holds",
  "friday keys push [provider…]           send this computer's keys to your account",
  "friday keys pull [provider…] [--force] bring your account's keys here (needs the download right, given when you confirm a link)",
  "friday keys remove <provider>          delete a key from your account",
];

function dollars(micros: number): string {
  const abs = Math.abs(micros) / 1_000_000;
  return `${micros < 0 ? "-" : ""}$${abs < 0.01 && abs > 0 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

function flags(args: string[]): { positional: string[]; server?: string; force: boolean } {
  const positional: string[] = [];
  let server: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--server") server = args[(index += 1)];
    else if (args[index].startsWith("--server=")) server = args[index].slice("--server=".length);
    else if (args[index] === "--force") force = true;
    else positional.push(args[index]);
  }
  return { positional, server, force };
}

const describe = (result: KeyResult): string => `  ${result.slot.padEnd(11)} ${result.status.padEnd(8)} ${result.detail}`;

export async function runAccountCommand(argv: string[], deps: AccountDeps): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, server: serverFlag, force } = flags(rest);
  try {
    if (command === "login") return await login(deps, serverFlag);
    const link = await loadLink(deps.environment);
    if (command === "logout") return await logout(deps, link);
    if (!link) {
      deps.err("This computer is not linked to a Friday account. Run `friday login`.");
      return 1;
    }
    const client = new AccountClient({ server: link.server, token: link.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if (command === "account") return await status(deps, client, link);
    if (command === "keys") {
      const [action = "list", ...providers] = positional;
      if (action === "list") return await listKeys(deps, client, link);
      if (action === "push") return summarize(deps, await pushKeys({ client, environment: deps.environment, only: providers }), "pushed");
      if (action === "pull") return summarize(deps, await pullKeys({ client, environment: deps.environment, only: providers, force }), "pulled");
      if (action === "remove") {
        if (providers.length !== 1) { deps.err("Say which: `friday keys remove <provider>`."); return 1; }
        deps.out((await client.removeKey(providers[0])) ? `Removed your ${providers[0]} key from your account.` : `Your account had no ${providers[0]} key.`);
        return 0;
      }
      deps.err(`Unknown: friday keys ${action}\n${HELP.join("\n")}`);
      return 1;
    }
    deps.err(HELP.join("\n"));
    return 1;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function login(deps: AccountDeps, serverFlag: string | undefined): Promise<number> {
  const server = serverUrl(deps.environment, serverFlag);
  const client = new AccountClient({ server, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const name = deps.computerName ?? `${os.hostname()} (${process.platform})`;
  const linked = await linkThisComputer({ client, name, print: deps.out, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const me = await new AccountClient({ server, token: linked.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).me();
  const link: AccountLink = { server, token: linked.token, login: me.json.user.login, scopes: linked.scopes, linkedAt: Date.now() };
  await saveLink(link, deps.environment);
  deps.out("");
  deps.out(`  Linked as ${link.login} on ${server}.`);
  deps.out(link.scopes.includes("vault:read")
    ? "  This computer can add keys to your account and download them."
    : "  This computer can add keys to your account. (To let it download them too, run `friday login` again and tick the box when you confirm.)");
  return 0;
}

async function logout(deps: AccountDeps, link: AccountLink | undefined): Promise<number> {
  if (!link) { deps.out("This computer was not linked."); return 0; }
  // Told to the server first, so the link is dead everywhere; the local file goes either way.
  try {
    await new AccountClient({ server: link.server, token: link.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).request("POST", "/api/logout", {}, { expect: [401] });
    deps.out(`Unlinked from ${link.login}.`);
  } catch {
    deps.out(`Unlinked here. (${link.server} could not be reached, so the link may still be listed on your account: remove it from your devices in the app.)`);
  }
  await clearLink(deps.environment);
  return 0;
}

async function status(deps: AccountDeps, client: AccountClient, link: AccountLink): Promise<number> {
  const me = (await client.me()).json;
  deps.out(`Linked as ${me.user.login} on ${link.server}`);
  deps.out(`Balance: ${dollars(me.balanceMicros)}`);
  deps.out(`This computer may: add keys${link.scopes.includes("vault:read") ? ", download keys" : ""}`);
  deps.out(`Devices on the account: ${me.devices.length}`);
  return 0;
}

async function listKeys(deps: AccountDeps, client: AccountClient, link: AccountLink): Promise<number> {
  const catalog = await client.vault();
  deps.out(`Keys in your account (${link.login}):`);
  for (const slot of catalog.slots) deps.out(`  ${slot.slot.padEnd(11)} ${slot.set ? `set ${slot.hint ?? ""}` : "not set"}`.trimEnd());
  if (!catalog.configured) deps.out("\n  Key storage is not set up on this server yet.");
  return 0;
}

function summarize(deps: AccountDeps, results: KeyResult[], done: "pushed" | "pulled"): number {
  for (const result of results) deps.out(describe(result));
  const count = results.filter((result) => result.status === done).length;
  const failed = results.filter((result) => result.status === "failed").length;
  deps.out(`${count} key${count === 1 ? "" : "s"} ${done}${failed > 0 ? `, ${failed} failed` : ""}.`);
  return failed > 0 ? 1 : 0;
}

