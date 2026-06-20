import { fetchBrandLogoDataUri } from '@/lib/exports/fetch-brand-logo';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseTitle(title: string): {
  orgName: string | null;
  reportName: string;
  period: string | null;
} {
  const parts = title
    .split(' — ')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    return {
      orgName: parts[0] ?? null,
      reportName: parts[1] ?? title,
      period: parts.slice(2).join(' — '),
    };
  }

  return {
    orgName: null,
    reportName: title,
    period: null,
  };
}

/** Removes a trailing " (export)" if present (legacy); print/PDF should match CSV column titles. */
function headersForPrintPreview(headers: string[]): string[] {
  return headers.map((h) => h.replace(/\s+\(export\)$/i, ''));
}

function isNumericHeader(header: string): boolean {
  return /amount|debit|credit|balance|period/i.test(header);
}

function isTotalLabel(label: string): boolean {
  return /^(total|totals|net )/i.test(label.trim());
}

export interface PrintTableOptions {
  readonly reportingNote?: string;
}

/**
 * Print-based "PDF export" utility.
 * Loads the Orange Way Books logo as a data URL so it appears reliably in the print preview window.
 * Opens a new window with a formatted table and triggers window.print().
 * **ZKA:** Table HTML is built only in the browser from already-decrypted row data; nothing is POSTed to the server for printing.
 * @returns true if the print window opened; false if popups were blocked (user is alerted).
 */
export async function printTable(
  title: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  options?: PrintTableOptions,
): Promise<boolean> {
  const logoDataUri = await fetchBrandLogoDataUri();

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to export as PDF.');
    return false;
  }

  const safeTitle = escapeHtml(title);
  const { orgName, reportName, period } = parseTitle(title);
  const reportingNoteHtml = options?.reportingNote
    ? `<p class="reporting-note">${escapeHtml(options.reportingNote)}</p>`
    : '';
  const logoBlock = `<img class="logo" src="${logoDataUri}" alt="Orange Way Books" />`;

  const displayHeaders = headersForPrintPreview(headers);

  const headerHtml = displayHeaders
    .map((h, index) => {
      const alignClass = isNumericHeader(h) ? 'th-num' : index === 0 ? 'th-first' : '';
      return `<th class="${alignClass}">${escapeHtml(h)}</th>`;
    })
    .join('');
  const bodyHtml = rows
    .map((row) => {
      const leadText = String(row[1] ?? row[0] ?? '').trim();
      const rowClass = isTotalLabel(leadText) ? 'row-total' : '';
      const cells = row
        .map((cell, index) => {
          const header = displayHeaders[index] ?? '';
          const alignClass = isNumericHeader(header) ? 'td-num' : index === 0 ? 'td-first' : '';
          return `<td class="${alignClass}">${escapeHtml(String(cell ?? ''))}</td>`;
        })
        .join('');
      return `<tr class="${rowClass}">${cells}</tr>`;
    })
    .join('');

  const generatedAt = escapeHtml(new Date().toLocaleString());

  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light;
      --brand: #f7931a;
      --ink: #111827;
      --muted: #6b7280;
      --line: #e5e7eb;
    }
    * { box-sizing: border-box; }
    body {
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 32px;
      color: var(--ink);
      background: white;
    }
    .page {
      max-width: 1100px;
      margin: 0 auto;
    }
    .report-hero {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 28px;
      padding: 0 0 20px;
      margin-bottom: 22px;
      border-bottom: 2px solid var(--brand);
    }
    .hero-brand {
      flex: 0 0 auto;
      opacity: 0.72;
      text-align: right;
    }
    .hero-brand .logo {
      display: block;
      width: 200px;
      max-width: 200px;
      height: auto;
      margin-left: auto;
    }
    .logo-fallback {
      display: block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      max-width: 200px;
      margin-left: auto;
      line-height: 1.2;
    }
    .hero-main {
      flex: 1;
      min-width: 0;
      text-align: left;
    }
    .org-name {
      font-size: 34px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.03em;
      margin: 0 0 10px;
      color: var(--ink);
    }
    .hero-main h1 {
      line-height: 1.25;
      margin: 0 0 6px;
      font-weight: 600;
      color: var(--ink);
    }
    .hero-main.has-org h1 {
      font-size: 20px;
    }
    .hero-main:not(.has-org) h1 {
      font-size: 28px;
      font-weight: 700;
    }
    .period {
      color: var(--muted);
      font-size: 13px;
      margin: 0;
    }
    .reporting-note {
      color: var(--ink);
      font-size: 12px;
      font-weight: 500;
      margin: 10px 0 0;
      line-height: 1.4;
      max-width: 52rem;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      overflow: hidden;
    }
    th, td {
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--line);
    }
    th {
      background: white;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .th-num, .td-num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .td-first {
      width: 18%;
    }
    tbody tr:nth-child(even):not(.row-total) td {
      background: #fcfcfd;
    }
    .row-total td {
      font-weight: 700;
      border-top: 2px solid #d1d5db;
      background: #fff;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    .page-footer {
      margin-top: 20px;
      text-align: center;
      color: var(--muted);
      font-size: 11px;
    }
    @media print {
      body { padding: 0; }
      .page { max-width: none; }
      .org-name { font-size: 28px; }
      .hero-main.has-org h1 { font-size: 19px; }
      .hero-main:not(.has-org) h1 { font-size: 24px; }
      .hero-brand .logo {
        width: 200px;
        max-width: 200px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="report-hero">
      <div class="hero-main${orgName ? ' has-org' : ''}">
        ${orgName ? `<div class="org-name">${escapeHtml(orgName)}</div>` : ''}
        <h1>${escapeHtml(reportName)}</h1>
        ${period ? `<p class="period">${escapeHtml(period)}</p>` : ''}
        ${reportingNoteHtml}
      </div>
      <div class="hero-brand">${logoBlock}</div>
    </div>

    <table>
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table>

    <div class="page-footer">Generated ${generatedAt}</div>
  </div>
</body>
</html>`);
  printWindow.document.close();
  const runPrint = (): void => {
    printWindow.focus();
    printWindow.print();
  };
  if (printWindow.document.readyState === 'complete') {
    window.setTimeout(runPrint, 0);
  } else {
    printWindow.addEventListener('load', () => window.setTimeout(runPrint, 0), { once: true });
  }
  return true;
}
