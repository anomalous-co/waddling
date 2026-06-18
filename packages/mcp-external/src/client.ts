// Control-plane REST client for the External MCP server (W3).
//
// The MCP server holds NO DB credentials — it is a thin HTTP client of the
// control-plane API (ARCHITECTURE.md §4). Auth is the org API key (sk_agent_…)
// in env WADDLING_API_KEY against WADDLING_URL. waddling_query goes through the
// gateway /gw/query endpoint (returned in the connect response).

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface CpError {
  status: number;
  code: string;
  reason: string;
  body?: unknown;
}

/** Thrown on any non-2xx control-plane / gateway response. */
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly body?: unknown;
  constructor(e: CpError) {
    super(e.reason);
    this.name = "ControlPlaneError";
    this.status = e.status;
    this.code = e.code;
    this.reason = e.reason;
    this.body = e.body;
  }
}

export function loadClientConfig(): ClientConfig {
  const baseUrl = process.env.WADDLING_URL;
  const apiKey = process.env.WADDLING_API_KEY;
  if (!baseUrl) throw new Error("missing env WADDLING_URL (e.g. https://app.getwaddling.com)");
  if (!apiKey) throw new Error("missing env WADDLING_API_KEY (sk_agent_…)");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

/** Resolves the live {baseUrl, apiKey} at call time (so a mid-session link works). */
export type ConfigProvider = () => ClientConfig;

export class WaddlingClient {
  private readonly resolve: ConfigProvider;

  /** Accepts either a static config or a provider that resolves it per-call. */
  constructor(config: ClientConfig | ConfigProvider) {
    this.resolve = typeof config === "function" ? config : () => config;
  }

  /** Call a control-plane REST endpoint with Bearer API-key auth. */
  async cp<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const config = this.resolve();
    const res = await fetch(`${config.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return this.parse<T>(res);
  }

  /** Call an arbitrary absolute URL (e.g. the gateway /gw/query) with a JSON body. */
  async post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const obj = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) ?? {};
      throw new ControlPlaneError({
        status: res.status,
        code: String(obj.error ?? `http_${res.status}`),
        reason: String(obj.reason ?? obj.message ?? res.statusText),
        body: parsed,
      });
    }
    return parsed as T;
  }
}
