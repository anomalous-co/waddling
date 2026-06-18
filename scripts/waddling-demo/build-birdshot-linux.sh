#!/usr/bin/env bash
# build-birdshot-linux.sh — Build the birdshot DuckDB extension for linux/arm64
# inside a Debian container so the (Linux) gateway container can LOAD it.
#
# The host Mac builds a Mach-O arm64 extension (birdshot/build/...) which the
# Linux gateway cannot load. This produces a native linux/arm64
# birdshot.duckdb_extension at birdshot/build-linux/, where Dockerfile.gateway
# COPYs it.
#
# WHY THIS IS STRUCTURED THE WAY IT IS:
#  * This Mac's global file table (sysctl kern.maxfiles) is small and already
#    ~90% saturated by other apps. DuckDB-from-source over a macOS Docker bind
#    mount (virtiofs/FUSE) proxies thousands of file opens back to the host and
#    ENFILEs ("too many open files in system") during CMake configure.
#  * FIX: the entire build tree lives in a NAMED DOCKER VOLUME (VM-native ext4).
#    Files opened by CMake/ninja/g++ inside the volume consume the Linux VM's
#    file table, never the macOS host's — fully insulated from host saturation.
#    The volume PERSISTS, so an OOM-killed build resumes incrementally on re-run.
#  * Source is streamed in via `tar | docker run -i ... tar -x` (one fd, no FUSE
#    bind, no /private/tmp staging). Artifact is pulled out via `docker cp`.
#  * System OpenSSL (libssl-dev) instead of vcpkg avoids a second long build.
#
# Output: birdshot/build-linux/birdshot.duckdb_extension  (linux/arm64 ELF)
#
# Usage:
#   nohup bash scripts/waddling-demo/build-birdshot-linux.sh > /tmp/birdshot-linux-build.log 2>&1 &
#   tail -f /tmp/birdshot-linux-build.log
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DUCKDB_TAG="${DUCKDB_TAG:-v1.5.3}"
# Docker Desktop here has ~3.5GiB; DuckDB-from-source can OOM. -j2 default; the
# named volume lets a killed build resume, so drop to JOBS=1 if it gets killed.
JOBS="${JOBS:-2}"
VOLUME="${BIRDSHOT_VOLUME:-birdshot_linux_build}"
CONTAINER="${BIRDSHOT_CONTAINER:-birdshot_linux_builder}"

echo "==> repo root: ${REPO_ROOT}"
echo "==> build volume: ${VOLUME} (VM-native ext4, insulated from host fd table)"
echo "==> building birdshot for linux/arm64 (DuckDB ${DUCKDB_TAG}, -j${JOBS})"

docker volume create "${VOLUME}" >/dev/null
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

# Stream the extension source into the volume and build, all on VM-native ext4.
# Source is fed via stdin tar (single fd). Extraction is sentinel-guarded so
# re-runs preserve ninja's incremental state (re-extracting bumps mtimes).
tar -c -C "${REPO_ROOT}/birdshot" \
    --exclude=build \
    --exclude=build-linux \
    --exclude=.cache \
    --exclude=duckdb_unittest_tempdir \
    . \
| docker run -i \
  --name "${CONTAINER}" \
  --platform linux/arm64 \
  -v "${VOLUME}:/work" \
  -e DUCKDB_PLATFORM=linux_arm64 \
  -e CMAKE_BUILD_PARALLEL_LEVEL="${JOBS}" \
  -e GEN=ninja \
  debian:bookworm \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    echo "==> installing build deps"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      cmake ninja-build g++ git ca-certificates libssl-dev python3 make pkg-config >/dev/null
    echo "==> deps: $(cmake --version | head -1) | ninja $(ninja --version) | g++ $(g++ -dumpversion)"

    # First run: extract source into the volume. Re-runs: keep existing tree
    # (incl. build/) so ninja resumes incrementally.
    if [ ! -f /work/Makefile ]; then
      echo "==> first run: extracting source into volume"
      tar -x -C /work
    else
      echo "==> re-run: reusing existing build tree in volume (incremental)"
      # drain stdin so tar producer does not SIGPIPE-fail the host pipeline
      cat >/dev/null
    fi

    git config --global --add safe.directory "*"
    cd /work
    echo "==> starting make release (-j '"${JOBS}"')"
    GEN=ninja make release -j '"${JOBS}"'

    ART=/work/build/release/extension/birdshot/birdshot.duckdb_extension
    echo "==> build finished; artifact:"
    ls -la "${ART}"
    # debian:bookworm minimal has no `file`; ls is enough and avoids aborting
    # the script (set -e) before the host-side docker cp runs.
    file "${ART}" 2>/dev/null || true
  '

# Pull the artifact out of the (now-stopped, non-removed) container.
mkdir -p "${REPO_ROOT}/birdshot/build-linux"
docker cp \
  "${CONTAINER}:/work/build/release/extension/birdshot/birdshot.duckdb_extension" \
  "${REPO_ROOT}/birdshot/build-linux/birdshot.duckdb_extension"
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

ART="${REPO_ROOT}/birdshot/build-linux/birdshot.duckdb_extension"
echo "==> DONE. Linux artifact at: ${ART}"
file "${ART}"
