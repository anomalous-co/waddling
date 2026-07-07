# @waddling/mcp

Local [MCP](https://modelcontextprotocol.io) server for **waddling** — governed
data-lake access for AI agents. It's a thin, safe client of the waddling control
plane: it holds no database credentials, only your bearer-token profiles, and
every query is authorized server-side by birdshot.

## Install

```bash
claude mcp add waddling npx -- -y @waddling/mcp
```

Or configure any MCP client to launch `npx -y @waddling/mcp` over stdio.

First run is unauthenticated: ask the agent to run `waddling_signup`, open the
link it prints, sign in, and the key is stored locally (`~/.waddling/`). From then
on the tools are live.

## Bearer-token profiles

One install can hold several **named profiles**, each a durable key backed by its
own waddling agent identity and ACL grants — e.g. a read-only `analyst` and a
write-capable `etl`. Pass `profile` to any tool to act as that identity; omit it
for the default.

- `waddling_profiles_list` — see stored profiles
- `waddling_profile_add { profile, api_key }` — import an existing `sk_agent_` key
- `waddling_profile_default { profile }` — set the default
- `waddling_profile_remove { profile }` — delete locally + revoke server-side
- `waddling_signup { profile }` — provision a new profile via device link

Env fallbacks: `WADDLING_API_KEY` (an implicit `env` profile), `WADDLING_PROFILE`
(select a profile), `WADDLING_URL` (override the control-plane host).

## Durable, scoped access — no 15-minute expiry

Sessions never "go cold" from the agent's view: `waddling_query` transparently
re-connects an expired session and retries, so there is no periodic reconnect.

When you need access you don't have, request it — the grant is then **permanent**
on your key:

- `waddling_request_access { datalake_id, grants:[{schema,table,caps}] }` → returns
  a link a human owner opens to review the requested grants (pre-filled as pending)
  and approve.
- `waddling_await_access { … }` → waits until the grant is live.

## Data tools

`waddling_list_datalakes`, `waddling_describe`, `waddling_connect`,
`waddling_query`, `waddling_etl`, `waddling_explain`, `waddling_whoami`,
`waddling_time_travel`, `waddling_install_extension`.

Reference the attached lake as `lake.<schema>.<table>`. Denials come back
structured (`{ error, table, reason }`) so the agent can self-correct.

## Remote (multi-tenant) mode

`waddling-mcp --http` serves streamable HTTP on `$PORT` (default 8810); each
request carries its own `Authorization: Bearer` key.
