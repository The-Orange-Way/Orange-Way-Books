import { useState, useMemo, useEffect, Fragment, type ReactElement, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  ChevronRight,
  CalendarIcon,
  X,
  TrendingUp,
  FileText,
  Zap,
  BookOpen,
  Scale,
  Loader2,
  Clock,
  Printer,
} from 'lucide-react';
import { format, startOfYear, startOfMonth, startOfWeek, subMonths, subYears } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { formatFiat } from '@/lib/formatters';
import { useVault } from '@/context/VaultContext';
import {
  decryptOrganization,
  decryptOrgSettings,
  decryptJournalEntryLine,
  decryptChartOfAccount,
} from '@/lib/crypto-fields';
import { useSecondaryDisplayRate } from '@/lib/exchange/hooks';
import { computePrimaryCurrencyBoundaries } from '@/lib/ledger-engine/boundary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
// DropdownMenu removed — CSV/Print buttons replaced the export dropdown
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { BitcoinDisplay } from '@/types';
import {
  computeAccountBalances,
  computePnL,
  computeBalanceSheet,
  computeTrialBalance,
  computeGeneralLedger,
  computeCashFlow,
  classifyAccountForCashFlow,
  journalLineInDateRange,
  type JournalLine,
  type AccountInfo,
  type PnLReport as PnLData,
  type BalanceSheetReport as BSData,
  type TrialBalanceReport as TBData,
  type GLEntry,
  type CashFlowReport as CFData,
  type DateRange,
  type ReportSection as LedgerReportSection,
  type AccountBalance,
} from '@/lib/ledger-engine';
import {
  buildAccountClosureFromList,
  buildReportHierarchyRoots,
  hierarchyNodeToDisplayLine,
  plSectionPredicate,
  bsSectionPredicate,
  type CoaClosureRow,
  type HierarchyLeafLine,
  type HierarchySectionPredicate,
  type ReportHierarchyNode,
} from '@/lib/reports/report-hierarchy';
import { ReportsViewToggle, type ReportViewMode } from '@/components/reports/ReportsViewToggle';
import { fetchBrandLogoDataUri } from '@/lib/exports/fetch-brand-logo';
import { formatNumericForCsvCell } from '@/lib/exports/format-numeric-csv';
import { csvExportCurrencyLabel } from '@/lib/exports/csv-currency-label';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';
import { reportPrintReportingNote } from '@/lib/reports/report-print-reporting-note';
import { auditFooterCsv } from '@/lib/reports/audit-footer';
import type { AuditFramework, FxTranslationMethod } from '@/lib/reports/audit-footer';

type ReportType =
  | 'pnl'
  | 'balance-sheet'
  | 'cash-flow'
  | 'general-ledger'
  | 'trial-balance'
  | 'activity-log';
type DatePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'ytd'
  | 'this_year'
  | 'last_month'
  | 'last_year'
  | 'all_time'
  | 'custom';

/** Matches toolbar: Account / Primary / Secondary — used for the CSV column title next to amounts. */
type ReportCurrencyMode = 'wallet' | 'primary' | 'secondary';

function reportCsvCurrencyExportColumnHeader(mode: ReportCurrencyMode): string {
  switch (mode) {
    case 'wallet':
      return 'Wallet Currency';
    case 'secondary':
      return 'Secondary Currency';
    case 'primary':
    default:
      return 'Primary Currency';
  }
}

interface ReportCard {
  id: ReportType;
  name: string;
  description: string;
  icon: typeof TrendingUp;
  color: string;
  bg: string;
}

const REPORTS: ReportCard[] = [
  {
    id: 'pnl',
    name: 'Profit & Loss',
    description: 'Income, expenses & net profit',
    icon: TrendingUp,
    color: '#16a34a',
    bg: '#DCFCE7',
  },
  {
    id: 'balance-sheet',
    name: 'Balance Sheet',
    description: 'Assets, liabilities & equity',
    icon: FileText,
    color: '#2563EB',
    bg: '#DBEAFE',
  },
  {
    id: 'cash-flow',
    name: 'Cash Flow Statement',
    description: 'Operating, investing & financing',
    icon: Zap,
    color: '#D97706',
    bg: '#FEF3C7',
  },
  {
    id: 'general-ledger',
    name: 'General Ledger',
    description: 'Full double-entry history',
    icon: BookOpen,
    color: '#DC2626',
    bg: '#FEE2E2',
  },
  {
    id: 'trial-balance',
    name: 'Trial Balance',
    description: 'Ledger integrity and account totals',
    icon: Scale,
    color: '#7C3AED',
    bg: '#EDE9FE',
  },
  {
    id: 'activity-log',
    name: 'Activity Log',
    description: 'Chronological record of all actions',
    icon: Clock,
    color: '#0891B2',
    bg: '#CFFAFE',
  },
];

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'ytd', label: 'Year to Date' },
  { value: 'this_year', label: 'This Year' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_year', label: 'Last Year' },
  { value: 'all_time', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
];

const CURRENCY_MODES: { value: ReportCurrencyMode; label: string; glOnly: boolean }[] = [
  { value: 'wallet', label: 'Wallet Currency', glOnly: true },
  { value: 'primary', label: 'Primary Currency', glOnly: false },
  { value: 'secondary', label: 'Secondary Currency', glOnly: false },
];

function getDateRange(preset: DatePreset): { from: Date | undefined; to: Date | undefined } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { from: now, to: now };
    case 'this_week':
      return { from: startOfWeek(now), to: now };
    case 'this_month':
      return { from: startOfMonth(now), to: now };
    case 'ytd':
      return { from: startOfYear(now), to: now };
    case 'this_year':
      return { from: startOfYear(now), to: now };
    case 'last_month':
      return { from: startOfMonth(subMonths(now, 1)), to: subMonths(startOfMonth(now), 0) };
    case 'last_year':
      return { from: startOfYear(subYears(now, 1)), to: startOfYear(now) };
    case 'all_time':
      return { from: undefined, to: undefined };
    default:
      return { from: undefined, to: undefined };
  }
}

/* Data-driven report components */

function fmtMoney(amount: number, currency: string = 'USD'): string {
  if (amount === 0) return '—';
  return formatFiat(amount, currency);
}

/** Client-side chart hierarchy + drill-down. */
interface ReportHierarchyBundle {
  viewMode: ReportViewMode;
  closure: Map<string, CoaClosureRow>;
  journalLines: JournalLine[];
  dateRange?: DateRange;
  drillAccountId: string | null;
  onToggleDrill: (accountId: string) => void;
  rollupCurrency: string;
}

function HierarchySectionBlock({
  header,
  section,
  hierarchy,
  currency,
  includeRow,
}: {
  header: string;
  section: LedgerReportSection;
  hierarchy: ReportHierarchyBundle;
  currency: string;
  includeRow: HierarchySectionPredicate;
}): ReactElement {
  const {
    viewMode,
    closure,
    journalLines,
    dateRange,
    drillAccountId,
    onToggleDrill,
    rollupCurrency,
  } = hierarchy;
  const leaves: HierarchyLeafLine[] = section.rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.name,
    accountCode: r.code,
    primaryAmount: r.balance,
    nativeAmount: r.balance,
    nativeCurrency: rollupCurrency,
  }));
  const roots = buildReportHierarchyRoots(leaves, closure, includeRow, rollupCurrency);

  const renderNodes = (nodes: ReportHierarchyNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const display = hierarchyNodeToDisplayLine(node, viewMode, false);
      const isLeaf = node.children.length === 0;
      const expanded = drillAccountId === node.accountId;
      const drillLines =
        expanded && isLeaf
          ? journalLines.filter(
              (l) => l.accountId === node.accountId && journalLineInDateRange(l.date, dateRange),
            )
          : [];
      const labelPrefix = display.code ? `${display.code} — ` : '';
      const childNodes = viewMode === 'details' ? node.children : [];

      return (
        <div key={node.accountId}>
          <div
            className={cn(
              'flex items-center justify-between py-2 px-3 text-sm border-b border-border/60',
              !isLeaf && 'bg-muted/25',
            )}
            style={{ paddingLeft: 12 + depth * 14 }}
          >
            <button
              type="button"
              className={cn(
                'text-left flex-1 min-w-0 truncate',
                isLeaf && 'hover:underline cursor-pointer',
              )}
              onClick={() => {
                if (isLeaf) onToggleDrill(node.accountId);
              }}
              disabled={!isLeaf}
            >
              {labelPrefix}
              {display.label}
            </button>
            <span className="font-mono shrink-0 tabular-nums">
              {fmtMoney(display.amount, currency)}
            </span>
          </div>
          {childNodes.length > 0 && <div>{renderNodes(childNodes, depth + 1)}</div>}
          {isLeaf && expanded && (
            <div className="mx-3 mb-3 ml-8 border rounded-md overflow-x-auto bg-muted/30">
              {drillLines.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">
                  No journal lines in this period.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="p-2 text-left font-medium">Date</th>
                      <th className="p-2 text-left font-medium">Memo</th>
                      <th className="p-2 text-right font-medium">Debit</th>
                      <th className="p-2 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillLines.map((l) => (
                      <tr
                        key={`${l.journalEntryId}-${l.date}-${l.description ?? ''}`}
                        className="border-b border-border/50"
                      >
                        <td className="p-2 font-mono whitespace-nowrap">{l.date}</td>
                        <td className="p-2 text-muted-foreground max-w-[200px] truncate">
                          {l.description ?? l.memo ?? '—'}
                        </td>
                        <td className="p-2 text-right font-mono">
                          {l.debit ? fmtMoney(l.debit, currency) : '—'}
                        </td>
                        <td className="p-2 text-right font-mono">
                          {l.credit ? fmtMoney(l.credit, currency) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="mb-4">
      <div className="font-semibold text-sm py-2 px-3 bg-muted">{header}</div>
      {section.rows.length === 0 ? (
        <ReportRow label={`No ${header.toLowerCase()} accounts`} />
      ) : (
        <div>{renderNodes(roots, 0)}</div>
      )}
      <ReportRow label={`Total ${header}`} amount={fmtMoney(section.total, currency)} bold />
    </div>
  );
}

function PnlReport({
  orgName,
  dateLabel,
  data,
  currency,
  hierarchy,
}: {
  orgName: string;
  dateLabel: string;
  data: PnLData;
  currency: string;
  hierarchy?: ReportHierarchyBundle;
}): ReactElement {
  if (hierarchy) {
    return (
      <ReportShell title="Profit & Loss Statement" orgName={orgName} dateLabel={dateLabel}>
        <HierarchySectionBlock
          header={data.income.header}
          section={data.income}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={plSectionPredicate('revenue')}
        />
        <HierarchySectionBlock
          header={data.expenses.header}
          section={data.expenses}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={plSectionPredicate('expense')}
        />
        <ReportRow label="Net Profit" amount={fmtMoney(data.netProfit, currency)} bold grand />
      </ReportShell>
    );
  }

  return (
    <ReportShell title="Profit & Loss Statement" orgName={orgName} dateLabel={dateLabel}>
      {[data.income, data.expenses].map((section) => (
        <div key={section.header} className="mb-4">
          <div
            className="font-semibold text-sm py-2 px-3"
            style={{ background: 'var(--color-gray-50)' }}
          >
            {section.header}
          </div>
          {section.rows.length === 0 ? (
            <ReportRow label={`No ${section.header.toLowerCase()} accounts`} />
          ) : (
            section.rows.map((r) => (
              <ReportRow
                key={r.accountId}
                label={r.code ? `${r.code} — ${r.name}` : r.name}
                amount={fmtMoney(r.balance, currency)}
              />
            ))
          )}
          <ReportRow
            label={`Total ${section.header}`}
            amount={fmtMoney(section.total, currency)}
            bold
          />
        </div>
      ))}
      <ReportRow label="Net Profit" amount={fmtMoney(data.netProfit, currency)} bold grand />
    </ReportShell>
  );
}

function BalanceSheetReport({
  orgName,
  dateLabel,
  data,
  currency,
  hierarchy,
}: {
  orgName: string;
  dateLabel: string;
  data: BSData;
  currency: string;
  hierarchy?: ReportHierarchyBundle;
}): ReactElement {
  if (hierarchy) {
    return (
      <ReportShell title="Balance Sheet" orgName={orgName} dateLabel={dateLabel}>
        <HierarchySectionBlock
          header={data.assets.header}
          section={data.assets}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={bsSectionPredicate('asset')}
        />
        <HierarchySectionBlock
          header={data.liabilities.header}
          section={data.liabilities}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={bsSectionPredicate('liability')}
        />
        <HierarchySectionBlock
          header={data.equity.header}
          section={data.equity}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={bsSectionPredicate('equity')}
        />
        <ReportRow
          label="Total Liabilities & Equity"
          amount={fmtMoney(data.totalLiabilitiesAndEquity, currency)}
          bold
          grand
        />
      </ReportShell>
    );
  }

  return (
    <ReportShell title="Balance Sheet" orgName={orgName} dateLabel={dateLabel}>
      {[data.assets, data.liabilities, data.equity].map((section) => (
        <div key={section.header} className="mb-4">
          <div
            className="font-semibold text-sm py-2 px-3"
            style={{ background: 'var(--color-gray-50)' }}
          >
            {section.header}
          </div>
          {section.rows.length === 0 ? (
            <ReportRow label={`No ${section.header.toLowerCase()} accounts`} />
          ) : (
            section.rows.map((r) => (
              <ReportRow
                key={r.accountId}
                label={r.code ? `${r.code} — ${r.name}` : r.name}
                amount={fmtMoney(r.balance, currency)}
              />
            ))
          )}
          <ReportRow
            label={`Total ${section.header}`}
            amount={fmtMoney(section.total, currency)}
            bold
          />
        </div>
      ))}
      <ReportRow
        label="Total Liabilities & Equity"
        amount={fmtMoney(data.totalLiabilitiesAndEquity, currency)}
        bold
        grand
      />
    </ReportShell>
  );
}

function CashFlowReport({
  orgName,
  dateLabel,
  data,
  currency,
  hierarchy,
  cfPredicates,
}: {
  orgName: string;
  dateLabel: string;
  data: CFData;
  currency: string;
  hierarchy?: ReportHierarchyBundle;
  cfPredicates?: {
    operating: HierarchySectionPredicate;
    investing: HierarchySectionPredicate;
    financing: HierarchySectionPredicate;
  };
}): ReactElement {
  if (hierarchy && cfPredicates) {
    return (
      <ReportShell title="Cash Flow Statement" orgName={orgName} dateLabel={dateLabel}>
        <HierarchySectionBlock
          header={data.operating.header}
          section={data.operating}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={cfPredicates.operating}
        />
        <HierarchySectionBlock
          header={data.investing.header}
          section={data.investing}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={cfPredicates.investing}
        />
        <HierarchySectionBlock
          header={data.financing.header}
          section={data.financing}
          hierarchy={hierarchy}
          currency={currency}
          includeRow={cfPredicates.financing}
        />
        <ReportRow
          label="Net Change in Cash"
          amount={fmtMoney(data.netChange, currency)}
          bold
          grand
        />
      </ReportShell>
    );
  }

  return (
    <ReportShell title="Cash Flow Statement" orgName={orgName} dateLabel={dateLabel}>
      {[data.operating, data.investing, data.financing].map((section) => (
        <div key={section.header} className="mb-4">
          <div
            className="font-semibold text-sm py-2 px-3"
            style={{ background: 'var(--color-gray-50)' }}
          >
            {section.header}
          </div>
          {section.rows.length === 0 ? (
            <ReportRow label="No activity" />
          ) : (
            section.rows.map((r) => (
              <ReportRow
                key={r.accountId}
                label={r.code ? `${r.code} — ${r.name}` : r.name}
                amount={fmtMoney(r.balance, currency)}
              />
            ))
          )}
          <ReportRow
            label={`Net Cash from ${section.header.replace(' Activities', '')}`}
            amount={fmtMoney(section.total, currency)}
            bold
          />
        </div>
      ))}
      <ReportRow
        label="Net Change in Cash"
        amount={fmtMoney(data.netChange, currency)}
        bold
        grand
      />
    </ReportShell>
  );
}

function GeneralLedgerReport({
  orgName,
  dateLabel,
  entries,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  entries: GLEntry[];
  currency: string;
}) {
  return (
    <ReportShell title="General Ledger" orgName={orgName} dateLabel={dateLabel}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-8 text-sm text-muted-foreground">
                No ledger entries yet.
              </TableCell>
            </TableRow>
          ) : (
            entries.map((e, i) => (
              <TableRow key={`${e.journalEntryId}-${i}`} className="hover:bg-[#fafafa]">
                <TableCell className="font-mono text-xs">{e.date}</TableCell>
                <TableCell className="text-xs">
                  {e.accountCode ? `${e.accountCode} — ` : ''}
                  {e.accountName}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                  {e.description || '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {e.debit ? fmtMoney(e.debit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {e.credit ? fmtMoney(e.credit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold">
                  {fmtMoney(e.runningBalance, currency)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </ReportShell>
  );
}

function TrialBalanceReport({
  orgName,
  dateLabel,
  data,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  data: TBData;
  currency: string;
}) {
  return (
    <ReportShell title="Trial Balance" orgName={orgName} dateLabel={dateLabel}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-center py-8 text-sm text-muted-foreground">
                No accounts with balances.
              </TableCell>
            </TableRow>
          ) : (
            data.rows.map((r) => (
              <TableRow key={r.accountName} className="hover:bg-[#fafafa]">
                <TableCell className="text-sm">
                  {r.accountCode ? `${r.accountCode} — ` : ''}
                  {r.accountName}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {r.debit ? fmtMoney(r.debit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {r.credit ? fmtMoney(r.credit, currency) : ''}
                </TableCell>
              </TableRow>
            ))
          )}
          <TableRow className="font-bold" style={{ background: 'var(--color-gray-50)' }}>
            <TableCell className="text-sm">
              Totals{' '}
              {!data.isBalanced && <span className="text-red-500 text-xs ml-2">(Unbalanced!)</span>}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(data.totalDebits, currency)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(data.totalCredits, currency)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ReportShell>
  );
}

/* Activity Log types & component */

interface ActivityEntry {
  id: string;
  date: string;
  action: string;
  description: string;
  amount: number;
  journalEntryId: string;
}

function buildActivityLog(journalLines: JournalLine[], dateRange?: DateRange): ActivityEntry[] {
  // Group lines by journal entry to build activity entries
  const entryMap = new Map<
    string,
    { date: string; descriptions: string[]; totalDebit: number; totalCredit: number }
  >();

  for (const line of journalLines) {
    if (dateRange) {
      const d = new Date(line.date);
      if (dateRange.from && d < dateRange.from) continue;
      if (dateRange.to) {
        const to = new Date(dateRange.to);
        to.setHours(23, 59, 59, 999);
        if (d > to) continue;
      }
    }

    const existing = entryMap.get(line.journalEntryId);
    if (existing) {
      existing.totalDebit += line.debit;
      existing.totalCredit += line.credit;
      if (line.description && !existing.descriptions.includes(line.description)) {
        existing.descriptions.push(line.description);
      }
    } else {
      entryMap.set(line.journalEntryId, {
        date: line.date,
        descriptions: line.description ? [line.description] : [],
        totalDebit: line.debit,
        totalCredit: line.credit,
      });
    }
  }

  const entries: ActivityEntry[] = [];
  for (const [jeId, data] of entryMap) {
    entries.push({
      id: jeId,
      date: data.date,
      action: 'Journal Entry Posted',
      description: data.descriptions.join('; ') | 'No description',
      amount: Math.max(data.totalDebit, data.totalCredit),
      journalEntryId: jeId,
    });
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

function ActivityLogReport({
  orgName,
  dateLabel,
  entries,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  entries: ActivityEntry[];
  currency: string;
}) {
  return (
    <ReportShell title="Activity Log" orgName={orgName} dateLabel={dateLabel}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center py-8 text-sm text-muted-foreground">
                No activity in this period.
              </TableCell>
            </TableRow>
          ) : (
            entries.map((e) => (
              <TableRow key={e.id} className="hover:bg-[#fafafa]">
                <TableCell className="font-mono text-xs">{e.date}</TableCell>
                <TableCell className="text-xs">
                  <Badge variant="outline" className="text-xs font-normal">
                    {e.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                  {e.description}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmtMoney(e.amount, currency)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </ReportShell>
  );
}

/* CSV Export — client-side only (ZKA): decrypted journal lines feed the engine; CSV is a local Blob download, never sent to the server. */

function exportReportCsv(
  reportType: ReportType,
  reportTitle: string,
  pnlData: PnLData,
  bsData: BSData,
  tbData: TBData,
  glEntries: GLEntry[],
  cfData: CFData,
  activityEntries: ActivityEntry[],
  reportCurrency: string,
  btcDisplay: BitcoinDisplay,
  currencyMode: ReportCurrencyMode,
  auditParams?: {
    dateLabel: string;
    primaryCurrency: string;
    secondaryCurrency: string | null;
    framework: AuditFramework;
    fxTranslationMethod: FxTranslationMethod;
    hasBoundary: boolean;
    primaryCurrencyHistory?: Array<{
      primary_currency: string;
      effective_from: string | null;
      effective_to: string | null;
    }>;
  },
): void {
  let headers: string[] = [];
  const rows: (string | number)[][] = [];

  /** Same ledger units as transactions/payments CSV (sats for Bitcoins/Satoshis, else raw). */
  const csvAmt = (n: number) => transactionAmountNumericForCsv(n, reportCurrency, btcDisplay);

  switch (reportType) {
    case 'pnl':
      headers = ['Account', 'Type', 'Balance'];
      for (const section of [pnlData.income, pnlData.expenses]) {
        for (const r of section.rows) {
          rows.push([r.name, section.header, csvAmt(r.balance)]);
        }
        rows.push([`Total ${section.header}`, '', csvAmt(section.total)]);
      }
      rows.push(['Net Profit', '', csvAmt(pnlData.netProfit)]);
      break;
    case 'balance-sheet':
      headers = ['Account', 'Type', 'Balance'];
      for (const section of [bsData.assets, bsData.liabilities, bsData.equity]) {
        for (const r of section.rows) {
          rows.push([r.name, section.header, csvAmt(r.balance)]);
        }
        rows.push([`Total ${section.header}`, '', csvAmt(section.total)]);
      }
      rows.push(['Total Liabilities & Equity', '', csvAmt(bsData.totalLiabilitiesAndEquity)]);
      break;
    case 'trial-balance':
      headers = ['Account', 'Debits', 'Credits'];
      for (const r of tbData.rows) {
        rows.push([
          r.accountCode ? `${r.accountCode} — ${r.accountName}` : r.accountName,
          csvAmt(r.debit),
          csvAmt(r.credit),
        ]);
      }
      rows.push(['Totals', csvAmt(tbData.totalDebits), csvAmt(tbData.totalCredits)]);
      break;
    case 'general-ledger':
      headers = ['Date', 'Account', 'Description', 'Debit', 'Credit', 'Balance'];
      for (const e of glEntries) {
        rows.push([
          e.date,
          e.accountCode ? `${e.accountCode} — ${e.accountName}` : e.accountName,
          e.description | '',
          csvAmt(e.debit),
          csvAmt(e.credit),
          csvAmt(e.runningBalance),
        ]);
      }
      break;
    case 'cash-flow':
      headers = ['Category', 'Amount'];
      for (const section of [cfData.operating, cfData.investing, cfData.financing]) {
        for (const r of section.rows) {
          rows.push([r.name, csvAmt(r.balance)]);
        }
        rows.push([
          `Net Cash from ${section.header.replace(' Activities', '')}`,
          csvAmt(section.total),
        ]);
      }
      rows.push(['Net Change in Cash', csvAmt(cfData.netChange)]);
      break;
    case 'activity-log':
      headers = ['Date', 'Action', 'Description', 'Amount'];
      for (const e of activityEntries) {
        rows.push([e.date, e.action, e.description, csvAmt(e.amount)]);
      }
      break;
  }

  const currencyCellLabel = csvExportCurrencyLabel(reportCurrency, btcDisplay);
  headers.push(reportCsvCurrencyExportColumnHeader(currencyMode));
  for (const row of rows) {
    row.push(currencyCellLabel);
  }

  // Build CSV string (numbers rounded to reduce float noise so Excel keeps amounts as numbers)
  const escape = (val: string | number | null | undefined): string => {
    if (val == null) {
      return '';
    }
    const str = typeof val === 'number' ? formatNumericForCsvCell(val) : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  let csvContent = [
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');

  if (auditParams) {
    csvContent +=
      '\n' +
      auditFooterCsv({
        reportType,
        reportTitle,
        dateLabel: auditParams.dateLabel,
        primaryCurrency: auditParams.primaryCurrency,
        secondaryCurrency: auditParams.secondaryCurrency,
        currencyMode,
        framework: auditParams.framework,
        fxTranslationMethod: auditParams.fxTranslationMethod,
        hasBoundary: auditParams.hasBoundary,
        primaryCurrencyHistory: auditParams.primaryCurrencyHistory,
      });
  }

  // Prefix UTF-8 BOM so Excel on Windows preserves symbols like ₿ and ⚡.
  const blob = new Blob(['\uFEFF', csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${reportTitle.replace(/\s+/g, '_').toLowerCase()}.csv`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* Print Export */

async function printReport(
  reportType: ReportType,
  reportTitle: string,
  orgName: string,
  dateLabel: string,
  pnlData: PnLData,
  bsData: BSData,
  tbData: TBData,
  glEntries: GLEntry[],
  cfData: CFData,
  activityEntries: ActivityEntry[],
  reportingNote?: string,
): Promise<void> {
  let headers: string[] = [];
  const rows: (string | number)[][] = [];

  switch (reportType) {
    case 'pnl':
      headers = ['Account', 'Type', 'Balance'];
      for (const section of [pnlData.income, pnlData.expenses]) {
        for (const r of section.rows) rows.push([r.name, section.header, r.balance]);
        rows.push([`Total ${section.header}`, '', section.total]);
      }
      rows.push(['Net Profit', '', pnlData.netProfit]);
      break;
    case 'balance-sheet':
      headers = ['Account', 'Type', 'Balance'];
      for (const section of [bsData.assets, bsData.liabilities, bsData.equity]) {
        for (const r of section.rows) rows.push([r.name, section.header, r.balance]);
        rows.push([`Total ${section.header}`, '', section.total]);
      }
      rows.push(['Total Liabilities & Equity', '', bsData.totalLiabilitiesAndEquity]);
      break;
    case 'trial-balance':
      headers = ['Account', 'Debits', 'Credits'];
      for (const r of tbData.rows)
        rows.push([
          r.accountCode ? `${r.accountCode} — ${r.accountName}` : r.accountName,
          r.debit,
          r.credit,
        ]);
      rows.push(['Totals', tbData.totalDebits, tbData.totalCredits]);
      break;
    case 'general-ledger':
      headers = ['Date', 'Account', 'Description', 'Debit', 'Credit', 'Balance'];
      for (const e of glEntries)
        rows.push([
          e.date,
          e.accountCode ? `${e.accountCode} — ${e.accountName}` : e.accountName,
          e.description | '',
          e.debit,
          e.credit,
          e.runningBalance,
        ]);
      break;
    case 'cash-flow':
      headers = ['Category', 'Amount'];
      for (const section of [cfData.operating, cfData.investing, cfData.financing]) {
        for (const r of section.rows) rows.push([r.name, r.balance]);
        rows.push([`Net Cash from ${section.header.replace(' Activities', '')}`, section.total]);
      }
      rows.push(['Net Change in Cash', cfData.netChange]);
      break;
    case 'activity-log':
      headers = ['Date', 'Action', 'Description', 'Amount'];
      for (const e of activityEntries) rows.push([e.date, e.action, e.description, e.amount]);
      break;
  }

  const escapeHtml = (str: string): string =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  const isNumericHeader = (header: string): boolean =>
    /amount|debit|credit|balance|period/i.test(header);
  const isTotalLabel = (label: string): boolean => /^(total|totals|net )/i.test(label.trim());

  const logoDataUri = await fetchBrandLogoDataUri();
  const logoBlock = `<img class="logo" src="${logoDataUri}" alt="Orange Way Books" />`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to print the report.');
    return;
  }

  const docTitle = `${orgName} — ${reportTitle} — ${dateLabel}`;
  const headerHtml = headers
    .map(
      (h, index) =>
        `<th class="${isNumericHeader(h) ? 'th-num' : index === 0 ? 'th-first' : ''}">${escapeHtml(h)}</th>`,
    )
    .join('');
  const bodyHtml = rows
    .map((row) => {
      const leadText = String(row[1] ?? row[0] ?? '').trim();
      const rowClass = isTotalLabel(leadText) ? 'row-total' : '';
      const cells = row
        .map((cell, index) => {
          const header = headers[index] ?? '';
          return `<td class="${isNumericHeader(header) ? 'td-num' : index === 0 ? 'td-first' : ''}">${escapeHtml(String(cell ?? ''))}</td>`;
        })
        .join('');
      return `<tr class="${rowClass}">${cells}</tr>`;
    })
    .join('');

  const generatedAt = escapeHtml(new Date().toLocaleString());
  const reportingNoteHtml = reportingNote
    ? `<p class="reporting-note">${escapeHtml(reportingNote)}</p>`
    : '';

  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(docTitle)}</title>
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
    .page { max-width: 1100px; margin: 0 auto; }
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
      font-size: 20px;
      line-height: 1.25;
      margin: 0 0 6px;
      font-weight: 600;
      color: var(--ink);
    }
    .period { color: var(--muted); font-size: 13px; margin: 0; }
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
    .td-first { width: 18%; }
    tbody tr:nth-child(even):not(.row-total) td { background: #fcfcfd; }
    .row-total td {
      font-weight: 700;
      border-top: 2px solid #d1d5db;
      background: #fff;
    }
    tbody tr:last-child td { border-bottom: none; }
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
      .hero-main h1 { font-size: 19px; }
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
      <div class="hero-main has-org">
        <div class="org-name">${escapeHtml(orgName)}</div>
        <h1>${escapeHtml(reportTitle)}</h1>
        <p class="period">${escapeHtml(dateLabel)}</p>
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
  printWindow.focus();
  printWindow.print();
}

function ReportShell({
  title,
  orgName,
  dateLabel,
  children,
}: {
  title: string;
  orgName: string;
  dateLabel: string;
  children: ReactNode;
}) {
  return (
    <div
      className="bg-white border rounded-lg p-4 md:p-6"
      style={{ borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }}
    >
      <p className="text-lg md:text-xl font-bold text-foreground tracking-tight mb-1">{orgName}</p>
      <h2 className="text-base md:text-lg font-semibold text-foreground mb-1">{title}</h2>
      <p className="text-xs mb-4" style={{ color: 'var(--color-gray-400)' }}>
        {dateLabel}
      </p>
      {/* Mobile: enable horizontal scroll for the report body so wide
          ledger / trial-balance / P&L tables stay legible. Desktop is
          unchanged — overflow-x-auto on a fitting container is a no-op. */}
      <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">{children}</div>
    </div>
  );
}

function ReportRow({
  label,
  amount,
  bold,
  grand,
}: {
  label: string;
  amount?: string;
  bold?: boolean;
  grand?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between py-2 px-3 text-sm',
        grand && 'border-t-2',
        bold && 'font-semibold',
      )}
      style={
        grand
          ? { borderColor: 'var(--color-gray-300)', background: 'var(--color-gray-50)' }
          : undefined
      }
    >
      <span>{label}</span>
      <span className="font-mono">{amount ?? '—'}</span>
    </div>
  );
}

/* ── Comparison Report Components ── */

function ComparisonPnl({
  orgName,
  dateLabel,
  priorDateLabel,
  data,
  priorData,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  priorDateLabel: string;
  data: PnLData;
  priorData: PnLData;
  currency: string;
}) {
  const renderSection = (current: PnLData['income'], prior: PnLData['income']) => {
    const allNames = new Set([
      ...current.rows.map((r) => r.name),
      ...prior.rows.map((r) => r.name),
    ]);
    return Array.from(allNames).map((name) => {
      const cur = current.rows.find((r) => r.name === name)?.balance ?? 0;
      const pri = prior.rows.find((r) => r.name === name)?.balance ?? 0;
      const variance = cur - pri;
      const pct = pri !== 0 ? ((variance / Math.abs(pri)) * 100).toFixed(1) : '—';
      return { name, cur, pri, variance, pct };
    });
  };

  return (
    <ReportShell
      title="Profit & Loss — Period Comparison"
      orgName={orgName}
      dateLabel={`${dateLabel} vs. ${priorDateLabel}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Current Period</TableHead>
            <TableHead className="text-right">Prior Period</TableHead>
            <TableHead className="text-right">Variance</TableHead>
            <TableHead className="text-right">%</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            { cur: data.income, pri: priorData.income },
            { cur: data.expenses, pri: priorData.expenses },
          ].map(({ cur, pri }) => (
            <>
              <TableRow key={cur.header} style={{ background: 'var(--color-gray-50)' }}>
                <TableCell colSpan={5} className="font-semibold text-sm">
                  {cur.header}
                </TableCell>
              </TableRow>
              {renderSection(cur, pri).map((r) => {
                const vColor =
                  r.variance > 0 ? 'text-green-600' : r.variance < 0 ? 'text-red-600' : '';
                return (
                  <TableRow key={`${cur.header}-${r.name}`} className="hover:bg-[#fafafa]">
                    <TableCell className="text-sm pl-6">{r.name}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtMoney(r.cur, currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtMoney(r.pri, currency)}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-sm', vColor)}>
                      {fmtMoney(r.variance, currency)}
                    </TableCell>
                    <TableCell className={cn('text-right text-xs', vColor)}>
                      {r.pct === '—' ? '—' : `${r.pct}%`}
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="font-semibold" style={{ background: 'var(--color-gray-50)' }}>
                <TableCell className="text-sm">Total {cur.header}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmtMoney(cur.total, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmtMoney(pri.total, currency)}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right font-mono text-sm',
                    cur.total - pri.total > 0
                      ? 'text-green-600'
                      : cur.total - pri.total < 0
                        ? 'text-red-600'
                        : '',
                  )}
                >
                  {fmtMoney(cur.total - pri.total, currency)}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {pri.total !== 0
                    ? `${(((cur.total - pri.total) / Math.abs(pri.total)) * 100).toFixed(1)}%`
                    : '—'}
                </TableCell>
              </TableRow>
            </>
          ))}
          <TableRow className="font-bold border-t-2">
            <TableCell>Net Profit</TableCell>
            <TableCell className="text-right font-mono">
              {fmtMoney(data.netProfit, currency)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {fmtMoney(priorData.netProfit, currency)}
            </TableCell>
            <TableCell
              className={cn(
                'text-right font-mono',
                data.netProfit - priorData.netProfit > 0 ? 'text-green-600' : 'text-red-600',
              )}
            >
              {fmtMoney(data.netProfit - priorData.netProfit, currency)}
            </TableCell>
            <TableCell className="text-right text-xs">
              {priorData.netProfit !== 0
                ? `${(((data.netProfit - priorData.netProfit) / Math.abs(priorData.netProfit)) * 100).toFixed(1)}%`
                : '—'}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ReportShell>
  );
}

function ComparisonBalanceSheet({
  orgName,
  dateLabel,
  priorDateLabel,
  data,
  priorData,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  priorDateLabel: string;
  data: BSData;
  priorData: BSData;
  currency: string;
}) {
  const renderSection = (curSection: BSData['assets'], priSection: BSData['assets']) => {
    const allNames = new Set([
      ...curSection.rows.map((r) => r.name),
      ...priSection.rows.map((r) => r.name),
    ]);
    return Array.from(allNames).map((name) => {
      const cur = curSection.rows.find((r) => r.name === name)?.balance ?? 0;
      const pri = priSection.rows.find((r) => r.name === name)?.balance ?? 0;
      return { name, cur, pri, variance: cur - pri };
    });
  };

  const sections = [
    { cur: data.assets, pri: priorData.assets },
    { cur: data.liabilities, pri: priorData.liabilities },
    { cur: data.equity, pri: priorData.equity },
  ];

  return (
    <ReportShell
      title="Balance Sheet — Period Comparison"
      orgName={orgName}
      dateLabel={`${dateLabel} vs. ${priorDateLabel}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Current Period</TableHead>
            <TableHead className="text-right">Prior Period</TableHead>
            <TableHead className="text-right">Variance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map(({ cur, pri }) => (
            <>
              <TableRow key={cur.header} style={{ background: 'var(--color-gray-50)' }}>
                <TableCell colSpan={4} className="font-semibold text-sm">
                  {cur.header}
                </TableCell>
              </TableRow>
              {renderSection(cur, pri).map((r) => (
                <TableRow key={`${cur.header}-${r.name}`} className="hover:bg-[#fafafa]">
                  <TableCell className="text-sm pl-6">{r.name}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtMoney(r.cur, currency)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtMoney(r.pri, currency)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono text-sm',
                      r.variance > 0 ? 'text-green-600' : r.variance < 0 ? 'text-red-600' : '',
                    )}
                  >
                    {fmtMoney(r.variance, currency)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold" style={{ background: 'var(--color-gray-50)' }}>
                <TableCell className="text-sm">Total {cur.header}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmtMoney(cur.total, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmtMoney(pri.total, currency)}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right font-mono text-sm',
                    cur.total - pri.total > 0
                      ? 'text-green-600'
                      : cur.total - pri.total < 0
                        ? 'text-red-600'
                        : '',
                  )}
                >
                  {fmtMoney(cur.total - pri.total, currency)}
                </TableCell>
              </TableRow>
            </>
          ))}
        </TableBody>
      </Table>
    </ReportShell>
  );
}

function ComparisonTrialBalance({
  orgName,
  dateLabel,
  priorDateLabel,
  data,
  priorData,
  currency,
}: {
  orgName: string;
  dateLabel: string;
  priorDateLabel: string;
  data: TBData;
  priorData: TBData;
  currency: string;
}) {
  const allAccounts = new Set([
    ...data.rows.map((r) => r.accountName),
    ...priorData.rows.map((r) => r.accountName),
  ]);
  return (
    <ReportShell
      title="Trial Balance — Period Comparison"
      orgName={orgName}
      dateLabel={`${dateLabel} vs. ${priorDateLabel}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Current Debit</TableHead>
            <TableHead className="text-right">Current Credit</TableHead>
            <TableHead className="text-right">Prior Debit</TableHead>
            <TableHead className="text-right">Prior Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from(allAccounts).map((name) => {
            const cur = data.rows.find((r) => r.accountName === name);
            const pri = priorData.rows.find((r) => r.accountName === name);
            return (
              <TableRow key={name} className="hover:bg-[#fafafa]">
                <TableCell className="text-sm">
                  {cur?.accountCode ? `${cur.accountCode} — ` : ''}
                  {name}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {cur?.debit ? fmtMoney(cur.debit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {cur?.credit ? fmtMoney(cur.credit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {pri?.debit ? fmtMoney(pri.debit, currency) : ''}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {pri?.credit ? fmtMoney(pri.credit, currency) : ''}
                </TableCell>
              </TableRow>
            );
          })}
          <TableRow className="font-bold" style={{ background: 'var(--color-gray-50)' }}>
            <TableCell>Totals</TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(data.totalDebits, currency)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(data.totalCredits, currency)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(priorData.totalDebits, currency)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {fmtMoney(priorData.totalCredits, currency)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ReportShell>
  );
}

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeReport = searchParams.get('report') as ReportType | null;
  const { orgId } = useUserOrg();
  const { decryptText } = useVault();
  const [orgName, setOrgName] = useState('');
  const [primaryCurrency, setPrimaryCurrency] = useState('USD');
  const [secondaryCurrency, setSecondaryCurrency] = useState<string | null>(null);
  const [btcDisplay, setBtcDisplay] = useState<BitcoinDisplay>('sats');
  const [journalLines, setJournalLines] = useState<JournalLine[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [revalJeIds, setRevalJeIds] = useState<Set<string>>(new Set());
  const [framework, setFramework] = useState<AuditFramework>('IFRS');
  const [fxTranslationMethod, setFxTranslationMethod] = useState<FxTranslationMethod>(
    'historical-per-transaction',
  );
  const [dataLoading, setDataLoading] = useState(true);

  const [datePreset, setDatePreset] = useState<DatePreset>('ytd');
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();
  const [showPriorPeriod, setShowPriorPeriod] = useState(false);
  const [priorPreset, setPriorPreset] = useState<DatePreset>('last_year');
  const [priorFrom, setPriorFrom] = useState<Date | undefined>();
  const [priorTo, setPriorTo] = useState<Date | undefined>();
  const [currencyMode, setCurrencyMode] = useState<ReportCurrencyMode>('primary');
  const [reportViewMode, setReportViewMode] = useState<ReportViewMode>('summary');
  const [showFxReval, setShowFxReval] = useState(true);
  const [drillAccountId, setDrillAccountId] = useState<string | null>(null);
  // Primary currency history for boundary detection (fetched alongside org settings)
  const [primaryCurrencyHistory, setPrimaryCurrencyHistory] = useState<
    Array<{ primary_currency: string; effective_from: string | null; effective_to: string | null }>
  >([]);

  useEffect(() => {
    setDrillAccountId(null);
  }, [activeReport, reportViewMode, showPriorPeriod]);

  useEffect(() => {
    if (!orgId) return;
    const fetchAll = async () => {
      setDataLoading(true);
      const [orgRes, sRes, jeRes, acctRes, histRes, revalRes] = await Promise.all([
        supabase.from('organizations').select('name, key_version').eq('id', orgId).single(),
        supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
        supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(date, memo, org_id)')
          .eq('journal_entries.org_id', orgId),
        supabase
          .from('chart_of_accounts' as any)
          .select('*')
          .eq('org_id', orgId),
        supabase
          .from('org_primary_currency_history' as any)
          .select('primary_currency, effective_from, effective_to')
          .eq('org_id', orgId)
          .order('effective_from', { ascending: true }),
        supabase
          .from('fx_revaluation_runs' as any)
          .select('je_id, reverse_je_id')
          .eq('org_id', orgId),
      ]);
      if (histRes.data) {
        setPrimaryCurrencyHistory((histRes.data as any[]) ?? []);
      }
      if (revalRes.data) {
        const ids = new Set<string>();
        for (const r of revalRes.data as any[]) {
          if (r.je_id) ids.add(r.je_id);
          if (r.reverse_je_id) ids.add(r.reverse_je_id);
        }
        setRevalJeIds(ids);
      }
      if (orgRes.data) {
        const decrypted = await decryptOrganization(orgRes.data, decryptText);
        setOrgName(decrypted.name);
      }
      if (sRes.data) {
        const dec = await decryptOrgSettings(sRes.data, decryptText);
        setPrimaryCurrency(dec.primary_currency || 'USD');
        setSecondaryCurrency(dec.secondary_currency || null);
        setBtcDisplay((dec.bitcoin_display as BitcoinDisplay) || 'sats');
        setFramework(((sRes.data as any).accounting_framework as AuditFramework) | 'IFRS');
        setFxTranslationMethod(
          ((sRes.data as any).fx_translation_method as FxTranslationMethod) |
            'historical-per-transaction',
        );
      }

      const rawLines = (jeRes.data as any[]) ?? [];
      const decryptedLines = await Promise.all(
        rawLines.map(async (l: any) => {
          const fields = await decryptJournalEntryLine(l, decryptText);
          return {
            date: l.journal_entries?.date ?? '',
            accountId: l.account_id,
            accountName: fields.account_name,
            accountCode: fields.account_code,
            debit: fields.debit,
            credit: fields.credit,
            description: fields.description,
            journalEntryId: l.journal_entry_id,
            // Dual-currency fields (null for pre-dual rows)
            amountNative: fields.amount_native ?? null,
            amountPrimary: fields.amount_primary ?? null,
            walletCurrency: fields.wallet_currency ?? null,
            primaryCurrencyAtPosting: l.primary_currency_at_posting ?? null,
            ratePending: l.rate_pending ?? false,
          };
        }),
      );
      setJournalLines(decryptedLines);

      const rawAccounts = (acctRes.data as any[]) ?? [];
      const decryptedAccts = await Promise.all(
        rawAccounts.map(async (a: any) => {
          const fields = await decryptChartOfAccount(a, decryptText);
          return {
            id: a.id,
            name: fields.account_name,
            code: fields.account_code,
            accountType: fields.account_type,
            accountGroup: fields.account_group || '',
            accountCategory: fields.account_category || null,
            parentAccountId: fields.parent_id ?? a.parent_id ?? null,
          };
        }),
      );
      setAccounts(decryptedAccts);

      setDataLoading(false);
    };
    fetchAll();
  }, [orgId]);

  const dateRange = useMemo(() => {
    if (datePreset === 'custom') return { from: customFrom, to: customTo };
    return getDateRange(datePreset);
  }, [datePreset, customFrom, customTo]);

  const engineDateRange: DateRange | undefined = useMemo(() => {
    if (!dateRange.from && !dateRange.to) return undefined;
    return dateRange as DateRange;
  }, [dateRange]);

  const dateLabel = useMemo(() => {
    if (dateRange.from && dateRange.to)
      return `${format(dateRange.from, 'MMM d, yyyy')} — ${format(dateRange.to, 'MMM d, yyyy')}`;
    if (dateRange.from) return `From ${format(dateRange.from, 'MMM d, yyyy')}`;
    return 'All Time';
  }, [dateRange]);

  // T-P1: closed-period banner. If the report's `to` date falls inside an
  // org_period_closes window, surface the close info + Owner-only reopen
  // affordance. Cheap query — closes table is small (one row per close
  // event, typically <50 per org per year).
  const [closedPeriodInfo, setClosedPeriodInfo] = useState<{
    locked_through_date: string;
    closed_at: string;
    note: string | null;
  } | null>(null);
  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const refDate = dateRange.to ?? new Date();
      const refIso = format(refDate, 'yyyy-MM-dd');
      const { data } = await supabase
        .from('org_period_closes')
        .select('locked_through_date, closed_at, encrypted_note, key_version')
        .eq('org_id', orgId)
        .order('closed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) {
        setClosedPeriodInfo(null);
        return;
      }
      if (refIso > (data as any).locked_through_date) {
        setClosedPeriodInfo(null);
        return;
      }
      let note: string | null = null;
      try {
        if ((data as any).encrypted_note && (data as any).key_version) {
          note = await decryptText((data as any).encrypted_note);
        }
      } catch {
        /* ignore */
      }
      setClosedPeriodInfo({
        locked_through_date: (data as any).locked_through_date,
        closed_at: (data as any).closed_at,
        note,
      });
    })();
  }, [orgId, dateRange.to, decryptText]);

  // Closing-rate secondary display (primary → secondary conversion factor)
  const { rate: secondaryDisplayRate } = useSecondaryDisplayRate(
    currencyMode === 'secondary' ? primaryCurrency : null,
    currencyMode === 'secondary' ? secondaryCurrency : null,
  );

  // Scale journal lines by closing rate when in secondary mode.
  // This is the "closing-rate" translation method. Historical-per-transaction is Part 10.
  const reportLines = useMemo<JournalLine[]>(() => {
    let lines = journalLines;
    if (!showFxReval && revalJeIds.size > 0) {
      lines = lines.filter((l) => !revalJeIds.has(l.journalEntryId));
    }
    if ((currencyMode !== 'secondary') | (secondaryDisplayRate == null)) return lines;
    return lines.map((l) => ({
      ...l,
      debit: l.debit * secondaryDisplayRate,
      credit: l.credit * secondaryDisplayRate,
    }));
  }, [journalLines, currencyMode, secondaryDisplayRate, showFxReval, revalJeIds]);

  // Compute report data via ledger engine
  const balances = useMemo(
    () => computeAccountBalances(reportLines, accounts, engineDateRange),
    [reportLines, accounts, engineDateRange],
  );

  const balanceById = useMemo(
    () => new Map<string, AccountBalance>(balances.map((b) => [b.accountId, b])),
    [balances],
  );

  const accountClosure = useMemo(() => buildAccountClosureFromList(accounts), [accounts]);

  const cfHierarchyPredicates = useMemo(() => {
    const mk =
      (bucket: 'operating' | 'investing' | 'financing'): HierarchySectionPredicate =>
      (row) => {
        const b = balanceById.get(row.id);
        if (!b) return false;
        return classifyAccountForCashFlow(b) === bucket;
      };
    return { operating: mk('operating'), investing: mk('investing'), financing: mk('financing') };
  }, [balanceById]);

  const hierarchyBundle: ReportHierarchyBundle | undefined = useMemo(() => {
    if (showPriorPeriod) return undefined;
    return {
      viewMode: reportViewMode,
      closure: accountClosure,
      journalLines,
      dateRange: engineDateRange,
      drillAccountId,
      onToggleDrill: (id) => setDrillAccountId((prev) => (prev === id ? null : id)),
      rollupCurrency: primaryCurrency,
    };
  }, [
    showPriorPeriod,
    reportViewMode,
    accountClosure,
    journalLines,
    engineDateRange,
    drillAccountId,
    primaryCurrency,
  ]);

  const pnlData = useMemo(() => computePnL(balances), [balances]);
  const bsData = useMemo(() => computeBalanceSheet(balances), [balances]);
  const tbData = useMemo(() => computeTrialBalance(balances), [balances]);
  const cfData = useMemo(() => computeCashFlow(balances), [balances]);
  const glEntries = useMemo(
    () => computeGeneralLedger(reportLines, accounts, engineDateRange),
    [reportLines, accounts, engineDateRange],
  );
  const activityEntries = useMemo(
    () => buildActivityLog(journalLines, engineDateRange),
    [journalLines, engineDateRange],
  );

  // Prior period comparison data
  const priorDateRange = useMemo(() => {
    if (!showPriorPeriod) return undefined;
    if (priorPreset === 'custom') return { from: priorFrom, to: priorTo };
    return getDateRange(priorPreset);
  }, [showPriorPeriod, priorPreset, priorFrom, priorTo]);

  const priorEngineDateRange: DateRange | undefined = useMemo(() => {
    if (!priorDateRange || (!priorDateRange.from && !priorDateRange.to)) return undefined;
    return priorDateRange as DateRange;
  }, [priorDateRange]);

  const priorBalances = useMemo(
    () =>
      showPriorPeriod ? computeAccountBalances(reportLines, accounts, priorEngineDateRange) : [],
    [reportLines, accounts, priorEngineDateRange, showPriorPeriod],
  );

  const priorPnlData = useMemo(
    () => (showPriorPeriod ? computePnL(priorBalances) : null),
    [priorBalances, showPriorPeriod],
  );
  const priorBsData = useMemo(
    () => (showPriorPeriod ? computeBalanceSheet(priorBalances) : null),
    [priorBalances, showPriorPeriod],
  );
  const priorTbData = useMemo(
    () => (showPriorPeriod ? computeTrialBalance(priorBalances) : null),
    [priorBalances, showPriorPeriod],
  );

  const priorDateLabel = useMemo(() => {
    if (!priorDateRange) return '';
    if (priorDateRange.from && priorDateRange.to)
      return `${format(priorDateRange.from, 'MMM d, yyyy')} — ${format(priorDateRange.to, 'MMM d, yyyy')}`;
    if (priorDateRange.from) return `From ${format(priorDateRange.from, 'MMM d, yyyy')}`;
    return 'All Time';
  }, [priorDateRange]);

  // Determine display currency based on currency mode toggle
  const displayCurrency = useMemo(() => {
    if (currencyMode === 'secondary' && secondaryCurrency) return secondaryCurrency;
    return primaryCurrency;
  }, [currencyMode, primaryCurrency, secondaryCurrency]);

  // Boundary detection — does the active date range cross a primary-currency change?
  const boundaryResult = useMemo(() => {
    if (!engineDateRange?.from || !engineDateRange?.to || primaryCurrencyHistory.length <= 1) {
      return null;
    }
    const rangeStart = format(engineDateRange.from, 'yyyy-MM-dd');
    const rangeEnd = format(engineDateRange.to, 'yyyy-MM-dd');
    const result = computePrimaryCurrencyBoundaries(primaryCurrencyHistory, rangeStart, rangeEnd);
    return result.hasBoundary ? result : null;
  }, [primaryCurrencyHistory, engineDateRange]);

  const navigateReport = (id: ReportType) => setSearchParams({ report: id });

  // Landing page
  if (!activeReport) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-6">Reports</h1>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {REPORTS.map((r) => (
            <button
              key={r.id}
              onClick={() => navigateReport(r.id)}
              className="bg-white border rounded-lg p-5 text-left hover:shadow-md transition-shadow flex items-start gap-4"
              style={{ borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: r.bg }}
              >
                <r.icon className="w-5 h-5" style={{ color: r.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-foreground">{r.name}</span>
                  <ChevronRight
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: 'var(--color-gray-400)' }}
                  />
                </div>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-gray-400)' }}>
                  {r.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Report view
  const currentReport = REPORTS.find((r) => r.id === activeReport) || REPORTS[0];

  return (
    <div>
      {/* T-P1 — closed-period banner. Shown when the report's date range
          falls within a closed period. Read-only signal; the "Reopen"
          affordance lives on the Admin Period Close tab. */}
      {closedPeriodInfo && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-amber-900">
              📌 This view is inside a <strong>closed period</strong> (locked through{' '}
              {closedPeriodInfo.locked_through_date}).
              {closedPeriodInfo.note && (
                <span className="text-amber-700"> — {closedPeriodInfo.note}</span>
              )}
              <span className="text-amber-700"> Read-only.</span>
            </span>
          </div>
          <Link
            to="/app/admin?tab=period-close"
            className="text-xs font-medium text-amber-900 hover:underline"
          >
            Manage period closes →
          </Link>
        </div>
      )}

      {/* Sub-navigation tabs */}
      <div
        className="flex items-center gap-1 mb-4 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {REPORTS.map((r) => (
          <button
            key={r.id}
            onClick={() => navigateReport(r.id)}
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
              r.id === activeReport
                ? 'border-[var(--color-brand-orange)] text-foreground'
                : 'border-transparent hover:text-foreground',
            )}
            style={{ color: r.id === activeReport ? undefined : 'var(--color-gray-400)' }}
          >
            {r.name}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button
          onClick={() => setSearchParams({})}
          className="flex items-center gap-1 text-sm font-medium"
          style={{ color: 'var(--color-brand-orange)' }}
        >
          <ArrowLeft className="w-4 h-4" /> Reports
        </button>

        <div className="flex flex-wrap items-center gap-2 flex-1 justify-center">
          <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {datePreset === 'custom' && (
            <>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    <CalendarIcon className="w-3 h-3 mr-1" />
                    {customFrom ? format(customFrom, 'MM/dd/yy') : 'Start'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={customFrom}
                    onSelect={setCustomFrom}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    <CalendarIcon className="w-3 h-3 mr-1" />
                    {customTo ? format(customTo, 'MM/dd/yy') : 'End'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={customTo}
                    onSelect={setCustomTo}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </>
          )}
          {!showPriorPeriod && (
            <button
              className="text-xs font-medium"
              style={{ color: 'var(--color-brand-orange)' }}
              onClick={() => setShowPriorPeriod(true)}
            >
              + Compare to a prior period
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* FX Revaluation toggle */}
          {revalJeIds.size > 0 && (
            <button
              className="flex items-center gap-1.5 px-3 h-8 text-xs font-medium border rounded-md transition-colors"
              style={{
                borderColor: 'var(--color-border)',
                background: showFxReval ? 'var(--color-brand-orange)' : 'white',
                color: showFxReval ? 'white' : 'var(--color-gray-600)',
              }}
              onClick={() => setShowFxReval((v) => !v)}
              title={showFxReval ? 'Hide FX revaluation entries' : 'Show FX revaluation entries'}
            >
              {showFxReval ? 'FX Reval: On' : 'FX Reval: Off'}
            </button>
          )}
          {/* Currency toggle */}
          <div
            className="flex border rounded-md overflow-hidden h-8"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {CURRENCY_MODES.filter((m) => !m.glOnly | (activeReport === 'general-ledger')).map(
              (m) => (
                <button
                  key={m.value}
                  disabled={m.value === 'secondary' && !secondaryCurrency}
                  className={cn('px-3 text-xs font-medium transition-colors disabled:opacity-40')}
                  style={{
                    background: currencyMode === m.value ? 'var(--color-brand-orange)' : 'white',
                    color: currencyMode === m.value ? 'white' : 'var(--color-gray-600)',
                  }}
                  onClick={() => setCurrencyMode(m.value)}
                >
                  {m.value === 'primary'
                    ? `Primary Currency (${primaryCurrency})`
                    : m.value === 'secondary'
                      ? `Secondary Currency (${secondaryCurrency || 'N/A'})`
                      : m.label}
                </button>
              ),
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() =>
              activeReport &&
              exportReportCsv(
                activeReport,
                currentReport.name,
                pnlData,
                bsData,
                tbData,
                glEntries,
                cfData,
                activityEntries,
                displayCurrency,
                btcDisplay,
                currencyMode,
                {
                  dateLabel,
                  primaryCurrency,
                  secondaryCurrency,
                  framework,
                  fxTranslationMethod,
                  hasBoundary: !!boundaryResult,
                  primaryCurrencyHistory,
                },
              )
            }
          >
            <Download className="w-4 h-4 mr-1" />
            CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              if (!activeReport) return;
              void printReport(
                activeReport,
                currentReport.name,
                orgName,
                dateLabel,
                pnlData,
                bsData,
                tbData,
                glEntries,
                cfData,
                activityEntries,
                reportPrintReportingNote(
                  activeReport,
                  currencyMode,
                  primaryCurrency,
                  secondaryCurrency,
                ),
              ).catch(() => {
                alert('Could not prepare the print preview. Try again.');
              });
            }}
          >
            <Printer className="w-4 h-4 mr-1" />
            Print
          </Button>
        </div>
      </div>

      {/* Prior period row */}
      {showPriorPeriod && (
        <div
          className="flex items-center gap-2 mb-4 px-2 py-2 rounded-lg"
          style={{ background: 'var(--color-gray-50)' }}
        >
          <span className="text-xs font-medium" style={{ color: 'var(--color-gray-600)' }}>
            Prior Period:
          </span>
          <Select value={priorPreset} onValueChange={(v) => setPriorPreset(v as DatePreset)}>
            <SelectTrigger className="w-[140px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {priorPreset === 'custom' && (
            <>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-7">
                    {priorFrom ? format(priorFrom, 'MM/dd/yy') : 'Start'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={priorFrom}
                    onSelect={setPriorFrom}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-7">
                    {priorTo ? format(priorTo, 'MM/dd/yy') : 'End'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={priorTo}
                    onSelect={setPriorTo}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowPriorPeriod(false)}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      )}

      {/* Wallet mode — mixed-units notice */}
      {!dataLoading && currencyMode === 'wallet' && (
        <div
          className="mb-3 px-3 py-2 rounded-lg text-xs"
          style={{ background: '#FFF7ED', border: '1px solid #FED7AA', color: '#92400E' }}
        >
          <strong>Mixed units:</strong> Each account is shown in its native wallet currency. Totals
          across different currencies are not meaningful.
        </div>
      )}

      {/* Boundary banner — date range crosses a primary-currency change */}
      {!dataLoading && boundaryResult && (
        <div
          className="mb-3 px-3 py-2 rounded-lg text-xs"
          style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E40AF' }}
        >
          <strong>Currency boundary detected:</strong> This report spans a period where your primary
          currency changed ({boundaryResult.eras.map((e) => e.currency).join(' → ')}). Amounts
          before and after {boundaryResult.boundariesInRange[0]} are in different currencies. Using
          closing-rate translation for secondary mode.
        </div>
      )}

      {/* Report content */}
      {dataLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <>
          {['pnl', 'balance-sheet', 'cash-flow'].includes(activeReport ?? '') &&
            !showPriorPeriod && (
              <ReportsViewToggle viewMode={reportViewMode} onChange={setReportViewMode} />
            )}
          {activeReport === 'pnl' &&
            (showPriorPeriod && priorPnlData ? (
              <ComparisonPnl
                orgName={orgName}
                dateLabel={dateLabel}
                priorDateLabel={priorDateLabel}
                data={pnlData}
                priorData={priorPnlData}
                currency={displayCurrency}
              />
            ) : (
              <PnlReport
                orgName={orgName}
                dateLabel={dateLabel}
                data={pnlData}
                currency={displayCurrency}
                hierarchy={hierarchyBundle}
              />
            ))}
          {activeReport === 'balance-sheet' &&
            (showPriorPeriod && priorBsData ? (
              <ComparisonBalanceSheet
                orgName={orgName}
                dateLabel={dateLabel}
                priorDateLabel={priorDateLabel}
                data={bsData}
                priorData={priorBsData}
                currency={displayCurrency}
              />
            ) : (
              <BalanceSheetReport
                orgName={orgName}
                dateLabel={dateLabel}
                data={bsData}
                currency={displayCurrency}
                hierarchy={hierarchyBundle}
              />
            ))}
          {activeReport === 'cash-flow' && (
            <CashFlowReport
              orgName={orgName}
              dateLabel={dateLabel}
              data={cfData}
              currency={displayCurrency}
              hierarchy={hierarchyBundle}
              cfPredicates={hierarchyBundle ? cfHierarchyPredicates : undefined}
            />
          )}
          {activeReport === 'general-ledger' && (
            <GeneralLedgerReport
              orgName={orgName}
              dateLabel={dateLabel}
              entries={glEntries}
              currency={displayCurrency}
            />
          )}
          {activeReport === 'trial-balance' &&
            (showPriorPeriod && priorTbData ? (
              <ComparisonTrialBalance
                orgName={orgName}
                dateLabel={dateLabel}
                priorDateLabel={priorDateLabel}
                data={tbData}
                priorData={priorTbData}
                currency={displayCurrency}
              />
            ) : (
              <TrialBalanceReport
                orgName={orgName}
                dateLabel={dateLabel}
                data={tbData}
                currency={displayCurrency}
              />
            ))}
          {activeReport === 'activity-log' && (
            <ActivityLogReport
              orgName={orgName}
              dateLabel={dateLabel}
              entries={activityEntries}
              currency={displayCurrency}
            />
          )}
        </>
      )}
    </div>
  );
}
