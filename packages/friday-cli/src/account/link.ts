import { AccountClient, AccountError } from "./client";

/**
 * Linking this computer to a Friday account, with no password and nothing secret typed or shown.
 *
 * It makes a key pair for this one link and sends only the public half; asks the server for a short code;
 * shows the code and an address; and waits while the person confirms it on their phone or the web. The
 * login the server then makes is encrypted to the public key, so what comes back is something only this
 * process can open. The private key lives in this function and is dropped when it returns.
 */

export type LinkDeps = {
  client: AccountClient;
  /** What this computer is called on the account's device list. */
  name: string;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export async function linkThisComputer(deps: LinkDeps): Promise<{ token: string; scopes: string[] }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pair = (await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"])) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));

  const started = (await deps.client.request("POST", "/api/device/code", { name: deps.name, publicKey })).json as { deviceCode: string; userCode: string; verifyUrl: string; expiresIn: number; interval: number };
  deps.print("");
  deps.print("  To link this computer, open this on your phone or in a browser where you are signed in:");
  deps.print(`    ${started.verifyUrl}`);
  deps.print(`  and confirm that the code is  ${started.userCode}`);
  deps.print("");
  deps.print("  Waiting for you to confirm…");

  const deadline = now() + started.expiresIn * 1000;
  let wait = Math.max(1, started.interval) * 1000;
  while (now() < deadline) {
    if (deps.signal?.aborted) throw new AccountError("Cancelled.", 0, "cancelled");
    await sleep(wait);
    const polled = await deps.client.request("POST", "/api/device/token", { deviceCode: started.deviceCode }, { expect: [202, 410, 429] });
    if (polled.status === 202) continue;
    if (polled.status === 429) { wait += 2_000; continue; } // asked too soon: slow down
    if (polled.status === 410) throw new AccountError("That code expired before it was confirmed. Run `friday login` again.", 410, "expired");
    const { sealedToken, scopes } = polled.json as { sealedToken: string; scopes: string };
    const opened = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, Uint8Array.from(atob(sealedToken), (char) => char.charCodeAt(0)));
    return { token: new TextDecoder().decode(opened), scopes: String(scopes).split(",").map((scope) => scope.trim()).filter(Boolean) };
  }
  throw new AccountError("That code expired before it was confirmed. Run `friday login` again.", 410, "expired");
}
