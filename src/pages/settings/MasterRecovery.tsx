/**
 * Settings → Security → Master recovery (S14)
 *
 * One 12-word phrase that unlocks every org the user is a member of.
 * Setup is opt-in: nothing happens unless the user enrolls.
 *
 * Status states:
 *   - none      No user_master_recovery row exists. Offer setup.
 *   - partial   Master record exists, but at least one org the user
 *               is a member of has no org_master_wraps row yet. Offer
 *               to enroll the active org (other orgs are enrolled on
 *               their own unlock).
 *   - complete  All current memberships have a wrap. Offer rotate or
 *               disable.
 *
 * Rotation: re-derive a fresh master KEK and re-wrap every org's MEK.
 * Disable: drop user_master_recovery + all org_master_wraps for the
 * user (per-org recovery kits still work).
 *
 * Surfaced by 2026-05-16 security review. Tracked as S14.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Printer,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { openRecoveryBackup } from '@/lib/recoveryBackup';
import { toast } from 'sonner';

type Status = 'none' | 'partial' | 'complete';
type Stage = 'intro' | 'display' | 'verify' | 'done' | 'rotate' | 'disable';

interface MembershipRow {
  org_id: string;
}

export default function MasterRecovery() {
  const navigate = useNavigate();
  const { setupMasterRecoveryCode, wrapCurrentOrgUnderMaster, isUnlocked } = useVault();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>('none');
  const [memberships, setMemberships] = useState<string[]>([]);
  const [wrappedOrgIds, setWrappedOrgIds] = useState<string[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>('intro');
  const [confirmAck, setConfirmAck] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyPositions, setVerifyPositions] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>(['', '', '']);
  const [verifyError, setVerifyError] = useState('');
  const [enrollCode, setEnrollCode] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        navigate('/app');
        return;
      }
      setUserId(user.id);

      const { data: members } = await supabase
        .from('org_members')
        .select('org_id, joined_at')
        .eq('user_id', user.id)
        .order('joined_at', { ascending: true });
      const orgIds = ((members ?? []) as MembershipRow[]).map((m) => m.org_id);
      setMemberships(orgIds);

      const stored = localStorage.getItem('orangewaybooks.active_org');
      setActiveOrgId(stored && orgIds.includes(stored) ? stored : (orgIds[0] ?? null));

      const { data: master } = await (supabase as any)
        .from('user_master_recovery')
        .select('user_id, created_at')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!master) {
        setStatus('none');
        setWrappedOrgIds([]);
        return;
      }
      const { data: wraps } = await (supabase as any)
        .from('org_master_wraps')
        .select('org_id')
        .eq('user_id', user.id);
      const wrappedIds = (wraps ?? []).map((w: { org_id: string }) => w.org_id);
      setWrappedOrgIds(wrappedIds);
      setStatus(orgIds.every((o) => wrappedIds.includes(o)) ? 'complete' : 'partial');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Warn during display/verify so the code isn't lost on a stray close.
  useEffect(() => {
    if (stage !== 'display' && stage !== 'verify') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        'Your new master recovery key has not been verified saved. Closing now will lose it.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stage]);

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading master recovery status…
      </div>
    );
  }
  if (!isUnlocked) {
    return (
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Unlock your vault to manage your master recovery key.
          </p>
        </div>
      </div>
    );
  }

  const unwrappedOrgIds = memberships.filter((id) => !wrappedOrgIds.includes(id));

  // ── Setup: brand-new master recovery ───────────────────────────────
  const handleSetup = async () => {
    if (!userId || !activeOrgId) return;
    setSubmitting(true);
    try {
      const out = await setupMasterRecoveryCode();
      const { error: insErr } = await (supabase as any).from('user_master_recovery').insert({
        user_id: userId,
        master_salt: out.masterSalt,
        master_verifier_ciphertext: out.verifierCiphertext,
        key_version: 1,
      });
      if (insErr) throw new Error(`user_master_recovery insert: ${insErr.message}`);

      const { error: wrapErr } = await (supabase as any).from('org_master_wraps').insert({
        user_id: userId,
        org_id: activeOrgId,
        master_wrapped_mek: out.currentOrgWrap,
        key_version: 1,
      });
      if (wrapErr) throw new Error(`org_master_wraps insert: ${wrapErr.message}`);

      setNewCode(out.newMasterCode);
      setStage('display');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Master recovery setup failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Enroll the active org into existing master recovery ────────────
  const handleEnrollActiveOrg = async () => {
    if (!userId || !activeOrgId) return;
    setSubmitting(true);
    try {
      const { data: master } = await (supabase as any)
        .from('user_master_recovery')
        .select('master_salt')
        .eq('user_id', userId)
        .single();
      const masterSalt = (master as any)?.master_salt;
      if (!masterSalt) throw new Error('Master recovery is not set up yet.');

      const wrap = await wrapCurrentOrgUnderMaster(enrollCode, masterSalt);
      const { error } = await (supabase as any)
        .from('org_master_wraps')
        .upsert(
          { user_id: userId, org_id: activeOrgId, master_wrapped_mek: wrap, key_version: 1 },
          { onConflict: 'user_id,org_id' },
        );
      if (error) throw new Error(error.message);
      toast.success('This organization is now enrolled in master recovery.');
      setEnrollCode('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Enrollment failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Disable: drop master record + all wraps ────────────────────────
  const handleDisable = async () => {
    if (!userId) return;
    if (
      !window.confirm(
        'Disable master recovery? Per-org recovery kits still work. Your saved master recovery key stops working immediately.',
      )
    )
      return;
    setSubmitting(true);
    try {
      await (supabase as any).from('org_master_wraps').delete().eq('user_id', userId);
      await (supabase as any).from('user_master_recovery').delete().eq('user_id', userId);
      toast.success('Master recovery disabled.');
      await refresh();
      setStage('intro');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disable.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartVerify = () => {
    const positions: number[] = [];
    while (positions.length < 3) {
      const buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      const pos = buf[0] % 12;
      if (!positions.includes(pos)) positions.push(pos);
    }
    positions.sort((a, b) => a - b);
    setVerifyPositions(positions);
    setVerifyInputs(['', '', '']);
    setVerifyError('');
    setStage('verify');
  };

  const handleConfirmVerify = () => {
    if (!newCode) return;
    const words = newCode.split(' ');
    const allMatch = verifyPositions.every(
      (pos, i) => verifyInputs[i].trim().toLowerCase() === words[pos],
    );
    if (!allMatch) {
      setVerifyError('One or more words do not match. Check your saved copy and try again.');
      return;
    }
    setStage('done');
    toast.success('Master recovery key set up.');
  };

  const handleCopy = async () => {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="max-w-2xl p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1 flex items-center gap-2">
          <KeyRound className="w-6 h-6 text-primary" />
          Master recovery key
        </h1>
        <p className="text-sm text-muted-foreground">
          A single 12-word phrase that unlocks <strong>every organization</strong> you belong to.
          Optional. Per-org recovery kits still work independently.
        </p>
      </div>

      {stage === 'intro' && status === 'none' && (
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-card-foreground">Set it up</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            You belong to <strong>{memberships.length}</strong> organization
            {memberships.length === 1 ? '' : 's'}. Setting up master recovery will wrap your current
            org's data key under a new master recovery key. You can enroll additional orgs by unlocking each
            one and returning here.
          </p>
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium mb-1">
                This adds a recovery path, it doesn't replace per-org kits.
              </p>
              <p>
                Per-org recovery kits still work for their specific org. The master recovery key is an
                extra layer that covers all your orgs at once.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="ack"
              checked={confirmAck}
              onCheckedChange={(v) => setConfirmAck(Boolean(v))}
            />
            <Label htmlFor="ack" className="text-sm leading-tight cursor-pointer">
              I will save my master recovery key immediately and store it offline.
            </Label>
          </div>
          <Button
            onClick={handleSetup}
            disabled={!confirmAck || submitting}
            data-testid="generate-master-code"
          >
            {submitting ? 'Generating…' : 'Generate master recovery key'}
          </Button>
        </section>
      )}

      {stage === 'intro' && status !== 'none' && (
        <>
          <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-2">
            <div className="flex items-center gap-2">
              <Check className="w-5 h-5 text-emerald-600" />
              <h2 className="text-base font-semibold text-card-foreground">
                Master recovery is enabled
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {wrappedOrgIds.length} of {memberships.length} organization
              {memberships.length === 1 ? '' : 's'} enrolled.
            </p>
          </section>

          {unwrappedOrgIds.length > 0 && (
            <section className="rounded-lg border border-border bg-card p-5 space-y-3">
              <h2 className="text-base font-semibold text-card-foreground">
                Enroll the active organization
              </h2>
              <p className="text-sm text-muted-foreground">
                {unwrappedOrgIds.includes(activeOrgId ?? '')
                  ? 'This organization is not yet enrolled. Enter your master recovery key to enroll it.'
                  : `Switch to one of these orgs (${unwrappedOrgIds.length} unenrolled) and return here to enroll it.`}
              </p>
              {unwrappedOrgIds.includes(activeOrgId ?? '') && (
                <>
                  <Input
                    placeholder="Master recovery key (12 words)"
                    value={enrollCode}
                    onChange={(e) => setEnrollCode(e.target.value)}
                    className="font-mono"
                  />
                  <Button
                    onClick={handleEnrollActiveOrg}
                    disabled={submitting || enrollCode.trim().split(/\s+/).length !== 12}
                  >
                    Enroll this organization
                  </Button>
                </>
              )}
            </section>
          )}

          <section className="rounded-lg border border-border bg-card p-5 space-y-3">
            <h2 className="text-base font-semibold text-card-foreground">
              Disable master recovery
            </h2>
            <p className="text-sm text-muted-foreground">
              Removes the master record and all org wraps. Per-org recovery kits are unaffected.
            </p>
            <Button variant="outline" onClick={handleDisable} disabled={submitting}>
              <Trash2 className="w-4 h-4 mr-1" /> Disable
            </Button>
          </section>
        </>
      )}

      {stage === 'display' && newCode && (
        <section className="rounded-lg border-2 border-primary/40 bg-primary/5 p-5 space-y-4">
          <h2 className="text-base font-semibold text-card-foreground flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" /> Your master recovery key
          </h2>
          <p className="text-xs text-muted-foreground">
            Shown once. Treat it like a key to all your books.
          </p>
          <div
            className="rounded-md border border-primary/40 bg-background p-4 grid grid-cols-3 gap-2"
            data-testid="master-code-grid"
          >
            {newCode.split(' ').map((w, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-sm"
                data-testid={`master-word-${i}`}
              >
                <span className="w-5 text-right text-xs text-muted-foreground shrink-0">
                  {i + 1}.
                </span>
                <span className="font-mono font-medium">{w}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" /> Copy
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                try {
                  openRecoveryBackup({ code: newCode });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Print failed.');
                }
              }}
            >
              <Printer className="w-4 h-4 mr-1" /> Download printable backup
            </Button>
          </div>
          <Button className="w-full" onClick={handleStartVerify}>
            I have saved it. Verify
          </Button>
        </section>
      )}

      {stage === 'verify' && newCode && (
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-base font-semibold text-card-foreground">Prove you saved it</h2>
          <div className="space-y-2">
            {verifyPositions.map((pos, i) => (
              <div key={pos} className="flex items-center gap-2">
                <span className="w-16 text-xs text-muted-foreground">Word {pos + 1}</span>
                <Input
                  value={verifyInputs[i]}
                  onChange={(e) => {
                    const next = [...verifyInputs];
                    next[i] = e.target.value;
                    setVerifyInputs(next);
                    setVerifyError('');
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  autoFocus={i === 0}
                />
              </div>
            ))}
          </div>
          {verifyError && (
            <p className="text-sm text-destructive flex items-start gap-1">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              {verifyError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setStage('display')}>
              Back to code
            </Button>
            <Button
              className="flex-1"
              disabled={verifyInputs.some((v) => !v.trim())}
              onClick={handleConfirmVerify}
            >
              Confirm
            </Button>
          </div>
        </section>
      )}

      {stage === 'done' && (
        <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Check className="w-5 h-5 text-emerald-600" />
            <h2 className="text-base font-semibold text-card-foreground">
              Master recovery is live
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            The active organization is enrolled. To enroll others, switch to each org and click
            "Enroll this organization" here.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setStage('intro');
              setNewCode(null);
            }}
          >
            Done
          </Button>
        </section>
      )}
    </div>
  );
}
