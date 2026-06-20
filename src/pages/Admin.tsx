import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useVault } from '@/context/VaultContext';
import { Settings, Users, BookOpen, Contact, Plug, Plus, Search, Pencil, Trash2, ChevronDown, ChevronRight, Upload, Zap, RefreshCw, ArrowLeftRight, Landmark, CheckCircle2, XCircle, Loader2, Key, KeyRound, Mail, ExternalLink, LayoutGrid, List, Archive, ArchiveRestore, ShieldCheck, Shield, Clock, Lock, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { writeAuditLog } from '@/lib/audit-logger';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useOrgSettings } from '@/hooks/useOrgSettings';
import { useCapability } from '@/hooks/useCapability';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { ImportPopup } from '@/components/ui/import-popup';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';
import { QuickBooksImportWizard } from '@/components/imports/QuickBooksImportWizard';
import { ImportFromOrangeRailsWizard } from '@/components/imports/ImportFromOrangeRailsWizard';
import {
  commitAccountsFromStaged,
  commitContactsFromStaged,
  commitJournalEntriesFromStaged,
  type ImportDeps,
} from '@/lib/import-from-orange-rails/handlers';
import { parseCsvContacts, CONTACT_COLUMNS, CONTACT_SAMPLE_CSV } from '@/lib/csv/contacts';
import { parseCsvChartOfAccounts, COA_COLUMNS, CHART_OF_ACCOUNTS_SAMPLE_CSV } from '@/lib/csv/chart-of-accounts';
import { encryptOrganization, decryptOrganization, encryptContact, decryptContact, encryptOrgSettings, decryptOrgSettings, encryptChartOfAccount, decryptChartOfAccount } from '@/lib/crypto-fields';
import { buildTakeoutFile, downloadTakeout } from '@/lib/takeout/export';
import { importTakeoutFile, wipeOrgData } from '@/lib/takeout/import';
import type { TakeoutFile } from '@/lib/takeout/schema';
import { generateMinerCompany } from '@/lib/takeout/seed/miner-company';
import { generateCoffeeShop } from '@/lib/takeout/seed/coffee-shop';
// Phase 2 removal: chart_of_accounts is Postgres-only. No more legacy ledger account
// provisioning during CSV import of accounts.
function humanizeLegacyClientError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
import { RateTransparency } from '@/pages/admin/RateTransparency';
import { BackfillRates } from '@/pages/admin/BackfillRates';
import { SecurityTab } from '@/pages/admin/SecurityTab';
import { RevaluationWizard } from '@/components/fx-revaluation/RevaluationWizard';
import { AccountingFramework } from '@/pages/settings/AccountingFramework';
import { ChangePrimaryCurrency } from '@/pages/settings/ChangePrimaryCurrency';
import { FxExposureDashboard } from '@/components/fx-exposure/FxExposureDashboard';
import Roles from '@/pages/settings/Roles';
import {
  generatePlaceholderOrgDek,
  wrapOrgDekForRecipient,
  lookupRecipientPublicKey,
} from '@/lib/invite-wrap';
import RekeyWizard from '@/components/rekey/RekeyWizard';

/* ───── types ───── */
type Tab = 'organization' | 'users' | 'roles' | 'coa' | 'contacts' | 'connectors' | 'data' | 'or-import' | 'rates' | 'backfill' | 'revaluation' | 'framework' | 'currency' | 'exposure' | 'security';
type CoaSubTab = 'income-expense' | 'balance-sheet';

const CURRENCIES = [
  'BTC', 'SATS',
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF',
  'MXN', 'BRL', 'CLP', 'COP', 'PEN', 'ARS',
  'SGD', 'HKD', 'INR', 'KRW', 'THB', 'IDR', 'MYR', 'PHP',
  'NOK', 'SEK', 'DKK', 'CZK', 'PLN', 'HUF', 'TRY',
  'ILS', 'AED', 'ZAR', 'NZD',
];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const IE_GROUPS = [
  { name: 'Sales', type: 'INCOME' },
  { name: 'Other Income', type: 'INCOME' },
  { name: 'Uncategorized Income', type: 'INCOME' },
  { name: 'Cost of Sales', type: 'EXPENSE' },
  { name: 'Sales & Marketing', type: 'EXPENSE' },
  { name: 'Labor', type: 'EXPENSE' },
  { name: 'General & Administrative', type: 'EXPENSE' },
  { name: 'Other Expenses', type: 'EXPENSE' },
  { name: 'Uncategorized Expenses', type: 'EXPENSE' },
];
const BS_GROUPS = [
  { name: 'Cash', type: 'ASSETS' },
  { name: 'Other Current Assets', type: 'ASSETS' },
  { name: 'Fixed Assets', type: 'ASSETS' },
  { name: 'Other Assets', type: 'ASSETS' },
  { name: 'Current Liabilities', type: 'LIABILITIES' },
  { name: 'Long-Term Liabilities', type: 'LIABILITIES' },
  { name: "Owner's Equity", type: 'EQUITY' },
  { name: 'Retained Earnings', type: 'EQUITY' },
  { name: 'Dividends Paid', type: 'EQUITY' },
];

function typeBadgeColor(t: string) {
  switch (t) {
    case 'INCOME': return 'bg-green-100 text-green-800';
    case 'EXPENSE': return 'bg-red-100 text-red-800';
    case 'ASSETS': return 'bg-blue-100 text-blue-800';
    case 'LIABILITIES': return 'bg-amber-100 text-amber-800';
    case 'EQUITY': return 'bg-purple-100 text-purple-800';
    default: return 'bg-gray-100 text-gray-800';
  }
}

const ADMIN_TAB_KEYS: Tab[] = [
  'organization','users','roles','coa','contacts','connectors','data','or-import',
  'rates','backfill','revaluation','framework','currency','exposure','security',
];

function isValidTab(v: string | null): v is Tab {
  return !!v && (ADMIN_TAB_KEYS as string[]).includes(v);
}

export default function Admin() {
  const { orgId, allOrgs, switchOrg } = useUserOrg();
  const { settings: orgSettings } = useOrgSettings();
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link via ?tab=<key>. Defaults to 'organization'. Used by the
  // /settings/roles → /admin?tab=roles redirect so existing links land on
  // the new canonical location.
  const initialTab: Tab = isValidTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as Tab)
    : 'organization';
  const [tab, setTab] = useState<Tab>(initialTab);

  // Keep URL and state in sync when the user clicks a tab.
  const handleSetTab = (next: Tab) => {
    setTab(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'organization') nextParams.delete('tab');
    else nextParams.set('tab', next);
    setSearchParams(nextParams, { replace: true });
  };

  // If the URL changes externally (e.g. browser back/forward), follow it.
  useEffect(() => {
    const q = searchParams.get('tab');
    if (isValidTab(q) && q !== tab) setTab(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'organization', label: 'Organization', icon: <Settings className="w-4 h-4" /> },
    { key: 'users', label: 'Users', icon: <Users className="w-4 h-4" /> },
    { key: 'roles', label: 'Roles', icon: <Shield className="w-4 h-4" /> },
    { key: 'coa', label: 'Chart of Accounts', icon: <BookOpen className="w-4 h-4" /> },
    { key: 'contacts', label: 'To/From List', icon: <Contact className="w-4 h-4" /> },
    { key: 'connectors', label: 'Connectors', icon: <Plug className="w-4 h-4" /> },
    { key: 'data', label: 'Data', icon: <Archive className="w-4 h-4" /> },
    { key: 'or-import', label: 'Import (Orange Rails)', icon: <Upload className="w-4 h-4" /> },
    { key: 'rates', label: 'Exchange Rates', icon: <ArrowLeftRight className="w-4 h-4" /> },
    { key: 'backfill', label: 'Backfill Rates', icon: <RefreshCw className="w-4 h-4" /> },
    { key: 'revaluation', label: 'FX Revaluation', icon: <Landmark className="w-4 h-4" /> },
    { key: 'framework', label: 'Framework', icon: <BookOpen className="w-4 h-4" /> },
    { key: 'currency', label: 'Change Currency', icon: <ArrowLeftRight className="w-4 h-4" /> },
    { key: 'exposure', label: 'FX Exposure', icon: <Zap className="w-4 h-4" /> },
    { key: 'security', label: 'Security', icon: <ShieldCheck className="w-4 h-4" /> },
    { key: 'audit-log', label: 'Audit Log', icon: <Clock className="w-4 h-4" /> },
    { key: 'period-close', label: 'Period Close', icon: <Lock className="w-4 h-4" /> },
    { key: 'beta', label: 'Beta Allowlist', icon: <Mail className="w-4 h-4" /> },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Admin</h1>
      <p className="text-sm text-muted-foreground mb-6">Organization settings and team management</p>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => handleSetTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? 'border-[var(--color-brand-orange)] text-[var(--color-brand-orange)]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'organization' && <OrganizationTab orgId={orgId} switchOrg={switchOrg} />}
      {tab === 'users' && <UsersTab orgId={orgId} onManageRoles={() => handleSetTab('roles')} />}
      {tab === 'roles' && <Roles embedded />}
      {tab === 'coa' && <ChartOfAccountsTab orgId={orgId} />}
      {tab === 'contacts' && <ContactsTab orgId={orgId} />}
      {tab === 'connectors' && <ConnectorsTab orgId={orgId} />}
      {tab === 'data' && <DataTab orgId={orgId} />}
      {tab === 'or-import' && <OrangeRailsImportTab orgId={orgId} />}
      {tab === 'rates' && <RateTransparency orgId={orgId} />}
      {tab === 'backfill' && <BackfillRates orgId={orgId} />}
      {tab === 'revaluation' && <RevaluationWizard orgId={orgId} />}
      {tab === 'framework' && <AccountingFramework orgId={orgId} />}
      {tab === 'currency' && <ChangePrimaryCurrency orgId={orgId} currentPrimary={orgSettings.primaryCurrency} />}
      {tab === 'exposure' && <FxExposureDashboard orgId={orgId} primaryCurrency={orgSettings.primaryCurrency} />}
      {tab === 'security' && <SecurityTab orgId={orgId} />}
      {tab === 'audit-log' && <AuditLogTab orgId={orgId} />}
      {tab === 'period-close' && <PeriodCloseTab orgId={orgId} />}
      {tab === 'beta' && <BetaAllowlistTab />}
    </div>
  );
}

/* ═══════════════════════════ Organization Tab ═══════════════════════════ */
interface OrgTile {
  id: string;
  name: string;
  is_archived: boolean;
}

function OrganizationTab({ orgId, switchOrg }: { orgId: string | null; switchOrg: (id: string) => void }) {
  const { encryptText, decryptText } = useVault();
  // Capability gate, UI presence only. Members lacking org.manage see a
  // read-only view of organization data; RLS still authoritative on writes.
  const canManageOrg = useCapability('org.manage', orgId);
  const [saving, setSaving] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgs, setOrgs] = useState<OrgTile[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showArchived, setShowArchived] = useState(false);

  // Add Org modal
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // Edit Org modal
  const [editOpen, setEditOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<OrgTile | null>(null);
  const [editName, setEditName] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Settings
  const [settings, setSettings] = useState({
    primary_currency: 'USD',
    secondary_currency: 'BTC' as string | null,
    bitcoin_display: 'sats',
    fiscal_year_type: 'calendar',
    fiscal_start_month: 1,
    journal_lock_date: '' as string,
    date_format: 'MM-DD-YYYY',
    time_format: '12h',
    number_format: 'us',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // T4 PR C, approval threshold for payment requests.
    approval_threshold_amount: null as number | null,
    approval_threshold_currency: '' as string,
  });
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const showBtcPref = settings.primary_currency === 'BTC' | settings.secondary_currency === 'BTC';

  const fetchOrgs = useCallback(async () => {
    setOrgsLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setOrgsLoading(false); return; }

    const { data: memberships } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id);
    if (!memberships?.length) { setOrgsLoading(false); return; }

    const orgIds = memberships.map(m => m.org_id);
    const { data: orgRows } = await supabase
      .from('organizations')
      .select('id, name, key_version, is_archived')
      .in('id', orgIds);

    if (orgRows) {
      const decrypted: OrgTile[] = await Promise.all(
        orgRows.map(async (org) => {
          const dec = await decryptOrganization(org, decryptText);
          return { id: org.id, name: dec.name, is_archived: org.is_archived ?? false };
        })
      );
      setOrgs(decrypted);
    }
    setOrgsLoading(false);
  }, [decryptText]);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data: org } = await supabase.from('organizations').select('name, key_version').eq('id', orgId).maybeSingle();
      if (org) {
        const decrypted = await decryptOrganization(org, decryptText);
        setOrgName(decrypted.name);
      }
      const { data: s } = await supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle();
      if (s) {
        const dec = await decryptOrgSettings(s, decryptText);
        setSettings({
          primary_currency: dec.primary_currency | 'USD',
          secondary_currency: dec.secondary_currency | null,
          bitcoin_display: dec.bitcoin_display | 'sats',
          fiscal_year_type: dec.fiscal_year_type | 'calendar',
          fiscal_start_month: dec.fiscal_start_month | 1,
          journal_lock_date: s.journal_lock_date | '',
          date_format: dec.date_format | 'MM-DD-YYYY',
          time_format: dec.time_format | '12h',
          number_format: dec.number_format | 'us',
          timezone: dec.timezone | Intl.DateTimeFormat().resolvedOptions().timeZone,
          approval_threshold_amount: dec.approval_threshold_amount ?? null,
          approval_threshold_currency: dec.approval_threshold_currency | '',
        });
      }
    })();
  }, [orgId]);

  const handleSave = async () => {
    if (!orgId) return;
    setSaving(true);
    const enc = await encryptOrgSettings({
      primary_currency: settings.primary_currency,
      secondary_currency: settings.secondary_currency | null,
      bitcoin_display: settings.bitcoin_display,
      fiscal_year_type: settings.fiscal_year_type,
      fiscal_start_month: settings.fiscal_start_month,
      date_format: settings.date_format,
      time_format: settings.time_format,
      number_format: settings.number_format,
      timezone: settings.timezone,
      // T4 PR C, approval threshold. NULL when input is empty.
      approval_threshold_amount: settings.approval_threshold_amount,
      approval_threshold_currency: settings.approval_threshold_currency | null,
    }, encryptText);
    await supabase.from('org_settings').upsert({
      org_id: orgId,
      ...enc,
      secondary_currency: enc.secondary_currency | null,
      journal_lock_date: settings.journal_lock_date | null,
    }, { onConflict: 'org_id' });
    writeAuditLog({ orgId, action: 'UPDATE', entityType: 'org_settings', entityId: orgId, summary: 'Updated organization settings', encrypt: encryptText });
    setSaving(false);
    toast.success('Settings saved');
  };

  const handleAddOrg = async () => {
    if (!addName.trim()) return;
    setAddSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error('Not authenticated'); setAddSaving(false); return; }

      const enc = await encryptOrganization({ name: addName.trim() }, encryptText);
      const { data: newOrg, error: orgError } = await supabase
        .from('organizations')
        .insert({ ...enc, is_archived: false })
        .select('id')
        .single();

      if (orgError || !newOrg) {
        toast.error(`Failed to create org: ${orgError?.message | 'Unknown error'}`);
        setAddSaving(false);
        return;
      }

      // Ensure the creator is OWNER of the new org.
      // An AFTER INSERT trigger on organizations handles this automatically
      // but we upsert defensively in case the trigger hasn't been deployed.
      await supabase.from('org_members').upsert(
        { org_id: newOrg.id, user_id: user.id, role: 'OWNER' },
        { onConflict: 'user_id,org_id' },
      );

      // Create default org_settings
      const defaultSettings = await encryptOrgSettings({
        primary_currency: 'USD',
        secondary_currency: null,
        bitcoin_display: 'sats',
        fiscal_year_type: 'calendar',
        fiscal_start_month: 1,
        date_format: 'MM-DD-YYYY',
        time_format: '12h',
        number_format: 'us',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, encryptText);
      await supabase.from('org_settings').insert({
        org_id: newOrg.id,
        ...defaultSettings,
      });

      writeAuditLog({ orgId: newOrg.id, action: 'CREATE', entityType: 'organization', entityId: newOrg.id, summary: `Created organization: ${addName.trim()}`, encrypt: encryptText });
      toast.success('Organization created');
      setAddOpen(false);
      setAddName('');
      fetchOrgs();
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
    setAddSaving(false);
  };

  const handleEditSave = async () => {
    if (!editOrg || !editName.trim()) return;
    setEditSaving(true);
    try {
      const enc = await encryptOrganization({ name: editName.trim() }, encryptText);
      await supabase.from('organizations').update({ ...enc }).eq('id', editOrg.id);
      toast.success('Organization renamed');
      setEditOpen(false);
      setEditOrg(null);
      fetchOrgs();
      if (editOrg.id === orgId) setOrgName(editName.trim());
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
    setEditSaving(false);
  };

  const handleArchiveToggle = async (org: OrgTile) => {
    const newArchived = !org.is_archived;
    await supabase.from('organizations').update({ is_archived: newArchived }).eq('id', org.id);
    toast.success(newArchived ? 'Organization archived' : 'Organization unarchived');
    fetchOrgs();
  };

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0]?.[0] | '?').toUpperCase();
  };

  const visibleOrgs = showArchived ? orgs : orgs.filter(o => !o.is_archived);
  const archivedCount = orgs.filter(o => o.is_archived).length;
  const fiscalEnd = (settings.fiscal_start_month + 10) % 12;

  return (
    <div className="space-y-8">
      {/* ── Your Organizations ── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Your Organizations</h2>
          <div className="flex items-center gap-2">
            {archivedCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)} className="text-xs text-muted-foreground">
                <Archive className="w-3.5 h-3.5 mr-1" />
                {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})
              </Button>
            )}
            <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`} title="Grid view">
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode('list')} className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`} title="List view">
              <List className="w-4 h-4" />
            </button>
            {canManageOrg && (
              <Button size="sm" onClick={() => { setAddName(''); setAddOpen(true); }} className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" data-testid="org-add">
                <Plus className="w-4 h-4 mr-1" /> Add Organization
              </Button>
            )}
          </div>
        </div>

        {orgsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : visibleOrgs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">No organizations yet. Create one to get started.</div>
        ) : (
          <div className={viewMode === 'grid' ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-3'}>
            {visibleOrgs.map(org => {
              const isActive = org.id === orgId;
              return (
                <div
                  key={org.id}
                  className={`relative border rounded-lg p-4 transition-colors ${
                    isActive
                      ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange-light)]'
                      : org.is_archived
                        ? 'border-border bg-muted/30 opacity-60'
                        : 'border-border bg-card hover:border-[var(--color-brand-orange)]/50'
                  } ${!isActive && !org.is_archived ? 'cursor-pointer' : ''}`}
                  onClick={() => { if (!isActive && !org.is_archived) switchOrg(org.id); }}
                >
                  <div className={`flex items-center gap-3 ${viewMode === 'list' ? '' : 'flex-col text-center'}`}>
                    <div
                      className="flex items-center justify-center flex-shrink-0"
                      style={{
                        width: viewMode === 'grid' ? 48 : 40,
                        height: viewMode === 'grid' ? 48 : 40,
                        borderRadius: '50%',
                        background: isActive ? 'var(--color-brand-orange)' : 'var(--color-gray-200)',
                        color: isActive ? 'white' : 'var(--color-gray-600)',
                        fontSize: viewMode === 'grid' ? 16 : 14,
                        fontWeight: 700,
                      }}
                    >
                      {getInitials(org.name)}
                    </div>
                    <div className={viewMode === 'list' ? 'flex-1 min-w-0' : ''}>
                      <div className="font-semibold text-sm text-foreground truncate">{org.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {org.is_archived ? 'Archived' : isActive ? 'Active organization' : 'Click to switch'}
                      </div>
                    </div>
                    <div className={`flex items-center gap-1 ${viewMode === 'grid' ? 'absolute top-2 right-2' : ''}`}>
                      {org.is_archived ? (
                        <button onClick={(e) => { e.stopPropagation(); handleArchiveToggle(org); }} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="Unarchive">
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); setEditOrg(org); setEditName(org.name); setEditOpen(true); }} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="Edit">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Settings for Active Org ── */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Settings: {orgName || 'Active Organization'}</h2>
      </div>

      <div className="max-w-2xl space-y-8">
        {/* Primary Currency */}
        <div className="space-y-2">
          <Label className="font-semibold">Primary Accounting Currency</Label>
          <Select value={settings.primary_currency} onValueChange={v => setSettings(p => ({ ...p, primary_currency: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {/* BTC Display */}
        {showBtcPref && (
          <div className="space-y-2">
            <Label className="font-semibold">Bitcoin Display Preference</Label>
            <div className="flex flex-wrap gap-3">
              {[
                { val: 'btc', label: 'BTC 1.50000000' },
                { val: 'btc-easy', label: 'BTC 0.00 050 000' },
                { val: 'sats', label: '⚡ 1,500,000' },
                { val: 'bitcoins', label: '₿ 1,500,000' },
              ].map(o => (
                <label key={o.val} className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-sm ${settings.bitcoin_display === o.val ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange-light)]' : 'border-border'}`}>
                  <input type="radio" name="btc-display" checked={settings.bitcoin_display === o.val} onChange={() => setSettings(p => ({ ...p, bitcoin_display: o.val }))} className="sr-only" />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Secondary Currency */}
        <div className="space-y-2">
          <Label className="font-semibold">Secondary Reporting Currency</Label>
          <Select value={settings.secondary_currency || 'none'} onValueChange={v => setSettings(p => ({ ...p, secondary_currency: v === 'none' ? null : v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {CURRENCIES.filter(c => c !== settings.primary_currency).map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Accounting Year */}
        <div className="space-y-2">
          <Label className="font-semibold">Accounting Year</Label>
          <div className="flex gap-4">
            {['calendar', 'fiscal'].map(v => (
              <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="fy-type" checked={settings.fiscal_year_type === v} onChange={() => setSettings(p => ({ ...p, fiscal_year_type: v }))} />
                {v === 'calendar' ? 'Calendar Year' : 'Fiscal Year'}
              </label>
            ))}
          </div>
          {settings.fiscal_year_type === 'fiscal' && (
            <div className="flex gap-4 mt-2">
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">Start Month</Label>
                <Select value={String(settings.fiscal_start_month)} onValueChange={v => setSettings(p => ({ ...p, fiscal_start_month: Number(v) }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">End Month</Label>
                <Input disabled value={MONTHS[fiscalEnd]} />
              </div>
            </div>
          )}
        </div>

        {/* Journal Lock Date */}
        <div className="space-y-2">
          <Label className="font-semibold">Journal Lock Date</Label>
          <Input type="date" value={settings.journal_lock_date} onChange={e => setSettings(p => ({ ...p, journal_lock_date: e.target.value }))} className="max-w-xs" />
          <p className="text-xs text-muted-foreground">Entries on or before this date cannot be edited.</p>
        </div>

        {/* Approval Threshold (T4 PR C). When set, any payment
            request submitted with an amount over this threshold (and in the
            matching currency) is auto-flagged PENDING regardless of who
            created it. Leave amount empty to disable. */}
        <div className="space-y-2">
          <Label className="font-semibold">Payment Approval Threshold</Label>
          <div className="flex gap-2 max-w-md">
            <Input
              type="number"
              placeholder="e.g. 5000"
              min="0"
              step="any"
              value={settings.approval_threshold_amount ?? ''}
              onChange={e => {
                const v = e.target.value;
                setSettings(p => ({ ...p, approval_threshold_amount: v ? Number(v) : null }));
              }}
              className="flex-1"
            />
            <Select
              value={settings.approval_threshold_currency || 'USD'}
              onValueChange={v => setSettings(p => ({ ...p, approval_threshold_currency: v }))}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'BTC', 'SATS'].map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Any payment request over this amount auto-flags as Pending for approval, regardless of who submitted it. Leave blank to disable.
          </p>
        </div>

        {/* Date Format */}
        <div className="space-y-2">
          <Label className="font-semibold">Date Format</Label>
          <div className="flex gap-4">
            {['MM-DD-YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD'].map(f => (
              <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="date-fmt" checked={settings.date_format === f} onChange={() => setSettings(p => ({ ...p, date_format: f }))} />
                {f}
              </label>
            ))}
          </div>
        </div>

        {/* Time Format */}
        <div className="space-y-2">
          <Label className="font-semibold">Time Format</Label>
          <div className="flex gap-4">
            {[{ v: '12h', l: '12-hour' }, { v: '24h', l: '24-hour' }].map(o => (
              <label key={o.v} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="time-fmt" checked={settings.time_format === o.v} onChange={() => setSettings(p => ({ ...p, time_format: o.v }))} />
                {o.l}
              </label>
            ))}
          </div>
        </div>

        {/* Number Format */}
        <div className="space-y-2">
          <Label className="font-semibold">Number Format</Label>
          <div className="flex gap-4">
            {[{ v: 'us', l: 'US / Standard (1,250.00)' }, { v: 'eu', l: 'EU / International (1.250,00)' }].map(o => (
              <label key={o.v} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="num-fmt" checked={settings.number_format === o.v} onChange={() => setSettings(p => ({ ...p, number_format: o.v }))} />
                {o.l}
              </label>
            ))}
          </div>
        </div>

        {/* Timezone */}
        <div className="space-y-2">
          <Label className="font-semibold">Timezone</Label>
          <Select value={settings.timezone} onValueChange={v => setSettings(p => ({ ...p, timezone: v }))}>
            <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[
                { value: 'America/New_York', label: 'Eastern Time (US)' },
                { value: 'America/Chicago', label: 'Central Time (US)' },
                { value: 'America/Denver', label: 'Mountain Time (US)' },
                { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
                { value: 'America/Anchorage', label: 'Alaska Time' },
                { value: 'Pacific/Honolulu', label: 'Hawaii Time' },
                { value: 'America/Toronto', label: 'Toronto (Eastern)' },
                { value: 'America/Vancouver', label: 'Vancouver (Pacific)' },
                { value: 'Europe/London', label: 'London (GMT)' },
                { value: 'Europe/Paris', label: 'Paris (CET)' },
                { value: 'Europe/Berlin', label: 'Berlin (CET)' },
                { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
                { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
                { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
                { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
                { value: 'Pacific/Auckland', label: 'Auckland (NZST)' },
              ].map(tz => <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {canManageOrg && (
          <Button onClick={handleSave} disabled={saving} className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" data-testid="org-save-settings">
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        )}

        {/* Danger Zone */}
        {canManageOrg && (
          <div className="border-t border-border pt-6 mt-8">
            <h3 className="text-sm font-semibold text-red-600 mb-2">Danger Zone</h3>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" onClick={() => setDeleteModal(true)} data-testid="org-delete">Delete Organization</Button>
              <Button asChild variant="outline" className="border-red-300 text-red-700 hover:bg-red-50">
                <Link to="/app/settings/demo-data">Wipe bookkeeping data</Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2 max-w-2xl">
              "Delete Organization" removes the whole workspace. "Wipe bookkeeping data" empties the bookkeeping
              tables but keeps your membership, billing, and the organization record, useful for resetting a demo
              org or a test account.
            </p>
          </div>
        )}
      </div>

      {/* ── Add Organization Modal ── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Organization</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Organization Name *</Label>
              <Input value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. My Company LLC" onKeyDown={e => { if (e.key === 'Enter' && addName.trim()) handleAddOrg(); }} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" disabled={!addName.trim() || addSaving} onClick={handleAddOrg}>
              {addSaving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Creating...</> : 'Create Organization'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Organization Modal ── */}
      <Dialog open={editOpen} onOpenChange={v => { if (!v) { setEditOpen(false); setEditOrg(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Organization</DialogTitle></DialogHeader>
          {editOrg && (
            <div className="space-y-4">
              <div>
                <Label>Organization Name *</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && editName.trim()) handleEditSave(); }} />
              </div>
              <div className="border-t border-border pt-4">
                <Button variant="outline" size="sm" onClick={() => { handleArchiveToggle(editOrg); setEditOpen(false); setEditOrg(null); }} className="text-muted-foreground">
                  <Archive className="w-4 h-4 mr-1" />
                  {editOrg.is_archived ? 'Unarchive Organization' : 'Archive Organization'}
                </Button>
                <p className="text-xs text-muted-foreground mt-1">
                  {editOrg.is_archived ? 'Unarchive to make this organization active again.' : 'Archived organizations are hidden from the main view but not deleted.'}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditOpen(false); setEditOrg(null); }}>Cancel</Button>
            <Button className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" disabled={!editName.trim() || editSaving} onClick={handleEditSave}>
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Organization Modal ── */}
      <Dialog open={deleteModal} onOpenChange={setDeleteModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Organization</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Type <strong>{orgName}</strong> to confirm deletion. This action cannot be undone.</p>
          <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="Organization name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteModal(false)}>Cancel</Button>
            <Button variant="destructive" disabled={deleteConfirm !== orgName || saving} onClick={async () => {
              if (!orgId) return;
              setSaving(true);
              const { error } = await supabase.from('organizations').delete().eq('id', orgId);
              setSaving(false);
              if (error) {
                toast.error(`Delete failed: ${error.message}`);
              } else {
                toast.success('Organization deleted');
                setDeleteModal(false);
                localStorage.removeItem('owb_active_org');
                window.location.href = '/';
              }
            }}>{saving ? 'Deleting...' : 'Delete Forever'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ═══════════════════════════ Users Tab ═══════════════════════════ */

// Phase 4.2 clean-cut (post-dual-write): role grants live entirely in
// `role_definitions` + `org_member_roles`. The invite-org-member edge
// function accepts a `role_definition_id` UUID, creates the auth user
// (if new), inserts the `org_members` membership row, and inserts the
// `org_member_roles` capability grant in one shot. The legacy
// `org_members.role` column still exists but we no longer write to it —
// it falls through to its schema default until the schema default is dropped
// the column.
//
// UsersTab reads role names from `org_member_roles → role_definitions(name)`.
// The Edit User dialog is a pure info view + "Manage role assignments"
// jump to the Roles tab, it never writes to `org_members.role`. Role
// changes happen exclusively through the Roles-tab UserAssignmentSection
// (Grant / Revoke against `role_definitions`).

interface RolePreset {
  id: string;
  name: string;
  description: string | null;
}

interface MemberRoleGrant {
  /** org_member_roles.id, drives the "Extend" button payload. */
  grantId: string;
  roleName: string;
  /** ISO 8601 string or null for non-expiring grants. */
  expiresAt: string | null;
  /** 'direct' | 'auditor_invite' | 'support_grant'. */
  source: string;
}

interface MemberRow {
  id: string;
  user_id: string;
  org_id: string;
  grantedRoleNames: string[];    // from org_member_roles → role_definitions
  grants: MemberRoleGrant[];     // Phase 4.4, per-grant expiry + source
  joined_at: string | null;
  email: string;
  name: string;
  status: 'Active' | 'Invited';
}

/**
 * Phase 4.4 expiry badge tiering:
 *   null         -> no badge
 *   > 14 days    -> green
 *   3–14 days    -> amber
 *   < 3 days     -> red
 *   past expiry  -> red with "Expired" label (sweep should revoke shortly)
 */
type ExpiryTier = 'none' | 'green' | 'amber' | 'red' | 'expired';

function expiryTier(expiresAt: string | null): { tier: ExpiryTier; msUntil: number } {
  if (!expiresAt) return { tier: 'none', msUntil: Infinity };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { tier: 'expired', msUntil: ms };
  const DAY = 24 * 60 * 60 * 1000;
  if (ms < 3 * DAY) return { tier: 'red', msUntil: ms };
  if (ms < 14 * DAY) return { tier: 'amber', msUntil: ms };
  return { tier: 'green', msUntil: ms };
}

function formatExpiryDate(expiresAt: string): string {
  return new Date(expiresAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function UsersTab({
  orgId,
  onManageRoles,
}: {
  orgId: string | null;
  /** Navigate to the Roles admin tab (Phase 4.2 role-grant editor). */
  onManageRoles?: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [rolePresets, setRolePresets] = useState<RolePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editMember, setEditMember] = useState<MemberRow | null>(null);
  const [addEmail, setAddEmail] = useState('');
  // addRoleId is the role_definitions.id of the selected preset.
  const [addRoleId, setAddRoleId] = useState<string>('');
  // Auditor expiry. Defaults to 90 days from today on
  // dialog open, capped at 1 year. Ignored for non-Auditor roles.
  const [addExpiresAt, setAddExpiresAt] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Phase 4.4 extend-expiry dialog state.
  const [extendTarget, setExtendTarget] = useState<{ member: MemberRow; grant: MemberRoleGrant } | null>(null);
  const [extendNewDate, setExtendNewDate] = useState<string>('');
  const [extendSaving, setExtendSaving] = useState(false);

  // Phase 4.4 Orange Way Books Support grant dialog + active session banner.
  const [supportGrantOpen, setSupportGrantOpen] = useState(false);
  const [supportEmail, setSupportEmail] = useState('');
  const [supportDurationHours, setSupportDurationHours] = useState<1 | 6 | 12 | 24>(12);
  const [supportGrantSaving, setSupportGrantSaving] = useState(false);
  const [activeSupportSession, setActiveSupportSession] = useState<{
    id: string;
    expires_at: string;
    support_user_id: string;
  } | null>(null);
  const [supportHistory, setSupportHistory] = useState<Array<{
    id: string;
    granted_at: string;
    expires_at: string;
    ended_at: string | null;
    end_reason: string | null;
    support_user_id: string;
  }>>([]);
  const [endingSupport, setEndingSupport] = useState(false);

  // Edit-user dialog form state. Decoupled from editMember so the user
  // can type freely without clobbering the row in the Users table, and
  // so we can detect "changed vs. original" for the Save buttons.
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  // When an email change is in flight (confirmation link sent, not yet
  // clicked), we show a "Pending user confirmation" badge until the
  // dialog is closed. Keyed by the edit session so re-opening on the
  // same member after a successful change doesn't keep stale state.
  const [emailPending, setEmailPending] = useState(false);
  // Per-button loading flags. One shared `saving` flag would disable
  // every button whenever any single one is in flight, confusing UX
  // when e.g. "Save name" is running and you want to also see the
  // password reset button remain visually enabled.
  const [savingName, setSavingName] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingReset, setSavingReset] = useState(false);
  const [savingResend, setSavingResend] = useState(false);

  // Load system presets once the tab mounts. Uses the same selector as
  // /settings/roles (is_system = TRUE AND org_id IS NULL) to guarantee
  // parity between the two surfaces.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from('role_definitions')
        .select('id, name, description')
        .eq('is_system', true)
        .is('org_id', null)
        .order('name');
      if (!active) return;
      if (error) {
        // Defensive: if the table doesn't exist yet (pre-4.2 migration
        // environments) we degrade gracefully, the dropdown will show
        // the legacy names via the fallback below.
        console.warn('role_definitions query failed, falling back to legacy names:', error.message);
        setRolePresets([]);
        return;
      }
      setRolePresets((data ?? []) as RolePreset[]);
    })();
    return () => { active = false; };
  }, []);

  // Default the Add User selection to the first preset once they load.
  useEffect(() => {
    if (!addRoleId && rolePresets.length > 0) {
      // Prefer the "Member" preset as a reasonable default if present.
      const memberPreset = rolePresets.find(p => p.name.toLowerCase() === 'member');
      setAddRoleId((memberPreset ?? rolePresets[0]).id);
    }
  }, [rolePresets, addRoleId]);

  const fetchMembers = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data: rawMembers } = await supabase.from('org_members').select('*').eq('org_id', orgId);
    if (!rawMembers || rawMembers.length === 0) {
      setMembers([]);
      setLoading(false);
      return;
    }

    // Pull the active Phase-4.2 role grants for this org so we can show
    // the canonical role_definitions.name alongside (or instead of) the
    // legacy role text. Phase 4.4 also carries expires_at + source so
    // the UI can render expiry badges + route Extend / End actions.
    const { data: grantRows } = await supabase
      .from('org_member_roles')
      .select('id, user_id, expires_at, source, role_definitions(name)')
      .eq('org_id', orgId)
      .is('revoked_at', null);
    const grantsByUser = new Map<string, string[]>();
    const detailedGrantsByUser = new Map<string, MemberRoleGrant[]>();
    for (const g of (grantRows ?? []) as Array<{
      id: string;
      user_id: string;
      expires_at: string | null;
      source: string | null;
      role_definitions: { name: string } | null;
    }>) {
      const name = g.role_definitions?.name;
      if (!name) continue;
      const names = grantsByUser.get(g.user_id) ?? [];
      names.push(name);
      grantsByUser.set(g.user_id, names);
      const details = detailedGrantsByUser.get(g.user_id) ?? [];
      details.push({
        grantId: g.id,
        roleName: name,
        expiresAt: g.expires_at,
        source: g.source ?? 'direct',
      });
      detailedGrantsByUser.set(g.user_id, details);
    }

    // Try to look up user profiles via edge function (names + emails from auth.users)
    const userIds = rawMembers.map(m => m.user_id);
    let profileMap: Record<string, { email: string; name: string }> = {};
    try {
      // Wait for the session so the first render doesn't fire the invoke
      // before the Authorization header is attached (401 silently yields
      // no data and every row falls back to a truncated UUID).
      await supabase.auth.getSession();
      const { data: profiles, error: profilesErr } = await supabase.functions.invoke(
        'lookup-user-profiles',
        { body: { userIds } },
      );
      if (profilesErr) {
        // Non-2xx from the edge function (e.g. not deployed, 401, 500).
        // Surface it instead of silently falling through so we notice in
        // prod.
        console.warn('lookup-user-profiles returned an error:', profilesErr);
      } else if (profiles && Array.isArray(profiles)) {
        for (const p of profiles) {
          profileMap[p.id] = { email: p.email | '', name: p.name | '' };
        }
      }
    } catch (err) {
      // Network / transport error, log and fall through to the
      // current-user fallback below.
      console.warn('lookup-user-profiles unavailable:', err);
    }

    // Fallback: even if the edge function worked, make sure we know our
    // own identity so the signed-in user never renders as a bare UUID.
    // (`getUser()` is a cheap local-session read, no network round-trip
    // once the session is warm.)
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const existing = profileMap[user.id];
        const metaName = user.user_metadata?.full_name | user.user_metadata?.name | '';
        profileMap[user.id] = {
          email: existing?.email | user.email | '',
          name: existing?.name | metaName,
        };
      }
    } catch {
      // Ignore, worst case we just show a truncated UUID for that row.
    }

    const enriched: MemberRow[] = rawMembers.map(m => ({
      id: m.id,
      user_id: m.user_id,
      org_id: m.org_id,
      grantedRoleNames: (grantsByUser.get(m.user_id) ?? []).sort(),
      grants: detailedGrantsByUser.get(m.user_id) ?? [],
      joined_at: m.joined_at,
      email: profileMap[m.user_id]?.email | '',
      name: profileMap[m.user_id]?.name | '',
      status: profileMap[m.user_id]?.email ? 'Active' as const : 'Invited' as const,
    }));

    setMembers(enriched);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    if (!s) return members;
    return members.filter(m =>
      m.name.toLowerCase().includes(s) ||
      m.email.toLowerCase().includes(s) ||
      m.grantedRoleNames.some(n => n.toLowerCase().includes(s))
    );
  }, [members, search]);

  const selectedPreset = useMemo(
    () => rolePresets.find(p => p.id === addRoleId) ?? null,
    [rolePresets, addRoleId],
  );
  const selectedPresetIsAuditor = (selectedPreset?.name ?? '') === 'Auditor';

  // Date picker default helpers (90 days, max 1y).
  const todayIsoDate = () => new Date().toISOString().slice(0, 10);
  const ninetyDaysFromNowIsoDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 90);
    return d.toISOString().slice(0, 10);
  };
  const oneYearFromNowIsoDate = () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };

  // When Auditor is selected and the field is empty, seed the default
  // 90-day expiry. Clearing the role clears the field.
  useEffect(() => {
    if (selectedPresetIsAuditor && !addExpiresAt) {
      setAddExpiresAt(ninetyDaysFromNowIsoDate());
    }
    if (!selectedPresetIsAuditor && addExpiresAt) {
      setAddExpiresAt('');
    }
    // Intentional: only react to preset change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPresetIsAuditor]);

  const handleAddUser = async () => {
    if (!orgId || !addEmail.trim()) return;
    if (!selectedPreset) {
      toast.error('Pick a role first');
      return;
    }
    setSaving(true);

    // Phase 4.3: the invite edge function always writes a pending_invites
    // row (status = awaiting_recipient OR ready_to_wrap depending on
    // whether the recipient has a keypair yet) and sends the Supabase
    // Auth invite email. The Owner's client picks up ready_to_wrap rows
    // via realtime and finalizes the hybrid-KEM wrap (see the
    // PendingWrapBanner effect below). This keeps the UI flow simple —
    // one call, one success toast, per-recipient wraps happen
    // asynchronously.
    // Auditor invites carry an ISO expires_at. For
    // other roles we don't send the field (edge function drops it
    // anyway; skipping keeps the body minimal).
    let expiresAtIso: string | undefined;
    if (selectedPresetIsAuditor) {
      if (!addExpiresAt) {
        toast.error('Pick an access end date for the auditor.');
        setSaving(false);
        return;
      }
      // yyyy-mm-dd → end of that day in the user's local timezone.
      const parsed = new Date(`${addExpiresAt}T23:59:59`);
      if (Number.isNaN(parsed.getTime())) {
        toast.error('The access end date is not valid.');
        setSaving(false);
        return;
      }
      if (parsed.getTime() <= Date.now()) {
        toast.error('The access end date must be in the future.');
        setSaving(false);
        return;
      }
      expiresAtIso = parsed.toISOString();
    }

    try {
      const { data, error } = await supabase.functions.invoke('invite-org-member', {
        body: {
          org_id: orgId,
          email: addEmail.trim(),
          role_definition_id: selectedPreset.id,
          ...(expiresAtIso ? { expires_at: expiresAtIso, source: 'auditor_invite' } : {}),
        },
      });
      if (error) throw error;

      const message = (data as { message?: string } | null)?.message
        ?? `Invitation sent to ${addEmail.trim()}`;
      toast.success(message);
      setAddOpen(false);
      setAddEmail('');
      setAddExpiresAt('');
      // Reset role selection to the Member preset for the next invite.
      const memberPreset = rolePresets.find(p => p.name.toLowerCase() === 'member');
      setAddRoleId((memberPreset ?? rolePresets[0])?.id ?? '');
      fetchMembers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to invite user';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Soft revoke ─────────────────────────────────────────────────────
  // Confirm modal state. `revokeTarget` is the member row we're about
  // to remove; null means the modal is closed.
  const [revokeTarget, setRevokeTarget] = useState<MemberRow | null>(null);
  const [revokeSaving, setRevokeSaving] = useState(false);
  // Phase 4.5: after a successful revoke, optionally prompt the admin
  // to rotate keys so the removed user can't read data they cached.
  // rekeyPromptFor holds the just-removed member's display info.
  const [rekeyPromptFor, setRekeyPromptFor] = useState<MemberRow | null>(null);
  const [rekeyWizardOpen, setRekeyWizardOpen] = useState(false);

  /**
   * Soft revoke: call admin-update-user with action=soft_revoke. The
   * edge function flips revoked_at on every active grant and deletes
   * the org_members row; the D9 trigger then drops the org_keys wrap
   * and writes the audit event. The user keeps their auth account —
   * they just lose access to THIS org.
   *
   * Hard re-key (rotate the org DEK so cached browser-tab keys no
   * longer work) ships in Phase 4.5 as a separate, explicit action.
   * The modal copy calls that out.
   */
  const executeSoftRevoke = async (target: MemberRow) => {
    if (!orgId) return;
    setRevokeSaving(true);
    const res = await invokeAdminUpdate(target.user_id, orgId, 'soft_revoke');
    setRevokeSaving(false);
    if (!res.ok) {
      toast.error((res as { ok: false; message: string }).message);
      return;
    }
    toast.success(`${target.name || target.email || 'User'} removed from organization`);
    setRevokeTarget(null);
    // If the Edit dialog was open on this user, close it too.
    if (editMember?.user_id === target.user_id) {
      setEditOpen(false);
    }
    fetchMembers();
    // Phase 4.5: offer to rotate team keys now so the removed user
    // can't read data they've already opened on their device.
    setRekeyPromptFor(target);
  };

  const handleRemoveMember = async () => {
    if (!editMember) return;
    // Route the Edit dialog's "Remove from Organization" button through
    // the same confirm-modal path so the UX stays consistent regardless
    // of which entry point the admin used.
    setRevokeTarget(editMember);
  };

  /**
   * Re-seed the form when a row is opened in the Edit User dialog, and
   * clear the "pending email confirmation" badge so it only shows
   * immediately after a successful update_email call in this session.
   */
  useEffect(() => {
    if (editOpen && editMember) {
      setEditName(editMember.name | '');
      setEditEmail(editMember.email | '');
      setEmailPending(false);
    }
  }, [editOpen, editMember]);

  /**
   * Invoke admin-update-user and normalize its response into a common
   * shape. Supabase's functions.invoke returns `error` when the
   * function itself failed OR when the status is non-2xx (with the
   * response body as `context.response`). We peel the JSON error
   * string out so we can show it as a toast, the edge function is
   * careful to only put user-friendly copy there.
   */
  const invokeAdminUpdate = async (
    targetUserId: string,
    orgId: string,
    action: 'update_name' | 'update_email' | 'send_password_reset' | 'resend_invite' | 'soft_revoke',
    payload?: { name?: string; email?: string },
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> => {
    try {
      const { data, error } = await supabase.functions.invoke('admin-update-user', {
        body: { target_user_id: targetUserId, org_id: orgId, action, payload },
      });
      if (error) {
        // Supabase wraps non-2xx responses in a FunctionsHttpError with
        // the raw Response on `context.response`. Read the JSON body
        // to surface the server-authored error copy.
        let msg = error.message | 'Request failed';
        const ctx = (error as { context?: { response?: Response } }).context;
        if (ctx?.response) {
          try {
            const parsed = await ctx.response.clone().json();
            if (parsed && typeof parsed.error === 'string') msg = parsed.error;
          } catch { /* fall through with the generic message */ }
        }
        console.warn(`admin-update-user ${action} failed:`, msg);
        return { ok: false, message: msg };
      }
      return { ok: true, data: (data ?? {}) as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed';
      console.warn(`admin-update-user ${action} threw:`, err);
      return { ok: false, message: msg };
    }
  };

  const handleSaveName = async () => {
    if (!editMember) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      toast.error('Name cannot be empty.');
      return;
    }
    setSavingName(true);
    const res = await invokeAdminUpdate(editMember.user_id, editMember.org_id, 'update_name', { name: trimmed });
    setSavingName(false);
    if (!res.ok) {
      toast.error((res as { ok: false; message: string }).message);
      return;
    }
    toast.success('Name updated');
    // Optimistically reflect the new name in the open dialog so the
    // "changed" detector doesn't immediately re-enable the Save button.
    setEditMember(prev => (prev ? { ...prev, name: trimmed } : prev));
    fetchMembers();
  };

  const handleSaveEmail = async () => {
    if (!editMember) return;
    const trimmed = editEmail.trim();
    // Cheap client-side email check; the server does the authoritative
    // one. This just avoids a round-trip for obvious typos.
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(trimmed)) {
      toast.error('Enter a valid email address.');
      return;
    }
    setSavingEmail(true);
    const res = await invokeAdminUpdate(editMember.user_id, editMember.org_id, 'update_email', { email: trimmed });
    setSavingEmail(false);
    if (!res.ok) {
      toast.error((res as { ok: false; message: string }).message);
      return;
    }
    toast.success('Confirmation email sent to new address');
    setEmailPending(true);
    // We intentionally do NOT optimistically update editMember.email
    // here, the email change isn't real until the user clicks the
    // confirmation link. fetchMembers() will show the old email
    // until the link is clicked, which matches reality.
  };

  const handleSendPasswordReset = async () => {
    if (!editMember) return;
    setSavingReset(true);
    const res = await invokeAdminUpdate(editMember.user_id, editMember.org_id, 'send_password_reset');
    setSavingReset(false);
    if (!res.ok) {
      toast.error((res as { ok: false; message: string }).message);
      return;
    }
    toast.success('Password reset email sent');
  };

  const handleResendInvite = async () => {
    if (!editMember) return;
    setSavingResend(true);
    const res = await invokeAdminUpdate(editMember.user_id, editMember.org_id, 'resend_invite');
    setSavingResend(false);
    if (!res.ok) {
      toast.error((res as { ok: false; message: string }).message);
      return;
    }
    toast.success('Invite email resent');
  };

  // ── Phase 4.4 extend expiry ───────────────────────────────────────
  const executeExtendExpiry = async () => {
    if (!extendTarget || !orgId || !extendNewDate) return;
    const parsed = new Date(`${extendNewDate}T23:59:59`);
    if (Number.isNaN(parsed.getTime()) | parsed.getTime() <= Date.now()) {
      toast.error('The new access end date must be in the future.');
      return;
    }
    setExtendSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-update-user', {
        body: {
          target_user_id: extendTarget.member.user_id,
          org_id: orgId,
          action: 'extend_role_expiry',
          payload: {
            role_grant_id: extendTarget.grant.grantId,
            new_expires_at: parsed.toISOString(),
          },
        },
      });
      if (error) {
        const ctx = (error as { context?: { response?: Response } }).context;
        let msg = error.message | 'Failed to extend access.';
        if (ctx?.response) {
          try {
            const parsedErr = await ctx.response.clone().json();
            if (parsedErr && typeof parsedErr.error === 'string') msg = parsedErr.error;
          } catch { /* */ }
        }
        toast.error(msg);
        return;
      }
      toast.success(`Access extended to ${formatExpiryDate((data as { new_expires_at: string }).new_expires_at)}.`);
      setExtendTarget(null);
      setExtendNewDate('');
      fetchMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to extend access.');
    } finally {
      setExtendSaving(false);
    }
  };

  // ── Phase 4.4 Orange Way Books Support session grant / end ────────────────
  const loadSupportSessions = useCallback(async () => {
    if (!orgId) return;
    const { data, error } = await (supabase as any)
      .from('support_sessions')
      .select('id, granted_at, expires_at, ended_at, end_reason, support_user_id')
      .eq('org_id', orgId)
      .order('granted_at', { ascending: false })
      .limit(20);
    if (error) {
      console.warn('[support] session load failed', error);
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      granted_at: string;
      expires_at: string;
      ended_at: string | null;
      end_reason: string | null;
      support_user_id: string;
    }>;
    setSupportHistory(rows);
    const active = rows.find((r) => !r.ended_at && new Date(r.expires_at).getTime() > Date.now());
    setActiveSupportSession(active
      ? { id: active.id, expires_at: active.expires_at, support_user_id: active.support_user_id }
      : null);
  }, [orgId]);

  useEffect(() => { loadSupportSessions(); }, [loadSupportSessions]);

  const executeGrantSupport = async () => {
    if (!orgId) return;
    const email = supportEmail.trim().toLowerCase();
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(email)) {
      toast.error('Enter a valid Orange Way Books support email.');
      return;
    }
    setSupportGrantSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-update-user', {
        body: {
          org_id: orgId,
          action: 'grant_support_session',
          payload: {
            support_email: email,
            duration_hours: supportDurationHours,
          },
        },
      });
      if (error) {
        const ctx = (error as { context?: { response?: Response } }).context;
        let msg = error.message | 'Failed to grant support access.';
        if (ctx?.response) {
          try {
            const parsedErr = await ctx.response.clone().json();
            if (parsedErr && typeof parsedErr.error === 'string') msg = parsedErr.error;
          } catch { /* */ }
        }
        toast.error(msg);
        return;
      }
      const d = data as { expires_at: string };
      const untilLabel = new Date(d.expires_at).toLocaleString(undefined, {
        hour: 'numeric', minute: '2-digit',
      });
      toast.success(`Support can view your organization until ${untilLabel}.`);
      setSupportGrantOpen(false);
      setSupportEmail('');
      setSupportDurationHours(12);
      fetchMembers();
      loadSupportSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to grant support access.');
    } finally {
      setSupportGrantSaving(false);
    }
  };

  const executeEndSupport = async () => {
    if (!orgId || !activeSupportSession) return;
    setEndingSupport(true);
    try {
      const { error } = await supabase.functions.invoke('admin-update-user', {
        body: {
          org_id: orgId,
          action: 'end_support_session',
          payload: { session_id: activeSupportSession.id },
        },
      });
      if (error) {
        const ctx = (error as { context?: { response?: Response } }).context;
        let msg = error.message | 'Failed to end support access.';
        if (ctx?.response) {
          try {
            const parsedErr = await ctx.response.clone().json();
            if (parsedErr && typeof parsedErr.error === 'string') msg = parsedErr.error;
          } catch { /* */ }
        }
        toast.error(msg);
        return;
      }
      toast.success('Support access ended.');
      fetchMembers();
      loadSupportSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to end support access.');
    } finally {
      setEndingSupport(false);
    }
  };

  // ── Pending wrap queue ────────────────────────────────────────────
  // Count of pending_invites rows in this org with status='ready_to_wrap'.
  // Displayed as a badge on the "Complete pending invites" button; clicking
  // the button runs the hybrid-KEM wrap for each ready row and calls
  // complete-invite-wrap to finalize them. Auto-runs on mount whenever
  // the count is >0 so an Owner who was offline when the recipient
  // signed up returns to a completed invite.
  const [pendingWrapCount, setPendingWrapCount] = useState(0);
  const [wrapCompleting, setWrapCompleting] = useState(false);

  const completePendingWraps = useCallback(async (silent = false) => {
    if (!orgId) return;
    setWrapCompleting(true);
    try {
      const { data: ready, error } = await supabase
        .from('pending_invites' as any)
        .select('id, recipient_user_id')
        .eq('org_id', orgId)
        .eq('status', 'ready_to_wrap');
      if (error) {
        console.warn('[invite] pending_invites fetch failed:', error.message);
        return;
      }
      const rows = (ready ?? []) as unknown as Array<{ id: string; recipient_user_id: string | null }>;
      let ok = 0;
      let failed = 0;
      for (const row of rows) {
        if (!row.recipient_user_id) {
          failed += 1;
          continue;
        }
        try {
          const { publicKeyB64 } = await lookupRecipientPublicKey(row.recipient_user_id);
          if (!publicKeyB64) {
            // The trigger believes they have a keypair but we can't
            // read it, likely an RLS race. Skip and retry next cycle.
            failed += 1;
            continue;
          }
          // Placeholder org DEK, Phase 4.5 will replace this with the
          // real shared DEK payload. Each invite gets its own random
          // slot so the 4.5 migration can pivot per-wrap without
          // rewriting history.
          const orgDek = generatePlaceholderOrgDek();
          const payload = await wrapOrgDekForRecipient(orgDek, publicKeyB64);
          const { error: completeErr } = await supabase.functions.invoke(
            'complete-invite-wrap',
            { body: { pending_invite_id: row.id, wrapped_dek: payload } },
          );
          if (completeErr) throw completeErr;
          ok += 1;
        } catch (err) {
          console.warn('[invite] complete-invite-wrap failed for', row.id, err);
          failed += 1;
        }
      }
      if (!silent) {
        if (ok > 0) toast.success(`Completed ${ok} pending invite${ok === 1 ? '' : 's'}`);
        if (failed > 0) toast.error(`${failed} invite${failed === 1 ? '' : 's'} could not be completed, retry in a moment`);
      }
      await fetchMembers();
    } finally {
      setWrapCompleting(false);
    }
  }, [orgId, fetchMembers]);

  // Load the pending-wrap count on mount + subscribe to realtime INSERTs
  // / UPDATEs on pending_invites. Any row transitioning into
  // ready_to_wrap triggers an auto-complete attempt, the Owner sees
  // a success toast without having to click anything.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;

    const refreshCount = async () => {
      const { count, error } = await supabase
        .from('pending_invites' as any)
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'ready_to_wrap');
      if (cancelled) return;
      if (!error) setPendingWrapCount(count ?? 0);
    };

    refreshCount().then(async () => {
      if (cancelled) return;
      // Auto-complete on mount if there are rows waiting (e.g. the
      // recipient signed up while the Owner was offline).
      await completePendingWraps(true);
      await refreshCount();
    });

    // Realtime channel scoped to this org's pending_invites rows.
    const channel = supabase
      .channel(`pending_invites:${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_invites', filter: `org_id=eq.${orgId}` },
        async () => {
          await refreshCount();
          // Debounce: only kick the auto-complete if we're not already running.
          if (!cancelled) {
            await completePendingWraps(true);
            await refreshCount();
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [orgId, completePendingWraps]);

  return (
    <div className="space-y-4">
      {/* Phase 4.4, Orange Way Books Support access section. Customer-first
          copy intentionally avoids: no "signing key", no "session TTL", no "capability". */}
      <div className="border border-border rounded-lg p-4 bg-muted/20">
        {activeSupportSession ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="w-4 h-4 text-green-700" />
              <span>
                Support access active. Ends at{' '}
                <strong>
                  {new Date(activeSupportSession.expires_at).toLocaleString(undefined, {
                    hour: 'numeric', minute: '2-digit',
                  })}
                </strong>.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={executeEndSupport}
              disabled={endingSupport}
            >
              {endingSupport ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              End session now
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <div className="font-medium">Orange Way Books support access</div>
              <div className="text-muted-foreground">
                Give Orange Way Books support temporary access to help you. You can end the session any time.
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSupportGrantOpen(true)}>
              <ShieldCheck className="w-4 h-4 mr-1" /> Give support access
            </Button>
          </div>
        )}
        {supportHistory.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-muted-foreground cursor-pointer">
              Recent support sessions
            </summary>
            <div className="mt-2 space-y-1 text-xs">
              {supportHistory.slice(0, 5).map((s) => (
                <div key={s.id} className="flex justify-between gap-3">
                  <span>
                    {new Date(s.granted_at).toLocaleString()} → {s.ended_at ? new Date(s.ended_at).toLocaleString() : 'active'}
                  </span>
                  <span className="text-muted-foreground">
                    {s.ended_at ? (s.end_reason ?? 'ended') : 'active'}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by name or email..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {pendingWrapCount > 0 && (
          <Button
            variant="outline"
            onClick={() => completePendingWraps(false)}
            disabled={wrapCompleting}
            title="Finish setup for invitees who have completed signup"
          >
            {wrapCompleting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : (
              <KeyRound className="w-4 h-4 mr-1" />
            )}
            Finish {pendingWrapCount} invite{pendingWrapCount === 1 ? '' : 's'}
          </Button>
        )}
        <Button onClick={() => {
          setAddEmail('');
          // Default role selection to the Member preset (matches the
          // post-submit reset in handleAddUser + the initial-load useEffect).
          const memberPreset = rolePresets.find(p => p.name.toLowerCase() === 'member');
          setAddRoleId((memberPreset ?? rolePresets[0])?.id ?? '');
          setAddOpen(true);
        }} className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white">
          <Plus className="w-4 h-4 mr-1" /> Add User
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">NAME</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">EMAIL</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">ROLE</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">STATUS</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading users...
              </td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">No users found.</td></tr>
            ) : filtered.map(m => {
              // Role grants from `org_member_roles` → `role_definitions` are
              // the single source of truth. A member with no active grant
              // renders as an em-dash; admins assign roles on the Roles tab.
              const hasGrant = m.grantedRoleNames.length > 0;
              const roleLabel = hasGrant ? m.grantedRoleNames.join(', ') : '\u2014';
              // Phase 4.4: find the earliest-expiring grant for this
              // member. Surfaces a single badge on the row even when
              // the member holds multiple time-boxed grants.
              const earliestExpiringGrant = m.grants
                .filter((g) => g.expiresAt !== null)
                .sort((a, b) =>
                  new Date(a.expiresAt as string).getTime() - new Date(b.expiresAt as string).getTime(),
                )[0] ?? null;
              const tier = earliestExpiringGrant
                ? expiryTier(earliestExpiringGrant.expiresAt).tier
                : 'none';
              const badgeClass: Record<ExpiryTier, string> = {
                none: '',
                green: 'bg-green-50 text-green-700 border border-green-200',
                amber: 'bg-amber-50 text-amber-700 border border-amber-200',
                red: 'bg-red-50 text-red-700 border border-red-200',
                expired: 'bg-red-50 text-red-700 border border-red-200 line-through',
              };
              return (
                <tr key={m.id} className={`border-b border-border last:border-0 hover:bg-muted/30 ${tier === 'expired' ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-3 font-medium">{m.name || m.email?.split('@')[0] || m.user_id.slice(0, 8) + '...'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.email || '\u2014'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded bg-muted"
                        title={hasGrant
                          ? 'Assigned on the Roles tab'
                          : 'No role assigned, add one on the Roles tab'}
                      >
                        {roleLabel}
                      </span>
                      {earliestExpiringGrant && tier !== 'none' && (
                        <>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${badgeClass[tier]}`}>
                            {tier === 'expired'
                              ? 'Expired'
                              : `Expires ${formatExpiryDate(earliestExpiringGrant.expiresAt as string)}`}
                          </span>
                          {earliestExpiringGrant.source === 'auditor_invite' && tier !== 'expired' && (
                            <button
                              onClick={() => {
                                setExtendTarget({ member: m, grant: earliestExpiringGrant });
                                // Seed dialog with 90 days from today, capped at 1 year.
                                setExtendNewDate(ninetyDaysFromNowIsoDate());
                              }}
                              className="text-xs text-[var(--color-brand-orange)] hover:underline"
                              title="Extend access"
                            >
                              Extend
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {m.status === 'Active' ? (
                      <span className="text-green-700 bg-green-50 px-2 py-0.5 rounded text-xs font-medium">Active</span>
                    ) : (
                      <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded text-xs font-medium">Invited</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => { setEditMember(m); setEditOpen(true); }}
                        className="text-muted-foreground hover:text-foreground"
                        title="Edit member details"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setRevokeTarget(m)}
                        className="text-muted-foreground hover:text-red-600"
                        title="Remove from organization"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      {onManageRoles && (
                        <button
                          onClick={onManageRoles}
                          className="text-xs text-[var(--color-brand-orange)] hover:underline whitespace-nowrap"
                          title="Assign or remove roles on the Roles tab"
                        >
                          Manage roles
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add User Modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Email *</Label>
              <Input value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="user@example.com" type="email" />
            </div>
            <div>
              <Label>Role *</Label>
              <Select value={addRoleId} onValueChange={setAddRoleId}>
                <SelectTrigger><SelectValue placeholder="Select a role" /></SelectTrigger>
                <SelectContent>
                  {rolePresets.length === 0 ? (
                    <SelectItem value="__none__" disabled>Loading roles…</SelectItem>
                  ) : rolePresets.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPreset?.description && (
                <p className="text-xs text-muted-foreground mt-1.5">{selectedPreset.description}</p>
              )}
            </div>
            {/* Auditor access-ends-on date picker. */}
            {selectedPresetIsAuditor && (
              <div>
                <Label>Access expires on *</Label>
                <Input
                  type="date"
                  value={addExpiresAt}
                  onChange={(e) => setAddExpiresAt(e.target.value)}
                  min={todayIsoDate()}
                  max={oneYearFromNowIsoDate()}
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Defaults to 90 days from today. You can extend access any time before it ends.
                </p>
              </div>
            )}
            <div className="bg-muted/50 border border-border rounded-md p-3 text-xs text-muted-foreground">
              Capability bundle comes from the <strong>Roles</strong> tab, open it to see
              exactly what this role can do, or to create a custom role.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              disabled={
                !addEmail.trim() ||
                !selectedPreset ||
                saving ||
                (selectedPresetIsAuditor && !addExpiresAt)
              }
              onClick={handleAddUser}
            >
              {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Sending...</> : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 4.4, Extend access dialog. */}
      <Dialog
        open={!!extendTarget}
        onOpenChange={(open) => {
          if (!open) {
            setExtendTarget(null);
            setExtendNewDate('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend access</DialogTitle>
          </DialogHeader>
          {extendTarget && (
            <div className="space-y-3 text-sm">
              <p>
                Change the access end date for{' '}
                <strong>{extendTarget.member.name || extendTarget.member.email || 'this user'}</strong>.
                {extendTarget.grant.expiresAt && (
                  <> Current end date: {formatExpiryDate(extendTarget.grant.expiresAt)}.</>
                )}
              </p>
              <div>
                <Label>New end date</Label>
                <Input
                  type="date"
                  value={extendNewDate}
                  onChange={(e) => setExtendNewDate(e.target.value)}
                  min={todayIsoDate()}
                  max={oneYearFromNowIsoDate()}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setExtendTarget(null); setExtendNewDate(''); }}
              disabled={extendSaving}
            >
              Cancel
            </Button>
            <Button
              className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              onClick={executeExtendExpiry}
              disabled={extendSaving || !extendNewDate}
            >
              {extendSaving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Saving…</> : 'Extend access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 4.4, Grant Orange Way Books Support access. */}
      <Dialog open={supportGrantOpen} onOpenChange={setSupportGrantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Give Orange Way Books support access</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Support can view your organization for the window you pick. You can end the session any time.
            </p>
            <div>
              <Label>Support email *</Label>
              <Input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="support@orangeway.app"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                The email Orange Way Books support asked you to use.
              </p>
            </div>
            <div>
              <Label>How long should access last? *</Label>
              <Select
                value={String(supportDurationHours)}
                onValueChange={(v) => setSupportDurationHours(Number(v) as 1 | 6 | 12 | 24)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 hour</SelectItem>
                  <SelectItem value="6">6 hours</SelectItem>
                  <SelectItem value="12">12 hours</SelectItem>
                  <SelectItem value="24">24 hours</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1.5">
                Access ends automatically after this window. 24 hours is the maximum.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupportGrantOpen(false)} disabled={supportGrantSaving}>
              Cancel
            </Button>
            <Button
              className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              onClick={executeGrantSupport}
              disabled={supportGrantSaving || !supportEmail.trim()}
            >
              {supportGrantSaving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Granting…</> : 'Give access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Modal
          Editable name + email (email change triggers a confirmation
          email to the new address), a button to send a password-reset
          email, a conditional "Resend invite" button for still-invited
          members, plus a danger-zone Remove action at the bottom.
          Role changes are NEVER written from this dialog, they live
          exclusively in the Roles tab's UserAssignmentSection. */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
          {editMember && (
            <div className="space-y-5">
              {/* Name, editable */}
              <div>
                <Label className="text-xs text-muted-foreground">Name</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="Full name"
                    disabled={savingName}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveName}
                    disabled={
                      savingName ||
                      editName.trim().length === 0 ||
                      editName.trim() === (editMember.name | '').trim()
                    }
                  >
                    {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  How this user appears across the app.
                </p>
              </div>

              {/* Email, editable, confirmation required */}
              <div>
                <Label className="text-xs text-muted-foreground">Email</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="email"
                    value={editEmail}
                    onChange={e => setEditEmail(e.target.value)}
                    placeholder="user@example.com"
                    disabled={savingEmail}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveEmail}
                    disabled={
                      savingEmail ||
                      editEmail.trim().length === 0 ||
                      editEmail.trim().toLowerCase() === (editMember.email | '').trim().toLowerCase() ||
                      !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(editEmail.trim())
                    }
                  >
                    {savingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  A confirmation link is sent to the new address. Their vault password and data are unaffected.
                </p>
                {emailPending && (
                  <div className="mt-2">
                    <Badge variant="secondary" className="bg-amber-50 text-amber-700 border border-amber-200">
                      Pending user confirmation
                    </Badge>
                  </div>
                )}
              </div>

              {/* Role, read-only, jump to Roles tab to edit */}
              <div>
                <Label className="text-xs text-muted-foreground">Role</Label>
                <p className="text-sm mt-1">
                  {editMember.grantedRoleNames.length > 0
                    ? editMember.grantedRoleNames.join(', ')
                    : <span className="text-muted-foreground">No role assigned</span>}
                </p>
                {onManageRoles && (
                  <div className="bg-muted/50 border border-border rounded-md p-3 flex items-center justify-between mt-2">
                    <span className="text-xs text-muted-foreground">
                      Change role grants for this user
                    </span>
                    <Button variant="outline" size="sm" onClick={() => { setEditOpen(false); onManageRoles(); }}>
                      Manage role assignments <ArrowLeftRight className="w-3 h-3 ml-1" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Password reset, sign-in credential only, NOT vault */}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendPasswordReset}
                  disabled={savingReset}
                >
                  {savingReset
                    ? <Loader2 className="w-4 h-4 animate-spin mr-1" />
                    : <KeyRound className="w-4 h-4 mr-1" />}
                  Send password reset email
                </Button>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Login password only. Their vault password is known only to them.
                </p>
              </div>

              {/* Resend invite, only for invited users who haven't accepted yet */}
              {editMember.status === 'Invited' && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleResendInvite}
                    disabled={savingResend}
                  >
                    {savingResend
                      ? <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      : <Mail className="w-4 h-4 mr-1" />}
                    Resend invite email
                  </Button>
                </div>
              )}

              {/* Danger zone, visually separated from the edit controls */}
              <div className="border-t border-border pt-4 mt-2">
                <Button variant="destructive" size="sm" onClick={handleRemoveMember} disabled={saving}>
                  <Trash2 className="w-4 h-4 mr-1" /> Remove from Organization
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove / soft-revoke confirm modal (Bitwarden pattern, D11).
          One click + one confirm. Hard re-key is separate. */}
      <Dialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from organization</DialogTitle>
          </DialogHeader>
          {revokeTarget && (
            <div className="space-y-3 text-sm">
              <p>
                Remove <strong>{revokeTarget.name || revokeTarget.email || 'this user'}</strong>{' '}
                from this organization? They will lose access to future data in this org.
              </p>
              <p className="text-muted-foreground">
                This does not delete their account, they can still sign in and access any other
                organizations they belong to. Refreshing your team's security so a removed
                member can't read data they already opened on their device is a separate
                <em> security refresh</em> step, which you'll be offered next.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revokeSaving}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revokeSaving || !revokeTarget}
              onClick={() => { if (revokeTarget) void executeSoftRevoke(revokeTarget); }}
            >
              {revokeSaving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Trash2 className="w-4 h-4 mr-1" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 4.5: post-revoke rotate-keys prompt. Offered, not
          forced. Opens the wizard at Screen 2 since the admin already
          confirmed the removal. */}
      <Dialog open={!!rekeyPromptFor} onOpenChange={(open) => { if (!open) setRekeyPromptFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refresh your team's security?</DialogTitle>
          </DialogHeader>
          {rekeyPromptFor && (
            <div className="space-y-3 text-sm">
              <p>
                <strong>{rekeyPromptFor.name || rekeyPromptFor.email || 'This person'}</strong> has been
                removed. They can still read any data they've already opened on their device.
              </p>
              <p className="text-muted-foreground">
                Refresh your team's security so they can't read that data anymore? This takes a few minutes.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRekeyPromptFor(null)}>
              Not now
            </Button>
            <Button onClick={() => { setRekeyPromptFor(null); setRekeyWizardOpen(true); }}>
              Refresh security now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 4.5: RekeyWizard. Opens at Screen 2 (skip intro since
          the admin already confirmed the removal). */}
      {rekeyWizardOpen && orgId && (
        <RekeyWizard
          orgId={orgId}
          open={rekeyWizardOpen}
          startAtWhatHappens
          triggerType="post_revoke"
          onClose={() => setRekeyWizardOpen(false)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════ Chart of Accounts Tab ═══════════════════════════ */
function ChartOfAccountsTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText } = useVault();
  // Capability gates, UI presence only; RLS still authoritative on writes.
  const canWriteAccounts = useCapability('accounts.write', orgId);
  const [subTab, setSubTab] = useState<CoaSubTab>('income-expense');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<any>(null);
  const [addGroup, setAddGroup] = useState('');
  const [addType, setAddType] = useState('');
  const [addName, setAddName] = useState('');
  const [editName, setEditName] = useState('');
  const [editArchived, setEditArchived] = useState(false);
  const [editType, setEditType] = useState('');
  const [editGroup, setEditGroup] = useState('');
  const [coaImportOpen, setCoaImportOpen] = useState(false);

  const fetchAccounts = async () => {
    if (!orgId) return;
    const { data } = await supabase.from('chart_of_accounts').select('*').eq('org_id', orgId).order('created_at');
    const decrypted = await Promise.all((data | []).map(a => decryptChartOfAccount(a, decryptText).then(fields => ({ ...a, ...fields }))));
    setAccounts(decrypted);
  };

  useEffect(() => { fetchAccounts(); }, [orgId]);

  const groups = subTab === 'income-expense' ? IE_GROUPS : BS_GROUPS;

  const toggleGroup = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const handleAdd = async () => {
    if (!orgId || !addName.trim()) return;
    const enc = await encryptChartOfAccount({
      account_name: addName.trim(),
      account_code: null,
      account_type: addType,
      account_group: addGroup,
      account_category: null,
      is_archived: false,
    }, encryptText);
    await supabase.from('chart_of_accounts').insert({
      org_id: orgId,
      ...enc,
    });
    setAddOpen(false);
    setAddName('');
    fetchAccounts();
    toast.success('Account created');
  };

  const handleEditSave = async () => {
    if (!editAccount) return;
    if (!editType || !editGroup) {
      toast.error('Pick a type and group before saving.');
      return;
    }
    const [encrypted_name, encrypted_account_type, encrypted_account_group, encrypted_is_archived] = await Promise.all([
      encryptText(editName),
      encryptText(editType),
      encryptText(editGroup),
      encryptText(editArchived ? 'true' : 'false'),
    ]);
    await supabase.from('chart_of_accounts').update({
      account_name: crypto.randomUUID(), // opaque placeholder
      encrypted_name,
      account_type: encrypted_account_type,
      account_group: encrypted_account_group,
      is_archived: false,
      encrypted_is_archived,
      key_version: 2,
    }).eq('id', editAccount.id);
    setEditOpen(false);
    fetchAccounts();
    toast.success('Account updated');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 border-b border-border">
          {[{ key: 'income-expense' as CoaSubTab, label: 'Income & Expense' }, { key: 'balance-sheet' as CoaSubTab, label: 'Balance Sheet' }].map(t => (
            <button key={t.key} onClick={() => setSubTab(t.key)} className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${subTab === t.key ? 'border-[var(--color-brand-orange)] text-[var(--color-brand-orange)]' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {canWriteAccounts && (
            <Button variant="outline" size="sm" onClick={() => setCoaImportOpen(true)} data-testid="coa-import-csv">
              <Upload className="w-4 h-4 mr-1" />Import CSV
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {groups.map(g => {
          const groupAccounts = accounts.filter(a => a.account_group === g.name && a.account_type === g.type);
          const isExpanded = expanded.has(g.name);
          return (
            <div key={g.name} className="border border-border rounded-lg overflow-hidden">
              <button onClick={() => toggleGroup(g.name)} className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span className="font-semibold text-sm">{g.name}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${typeBadgeColor(g.type)}`}>{g.type}</span>
                </div>
              </button>
              {isExpanded && (
                <div className="border-t border-border">
                  {groupAccounts.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground italic">No accounts in this group.</p>
                  ) : groupAccounts.map(a => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/20">
                      <div className="flex items-center gap-3">
                        <span className="text-sm">{a.account_name}</span>
                        {a.account_code && <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{a.account_code}</span>}
                        {a.is_archived && <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">Archived</span>}
                      </div>
                      {canWriteAccounts && (
                        <button onClick={() => { setEditAccount(a); setEditName(a.account_name); setEditArchived(a.is_archived | false); setEditType(a.account_type | g.type); setEditGroup(a.account_group | g.name); setEditOpen(true); }} className="text-muted-foreground hover:text-foreground" data-testid="coa-edit-account">
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  {canWriteAccounts && (
                    <button onClick={() => { setAddGroup(g.name); setAddType(g.type); setAddName(''); setAddOpen(true); }} className="w-full px-4 py-2.5 text-sm text-[var(--color-brand-orange)] hover:bg-muted/20 flex items-center gap-1" data-testid="coa-add-account">
                      <Plus className="w-3.5 h-3.5" /> Add Account
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {(() => {
          const ieTypes = new Set(IE_GROUPS.map(g => g.type));
          const bsTypes = new Set(BS_GROUPS.map(g => g.type));
          const tabTypes = subTab === 'income-expense' ? ieTypes : bsTypes;
          const tabGroups = subTab === 'income-expense' ? IE_GROUPS : BS_GROUPS;
          const tabGroupKeys = new Set(tabGroups.map(g => `${g.name}|${g.type}`));
          // Show an "Unfiled" bucket for accounts whose type is in this tab but
          // whose (group, type) tuple doesn't match any configured group, e.g.
          // QB-imported accounts that wrote enum-style groups. This is the only
          // way the user can see and re-classify them.
          const unfiled = accounts.filter(a =>
            a.account_type && tabTypes.has(a.account_type) &&
            !tabGroupKeys.has(`${a.account_group}|${a.account_type}`)
          );
          if (unfiled.length === 0) return null;
          const isExpanded = expanded.has('__unfiled');
          return (
            <div className="border border-amber-300 rounded-lg overflow-hidden bg-amber-50/30">
              <button onClick={() => toggleGroup('__unfiled')} className="w-full flex items-center justify-between px-4 py-3 bg-amber-100/40 hover:bg-amber-100/70 transition-colors">
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span className="font-semibold text-sm">Unfiled, needs review</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-200 text-amber-900">{unfiled.length}</span>
                </div>
              </button>
              {isExpanded && (
                <div className="border-t border-amber-200">
                  <p className="px-4 py-2 text-xs text-amber-900 bg-amber-50">
                    These accounts have a type or group that doesn&apos;t match any configured bucket.
                    Open each one and pick a Type + Group so it shows up in your chart.
                  </p>
                  {unfiled.map(a => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-2.5 border-b border-amber-100 last:border-0 hover:bg-amber-50">
                      <div className="flex items-center gap-3">
                        <span className="text-sm">{a.account_name}</span>
                        {a.account_code && <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{a.account_code}</span>}
                        <span className="text-[10px] text-amber-700">{a.account_type} · {a.account_group}</span>
                      </div>
                      {canWriteAccounts && (
                        <button onClick={() => { setEditAccount(a); setEditName(a.account_name); setEditArchived(a.is_archived | false); setEditType(a.account_type); setEditGroup(a.account_group); setEditOpen(true); }} className="text-muted-foreground hover:text-foreground" data-testid="coa-edit-unfiled">
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Add Account Modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Account</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">Group: {addGroup} ({addType})</p>
          <div><Label>Name *</Label><Input value={addName} onChange={e => setAddName(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" onClick={handleAdd}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Account Modal */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Account</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Name *</Label><Input value={editName} onChange={e => setEditName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type *</Label>
                <Select
                  value={editType}
                  onValueChange={(v) => {
                    setEditType(v);
                    const validGroup = [...IE_GROUPS, ...BS_GROUPS].find((g) => g.type === v && g.name === editGroup);
                    if (!validGroup) {
                      const firstForType = [...IE_GROUPS, ...BS_GROUPS].find((g) => g.type === v);
                      if (firstForType) setEditGroup(firstForType.name);
                    }
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INCOME">Income</SelectItem>
                    <SelectItem value="EXPENSE">Expense</SelectItem>
                    <SelectItem value="ASSETS">Assets</SelectItem>
                    <SelectItem value="LIABILITIES">Liabilities</SelectItem>
                    <SelectItem value="EQUITY">Equity</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Group *</Label>
                <Select value={editGroup} onValueChange={setEditGroup}>
                  <SelectTrigger><SelectValue placeholder="Select group" /></SelectTrigger>
                  <SelectContent>
                    {[...IE_GROUPS, ...BS_GROUPS]
                      .filter((g) => g.type === editType)
                      .map((g) => (
                        <SelectItem key={g.name} value={g.name}>{g.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Type + Group control where the account appears in your chart. Use this to fix
              imported accounts that landed in the wrong place.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={editArchived} onCheckedChange={v => setEditArchived(!!v)} />
              {editArchived ? 'Unarchive this account' : 'Archive this account'}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" onClick={handleEditSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* COA CSV Import */}
      <ImportPopup
        open={coaImportOpen}
        onClose={() => { setCoaImportOpen(false); fetchAccounts(); }}
        entityName="Accounts"
        sampleCsvContent={CHART_OF_ACCOUNTS_SAMPLE_CSV}
        sampleFileName="chart-of-accounts-sample.csv"
        columns={COA_COLUMNS}
        tips={[
          'Name and Type are required. All other columns are optional.',
          'Type options: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE.',
          'SubType is auto-assigned if left blank.',
          'Normal Balance defaults based on Type.',
          'System accounts cannot be overwritten. Duplicate names skipped.',
        ]}
        parseCsv={parseCsvChartOfAccounts}
        onImportRows={async (rows: ImportPreviewRow[]): Promise<ImportResult> => {
          if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };
          // Check existing accounts in chart_of_accounts
          const { data: existing } = await supabase.from('chart_of_accounts' as any).select('account_name, account_code, encrypted_name, key_version').eq('org_id', orgId);
          const decryptedCoaNames = await Promise.all(
            (existing | []).map(async (a: any) => {
              if (a.key_version && a.encrypted_name) {
                return decryptText(a.encrypted_name);
              }
              return a.account_name;
            })
          );
          const existingNames = new Set(decryptedCoaNames.map((n: string) => n?.toLowerCase()));
          const existingCodes = new Set((existing | []).map((a: any) => a.account_code?.toLowerCase()).filter(Boolean));
          let created = 0, skipped = 0, failed = 0;
          const errors: string[] = [];
          const warnings: string[] = [];
          for (const row of rows) {
            const name = row.data.name.trim();
            const code = row.data.code?.trim() | '';
            if (existingNames.has(name.toLowerCase()) | (code && existingCodes.has(code.toLowerCase()))) {
              skipped++;
              warnings.push(`"${name}" already exists, skipped`);
              continue;
            }
            // Phase 2 (legacy-ledger removal): chart_of_accounts is Postgres-only.
            // No the ledger provisioning step; row goes straight into the new schema.
            try {
              const enc = await encryptChartOfAccount({
                account_name: name,
                account_code: code | null,
                account_type: row.data.type,
                account_sub_type: row.data.subtype | null,
                account_group: null,       // legacy field; not in new schema
                account_category: null,    // legacy field; not in new schema
                description: null,
                is_group: false,
                is_system: false,          // user-imported, not system-seeded
                is_archived: false,
                allowed_currencies: null,
                parent_id: null,
              }, encryptText);
              const { error: insertError } = await supabase.from('chart_of_accounts' as any).insert({
                org_id: orgId,
                ...enc,
              });
              if (insertError) {
                failed++;
                errors.push(`Row ${row.rowIndex + 1}: ${insertError.message}`);
              } else {
                created++;
                existingNames.add(name.toLowerCase());
                if (code) existingCodes.add(code.toLowerCase());
              }
            } catch (err: unknown) {
              failed++;
              errors.push(`Row ${row.rowIndex + 1}: ${humanizeLegacyClientError(err)}`);
            }
          }
          return { created, skipped, failed, errors, warnings };
        }}
      />
    </div>
  );
}

/* ═══════════════════════════ Contacts (To/From) Tab ═══════════════════════════ */
function ContactsTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText } = useVault();
  // Capability gates, UI presence only; RLS still authoritative on writes.
  const canWriteContacts = useCapability('contacts.write', orgId);
  const canDeleteContacts = useCapability('contacts.delete', orgId);
  const [contacts, setContacts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(10);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({ name: '', street: '', city: '', state: '', zip: '', country: '', email: '', phone: '', type: '' });
  const [editId, setEditId] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const fetchContacts = async () => {
    if (!orgId) return;
    const { data } = await supabase.from('contacts').select('*').eq('org_id', orgId).order('created_at');
    const decrypted = await Promise.all((data | []).map(c => decryptContact(c, decryptText).then(fields => ({ ...c, ...fields }))));
    setContacts(decrypted);
  };

  useEffect(() => { fetchContacts(); }, [orgId]);

  const filtered = useMemo(() => {
    let r = contacts.filter(c => !search | c.name.toLowerCase().includes(search.toLowerCase()));
    r.sort((a, b) => sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    return r;
  }, [contacts, search, sortDir]);

  const totalPages = Math.ceil(filtered.length / perPage);
  const pageData = filtered.slice(page * perPage, (page + 1) * perPage);
  const startIdx = page * perPage + 1;
  const endIdx = Math.min((page + 1) * perPage, filtered.length);

  const handleSave = async () => {
    if (!orgId || !form.name.trim()) return;
    const encrypted = await encryptContact({
      name: form.name,
      street: form.street | null,
      city: form.city | null,
      state: form.state | null,
      zip: form.zip | null,
      country: form.country | null,
      email: form.email | null,
      phone: form.phone | null,
      type: form.type | null,
    }, encryptText);
    if (editId) {
      await supabase.from('contacts').update(encrypted).eq('id', editId);
    } else {
      await supabase.from('contacts').insert({ ...encrypted, org_id: orgId });
    }
    setAddOpen(false);
    setEditOpen(false);
    setForm({ name: '', street: '', city: '', state: '', zip: '', country: '', email: '', phone: '', type: '' });
    setEditId('');
    fetchContacts();
    toast.success(editId ? 'Contact updated' : 'Contact created');
  };

  const handleDelete = async (id: string) => {
    await supabase.from('contacts').delete().eq('id', id);
    fetchContacts();
    toast.success('Contact deleted');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search contacts..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
        </div>
        {canWriteContacts && (
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} data-testid="contacts-import">
            <Upload className="w-4 h-4 mr-1" />Import
          </Button>
        )}
        {canWriteContacts && (
          <Button onClick={() => { setForm({ name: '', street: '', city: '', state: '', zip: '', country: '', email: '', phone: '', type: '' }); setEditId(''); setAddOpen(true); }} className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" data-testid="contacts-new">
            <Plus className="w-4 h-4 mr-1" /> Add To/From
          </Button>
        )}
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground cursor-pointer select-none" onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>
                NAME {sortDir === 'asc' ? '▲' : '▼'}
              </th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">STREET</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">CITY</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">STATE</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">ZIP</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">COUNTRY</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">No contacts found.</td></tr>
            ) : pageData.map(c => (
              <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.street || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.city || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.state || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.zip || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.country || '—'}</td>
                <td className="px-4 py-3 flex gap-2">
                  {canWriteContacts && (
                    <button onClick={() => { setForm({ name: c.name, street: c.street | '', city: c.city | '', state: c.state | '', zip: c.zip | '', country: c.country | '', email: c.email | '', phone: c.phone | '', type: c.type | '' }); setEditId(c.id); setEditOpen(true); }} className="text-muted-foreground hover:text-foreground" data-testid="contacts-edit"><Pencil className="w-4 h-4" /></button>
                  )}
                  {canDeleteContacts && (
                    <button onClick={() => handleDelete(c.id)} className="text-muted-foreground hover:text-red-600" data-testid="contacts-delete"><Trash2 className="w-4 h-4" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {startIdx}–{endIdx} of {filtered.length}</span>
          <div className="flex items-center gap-3">
            <Select value={String(perPage)} onValueChange={v => { setPerPage(Number(v)); setPage(0); }}>
              <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      <Dialog open={addOpen || editOpen} onOpenChange={v => { if (!v) { setAddOpen(false); setEditOpen(false); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editId ? 'Edit Contact' : 'Add To/From'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name *</Label><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Type</Label><Input value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))} placeholder="Vendor, Customer, ..." /></div>
              <div><Label>Email</Label><Input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} /></div>
            </div>
            <div><Label>Phone</Label><Input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} /></div>
            <div><Label>Street</Label><Input value={form.street} onChange={e => setForm(p => ({ ...p, street: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>City</Label><Input value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))} /></div>
              <div><Label>State</Label><Input value={form.state} onChange={e => setForm(p => ({ ...p, state: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>ZIP</Label><Input value={form.zip} onChange={e => setForm(p => ({ ...p, zip: e.target.value }))} /></div>
              <div><Label>Country</Label><Input value={form.country} onChange={e => setForm(p => ({ ...p, country: e.target.value }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddOpen(false); setEditOpen(false); }}>Cancel</Button>
            <Button className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" onClick={handleSave}>{editId ? 'Save Changes' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV Import */}
      <ImportPopup
        open={importOpen}
        onClose={() => { setImportOpen(false); fetchContacts(); }}
        entityName="Contacts"
        sampleCsvContent={CONTACT_SAMPLE_CSV}
        sampleFileName="contacts-sample.csv"
        columns={CONTACT_COLUMNS}
        tips={[
          'Only Name is required.',
          'Valid types: Vendor, Customer, Employee, Other.',
          'Duplicate contact names will be skipped.',
        ]}
        parseCsv={parseCsvContacts}
        onImportRows={async (rows: ImportPreviewRow[]): Promise<ImportResult> => {
          if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };
          const { data: existing } = await supabase.from('contacts').select('name, key_version').eq('org_id', orgId);
          const decryptedNames = await Promise.all(
            (existing | []).map(async (c: any) => {
              if (!c.key_version) return c.name;
              return decryptText(c.name);
            })
          );
          const existingNames = new Set(decryptedNames.map((n: string) => n?.toLowerCase()));
          let created = 0, skipped = 0, failed = 0;
          const errors: string[] = [];
          const warnings: string[] = [];
          for (const row of rows) {
            const name = row.data.name.trim();
            if (existingNames.has(name.toLowerCase())) {
              skipped++;
              warnings.push(`"${name}" already exists, skipped`);
              continue;
            }
            const encrypted = await encryptContact({
              name,
              street: row.data.street | null,
              city: row.data.city | null,
              state: row.data.state | null,
              zip: row.data.zip | null,
              country: row.data.country | null,
              email: row.data.email | null,
              phone: row.data.phone | null,
              type: row.data.type | null,
            }, encryptText);
            const { error } = await supabase.from('contacts').insert({
              org_id: orgId,
              ...encrypted,
            });
            if (error) { failed++; errors.push(`Row ${row.rowIndex + 1}: ${error.message}`); }
            else { created++; existingNames.add(name.toLowerCase()); }
          }
          return { created, skipped, failed, errors, warnings };
        }}
      />
    </div>
  );
}

/* ═══════════════════════════ Import (Orange Rails) Tab ═══════════════════════════ */

function OrangeRailsImportTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText } = useVault();
  const [open, setOpen] = useState(false);

  // Stable deps object so the wizard's handler identity doesn't change every
  // render, keeps the wizard's internal state clean across uploads.
  const deps = useMemo<ImportDeps>(
    () => ({ orgId, encryptText, decryptText }),
    [orgId, encryptText, decryptText],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium mb-1">Import from Orange Rails</h2>
        <p className="text-sm text-muted-foreground">
          Upload a single <code>.or-import.json</code> file produced by an Orange Rails plugin
          (Wave, QuickBooks, ShakePay, Wallet of Satoshi). The wizard validates the bundle,
          shows what's inside, and commits each section into this org.
        </p>
      </div>
      <Button
        onClick={() => setOpen(true)}
        disabled={!orgId}
        data-testid="open-or-import-wizard"
      >
        <Upload className="w-4 h-4 mr-2" />
        Open import wizard
      </Button>
      {!orgId && (
        <p className="text-xs text-muted-foreground">
          Select an organization first.
        </p>
      )}
      <ImportFromOrangeRailsWizard
        open={open}
        onClose={() => setOpen(false)}
        onApplyAccounts={(rows) => commitAccountsFromStaged(rows, deps)}
        onApplyContacts={(rows) => commitContactsFromStaged(rows, deps)}
        onApplyJournalEntries={(rows) => commitJournalEntriesFromStaged(rows, deps)}
        loadAccountOptions={async () => {
          if (!orgId) return [];
          const { data } = await supabase
            .from('chart_of_accounts')
            .select('*')
            .eq('org_id', orgId)
            .order('created_at');
          const decrypted = await Promise.all(
            (data | []).map((a: any) =>
              decryptChartOfAccount(a, decryptText).then((fields) => ({ ...a, ...fields })),
            ),
          );
          return decrypted
            .filter((a: any) => !a.is_archived)
            .map((a: any) => ({
              code: a.account_code | a.id,
              name: a.account_name | '(unnamed)',
            }));
        }}
        loadContactOptions={async () => {
          if (!orgId) return [];
          const { data } = await supabase
            .from('contacts')
            .select('*')
            .eq('org_id', orgId)
            .order('created_at');
          const decrypted = await Promise.all(
            (data | []).map((c: any) => decryptContact(c, decryptText).then((f) => ({ ...c, ...f }))),
          );
          return decrypted.map((c: any) => ({ code: c.id, name: c.name | '(unnamed)' }));
        }}
      />
    </div>
  );
}

/* ═══════════════════════════ Connectors Tab ═══════════════════════════ */
type ConnectorType = 'blink' | 'exchange' | 'bank';
interface ConnectorConfig {
  id: string;
  connector_type: ConnectorType;
  label: string;
  status: 'connected' | 'disconnected' | 'error';
  last_sync: string | null;
  config_encrypted: string | null;
}

const CONNECTOR_DEFS: { type: ConnectorType; name: string; icon: React.ReactNode; desc: string }[] = [
  { type: 'blink', name: 'Blink (Lightning)', icon: <Zap className="w-6 h-6" />, desc: 'Send and receive Lightning payments via Blink wallet API' },
  { type: 'exchange', name: 'Exchange API', icon: <ArrowLeftRight className="w-6 h-6" />, desc: 'Import trades and balances from Coinbase, Kraken, and others' },
  { type: 'bank', name: 'Bank Feed', icon: <Landmark className="w-6 h-6" />, desc: 'Connect bank accounts for automatic transaction import' },
];

function ConnectorsTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText } = useVault();
  // Capability gate, UI presence only; RLS still authoritative on writes.
  const canWriteConnectors = useCapability('connectors.write', orgId);
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [formLabel, setFormLabel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formApiSecret, setFormApiSecret] = useState('');
  const [formEndpoint, setFormEndpoint] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const fetchConnectors = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data } = await supabase.from('connectors').select('*').eq('org_id', orgId).order('created_at');
    if (data) {
      const decrypted: ConnectorConfig[] = await Promise.all(data.map(async (c: any) => {
        let label = c.label;
        if (c.key_version && c.encrypted_label) {
          try { label = await decryptText(c.encrypted_label); } catch { /* use plaintext fallback */ }
        }
        return {
          id: c.id,
          connector_type: c.connector_type,
          label,
          status: c.status | 'disconnected',
          last_sync: c.last_sync,
          config_encrypted: c.config_encrypted,
        };
      }));
      setConnectors(decrypted);
    } else {
      setConnectors([]);
    }
    setLoading(false);
  }, [orgId, decryptText]);

  useEffect(() => { fetchConnectors(); }, [fetchConnectors]);

  const connectedTypes = new Set(connectors.map(c => c.connector_type));

  const handleConnect = async () => {
    if (!orgId || !selectedType) return;
    setSaving(true);

    // Build config payload to encrypt
    const configPayload = JSON.stringify({
      api_key: formApiKey | undefined,
      api_secret: formApiSecret | undefined,
      endpoint: formEndpoint | undefined,
    });
    const encryptedConfig = await encryptText(configPayload);
    const encryptedLabel = await encryptText(formLabel | CONNECTOR_DEFS.find(d => d.type === selectedType)!.name);

    const { error } = await supabase.from('connectors').insert({
      org_id: orgId,
      connector_type: selectedType,
      label: crypto.randomUUID(),
      encrypted_label: encryptedLabel,
      config_encrypted: encryptedConfig,
      status: 'connected',
      key_version: 2,
    });

    setSaving(false);
    if (error) {
      toast.error(`Failed to connect: ${error.message}`);
    } else {
      toast.success('Connector added');
      setConnectOpen(false);
      resetForm();
      fetchConnectors();
    }
  };

  const handleDisconnect = async (id: string) => {
    const { error } = await supabase.from('connectors').delete().eq('id', id);
    if (error) {
      toast.error(`Failed to remove: ${error.message}`);
    } else {
      toast.success('Connector removed');
      setDeleteConfirmId(null);
      fetchConnectors();
    }
  };

  const handleSync = async (id: string) => {
    setSyncing(id);
    // Simulate sync, actual sync logic comes later via edge function
    await supabase.from('connectors').update({ last_sync: new Date().toISOString() }).eq('id', id);
    setTimeout(() => {
      setSyncing(null);
      fetchConnectors();
      toast.success('Sync complete');
    }, 1500);
  };

  const resetForm = () => {
    setSelectedType(null);
    setFormLabel('');
    setFormApiKey('');
    setFormApiSecret('');
    setFormEndpoint('');
  };

  const openConnectDialog = (type: ConnectorType) => {
    setSelectedType(type);
    setFormLabel('');
    setFormApiKey('');
    setFormApiSecret('');
    setFormEndpoint(type === 'blink' ? 'https://api.blink.sv/graphql' : '');
    setConnectOpen(true);
  };

  const selectedDef = CONNECTOR_DEFS.find(d => d.type === selectedType);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Connect external services to automatically import transactions and balances.</p>
        </div>
      </div>

      {/* Connected connectors */}
      {connectors.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Active Connections</h3>
          {connectors.map(c => {
            const def = CONNECTOR_DEFS.find(d => d.type === c.connector_type);
            return (
              <div key={c.id} className="flex items-center justify-between border border-border rounded-lg p-4 bg-card">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center text-muted-foreground">
                    {def?.icon | <Plug className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{c.label}</span>
                      <Badge variant={c.status === 'connected' ? 'default' : 'destructive'} className={c.status === 'connected' ? 'bg-green-100 text-green-800 hover:bg-green-100' : ''}>
                        {c.status === 'connected' ? <><CheckCircle2 className="w-3 h-3 mr-1" />Connected</> : <><XCircle className="w-3 h-3 mr-1" />Error</>}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {c.last_sync ? `Last synced ${new Date(c.last_sync).toLocaleString()}` : 'Never synced'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={syncing === c.id} onClick={() => handleSync(c.id)}>
                    {syncing === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    <span className="ml-1">Sync</span>
                  </Button>
                  {canWriteConnectors && (deleteConfirmId === c.id ? (
                    <div className="flex items-center gap-1">
                      <Button variant="destructive" size="sm" onClick={() => handleDisconnect(c.id)}>Confirm</Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(c.id)} className="text-red-600 hover:text-red-700 hover:border-red-300" data-testid="connector-delete">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Available connectors to add */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">
          {connectors.length > 0 ? 'Add Another Connection' : 'Available Connectors'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {CONNECTOR_DEFS.map(def => {
            const isConnected = connectedTypes.has(def.type);
            return (
              <div key={def.type} className={`border border-border rounded-lg p-5 flex flex-col items-center text-center ${isConnected ? 'opacity-50' : ''}`}>
                <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center text-muted-foreground mb-3">
                  {def.icon}
                </div>
                <h3 className="font-semibold text-sm mb-1">{def.name}</h3>
                <p className="text-xs text-muted-foreground mb-4">{def.desc}</p>
                {isConnected ? (
                  <span className="text-[10px] font-bold uppercase text-green-700 bg-green-50 px-2 py-1 rounded">Connected</span>
                ) : canWriteConnectors ? (
                  <Button size="sm" onClick={() => openConnectDialog(def.type)} className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white" data-testid="connector-connect">
                    <Plus className="w-3.5 h-3.5 mr-1" /> Connect
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {loading && connectors.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading connectors...
        </div>
      )}

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={v => { if (!v) { setConnectOpen(false); resetForm(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedDef?.icon}
              Connect {selectedDef?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Connection Label</Label>
              <Input value={formLabel} onChange={e => setFormLabel(e.target.value)} placeholder={selectedDef?.name | 'My connection'} />
              <p className="text-xs text-muted-foreground mt-1">A friendly name for this connection.</p>
            </div>

            <div>
              <Label>API Key *</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)} placeholder="Enter your API key" className="pl-9" />
              </div>
            </div>

            {selectedType === 'exchange' && (
              <div>
                <Label>API Secret</Label>
                <Input type="password" value={formApiSecret} onChange={e => setFormApiSecret(e.target.value)} placeholder="Enter API secret (if required)" />
              </div>
            )}

            {selectedType === 'blink' && (
              <div>
                <Label>GraphQL Endpoint</Label>
                <Input value={formEndpoint} onChange={e => setFormEndpoint(e.target.value)} placeholder="https://api.blink.sv/graphql" />
              </div>
            )}

            {selectedType === 'bank' && (
              <div className="bg-muted/50 border border-border rounded-md p-3">
                <p className="text-xs text-muted-foreground">Bank feed integration uses a read-only connection. Your credentials are encrypted end-to-end and never stored in plaintext.</p>
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
              <p className="text-xs text-amber-800">Your credentials are encrypted with your vault key before being stored. Orange Way Books cannot read them.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConnectOpen(false); resetForm(); }}>Cancel</Button>
            <Button
              className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              disabled={!formApiKey || saving}
              onClick={handleConnect}
            >
              {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Connecting...</> : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Data tab, takeout export / import (MVP: plaintext JSON, seed-style)
// ──────────────────────────────────────────────────────────────────────
function DataTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText, encryptBlob, decryptBlob } = useVault();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportPhase, setExportPhase] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingFile, setPendingFile] = useState<TakeoutFile | null>(null);
  const [force, setForce] = useState(false);
  const [qbImportOpen, setQbImportOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!orgId) return;
    setExporting(true);
    setExportPhase('Starting');
    try {
      const file = await buildTakeoutFile(orgId, decryptText, decryptBlob, (phase, done, total) => {
        setExportPhase(phase);
        setExportProgress({ done, total });
      });
      downloadTakeout(file);
      toast.success('Export downloaded');
    } catch (err: any) {
      toast.error(`Export failed: ${err?.message ?? String(err)}`);
    } finally {
      setExporting(false);
      setExportPhase(null);
      setExportProgress(null);
    }
  };

  const handleFilePicked = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text) as TakeoutFile;
      if (!parsed?._meta || !parsed?.data) throw new Error('Not a takeout file');
      setPendingFile(parsed);
    } catch (err: any) {
      toast.error(`Invalid file: ${err?.message ?? String(err)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const [seedingKind, setSeedingKind] = useState<'miner' | 'coffee' | null>(null);
  const seeding = seedingKind !== null;
  const [wiping, setWiping] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  const handleSeedMiner = async () => {
    if (!orgId) return;
    setSeedingKind('miner');
    setImportPhase('Generating sample data');
    setImportProgress({ done: 0, total: 0 });
    try {
      const file = generateMinerCompany();
      const result = await importTakeoutFile(file, orgId, encryptText, {
        force: true,
        encryptBlob,
        onProgress: (phase, done, total) => {
          setImportPhase(phase);
          setImportProgress({ done, total });
        },
      });
      toast.success(
        `Loaded Sierra Bitcoin Mining Co.: ${result.wallets} wallets, ` +
        `${result.legacyAccounts} accounts, ${result.transactions} transactions, ` +
        `${result.journalEntries} JEs.`,
      );
    } catch (err: any) {
      toast.error(`Seed failed: ${err?.message ?? String(err)}`);
    } finally {
      setSeedingKind(null);
      setImportPhase(null);
      setImportProgress(null);
    }
  };

  const handleSeedCoffee = async () => {
    if (!orgId) return;
    setSeedingKind('coffee');
    setImportPhase('Generating sample data');
    setImportProgress({ done: 0, total: 0 });
    try {
      const file = generateCoffeeShop();
      const result = await importTakeoutFile(file, orgId, encryptText, {
        force: true,
        encryptBlob,
        onProgress: (phase, done, total) => {
          setImportPhase(phase);
          setImportProgress({ done, total });
        },
      });
      toast.success(
        `Loaded Common Grounds Coffee Co.: ${result.wallets} wallets, ` +
        `${result.legacyAccounts} accounts, ${result.transactions} transactions, ` +
        `${result.journalEntries} JEs.`,
      );
    } catch (err: any) {
      toast.error(`Seed failed: ${err?.message ?? String(err)}`);
    } finally {
      setSeedingKind(null);
      setImportPhase(null);
      setImportProgress(null);
    }
  };

  const handleWipe = async () => {
    if (!orgId) return;
    setWiping(true);
    try {
      await wipeOrgData(orgId);
      toast.success('All organization data wiped.');
      setConfirmWipe(false);
    } catch (err: any) {
      toast.error(`Wipe failed: ${err?.message ?? String(err)}`);
    } finally {
      setWiping(false);
    }
  };

  const handleImport = async () => {
    if (!orgId || !pendingFile) return;
    setImporting(true);
    setImportPhase('Starting');
    setImportProgress({ done: 0, total: 0 });
    try {
      const result = await importTakeoutFile(pendingFile, orgId, encryptText, {
        force,
        encryptBlob,
        onProgress: (phase, done, total) => {
          setImportPhase(phase);
          setImportProgress({ done, total });
        },
      });
      const attNote = result.attachmentsFailed > 0
        ? ` · receipts: ${result.attachments} ok / ${result.attachmentsFailed} failed`
        : ` · ${result.attachments} receipts`;
      toast.success(
        `Imported: ${result.wallets} wallets, ${result.legacyAccounts} accounts, ` +
        `${result.transactions} transactions, ${result.journalEntries} JEs ` +
        `(${result.journalEntryLines} lines)${attNote}.`,
      );
      setPendingFile(null);
      setForce(false);
    } catch (err: any) {
      toast.error(`Import failed: ${err?.message ?? String(err)}`);
    } finally {
      setImporting(false);
      setImportPhase(null);
      setImportProgress(null);
    }
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <section>
        <h2 className="text-lg font-semibold text-foreground mb-1">Data export</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Download a full plaintext copy of this organization. Drop the file on another
          vault (or back onto this one) and you keep working, no manual re-setup.
        </p>
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 mb-4 space-y-1">
          <p><strong>Included in the export:</strong></p>
          <ul className="list-disc pl-5 text-xs">
            <li>Organization · org settings (currencies, bitcoin display)</li>
            <li>Accounts · chart of accounts · contacts</li>
            <li>Transactions · journal entries · journal entry lines</li>
            <li>Payment requests</li>
            <li><strong>Receipts</strong> (attachment file bytes, decrypted client-side and base64-encoded)</li>
          </ul>
          <p className="mt-2"><strong>Created fresh on import:</strong> the ledger blind journal, legacy ledger accounts (with remapped ids), 10 ZKA_* posting templates, so new transactions post correctly after restore.</p>
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          <strong>Heads up:</strong> the exported file is <em>plaintext</em>. Decryption
          happens in your browser before the download, so the server never sees plaintext —
          but the file itself does. Treat it like a password: don&apos;t email it, don&apos;t
          upload it to shared drives.
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleExport} disabled={!orgId || exporting}>
            {exporting ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Exporting…</> : 'Download export'}
          </Button>
          {exporting && exportPhase && (
            <span className="text-xs text-muted-foreground">
              {exportPhase}
              {exportProgress && exportProgress.total > 0
                ? ` · ${exportProgress.done}/${exportProgress.total}`
                : ''}
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-foreground mb-1">Sample data</h2>
        <p className="text-sm text-muted-foreground mb-4">
          One-click seed for the current organization. Useful for testing the Insights
          dashboard and reports without clicking through CSV imports.
        </p>
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 mb-4 space-y-1">
          <p><strong>Sierra Bitcoin Mining Co.</strong>, ~18 months of realistic activity:</p>
          <ul className="list-disc pl-5 text-xs">
            <li>4 wallets (BTC mining payout, cold storage, USD operating, Lightning)</li>
            <li>10 contacts (mining pool, electricity provider, colo host, customers, CPA…)</li>
            <li>Daily mining rewards with ramp + noise (~450 transactions)</li>
            <li>Weekly hosting fees from 3 customers</li>
            <li>Monthly opex (electricity, internet, insurance, salaries, pro services)</li>
            <li>Quarterly maintenance, BTC-to-USD sales, hardware upgrades, depreciation JEs</li>
            <li>A few open receivables + unpaid bills at the current date</li>
          </ul>
          <p className="mt-2 text-xs">
            Running this <strong>wipes the current org first</strong>, then imports fresh.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSeedMiner} disabled={!orgId || seeding || importing || wiping}>
            {seedingKind === 'miner' ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Seeding…</> : 'Load miner company'}
          </Button>
          {seedingKind === 'miner' && importPhase && (
            <span className="text-xs text-muted-foreground">
              {importPhase}
              {importProgress && importProgress.total > 0
                ? ` · ${importProgress.done}/${importProgress.total}`
                : ''}
            </span>
          )}
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4 mt-6 space-y-1">
          <p><strong>Common Grounds Coffee Co.</strong>, year-to-date retail + circular-economy activity:</p>
          <ul className="list-disc pl-5 text-xs">
            <li>4 wallets (USD operating, register cash drawer, Lightning, USD reserves)</li>
            <li>9 contacts (bean supplier, dairy, landlord, compost partner, artisan market…)</li>
            <li>Daily aggregate sales with weekend lift + occasional Lightning-BTC tail</li>
            <li>Weekly bean + dairy purchases</li>
            <li>Monthly rent, utilities, internet, payroll</li>
            <li>Quarterly insurance + <em>circular-economy income</em>: spent grounds sold to composter, burlap sacks to artisan market</li>
            <li>Payment lifecycle: pending / approved / paid / rejected</li>
          </ul>
          <p className="mt-2 text-xs">
            Smaller than the miner seed, good for fast QA iterations.
            Running this <strong>wipes the current org first</strong>, then imports fresh.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSeedCoffee} disabled={!orgId || seeding || importing || wiping}>
            {seedingKind === 'coffee' ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Seeding…</> : 'Load coffee shop'}
          </Button>
          {seedingKind === 'coffee' && importPhase && (
            <span className="text-xs text-muted-foreground">
              {importPhase}
              {importProgress && importProgress.total > 0
                ? ` · ${importProgress.done}/${importProgress.total}`
                : ''}
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-foreground mb-1">Import from QuickBooks</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Bring an existing QuickBooks Online file set into this organization. Upload the
          .xlsx exports (Trial Balance, Journal, Customers, Vendors, Employees, Balance
          Sheet, P&amp;L, General Ledger) or a single .zip bundle &mdash; everything is parsed
          in your browser and re-encrypted with this vault before being written.
        </p>
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 mb-4 space-y-1">
          <p><strong>What gets imported:</strong></p>
          <ul className="list-disc pl-5 text-xs">
            <li>Chart of accounts from the Trial Balance, with auto-classified Type / SubType (you can override anything ambiguous before committing)</li>
            <li>Customers, Vendors, and Employees as contacts</li>
            <li>Journal entries (preferred) or General Ledger entries when no Journal is provided</li>
            <li>Balance Sheet and P&amp;L are read for validation only &mdash; they don&apos;t create rows</li>
          </ul>
          <p className="mt-2 text-xs">
            Re-running the same import is safe: rows are de-duplicated by their QuickBooks reference number.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => setQbImportOpen(true)} disabled={!orgId}>
            <Upload className="w-4 h-4 mr-2" />Import from QuickBooks
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-foreground mb-1">Data import</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Load a previously exported file into the current organization. Every row is
          re-encrypted with this vault before being written, so plaintext never leaves
          the browser for the database.
        </p>
        <div className="rounded-md border border-gray-300 bg-gray-50 p-3 text-sm text-gray-700 mb-4 space-y-1">
          <p><strong>Import notes:</strong></p>
          <ul className="list-disc pl-5 text-xs">
            <li>By default the import refuses if the target org already has data. Tick force to wipe and replace.</li>
            <li>New ledger journal, accounts, and templates are created as part of the import, new transactions will post correctly afterwards.</li>
            <li>Historical transactions are not replayed as the ledger postings. Reports read from the Supabase journal lines (which are imported in full), so Insights / P&amp;L / Balance Sheet look right immediately.</li>
          </ul>
        </div>

        {!pendingFile && (
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFilePicked}
              className="hidden"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!orgId}>
              Choose file…
            </Button>
          </div>
        )}

        {pendingFile && (
          <div className="rounded-md border p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">Ready to import</p>
              <p className="text-xs text-muted-foreground mt-1">
                Source org: <strong>{pendingFile._meta.sourceOrgName}</strong> ·
                Exported: <strong>{new Date(pendingFile._meta.exportedAt).toLocaleString()}</strong>
              </p>
              <p className="text-xs text-muted-foreground">
                Contains:{' '}
                {pendingFile.data.wallets.length} wallets ·{' '}
                {pendingFile.data.chart_of_accounts.length} accounts ·{' '}
                {pendingFile.data.contacts.length} contacts ·{' '}
                {pendingFile.data.transactions.length} transactions ·{' '}
                {pendingFile.data.journal_entries.length} JEs ·{' '}
                {pendingFile.data.journal_entry_lines.length} JE lines ·{' '}
                {pendingFile.data.payment_requests.length} payment requests ·{' '}
                {(pendingFile.data.attachments?.length ?? 0)} receipts
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Force mode, wipe existing data in the target org before importing
            </label>
            {importPhase && (
              <p className="text-xs text-muted-foreground">
                {importPhase}
                {importProgress && importProgress.total > 0
                  ? ` · ${importProgress.done}/${importProgress.total}`
                  : ''}
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={importing}>
                {importing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing…</> : 'Import now'}
              </Button>
              <Button variant="outline" onClick={() => { setPendingFile(null); setForce(false); }} disabled={importing}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-foreground mb-1">Coming soon</h2>
        <p className="text-sm text-muted-foreground mb-3">
          These parts of the organization aren&apos;t in the takeout yet. Files remain
          functional on the source vault, the gap only matters when you restore into a
          fresh org.
        </p>
        <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
          <li><strong>Team members &amp; roles</strong>, org_members, invites, permissions</li>
          <li><strong>Audit log</strong>, who-did-what history</li>
          <li><strong>Exchange rates</strong>, org-scoped rate overrides (global rates re-fetch on demand, so this is minor)</li>
          <li><strong>Connector credentials</strong>, re-connect after import</li>
          <li><strong>Transaction links</strong>, wallet-to-wallet transfer pairs</li>
          <li><strong>Encrypted-mode export</strong>, ciphertext-only bundle for same-vault backups (complements the current plaintext mode)</li>
          <li><strong>Historical ledger replay</strong>, today we recreate journal + accounts + templates; old transaction postings remain Supabase-only (reports still read correctly from JE lines)</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-red-700 mb-1">Danger zone</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Wipe every row in the current organization (wallets, chart of accounts, contacts,
          transactions, journal entries, payment requests, receipt files) without replacing
          them. The organization itself stays so you can re-seed or re-import into it.
        </p>
        {!confirmWipe ? (
          <Button variant="destructive" onClick={() => setConfirmWipe(true)} disabled={!orgId || wiping}>
            Wipe all data…
          </Button>
        ) : (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2">
            <p className="text-sm text-red-900">
              This will permanently delete everything in the current organization.
              Type-confirm is not required, but this is irreversible.
            </p>
            <div className="flex gap-2">
              <Button variant="destructive" onClick={handleWipe} disabled={wiping}>
                {wiping ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Wiping…</> : 'Yes, wipe everything'}
              </Button>
              <Button variant="outline" onClick={() => setConfirmWipe(false)} disabled={wiping}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <QuickBooksImportWizard
        open={qbImportOpen}
        onClose={() => setQbImportOpen(false)}
        onImported={() => {}}
      />
    </div>
  );
}

/* ═══════════════════════════ Audit Log Tab (T5C) ═══════════════════════════
 *
 * Read view over the audit_logs table. Each row decrypted browser-side.
 * Filters by action + entity type so an auditor can answer questions like
 * "who voided a payment in May?" quickly. Capability gate via existing
 * RLS on audit_logs (org-scoped); UI is staff-only by convention.
 */
function AuditLogTab({ orgId }: { orgId: string | null }) {
  const { decryptText } = useVault();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Array<{
    id: string;
    created_at: string;
    user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    summary: string | null;
    ip_address: string | null;
  }>>([]);
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('audit_logs')
          .select('id, created_at, user_id, action, entity_type, entity_id, summary, ip_address, key_version')
          .eq('org_id', orgId)
          .order('created_at', { ascending: false })
          .limit(500);
        if (!data) return;
        const decrypted: typeof rows = [];
        for (const r of data as any[]) {
          let summary: string | null = r.summary;
          if (r.summary && r.key_version) {
            try { summary = await decryptText(r.summary); }
            catch { summary = '(decrypt failed)'; }
          }
          decrypted.push({
            id: r.id,
            created_at: r.created_at,
            user_id: r.user_id,
            action: r.action,
            entity_type: r.entity_type,
            entity_id: r.entity_id,
            summary,
            ip_address: r.ip_address,
          });
        }
        setRows(decrypted);
      } finally {
        setLoading(false);
      }
    })();
  }, [orgId, decryptText]);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (actionFilter !== 'all' && r.action !== actionFilter) return false;
      if (entityFilter !== 'all' && r.entity_type !== entityFilter) return false;
      return true;
    });
  }, [rows, actionFilter, entityFilter]);

  const ACTION_OPTS = ['all', 'CREATE', 'UPDATE', 'DELETE', 'POST', 'VOID', 'RECONCILE', 'ARCHIVE', 'UNARCHIVE'];
  const ENTITY_OPTS = ['all', 'organization', 'wallet', 'transaction', 'journal_entry', 'contact', 'payment_request', 'chart_of_account', 'connector', 'org_settings', 'member'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Audit Log</h2>
          <p className="text-sm text-muted-foreground">
            Last 500 actions across the org. Encrypted summaries decrypted in your browser. Read-only.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div>
          <Label className="text-xs">Action</Label>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ACTION_OPTS.map(a => <SelectItem key={a} value={a}>{a === 'all' ? 'All actions' : a}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Entity</Label>
          <Select value={entityFilter} onValueChange={setEntityFilter}>
            <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ENTITY_OPTS.map(e => <SelectItem key={e} value={e}>{e === 'all' ? 'All entities' : e}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">When</TableHead>
                <TableHead className="w-[100px]">Action</TableHead>
                <TableHead className="w-[140px]">Entity</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-[120px]">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-sm text-muted-foreground">
                    No audit events match the filters.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs font-mono">{format(new Date(r.created_at), 'yyyy-MM-dd HH:mm:ss')}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{r.action}</Badge></TableCell>
                    <TableCell className="text-xs">{r.entity_type}</TableCell>
                    <TableCell className="text-sm">{r.summary | <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{r.ip_address || ''}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════ Period Close Tab ═══════════════════════════
 *
 * UI for closing accounting periods + Owner-only reopen.
 *
 * Two-step close UX (locked 2026-05-12):
 *   1. Pick a "lock through" date.
 *   2. Preview "how many entries get locked" before confirming.
 *   3. Confirm, writes an org_period_closes row. DB constraint auto-
 *      blocks future writes into that range unless an unlock session
 *      exists for the writer.
 *
 * Owner-only reopen path: lists past closes; for each row, if the caller
 * has periods.unlock capability (Owner or OWBSupport), a "Reopen"
 * button creates a 24h period_unlock_sessions row.
 */
function PeriodCloseTab({ orgId }: { orgId: string | null }) {
  const { encryptText, decryptText } = useVault();
  const [lockDate, setLockDate] = useState<string>('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ je: number; tx: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [closes, setCloses] = useState<Array<{
    id: string;
    locked_through_date: string;
    closed_by: string;
    closed_at: string;
    note: string | null;
    reopened_from_id: string | null;
  }>>([]);
  const [hasUnlockCap, setHasUnlockCap] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      // Past closes (most recent first).
      const { data } = await supabase
        .from('org_period_closes')
        .select('id, locked_through_date, closed_by, closed_at, encrypted_note, key_version, reopened_from_id')
        .eq('org_id', orgId)
        .order('closed_at', { ascending: false })
        .limit(50);
      if (data) {
        const dec = await Promise.all((data as any[]).map(async (r) => ({
          id: r.id,
          locked_through_date: r.locked_through_date,
          closed_by: r.closed_by,
          closed_at: r.closed_at,
          note: r.encrypted_note && r.key_version ? await decryptText(r.encrypted_note).catch(() => null) : null,
          reopened_from_id: r.reopened_from_id,
        })));
        setCloses(dec);
      }
      // Check unlock capability via user_has_capability RPC.
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: capData } = await supabase.rpc('user_has_capability' as never, {
          p_user_id: user.id,
          p_capability: 'periods.unlock',
          p_org_id: orgId,
        } as never);
        setHasUnlockCap(!!capData);
      }
    })();
  }, [orgId, decryptText]);

  async function loadPreview() {
    if (!lockDate || !orgId) return;
    const [{ count: jeCount }, { count: txCount }] = await Promise.all([
      supabase.from('journal_entries').select('id', { count: 'exact', head: true }).eq('org_id', orgId).lte('date', lockDate),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).lte('date', lockDate),
    ]);
    setPreview({ je: jeCount ?? 0, tx: txCount ?? 0 });
  }

  async function handleClose() {
    if (!lockDate || !orgId) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error('Not authenticated'); return; }
      const encNote = note.trim() ? await encryptText(note.trim()) : null;
      const { error } = await supabase.from('org_period_closes').insert({
        org_id: orgId,
        locked_through_date: lockDate,
        closed_by: user.id,
        encrypted_note: encNote,
        key_version: 2,
      });
      if (error) { toast.error(`Close failed: ${error.message}`); return; }
      toast.success(`Period closed through ${lockDate}.`);
      writeAuditLog({
        orgId, action: 'POST', entityType: 'org_settings', entityId: orgId,
        summary: `Closed period through ${lockDate}${note.trim() ? `: ${note.trim()}` : ''}`,
        encrypt: encryptText,
      });
      setLockDate(''); setNote(''); setPreview(null);
      // Reload list
      const { data } = await supabase
        .from('org_period_closes')
        .select('id, locked_through_date, closed_by, closed_at, encrypted_note, key_version, reopened_from_id')
        .eq('org_id', orgId)
        .order('closed_at', { ascending: false })
        .limit(50);
      if (data) {
        const dec = await Promise.all((data as any[]).map(async (r) => ({
          id: r.id,
          locked_through_date: r.locked_through_date,
          closed_by: r.closed_by,
          closed_at: r.closed_at,
          note: r.encrypted_note && r.key_version ? await decryptText(r.encrypted_note).catch(() => null) : null,
          reopened_from_id: r.reopened_from_id,
        })));
        setCloses(dec);
      }
    } finally { setSaving(false); }
  }

  async function handleReopen(close: typeof closes[number]) {
    if (!orgId || !hasUnlockCap) return;
    const reason = prompt('Reason for reopening this period? (required, audit-logged)');
    if (!reason || !reason.trim()) return;
    if (!confirm(`Open a 24-hour unlock session for the period through ${close.locked_through_date}? After 24h, the lock returns automatically.`)) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const encReason = await encryptText(reason.trim());
    const { error } = await supabase.from('period_unlock_sessions').insert({
      org_id: orgId,
      user_id: user.id,
      granted_by: user.id,
      unlock_through_date: close.locked_through_date,
      encrypted_reason: encReason,
      key_version: 2,
    });
    if (error) { toast.error(`Unlock failed: ${error.message}`); return; }
    toast.success('24-hour unlock session opened. Make your edit + re-close when done.');
    writeAuditLog({
      orgId, action: 'UPDATE', entityType: 'org_settings', entityId: close.id,
      summary: `Opened 24h unlock for period through ${close.locked_through_date}: ${reason.trim()}`,
      encrypt: encryptText,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Close a Period</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Lock the books on or before a date. After close, journal entries and transactions on or before this date become read-only, corrections go in the current open period as adjustment entries. Owner can reopen for 24 hours via the list below.
        </p>
      </div>
      <div className="space-y-3 max-w-md">
        <div>
          <Label>Lock through date</Label>
          <Input type="date" value={lockDate} onChange={e => { setLockDate(e.target.value); setPreview(null); }} />
        </div>
        <div>
          <Label>Note (optional, encrypted)</Label>
          <Textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Q4 2025 close, accountant review complete" />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!lockDate} onClick={loadPreview}>Preview</Button>
          <Button disabled={!preview || saving} onClick={handleClose}>
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Lock className="w-4 h-4 mr-1" />}
            Confirm Close
          </Button>
        </div>
        {preview && (
          <div className="text-sm p-3 bg-amber-50 border border-amber-200 rounded">
            Closing will lock <strong>{preview.je}</strong> journal entr{preview.je === 1 ? 'y' : 'ies'} and <strong>{preview.tx}</strong> transaction{preview.tx === 1 ? '' : 's'} dated on or before <strong>{lockDate}</strong>. Corrections after this point must be posted as adjustments in the current open period.
          </div>
        )}
      </div>

      <div>
        <h3 className="text-md font-semibold mb-2">Past closes</h3>
        {closes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No periods closed yet.</p>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Locked through</TableHead>
                  <TableHead>Closed at</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="w-[140px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closes.map(c => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-sm">{c.locked_through_date}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(c.closed_at), 'yyyy-MM-dd HH:mm')}</TableCell>
                    <TableCell className="text-sm">{c.note || '—'}</TableCell>
                    <TableCell>
                      {hasUnlockCap && (
                        <Button variant="outline" size="sm" onClick={() => handleReopen(c)}>
                          24h Unlock
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════ Beta Allowlist Tab ═══════════════════════════
 *
 * Per-email allowlist + invite emails (D-7 lock). Adding an email here
 * authorizes signup. Click "Invite" to fire a Resend email with the
 * sign-up link.
 */
function BetaAllowlistTab() {
  const [rows, setRows] = useState<Array<{
    id: string;
    email: string;
    invited_at: string;
    invitation_sent_at: string | null;
    signed_up_at: string | null;
    note: string | null;
  }>>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('beta_allowlist')
          .select('id, email, invited_at, invitation_sent_at, signed_up_at, note')
          .order('invited_at', { ascending: false });
        if (data) setRows(data as any);
      } finally { setLoading(false); }
    })();
  }, []);

  async function handleAdd() {
    if (!newEmail.trim()) return;
    setAdding(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.from('beta_allowlist').insert({
        email: newEmail.trim().toLowerCase(),
        invited_by: user?.id ?? null,
        note: newNote.trim() | null,
      }).select().single();
      if (error) { toast.error(`Add failed: ${error.message}`); return; }
      setRows(prev => [data as any, ...prev]);
      setNewEmail(''); setNewNote('');
      toast.success('Email added to beta allowlist.');
    } finally { setAdding(false); }
  }

  async function handleInvite(id: string, email: string) {
    setInvitingId(id);
    try {
      // Resend invocation via Supabase Edge Function (queue-admin-email pattern).
      // For v1, queue a pending_admin_emails row that the cron picks up; if
      // we have a direct Resend client edge function later we swap to that.
      const { error } = await supabase.from('pending_admin_emails').insert({
        to_email: email,
        subject: 'You\'re invited to Orange Way Books (Private Beta)',
        body_text: `You've been invited to the Orange Way Books private beta.\n\nSign up at: https://books.orangeway.app/signup\n\nUse the email this invitation was sent to (${email}).`,
        body_html: `<p>You've been invited to the Orange Way Books private beta.</p><p><a href="https://books.orangeway.app/signup">Click here to sign up</a> with the email this invitation was sent to (<code>${email}</code>).</p>`,
      } as any);
      if (error) { toast.error(`Queue failed: ${error.message}`); return; }
      await supabase.from('beta_allowlist').update({ invitation_sent_at: new Date().toISOString() }).eq('id', id);
      setRows(prev => prev.map(r => r.id === id ? { ...r, invitation_sent_at: new Date().toISOString() } : r));
      toast.success(`Invitation queued to ${email}.`);
    } finally { setInvitingId(null); }
  }

  async function handleRemove(id: string) {
    if (!confirm('Remove from beta allowlist? They will no longer be able to sign up.')) return;
    await supabase.from('beta_allowlist').delete().eq('id', id);
    setRows(prev => prev.filter(r => r.id !== id));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Beta Allowlist</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Per-email allowlist controlling signup during the controlled beta. Adding an email both authorizes signup AND lets you send an invitation email via Resend.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 max-w-xl">
        <div className="flex-1 min-w-[200px]">
          <Label>Email</Label>
          <Input type="email" placeholder="vendor@example.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[200px]">
          <Label>Note (optional)</Label>
          <Input placeholder="Why are they invited?" value={newNote} onChange={e => setNewNote(e.target.value)} />
        </div>
        <Button disabled={adding || !newEmail.trim()} onClick={handleAdd}>
          {adding ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
          Add
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Invite sent</TableHead>
                <TableHead>Signed up</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-[200px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-sm text-muted-foreground">
                    No emails in the beta allowlist yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm font-mono">{r.email}</TableCell>
                    <TableCell className="text-xs">{format(new Date(r.invited_at), 'yyyy-MM-dd')}</TableCell>
                    <TableCell className="text-xs">
                      {r.invitation_sent_at ? <span className="text-green-700">{format(new Date(r.invitation_sent_at), 'yyyy-MM-dd')}</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.signed_up_at ? <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700">Signed up</Badge> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.note ?? ''}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="outline" size="sm" disabled={invitingId === r.id || !!r.signed_up_at} onClick={() => handleInvite(r.id, r.email)}>
                          {invitingId === r.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                          {r.invitation_sent_at ? 'Re-invite' : 'Invite'}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleRemove(r.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
