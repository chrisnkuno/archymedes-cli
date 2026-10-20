import { promises as fs } from "node:fs";
import path from "node:path";
import { settingsDirectory } from "../platform/settings";

/**
 * Where this computer remembers the Friday account it is linked to: one small file next to the settings.
 *
 * It holds a login token, which is a credential, so it is written readable by its owner alone, replaced
 * atomically (a half-written token is a logged-out computer), and never printed.
 */

export const DEFAULT_SERVER = "https://app.archymedes.xyz";

export type AccountLink = {
  server: string;
  /** `<login id>.<secret>`: what is sent as a bearer token. */
  token: string;
  login: string;
  /** What the person allowed this computer to do: `vault:write`, and `vault:read` if they ticked the box. */
  scopes: string[];
  linkedAt: number;
};

type Environment = Record<string, string | undefined>;

export function accountFile(environment: Environment = process.env): string {
  return path.join(settingsDirectory(environment), "account.json");
}

/** The server to talk to: a flag, then `ARCHYMEDES_APP_URL`, then Friday's. Plain http is for a local server only. */
export function serverUrl(environment: Environment = process.env, flag?: string): string {
  const raw = (flag ?? environment.ARCHYMEDES_APP_URL ?? DEFAULT_SERVER).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`'${raw}' is not a web address.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server must be an https:// address (http:// only for a server on this computer).");
  if (url.username || url.password) throw new Error("The server address must not carry a username or password.");
  return url.origin;
}

export async function loadLink(environment: Environment = process.env): Promise<AccountLink | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(accountFile(environment), "utf8")) as Partial<AccountLink>;
    if (typeof raw.server !== "string" || typeof raw.token !== "string" || !raw.token.includes(".") || typeof raw.login !== "string") return undefined;
    return { server: raw.server, token: raw.token, login: raw.login, scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === "string") : [], linkedAt: typeof raw.linkedAt === "number" ? raw.linkedAt : 0 };
  } catch {
    return undefined;
  }
}

export async function saveLink(link: AccountLink, environment: Environment = process.env): Promise<string> {
  const file = accountFile(environment);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(link, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => undefined);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export async function clearLink(environment: Environment = process.env): Promise<boolean> {
  try {
    await fs.rm(accountFile(environment));
    return true;
  } catch {
    return false;
  }
}
