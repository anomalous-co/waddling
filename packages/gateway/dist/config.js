// Gateway runtime configuration, read once from the environment (W3).
// See ARCHITECTURE.md §9-W3 and docker-compose (§8) for the canonical values.
// NOTE: session-JWT settings (JWKS_URL / JWT_ISSUER / JWT_AUDIENCE) are NOT read
// here. The gateway no longer verifies JWTs itself — birdshot does, at the quack
// auth hook, using the issuer/audience/JWKS pushed atomically with each policy
// snapshot (birdshot_set_auth / birdshot_add_jwk in applySnapshot).
function req(name) {
    const v = process.env[name];
    if (v === undefined || v === "") {
        throw new Error(`[gateway] missing required env ${name}`);
    }
    return v;
}
function opt(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === "" ? fallback : v;
}
function bool(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === "")
        return fallback;
    return /^(1|true|yes|on)$/i.test(v);
}
export function loadGatewayConfig() {
    const ducklakeDataPath = req("DUCKLAKE_DATA_PATH");
    const localData = !/^s3:\/\//i.test(ducklakeDataPath);
    const ducklakeCatalogFile = opt("DUCKLAKE_CATALOG_FILE", "");
    return {
        birdshotExtensionPath: req("BIRDSHOT_EXTENSION_PATH"),
        quackPort: Number(opt("QUACK_PORT", "9500")),
        serverToken: req("GW_SERVER_TOKEN"),
        ctrlPort: Number(opt("CTRL_PORT", "9510")),
        // postgres-catalog DSN is required only when no local catalog file is given.
        ducklakeCatalogDsn: ducklakeCatalogFile ? opt("DUCKLAKE_CATALOG_DSN", "") : req("DUCKLAKE_CATALOG_DSN"),
        ducklakeCatalogFile,
        ducklakeDataPath,
        localData,
        lakeAlias: opt("DUCKLAKE_ALIAS", "lake"),
        encrypted: bool("DUCKLAKE_ENCRYPTED", false),
        // S3 creds are required only for an s3:// data path; in local mode they are unused.
        s3: {
            endpoint: localData ? opt("S3_ENDPOINT", "") : req("S3_ENDPOINT"),
            keyId: localData ? opt("S3_KEY_ID", "") : req("S3_KEY_ID"),
            secret: localData ? opt("S3_SECRET", "") : req("S3_SECRET"),
            region: opt("S3_REGION", "auto"),
            useSsl: bool("S3_USE_SSL", false),
            urlStyle: opt("S3_URL_STYLE", "path"),
        },
    };
}
