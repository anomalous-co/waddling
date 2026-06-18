// Local credential + device identity for the External MCP server (Stream B).
//
// Key resolution order (first hit wins):
//   1. env WADDLING_API_KEY
//   2. ~/.waddling/credentials.json  { api_key, base_url? }
//   3. none → ONBOARDING MODE (the agent runs waddling_signup)
//
// device.json persists a stable device uuid used as the PostHog distinct-id and
// the device-link {deviceId}. credentials.json is written 0600 after a claim.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DIR = join(homedir(), ".waddling");
const DEVICE_FILE = join(DIR, "device.json");
const CRED_FILE = join(DIR, "credentials.json");
function ensureDir() {
    if (!existsSync(DIR))
        mkdirSync(DIR, { recursive: true, mode: 0o700 });
}
/** Stable per-machine device id; created on first use. */
export function getOrCreateDeviceId() {
    try {
        const data = JSON.parse(readFileSync(DEVICE_FILE, "utf8"));
        if (data.device_id)
            return data.device_id;
    }
    catch {
        /* fall through to create */
    }
    const deviceId = randomUUID();
    try {
        ensureDir();
        writeFileSync(DEVICE_FILE, JSON.stringify({ device_id: deviceId }), { mode: 0o600 });
    }
    catch {
        /* if we can't persist, the in-memory id still works for this run */
    }
    return deviceId;
}
const DEFAULT_BASE_URL = "https://app.getwaddling.com";
function baseUrlFrom(fileBaseUrl) {
    return (process.env["WADDLING_URL"] ?? fileBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}
/** Resolve credentials, or null to signal onboarding mode. */
export function resolveCredentials() {
    const envKey = process.env["WADDLING_API_KEY"];
    if (envKey)
        return { apiKey: envKey, baseUrl: baseUrlFrom(), source: "env" };
    try {
        const cred = JSON.parse(readFileSync(CRED_FILE, "utf8"));
        if (cred.api_key) {
            return { apiKey: cred.api_key, baseUrl: baseUrlFrom(cred.base_url), source: "file" };
        }
    }
    catch {
        /* no file → onboarding */
    }
    return null;
}
/** The base URL to use during onboarding (before any key exists). */
export function onboardingBaseUrl() {
    return baseUrlFrom();
}
/** Persist a freshly-claimed key 0600 so future runs skip onboarding. */
export function persistCredentials(apiKey, baseUrl) {
    ensureDir();
    writeFileSync(CRED_FILE, JSON.stringify({ api_key: apiKey, base_url: baseUrl }, null, 2), {
        mode: 0o600,
    });
}
