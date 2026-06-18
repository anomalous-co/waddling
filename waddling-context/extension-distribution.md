# DuckDB Extension Distribution — Waddling Implementation Guide

## Quick Start: One-Command User Install

**End-user goal**: Install and load a waddling-managed extension with minimal friction.

```sql
INSTALL myext FROM 'https://your-repo.example.com';
LOAD myext;
```

This is the smoothest UX. Custom repositories must follow DuckDB's directory structure.

---

## Repository Structure & Layout

Custom repositories serve extensions over HTTP(S), S3, or local paths using **one standard format**:

```
{repo_root}
└── v{duckdb_version}          # e.g., v1.2.0
    └── {platform}             # linux_amd64, osx_arm64, windows_amd64, etc.
        ├── myext.duckdb_extension       # uncompressed (optional)
        └── myext.duckdb_extension.gz    # compressed (preferred)
```

**Supported Platforms** (all official extensions target these):
- `linux_amd64`, `linux_amd64_gcc4` (Node.js, Python CLI, etc.)
- `linux_arm64` (AWS Graviton, Snapdragon)
- `osx_amd64` (Intel Mac), `osx_arm64` (Apple Silicon)
- `windows_amd64`
- `windows_amd64_mingw`, `wasm_eh`, `wasm_mvp` (limited distro)

**Binary Compatibility**: Extensions are tied to **exact DuckDB version + platform**. Mismatches error. Version detection: stable releases use semver (v1.2.0); nightly builds use git short hash.

---

## Installation Methods

### From Custom Repository (Recommended)

```sql
-- One-time setup (optional, sets default)
SET custom_extension_repository = 'http://your-repo.example.com';

-- Then simply:
INSTALL myext;  -- reads from custom_extension_repository
LOAD myext;
```

Or explicit per-install:

```sql
INSTALL myext FROM 'https://your-repo.example.com';
LOAD myext;
```

DuckDB searches for both gzipped (`.gz`) and uncompressed versions; gzip preferred for bandwidth.

### From HTTPS/S3 Repositories

For HTTPS or S3 repos, `httpfs` extension is **auto-loaded** on first use—no manual setup required.

```sql
INSTALL myext FROM 'https://cdn.example.com/extensions';
INSTALL myext FROM 's3://my-bucket/extensions';
```

### From Local Path

```sql
INSTALL './path/to/myext.duckdb_extension';
LOAD './path/to/myext.duckdb_extension';
```

### Force Upgrade

```sql
FORCE INSTALL myext;  -- re-download, bypass cache
FORCE INSTALL myext FROM 'https://new-repo.example.com';  -- switch repos
```

---

## Extension Signing & Security

### Signed Extensions (Default Security)

- **Core-signed**: Built & verified by DuckDB team (http://extensions.duckdb.org)
- **Community-signed**: Open-source extensions via community repository (http://community-extensions.duckdb.org)
- **No signature verification needed**—DuckDB validates automatically using built-in public keys
- Can be served over plain **HTTP** (no HTTPS required) because cryptographic validation is baked in

**Security Levels**:
```sql
-- Default (recommended for agents): allow core + community
SET allow_community_extensions = true;  -- (default)

-- Strict: core only
SET allow_community_extensions = false;

-- Permissive (dev only): unsigned allowed
SET allow_unsigned_extensions = true;
```

### Unsigned Extensions

**Required for custom extensions** unless you obtain core/community signing.

```bash
# CLI startup
duckdb -unsigned
```

Client APIs (Python example):
```python
import duckdb
conn = duckdb.connect(':memory:', config={'allow_unsigned_extensions': True})
```

**Warning**: Unsigned extensions execute with full process privileges. Only load from trusted sources over HTTPS.

---

## Serving from Object Storage (R2/S3 + CDN)

DuckDB natively supports S3 repositories with auto-loaded `httpfs`:

```sql
INSTALL myext FROM 's3://my-waddling-extensions';
```

**Setup**:
1. Create S3 bucket (or Cloudflare R2) with structure above
2. Upload gzipped extension binaries: `v1.2.0/linux_amd64/myext.duckdb_extension.gz`
3. Optionally front with CDN (CloudFlare, CloudFront, etc.)
4. Use bucket/CDN URL in `INSTALL` command

S3 credentials: DuckDB auto-detects via AWS SDK (env vars, `.aws/config`). R2 auth via `s3_access_key_id`, `s3_secret_access_key` settings.

**Waddling benefit**: Agents query `ATTACH` to org DuckDB endpoints; you control the ACL-gated repository. Plain S3 + CDN is simpler than running app servers.

---

## Building & CI/CD for Extension Distribution

### Build Tools (Extension Template)

Use [`duckdb/extension-template`](https://github.com/duckdb/extension-template):

```bash
git clone --recurse-submodules https://github.com/<you>/<your-ext>.git
cd <your-ext>
make  # builds ./build/release/extension/<name>/<name>.duckdb_extension
```

Binary output: `./build/release/extension/{name}/{name}.duckdb_extension` (unsigned)

### GitHub Actions Pipeline

Template includes `.github/workflows/MainDistributionPipeline.yml`:

```yaml
jobs:
  duckdb-stable-build:
    uses: duckdb/extension-ci-tools/.github/workflows/_extension_distribution.yml@v1.5-variegata
    with:
      duckdb_version: v1.2.0
      ci_tools_version: v1.5-variegata
      extension_name: myext
```

Artifacts automatically built for all platforms. Upload to S3/R2 in release workflow.

### Keeping Versioned Builds

Extension binaries are **per-DuckDB-version**. When DuckDB releases v1.3.0:

1. Update submodule: `cd duckdb && git checkout v1.3.0 && cd .. && git add duckdb`
2. CI rebuilds for v1.3.0 (all platforms)
3. Upload to `{repo}/v1.3.0/{platform}/myext.duckdb_extension.gz`

Or maintain multiple versions by duplicating CI jobs with different `duckdb_version` params.

---

## Community Extension Submission (Optional Distribution Path)

If you want signed, auto-updated distribution without running infrastructure:

1. Ensure extension builds with default CI toolchain (extension-template does this)
2. Add descriptor YAML to [duckdb/community-extensions](https://github.com/duckdb/community-extensions):
   ```yaml
   repo:
     github: yourorg/myext
     ref: abc123def456  # commit hash
   ```
3. Community CI builds, signs, distributes to http://community-extensions.duckdb.org
4. Users install with: `INSTALL myext FROM community;`

**For waddling**: Community repo is good for public extensions; org-internal extensions stay on your own R2/S3 repo.

---

## Configuration Reference

Key settings for agents querying extension repositories:

```sql
-- Set default repo (avoids repetition in INSTALL commands)
SET custom_extension_repository = 'http://your-repo.example.com';

-- Control what extensions can load
SET allow_unsigned_extensions = false;      -- require signatures (default: false)
SET allow_community_extensions = true;      -- allow community-signed (default: true)
SET autoinstall_known_extensions = true;    -- auto-install on first use
SET autoload_known_extensions = true;       -- auto-load on startup

-- Inspect installed extensions
SELECT extension_name, extension_version, installed_from, install_mode
FROM duckdb_extensions();

-- Cache location (auto-managed, per-version + platform)
SET extension_directory = '/custom/cache/path';
-- Default: ~/.duckdb/extensions/{version}/{platform}/
```

---

## Waddling Integration Points

**ACL-governed access pattern**:
- Agent requests `INSTALL myext FROM 'https://waddling-repo.org'`
- Waddling backend controls:
  - Which extensions are published (upload to S3)
  - Which DuckDB versions/platforms are available
  - Signed vs. unsigned (community vs. custom)
  - Auth headers (if repo requires API key)
- Agent's DuckDB instance caches locally after first install

**DevEx priority**:
- Single `INSTALL` command + optional `SET custom_extension_repository`
- No manual binary downloads
- Gzip compression for faster CDN delivery
- S3 + CloudFlare = minimal infra for org-scale distribution
