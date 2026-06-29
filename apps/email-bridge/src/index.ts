// CF email bridge. The GCP control-api can't hold a Cloudflare send_email binding, but the product
// keeps using Cloudflare Email Sending for transactional mail. This tiny Worker IS that binding: the
// control-api POSTs /send (shared-secret auth) and the Worker delivers via env.EMAIL.send(). It is the
// one piece deliberately left on Cloudflare after the GCP cutover.
import { EmailMessage } from 'cloudflare:email';

interface Env {
  EMAIL: { send(msg: EmailMessage): Promise<void> };
  BRIDGE_SECRET: string;
}

interface SendBody {
  to: string | { email: string; name?: string };
  from?: { email: string; name?: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

const DEFAULT_FROM = { email: 'noreply@getwaddling.com', name: 'Waddling' };

// Build a multipart/alternative MIME message (text + html). Subjects/bodies are RFC 2047 / quoted
// where needed; our transactional content is simple, so we keep ASCII headers and UTF-8 bodies.
function buildMime(from: { email: string; name?: string }, toAddr: string, replyTo: string | undefined, subject: string, html: string, text: string): string {
  const boundary = `bnd_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
  const fromDomain = from.email.split('@')[1] ?? 'getwaddling.com';
  const lines = [
    `From: ${fromHeader}`,
    `To: ${toAddr}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${fromDomain}>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    html,
    `--${boundary}--`,
    ``,
  ];
  return lines.join('\r\n');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
      return Response.json({ ok: true, service: 'email-bridge' });
    }
    if (req.method !== 'POST' || url.pathname !== '/send') {
      return new Response('not found', { status: 404 });
    }
    // Shared-secret auth (Cloud Run → Worker; the secret is held both sides).
    const auth = req.headers.get('authorization') ?? '';
    if (!env.BRIDGE_SECRET || auth !== `Bearer ${env.BRIDGE_SECRET}`) {
      return new Response('unauthorized', { status: 401 });
    }
    let body: SendBody;
    try {
      body = (await req.json()) as SendBody;
    } catch {
      return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
    }
    const from = body.from ?? DEFAULT_FROM;
    const toAddr = typeof body.to === 'string' ? body.to : body.to.email;
    if (!toAddr || !body.subject) return Response.json({ ok: false, error: 'missing to/subject' }, { status: 400 });

    const raw = buildMime(from, toAddr, body.replyTo, body.subject, body.html, body.text);
    try {
      const msg = new EmailMessage(from.email, toAddr, raw);
      await env.EMAIL.send(msg);
      return Response.json({ ok: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.log(`[email-bridge] send failed "${body.subject}" → ${toAddr}: ${detail}`);
      return Response.json({ ok: false, error: detail }, { status: 502 });
    }
  },
};
