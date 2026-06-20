import { supabase } from '@/lib/supabase';
import {
  decryptOrganization,
  decryptOrgSettings,
  decryptWallet,
  decryptChartOfAccount,
  decryptContact,
  decryptTransaction,
  decryptJournalEntry,
  decryptJournalEntryLine,
  decryptPaymentRequest,
  decryptAttachment,
} from '@/lib/crypto-fields';
import {
  TAKEOUT_VERSION,
  type TakeoutFile,
  type TakeoutData,
  type TakeoutAttachment,
} from './schema';

type DecryptFn = (ciphertext: string) => Promise<string>;
type DecryptBlobFn = (ciphertext: Blob | ArrayBuffer) => Promise<ArrayBuffer>;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function mapAsync<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  return Promise.all(items.map((item, i) => fn(item, i)));
}

/** Decrypt every org-scoped row and return a portable plaintext bundle. */
export async function buildTakeoutFile(
  orgId: string,
  decryptText: DecryptFn,
  decryptBlob: DecryptBlobFn,
  onProgress?: (phase: string, done: number, total: number) => void,
): Promise<TakeoutFile> {
  const progress = onProgress ?? (() => {});

  const [
    orgRes,
    settingsRes,
    walletsRes,
    accountsRes,
    contactsRes,
    txsRes,
    jesRes,
    linesRes,
    paymentsRes,
    attachmentsRes,
  ] = await Promise.all([
    supabase.from('organizations').select('*').eq('id', orgId).maybeSingle(),
    supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
    supabase.from('accounts').select('*').eq('org_id', orgId),
    supabase
      .from('chart_of_accounts' as any)
      .select('*')
      .eq('org_id', orgId),
    supabase.from('contacts').select('*').eq('org_id', orgId),
    supabase.from('transactions').select('*').eq('org_id', orgId),
    supabase.from('journal_entries').select('*').eq('org_id', orgId),
    supabase
      .from('journal_entry_lines')
      .select('*, journal_entries!inner(org_id)')
      .eq('journal_entries.org_id', orgId),
    supabase.from('payment_requests').select('*').eq('org_id', orgId),
    supabase.from('attachments').select('*').eq('org_id', orgId),
  ]);

  const orgRow = orgRes.data;
  if (!orgRow) throw new Error('Organization not found');

  const orgFields = await decryptOrganization(orgRow as any, decryptText);

  const settings = settingsRes.data
    ? await decryptOrgSettings(settingsRes.data as any, decryptText)
    : { bitcoin_display: null, primary_currency: null, secondary_currency: null };

  const wallets = await mapAsync((walletsRes.data as any[]) ?? [], async (w) => {
    const f = await decryptWallet(w, decryptText);
    return {
      id: w.id as string,
      name: f.encrypted_name,
      asset: f.asset,
      account_type: f.account_type,
      initial_balance: f.initial_balance ?? 0,
      legacy_account_id: (w.external_account_id ?? null) as string | null,
      connection_type: f.connection_type,
      legacy_account_code: f.legacy_account_code,
    };
  });

  const chart_of_accounts = await mapAsync((accountsRes.data as any[]) ?? [], async (a) => {
    const f = await decryptChartOfAccount(a, decryptText);
    return {
      id: a.id as string,
      legacy_account_id: a.id as string,
      account_name: f.account_name,
      account_code: f.account_code,
      account_type: f.account_type,
      account_group: f.account_group ?? '',
      account_category: f.account_category ?? null,
      is_archived: f.is_archived,
      // Takeout file format keeps legacy field name for backward compat
      // with previously-saved files. Internally the value is the new
      // chart_of_accounts.parent_id UUID.
      parent_legacy_account_id: f.parent_id ?? null,
    } as any;
  });

  const contacts = await mapAsync((contactsRes.data as any[]) ?? [], async (c) => {
    const f = await decryptContact(c, decryptText);
    return { id: c.id as string, ...f };
  });

  const transactions = await mapAsync((txsRes.data as any[]) ?? [], async (tx) => {
    const f = await decryptTransaction(tx, decryptText);
    return {
      id: tx.id as string,
      account_id: (tx.account_id ?? null) as string | null,
      date: tx.date as string,
      type: f.type,
      asset: f.asset,
      amount: f.amount,
      usd_value: f.usd_value ?? null,
      exchange_rate: f.exchange_rate ?? null,
      memo: f.memo,
      status: f.status,
      cleared_status: f.cleared_status,
    };
  });

  const journal_entries = await mapAsync((jesRes.data as any[]) ?? [], async (je) => {
    const f = await decryptJournalEntry(je, decryptText);
    return {
      id: je.id as string,
      date: je.date as string,
      memo: f.memo,
      ref_number: f.ref_number,
      currency: f.currency,
      exchange_rate: f.exchange_rate,
      status: f.status,
      source_type: f.source_type,
      period_locked: f.period_locked,
    };
  });

  const journal_entry_lines = await mapAsync((linesRes.data as any[]) ?? [], async (l) => {
    const f = await decryptJournalEntryLine(l, decryptText);
    return {
      id: l.id as string,
      journal_entry_id: l.journal_entry_id as string,
      account_id: (l.account_id ?? null) as string | null,
      account_name: f.account_name,
      account_code: f.account_code,
      debit: f.debit,
      credit: f.credit,
      description: f.description,
      amount_native: f.amount_native ?? null,
      amount_primary: f.amount_primary ?? null,
      posted_rate: f.posted_rate ?? null,
      wallet_currency: f.wallet_currency ?? null,
      primary_currency_at_posting: (l.primary_currency_at_posting ?? null) as string | null,
    };
  });

  const payment_requests = await mapAsync((paymentsRes.data as any[]) ?? [], async (p) => {
    const f = await decryptPaymentRequest(p, decryptText);
    return {
      id: p.id as string,
      payee: f.payee,
      description: f.description,
      rejection_reason: f.rejection_reason,
      amount: f.amount,
      currency: f.currency,
      status: f.status,
      request_type: f.request_type,
      vendor_ref: f.vendor_ref,
      payment_address: f.payment_address,
      document_date: (p.document_date ?? null) as string | null,
      due_date: (p.due_date ?? null) as string | null,
      paid_at: (p.paid_at ?? null) as string | null,
    };
  });

  // ── Attachments: download encrypted blobs, decrypt client-side, base64 ──
  const attachmentRows = (attachmentsRes.data as any[]) ?? [];
  const attachments: TakeoutAttachment[] = [];
  for (let i = 0; i < attachmentRows.length; i++) {
    const row = attachmentRows[i];
    progress('Receipts', i, attachmentRows.length);
    try {
      const meta = await decryptAttachment(row, decryptText);
      const dl = await supabase.storage.from('attachments').download(row.storage_path);
      let content_base64 = '';
      if (!dl.error && dl.data) {
        const buf = await dl.data.arrayBuffer();
        const plaintextBuf = await decryptBlob(buf);
        content_base64 = arrayBufferToBase64(plaintextBuf);
      }
      attachments.push({
        id: row.id as string,
        entity_type: row.entity_type,
        entity_id: row.entity_id as string,
        file_name: meta.file_name,
        file_size: row.file_size as number,
        mime_type: meta.mime_type,
        content_base64,
      });
    } catch (err) {
      // Keep the metadata even if the blob failed — helpful for diagnosis.
      attachments.push({
        id: row.id as string,
        entity_type: row.entity_type,
        entity_id: row.entity_id as string,
        file_name: `[decrypt-failed-${row.id}]`,
        file_size: row.file_size as number,
        mime_type: null,
        content_base64: '',
      });
    }
  }
  progress('Receipts', attachmentRows.length, attachmentRows.length);

  const data: TakeoutData = {
    organizations: [
      {
        id: orgId,
        name: orgFields.name,
        external_journal_id: (orgRow as any).external_journal_id ?? null,
      },
    ],
    org_settings: [settings],
    wallets,
    chart_of_accounts,
    contacts,
    transactions,
    journal_entries,
    journal_entry_lines,
    payment_requests,
    attachments,
  };

  return {
    _meta: {
      version: TAKEOUT_VERSION,
      exportedAt: new Date().toISOString(),
      encryption: 'none',
      sourceOrgName: orgFields.name,
      sourceOrgId: orgId,
      tables: Object.keys(data),
    },
    data,
  };
}

/** Triggers a browser download for the takeout JSON. */
export function downloadTakeout(file: TakeoutFile): void {
  const safeName = file._meta.sourceOrgName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() | 'org';
  const today = new Date().toISOString().slice(0, 10);
  const filename = `owb-${safeName}-${today}-plaintext.json`;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
