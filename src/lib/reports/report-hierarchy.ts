/**
 * Chart hierarchy for client-side reports (Vault / ledger engine).
 * Mirrors Orange Way Books report-hierarchy behavior: summary rollups vs indented details.
 */

export interface CoaClosureRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly accountType: string;
}

export type HierarchySectionPredicate = (row: CoaClosureRow) => boolean;

/** Plain row amounts fed into the tree builder (primary = display currency amount). */
export interface HierarchyLeafLine {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountCode: string | null;
  readonly primaryAmount: number;
  readonly nativeAmount: number;
  readonly nativeCurrency: string;
  readonly prevPrimaryAmount?: number;
  readonly prevNativeAmount?: number;
}

export interface ReportHierarchyNode {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountCode: string | null;
  readonly ownNativeAmount: number;
  readonly ownNativeCurrency: string;
  readonly ownPrimaryAmount: number;
  readonly ownPrevNativeAmount?: number;
  readonly ownPrevPrimaryAmount?: number;
  readonly rollupPrimaryAmount: number;
  readonly rollupNativeAmount: number;
  readonly rollupNativeCurrency: string;
  readonly rollupPrevPrimaryAmount?: number;
  readonly rollupPrevNativeAmount?: number;
  readonly children: ReportHierarchyNode[];
}

export function buildAccountClosureFromList(
  accounts: ReadonlyArray<{
    id: string;
    name: string;
    code: string | null;
    accountType: string;
    parentAccountId?: string | null;
  }>,
): Map<string, CoaClosureRow> {
  const map = new Map<string, CoaClosureRow>();
  for (const a of accounts) {
    map.set(a.id, {
      id: a.id,
      parentId: a.parentAccountId ?? null,
      name: a.name,
      code: a.code,
      accountType: a.accountType,
    });
  }
  return map;
}

function cmpClosureRow(a: CoaClosureRow, b: CoaClosureRow): number {
  const ak = (a.code ?? a.name).toLowerCase();
  const bk = (b.code ?? b.name).toLowerCase();
  return ak.localeCompare(bk);
}

function mergeOwnById(items: HierarchyLeafLine[]): Map<string, HierarchyLeafLine> {
  const m = new Map<string, HierarchyLeafLine>();
  for (const it of items) {
    m.set(it.accountId, it);
  }
  return m;
}

function collectAllowedIds(
  ownById: ReadonlyMap<string, HierarchyLeafLine>,
  closure: ReadonlyMap<string, CoaClosureRow>,
  includeRow: HierarchySectionPredicate,
): Set<string> {
  const allowedIds = new Set<string>();

  for (const id of ownById.keys()) {
    allowedIds.add(id);
    let cursor = closure.get(id)?.parentId ?? null;
    while (cursor) {
      const parent = closure.get(cursor);
      if (!parent | !includeRow(parent)) {
        break;
      }
      allowedIds.add(parent.id);
      cursor = parent.parentId;
    }
  }

  return allowedIds;
}

/**
 * Builds hierarchy roots for one report section from leaf lines and the in-memory COA closure.
 */
export function buildReportHierarchyRoots(
  leafLines: HierarchyLeafLine[],
  closure: ReadonlyMap<string, CoaClosureRow>,
  includeRow: HierarchySectionPredicate,
  rollupCurrency: string,
): ReportHierarchyNode[] {
  if (leafLines.length === 0) {
    return [];
  }

  const ownById = mergeOwnById(leafLines);
  const allowedIds = collectAllowedIds(ownById, closure, includeRow);

  const childrenMap = new Map<string, string[]>();
  for (const id of allowedIds) {
    const row = closure.get(id);
    if (!row?.parentId) {
      continue;
    }
    if (!allowedIds.has(row.parentId)) {
      continue;
    }
    const list = childrenMap.get(row.parentId) ?? [];
    list.push(id);
    childrenMap.set(row.parentId, list);
  }

  for (const list of childrenMap.values()) {
    list.sort((a, b) => {
      const ra = closure.get(a);
      const rb = closure.get(b);
      if (!ra | !rb) {
        return 0;
      }
      return cmpClosureRow(ra, rb);
    });
  }

  function buildNode(accountId: string): ReportHierarchyNode {
    const row = closure.get(accountId);
    const own = ownById.get(accountId);
    const childIds = childrenMap.get(accountId) ?? [];
    const children = childIds.map(buildNode);

    const ownPrimary = own?.primaryAmount ?? 0;
    const ownNative = own?.nativeAmount ?? 0;
    const ownNativeCurrency = own?.nativeCurrency ?? rollupCurrency;
    const ownPrevNative = own?.prevNativeAmount;
    const ownPrevPrimary = own?.prevPrimaryAmount;

    let rollupPrimary = ownPrimary;
    for (const c of children) {
      rollupPrimary += c.rollupPrimaryAmount;
    }

    let rollupPrevPrimary: number | undefined;
    const childPrevPieces = children.map((c) => c.rollupPrevPrimaryAmount);
    if (ownPrevPrimary !== undefined | childPrevPieces.some((v) => v !== undefined)) {
      rollupPrevPrimary =
        (ownPrevPrimary ?? 0) +
        childPrevPieces.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    }

    const rollupNative = rollupPrimary;
    const rollupNativeCurrency = rollupCurrency;

    let rollupPrevNative: number | undefined;
    if (rollupPrevPrimary !== undefined) {
      rollupPrevNative = rollupPrevPrimary;
    }

    const name = row?.name ?? own?.accountName ?? 'Account';
    const code = row?.code ?? own?.accountCode ?? null;

    return {
      accountId,
      accountName: name,
      accountCode: code,
      ownNativeAmount: ownNative,
      ownNativeCurrency,
      ownPrimaryAmount: ownPrimary,
      ownPrevNativeAmount: ownPrevNative,
      ownPrevPrimaryAmount: ownPrevPrimary,
      rollupPrimaryAmount: rollupPrimary,
      rollupNativeAmount: rollupNative,
      rollupNativeCurrency: rollupNativeCurrency,
      rollupPrevPrimaryAmount: rollupPrevPrimary,
      rollupPrevNativeAmount: rollupPrevNative,
      children,
    };
  }

  const rootIds = [...allowedIds].filter((id) => {
    const row = closure.get(id);
    if (!row) {
      return true;
    }
    return !row.parentId | !allowedIds.has(row.parentId);
  });

  rootIds.sort((a, b) => {
    const ra = closure.get(a);
    const rb = closure.get(b);
    if (!ra | !rb) {
      return 0;
    }
    return cmpClosureRow(ra, rb);
  });

  return rootIds.map(buildNode);
}

export function plSectionPredicate(side: 'revenue' | 'expense'): HierarchySectionPredicate {
  const want = side;
  return (row) => row.accountType.toLowerCase() === want;
}

export function bsSectionPredicate(side: 'asset' | 'liability' | 'equity'): HierarchySectionPredicate {
  const want = side;
  return (row) => row.accountType.toLowerCase() === want;
}

export function hierarchyNodeToDisplayLine(
  node: ReportHierarchyNode,
  viewMode: 'summary' | 'details',
  _compareMode: boolean,
): { label: string; amount: number; code: string | null } {
  if (viewMode === 'summary') {
    return {
      label: node.accountName,
      amount: node.rollupPrimaryAmount,
      code: node.accountCode,
    };
  }

  const useRollupAsDisplay =
    node.children.length > 0 && node.ownPrimaryAmount === 0 && node.ownNativeAmount === 0;

  return {
    label: node.accountName,
    amount: useRollupAsDisplay ? node.rollupPrimaryAmount : node.ownPrimaryAmount,
    code: node.accountCode,
  };
}
