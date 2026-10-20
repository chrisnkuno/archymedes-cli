/**
 * Friday's account API, from the desktop: a thin client over `fetch`.
 *
 * It never logs a request body (which carries keys) and turns every failure into a sentence a person can
 * act on, with the server's own words where it gave them.
 */

export class AccountError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "AccountError";
  }
}

export type VaultSlot = { slot: string; label: string; help: string; set: boolean; hint?: string; addedAt?: number; usedAt?: number | null };
export type VaultCatalog = { configured: boolean; slots: VaultSlot[]; sources: Array<{ source: string; ready: boolean }> };
export type Fetcher = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export class AccountClient {
  private readonly fetcher: Fetcher;

  constructor(private readonly options: { server: string; token?: string; fetch?: Fetcher; timeoutMs?: number }) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init as RequestInit));
  }

  /** One request. `ok` statuses other than 2xx a caller expects (202, 410, 429) come back as data, not errors. */
  async request(method: string, path: string, body?: unknown, options: { expect?: number[] } = {}): Promise<{ status: number; json: any }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.server}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new AccountError(`Could not reach ${this.options.server} (${error instanceof Error ? error.message : String(error)}). Check your connection, or the server address.`, 0);
    }
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (response.ok || options.expect?.includes(response.status)) return { status: response.status, json };
    if (response.status === 401) throw new AccountError("This computer is not signed in, or its link was removed. Run `friday login`.", 401, "signed_out");
    throw new AccountError(String(json?.message ?? json?.error?.message ?? `The server answered ${response.status}.`), response.status, typeof json?.error === "string" ? json.error : undefined);
  }

  me(): Promise<{ status: number; json: { user: { id: string; login: string }; balanceMicros: number; devices: Array<{ id: string; userAgent: string; current: boolean; scopes: string[] }> } }> {
    return this.request("GET", "/api/me");
  }

  async vault(): Promise<VaultCatalog> {
    return (await this.request("GET", "/api/vault")).json;
  }

  async putKey(slot: string, value: string): Promise<{ hint: string }> {
    return (await this.request("PUT", `/api/vault/${encodeURIComponent(slot)}`, { value })).json;
  }

  async removeKey(slot: string): Promise<boolean> {
    const { status } = await this.request("DELETE", `/api/vault/${encodeURIComponent(slot)}`, undefined, { expect: [404] });
    return status === 204;
  }

  async revealKey(slot: string): Promise<string> {
    return (await this.request("GET", `/api/vault/${encodeURIComponent(slot)}/reveal`)).json.value;
  }
}
