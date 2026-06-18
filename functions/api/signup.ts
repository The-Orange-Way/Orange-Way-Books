/**
 * Cloudflare Pages Function — signup endpoint for OrangeWayBooks.
 * Sends transactional confirmation via Resend; later will also POST to GoHighLevel.
 *
 * Routed by the `form` field in the POST body:
 *   - "waitlist": OrangeWayBooks marketing waitlist
 *   - "demo":     Demo request for the bookkeeping product
 *
 * Env vars required (set on the orangewaybooks-dev + orangewaybooks-prod CF Pages projects):
 *   RESEND_API_KEY_OW   — Resend API key, scoped to send.orangeway.app
 */

interface Env {
  RESEND_API_KEY_OW: string;
}

type FormType = "waitlist" | "demo";

interface SignupBody {
  form: FormType;
  email: string;
  company?: string;
  role?: string;
}

const FROM_NAME = "OrangeWay Books";
const FROM_ADDR = "support@send.orangeway.app";   // verified Resend sending domain
const REPLY_TO  = "support@orangeway.app";        // alias on the Google Workspace account

const COPY: Record<FormType, { subject: string; html: (body: SignupBody) => string }> = {
  waitlist: {
    subject: "You're on the OrangeWayBooks waitlist",
    html: (_b) => `
<p>Thanks for joining the OrangeWayBooks waitlist.</p>
<p>OrangeWayBooks is privacy-first accounting and bookkeeping for businesses that hold Bitcoin. Built so the operator never sees your books in plaintext.</p>
<p>We'll email you before launch.</p>
<p>The code is open source: <a href="https://github.com/bitcoin-zka">github.com/bitcoin-zka</a>. Don't trust. Verify.</p>
<p>— OrangeWayBooks</p>`,
  },
  demo: {
    subject: "Demo request received — OrangeWayBooks",
    html: (b) => `
<p>Thanks for requesting a demo of OrangeWayBooks${b.company ? ` for ${escapeHtml(b.company)}` : ""}.</p>
<p>We'll reach out within 1-2 business days to schedule a walkthrough. Reply directly to this email if you want to share more context first.</p>
<p>— OrangeWayBooks</p>`,
  },
};

function emailValid(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c] as string);
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: SignupBody;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!emailValid(body.email)) return json({ error: "invalid email" }, 400);
  if (body.form !== "waitlist" && body.form !== "demo") return json({ error: "invalid form" }, 400);

  const copy = COPY[body.form];
  const apiKey = ctx.env.RESEND_API_KEY_OW;
  if (!apiKey) return json({ error: "server not configured" }, 500);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_ADDR}>`,
      to: [body.email],
      reply_to: REPLY_TO,
      subject: copy.subject,
      html: copy.html(body),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: "send failed", detail: detail.slice(0, 200) }, 502);
  }

  return json({ ok: true }, 200);
};

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
