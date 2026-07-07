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
export declare class ControlPlaneError extends Error {
    readonly status: number;
    readonly code: string;
    readonly reason: string;
    readonly body?: unknown;
    constructor(e: CpError);
}
export declare function loadClientConfig(): ClientConfig;
/**
 * Resolves the live {baseUrl, apiKey} at call time (so a mid-session link works).
 * Takes an optional profile name so a single tool call can target a specific
 * bearer-token profile; the provider throws if that profile is not linked.
 */
export type ConfigProvider = (profile?: string) => ClientConfig;
export declare class WaddlingClient {
    private readonly resolve;
    /** Accepts either a static config or a provider that resolves it per-call. */
    constructor(config: ClientConfig | ConfigProvider);
    /** The base URL (app origin) for the resolved profile — used for deep links. */
    baseUrl(profile?: string): string;
    /** Call a control-plane REST endpoint with Bearer API-key auth. */
    cp<T>(path: string, init?: {
        method?: string;
        body?: unknown;
        profile?: string;
    }): Promise<T>;
    /** Call an arbitrary absolute URL (e.g. the gateway /gw/query) with a JSON body. */
    post<T>(url: string, body: unknown): Promise<T>;
    private parse;
}
