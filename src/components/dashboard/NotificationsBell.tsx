import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellDot, Check } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { format } from 'date-fns';

interface DerivedItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly count: number;
}

interface InboxRow {
  readonly id: string;
  readonly kind: string;
  readonly body: string;
  readonly action_href: string | null;
  readonly read_at: string | null;
  readonly created_at: string;
}

export interface NotificationsBellProps {
  readonly orgId: string | null;
}

export function NotificationsBell({ orgId }: NotificationsBellProps) {
  const { decryptText } = useVault();
  const [derived, setDerived] = useState<DerivedItem[]>([]);
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [loadingDerived, setLoadingDerived] = useState(true);
  const [marking, setMarking] = useState(false);

  // Derived counts, the "current state to query" notifications that
  // don't have a dedicated inbox row.
  useEffect(() => {
    if (!orgId) {
      setLoadingDerived(false);
      return;
    }
    let cancelled = false;

    const run = async () => {
      const [jeRes, walletsRes, txPendingRes] = await Promise.all([
        supabase.from('journal_entries').select('id, status, key_version').eq('org_id', orgId),
        supabase.from('accounts').select('id, external_account_id').eq('org_id', orgId),
        supabase
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .is('account_id', null),
      ]);

      if (cancelled) return;

      let draftCount = 0;
      for (const row of (jeRes.data as any[]) ?? []) {
        let status: string | null = null;
        if (row.key_version && row.status) {
          try {
            status = await decryptText(row.status);
          } catch {
            status = null;
          }
        } else if (row.status) {
          status = row.status;
        }
        if (!status || status.toUpperCase() === 'DRAFT') draftCount += 1;
      }

      const unmappedWallets = ((walletsRes.data as any[]) ?? []).filter(
        (w) => !w.external_account_id,
      ).length;

      const unassignedTx = txPendingRes.count ?? 0;

      const next: DerivedItem[] = [];
      if (draftCount > 0) {
        next.push({
          id: 'drafts',
          title: `${draftCount} draft journal ${draftCount === 1 ? 'entry' : 'entries'}`,
          description: 'Review and post to include in your reports.',
          href: '/journal',
          count: draftCount,
        });
      }
      if (unmappedWallets > 0) {
        next.push({
          id: 'unmapped',
          title: `${unmappedWallets} wallet${unmappedWallets === 1 ? '' : 's'} without a chart account`,
          description: 'Map them to a chart account so transactions post correctly.',
          href: '/accounts',
          count: unmappedWallets,
        });
      }
      if (unassignedTx > 0) {
        next.push({
          id: 'unassigned-tx',
          title: `${unassignedTx} transaction${unassignedTx === 1 ? '' : 's'} without a wallet`,
          description: 'Assign them so they appear in the right account.',
          href: '/transactions',
          count: unassignedTx,
        });
      }

      setDerived(next);
      setLoadingDerived(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [orgId, decryptText]);

  // Inbox notifications, newest 20 from the notifications table. The
  // realtime subscription below keeps the list fresh while the bell is
  // visible.
  const fetchInbox = useCallback(async () => {
    if (!orgId) {
      setInbox([]);
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setInbox([]);
      return;
    }
    const { data, error } = await (supabase as any)
      .from('notifications')
      .select('id, kind, body, action_href, read_at, created_at')
      .eq('org_id', orgId)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      // The bell shouldn't crash the page if the table isn't reachable
      // (e.g. migration hasn't applied yet). Silent failure + log.
      console.warn('[NotificationsBell] inbox fetch failed:', error.message);
      return;
    }
    setInbox((data as InboxRow[] | null) ?? []);
  }, [orgId]);

  useEffect(() => {
    void fetchInbox();
  }, [fetchInbox]);

  useEffect(() => {
    if (!orgId) return;
    const channel = supabase
      .channel(`notifications-${orgId}`)
      .on(
        'postgres_changes' as never,
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `org_id=eq.${orgId}` },
        () => {
          void fetchInbox();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [orgId, fetchInbox]);

  const unreadInbox = inbox.filter((n) => n.read_at === null);
  const derivedCount = derived.reduce((s, i) => s + i.count, 0);
  const totalBadge = derivedCount + unreadInbox.length;
  const hasAny = totalBadge > 0;
  const Icon = hasAny ? BellDot : Bell;
  const color = hasAny ? '#d97706' : '#6b7280';

  const markAllRead = async () => {
    if (unreadInbox.length === 0) return;
    setMarking(true);
    const now = new Date().toISOString();
    const ids = unreadInbox.map((n) => n.id);
    const { error } = await (supabase as any)
      .from('notifications')
      .update({ read_at: now })
      .in('id', ids);
    setMarking(false);
    if (error) {
      console.warn('[NotificationsBell] mark all read failed:', error.message);
      return;
    }
    setInbox((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, read_at: now } : n)));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={hasAny ? `${totalBadge} notifications` : 'No notifications'}
          className="relative inline-flex items-center justify-center rounded-full p-1.5 hover:bg-muted/60 transition-colors"
        >
          <Icon className="w-5 h-5" style={{ color }} strokeWidth={2} />
          {hasAny && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center"
              style={{ background: '#dc2626' }}
            >
              {totalBadge > 99 ? '99+' : totalBadge}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="px-4 py-3 border-b flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Notifications</p>
            <p className="text-xs text-muted-foreground">
              {loadingDerived && inbox.length === 0
                ? 'Checking…'
                : hasAny
                  ? 'Click an item to go there.'
                  : 'All caught up.'}
            </p>
          </div>
          {unreadInbox.length > 0 && (
            <button
              type="button"
              className="text-xs text-blue-700 hover:underline whitespace-nowrap shrink-0"
              onClick={() => void markAllRead()}
              disabled={marking}
              data-testid="notifications-mark-all-read"
            >
              <Check className="inline w-3 h-3 mr-0.5" />
              Mark all read
            </button>
          )}
        </div>

        <ul className="max-h-96 overflow-y-auto divide-y">
          {derived.length === 0 && inbox.length === 0 && !loadingDerived && (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground">
              No pending items. Nice.
            </li>
          )}

          {derived.map((it) => (
            <li key={`d:${it.id}`}>
              <Link to={it.href} className="block px-4 py-3 hover:bg-muted/50 transition-colors">
                <div className="flex items-start gap-2">
                  <span
                    className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold text-white flex items-center justify-center"
                    style={{ background: '#d97706' }}
                  >
                    {it.count}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-tight">{it.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{it.description}</p>
                  </div>
                </div>
              </Link>
            </li>
          ))}

          {inbox.map((n) => {
            const unread = n.read_at === null;
            const inner = (
              <div className="flex items-start gap-2">
                <span
                  className="shrink-0 mt-0.5 w-2 h-2 rounded-full"
                  style={{ background: unread ? '#dc2626' : 'transparent' }}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p
                    className={`text-sm leading-tight ${unread ? 'font-semibold' : 'text-muted-foreground'}`}
                  >
                    {n.body}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {format(new Date(n.created_at), 'MMM d, h:mm a')}
                  </p>
                </div>
              </div>
            );
            return (
              <li key={`n:${n.id}`}>
                {n.action_href ? (
                  <Link
                    to={n.action_href}
                    className="block px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="px-4 py-3">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
