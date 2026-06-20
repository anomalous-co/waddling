// Gateway runtime configuration, read once from the environment (W3).
// See ARCHITECTURE.md §9-W3 and docker-compose (§8) for the canonical values.

export interface GatewayConfig {
  /** birdshot compiled extension to LOAD (allow_unsigned_extensions). */
  birdshotExtensionPath: string;
  /** quack_serve port (data plane). */
  quackPort: number;
  /** birdshot server_token passed to quack_serve and verified per connection. */
  serverToken: string;
  /** HTTP control-channel port (W1's gateway-client contract; internal only). */
  ctrlPort: number;

  /** DuckLake postgres catalog DSN (e.g. 'dbname=ducklake host=postgres'). Empty in local-file mode. */
  ducklakeCatalogDsn: string;
  /**
   * Local DuckLake catalog file (e.g. '/abs/lake.ducklake'). When set, the lake
   * is ATTACHed as 'ducklake:<file>' instead of 'ducklake:postgres:<dsn>' — the
   * no-Postgres, host-native path. Empty in postgres-catalog mode.
   */
  ducklakeCatalogFile: string;
  /** DuckLake DATA_PATH: 's3://bucket/prefix/' (object store) or a local dir '/abs/data/'. */
  ducklakeDataPath: string;
  /** True when DATA_PATH is a local directory (no S3 secret needed). */
  localData: boolean;
  /** Alias the lake is ATTACHed as inside DuckDB. */
  lakeAlias: string;
  /**
   * Postgres schema that holds THIS endpoint's DuckLake metadata tables (the
   * `METADATA_SCHEMA` ATTACH option). Empty ⇒ DuckLake's default `main`. This is the
   * per-endpoint isolation primitive when many endpoints share ONE org-level Postgres
   * catalog database: distinct schema → distinct DuckLake → no cross-endpoint visibility.
   * Only meaningful for a postgres catalog; ignored for a local catalog file.
   */
  metadataSchema: string;
  /** ENCRYPTED ducklake attach. */
  encrypted: boolean;

  /**
   * Quackboard mode: boot birdshot + serve quack but do NOT ATTACH any DuckLake or object
   * store. The opened {@link databasePath} IS the durable store (shared agent-coordination
   * tables); the data plane restores/persists it from R2. birdshot still enforces ACLs.
   */
  quackboard: boolean;
  /**
   * DuckDB database to open. ':memory:' for a lake gateway (durable data lives in the
   * ATTACHed lake). An absolute file path for a quackboard — the durable .duckdb the data
   * plane restored from R2 — so quack serves its tables directly with no views.
   */
  databasePath: string;

  /** S3/R2/MinIO secret for the lake's object store. Unused when {@link localData}. */
  s3: {
    endpoint: string; // 'minio:9000' or 'r2-account.r2.cloudflarestorage.com'
    keyId: string;
    secret: string;
    sessionToken: string; // STS-style session token (R2 faucet temp creds); '' for static creds
    region: string;
    useSsl: boolean; // false for MinIO; true for R2
    urlStyle: "path" | "vhost"; // MinIO needs path-style
  };
}
// NOTE: session-JWT settings (JWKS_URL / JWT_ISSUER / JWT_AUDIENCE) are NOT read
// here. The gateway no longer verifies JWTs itself — birdshot does, at the quack
// auth hook, using the issuer/audience/JWKS pushed atomically with each policy
// snapshot (birdshot_set_auth / birdshot_add_jwk in applySnapshot).

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`[gateway] missing required env ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadGatewayConfig(): GatewayConfig {
  // Quackboard: no DuckLake at all, so the lake env vars (DATA_PATH/CATALOG_DSN/S3) are not
  // required — the served database is DUCKDB_DATABASE_PATH (a file restored from R2).
  const quackboard = bool("QUACKBOARD", false);
  const ducklakeDataPath = quackboard ? opt("DUCKLAKE_DATA_PATH", "") : req("DUCKLAKE_DATA_PATH");
  const localData = quackboard || !/^s3:\/\//i.test(ducklakeDataPath);
  const ducklakeCatalogFile = opt("DUCKLAKE_CATALOG_FILE", "");

  return {
    birdshotExtensionPath: req("BIRDSHOT_EXTENSION_PATH"),
    quackPort: Number(opt("QUACK_PORT", "9500")),
    serverToken: req("GW_SERVER_TOKEN"),
    ctrlPort: Number(opt("CTRL_PORT", "9510")),

    // postgres-catalog DSN is required only when no local catalog file is given (and never
    // for a quackboard, which mounts no catalog).
    ducklakeCatalogDsn:
      quackboard || ducklakeCatalogFile ? opt("DUCKLAKE_CATALOG_DSN", "") : req("DUCKLAKE_CATALOG_DSN"),
    ducklakeCatalogFile,
    ducklakeDataPath,
    localData,
    lakeAlias: opt("DUCKLAKE_ALIAS", "lake"),
    // Per-endpoint metadata schema (postgres catalog only). Empty ⇒ DuckLake default 'main'.
    metadataSchema: opt("DUCKLAKE_METADATA_SCHEMA", ""),
    encrypted: bool("DUCKLAKE_ENCRYPTED", false),

    quackboard,
    databasePath: opt("DUCKDB_DATABASE_PATH", ":memory:"),

    // S3 creds are required only for an s3:// data path; in local mode they are unused.
    s3: {
      endpoint: localData ? opt("S3_ENDPOINT", "") : req("S3_ENDPOINT"),
      keyId: localData ? opt("S3_KEY_ID", "") : req("S3_KEY_ID"),
      secret: localData ? opt("S3_SECRET", "") : req("S3_SECRET"),
      sessionToken: opt("S3_SESSION_TOKEN", ""),
      region: opt("S3_REGION", "auto"),
      useSsl: bool("S3_USE_SSL", false),
      urlStyle: (opt("S3_URL_STYLE", "path") as "path" | "vhost"),
    },
  };
}
