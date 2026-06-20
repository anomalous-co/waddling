#!/usr/bin/env bash
# bb-init.sh — (re)create a FRESH quackboard at swarm/quackboard.duckdb with the
# full schema, the shared objective, and a valid FTS index. Server must be
# stopped (this opens the file directly). Destroys any prior run's data.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${BB_DB:-$HERE/quackboard.duckdb}"
OBJECTIVE="${1:-Explore and qualify the architecture of the waddling API at /Users/orchid/mirrir/waddling — focus on apps/control-api and how it spans the three planes (control/data/agent). Collectively produce observations (with file references) and an architectural qualification covering: auth boundaries, secret/credential handling, ACL enforcement, the control/data-plane split, failure modes, and multi-tenant isolation. Coordinate ONLY via the bb toolkit; run \`bb help\` first.}"

rm -f "$DB" "$DB".wal
duckdb "$DB" <<SQL
INSTALL fts; LOAD fts;
CREATE SEQUENCE trace_seq START 1;  CREATE SEQUENCE tool_seq START 1;
CREATE SEQUENCE obs_seq   START 1;  CREATE SEQUENCE amem_seq START 1;
CREATE SEQUENCE sub_seq   START 1;  CREATE SEQUENCE notif_seq START 1;
CREATE SEQUENCE bnd_seq   START 1;  CREATE SEQUENCE msg_seq  START 1;

CREATE TABLE objectives(id INTEGER PRIMARY KEY, owner TEXT, status TEXT DEFAULT 'open', body TEXT);
CREATE TABLE straces(ord INTEGER PRIMARY KEY DEFAULT nextval('trace_seq'),
  session_id TEXT, agent_role TEXT, model TEXT, status TEXT,
  started_at TIMESTAMP DEFAULT current_timestamp, ended_at TIMESTAMP);
CREATE TABLE tool(ord INTEGER PRIMARY KEY DEFAULT nextval('tool_seq'),
  session_id TEXT, agent_role TEXT, phase TEXT, tool_name TEXT, tool_use_id TEXT,
  tool_input JSON, tool_response JSON, duration_ms INTEGER, ts TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE observations(id INTEGER PRIMARY KEY DEFAULT nextval('obs_seq'),
  agent_role TEXT, content TEXT, refs JSON, topic TEXT, ts TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE agent_memory(id INTEGER PRIMARY KEY DEFAULT nextval('amem_seq'),
  agent_role TEXT, key TEXT, content TEXT, ts TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE claims(area TEXT PRIMARY KEY, agent_role TEXT, status TEXT DEFAULT 'claimed', ts TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE subscriptions(id INTEGER PRIMARY KEY DEFAULT nextval('sub_seq'),
  agent_role TEXT, pattern TEXT, match_type TEXT DEFAULT 'fts', topic TEXT, created TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE notifications(id INTEGER PRIMARY KEY DEFAULT nextval('notif_seq'),
  to_role TEXT, source_id INTEGER, sub_id INTEGER, snippet TEXT, ts TIMESTAMP DEFAULT current_timestamp, is_read BOOLEAN DEFAULT false);
CREATE TABLE boundaries(id INTEGER PRIMARY KEY DEFAULT nextval('bnd_seq'),
  name TEXT, scope TEXT, paths JSON, status TEXT DEFAULT 'open', owner TEXT, ts TIMESTAMP DEFAULT current_timestamp);
CREATE TABLE messages(id INTEGER PRIMARY KEY DEFAULT nextval('msg_seq'),
  from_agent TEXT, to_agent TEXT, body TEXT, ts TIMESTAMP DEFAULT current_timestamp);

INSERT INTO objectives VALUES (1,'swarm','open','$(printf '%s' "$OBJECTIVE" | sed "s/'/''/g")');
INSERT INTO observations(agent_role,content,refs,topic) VALUES ('system','swarm scaffold initialized','[]','meta');
PRAGMA create_fts_index('observations','id','content', stemmer='porter', overwrite=1);
SELECT 'fresh db: '||(SELECT count(*) FROM objectives)||' objective, schema ready' AS s;
SQL
