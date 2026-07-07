/** The implicit profile name for a key supplied via WADDLING_API_KEY. */
export declare const ENV_PROFILE = "env";
/** Stable per-machine device id; created on first use. */
export declare function getOrCreateDeviceId(): string;
interface StoredProfile {
    api_key: string;
    base_url?: string;
    agent_name?: string;
    created_at?: string;
}
export interface ResolvedCredentials {
    apiKey: string;
    baseUrl: string;
    /** The profile this resolved to ("env" for a WADDLING_API_KEY key). */
    profile: string;
    /** Where the key came from — useful for telemetry / debugging. */
    source: "env" | "file";
}
export interface ProfileInfo {
    name: string;
    isDefault: boolean;
    source: "env" | "file";
    /** Last 4 chars of the key, prefix-masked (never the full secret). */
    masked: string;
    baseUrl: string;
    agentName?: string;
    createdAt?: string;
}
/**
 * Resolve credentials for an (optional) profile name, applying the precedence in
 * the module header. Returns null to signal ONBOARDING MODE (no credential).
 */
export declare function resolveProfile(name?: string): ResolvedCredentials | null;
/** Back-compat alias: resolve the default/effective credential. */
export declare function resolveCredentials(): ResolvedCredentials | null;
/** List every known profile (stored + the implicit env profile if a key is set). */
export declare function listProfiles(): ProfileInfo[];
export interface PersistOptions {
    baseUrl?: string;
    agentName?: string;
    createdAt?: string;
    /** Make this the default profile (default: true when it's the first profile). */
    makeDefault?: boolean;
}
/** Persist (create or overwrite) a named profile. Returns the resolved credential. */
export declare function persistProfile(name: string, apiKey: string, opts?: PersistOptions): ResolvedCredentials;
/** Set the default profile. Throws if the profile does not exist. */
export declare function setDefaultProfile(name: string): void;
/**
 * Remove a stored profile locally. Returns the removed credential (so the caller
 * can revoke the key server-side) or null if it did not exist. The env profile
 * cannot be removed.
 */
export declare function removeProfile(name: string): StoredProfile | null;
/** The base URL to use during onboarding (before any key exists). */
export declare function onboardingBaseUrl(): string;
/**
 * @deprecated single-key writer kept for reference — use persistProfile.
 * Persist a freshly-claimed key into the "default" profile.
 */
export declare function persistCredentials(apiKey: string, baseUrl: string): void;
export {};
