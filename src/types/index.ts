export interface Organization {
  id: string;
  name: string;
  external_journal_id?: string;
  created_at: string;
}

export interface OrgMember {
  id: string;
  user_id: string;
  org_id: string;
  role: string;
  joined_at: string;
}

export interface OrgSettings {
  org_id: string;
  primary_currency: string;
  secondary_currency: string;
  bitcoin_display: BitcoinDisplay;
  date_format: string;
}

export type BitcoinDisplay = 'sats' | 'btc' | 'btc-easy' | 'bitcoins';

export interface AccountMetadata {
  id: string;
  org_id: string;
  external_account_id: string;
  external_account_code: string;
  encrypted_name?: string;
  encrypted_description?: string;
  key_version: number;
  created_at: string;
}

export interface Account {
  id: string;
  org_id: string;
  external_account_id?: string;
  external_account_code?: string;
  encrypted_name: string;
  asset: string;
  account_type: string;
  key_version: number;
  created_at: string;
}

export interface TransactionMetadata {
  id: string;
  org_id: string;
  legacy_tx_id?: string;
  encrypted_description?: string;
  encrypted_contact?: string;
  receipt_url?: string;
  key_version: number;
  created_at: string;
}
