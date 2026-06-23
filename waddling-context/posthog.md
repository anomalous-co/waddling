# PostHog Implementation Reference

## 1. posthog-js in Next.js App Router

**Packages:** `posthog-js@latest`, `@posthog/next@latest`

**Environment Variables:**
```env
NEXT_PUBLIC_POSTHOG_KEY=phc_your_key_here
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com  # or https://eu.i.posthog.com for EU
```

**Initialization (Recommended: Provider Component):**
```tsx
// app/_providers.tsx or instrumentation-client.ts (Next.js 16+)
import { PostHogProvider, PostHogPageView } from '@posthog/next'

export function PostHogSetup({ children }: { children: React.ReactNode }) {
  return (
    <PostHogProvider
      apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY}
      clientOptions={{
        api_host: '/ingest',  // reverse proxy: next.config.js rewrites /ingest → PostHog
        capture_pageview: 'history_change',
        persistence: 'localStorage+cookie',
        session_recording: { recordCrossOriginIframes: true },
      }}
    >
      <PostHogPageView />
      {children}
    </PostHogProvider>
  )
}
```

**next.config.ts (Reverse Proxy for Ad-Blockers):**
```typescript
const nextConfig = {
  rewrites: async () => ({
    beforeFiles: [
      {
        source: '/ingest/:path*',
        destination: `${process.env.NEXT_PUBLIC_POSTHOG_HOST}/ingest/:path*`,
      },
    ],
  }),
}
export default nextConfig
```

---

## 2. posthog-node: Server & CLI Processes

**Packages:** `posthog-node@latest` (included in `posthog-js` monorepo)

**Long-Running Service (Node MCP Server):**
```typescript
import { PostHog } from 'posthog-node'

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: 'https://us.i.posthog.com',
  flushAt: 20,           // batch size
  flushInterval: 10000,  // ms; critical for servers
})

posthog.capture({
  distinctId: userId,
  event: 'tool_executed',
  properties: { tool_name: 'query_db', duration_ms: 150 },
})

// On server shutdown/SIGTERM:
process.on('SIGTERM', async () => {
  await posthog.shutdown()
  process.exit(0)
})
```

**Short-Lived CLI Processes:**
```typescript
import { PostHog } from 'posthog-node'

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  flushAt: 5,          // small batch for CLI
  flushInterval: 5000, // shorter interval
})

// ... capture events ...

// CRITICAL: flush before exit (blocks until sent or timeout)
await posthog.shutdown()
process.exit(0)
```

---

## 3. Identity Stitching: Anonymous → Registered

**Anonymous Device ID (Persisted):**
```typescript
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

function getOrCreateDeviceId(): string {
  const deviceFile = path.join(process.env.HOME!, '.waddling', 'device.json')
  try {
    const data = JSON.parse(fs.readFileSync(deviceFile, 'utf-8'))
    return data.device_id
  } catch {
    const deviceId = randomUUID()
    fs.mkdirSync(path.dirname(deviceFile), { recursive: true })
    fs.writeFileSync(deviceFile, JSON.stringify({ device_id: deviceId }))
    return deviceId
  }
}

const anonymousId = getOrCreateDeviceId()
posthog.capture({ distinctId: anonymousId, event: 'app_started' })
```

**Signup: Link Anonymous → User ID:**
```typescript
// At signup: alias(anonymousId, userId) then identify
posthog.alias({
  distinctId: anonymousId,
  alias: userId, // e.g., user_id from DB
})

posthog.identify({
  distinctId: userId,
  properties: {
    email: userEmail,
    plan: 'free',
    $set: { signup_date: new Date().toISOString() },
    $set_once: { first_signup: true },
  },
})
```

**Group Analytics (Organization-Level):**
```typescript
posthog.groupIdentify({
  groupType: 'organization',
  groupKey: orgId,
  properties: { name: 'Acme Corp', industry: 'tech', employees: 50 },
})

// Capture with group context:
posthog.capture({
  distinctId: userId,
  event: 'query_executed',
  properties: { query_type: 'SELECT' },
  groups: { organization: orgId },
})
```

---

## 4. Server-Side Capture from Next.js Route Handlers

**Shared Singleton PostHog Client:**
```typescript
// lib/posthog-server.ts
import { PostHog } from 'posthog-node'

let posthogInstance: PostHog | null = null

export function getPostHogServer(): PostHog {
  if (!posthogInstance) {
    posthogInstance = new PostHog(process.env.POSTHOG_API_KEY!, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushInterval: 15000,
    })
  }
  return posthogInstance
}
```

**Route Handler Usage:**
```typescript
// app/api/execute-query/route.ts
import { getPostHogServer } from '@/lib/posthog-server'

export async function POST(req: Request) {
  const posthog = getPostHogServer()
  const { userId, query } = await req.json()

  posthog.capture({
    distinctId: userId,
    event: 'api_query_executed',
    properties: { query_type: 'SELECT', status: 'success' },
  })

  return Response.json({ ok: true })
}
```

**Also supported in App Router:**
```typescript
import { getPostHog } from '@posthog/next'

export default async function Page() {
  const posthog = await getPostHog()
  const flags = await posthog.getAllFlags()
  posthog.capture({ event: 'page_loaded' })
  return <div>...</div>
}
```

---

## 5. Feature Flags & Funnel Patterns

**Feature Flag Checks (Client & Server):**
```typescript
// Client:
import { usePostHog } from 'posthog-js/react'

export function UpgradePrompt() {
  const posthog = usePostHog()
  const showUpgrade = posthog.isFeatureEnabled('new-pricing')
  return showUpgrade ? <NewPricingUI /> : <LegacyPricingUI />
}

// Server:
const posthog = await getPostHog()
const showNewDash = await posthog.getFeatureFlagResult('new-dashboard')?.enabled
```

**Funnel Tracking ($set, $set_once):**
```typescript
posthog.identify({
  distinctId: userId,
  properties: {
    $set: { last_active: new Date().toISOString(), plan: 'pro' },
    $set_once: { signup_source: 'organic' }, // only set if not exists
  },
})

posthog.capture({
  distinctId: userId,
  event: 'upgrade_initiated',
  properties: { from_plan: 'free', to_plan: 'pro' },
})
```

---

## 6. Privacy & Opt-Out

**Environment Variable Pattern:**
```typescript
// .env.local
WADDLING_TELEMETRY=0  # disables all tracking

function shouldTrack(): boolean {
  return process.env.WADDLING_TELEMETRY !== '0'
}

if (shouldTrack()) {
  posthog.capture({
    distinctId: userId,
    event: 'user_action',
    properties: { /* ... */ },
  })
}
```

**What NOT to Capture:**
- SQL query text (capture query_type: 'SELECT|INSERT|UPDATE|DELETE' instead)
- PII: passwords, email addresses, SSNs (capture anonymized user_id + email domain only)
- API keys, tokens, connection strings

**Client-Side Opt-In/Out:**
```typescript
const posthog = usePostHog()
posthog.optOut()  // stops tracking, persists
posthog.optIn()   // resumes tracking
```

---

## Package Versions & Setup

| Package | Version | Use |
|---------|---------|-----|
| `posthog-js` | ^1.393.0 | Browser capture + Next.js integration |
| `@posthog/next` | ^0.5.0 | Next.js App Router setup, `PostHogProvider` |
| `posthog-node` | ^5.38.3 | Server-side & CLI capture (CommonJS/ESM) |

**Install:**
```bash
npm install posthog-js @posthog/next posthog-node
```

---

**Summary:** posthog-js handles client/App Router (env vars, provider setup, pageview auto-capture, reverse proxy /ingest); posthog-node powers server routes & CLI tools (flushAt/flushInterval, shutdown() before exit); identity stitching via uuid-persisted device.json → alias → identify; server capture via singleton client; feature flags via isFeatureEnabled; privacy via WADDLING_TELEMETRY=0 env check + avoid SQL/PII in events.
