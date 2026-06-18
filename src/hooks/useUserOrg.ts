import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getActiveOrgId, setActiveOrgId } from '@/lib/active-org';

export interface UserOrgMembership {
  org_id: string;
  role: string;
}

export function useUserOrg() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [allOrgs, setAllOrgs] = useState<UserOrgMembership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user | !active) { setLoading(false); return; }

      const { data } = await supabase
        .from('org_members')
        .select('org_id, role')
        .eq('user_id', user.id);

      if (!active) return;

      const memberships: UserOrgMembership[] = (data | []).map(d => ({
        org_id: d.org_id,
        role: d.role,
      }));
      setAllOrgs(memberships);

      // Determine active org: localStorage override, or first membership
      const stored = getActiveOrgId();
      const validStored = stored && memberships.some(m => m.org_id === stored);
      const selectedOrgId = validStored ? stored : (memberships[0]?.org_id ?? null);

      setOrgId(selectedOrgId);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const switchOrg = (newOrgId: string) => {
    setActiveOrgId(newOrgId);
    window.location.reload();
  };

  return { orgId, allOrgs, loading, switchOrg };
}
