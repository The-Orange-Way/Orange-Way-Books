/**
 * S8, printable / save-as-PDF recovery code backup.
 *
 * The native browser print pipeline is the smallest way to ship a PDF:
 *   1. open a new window with a print-styled HTML page
 *   2. trigger window.print(), user picks "Save as PDF" or sends to printer
 *
 * No new dependencies. Works in Chrome, Firefox, Safari, Edge.
 *
 * Layout is intentionally bare so the printed sheet:
 *   • Fits one US Letter / A4 page
 *   • Reads cleanly under a desk lamp
 *   • Has a visible serial date so the user knows when it was generated
 *   • Warns clearly about loss + sharing
 *
 * No QR code yet (would require pulling in a QR lib). Words alone are
 * sufficient for recovery; QR can be a follow-up if users ask.
 */

interface RecoveryBackupInput {
  code: string;
  orgName?: string | null;
  generatedAt?: Date;
}

export function openRecoveryBackup({
  code,
  orgName,
  generatedAt = new Date(),
}: RecoveryBackupInput): void {
  const words = code.split(' ');
  if (words.length !== 12) {
    throw new Error('Recovery code must be exactly 12 words.');
  }

  const win = window.open('', '_blank', 'noopener=true,noreferrer=true,width=860,height=1100');
  if (!win) {
    throw new Error('Could not open print window. Allow popups for this site and try again.');
  }

  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );

  const orgLabel = orgName ? esc(orgName) : '(Your organization)';
  const dateLabel = generatedAt.toLocaleString();

  const rows = words
    .map(
      (w, i) => `
    <div class="word">
      <span class="num">${i + 1}.</span>
      <span class="text">${esc(w)}</span>
    </div>
  `,
    )
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Orange Way Books, Recovery Code Backup</title>
  <style>
    @media print { @page { margin: 0.6in; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; color: #111; max-width: 720px; margin: 32px auto; padding: 0 16px; line-height: 1.45; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .meta { font-size: 12px; color: #555; margin-bottom: 24px; }
    .frame { border: 2px solid #c2410c; border-radius: 8px; padding: 20px; background: #fff7ed; }
    .frame h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: #c2410c; margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px; font-size: 14px; }
    .word { display: flex; align-items: baseline; gap: 8px; }
    .num { display: inline-block; width: 22px; text-align: right; color: #888; font-size: 11px; }
    .text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; letter-spacing: 0.02em; }
    .warning { margin-top: 24px; padding: 14px 16px; border: 1px solid #d97706; background: #fffbeb; border-radius: 8px; font-size: 13px; }
    .warning b { display: block; margin-bottom: 6px; color: #92400e; }
    .footer { margin-top: 28px; font-size: 11px; color: #666; }
    .footer p { margin: 4px 0; }
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
    <span>Use your browser's print dialog → Save as PDF. Store the PDF offline.</span>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>

  <h1>Orange Way Books, Recovery Code Backup</h1>
  <div class="meta">
    Organization: <strong>${orgLabel}</strong><br />
    Generated: ${esc(dateLabel)}
  </div>

  <div class="frame">
    <h2>Recovery code (12 words)</h2>
    <div class="grid">
      ${rows}
    </div>
  </div>

  <div class="warning">
    <b>Treat this paper like a key to your safe.</b>
    Anyone who has these 12 words can unlock your books without your vault password.
    If you lose this paper <em>and</em> forget your vault password, your encrypted data
    cannot be recovered, Orange Way Books does not hold a copy and cannot reset it for you.
    Do not photograph, email, or store this in cloud notes.
  </div>

  <div class="footer">
    <p>Store this sheet in a safe, deposit box, fireproof folder, or with a trusted custodian.</p>
    <p>If you ever generate a new recovery code, this one stops working immediately, shred this paper.</p>
  </div>

  <script>
    // Small delay so the UI paints before the print dialog opens on slower
    // browsers; user can also re-trigger via the button.
    window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 250); });
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}
