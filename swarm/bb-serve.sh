#!/usr/bin/env bash
# bb-serve.sh start|stop — run a long-lived DuckDB process that holds the
# quackboard DuckDB file open and serves it over quack. The duckdb CLI process
# is kept alive by holding stdin open (tail -f) after quack_serve starts its
# background listener thread. Teardown is a plain kill (process exit releases
# the file lock); quack_stop isn't reachable once stdin is a tail -f pipe.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${BB_DB:-$HERE/quackboard.duckdb}"
TOK="${BB_TOKEN:-bb-dev-token}"
PORT="${BB_PORT:-9494}"
PIDF="$HERE/bb-serve.pid"
export PATH="$HERE/bin:$PATH"

start () {
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "already running (pid $(cat "$PIDF"))"; return 0
  fi
  duckdb "$DB" < <(printf "INSTALL quack;LOAD quack;INSTALL fts;LOAD fts;CALL quack_serve('quack:127.0.0.1:%s', token := '%s');\n" "$PORT" "$TOK"; tail -f /dev/null) \
    > "$HERE/bb-serve.out" 2>&1 &
  echo $! > "$PIDF"
  # health gate: wait until the server answers a client round-trip
  for i in $(seq 1 50); do
    if BB_TOKEN="$TOK" BB_URI="quack:127.0.0.1:$PORT" bbq "SELECT 1" >/dev/null 2>&1; then
      echo "serving on quack:127.0.0.1:$PORT (pid $(cat "$PIDF"))"; return 0
    fi
    sleep 0.2
  done
  echo "FAILED to come up; server log:" >&2; cat "$HERE/bb-serve.out" >&2; return 1
}

stop () {
  if [ -f "$PIDF" ]; then
    kill "$(cat "$PIDF")" 2>/dev/null || true
    rm -f "$PIDF"
    echo "stopped"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop)  stop ;;
  *) echo "usage: bb-serve.sh start|stop" >&2; exit 2 ;;
esac
