import { resolve } from "node:path";

/** Runtime configuration for a single quack-stack instance, read from env. */
export interface StackConfig {
  /** Human label for this instance (e.g. "A" / "B"), shown in the UI. */
  instance: string;
  /** Absolute path to this instance's PGlite data directory (shared/federated data). */
  dataDir: string;
  /**
   * Absolute path to this instance's PRIVATE PGlite data directory. Holds
   * notebooks + saved views. Deliberately NOT attached to DuckDB, so quack peers
   * cannot reach it.
   */
  privateDataDir: string;
  /** Local Postgres-wire port that bridges PGlite -> DuckDB. */
  pgPort: number;
  /** This instance's quack HTTP server port. */
  quackPort: number;
  /** Auth token guarding this instance's quack endpoint. */
  quackToken: string;
  /** The peer's quack port to ATTACH for federated analytics. */
  peerQuackPort: number;
  /** Auth token for the peer's quack endpoint. */
  peerQuackToken: string;
  /**
   * Absolute path to this instance's AUTH PGlite data directory. Holds Better
   * Auth's tables (user/account/session/jwks) and the `birdshot.*` schema
   * (roles, grants, revocations). Like {@link privateDataDir} it is NEVER
   * attached to DuckDB, so no quack peer can read the auth schema out of the
   * catalog; the host loader reads it and pushes snapshots into the birdshot
   * extension instead.
   */
  authDataDir: string;
  /** Local Postgres-wire port that exposes authDb to Better Auth's `pg` Pool. */
  authPgPort: number;
  /**
   * Filesystem path to the compiled `birdshot.duckdb_extension`. When set and
   * loadable, birdshot replaces the legacy `peer_read_only` macro as the quack
   * auth/authz hooks. When unset/unbuildable, the stack falls back to the macro.
   */
  birdshotExtensionPath: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Resolve config from the environment. `DATA_DIR` is resolved against the
 * current working directory (the Next.js app runs from `apps/web`, so the
 * dev scripts pass `../../pgdata-a` to land the store at the repo root).
 */
export function loadConfig(): StackConfig {
  const dataDir = resolve(process.cwd(), str("DATA_DIR", "./pgdata-a"));
  return {
    instance: str("INSTANCE", "A"),
    dataDir,
    privateDataDir: str("PRIVATE_DATA_DIR", "") ? resolve(process.cwd(), str("PRIVATE_DATA_DIR", "")) : `${dataDir}-private`,
    pgPort: num("PG_PORT", 5432),
    quackPort: num("QUACK_PORT", 9494),
    quackToken: str("QUACK_TOKEN", "token-a"),
    peerQuackPort: num("PEER_QUACK_PORT", 9495),
    peerQuackToken: str("PEER_QUACK_TOKEN", "token-b"),
    authDataDir: str("AUTH_DATA_DIR", "") ? resolve(process.cwd(), str("AUTH_DATA_DIR", "")) : `${dataDir}-auth`,
    authPgPort: num("AUTH_PG_PORT", 5442),
    // Resolve to an absolute path so DuckDB's LOAD doesn't depend on cwd.
    birdshotExtensionPath: str("BIRDSHOT_EXTENSION_PATH", "")
      ? resolve(process.cwd(), str("BIRDSHOT_EXTENSION_PATH", ""))
      : "",
  };
}
