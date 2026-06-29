/**
 * Transactional email — one wrapper over the Cloudflare Email Service `send_email`
 * binding (env.EMAIL), plus the auth/billing templates. See docs/cloudflare-email-service.md
 * and ANO-56.
 *
 * The binding comes off `env` per-request (never cache it on a module global — same
 * no-cached-binding rule as Hyperdrive/Better-Auth on workerd). A send failure NEVER
 * throws: callers are auth hooks where a thrown mailer would fail sign-in/sign-up, so we
 * log `.code` + message and return false. If the binding is absent (unconfigured deploy /
 * local sim) we no-op + log so the flow still completes.
 */
import type { Env, EmailMessage } from './env';

const FROM = { email: 'noreply@getwaddling.com', name: 'Waddling' } as const;
const REPLY_TO = 'support@getwaddling.com';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Send one transactional email. Returns true on accept, false on any failure (logged). */
export async function sendEmail(
  env: Env,
  to: string | { email: string; name?: string },
  content: EmailContent,
  replyTo: string = REPLY_TO,
): Promise<boolean> {
  // SendGrid HTTP path (Node/Cloud Run): takes priority over the CF EMAIL binding.
  if (env.SENDGRID_API_KEY) {
    const toList = Array.isArray(to) ? to : [to];
    const toAddrs = toList.map((a) => (typeof a === 'string' ? { email: a } : a));
    const sgBody = {
      personalizations: [{ to: toAddrs }],
      from: FROM,
      reply_to: { email: replyTo },
      subject: content.subject,
      content: [
        { type: 'text/html', value: content.html },
        { type: 'text/plain', value: content.text },
      ],
    };
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        },
        body: JSON.stringify(sgBody),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.log(
          `[email] sendgrid ${res.status} "${content.subject}": ${detail.slice(0, 200)}`,
        );
        return false;
      }
      return true;
    } catch (e) {
      console.log(
        `[email] sendgrid threw "${content.subject}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  // CF email bridge (Node/Cloud Run "keep CF email"): POST to the bridge Worker that holds the
  // Cloudflare send_email binding. This is how transactional mail still goes through Cloudflare
  // after the GCP cutover; it takes priority over the (Node-absent) EMAIL binding below.
  if (env.CF_EMAIL_BRIDGE_URL && env.CF_EMAIL_BRIDGE_TOKEN) {
    try {
      const res = await fetch(`${env.CF_EMAIL_BRIDGE_URL.replace(/\/$/, '')}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_EMAIL_BRIDGE_TOKEN}` },
        body: JSON.stringify({ to, from: FROM, replyTo, subject: content.subject, html: content.html, text: content.text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.log(`[email] bridge ${res.status} "${content.subject}": ${detail.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (e) {
      console.log(`[email] bridge threw "${content.subject}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  if (!env.EMAIL) {
    console.log(`[email] EMAIL binding unset — skipped "${content.subject}"`);
    return false;
  }
  const message: EmailMessage = {
    to,
    from: FROM,
    replyTo,
    subject: content.subject,
    html: content.html,
    text: content.text,
  };
  try {
    await env.EMAIL.send(message);
    return true;
  } catch (e) {
    const code =
      e && typeof e === 'object' && 'code' in e ? (e as { code?: unknown }).code : undefined;
    console.log(
      `[email] send failed (${code ?? 'no-code'}) "${content.subject}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

// ── Templates ──────────────────────────────────────────────────────────────────────
// Minimal, dependency-free html + text. Keep both parts (deliverability).

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin-bottom:24px">Waddling</div>
    <div style="background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:28px">
      <h1 style="font-size:18px;margin:0 0 12px">${heading}</h1>
      ${bodyHtml}
    </div>
    <div style="color:#8a9099;font-size:12px;margin-top:20px">Waddling — governed data access for AI agents.</div>
  </div>
</body></html>`;
}

function button(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0">${label}</a>`;
}

const greeting = (name?: string) => (name ? `Hi ${name},` : 'Hi,');

export function verificationEmail(url: string, name?: string): EmailContent {
  return {
    subject: 'Verify your email',
    html: layout(
      'Verify your email',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">${greeting(name)} confirm your email address to start using Waddling.</p>
       <p style="margin:8px 0">${button(url, 'Verify email')}</p>
       <p style="margin:8px 0 0;font-size:12px;color:#8a9099;line-height:1.5">Or paste this link: ${url}</p>`,
    ),
    text: `${greeting(name)}\n\nConfirm your email address to start using Waddling:\n${url}\n`,
  };
}

export function resetPasswordEmail(url: string, name?: string): EmailContent {
  return {
    subject: 'Reset your password',
    html: layout(
      'Reset your password',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">${greeting(name)} we received a request to reset your Waddling password. This link expires shortly.</p>
       <p style="margin:8px 0">${button(url, 'Reset password')}</p>
       <p style="margin:8px 0 0;font-size:12px;color:#8a9099;line-height:1.5">If you didn't request this, you can ignore this email. Link: ${url}</p>`,
    ),
    text: `${greeting(name)}\n\nReset your Waddling password (link expires shortly):\n${url}\n\nIf you didn't request this, ignore this email.\n`,
  };
}

export function invitationEmail(args: {
  acceptUrl: string;
  orgName: string;
  role: string;
  inviterName?: string;
}): EmailContent {
  const by = args.inviterName ? `${args.inviterName} invited you` : 'You’ve been invited';
  return {
    subject: `You're invited to ${args.orgName} on Waddling`,
    html: layout(
      `Join ${args.orgName}`,
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">${by} to join <strong>${args.orgName}</strong> on Waddling as ${args.role}.</p>
       <p style="margin:8px 0">${button(args.acceptUrl, 'Accept invitation')}</p>
       <p style="margin:8px 0 0;font-size:12px;color:#8a9099;line-height:1.5">Link: ${args.acceptUrl}</p>`,
    ),
    text: `${by} to join ${args.orgName} on Waddling as ${args.role}.\n\nAccept: ${args.acceptUrl}\n`,
  };
}

export function paymentFailedEmail(args: { name?: string; manageUrl?: string }): EmailContent {
  const cta = args.manageUrl
    ? `<p style="margin:8px 0">${button(args.manageUrl, 'Update payment method')}</p>`
    : '';
  return {
    subject: 'Your Waddling payment failed',
    html: layout(
      'Payment failed',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">${greeting(args.name)} a payment for your Waddling subscription didn't go through. Please update your payment method to avoid interruption.</p>
       ${cta}`,
    ),
    text: `${greeting(args.name)}\n\nA payment for your Waddling subscription didn't go through. Update your payment method to avoid interruption.${args.manageUrl ? `\n${args.manageUrl}` : ''}\n`,
  };
}
