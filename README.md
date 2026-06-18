# pglite-sandbox

A web application where **two users run analytics on each other's databases**. Each
user runs an instance that stores data in its own [PGlite](https://pglite.dev)
(in-process PostgreSQL) database and federates analytics across both instances using
[DuckDB](https://duckdb.org)'s **quack** protocol — DuckDB's native HTTP catalog
federation (v1.5.3+). The phrase "duck quack" is literal: DuckDB's quack endpoint is
what lets each side query the other's PGlite data.

Built as a **Next.js + TypeScript pnpm workspace**, running on **Node**.

## Architecture

Each instance is one Next.js process that stacks three layers:

```
Browser (Next.js UI)
        │  CRUD → /api/todos        Analytics → /api/analytics, /api/query
        ▼
┌───────────────────────────────────────────────┐
│  Next.js server (App Router, Node runtime)     │
│  instrumentation.ts boots the quack stack once │
└───────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌──────────────────┐   pg wire    ┌──────────────────────────┐
│  PGlite          │ ───────────► │  DuckDB (:memory:)       │
│  ./pgdata-a      │  (:5432)     │  ATTACH local_db RO      │
│  (authoritative) │  PGLiteSocket│  VIEW todos              │
└──────────────────┘   Server     │  CALL quack_serve :9494  │
                                  └──────────────────────────┘
                                            │  quack HTTP
                                            ▼
                                  ┌──────────────────────────┐
                                  │  Peer instance :9495     │
                                  │  ATTACH peer_db          │
                                  └──────────────────────────┘
```

PGlite is the authoritative store (all writes go to it). DuckDB can't embed PGlite,
so [`pglite-socket`](https://www.npmjs.com/package/@electric-sql/pglite-socket)
bridges them over the standard PostgreSQL wire protocol on localhost. DuckDB exposes
its read-only view over the quack protocol so the peer instance can attach and run
federated analytics across both databases.

Two "users" = two instances of the same codebase (`dev:a` / `dev:b`), each with its
own PGlite store and quack peer. Quack federation is inherently cross-process, so two
processes is the architecturally honest mapping — and it's still one codebase.

### Private data & peer isolation

Each instance also runs a **second, private PGlite database** (`./pgdata-a-private`)
holding notebooks and saved views. It is **deliberately never `ATTACH`ed to DuckDB**,
so it is outside the quack server's catalog and **physically unreachable by peers** — a
peer querying `peer_db.…notebooks` simply gets "table does not exist". As
defense-in-depth, a **read-only authorization macro** (`quack_authorization_function`)
additionally rejects any non-read statement a peer sends, so peers can read the shared
`todos` but never write. (Capturing *which* queries a peer ran is deferred to a future
DuckDB extension, **birdshot** — the authorization hook can enforce but a SQL macro
can't record, and node-registered UDFs aren't visible to quack's dispatcher.)

## Workspace layout

```
pglite-sandbox/
├── pnpm-workspace.yaml
├── package.json              # dev:a / dev:b / build scripts
├── tsconfig.base.json
├── packages/
│   └── db/                   # framework-agnostic quack stack
│       └── src/
│           ├── config.ts     # env → typed config (shared + private data dirs)
│           ├── stack.ts      # getStack(): idempotent singleton; shared + private PGlite
│           ├── todos.ts      # PGlite CRUD (shared db)
│           ├── notebooks.ts  # notebook CRUD (private db)
│           ├── views.ts      # saved-view CRUD (private db)
│           ├── analytics.ts  # federated aggregates + read-only query runner
│           └── boot.ts       # standalone smoke test
└── apps/
    └── web/                  # Next.js App Router + shadcn/ui
        ├── instrumentation.ts
        ├── next.config.ts
        └── src/
            ├── app/api/{todos,analytics,query,notebooks,views}/…   # route handlers
            └── components/
                ├── dashboard.tsx           # Home · Editor · Analytics tabs
                ├── home-view.tsx           # todos + saved data-view cards
                ├── notebook-editor.tsx     # Monaco notebook (cells → results)
                ├── analytics-view.tsx      # stat cards + peer-activity placeholder
                ├── data-table.tsx          # reusable TanStack results table
                └── monaco-sql.tsx          # themed Monaco SQL editor
```

## Prerequisites

- [Node.js](https://nodejs.org) 20+ (tested on 26)
- [pnpm](https://pnpm.io) 10+

The workspace uses `node-linker=hoisted` (see `.npmrc`) so DuckDB's prebuilt native
binary resolves correctly.

## Install

```bash
pnpm install
```

This downloads DuckDB's native binary via its postinstall step.

## Quick start

Open two terminals.

**Terminal 1 — Instance A** (UI on :3000, PG wire :5432, quack :9494)
```bash
pnpm dev:a
```

**Terminal 2 — Instance B** (UI on :3001, PG wire :5433, quack :9495)
```bash
pnpm dev:b
```

Then open both:

- Instance A → **http://localhost:3000**
- Instance B → **http://localhost:3001**

> Use `localhost`, not `127.0.0.1`. (Both are configured via `allowedDevOrigins`, but
> `localhost` is the default and avoids any cross-origin dev-resource issues.)

Each UI has three tabs:

- **Home** — create / toggle / delete this instance's todos, plus **custom data views**:
  named saved `SELECT` queries, each rendered as a data table that runs on demand.
- **Editor** — a **notebook** of cells. Each cell is a Monaco SQL editor; running it
  shows results in a paginated [TanStack](https://tanstack.com/table) data table. A cell
  can be pinned to Home as a saved view. Notebooks persist in the private PGlite DB.
- **Analytics** — live local-vs-peer aggregate cards (polls every 2s; shows
  `peer connected` / `offline` and auto-reconnects) plus a placeholder for peer query
  activity (pending the **birdshot** extension).

Run queries across `main.todos` (local) and `peer_db.main.todos` (peer, over quack) from
the Editor.

Data persists across restarts in `./pgdata-a` / `./pgdata-b` (shared) and
`./pgdata-a-private` / `./pgdata-b-private` (notebooks + views). Starting A before B is
fine — analytics shows the peer offline until B is up, then reconnects.

## API reference

All routes run on the Node runtime and read live data.

| Method & path        | Description                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `GET /api/todos`     | List todos.                                                       |
| `POST /api/todos`    | Create. Body `{ "title": string }`.                              |
| `GET /api/todos/:id` | Get one (404 if missing).                                         |
| `PATCH /api/todos/:id` | Update. Body `{ "title"?: string, "done"?: boolean }`.         |
| `DELETE /api/todos/:id` | Delete (204).                                                  |
| `GET /api/analytics` | Cross-instance aggregate: `{ peer_connected, local, peer }`.      |
| `POST /api/query`    | Run read-only DuckDB SQL. Body `{ "sql": string }`. Only a single `SELECT` / `WITH` statement is allowed. |
| `GET/POST /api/notebooks`, `GET/PUT/DELETE /api/notebooks/:id` | Notebook CRUD (private DB). |
| `GET/POST /api/views`, `DELETE /api/views/:id` | Saved-view CRUD (private DB). |

## Configuration

The `dev:a` / `dev:b` scripts set these via env vars.

| Variable           | A          | B          | Description                                   |
| ------------------ | ---------- | ---------- | --------------------------------------------- |
| `PORT`             | 3000       | 3001       | Next.js HTTP port                             |
| `NEXT_DIST_DIR`    | .next-a    | .next-b    | Per-instance build dir (so both can run)      |
| `INSTANCE`         | A          | B          | Display label                                 |
| `DATA_DIR`         | ../../pgdata-a | ../../pgdata-b | PGlite data dir (relative to `apps/web`) |
| `PG_PORT`          | 5432       | 5433       | PGlite → DuckDB wire port                     |
| `QUACK_PORT`       | 9494       | 9495       | This instance's quack endpoint                |
| `QUACK_TOKEN`      | token-a    | token-b    | Auth token for this quack endpoint (≥4 chars) |
| `PEER_QUACK_PORT`  | 9495       | 9494       | Peer's quack port                             |
| `PEER_QUACK_TOKEN` | token-b    | token-a    | Auth token for the peer's quack endpoint      |

## How the stack initializes

`packages/db/src/stack.ts` exposes `getStack()`, which caches its init **promise** on
`globalThis`. This makes initialization idempotent and safe across Next.js dev
hot-reloads and its separate module registries, and doubles as the guard against
double-binding the PG-wire / quack ports. `instrumentation.ts` calls it at server boot
(so the quack endpoint is up early for the peer); every route handler also calls it, so
no route depends on instrumentation having run.

Verify the stack boots without the web layer:

```bash
DATA_DIR=./pgdata-test PG_PORT=5440 QUACK_PORT=9490 QUACK_TOKEN=token-test pnpm db:boot
```

## Extending

**New table:** add the `CREATE TABLE IF NOT EXISTS` in `initStack()`, add a matching
`CREATE OR REPLACE VIEW` so quack peers see it, then add CRUD functions in `todos.ts`
(or a new module) and route handlers under `apps/web/src/app/api/`.

**New analytics:** both `main.todos` (local) and `peer_db.main.todos` (peer) behave like
regular DuckDB tables — any DuckDB SQL works, including joins across both. Remember
DuckDB returns `BigInt` for `COUNT(*)`; `analytics.ts` already normalizes BigInt → Number.

## Notes

- **Read-only analytics:** `local_db` is attached `READ_ONLY`, and `/api/query` rejects
  anything that isn't a single `SELECT` / `WITH`. CRUD always goes through PGlite.
- **Turbopack:** dev uses Turbopack. If the native DuckDB module ever fights it, fall
  back to webpack with `pnpm --filter web dev:webpack`.
- **Tailwind:** `globals.css` scopes class detection to `src/**/*.{ts,tsx}` so the build
  never scans `.next-*` output or binary assets (which produces garbage utilities).
