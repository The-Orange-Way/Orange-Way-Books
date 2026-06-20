/**
 * OWB Invoicing — printable invoice render.
 *
 * Uses the same print-window pattern as `recoveryBackup.ts`: open a new
 * browser window with a print-styled HTML page, trigger `window.print()`,
 * user picks "Save as PDF" or sends to a printer. No PDF library bundled.
 *
 * The invoice content stays in the browser the whole time — the server
 * never sees it. This is the same ZKA property that applies to every
 * other decrypted view in OWB.
 */

import type { InvoiceSharePayload } from './invoiceShare';

interface PrintOptions {
  orgPublicName?: string | null;
  /** ISO currency code formatter (USD, EUR, BTC, …) */
  formatAmount?: (amount: number, currency: string) => string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

const defaultFormat = (amt: number, cur: string) =>
  `${cur} ${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;

export function openInvoicePrint(payload: InvoiceSharePayload, opts: PrintOptions = {}): void {
  const fmt = opts.formatAmount ?? defaultFormat;
  const orgName = opts.orgPublicName ?? 'An organization using Orange Way Books';

  const win = window.open('', '_blank', 'noopener=true,noreferrer=true,width=900,height=1100');
  if (!win) {
    throw new Error('Could not open print window. Allow popups for this site.');
  }

  const lineRows = payload.lines
    .map(
      (l) => `
    <tr>
      <td class="desc">${esc(l.description | '—')}</td>
      <td class="qty">${l.quantity != null ? l.quantity : ''}</td>
      <td class="unit">${l.unit_price != null ? fmt(l.unit_price, payload.currency) : ''}</td>
      <td class="amt">${fmt(l.amount, payload.currency)}</td>
    </tr>
  `,
    )
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(payload.invoice_number)}</title>
  <style>
    @media print { @page { margin: 0.5in; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; color: #111; max-width: 780px; margin: 28px auto; padding: 0 16px; line-height: 1.4; font-size: 13px; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #c2410c; }
    .top h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.02em; }
    .top .meta { font-size: 12px; color: #555; }
    .right { text-align: right; }
    .right .num { font-size: 18px; font-weight: 700; color: #c2410c; margin-bottom: 4px; }
    .right .date { font-size: 12px; color: #555; }
    .right .status { display: inline-block; background: #c2410c; color: #fff; padding: 3px 10px; border-radius: 4px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; margin-top: 6px; }
    .blocks { display: flex; gap: 32px; margin: 18px 0 24px; }
    .block { flex: 1; }
    .block h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; }
    .block p { margin: 1px 0; font-size: 13px; }
    table.lines { width: 100%; border-collapse: collapse; margin: 12px 0 18px; }
    table.lines th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; padding: 8px 6px; border-bottom: 1px solid #ddd; }
    table.lines th.qty, table.lines th.unit, table.lines th.amt { text-align: right; }
    table.lines td { padding: 10px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    table.lines td.qty, table.lines td.unit, table.lines td.amt { text-align: right; font-variant-numeric: tabular-nums; }
    table.lines td.desc { width: 50%; }
    .totals { display: flex; justify-content: flex-end; margin-top: 8px; }
    .totals table { font-size: 13px; }
    .totals td { padding: 4px 8px; }
    .totals .grand td { font-size: 15px; font-weight: 700; padding-top: 8px; border-top: 2px solid #111; }
    .grand .label { padding-right: 18px; }
    .memo, .pay, .footer { margin-top: 20px; padding: 12px; background: #fff7ed; border-radius: 6px; font-size: 12px; }
    .pay { background: #fef3c7; }
    .memo b, .pay b { display: block; margin-bottom: 4px; color: #92400e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .footer { margin-top: 28px; background: none; color: #888; font-size: 10px; text-align: center; padding: 8px; }
    @media screen {
      .print-bar { position: fixed; top: 0; left: 0; right: 0; background: #111; color: #fff; padding: 10px 14px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
      .print-bar button { background: #c2410c; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px; font-size: 13px; cursor: pointer; }
      body { padding-top: 56px; }
    }
    @media print { .print-bar { display: none; } }
  </style>
</head>
<body>
  <div class="print-bar">
    <span>Use the browser's print dialog → Save as PDF.</span>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>

  <div class="top">
    <div>
      <h1>${esc(orgName)}</h1>
      <div class="meta">Invoice issued via Orange Way Books</div>
    </div>
    <div class="right">
      <div class="num">${esc(payload.invoice_number)}</div>
      <div class="date">${payload.issue_date ? `Issued ${esc(payload.issue_date)}` : ''}${payload.due_date ? ` · Due ${esc(payload.due_date)}` : ''}</div>
      <div class="status">${esc(payload.status)}</div>
    </div>
  </div>

  <div class="blocks">
    <div class="block">
      <h3>Bill to</h3>
      <p><strong>${esc(payload.customer_name)}</strong></p>
      ${payload.customer_email ? `<p>${esc(payload.customer_email)}</p>` : ''}
      ${payload.customer_phone ? `<p>${esc(payload.customer_phone)}</p>` : ''}
      ${payload.customer_address ? `<p style="white-space:pre-wrap">${esc(payload.customer_address)}</p>` : ''}
    </div>
    <div class="block">
      <h3>Amount</h3>
      <p style="font-size:22px;font-weight:700;color:#c2410c;margin-top:4px">${fmt(payload.amount, payload.currency)}</p>
    </div>
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th class="desc">Description</th>
        <th class="qty">Qty</th>
        <th class="unit">Unit</th>
        <th class="amt">Amount</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals">
    <table>
      <tr class="grand"><td class="label">Total</td><td>${fmt(payload.amount, payload.currency)}</td></tr>
    </table>
  </div>

  ${payload.memo ? `<div class="memo"><b>Note</b><div style="white-space:pre-wrap">${esc(payload.memo)}</div></div>` : ''}
  ${payload.payment_instructions ? `<div class="pay"><b>Payment instructions</b><div style="white-space:pre-wrap">${esc(payload.payment_instructions)}</div></div>` : ''}

  <div class="footer">Encrypted invoice delivered via Orange Way Books · books.orangeway.app</div>

  <script>
    window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 200); });
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}
