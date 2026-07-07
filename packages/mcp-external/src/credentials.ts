// Local credential + device identity for @waddling/mcp.
//
// MULTI-PROFILE store. ~/.waddling/credentials.json holds a map of NAMED bearer-
// token profiles, each a durable `sk_agent_` key bound to its own waddling agent
// (its own ACL grants). One profile is the `default`. A legacy v1 file
// ({ api_key, base_url }) is migrated on read into a single profile named
// "default" — old installs keep working with zero user action.
//
// Resolution precedence (per call), first hit wins:
//   1. explicit `profile` argument (a named stored profile, or "env")
//   2. env WADDLING_PROFILE  (names a stored profile)
//   3. stored `default` profile
//   4. the sole stored profile, if exactly one exists
//   5. env WADDLING_API_KEY  (exposed as an implicit read-only "env" profile)
//   6. none → ONBOARDING MODE (the agent runs waddling_signup)
//
// WADDLING_URL overrides base_url everywhere. device.json persists a stable
// device uuid (PostHog distinct-id + device-link {deviceId}). Files are 0600.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".waddling");
const DEVICE_FILE = join(DIR, "device.json");
const CRED_FILE = join(DIR, "credentials.json");

const DEFAULT_BASE_URL = "https://app.getwaddling.com";
/** The implicit profile name for a key supplied via WADDLING_API_KEY. */
export const ENV_PROFILE = "env";

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

/** Stable per-machine device id; created on first use. */
export function getOrCreateDeviceId(): string {
  try {
    const data = JSON.parse(readFileSync(DEVICE_FILE, "utf8")) as { device_id?: string };
    if (data.device_id) return data.device_id;
  } catch {
    /* fall through to create */
  }
  const deviceId = randomUUID();
  try {
    ensureDir();
    writeFileSync(DEVICE_FILE, JSON.stringify({ device_id: deviceId }), { mode: 0o600 });
  } catch {
    /* if we can't persist, the in-memory id still works for this run */
  }
  return deviceId;
}

// ── On-disk shapes ────────────────────────────────────────────────────────────

interface StoredProfile {
  api_key: string;
  base_url?: string;
  agent_name?: string;
  created_at?: string;
}

interface StoreV2 {
  version: 2;
  default?: string;
  profiles: Record<string, StoredProfile>;
}

/** Legacy single-key file. */
interface StoreV1 {
  api_key?: string;
  base_url?: string;
}

// ── Resolved (in-memory) credential ───────────────────────────────────────────

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

function baseUrlFrom(fileBaseUrl?: string): string {
  return (process.env["WADDLING_URL"] ?? fileBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function maskKey(key: string): string {
  if (key.length <= 8) return "sk_…";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Read + normalize the store (migrating a v1 file to v2 in memory). Never throws. */
function readStore(): StoreV2 {
  try {
    const raw = JSON.parse(readFileSync(CRED_FILE, "utf8")) as StoreV2 | StoreV1;
    if (raw && typeof raw === "object" && "profiles" in raw && raw.profiles) {
      return { version: 2, default: raw.default, profiles: raw.profiles };
    }
    // v1 → v2: a single { api_key, base_url } becomes profile "default".
    const v1 = raw as StoreV1;
    if (v1 && v1.api_key) {
      return {
        version: 2,
        default: "default",
        profiles: { default: { api_key: v1.api_key, base_url: v1.base_url } },
      };
    }
  } catch {
    /* no file / unparseable → empty store */
  }
  return { version: 2, profiles: {} };
}

function writeStore(store: StoreV2): void {
  ensureDir();
  writeFileSync(CRED_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function envKey(): string | undefined {
  const k = process.env["WADDLING_API_KEY"];
  return k && k.trim() ? k.trim() : undefined;
}

function fromStored(name: string, p: StoredProfile): ResolvedCredentials {
  return { apiKey: p.api_key, baseUrl: baseUrlFrom(p.base_url), profile: name, source: "file" };
}

function envCreds(): ResolvedCredentials | null {
  const k = envKey();
  return k ? { apiKey: k, baseUrl: baseUrlFrom(), profile: ENV_PROFILE, source: "env" } : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve credentials for an (optional) profile name, applying the precedence in
 * the module header. Returns null to signal ONBOARDING MODE (no credential).
 */
export function resolveProfile(name?: string): ResolvedCredentials | null {
  const store = readStore();

  // 1 + 2: an explicit name (arg beats env) selects a stored profile or "env".
  const explicit = name ?? process.env["WADDLING_PROFILE"];
  if (explicit) {
    if (explicit === ENV_PROFILE) return envCreds();
    const p = store.profiles[explicit];
    return p ? fromStored(explicit, p) : null;
  }

  // 3: stored default.
  if (store.default && store.profiles[store.default]) {
    return fromStored(store.default, store.profiles[store.default]);
  }
  // 4: exactly one stored profile → use it.
  const names = Object.keys(store.profiles);
  if (names.length === 1) return fromStored(names[0], store.profiles[names[0]]);
  // 5: env key as an implicit fallback.
  const env = envCreds();
  if (env) return env;
  // (>1 stored profiles but no default and no env → ambiguous → onboarding-ish
  //  null; callers surface "pick a profile". Rare: default is set on first write.)
  return null;
}

/** Back-compat alias: resolve the default/effective credential. */
export function resolveCredentials(): ResolvedCredentials | null {
  return resolveProfile();
}

/** List every known profile (stored + the implicit env profile if a key is set). */
export function listProfiles(): ProfileInfo[] {
  const store = readStore();
  const out: ProfileInfo[] = [];
  for (const [name, p] of Object.entries(store.profiles)) {
    out.push({
      name,
      isDefault: store.default === name,
      source: "file",
      masked: maskKey(p.api_key),
      baseUrl: baseUrlFrom(p.base_url),
      agentName: p.agent_name,
      createdAt: p.created_at,
    });
  }
  const env = envCreds();
  if (env && !store.profiles[ENV_PROFILE]) {
    // env is default only when nothing stored takes precedence.
    const isDefault = !(store.default && store.profiles[store.default]) && out.length === 0;
    out.push({ name: ENV_PROFILE, isDefault, source: "env", masked: maskKey(env.apiKey), baseUrl: env.baseUrl });
  }
  return out;
}

export interface PersistOptions {
  baseUrl?: string;
  agentName?: string;
  createdAt?: string;
  /** Make this the default profile (default: true when it's the first profile). */
  makeDefault?: boolean;
}

/** Persist (create or overwrite) a named profile. Returns the resolved credential. */
export function persistProfile(name: string, apiKey: string, opts: PersistOptions = {}): ResolvedCredentials {
  if (name === ENV_PROFILE) throw new Error(`"${ENV_PROFILE}" is a reserved profile name`);
  const store = readStore();
  const firstProfile = Object.keys(store.profiles).length === 0;
  store.profiles[name] = {
    api_key: apiKey,
    base_url: opts.baseUrl,
    agent_name: opts.agentName,
    created_at: opts.createdAt ?? new Date().toISOString(),
  };
  if (opts.makeDefault ?? firstProfile) store.default = name;
  else if (!store.default) store.default = name;
  writeStore(store);
  return fromStored(name, store.profiles[name]);
}

/** Set the default profile. Throws if the profile does not exist. */
export function setDefaultProfile(name: string): void {
  const store = readStore();
  if (!store.profiles[name]) throw new Error(`no such profile: ${name}`);
  store.default = name;
  writeStore(store);
}

/**
 * Remove a stored profile locally. Returns the removed credential (so the caller
 * can revoke the key server-side) or null if it did not exist. The env profile
 * cannot be removed.
 */
export function removeProfile(name: string): StoredProfile | null {
  if (name === ENV_PROFILE) throw new Error(`the "${ENV_PROFILE}" profile is env-supplied and cannot be removed`);
  const store = readStore();
  const p = store.profiles[name];
  if (!p) return null;
  delete store.profiles[name];
  if (store.default === name) {
    const rest = Object.keys(store.profiles);
    store.default = rest.length ? rest[0] : undefined;
  }
  writeStore(store);
  return p;
}

/** The base URL to use during onboarding (before any key exists). */
export function onboardingBaseUrl(): string {
  return baseUrlFrom();
}

/**
 * @deprecated single-key writer kept for reference — use persistProfile.
 * Persist a freshly-claimed key into the "default" profile.
 */
export function persistCredentials(apiKey: string, baseUrl: string): void {
  persistProfile("default", apiKey, { baseUrl, makeDefault: true });
}
