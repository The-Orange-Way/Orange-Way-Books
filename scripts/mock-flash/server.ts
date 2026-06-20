/**
 * Local mock Flash Connect server. Stand it up alongside `supabase start`
 * so the rest of the Vault stack can run the full pay flow end-to-end
 * without real Flash credentials.
 *
 * Run:
 *   FLASH_WEBHOOK_SECRET=devsecret \
 *   WEBHOOK_TARGET_URL=http://localhost:54321/functions/v1/flash-webhook \
 *   deno run --allow-net --allow-env scripts/mock-flash/server.ts
 *
 * Endpoints:
 *   POST /oauth/token        — returns fake access/refresh tokens
 *   POST /payment-links      — returns { id, url, expiresAt }
 *   GET  /pay/:id            — fake checkout HTML with a "Mark as paid" form
 *   POST /pay/:id/complete   — submits the "paid" form, HMAC-signs a
 *                              payment.completed event, POSTs it to
 *                              WEBHOOK_TARGET_URL.
 *
 * On the Vault side, set:
 *   MOCK_FLASH=false                            (we want real fetches to land here)
 *   FLASH_BASE_URL=http://localhost:8787
 *   MOCK_FLASH_PUBLIC_URL=http://localhost:8787
 *   FLASH_OAUTH_TOKEN_URL=http://localhost:8787/oauth/token
 *   FLASH_CLIENT_ID=mock-client
 *   FLASH_CLIENT_SECRET=mock-secret
 *   FLASH_WEBHOOK_SECRET=devsecret
 */

const PORT = Number(Deno.env.get('PORT') ?? 8787);
const WEBHOOK_TARGET_URL =
  Deno.env.get('WEBHOOK_TARGET_URL') ?? 'http://localhost:54321/functions/v1/flash-webhook';
const SECRET = Deno.env.get('FLASH_WEBHOOK_SECRET') ?? 'devsecret';

interface Link {
  id: string;
  externalReference: string;
  amount: number;
  currency: string;
  expiresAt: string;
  status: 'pending' | 'completed';
}

const links = new Map<string, Link>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return hex(sig);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleOauthToken(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const grant = form?.get('grant_type');
  return json({
    access_token: 'mock-access-' + crypto.randomUUID(),
    refresh_token: 'mock-refresh-' + crypto.randomUUID(),
    expires_in: 3600,
    scope: 'read_write',
    grant_type_seen: grant,
  });
}

async function handlePaymentLinks(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const id = crypto.randomUUID();
  const link: Link = {
    id,
    externalReference: String(body.externalReference ?? ''),
    amount: Number(body.amount ?? 0),
    currency: String(body.currency ?? 'USD'),
    expiresAt: new Date(Date.now() + Number(body.expiresInSeconds ?? 86400) * 1000).toISOString(),
    status: 'pending',
  };
  links.set(id, link);
  return json({
    id,
    url: `http://localhost:${PORT}/pay/${id}`,
    expiresAt: link.expiresAt,
  });
}

function handleCheckoutPage(id: string): Response {
  const link = links.get(id);
  if (!link) return new Response('Not found', { status: 404 });
  const html = `<!doctype html><html><body style="font:14px system-ui;padding:32px;max-width:520px;margin:auto">
    <h1>Mock Flash checkout</h1>
    <p>Payment <code>${id}</code></p>
    <p><strong>${(link.amount / 100).toFixed(2)} ${link.currency}</strong></p>
    <p>External reference: <code>${link.externalReference}</code></p>
    <p>Status: <strong>${link.status}</strong></p>
    ${
      link.status === 'pending'
        ? `<form method="POST" action="/pay/${id}/complete">
      <button type="submit" style="padding:10px 18px;background:#16a34a;color:white;border:0;border-radius:6px;font-size:14px">Mark as paid</button>
    </form>`
        : '<p>Already paid.</p>'
    }
  </body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

async function handleCompletePost(id: string): Promise<Response> {
  const link = links.get(id);
  if (!link) return new Response('Not found', { status: 404 });
  link.status = 'completed';
  const paidAt = new Date().toISOString();
  const event = {
    event_type: 'payment.completed',
    external_reference: link.externalReference,
    paidAt,
    data: {
      paidAt,
      externalReference: link.externalReference,
      gross_cents: link.amount,
      flash_fee_cents: Math.round(link.amount * 0.01),
      platform_fee_cents: 0,
      net_cents: link.amount - Math.round(link.amount * 0.01),
    },
  };
  const raw = JSON.stringify(event);
  const sig = await hmacHex(SECRET, raw);
  try {
    const res = await fetch(WEBHOOK_TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flash-Signature': sig,
      },
      body: raw,
    });
    const body = await res.text();
    return new Response(
      `<!doctype html><html><body style="font:14px system-ui;padding:32px;max-width:520px;margin:auto">
        <h1>Paid.</h1>
        <p>Webhook delivered to ${WEBHOOK_TARGET_URL}: HTTP ${res.status}</p>
        <pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:12px;overflow:auto">${body.slice(0, 800)}</pre>
        <p><a href="/pay/${id}">Back</a></p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html' } },
    );
  } catch (err) {
    return new Response(`Webhook delivery failed: ${err}`, { status: 502 });
  }
}

Deno.serve(
  {
    port: PORT,
    onListen: ({ port }) => {
      console.log(`mock-flash listening on http://localhost:${port}`);
      console.log(`webhook target = ${WEBHOOK_TARGET_URL}`);
    },
  },
  async (req: Request) => {
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname === '/oauth/token') return handleOauthToken(req);
    if (
      req.method === 'POST' &&
      (u.pathname === '/payment-links' || u.pathname === '/flash-connect/payment-links')
    )
      return handlePaymentLinks(req);
    const payMatch = u.pathname.match(/^\/pay\/([0-9a-f-]+)$/);
    if (req.method === 'GET' && payMatch) return handleCheckoutPage(payMatch[1]);
    const completeMatch = u.pathname.match(/^\/pay\/([0-9a-f-]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) return handleCompletePost(completeMatch[1]);
    return new Response('Not found', { status: 404 });
  },
);
