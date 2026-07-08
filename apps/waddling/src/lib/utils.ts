import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Sanitize a `next` redirect target to a same-origin path, defeating open-redirect.
 * We thread `next` through the sign-in → sign-up → onboarding funnel (so an MCP
 * device-link claim survives account creation), and it lands in `router.push`,
 * `redirect()`, and a Stripe `successUrl` — all of which will happily send the user
 * to an attacker-controlled origin if `next` is a full URL. Accept ONLY a single
 * leading-slash path; reject protocol-relative (`//host`), backslash tricks, and
 * absolute URLs. Returns `fallback` (default undefined) when the input is unsafe.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback?: string,
): string | undefined {
  if (!next) return fallback
  // Must be a rooted path, not `//evil.com` (protocol-relative) or `/\evil.com`.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback
  // Reject anything that still parses as an absolute URL (e.g. control chars).
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return fallback
  return next
}
