# Cloudflare Email Service — Waddling transactional email reference

Authoritative internal reference for wiring transactional email into Waddling
(control-api). Backs Linear **ANO-56** (M0 — wire transactional email provider).

Sources are the live Cloudflare docs (`developers.cloudflare.com/email-service/`)
as of 2026-06. Email Sending is a **public beta** (GA'd to public beta 2026-04-16;
SMTP submission added 2026-06-08). Re-verify limits/pricing against the docs before
relying on specific numbers — this is a fast-moving beta.

## What it is

**Cloudflare Email Service** is one service with two features:

| Feature | Direction | Plan | Use for |
|---|---|---|---|
| **Email Sending** | Outbound transactional | **Workers Paid only** (to arbitrary recipients) | verification, password reset, org invites, billing/dunning |
| **Email Routing** | Inbound | Free + Paid | inbound mail → Worker or verified address |

Waddling needs **Email Sending**. Email Routing is only relevant if/when we want
inbound (e.g. bounce-handling Worker, support@ inbox, reply-to-thread).

## Prerequisites (do these first)

1. **Workers Paid plan.** Sending to arbitrary customer addresses is Paid-only.
   We already run Durable Objects + Containers, so the account is Paid — but
   confirm Email Sending beta is enabled for the account.
2. **Sending domain on Cloudflare DNS.** `getwaddling.com` is already on CF
   (apex worker routes ship today), so this is satisfied.
3. **Onboard the domain** in dash → Compute → Email Service → Email Sending →
   *Onboard Domain*. Cloudflare auto-adds DNS records:
   - MX on the `cf-bounce` subdomain (bounce routing)
   - TXT **SPF** (authorize sending)
   - TXT **DKIM** (authentication)
   - TXT **DMARC** on `_dmarc.<domain>`
   Propagation is usually 5–15 min on CF DNS (up to 24h worst case).
   **DKIM and ARC signing are automatic** once onboarded — we sign nothing.

### Decision: which sender domain/subdomain

Deliverability best practice is **one domain/subdomain per email category** so a
bad reputation in one class can't poison another. The apex `getwaddling.com`
serves marketing. Recommendation: send transactional auth/billing mail from a
dedicated subdomain (e.g. `noreply@auth.getwaddling.com` or `mail.getwaddling.com`)
onboarded separately, OR at minimum a fixed `noreply@getwaddling.com` sender.
**This is an open decision for ANO-56.**

## How we send: Workers binding (recommended for control-api)

control-api is a Worker, so use the **`send_email` binding** — no API token to
manage, lowest latency, native.

### wrangler config (control-api)

```jsonc
// apps/control-api/wrangler.jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      // Restrict the sender so the binding can only send as our noreply.
      "allowed_sender_addresses": ["noreply@getwaddling.com"],
      // Call the REAL Email Service API during `wrangler dev` (remote binding).
      // Email Sending is CF-only, so local simulation can't send — see Local dev.
      "remote": true
    }
  ]
}
```

Binding restriction attributes (pick per binding):
- *(none)* — send to any **verified destination address** in the account only.
- `destination_address` — locked to one recipient (good for internal alerts).
- `allowed_destination_addresses` — recipient allowlist.
- `allowed_sender_addresses` — **sender** allowlist (what we want: lock the `from`).

> Sending to **arbitrary** customer recipients (what transactional needs) works
> once the domain is onboarded + Paid plan; the `allowed_sender_addresses`
> restriction constrains the `from`, not the `to`.

### Type + call (TypeScript)

```ts
interface SendEmail {
  send(message: EmailMessageBuilder): Promise<{ messageId: string }>;
}
interface EmailAddress { email: string; name?: string }
interface EmailMessageBuilder {
  to: string | EmailAddress | (string | EmailAddress)[]; // to+cc+bcc ≤ 50 total
  from: string | EmailAddress;
  subject: string;
  html?: string;
  text?: string;            // always include a text part (deliverability)
  cc?:  string | EmailAddress | (string | EmailAddress)[];
  bcc?: string | EmailAddress | (string | EmailAddress)[];
  replyTo?: string | EmailAddress;
  attachments?: Attachment[]; // total message ≤ 5 MiB
  headers?: Record<string, string>;
}
// env.EMAIL: SendEmail
const { messageId } = await env.EMAIL.send({
  to: { email: user.email, name: user.name },
  from: { email: "noreply@getwaddling.com", name: "Waddling" },
  replyTo: "support@getwaddling.com",
  subject: "Verify your email",
  html, text,
});
// Errors throw a standard Error with a `.code` property:
// try { await env.EMAIL.send(...) } catch (e) { log(e.code, e.message) }
```

## Better Auth integration points

All four call sites funnel through one `sendEmail()` wrapper over `env.EMAIL.send()`:

| Hook | Plugin | Triggers |
|---|---|---|
| `emailVerification.sendVerificationEmail` | core | signup verification |
| `emailAndPassword.sendResetPassword` | core | password reset |
| `organization.sendInvitationEmail` | organization (M4) | member invites — **blocks ANO-79** |
| (custom) on Stripe `invoice.payment_failed` | stripe (M2) | dunning / low-balance |

Note for workerd: the `EMAIL` binding comes off `env` per-request — fine. Do NOT
cache it on a module global (same rule as the Hyperdrive/Better-Auth no-cached-pool
gotcha). For fire-and-forget non-critical sends, wrap in `ctx.waitUntil()`.

## Alternative send paths (not our primary)

- **REST API** — `POST /accounts/{account_id}/email/sending/send`, header
  `Authorization: Bearer <API_TOKEN>` (token needs email-send permission). JSON body
  uses snake_case (`reply_to`). Official SDKs: Node, Python, Go. Use from non-Worker
  backends or CI. We don't need this while sending from control-api.
- **SMTP** (beta) — `smtp.mx.cloudflare.net:465` implicit TLS, AUTH PLAIN/LOGIN,
  username `api_token`, password = a CF API token with **Email Sending: Edit**.
  For Nodemailer/`smtplib`/PHPMailer/JavaMail. Same pipeline (DKIM/ARC, limits, logs).

All three paths share the same delivery pipeline, limits, and dashboard logs.

## Limits & pricing (verify before relying)

- **Recipients**: `to` + `cc` + `bcc` ≤ **50** combined per message.
- **Message size**: ≤ **5 MiB** total incl. base64 attachments.
- **Pricing**: **3,000 emails/month included** on Workers Paid, then **$0.35 per
  1,000**. Per account, per month, aligned to the CF billing cycle.
- Sends to **verified destination addresses** are **free** and don't count toward
  quota (only useful for internal alerts, not customer mail).
- Emails **rejected at the API boundary** (incl. suppression-list blocks) **do not
  count** toward quota. Accepted + hard-bounced emails **do** count.
- (Inbound, for reference: 25 MiB message, 200 routing rules/domain, 200 destination
  addresses/account.)

## Deliverability — handled for us, but watch the metrics

Cloudflare auto-manages IP reputation, DKIM/SPF/DMARC alignment, ISP complaint
feedback, and the suppression list:
- **Hard bounce** (no such user/domain, permanent block, spam-rejected): never
  retried; sender gets a bounce notification; address **auto-added to the
  suppression list**.
- **Soft bounce** (mailbox full, temp down, greylist): auto-retried with
  exponential backoff.
- A send to a suppressed address returns **Rejected** at the API boundary (doesn't
  count toward quota). We can also proactively check suppression before sending.

Reputation targets to stay healthy: **delivery > 95%, hard-bounce < 2%,
complaint < 0.1%.** For any bulk-ish mail, set `List-Unsubscribe` +
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (Gmail/Yahoo bulk
sender requirement). Always send both `html` and `text`.

## Observability

- **Activity log** (dashboard, 30 min – 30 day window). Outbound statuses:
  **Sent** (queued) · **Delivered** · **Delivery failed** (bounce) · **Rejected**
  (suppressed) · **Failed** (config/auth error).
- **GraphQL Analytics**: `emailSendingAdaptive` (+ `emailRoutingAdaptive`) datasets
  for programmatic metrics — wire into our existing dashboards (M5/observability).
- ⚠️ **Gotcha**: emails sent from a Worker via `send_email` appear in the Email
  **Routing** summary as **"dropped"** even when delivered fine. **Ignore that
  panel** — track outbound success via Email **Sending** metrics/logs only.

## Local development

- Set `"remote": true` on the binding so `wrangler dev` calls the real Email
  Service API and actually delivers (matches our wrangler-dev-not-deploy loop).
- Known limitation: with a non-remote (local-sim) binding, `ArrayBuffer`/
  `ArrayBufferView` attachment content can't be serialized. Auth emails are
  HTML/text only, so this won't bite us until we add binary attachments.

## ANO-56 implementation checklist

- [ ] Confirm account on Workers Paid + Email Sending beta enabled.
- [ ] Decide sender domain/subdomain; onboard it (SPF/DKIM/DMARC auto-added).
- [ ] Add `send_email` binding (`EMAIL`, `allowed_sender_addresses`, `remote:true`)
      to `apps/control-api/wrangler.jsonc`.
- [ ] Implement `sendEmail()` wrapper over `env.EMAIL.send()` (html+text, replyTo,
      `.code` error handling, `ctx.waitUntil` for non-critical).
- [ ] Wire Better Auth `sendVerificationEmail` + `sendResetPassword`.
- [ ] Author templates: verify, reset, **invitation** (unblocks ANO-79), dunning.
- [ ] Verify a real send end-to-end via `wrangler dev` (remote binding).
- [ ] Add a suppression-aware preflight + surface Email Sending metrics.
```
