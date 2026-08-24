export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_key_versions: {
        Row: {
          active_dek_key_version: number
          active_osk_key_version: number
          last_rotated_at: string | null
          org_id: string
        }
        Insert: {
          active_dek_key_version?: number
          active_osk_key_version?: number
          last_rotated_at?: string | null
          org_id: string
        }
        Update: {
          active_dek_key_version?: number
          active_osk_key_version?: number
          last_rotated_at?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "active_key_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      attachments: {
        Row: {
          created_at: string | null
          dek_key_version: number
          entity_id: string
          entity_type: string
          file_name: string
          file_size: number
          id: string
          key_version: number | null
          mime_type: string | null
          org_id: string
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string | null
          dek_key_version?: number
          entity_id: string
          entity_type: string
          file_name: string
          file_size: number
          id?: string
          key_version?: number | null
          mime_type?: string | null
          org_id: string
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string | null
          dek_key_version?: number
          entity_id?: string
          entity_type?: string
          file_name?: string
          file_size?: number
          id?: string
          key_version?: number | null
          mime_type?: string | null
          org_id?: string
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attachments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          after_snapshot: string | null
          before_snapshot: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          key_version: number | null
          org_id: string
          summary: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          after_snapshot?: string | null
          before_snapshot?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          key_version?: number | null
          org_id: string
          summary?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          after_snapshot?: string | null
          before_snapshot?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          key_version?: number | null
          org_id?: string
          summary?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      beta_allowlist: {
        Row: {
          email: string
          id: string
          invitation_sent_at: string | null
          invited_at: string
          invited_by: string | null
          note: string | null
          signed_up_at: string | null
        }
        Insert: {
          email: string
          id?: string
          invitation_sent_at?: string | null
          invited_at?: string
          invited_by?: string | null
          note?: string | null
          signed_up_at?: string | null
        }
        Update: {
          email?: string
          id?: string
          invitation_sent_at?: string | null
          invited_at?: string
          invited_by?: string | null
          note?: string | null
          signed_up_at?: string | null
        }
        Relationships: []
      }
      billing_access_log: {
        Row: {
          access_context: string
          accessed_at: string
          billing_account_id: string
          client_ip: unknown
          id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          access_context: string
          accessed_at?: string
          billing_account_id: string
          client_ip?: unknown
          id?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          access_context?: string
          accessed_at?: string
          billing_account_id?: string
          client_ip?: unknown
          id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_access_log_billing_account_id_fkey"
            columns: ["billing_account_id"]
            isOneToOne: false
            referencedRelation: "billing_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_accounts: {
        Row: {
          created_at: string
          display_name: string
          id: string
          owner_user_id: string
          type: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          owner_user_id: string
          type: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          owner_user_id?: string
          type?: string
        }
        Relationships: []
      }
      capabilities: {
        Row: {
          added_in_version: string | null
          created_at: string
          description: string
          feature: string
          key: string
          requires_dek: boolean
          requires_osk: boolean
        }
        Insert: {
          added_in_version?: string | null
          created_at?: string
          description: string
          feature: string
          key: string
          requires_dek?: boolean
          requires_osk?: boolean
        }
        Update: {
          added_in_version?: string | null
          created_at?: string
          description?: string
          feature?: string
          key?: string
          requires_dek?: boolean
          requires_osk?: boolean
        }
        Relationships: []
      }
      chart_of_accounts: {
        Row: {
          closed_at: string | null
          created_at: string
          encrypted_account_sub_type: string | null
          encrypted_account_type: string
          encrypted_allowed_currencies: string | null
          encrypted_code: string | null
          encrypted_description: string | null
          encrypted_is_archived: string | null
          encrypted_is_group: string
          encrypted_is_system: string
          encrypted_metadata: Json | null
          encrypted_name: string
          id: string
          key_version: number
          opened_at: string | null
          org_id: string
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          encrypted_account_sub_type?: string | null
          encrypted_account_type: string
          encrypted_allowed_currencies?: string | null
          encrypted_code?: string | null
          encrypted_description?: string | null
          encrypted_is_archived?: string | null
          encrypted_is_group: string
          encrypted_is_system: string
          encrypted_metadata?: Json | null
          encrypted_name: string
          id?: string
          key_version?: number
          opened_at?: string | null
          org_id: string
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          encrypted_account_sub_type?: string | null
          encrypted_account_type?: string
          encrypted_allowed_currencies?: string | null
          encrypted_code?: string | null
          encrypted_description?: string | null
          encrypted_is_archived?: string | null
          encrypted_is_group?: string
          encrypted_is_system?: string
          encrypted_metadata?: Json | null
          encrypted_name?: string
          id?: string
          key_version?: number
          opened_at?: string | null
          org_id?: string
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chart_of_accounts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chart_of_accounts_parent_fk"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "chart_of_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_account_map: {
        Row: {
          created_at: string
          encrypted_account_id: string
          encrypted_metadata_key_version: number
          id: string
          is_active: boolean
          or_connection_id: string
          or_external_wallet_id: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          encrypted_account_id: string
          encrypted_metadata_key_version?: number
          id?: string
          is_active?: boolean
          or_connection_id: string
          or_external_wallet_id: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          encrypted_account_id?: string
          encrypted_metadata_key_version?: number
          id?: string
          is_active?: boolean
          or_connection_id?: string
          or_external_wallet_id?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_account_map_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      connectors: {
        Row: {
          connector_type: string
          created_at: string
          encrypted_metadata: Json | null
          id: string
          key_version: number | null
          label: string
          last_sync: string | null
          or_access_token: string | null
          or_connection_ids: string[] | null
          or_user_id: string | null
          org_id: string
          status: string
          updated_at: string
        }
        Insert: {
          connector_type: string
          created_at?: string
          encrypted_metadata?: Json | null
          id?: string
          key_version?: number | null
          label?: string
          last_sync?: string | null
          or_access_token?: string | null
          or_connection_ids?: string[] | null
          or_user_id?: string | null
          org_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          connector_type?: string
          created_at?: string
          encrypted_metadata?: Json | null
          id?: string
          key_version?: number | null
          label?: string
          last_sync?: string | null
          or_access_token?: string | null
          or_connection_ids?: string[] | null
          or_user_id?: string | null
          org_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connectors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          city: string | null
          country: string | null
          created_at: string | null
          dek_key_version: number
          email: string | null
          hmac_name: string | null
          id: string
          key_version: number | null
          name: string
          org_id: string
          phone: string | null
          state: string | null
          street: string | null
          type: string | null
          updated_at: string | null
          zip: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string | null
          dek_key_version?: number
          email?: string | null
          hmac_name?: string | null
          id?: string
          key_version?: number | null
          name: string
          org_id: string
          phone?: string | null
          state?: string | null
          street?: string | null
          type?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string | null
          dek_key_version?: number
          email?: string | null
          hmac_name?: string | null
          id?: string
          key_version?: number | null
          name?: string
          org_id?: string
          phone?: string | null
          state?: string | null
          street?: string | null
          type?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rates: {
        Row: {
          base_currency: string
          bucket_granularity: string | null
          bucket_ts: string | null
          confirmed_at: string | null
          fetched_at: string | null
          id: string
          provider: string
          quote_currency: string
          rate: number | null
          rate_date: string
          source_kind: string | null
          status: string
        }
        Insert: {
          base_currency: string
          bucket_granularity?: string | null
          bucket_ts?: string | null
          confirmed_at?: string | null
          fetched_at?: string | null
          id?: string
          provider: string
          quote_currency: string
          rate?: number | null
          rate_date: string
          source_kind?: string | null
          status?: string
        }
        Update: {
          base_currency?: string
          bucket_granularity?: string | null
          bucket_ts?: string | null
          confirmed_at?: string | null
          fetched_at?: string | null
          id?: string
          provider?: string
          quote_currency?: string
          rate?: number | null
          rate_date?: string
          source_kind?: string | null
          status?: string
        }
        Relationships: []
      }
      flash_oauth_state: {
        Row: {
          created_at: string
          expires_at: string
          purpose: string
          state: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          purpose: string
          state: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          purpose?: string
          state?: string
          user_id?: string | null
        }
        Relationships: []
      }
      flash_payment_events: {
        Row: {
          event_type: string
          external_reference: string | null
          id: string
          payload: Json
          received_at: string
          signature: string | null
        }
        Insert: {
          event_type: string
          external_reference?: string | null
          id?: string
          payload: Json
          received_at?: string
          signature?: string | null
        }
        Update: {
          event_type?: string
          external_reference?: string | null
          id?: string
          payload?: Json
          received_at?: string
          signature?: string | null
        }
        Relationships: []
      }
      flash_payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          external_reference: string
          flash_fee_cents: number | null
          flash_payment_link_url: string | null
          gross_cents: number | null
          id: string
          idempotency_key: string | null
          net_cents: number | null
          paid_at: string | null
          platform_fee_cents: number | null
          status: string
          subscription_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency: string
          external_reference: string
          flash_fee_cents?: number | null
          flash_payment_link_url?: string | null
          gross_cents?: number | null
          id?: string
          idempotency_key?: string | null
          net_cents?: number | null
          paid_at?: string | null
          platform_fee_cents?: number | null
          status: string
          subscription_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          external_reference?: string
          flash_fee_cents?: number | null
          flash_payment_link_url?: string | null
          gross_cents?: number | null
          id?: string
          idempotency_key?: string | null
          net_cents?: number | null
          paid_at?: string | null
          platform_fee_cents?: number | null
          status?: string
          subscription_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flash_payments_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      flash_platform_tokens: {
        Row: {
          access_token: string
          expires_at: string
          id: string
          refresh_token: string
          scopes: string[]
          updated_at: string
        }
        Insert: {
          access_token: string
          expires_at: string
          id?: string
          refresh_token: string
          scopes?: string[]
          updated_at?: string
        }
        Update: {
          access_token?: string
          expires_at?: string
          id?: string
          refresh_token?: string
          scopes?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      fx_revaluation_runs: {
        Row: {
          created_at: string
          framework: string
          id: string
          je_id: string | null
          method: string
          notes: string | null
          org_id: string
          period_end: string
          period_start: string
          reverse_je_id: string | null
          reverse_on: string | null
          run_at: string
          run_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          framework: string
          id?: string
          je_id?: string | null
          method: string
          notes?: string | null
          org_id: string
          period_end: string
          period_start: string
          reverse_je_id?: string | null
          reverse_on?: string | null
          run_at?: string
          run_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          framework?: string
          id?: string
          je_id?: string | null
          method?: string
          notes?: string | null
          org_id?: string
          period_end?: string
          period_start?: string
          reverse_je_id?: string | null
          reverse_on?: string | null
          run_at?: string
          run_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fx_revaluation_runs_je_id_fkey"
            columns: ["je_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_reverse_je_id_fkey"
            columns: ["reverse_je_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      import_jobs: {
        Row: {
          committed_at: string | null
          created_at: string
          created_by: string | null
          encrypted_committed_refs: string | null
          encrypted_error: string | null
          encrypted_manifest: string | null
          encrypted_parse_summary: string | null
          encrypted_reconciliation: string | null
          encrypted_staged_data: string | null
          file_hash: string | null
          file_name: string | null
          id: string
          key_version: number
          org_id: string
          row_count: number | null
          source_type: string
          status: string
          updated_at: string
        }
        Insert: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          encrypted_committed_refs?: string | null
          encrypted_error?: string | null
          encrypted_manifest?: string | null
          encrypted_parse_summary?: string | null
          encrypted_reconciliation?: string | null
          encrypted_staged_data?: string | null
          file_hash?: string | null
          file_name?: string | null
          id?: string
          key_version?: number
          org_id: string
          row_count?: number | null
          source_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          encrypted_committed_refs?: string | null
          encrypted_error?: string | null
          encrypted_manifest?: string | null
          encrypted_parse_summary?: string | null
          encrypted_reconciliation?: string | null
          encrypted_staged_data?: string | null
          file_hash?: string | null
          file_name?: string | null
          id?: string
          key_version?: number
          org_id?: string
          row_count?: number | null
          source_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          amount: number
          created_at: string
          encrypted_amount: string | null
          encrypted_description: string | null
          encrypted_quantity: string | null
          encrypted_unit_price: string | null
          id: string
          invoice_id: string
          key_version: number
          sort_order: number
        }
        Insert: {
          amount?: number
          created_at?: string
          encrypted_amount?: string | null
          encrypted_description?: string | null
          encrypted_quantity?: string | null
          encrypted_unit_price?: string | null
          id?: string
          invoice_id: string
          key_version?: number
          sort_order?: number
        }
        Update: {
          amount?: number
          created_at?: string
          encrypted_amount?: string | null
          encrypted_description?: string | null
          encrypted_quantity?: string | null
          encrypted_unit_price?: string | null
          id?: string
          invoice_id?: string
          key_version?: number
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_payments: {
        Row: {
          amount_applied: number
          applied_at: string
          applied_by: string | null
          applied_rate: number | null
          applied_rate_currency: string | null
          encrypted_amount_applied: string | null
          encrypted_notes: string | null
          id: string
          invoice_id: string
          is_placeholder: boolean
          key_version: number
          signature_b64: string | null
          signature_key_version: number | null
          superseded_at: string | null
          superseded_by_transaction_id: string | null
          transaction_id: string
        }
        Insert: {
          amount_applied?: number
          applied_at?: string
          applied_by?: string | null
          applied_rate?: number | null
          applied_rate_currency?: string | null
          encrypted_amount_applied?: string | null
          encrypted_notes?: string | null
          id?: string
          invoice_id: string
          is_placeholder?: boolean
          key_version?: number
          signature_b64?: string | null
          signature_key_version?: number | null
          superseded_at?: string | null
          superseded_by_transaction_id?: string | null
          transaction_id: string
        }
        Update: {
          amount_applied?: number
          applied_at?: string
          applied_by?: string | null
          applied_rate?: number | null
          applied_rate_currency?: string | null
          encrypted_amount_applied?: string | null
          encrypted_notes?: string | null
          id?: string
          invoice_id?: string
          is_placeholder?: boolean
          key_version?: number
          signature_b64?: string | null
          signature_key_version?: number | null
          superseded_at?: string | null
          superseded_by_transaction_id?: string | null
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_superseded_by_transaction_id_fkey"
            columns: ["superseded_by_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number
          contact_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          due_date: string | null
          encrypted_amount: string | null
          encrypted_customer_address: string | null
          encrypted_customer_email_snapshot: string | null
          encrypted_customer_name: string | null
          encrypted_customer_phone_snapshot: string | null
          encrypted_internal_notes: string | null
          encrypted_memo: string | null
          encrypted_payment_instructions: string | null
          encrypted_share_blob: string | null
          encrypted_void_reason: string | null
          encrypted_write_off_reason: string | null
          id: string
          invoice_number: string
          issue_date: string | null
          key_version: number
          org_id: string
          paid_at: string | null
          public_share_created_at: string | null
          public_share_expires_at: string | null
          public_url_id: string | null
          public_view_count: number
          sent_at: string | null
          status: string
          updated_at: string
          viewed_at: string | null
          voided_at: string | null
          written_off_at: string | null
        }
        Insert: {
          amount?: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          encrypted_amount?: string | null
          encrypted_customer_address?: string | null
          encrypted_customer_email_snapshot?: string | null
          encrypted_customer_name?: string | null
          encrypted_customer_phone_snapshot?: string | null
          encrypted_internal_notes?: string | null
          encrypted_memo?: string | null
          encrypted_payment_instructions?: string | null
          encrypted_share_blob?: string | null
          encrypted_void_reason?: string | null
          encrypted_write_off_reason?: string | null
          id?: string
          invoice_number: string
          issue_date?: string | null
          key_version?: number
          org_id: string
          paid_at?: string | null
          public_share_created_at?: string | null
          public_share_expires_at?: string | null
          public_url_id?: string | null
          public_view_count?: number
          sent_at?: string | null
          status?: string
          updated_at?: string
          viewed_at?: string | null
          voided_at?: string | null
          written_off_at?: string | null
        }
        Update: {
          amount?: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          encrypted_amount?: string | null
          encrypted_customer_address?: string | null
          encrypted_customer_email_snapshot?: string | null
          encrypted_customer_name?: string | null
          encrypted_customer_phone_snapshot?: string | null
          encrypted_internal_notes?: string | null
          encrypted_memo?: string | null
          encrypted_payment_instructions?: string | null
          encrypted_share_blob?: string | null
          encrypted_void_reason?: string | null
          encrypted_write_off_reason?: string | null
          id?: string
          invoice_number?: string
          issue_date?: string | null
          key_version?: number
          org_id?: string
          paid_at?: string | null
          public_share_created_at?: string | null
          public_share_expires_at?: string | null
          public_url_id?: string | null
          public_view_count?: number
          sent_at?: string | null
          status?: string
          updated_at?: string
          viewed_at?: string | null
          voided_at?: string | null
          written_off_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      je_ref_sequence: {
        Row: {
          last_seq: number
          org_id: string
          year: number
        }
        Insert: {
          last_seq?: number
          org_id: string
          year: number
        }
        Update: {
          last_seq?: number
          org_id?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "je_ref_sequence_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          created_at: string
          date: string
          encrypted_currency: string
          encrypted_exchange_rate: string | null
          encrypted_memo: string | null
          encrypted_metadata: Json | null
          encrypted_period_locked: string | null
          encrypted_ref_number: string | null
          hmac_import_external_id: string | null
          id: string
          import_job_id: string | null
          key_version: number
          org_id: string
          reversal_of_id: string | null
          source_type: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          date?: string
          encrypted_currency: string
          encrypted_exchange_rate?: string | null
          encrypted_memo?: string | null
          encrypted_metadata?: Json | null
          encrypted_period_locked?: string | null
          encrypted_ref_number?: string | null
          hmac_import_external_id?: string | null
          id?: string
          import_job_id?: string | null
          key_version?: number
          org_id: string
          reversal_of_id?: string | null
          source_type?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          encrypted_currency?: string
          encrypted_exchange_rate?: string | null
          encrypted_memo?: string | null
          encrypted_metadata?: Json | null
          encrypted_period_locked?: string | null
          encrypted_ref_number?: string | null
          hmac_import_external_id?: string | null
          id?: string
          import_job_id?: string | null
          key_version?: number
          org_id?: string
          reversal_of_id?: string | null
          source_type?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_import_job_id_fkey"
            columns: ["import_job_id"]
            isOneToOne: false
            referencedRelation: "import_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_reversal_of_id_fkey"
            columns: ["reversal_of_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entry_lines: {
        Row: {
          account_code: string | null
          account_id: string
          account_name: string | null
          created_at: string
          description: string | null
          dual_amounts_backfilled: boolean
          encrypted_amount_native: string | null
          encrypted_amount_primary: string | null
          encrypted_book_value: string | null
          encrypted_credit: string
          encrypted_debit: string
          encrypted_manual_rate_reason: string | null
          encrypted_manual_rate_source: string | null
          encrypted_metadata: Json | null
          encrypted_posted_rate: string | null
          encrypted_primary_currency_at_posting: string | null
          encrypted_wallet_currency: string | null
          id: string
          journal_entry_id: string
          key_version: number
          pinned_rate_id: string | null
          rate_asof: string | null
          rate_pending: boolean
        }
        Insert: {
          account_code?: string | null
          account_id: string
          account_name?: string | null
          created_at?: string
          description?: string | null
          dual_amounts_backfilled?: boolean
          encrypted_amount_native?: string | null
          encrypted_amount_primary?: string | null
          encrypted_book_value?: string | null
          encrypted_credit: string
          encrypted_debit: string
          encrypted_manual_rate_reason?: string | null
          encrypted_manual_rate_source?: string | null
          encrypted_metadata?: Json | null
          encrypted_posted_rate?: string | null
          encrypted_primary_currency_at_posting?: string | null
          encrypted_wallet_currency?: string | null
          id?: string
          journal_entry_id: string
          key_version?: number
          pinned_rate_id?: string | null
          rate_asof?: string | null
          rate_pending?: boolean
        }
        Update: {
          account_code?: string | null
          account_id?: string
          account_name?: string | null
          created_at?: string
          description?: string | null
          dual_amounts_backfilled?: boolean
          encrypted_amount_native?: string | null
          encrypted_amount_primary?: string | null
          encrypted_book_value?: string | null
          encrypted_credit?: string
          encrypted_debit?: string
          encrypted_manual_rate_reason?: string | null
          encrypted_manual_rate_source?: string | null
          encrypted_metadata?: Json | null
          encrypted_posted_rate?: string | null
          encrypted_primary_currency_at_posting?: string | null
          encrypted_wallet_currency?: string | null
          id?: string
          journal_entry_id?: string
          key_version?: number
          pinned_rate_id?: string | null
          rate_asof?: string | null
          rate_pending?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "journal_entry_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "chart_of_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_pinned_rate_id_fkey"
            columns: ["pinned_rate_id"]
            isOneToOne: false
            referencedRelation: "exchange_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      key_rotation_jobs: {
        Row: {
          abort_reason: string | null
          completed_at: string | null
          error_log: Json
          id: string
          new_dek_key_version: number
          new_osk_key_version: number
          org_id: string
          previous_dek_key_version: number | null
          previous_osk_key_version: number | null
          refresh_mode: string
          rollback_expires_at: string | null
          rows_failed: number
          rows_processed: number
          rows_total: number
          started_at: string
          started_by: string
          status: string
          trigger_type: string
        }
        Insert: {
          abort_reason?: string | null
          completed_at?: string | null
          error_log?: Json
          id?: string
          new_dek_key_version: number
          new_osk_key_version: number
          org_id: string
          previous_dek_key_version?: number | null
          previous_osk_key_version?: number | null
          refresh_mode?: string
          rollback_expires_at?: string | null
          rows_failed?: number
          rows_processed?: number
          rows_total?: number
          started_at?: string
          started_by: string
          status?: string
          trigger_type: string
        }
        Update: {
          abort_reason?: string | null
          completed_at?: string | null
          error_log?: Json
          id?: string
          new_dek_key_version?: number
          new_osk_key_version?: number
          org_id?: string
          previous_dek_key_version?: number | null
          previous_osk_key_version?: number | null
          refresh_mode?: string
          rollback_expires_at?: string | null
          rows_failed?: number
          rows_processed?: number
          rows_total?: number
          started_at?: string
          started_by?: string
          status?: string
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "key_rotation_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_keys: {
        Row: {
          created_at: string | null
          id: string
          is_placeholder: boolean
          iv: string
          key_version: number
          org_id: string
          updated_at: string | null
          user_id: string
          wrap_algo: string | null
          wrapped_dek: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_placeholder?: boolean
          iv: string
          key_version?: number
          org_id: string
          updated_at?: string | null
          user_id: string
          wrap_algo?: string | null
          wrapped_dek: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_placeholder?: boolean
          iv?: string
          key_version?: number
          org_id?: string
          updated_at?: string | null
          user_id?: string
          wrap_algo?: string | null
          wrapped_dek?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_master_wraps: {
        Row: {
          created_at: string
          key_version: number
          master_wrapped_mek: string
          org_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          key_version?: number
          master_wrapped_mek: string
          org_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          key_version?: number
          master_wrapped_mek?: string
          org_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_master_wraps_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_member_signing_key_wraps: {
        Row: {
          created_at: string
          iv: string
          key_version: number
          org_id: string
          user_id: string
          wrap_algo: string
          wrapped_private_key: string
        }
        Insert: {
          created_at?: string
          iv: string
          key_version?: number
          org_id: string
          user_id: string
          wrap_algo?: string
          wrapped_private_key: string
        }
        Update: {
          created_at?: string
          iv?: string
          key_version?: number
          org_id?: string
          user_id?: string
          wrap_algo?: string
          wrapped_private_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_member_signing_key_wraps_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_member_roles: {
        Row: {
          expires_at: string | null
          granted_at: string
          granted_by: string | null
          id: string
          org_id: string
          revoked_at: string | null
          role_definition_id: string
          source: string
          user_id: string
        }
        Insert: {
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          org_id: string
          revoked_at?: string | null
          role_definition_id: string
          source?: string
          user_id: string
        }
        Update: {
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          org_id?: string
          revoked_at?: string | null
          role_definition_id?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_member_roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_member_roles_role_definition_id_fkey"
            columns: ["role_definition_id"]
            isOneToOne: false
            referencedRelation: "role_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          id: string
          joined_at: string | null
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string | null
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string | null
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_period_closes: {
        Row: {
          closed_at: string
          closed_by: string
          encrypted_note: string | null
          id: string
          key_version: number
          locked_through_date: string
          org_id: string
          reopened_from_id: string | null
        }
        Insert: {
          closed_at?: string
          closed_by: string
          encrypted_note?: string | null
          id?: string
          key_version?: number
          locked_through_date: string
          org_id: string
          reopened_from_id?: string | null
        }
        Update: {
          closed_at?: string
          closed_by?: string
          encrypted_note?: string | null
          id?: string
          key_version?: number
          locked_through_date?: string
          org_id?: string
          reopened_from_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_period_closes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_period_closes_reopened_from_id_fkey"
            columns: ["reopened_from_id"]
            isOneToOne: false
            referencedRelation: "org_period_closes"
            referencedColumns: ["id"]
          },
        ]
      }
      org_primary_currency_history: {
        Row: {
          changed_by: string | null
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          org_id: string
          primary_currency: string
          reason: string
        }
        Insert: {
          changed_by?: string | null
          created_at?: string
          effective_from: string
          effective_to?: string | null
          id?: string
          org_id: string
          primary_currency: string
          reason: string
        }
        Update: {
          changed_by?: string | null
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          org_id?: string
          primary_currency?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_primary_currency_history_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_settings: {
        Row: {
          accounting_framework: string
          accounts_receivable_account_map_id: string | null
          bitcoin_display: string | null
          date_format: string | null
          default_payment_terms_days: number | null
          dek_key_version: number
          enc_mek_ciphertext: string | null
          encrypted_approval_threshold_amount: string | null
          encrypted_approval_threshold_currency: string | null
          encrypted_fiscal_month: string | null
          fiscal_start_month: number | null
          fiscal_year_type: string | null
          fx_translation_method: string
          invoice_email_body_template: string | null
          invoice_email_subject_template: string | null
          invoice_next_number: number
          invoice_prefix: string
          kdf_version: number | null
          key_version: number | null
          number_format: string | null
          org_id: string
          primary_currency: string | null
          public_org_name: string | null
          recovery_ciphertext: string | null
          secondary_currency: string | null
          time_format: string | null
          timezone: string | null
          vault_key_version: number | null
          vault_salt: string | null
          vault_verifier: string | null
        }
        Insert: {
          accounting_framework?: string
          accounts_receivable_account_map_id?: string | null
          bitcoin_display?: string | null
          date_format?: string | null
          default_payment_terms_days?: number | null
          dek_key_version?: number
          enc_mek_ciphertext?: string | null
          encrypted_approval_threshold_amount?: string | null
          encrypted_approval_threshold_currency?: string | null
          encrypted_fiscal_month?: string | null
          fiscal_start_month?: number | null
          fiscal_year_type?: string | null
          fx_translation_method?: string
          invoice_email_body_template?: string | null
          invoice_email_subject_template?: string | null
          invoice_next_number?: number
          invoice_prefix?: string
          kdf_version?: number | null
          key_version?: number | null
          number_format?: string | null
          org_id: string
          primary_currency?: string | null
          public_org_name?: string | null
          recovery_ciphertext?: string | null
          secondary_currency?: string | null
          time_format?: string | null
          timezone?: string | null
          vault_key_version?: number | null
          vault_salt?: string | null
          vault_verifier?: string | null
        }
        Update: {
          accounting_framework?: string
          accounts_receivable_account_map_id?: string | null
          bitcoin_display?: string | null
          date_format?: string | null
          default_payment_terms_days?: number | null
          dek_key_version?: number
          enc_mek_ciphertext?: string | null
          encrypted_approval_threshold_amount?: string | null
          encrypted_approval_threshold_currency?: string | null
          encrypted_fiscal_month?: string | null
          fiscal_start_month?: number | null
          fiscal_year_type?: string | null
          fx_translation_method?: string
          invoice_email_body_template?: string | null
          invoice_email_subject_template?: string | null
          invoice_next_number?: number
          invoice_prefix?: string
          kdf_version?: number | null
          key_version?: number | null
          number_format?: string | null
          org_id?: string
          primary_currency?: string | null
          public_org_name?: string | null
          recovery_ciphertext?: string | null
          secondary_currency?: string | null
          time_format?: string | null
          timezone?: string | null
          vault_key_version?: number | null
          vault_salt?: string | null
          vault_verifier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_signing_keys: {
        Row: {
          algorithm: string
          created_at: string
          created_by: string
          key_version: number
          org_id: string
          public_key_b64: string
        }
        Insert: {
          algorithm?: string
          created_at?: string
          created_by: string
          key_version?: number
          org_id: string
          public_key_b64: string
        }
        Update: {
          algorithm?: string
          created_at?: string
          created_by?: string
          key_version?: number
          org_id?: string
          public_key_b64?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_signing_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          billing_account_id: string | null
          external_journal_id: string | null
          created_at: string | null
          dek_key_version: number
          id: string
          is_archived: boolean | null
          key_version: number | null
          ledger_provisioned_at: string | null
          ledger_status: string
          ledger_status_error: string | null
          name: string
        }
        Insert: {
          billing_account_id?: string | null
          external_journal_id?: string | null
          created_at?: string | null
          dek_key_version?: number
          id?: string
          is_archived?: boolean | null
          key_version?: number | null
          ledger_provisioned_at?: string | null
          ledger_status?: string
          ledger_status_error?: string | null
          name: string
        }
        Update: {
          billing_account_id?: string | null
          external_journal_id?: string | null
          created_at?: string | null
          dek_key_version?: number
          id?: string
          is_archived?: boolean | null
          key_version?: number | null
          ledger_provisioned_at?: string | null
          ledger_status?: string
          ledger_status_error?: string | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_billing_account_id_fkey"
            columns: ["billing_account_id"]
            isOneToOne: false
            referencedRelation: "billing_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_request_line_items: {
        Row: {
          amount: number
          created_at: string
          description: string | null
          encrypted_amount: string | null
          encrypted_description: string | null
          id: string
          key_version: number
          payment_request_id: string
          sort_order: number
        }
        Insert: {
          amount?: number
          created_at?: string
          description?: string | null
          encrypted_amount?: string | null
          encrypted_description?: string | null
          id?: string
          key_version?: number
          payment_request_id: string
          sort_order?: number
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          encrypted_amount?: string | null
          encrypted_description?: string | null
          id?: string
          key_version?: number
          payment_request_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_request_line_items_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_requests: {
        Row: {
          amount: number
          approved_by: string | null
          created_at: string | null
          currency: string
          dek_key_version: number
          document_date: string | null
          due_date: string | null
          encrypted_amount: string | null
          encrypted_description: string | null
          encrypted_metadata: Json | null
          encrypted_payee: string | null
          encrypted_payee_email_snapshot: string | null
          encrypted_payee_phone_snapshot: string | null
          encrypted_rejection_reason: string | null
          id: string
          key_version: number | null
          org_id: string
          paid_at: string | null
          payment_address: string | null
          ref_number: string | null
          request_type: string
          requested_by: string | null
          status: string
          updated_at: string | null
          vendor_ref: string | null
        }
        Insert: {
          amount?: number
          approved_by?: string | null
          created_at?: string | null
          currency?: string
          dek_key_version?: number
          document_date?: string | null
          due_date?: string | null
          encrypted_amount?: string | null
          encrypted_description?: string | null
          encrypted_metadata?: Json | null
          encrypted_payee?: string | null
          encrypted_payee_email_snapshot?: string | null
          encrypted_payee_phone_snapshot?: string | null
          encrypted_rejection_reason?: string | null
          id?: string
          key_version?: number | null
          org_id: string
          paid_at?: string | null
          payment_address?: string | null
          ref_number?: string | null
          request_type?: string
          requested_by?: string | null
          status?: string
          updated_at?: string | null
          vendor_ref?: string | null
        }
        Update: {
          amount?: number
          approved_by?: string | null
          created_at?: string | null
          currency?: string
          dek_key_version?: number
          document_date?: string | null
          due_date?: string | null
          encrypted_amount?: string | null
          encrypted_description?: string | null
          encrypted_metadata?: Json | null
          encrypted_payee?: string | null
          encrypted_payee_email_snapshot?: string | null
          encrypted_payee_phone_snapshot?: string | null
          encrypted_rejection_reason?: string | null
          id?: string
          key_version?: number | null
          org_id?: string
          paid_at?: string | null
          payment_address?: string | null
          ref_number?: string | null
          request_type?: string
          requested_by?: string | null
          status?: string
          updated_at?: string | null
          vendor_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_admin_emails: {
        Row: {
          body_html: string | null
          body_text: string
          created_at: string
          id: string
          sent_at: string | null
          status: string
          subject: string
          to_email: string
        }
        Insert: {
          body_html?: string | null
          body_text: string
          created_at?: string
          id?: string
          sent_at?: string | null
          status?: string
          subject: string
          to_email: string
        }
        Update: {
          body_html?: string | null
          body_text?: string
          created_at?: string
          id?: string
          sent_at?: string | null
          status?: string
          subject?: string
          to_email?: string
        }
        Relationships: []
      }
      pending_invites: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          inviter_id: string
          org_id: string
          recipient_user_id: string | null
          role_definition_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          inviter_id: string
          org_id: string
          recipient_user_id?: string | null
          role_definition_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          inviter_id?: string
          org_id?: string
          recipient_user_id?: string | null
          role_definition_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_invites_role_definition_id_fkey"
            columns: ["role_definition_id"]
            isOneToOne: false
            referencedRelation: "role_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      period_unlock_sessions: {
        Row: {
          created_at: string
          encrypted_reason: string | null
          expires_at: string
          granted_by: string
          id: string
          key_version: number
          org_id: string
          revoked_at: string | null
          unlock_through_date: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_reason?: string | null
          expires_at?: string
          granted_by: string
          id?: string
          key_version?: number
          org_id: string
          revoked_at?: string | null
          unlock_through_date: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_reason?: string | null
          expires_at?: string
          granted_by?: string
          id?: string
          key_version?: number
          org_id?: string
          revoked_at?: string | null
          unlock_through_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "period_unlock_sessions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_events: {
        Row: {
          created_at: string
          id: number
          scope: string
          subject: string
        }
        Insert: {
          created_at?: string
          id?: number
          scope: string
          subject: string
        }
        Update: {
          created_at?: string
          id?: number
          scope?: string
          subject?: string
        }
        Relationships: []
      }
      role_capabilities: {
        Row: {
          capability_key: string
          created_at: string
          role_id: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          role_id: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_capabilities_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capabilities"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "role_capabilities_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "role_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      role_definitions: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          name: string
          org_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          org_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          org_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_definitions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_lifecycle_events: {
        Row: {
          from_status: string | null
          id: string
          occurred_at: string
          reason: string | null
          subscription_id: string
          to_status: string
        }
        Insert: {
          from_status?: string | null
          id?: string
          occurred_at?: string
          reason?: string | null
          subscription_id: string
          to_status: string
        }
        Update: {
          from_status?: string | null
          id?: string
          occurred_at?: string
          reason?: string | null
          subscription_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_lifecycle_events_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          billing_account_id: string
          created_at: string
          currency: string
          current_period_end: string | null
          id: string
          locked_at: string | null
          past_due_since: string | null
          plan: string
          price_cents: number
          scheduled_deletion_at: string | null
          status: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          billing_account_id: string
          created_at?: string
          currency?: string
          current_period_end?: string | null
          id?: string
          locked_at?: string | null
          past_due_since?: string | null
          plan: string
          price_cents: number
          scheduled_deletion_at?: string | null
          status: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          billing_account_id?: string
          created_at?: string
          currency?: string
          current_period_end?: string | null
          id?: string
          locked_at?: string | null
          past_due_since?: string | null
          plan?: string
          price_cents?: number
          scheduled_deletion_at?: string | null
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_billing_account_id_fkey"
            columns: ["billing_account_id"]
            isOneToOne: true
            referencedRelation: "billing_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      support_sessions: {
        Row: {
          end_reason: string | null
          ended_at: string | null
          expires_at: string
          granted_at: string
          granted_by: string
          id: string
          org_id: string
          support_user_id: string
        }
        Insert: {
          end_reason?: string | null
          ended_at?: string | null
          expires_at: string
          granted_at?: string
          granted_by: string
          id?: string
          org_id: string
          support_user_id: string
        }
        Update: {
          end_reason?: string | null
          ended_at?: string | null
          expires_at?: string
          granted_at?: string
          granted_by?: string
          id?: string
          org_id?: string
          support_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_sessions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          account_id: string | null
          amount: number
          asset: string
          cleared_status: string | null
          contact_id: string | null
          created_at: string | null
          created_by: string | null
          date: string
          dek_key_version: number
          encrypted_amount: string | null
          encrypted_exchange_rate: string | null
          encrypted_metadata: Json | null
          encrypted_usd_value: string | null
          exchange_rate: number | null
          hmac_asset: string | null
          hmac_type: string | null
          id: string
          journal_entry_id: string | null
          key_version: number | null
          linked_transfer_id: string | null
          memo: string | null
          org_id: string
          signature_b64: string | null
          signature_key_version: number | null
          status: string | null
          type: string
          usd_value: number | null
          account_id: string | null
        }
        Insert: {
          account_id?: string | null
          amount: number
          asset: string
          cleared_status?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          date?: string
          dek_key_version?: number
          encrypted_amount?: string | null
          encrypted_exchange_rate?: string | null
          encrypted_metadata?: Json | null
          encrypted_usd_value?: string | null
          exchange_rate?: number | null
          hmac_asset?: string | null
          hmac_type?: string | null
          id?: string
          journal_entry_id?: string | null
          key_version?: number | null
          linked_transfer_id?: string | null
          memo?: string | null
          org_id: string
          signature_b64?: string | null
          signature_key_version?: number | null
          status?: string | null
          type: string
          usd_value?: number | null
          wallet_id?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number
          asset?: string
          cleared_status?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          date?: string
          dek_key_version?: number
          encrypted_amount?: string | null
          encrypted_exchange_rate?: string | null
          encrypted_metadata?: Json | null
          encrypted_usd_value?: string | null
          exchange_rate?: number | null
          hmac_asset?: string | null
          hmac_type?: string | null
          id?: string
          journal_entry_id?: string | null
          key_version?: number | null
          linked_transfer_id?: string | null
          memo?: string | null
          org_id?: string
          signature_b64?: string | null
          signature_key_version?: number | null
          status?: string | null
          type?: string
          usd_value?: number | null
          wallet_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_linked_transfer_id_fkey"
            columns: ["linked_transfer_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_wallet_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      user_last_seen_key_versions: {
        Row: {
          dek_key_version: number
          org_id: string
          osk_key_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          dek_key_version?: number
          org_id: string
          osk_key_version?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          dek_key_version?: number
          org_id?: string
          osk_key_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_last_seen_key_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_master_recovery: {
        Row: {
          created_at: string
          key_version: number
          master_salt: string
          master_verifier_ciphertext: string
          rotated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          key_version?: number
          master_salt: string
          master_verifier_ciphertext: string
          rotated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          key_version?: number
          master_salt?: string
          master_verifier_ciphertext?: string
          rotated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_vault_keys: {
        Row: {
          created_at: string
          encrypted_private_key: string
          iv: string
          key_algorithm: string
          public_key_b64: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_private_key: string
          iv: string
          key_algorithm?: string
          public_key_b64: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_private_key?: string
          iv?: string
          key_algorithm?: string
          public_key_b64?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      vault_security_events: {
        Row: {
          created_at: string
          event: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      accounts: {
        Row: {
          asset: string
          external_account_code: string | null
          external_account_id: string | null
          connection_type: string | null
          created_at: string | null
          dek_key_version: number
          encrypted_balance: string | null
          encrypted_metadata: Json | null
          encrypted_name: string
          exchange_rate: number | null
          id: string
          initial_balance: number | null
          key_version: number | null
          last_sync_at: string | null
          org_id: string
          sync_status: string | null
          account_type: string | null
        }
        Insert: {
          asset?: string
          external_account_code?: string | null
          external_account_id?: string | null
          connection_type?: string | null
          created_at?: string | null
          dek_key_version?: number
          encrypted_balance?: string | null
          encrypted_metadata?: Json | null
          encrypted_name: string
          exchange_rate?: number | null
          id?: string
          initial_balance?: number | null
          key_version?: number | null
          last_sync_at?: string | null
          org_id: string
          sync_status?: string | null
          wallet_type?: string | null
        }
        Update: {
          asset?: string
          external_account_code?: string | null
          external_account_id?: string | null
          connection_type?: string | null
          created_at?: string | null
          dek_key_version?: number
          encrypted_balance?: string | null
          encrypted_metadata?: Json | null
          encrypted_name?: string
          exchange_rate?: number | null
          id?: string
          initial_balance?: number | null
          key_version?: number | null
          last_sync_at?: string | null
          org_id?: string
          sync_status?: string | null
          wallet_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wallets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      advance_rotation_job: {
        Args: { p_job_id: string; p_new_status: string }
        Returns: undefined
      }
      apply_invoice_payment: {
        Args: {
          p_amount_applied: number
          p_applied_rate?: number
          p_encrypted_amount_applied: string
          p_encrypted_notes?: string
          p_invoice_id: string
          p_transaction_id: string
        }
        Returns: {
          invoice_amount: number
          invoice_status: string
          je_id: string
          je_posted: boolean
          payment_id: string
          total_applied: number
        }[]
      }
      approve_payment_request: {
        Args: { new_status_ciphertext: string; request_id: string }
        Returns: undefined
      }
      check_vault_unlock_rate_limit: {
        Args: never
        Returns: {
          cooldown_until: string
          failed_count: number
          ok: boolean
          window_minutes: number
        }[]
      }
      current_user_org_rank: { Args: { org: string }; Returns: number }
      expire_time_boxed_roles: {
        Args: never
        Returns: {
          expired_roles: number
          expired_sessions: number
        }[]
      }
      get_public_invoice: {
        Args: { p_url_id: string }
        Returns: {
          currency: string
          due_date: string
          encrypted_share_blob: string
          expires_at: string
          issue_date: string
          org_public_name: string
          sent_at: string
          status: string
          view_count: number
        }[]
      }
      is_date_in_closed_period: {
        Args: { at_date: string; p_org_id: string; p_user_id: string }
        Returns: boolean
      }
      is_email_in_beta_allowlist: {
        Args: { p_email: string }
        Returns: boolean
      }
      log_billing_access: {
        Args: { p_access_context: string; p_billing_account_id: string }
        Returns: string
      }
      merge_invoice_payment: {
        Args: {
          p_invoice_payment_id: string
          p_new_transaction_id: string
          p_signature_b64: string
          p_signature_key_version: number
        }
        Returns: {
          invoice_id: string
          je_posted_id: string
          je_reversed_id: string
          new_transaction_id: string
          noop: boolean
          payment_id: string
          superseded_transaction_id: string
        }[]
      }
      next_invoice_number: { Args: { p_org_id: string }; Returns: string }
      next_je_ref_number: {
        Args: { p_org_id: string; p_year: number }
        Returns: string
      }
      owb_je_is_locked: { Args: { p_je_id: string }; Returns: boolean }
      owb_test_seed_je: {
        Args: { p_lines: Json; p_status: string }
        Returns: string
      }
      pqc_verify_ml_dsa_65: {
        Args: {
          p_payload: string
          p_public_key_b64: string
          p_signature_b64: string
        }
        Returns: boolean
      }
      purge_expired_old_key_wraps: { Args: never; Returns: number }
      purge_import_job_artifacts: {
        Args: { p_import_job_id: string }
        Returns: Json
      }
      rate_limit_try: {
        Args: {
          max_per_window: number
          scope_in: string
          subject_in: string
          window_seconds: number
        }
        Returns: boolean
      }
      record_public_invoice_view: {
        Args: { p_url_id: string }
        Returns: boolean
      }
      reject_payment_request: {
        Args: {
          new_status_ciphertext: string
          rejection_reason_ciphertext: string
          request_id: string
        }
        Returns: undefined
      }
      rpc_upgrade_vault_to_v3: {
        Args: {
          p_new_salt: string
          p_new_verifier: string
          p_org_id: string
          p_updates: Json
        }
        Returns: undefined
      }
      user_has_capability: {
        Args: { p_capability: string; p_org_id: string; p_user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
