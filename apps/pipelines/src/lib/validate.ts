/**
 * Identifier + literal guards for SQL the fleet hands to the governed lake.
 *
 * All schema/table names that reach a CTAS, and the staging glob interpolated
 * into read_parquet(), are validated here. birdshot authorizes the statement on
 * the gateway, but the fleet must not be the one constructing an injectable
 * string — these are belt-and-suspenders at the boundary.
 */

/** A bare SQL identifier (schema or table name). No quotes, no dots. */
export const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

/** A UTC ISO-8601 timestamp (PostHog watermark shape). */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

export function assertIdent(kind: string, value: string): string {
  if (!IDENT_RE.test(value)) throw new Error(`invalid ${kind} identifier: ${value}`);
  return value;
}

/**
 * Validate a staging glob before it's interpolated into a single-quoted SQL
 * string literal. A quote would break out of the literal; reject it outright
 * rather than trying to escape (the glob is config, not user input).
 */
export function assertGlob(glob: string): string {
  if (!glob) throw new Error('staging glob is empty');
  if (glob.includes("'") || glob.includes('"')) {
    throw new Error('staging glob must not contain quotes');
  }
  return glob;
}
