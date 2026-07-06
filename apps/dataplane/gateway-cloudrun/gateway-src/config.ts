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
   * mTLS client cert / key / server-CA file paths for the postgres catalog connection.
   * Cloud SQL requires a client cert (TRUSTED_CLIENT_CERTIFICATE_REQUIRED) and presents a
   * per-instance internal CA that is NOT in the system trust store, so the catalog ATTACH
   * must use `sslmode=verify-ca` with an explicit `sslrootcert`. The per-org DSN carries
   * only `sslmode=verify-ca`; these paths are appended at ATTACH time (one shared client
   * cert per deployment). Empty ⇒ no mTLS appended (local-file / demo / selftest catalogs).
   * The entrypoint materializes the PEM secrets to files and sets these env vars.
   */
  catalogSslCert: string;
  catalogSslKey: string;
  catalogSslRootCert: string;

  /**
   * Quackboard mode: boot birdshot + serve quack but do NOT ATTACH any DuckLake or object
   * store. The opened {@link databasePath} IS the durable store (shared agent-coordination
   * tables); the data plane restores/persists it from R2. birdshot still enforces ACLs.
   */
  quackboard: boolean;
  /**
   * Workspace mode: like quackboard in that a durable .duckdb file is opened directly (no
   * DuckLake, no coordination schema). The agent's own DDL creates tables; birdshot still
   * enforces ACLs. The file is fetched from GCS on boot and uploaded back after CHECKPOINT.
   * Mutually exclusive with quackboard; if both are set, quackboard takes precedence.
   */
  workspaceMode: boolean;
  /**
   * Memory-lake (quackboard) mode: a NORMAL managed DuckLake gateway (real Postgres catalog +
   * object store) that ALSO bootstraps the shared agent-coordination tables into `lake.main`
   * at boot. Unlike the legacy {@link quackboard} local-file mode this is NOT no-lake — the 8
   * coordination namespaces are governed DuckLake tables, durable in the catalog/object store,
   * and board reads+writes ride the trusted `/qb-query` path (birdshot-authorized, executed on
   * the control connection that has `USE lake`). Orthogonal to quackboard/workspaceMode.
   */
  memoryLake: boolean;
  /**
   * Workspace encryption key (64 hex chars) for the durable .duckdb. When set in workspace
   * mode the gateway opens ':memory:' and ATTACHes {@link databasePath} ENCRYPTED (OpenSSL via
   * httpfs), so the file is encrypted at rest before it is uploaded to GCS. Empty ⇒ plaintext
   * workspace open (back-compat). Unused outside workspace mode.
   */
  encryptionKey: string;
  /**
   * DuckDB database to open. ':memory:' for a lake gateway (durable data lives in the
   * ATTACHed lake). An absolute file path for a quackboard or workspace — the durable .duckdb
   * the data plane restored from GCS/R2 — so quack serves its tables directly with no views.
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
  // Quackboard and workspace mode: no DuckLake, so lake env vars are not required.
  // Quackboard also bootstraps coordination tables; workspace opens the file clean (agent DDL).
  const quackboard = bool("QUACKBOARD", false);
  const workspaceMode = !quackboard && bool("WORKSPACE_MODE", false);
  // Memory-lake mode is a REAL managed DuckLake (lake env vars required, like a normal lake) that
  // additionally bootstraps the board schema — so it is NOT part of noDuckLake.
  const memoryLake = !quackboard && !workspaceMode && bool("MEMORY_LAKE", false);
  const noDuckLake = quackboard || workspaceMode;
  const ducklakeDataPath = noDuckLake ? opt("DUCKLAKE_DATA_PATH", "") : req("DUCKLAKE_DATA_PATH");
  const localData = noDuckLake || !/^s3:\/\//i.test(ducklakeDataPath);
  const ducklakeCatalogFile = opt("DUCKLAKE_CATALOG_FILE", "");

  return {
    birdshotExtensionPath: req("BIRDSHOT_EXTENSION_PATH"),
    quackPort: Number(opt("QUACK_PORT", "9500")),
    serverToken: req("GW_SERVER_TOKEN"),
    ctrlPort: Number(opt("CTRL_PORT", "9510")),

    // postgres-catalog DSN is required only when no local catalog file is given (and never
    // in no-lake modes: quackboard or workspace).
    ducklakeCatalogDsn:
      noDuckLake || ducklakeCatalogFile ? opt("DUCKLAKE_CATALOG_DSN", "") : req("DUCKLAKE_CATALOG_DSN"),
    ducklakeCatalogFile,
    ducklakeDataPath,
    localData,
    lakeAlias: opt("DUCKLAKE_ALIAS", "lake"),
    // Per-endpoint metadata schema (postgres catalog only). Empty ⇒ DuckLake default 'main'.
    metadataSchema: opt("DUCKLAKE_METADATA_SCHEMA", ""),
    encrypted: bool("DUCKLAKE_ENCRYPTED", false),

    // mTLS material for the postgres catalog (Cloud SQL). Set by the entrypoint after it
    // materializes the PEM secrets to files; empty for local-file/demo catalogs.
    catalogSslCert: opt("DUCKLAKE_CATALOG_SSLCERT", ""),
    catalogSslKey: opt("DUCKLAKE_CATALOG_SSLKEY", ""),
    catalogSslRootCert: opt("DUCKLAKE_CATALOG_SSLROOTCERT", ""),

    quackboard,
    workspaceMode,
    memoryLake,
    encryptionKey: opt("WORKSPACE_ENCRYPTION_KEY", ""),
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
