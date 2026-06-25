/**
 * Period Close + Reopen (P7 + P10).
 *
 * Surfaces the existing period-lock schema as a settings page:
 *   - org_period_closes for the close events
 *   - period_unlock_sessions for owner-initiated reopen with TTL
 *
 * Scope:
 *   - Show current effective lock date
 *   - Close period through <date> with an optional encrypted reason
 *     (gated on periods.close capability)
 *   - Reopen the current period for me (Owner only, via periods.unlock):
 *     pick an unlock-through date + optional encrypted reason. Inserts
 *     a period_unlock_sessions row with the schema's default 24h TTL.
 *   - List currently-active unlock sessions for this user; revoke any
 *     of them with one click.
 *   - History table of past close events.
 *
 * Out of scope (future):
 *   - Bulk revocation across all users (server-side only via SQL today)
 *   - Surfacing unlock-session usage in the audit log feed
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarIcon, Lock, Loader2, Unlock, KeyRound } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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

interface PeriodCloseRow {
  id: string;
  locked_through_date: string;
  closed_by: string;
  closed_at: string;
  encrypted_note: string | null;
  key_version: number | null;
  reopened_from_id: string | null;
  note_plain: string | null;
}

interface UnlockSessionRow {
  id: string;
  user_id: string;
  granted_by: string;
  unlock_through_date: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  encrypted_reason: string | null;
  key_version: number | null;
  reason_plain: string | null;
  is_mine: boolean;
}

export default function Periods() {
  const { orgId } = useUserOrg();
  const { encryptText, decryptText } = useVault();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PeriodCloseRow[]>([]);
  const [unlockRows, setUnlockRows] = useState<UnlockSessionRow[]>([]);
  const [canClose, setCanClose] = useState(false);
  const [canUnlock, setCanUnlock] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // Close-period form state
  const [closeDate, setCloseDate] = useState<Date | undefined>(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31));
  });
  const [datePopOpen, setDatePopOpen] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reopen form state
  const [unlockDate, setUnlockDate] = useState<Date | undefined>(undefined);
  const [unlockDatePopOpen, setUnlockDatePopOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const load = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const uid = user?.id ?? null;
      setUserId(uid);

      // Closes
      const { data: closes, error } = await supabase
        .from('org_period_closes')
        .select('*')
        .eq('org_id', orgId)
        .order('closed_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const decrypted: PeriodCloseRow[] = await Promise.all(
        (closes ?? []).map(async (r: any) => {
          let note_plain: string | null = null;
          if (r.encrypted_note && r.key_version) {
            try {
              note_plain = await decryptText(r.encrypted_note);
            } catch {
              note_plain = '(decryption failed)';
            }
          }
          return {
            id: r.id,
            locked_through_date: r.locked_through_date,
            closed_by: r.closed_by,
            closed_at: r.closed_at,
            encrypted_note: r.encrypted_note,
            key_version: r.key_version,
            reopened_from_id: r.reopened_from_id,
            note_plain,
          };
        }),
      );
      setRows(decrypted);

      // Active unlock sessions (not yet expired, not revoked)
      const { data: sessions } = await supabase
        .from('period_unlock_sessions')
        .select('*')
        .eq('org_id', orgId)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      const decryptedSessions: UnlockSessionRow[] = await Promise.all(
        (sessions ?? []).map(async (r: any) => {
          let reason_plain: string | null = null;
          if (r.encrypted_reason && r.key_version) {
            try {
              reason_plain = await decryptText(r.encrypted_reason);
            } catch {
              reason_plain = '(decryption failed)';
            }
          }
          return {
            id: r.id,
            user_id: r.user_id,
            granted_by: r.granted_by,
            unlock_through_date: r.unlock_through_date,
            created_at: r.created_at,
            expires_at: r.expires_at,
            revoked_at: r.revoked_at,
            encrypted_reason: r.encrypted_reason,
            key_version: r.key_version,
            reason_plain,
            is_mine: r.user_id === uid,
          };
        }),
      );
      setUnlockRows(decryptedSessions);

      // Capability checks
      const [{ data: closeCap }, { data: unlockCap }] = await Promise.all([
        supabase.rpc('user_has_capability', {
          p_user_id: uid,
          p_capability: 'periods.close',
          p_org_id: orgId,
        }),
        supabase.rpc('user_has_capability', {
          p_user_id: uid,
          p_capability: 'periods.unlock',
          p_org_id: orgId,
        }),
      ]);
      setCanClose(!!closeCap);
      setCanUnlock(!!unlockCap);
    } catch (err) {
      console.error('Periods load failed', err);
      toast.error('Failed to load period closes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [orgId]);

  const activeLock = useMemo(() => {
    return rows.length > 0 ? rows[0] : null;
  }, [rows]);

  const handleClose = async () => {
    if (!orgId || !closeDate || !userId) return;
    setSubmitting(true);
    try {
      let encNote: string | null = null;
      if (note.trim()) {
        encNote = await encryptText(note.trim());
      }
      const { error } = await supabase.from('org_period_closes').insert({
        org_id: orgId,
        locked_through_date: format(closeDate, 'yyyy-MM-dd'),
        closed_by: userId,
        encrypted_note: encNote,
        key_version: encNote ? 2 : null,
      } as any);
      if (error) throw error;
      toast.success(`Period closed through ${format(closeDate, 'PPP')}`);
      setNote('');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to close period: ${msg}`);
      console.error('Period close failed', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReopen = async () => {
    if (!orgId || !unlockDate || !userId) return;
    setUnlocking(true);
    try {
      let encReason: string | null = null;
      if (unlockReason.trim()) {
        encReason = await encryptText(unlockReason.trim());
      }
      const { error } = await supabase.from('period_unlock_sessions').insert({
        org_id: orgId,
        user_id: userId,
        granted_by: userId,
        unlock_through_date: format(unlockDate, 'yyyy-MM-dd'),
        encrypted_reason: encReason,
        key_version: encReason ? 2 : null,
      } as any);
      if (error) throw error;
      toast.success(`Unlocked through ${format(unlockDate, 'PPP')} (24 hour TTL)`);
      setUnlockReason('');
      setUnlockDate(undefined);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to reopen: ${msg}`);
      console.error('Period reopen failed', err);
    } finally {
      setUnlocking(false);
    }
  };

  const handleRevoke = async (sessionId: string) => {
    if (
      !confirm(
        'Revoke this unlock session? Writes to the closed period will be blocked again immediately.',
      )
    )
      return;
    try {
      const { error } = await supabase
        .from('period_unlock_sessions')
        .update({ revoked_at: new Date().toISOString() } as any)
        .eq('id', sessionId);
      if (error) throw error;
      toast.success('Unlock session revoked');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to revoke: ${msg}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container max-w-4xl py-8">
      <Link
        to="/app/admin"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Admin
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2">
          <Lock className="w-5 h-5" /> Period Close
        </h1>
        <p className="text-sm text-muted-foreground">
          Lock a date range so journal entries on or before that date can no longer be edited.
          Owners can briefly reopen a closed period for themselves with a 24 hour time-limited
          session.
        </p>
      </header>

      <section className="rounded-md border p-5 mb-8 bg-card">
        <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-2">Current lock</h2>
        {activeLock ? (
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-mono">
              {format(parseISO(activeLock.locked_through_date), 'PPP')}
            </span>
            <span className="text-xs text-muted-foreground">
              closed {format(parseISO(activeLock.closed_at), 'PPP')}
            </span>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            No period is currently closed. All dates are editable.
          </div>
        )}
      </section>

      {canClose && (
        <section className="rounded-md border p-5 mb-8 bg-card">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3">
            Close period
          </h2>

          <div className="space-y-4">
            <div>
              <Label htmlFor="close-date" className="text-sm font-medium">
                Lock through date (inclusive)
              </Label>
              <Popover open={datePopOpen} onOpenChange={setDatePopOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="close-date"
                    variant="outline"
                    className={cn(
                      'w-full md:w-72 justify-start text-left font-normal mt-1',
                      !closeDate && 'text-muted-foreground',
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {closeDate ? format(closeDate, 'PPP') : 'Pick a date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={closeDate}
                    onSelect={(d) => {
                      if (d) {
                        setCloseDate(d);
                        setDatePopOpen(false);
                      }
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground mt-1">
                Journal entries dated on or before this day will be locked from edits.
              </p>
            </div>

            <div>
              <Label htmlFor="close-note" className="text-sm font-medium">
                Reason / note (encrypted, optional)
              </Label>
              <Textarea
                id="close-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. 2024 books closed for accountant review"
                className="mt-1 max-w-2xl"
                rows={2}
              />
            </div>

            <div className="flex justify-end">
              <Button type="button" onClick={handleClose} disabled={submitting || !closeDate}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Close period
              </Button>
            </div>
          </div>
        </section>
      )}

      {canUnlock && activeLock && (
        <section className="rounded-md border p-5 mb-8 bg-card">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> Reopen for me (24 hour TTL)
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Creates a time-limited unlock session just for you. Writes into the closed period become
            possible until the session expires (24 hours) or you revoke it. The audit trail records
            every reopen.
          </p>

          <div className="space-y-4">
            <div>
              <Label htmlFor="unlock-date" className="text-sm font-medium">
                Unlock through date
              </Label>
              <Popover open={unlockDatePopOpen} onOpenChange={setUnlockDatePopOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="unlock-date"
                    variant="outline"
                    className={cn(
                      'w-full md:w-72 justify-start text-left font-normal mt-1',
                      !unlockDate && 'text-muted-foreground',
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {unlockDate ? format(unlockDate, 'PPP') : 'Pick a date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={unlockDate}
                    onSelect={(d) => {
                      if (d) {
                        setUnlockDate(d);
                        setUnlockDatePopOpen(false);
                      }
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground mt-1">
                Pick a date inside the locked range. Writes for that day and earlier become
                possible.
              </p>
            </div>

            <div>
              <Label htmlFor="unlock-reason" className="text-sm font-medium">
                Reason (encrypted, optional)
              </Label>
              <Textarea
                id="unlock-reason"
                value={unlockReason}
                onChange={(e) => setUnlockReason(e.target.value)}
                placeholder="e.g. fix mis-categorized 2024-Q4 expense"
                className="mt-1 max-w-2xl"
                rows={2}
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={handleReopen}
                disabled={unlocking || !unlockDate}
              >
                {unlocking && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                <Unlock className="w-4 h-4 mr-2" />
                Reopen for 24 hours
              </Button>
            </div>
          </div>
        </section>
      )}

      {unlockRows.length > 0 && (
        <section className="rounded-md border bg-card mb-8">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground px-5 pt-5 mb-3">
            Active unlock sessions ({unlockRows.length})
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Unlock through</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {unlockRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.is_mine ? (
                      <Badge variant="default">You</Badge>
                    ) : (
                      <span className="text-xs font-mono">{r.user_id.slice(0, 8)}…</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono">
                    {format(parseISO(r.unlock_through_date), 'yyyy-MM-dd')}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(parseISO(r.expires_at), 'PPP p')}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.reason_plain || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {r.is_mine && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevoke(r.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="rounded-md border bg-card">
        <h2 className="text-sm uppercase tracking-wide text-muted-foreground px-5 pt-5 mb-3">
          Close history
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-5 pt-0">No close events yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Locked through</TableHead>
                <TableHead>Closed at</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-32">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono">
                    {format(parseISO(r.locked_through_date), 'yyyy-MM-dd')}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(parseISO(r.closed_at), 'PPP p')}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.note_plain || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {r.reopened_from_id ? (
                      <Badge variant="secondary">Re-close</Badge>
                    ) : (
                      <Badge variant="outline">Close</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
