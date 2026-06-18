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
    /** ENCRYPTED ducklake attach. */
    encrypted: boolean;
    /** S3/R2/MinIO secret for the lake's object store. Unused when {@link localData}. */
    s3: {
        endpoint: string;
        keyId: string;
        secret: string;
        region: string;
        useSsl: boolean;
        urlStyle: "path" | "vhost";
    };
}
export declare function loadGatewayConfig(): GatewayConfig;
