/**
 * MaintenanceBanner, Phase 4.5 D14.
 *
 * Global top-of-app banner shown to non-Owners while a key rotation job
 * is in an intermediate stage (wrapping_members, rekeying_rows,
 * finalizing). Owners driving the job see the wizard progress UI
 * instead, so we hide the banner for them.
 *
 * Subscribes via Supabase realtime to `key_rotation_jobs` for the
 * user's active org. Also polls once on mount in case a job started
 * before the subscription was live.
 *
 * Customer-first copy: no DEK/rekey/wrap. Just "Your team is
 * updating its security."
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AlertTriangle } from 'lucide-react';

export interface MaintenanceBannerProps {
  orgId: string | null;
  /** If the current user is the one running the job, suppress the
   *  banner (they see the wizard progress UI instead). */
  currentUserId: string | null;
}

interface ActiveJob {
  id: string;
  status: string;
  started_by: string;
}

const ACTIVE_STAGES = new Set(['wrapping_members', 'rekeying_rows', 'finalizing']);

export function MaintenanceBanner({ orgId, currentUserId }: MaintenanceBannerProps) {
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);

  useEffect(() => {
    if (!orgId) {
      setActiveJob(null);
      return;
    }
    let active = true;

    const fetch = async () => {
      const { data } = await supabase
        .from('key_rotation_jobs')
        .select('id, status, started_by')
        .eq('org_id', orgId)
        .in('status', Array.from(ACTIVE_STAGES))
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!active) return;
      setActiveJob((data as ActiveJob | null) ?? null);
    };
    void fetch();

    const channel = supabase
      .channel(`key-rotation-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'key_rotation_jobs', filter: `org_id=eq.${orgId}` },
        () => {
          void fetch();
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [orgId]);

  if (!activeJob) return null;
  if (currentUserId && activeJob.started_by === currentUserId) return null;

  return (
    <div className="w-full bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-center gap-3 text-sm">
      <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
      <div className="flex-1">
        <p className="font-semibold text-amber-900">Your team is updating its security.</p>
        <p className="text-amber-800">
          You can view data but can't make changes for a few minutes. If this takes longer than
          expected, contact support.
        </p>
      </div>
    </div>
  );
}

export default MaintenanceBanner;
