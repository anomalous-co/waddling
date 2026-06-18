#!/usr/bin/env bash
# build.sh — Pack the DuckBase Claude Desktop Extension (.mcpb)
#
# Prerequisites:
#   1. pnpm --filter @waddling/mcp build   (builds the MCP server JS bundle)
#   2. This script must run from the repo root (or set REPO_ROOT env var)
#
# Output: marketplace/mcpb/waddling-<version>.mcpb  (a ZIP file)
#
# Usage:
#   bash marketplace/mcpb/build.sh
#   bash marketplace/mcpb/build.sh --version 0.2.0
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_PKG_DIR="${REPO_ROOT}/packages/mcp-external"
OUT_DIR="${SCRIPT_DIR}"

# Allow version override
VERSION="${1#--version=}"
if [[ "${1:-}" == "--version" ]]; then
  VERSION="${2}"
fi
if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(node -p "require('${MCP_PKG_DIR}/package.json').version" 2>/dev/null || echo "0.1.0")"
fi

OUT_FILE="${OUT_DIR}/waddling-${VERSION}.mcpb"

echo "[waddling mcpb] Building version ${VERSION}..."

# ── 1. Verify the MCP server is built ──────────────────────────────────────────
BUILT_BUNDLE="${MCP_PKG_DIR}/dist/index.js"
if [[ ! -f "${BUILT_BUNDLE}" ]]; then
  echo "[waddling mcpb] ERROR: ${BUILT_BUNDLE} not found."
  echo "  Run: pnpm --filter @waddling/mcp build"
  exit 1
fi

# ── 2. Stage files into a temp directory ──────────────────────────────────────
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

mkdir -p "${STAGE_DIR}/server"

# Copy the built server bundle
cp "${BUILT_BUNDLE}" "${STAGE_DIR}/server/index.js"

# Copy the manifest
cp "${SCRIPT_DIR}/manifest.json" "${STAGE_DIR}/manifest.json"

# Copy any additional assets bundled with the MCP package (icons, etc.) if present
if [[ -d "${MCP_PKG_DIR}/assets" ]]; then
  cp -r "${MCP_PKG_DIR}/assets" "${STAGE_DIR}/assets"
fi

# ── 3. Pack into .mcpb (zip) ──────────────────────────────────────────────────
echo "[waddling mcpb] Packing ${OUT_FILE}..."
(cd "${STAGE_DIR}" && zip -qr "${OUT_FILE}" .)

echo "[waddling mcpb] Done: ${OUT_FILE}"
echo ""
echo "Install in Claude Desktop: double-click ${OUT_FILE}"
echo "Or drag it into Claude Desktop > Settings > Extensions."
