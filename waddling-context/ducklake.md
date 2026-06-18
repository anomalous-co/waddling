# DuckLake Reference: Agents & ACL Control

## ATTACH Syntax & URIs

**Basic ATTACH (DuckDB catalog)**
```sql
ATTACH 'ducklake:metadata.ducklake' AS my_ducklake (DATA_PATH 'data/');
USE my_ducklake;
```

**PostgreSQL catalog + S3 data**
```sql
ATTACH 'ducklake:postgres:dbname=ducklake_catalog host=localhost' (DATA_PATH 's3://bucket/path/');
```

**Via secrets** (named or default)
```sql
CREATE SECRET ducklake_secret (TYPE ducklake, METADATA_PATH '', DATA_PATH 's3://bucket/', 
  METADATA_PARAMETERS MAP {'TYPE': 'postgres', 'SECRET': 'pg_secret'});
ATTACH 'ducklake:ducklake_secret' AS my_ducklake;
```

**Time-travel attach**
```sql
ATTACH 'ducklake:metadata.ducklake' (SNAPSHOT_VERSION 3);
ATTACH 'ducklake:metadata.ducklake' (SNAPSHOT_TIME '2025-05-26 00:00:00');
```

**Read-only mode**
```sql
ATTACH 'ducklake:postgres:dbname=postgres' (READ_ONLY);
```

## PostgreSQL as Catalog

Requirements: PostgreSQL 12+, `postgres` extension installed.

**Setup:**
```sql
INSTALL ducklake;
INSTALL postgres;

-- Catalog DB must exist on PostgreSQL
ATTACH 'ducklake:postgres:dbname=ducklake_catalog host=localhost' 
  (DATA_PATH 'data_files/');
USE my_ducklake;
```

## S3/R2 (Object Storage) Configuration

**Supported:** AWS S3, Cloudflare R2, Hetzner Object Storage (S3-compatible).

**Via secrets (recommended):**
```sql
CREATE SECRET s3_creds (TYPE s3, PROVIDER config, KEY_ID 'xxx', SECRET 'yyy', REGION 'eu-north-1');
CREATE SECRET pg_creds (TYPE postgres, HOST 'localhost', USER 'user', PASSWORD 'pass', DATABASE 'db');
CREATE SECRET ducklake_config (TYPE ducklake, METADATA_PATH '', DATA_PATH 's3://bucket/', 
  METADATA_PARAMETERS MAP {'TYPE': 'postgres', 'SECRET': 'pg_creds'});
ATTACH 'ducklake:ducklake_config' AS lake;
```

**S3 Access Patterns (path-based ACL):**
- Superuser: full `s3:ListBucket, GetObject, PutObject, DeleteObject` on `arn:aws:s3:::bucket/*`
- Writer: scope to schema path `arn:aws:s3:::bucket/schema_name/*` (includes DeleteObject for compaction)
- Reader: scope to table path `arn:aws:s3:::bucket/schema/table/*` (GetObject only)

## Creating Tables & Inserting

**Basic operations**
```sql
CREATE TABLE my_ducklake.tbl (id INTEGER, name VARCHAR);
INSERT INTO my_ducklake.tbl VALUES (1, 'Alice'), (2, 'Bob');

-- From CSV/Parquet
CREATE TABLE tbl AS FROM 'https://example.com/data.csv';

-- Schema evolution (no rewrite)
ALTER TABLE tbl ADD COLUMN status VARCHAR DEFAULT 'active';
ALTER TABLE tbl ALTER id SET TYPE BIGINT;  -- type promotion only
ALTER TABLE tbl DROP COLUMN status;
ALTER TABLE tbl RENAME id TO user_id;
```

## Snapshots & Time Travel

**List snapshots**
```sql
SELECT * FROM my_ducklake.snapshots();
SELECT * FROM my_ducklake.current_snapshot();  -- latest committed
SELECT * FROM my_ducklake.last_committed_snapshot();  -- for multi-client
```

**Commit metadata**
```sql
BEGIN;
INSERT INTO my_ducklake.people VALUES (1, 'Pedro');
CALL my_ducklake.set_commit_message('Pedro', 'Initial data', extra_info => '{"source": "api"}');
COMMIT;  -- snapshot created
```

**Time travel**
```sql
SELECT * FROM tbl AT (VERSION => 2);
SELECT * FROM tbl AT (TIMESTAMP => now() - INTERVAL '1 week');
```

## Multi-Client & Concurrent Access

**Conflict detection:** Sequential snapshot IDs auto-detect conflicts via PRIMARY KEY on `ducklake_snapshot.snapshot_id`.

**Automatic retry on non-conflicting changes** (e.g., inserts to different tables).

**Conflict types (transactions abort if detected):**
- Schema: create/drop same schema, drop schema with new entries
- Table/View: create/drop same table, alter dropped/altered tables
- Data: insert/delete to dropped/altered table, compact table with concurrent deletes
- Compaction: compact table altered/deleted by another transaction

**Multi-client setup:**
- **Single client:** DuckDB catalog
- **Multiple local clients:** SQLite catalog (retry on write-lock)
- **Remote clients:** PostgreSQL catalog (required for production multi-user)

**Retry config (defaults acceptable):**
```sql
-- Override per-connection if needed (details in DuckDB settings)
```

## Maintenance: Compaction & Cleanup

**Merge small files (preserves snapshots)**
```sql
CALL ducklake_merge_adjacent_files('my_ducklake');  -- all tables with auto_compact=true
CALL ducklake_merge_adjacent_files('my_ducklake', 'tbl', schema => 'schema_name');
CALL ducklake_merge_adjacent_files('my_ducklake', min_file_size => 10240, max_file_size => 102400);
```

**Disable auto-compaction per table**
```sql
CALL my_ducklake.set_option('auto_compact', false, table_name => 'tbl');
```

**Expire snapshots (enables physical deletion)**
```sql
CALL ducklake_expire_snapshots('my_ducklake', versions => [0, 1, 2]);
CALL ducklake_expire_snapshots('my_ducklake', older_than => now() - INTERVAL '1 week');
CALL ducklake_expire_snapshots('my_ducklake', dry_run => true, older_than => now() - INTERVAL '1 month');
```

**Clean up unreferenced files**
```sql
CALL ducklake_cleanup_old_files('my_ducklake', cleanup_all => true);
CALL ducklake_cleanup_old_files('my_ducklake', older_than => now() - INTERVAL '1 week');
CALL ducklake_delete_orphaned_files('my_ducklake', cleanup_all => true);
```

**Rewrite heavily-deleted files**
```sql
CALL ducklake_rewrite_data_files('my_ducklake', 't', delete_threshold => 0.5);
```

**Checkpoint (runs all maintenance)**
```sql
CHECKPOINT;  -- flushes inlined data, merges files, expires old snapshots (per config)
```

## Encryption

**Enable on init** (Parquet-level encryption)
```sql
ATTACH 'ducklake:encrypted.ducklake' (DATA_PATH 'untrusted_location/', ENCRYPTED);
```

- Keys auto-generated per file, stored in `ducklake_data_file.encryption_key`
- Files read/written transparently (keys fetched from catalog)
- No performance penalty vs unencrypted

## Data Inlining (Small Writes)

**Default:** inserts/deletes ≤10 rows stored in catalog, not as Parquet files.

**Configure:**
```sql
ATTACH 'ducklake:inlining.duckdb' (DATA_INLINING_ROW_LIMIT 50);
CALL my_ducklake.set_option('data_inlining_row_limit', 10, table_name => 'tbl');
SET ducklake_default_data_inlining_row_limit = 0;  -- disable globally
```

**Manual flush to Parquet**
```sql
CALL ducklake_flush_inlined_data('my_ducklake');
CALL ducklake_flush_inlined_data('my_ducklake', schema_name => 'schema', table_name => 'tbl');
```

## Access Control (Waddling Agents)

**Path-based ACL:** Schema/table isolation via catalog DB + S3 path restrictions.

**PostgreSQL roles:**
```sql
CREATE USER agent_writer WITH PASSWORD 'pass';
GRANT USAGE ON SCHEMA public TO agent_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_writer;

CREATE USER agent_reader WITH PASSWORD 'pass';
GRANT USAGE ON SCHEMA public TO agent_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_reader;
```

**S3 IAM policies (resource paths = schema/table):**
- Writer: `s3:ListBucket, GetObject, PutObject, DeleteObject` on `bucket/schema_name/*`
- Reader: `s3:GetObject` on `bucket/schema/table/*`

**Agent attach with ACL credentials:**
```sql
CREATE SECRET agent_pg (TYPE postgres, HOST 'host', DATABASE 'db', USER 'agent_writer', PASSWORD '...');
CREATE SECRET agent_s3 (TYPE s3, PROVIDER config, KEY_ID '...', SECRET '...', REGION '...');
CREATE SECRET agent_ducklake (TYPE ducklake, DATA_PATH 's3://bucket/', 
  METADATA_PARAMETERS MAP {'TYPE': 'postgres', 'SECRET': 'agent_pg'});
ATTACH 'ducklake:agent_ducklake' AS agent_lake;
```

## Key Parameters & Options

| Parameter | Default | Use |
|-----------|---------|-----|
| `DATA_PATH` | required | S3/local path for Parquet files |
| `DATA_INLINING_ROW_LIMIT` | 10 | Rows before write to Parquet |
| `ENCRYPTED` | false | Enable Parquet encryption |
| `READ_ONLY` | false | Read-only attach |
| `SNAPSHOT_VERSION` | latest | Attach at historical snapshot |
| `SNAPSHOT_TIME` | latest | Attach at timestamp |
| `CREATE_IF_NOT_EXISTS` | true | Auto-create if not exist |
| `METADATA_CATALOG` | `__ducklake_metadata_*` | Catalog DB name |

**Per-table options:**
```sql
CALL my_ducklake.set_option('auto_compact', false, table_name => 'tbl');
CALL my_ducklake.set_option('data_inlining_row_limit', 5, table_name => 'tbl');
CALL my_ducklake.set_option('sort_on_insert', true, table_name => 'tbl');
```

## Data Change Feed (Audit)

```sql
FROM db.table_changes('tbl', start_version, end_version);  -- insert/delete/update
FROM db.table_insertions('tbl', v1, v2);
FROM db.table_deletions('tbl', v1, v2);
```

Tracks row identity (`rowid`) + snapshot ownership for compliance.
