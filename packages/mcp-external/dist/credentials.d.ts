/** Stable per-machine device id; created on first use. */
export declare function getOrCreateDeviceId(): string;
export interface ResolvedCredentials {
    apiKey: string;
    baseUrl: string;
    /** Where the key came from — useful for telemetry / debugging. */
    source: "env" | "file";
}
/** Resolve credentials, or null to signal onboarding mode. */
export declare function resolveCredentials(): ResolvedCredentials | null;
/** The base URL to use during onboarding (before any key exists). */
export declare function onboardingBaseUrl(): string;
/** Persist a freshly-claimed key 0600 so future runs skip onboarding. */
export declare function persistCredentials(apiKey: string, baseUrl: string): void;
