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
/** Resolves the live {baseUrl, apiKey} at call time (so a mid-session link works). */
export type ConfigProvider = () => ClientConfig;
export declare class WaddlingClient {
    private readonly resolve;
    /** Accepts either a static config or a provider that resolves it per-call. */
    constructor(config: ClientConfig | ConfigProvider);
    /** Call a control-plane REST endpoint with Bearer API-key auth. */
    cp<T>(path: string, init?: {
        method?: string;
        body?: unknown;
    }): Promise<T>;
    /** Call an arbitrary absolute URL (e.g. the gateway /gw/query) with a JSON body. */
    post<T>(url: string, body: unknown): Promise<T>;
    private parse;
}
