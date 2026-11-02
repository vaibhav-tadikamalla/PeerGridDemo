# PeerGrid

[![CI](https://github.com/vaibhav-tadikamalla/peergrid-realtime-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/vaibhav-tadikamalla/peergrid-realtime-workspace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Yjs](https://img.shields.io/badge/Yjs-13.6-orange)](https://yjs.dev/)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](docker-compose.yml)

**Real-time collaborative workspace built with CRDTs, WebSockets, and folder-level RBAC.**

🚀 **[Live demo](https://peergriddemo-web-mah6.onrender.com/)** — hosted on Render's free tier; may take ~30 seconds to wake up from idle.

PeerGrid lets multiple users create folders, manage files, and simultaneously edit rich-text documents with zero conflicts. Every edit is resolved automatically using **Conflict-free Replicated Data Types** (Yjs), making merges mathematically correct regardless of network conditions or edit order.

---

## Highlights

- **CRDT sync with Yjs** — conflict-free rich-text editing; server applies, persists, and broadcasts Yjs binary updates over WebSocket.
- **Folder-level RBAC enforced on REST and WebSocket** — owner / editor / viewer roles checked at every API endpoint and inside `handleSyncMessage()`.
- **Measured P99 8.44 ms at 40 editors** on loopback (single-node; see Performance section below).

---

## Performance

### Propagation latency by editor count (loopback, ms, best of N valid runs)

| Users | N | P50    | P95    | P99    | Max     |
|------:|--:|-------:|-------:|-------:|--------:|
|     2 | 2 |   1.85 |   2.24 |   2.30 |    2.31 |
|     5 | 1 |   2.29 |   3.29 |   3.69 |    4.18 |
|    10 | 2 |   1.93 |   2.71 |   3.27 |    4.98 |
|    20 | 1 |   2.36 |   3.29 |   3.88 |    6.43 |
|    40 | 1 |   3.73 |   6.38 |   8.44 |   42.96 |
|    80 | 3 |  12.94 |  60.56 | 114.10 |  321.31 |
|   120 | 4 | 224.75 | 555.33 | 739.77 | 1024.40 |

Measured with `benchmark-cli.mjs` on loopback; single-node limit appears between 40 and 80 editors.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BROWSER (React 18)                          │
│                                                                      │
│   ┌──────────┐   ┌───────────────┐   ┌──────────────────────────┐   │
│   │  Auth UI │   │ Workspace UI  │   │   TipTap Rich-Text       │   │
│   │ (Login)  │   │ (Sidebar,     │   │   Editor + Toolbar       │   │
│   │          │   │  Permissions, │   │                          │   │
│   │          │   │  Activity)    │   │  ┌────────────────────┐  │   │
│   └──────────┘   └───────────────┘   │  │  Y.Doc (local)     │  │   │
│                                      │  │  — instant edits   │  │   │
│                                      │  └─────────┬──────────┘  │   │
│                                      └────────────┼─────────────┘   │
│                                                   │                  │
└───────────────────────────────────────────────────┼──────────────────┘
                      REST  /api/*                  │  WebSocket  /ws
                           │                        │
┌──────────────────────────┼────────────────────────┼──────────────────┐
│                     NGINX (reverse proxy, static serve)              │
│                          │                        │                  │
└──────────────────────────┼────────────────────────┼──────────────────┘
                           │                        │
┌──────────────────────────┼────────────────────────┼──────────────────┐
│                   FASTIFY SERVER (:3001)           │                  │
│                          │                        │                  │
│   ┌──────────────────────▼───┐   ┌────────────────▼───────────────┐  │
│   │   REST API Layer         │   │  Collaboration Server (ws)     │  │
│   │                          │   │                                │  │
│   │  • Auth (JWT RS256)      │   │  Per-file Y.Doc rooms          │  │
│   │  • Folders CRUD          │   │  • Sync protocol               │  │
│   │  • Files CRUD + Trash    │   │  • Awareness (cursors)         │  │
│   │  • Permissions (RBAC)    │   │  • Role-gated writes           │  │
│   │  • Activity logs         │   │  • Auto-save every 5s          │  │
│   │  • Search (FTS + ILIKE)  │   │  • Edit session tracking       │  │
│   │  • Rate limiting         │   │  • In-memory edit batching     │  │
│   └──────────────────────────┘   └────────────────────────────────┘  │
│                          │                        │                  │
│                          └────────────┬───────────┘                  │
│                                       │                              │
│                              ┌────────▼────────┐                     │
│                              │   PostgreSQL    │                     │
│                              │                 │                     │
│                              │  users          │                     │
│                              │  folders        │                     │
│                              │  folder_perms   │                     │
│                              │  files (BYTEA)  │                     │
│                              │  edit_sessions  │                     │
│                              │  activity_logs  │                     │
│                              └─────────────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer       | Technology                                                                 |
|-------------|----------------------------------------------------------------------------|
| **Frontend**    | React 18, TypeScript, Vite 5, Tailwind CSS, Framer Motion              |
| **Editor**      | TipTap (ProseMirror) with Yjs collaboration extensions                 |
| **CRDT**        | Yjs 13.6 with y-protocols (sync + awareness) and lib0 encoding        |
| **HTTP Server** | Fastify 4 with rate-limit, cookie, CORS plugins                       |
| **WebSocket**   | ws 8.16 in `noServer` mode, attached to Fastify's HTTP server         |
| **Auth**        | JWT RS256 (jose), bcrypt password hashing, httpOnly refresh cookies    |
| **Database**    | PostgreSQL 16 — Yjs state stored as `BYTEA`, full-text search via GIN |
| **Proxy**       | Nginx (in Docker) — serves static build, proxies `/api` and `/ws`     |
| **Logging**     | Pino (structured JSON in prod, pretty-print in dev)                   |
| **Validation**  | Zod schemas on every endpoint                                         |

---

## How Collaboration Works

### CRDTs — Conflict-Free Replicated Data Types

Traditional approaches (Operational Transformation) require a central server to order operations and apply complex transform functions. CRDTs solve this differently:

1. **Every character gets a unique ID** — based on a logical clock and client ID.
2. **Merge is commutative and idempotent** — the same result regardless of operation order.
3. **No coordination needed** — clients can edit offline and sync later.

PeerGrid uses **Yjs**, the most mature CRDT library for rich text. The flow:

```
Client A edits → Y.Doc update (binary) → WebSocket → Server Y.Doc → broadcast → Client B
                                                         │
                                                    PostgreSQL
                                                   (ydoc_state BYTEA)
```

- **SyncStep1/SyncStep2** — on connect, the server and client exchange state vectors to bring each other up to date.
- **Awareness** — cursor positions, user names, and colors are broadcast to all peers in the room via the awareness protocol.
- **Auto-save** — the server snapshots the Y.Doc state to PostgreSQL every 5 seconds (if the document is dirty).

### In-Memory Edit Batching

Instead of writing every keystroke to the database, edit counts are accumulated in an in-memory `Map<fileId::userId, count>` and flushed to the `edit_sessions` table every 5 seconds. This reduces DB write pressure by orders of magnitude.

---

## How Edit Tracking Works

1. When a user connects to a file via WebSocket and sends their first write, an **edit session** is started (`edit_sessions` table).
2. Subsequent writes increment an in-memory counter (not DB).
3. Every 5 seconds, accumulated edit counts are flushed to the DB in batch.
4. When the user's last connection to the file disconnects, the session is ended and any remaining pending edits are flushed.
5. The `/api/files/:fileId/contributors` endpoint surfaces contributor data from edit sessions.

---

## How Permission Enforcement Works

PeerGrid uses **folder-level RBAC** with three roles:

| Role       | REST API                                    | WebSocket                              |
|------------|---------------------------------------------|----------------------------------------|
| **Owner**  | Full CRUD, manage permissions, perm delete  | Read + Write                           |
| **Editor** | Create/rename/delete files, edit content    | Read + Write                           |
| **Viewer** | Read-only access                            | Read only (writes rejected at server)  |

**Enforcement points:**
- Every REST endpoint checks permissions via `workspacePermissionService` before executing.
- WebSocket `handleSyncMessage()` rejects sync updates from viewers.
- Permission revocation immediately downgrades the user's role to `'viewer'` in-memory, then disconnects their socket.
- Folder deletion force-closes all active WebSocket rooms for contained files.

---

## Data Flow

### REST API

```
Client → POST /api/auth/register    → Create account (bcrypt hash)
Client → POST /api/auth/login       → JWT access token + httpOnly refresh cookie
Client → GET  /api/folders           → List user's folders (owned + shared)
Client → POST /api/folders           → Create folder
Client → POST /api/files             → Create file in folder
Client → GET  /api/folders/:id/files → List files
Client → DELETE /api/files/:id       → Soft-delete (trash)
Client → POST /api/files/:id/restore → Restore from trash
Client → GET  /api/activity/folder/:id → Activity log
Client → GET  /api/search?q=term    → Full-text + prefix search
```

### WebSocket

```
Client → ws://server/ws              → Upgrade (noServer)
Client → { type: "auth", accessToken, fileId } → Authenticate + join room
Server → Y.Doc sync (SyncStep1)     → Full state exchange
Client → Y.Doc updates              → Server applies, broadcasts, batches metrics
Server → Awareness updates          → Cursor positions, user presence
```

---

## Folder Structure

```
PeerGrid/
├── packages/
│   ├── server/                     # Fastify API + WebSocket server
│   │   ├── src/
│   │   │   ├── auth/               # JWT (RS256), middleware, OTP utils
│   │   │   ├── db/                 # Pool, migrations (001–012)
│   │   │   ├── middleware/         # Error handler, rate limiter
│   │   │   ├── routes/             # Auth, folders, files, permissions, activity, search, health
│   │   │   ├── services/           # Business logic (file, folder, permission, edit tracking, search, activity)
│   │   │   ├── utils/              # Pino logger
│   │   │   ├── config.ts           # Zod env schema
│   │   │   ├── server.ts           # Fastify app factory
│   │   │   ├── websocket.ts        # CollaborationServer (Yjs rooms, sync, awareness)
│   │   │   └── index.ts            # Entry point — boot sequence
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── client/                     # React SPA
│   │   ├── src/
│   │   │   ├── components/         # Shared UI (ErrorBoundary, LoadingScreen, ColorPicker)
│   │   │   ├── features/
│   │   │   │   ├── auth/           # Login page
│   │   │   │   └── workspace/      # Sidebar, FileEditor, Permissions, Activity, Trash
│   │   │   ├── hooks/              # useCollaboration, useOnlineStatus, useAdaptiveThrottle
│   │   │   ├── stores/             # Zustand workspace store
│   │   │   ├── lib/                # API client (ky), auth context, utils
│   │   │   ├── App.tsx             # Router + providers
│   │   │   └── main.tsx            # React DOM entry
│   │   ├── nginx.conf              # Production reverse proxy config
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── shared/                     # Shared types & constants
│       ├── src/
│       │   ├── types.ts
│       │   ├── constants.ts
│       │   └── protocol.ts
│       └── package.json
│
├── docs/                           # Architecture, hardening, and walkthrough docs
├── observability/                  # Prometheus + Grafana configuration
├── scripts/                        # Key generation and deploy helpers
├── docker-compose.yml              # Dev infrastructure (Postgres + Prometheus + Grafana)
├── docker-compose.prod.yml         # Full production stack
├── benchmark-cli.mjs               # Standalone propagation-latency benchmark
├── .env.example                    # Dev environment template
├── .env.production.example         # Production environment template
└── package.json                    # Workspace root (pnpm monorepo)
```

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 8
- **Docker** (for PostgreSQL)

### Local Development

```bash
# 1. Clone and install
git clone https://github.com/vaibhav-tadikamalla/peergrid-realtime-workspace.git
cd peergrid-realtime-workspace
pnpm install

# 2. Generate JWT keys
node scripts/generate-keys.mjs
# Copy output into .env

# 3. Set up environment
cp .env.example .env
# Edit .env — paste JWT keys from step 2

# 4. Start PostgreSQL
docker compose up -d

# 5. Run database migrations
pnpm db:migrate

# 6. Start development servers
pnpm dev
# → Server: http://localhost:3001
# → Client: http://localhost:5173
```

### Docker Production Deployment

```bash
# 1. Configure production environment
cp .env.production.example .env.production
# Edit .env.production — set real passwords, keys, domain

# 2. Generate JWT keys (if not already done)
node scripts/generate-keys.mjs
# Copy output into .env.production

# 3. Build and start
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# The app is now available at http://localhost (or your HOST_PORT)
```

### Verify Deployment

```bash
# Health check
curl http://localhost/health

# Readiness check (includes DB connectivity)
curl http://localhost/health/ready
```

---

## Production Deployment Notes

### Security Hardening (already implemented)

| Feature                     | Implementation                                                    |
|-----------------------------|-------------------------------------------------------------------|
| **Trust proxy**             | `trustProxy: true` — respects `X-Forwarded-For`                  |
| **CORS**                    | Restricted to `APP_URL` in production                            |
| **Secure cookies**          | `httpOnly`, `secure` in production, `sameSite: lax`              |
| **Security headers**        | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy` |
| **Rate limiting**           | Global 120 req/min via `@fastify/rate-limit`                     |
| **Input validation**        | Zod schemas on every endpoint                                    |
| **SQL injection prevention**| Parameterized queries everywhere, ILIKE wildcards escaped        |
| **Password hashing**        | bcrypt with auto salt rounds                                     |
| **JWT RS256**               | Asymmetric keys — server signs, anyone can verify                |
| **WebSocket auth**          | Token verified before room join, 10 s auth timeout               |
| **Graceful shutdown**       | SIGTERM/SIGINT → flush edits → save docs → close connections → drain pool |

### Scaling Considerations

- **Current**: Single-server deployment. Y.Doc state lives in-memory per server.
- **Multi-node** (implemented, requires Redis): consistent hash ring (`consistentHash.ts`), Redis Streams for durable CRDT log (`redisStreams.ts`), Redis-backed room store with distributed locking (`RedisRoomStore.ts`), and viewport-aware presence service (`presenceService.ts`). Set `REDIS_URL` to enable.

### Resource Recommendations

| Resource   | Minimum  | Recommended       |
|------------|----------|-------------------|
| CPU        | 1 core   | 2 cores            |
| RAM        | 512 MB   | 1 GB               |
| Disk (PG)  | 1 GB     | 10 GB+             |
| Network    | —        | Low-latency (<50ms)|

---

## Known Tradeoffs

| Decision                        | Tradeoff | Rationale                                            |
|---------------------------------|----------|------------------------------------------------------|
| Y.Doc state in PostgreSQL BYTEA | Not queryable | CRDT binary state can't be SQL-queried, but it's compact and portable |
| In-memory edit batching         | Data loss window (5s) | Reduces DB writes from per-keystroke to periodic flush — acceptable for edit counts |
| Folder-level permissions only   | No per-file ACLs | Simpler mental model. Files inherit folder permissions |
| Single-process default          | No horizontal scaling without Redis | Multi-node path is implemented; set `REDIS_URL` to activate cluster mode |
| OTP returned in dev response    | Security in dev only | Production blocks OTP from response; email transport is a future integration |

---

## Future Improvements

- **Email transport** for OTP-based sharing (SendGrid / SES integration)
- **File version history** — periodic snapshots with restore capability
- **Comments & annotations** — threaded comments anchored to document positions
- **Cursor labels** — show user names next to cursor positions in the editor
- **Export** — PDF/Markdown/HTML export from rich-text content
- **Audit log dashboard** — admin view of all workspace activity
- **OAuth providers** — Google, GitHub login alongside email/password

---

## License

MIT
