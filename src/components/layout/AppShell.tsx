import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import { useUserOrg } from '@/hooks/useUserOrg';
import { PendingRatesBanner } from '@/components/PendingRatesBanner';
import { MaintenanceBanner } from '@/components/rekey/MaintenanceBanner';
import { LedgerStatusPill } from '@/components/LedgerStatusPill';
import { supabase } from '@/lib/supabase';

export default function AppShell() {
  const { orgId } = useUserOrg();
  const [userId, setUserId] = useState<string | null>(null);
  // Mobile drawer state. Desktop ignores this (sidebar is always visible
  // at md+ via the `hidden md:flex` wrapper below).
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (active) setUserId(user?.id ?? null);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen w-full flex-col" data-testid="app-shell">
      <MaintenanceBanner orgId={orgId} currentUserId={userId} />
      <PendingRatesBanner orgId={orgId} />
      <div className="flex flex-1">
        {/* Desktop sidebar — hidden on small viewports. */}
        <div className="hidden md:flex">
          <Sidebar />
        </div>

        {/* Mobile drawer overlay — clicking the backdrop dismisses. */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          >
            <div className="absolute left-0 top-0 h-full" onClick={(e) => e.stopPropagation()}>
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </div>
          </div>
        )}

        <main className="flex flex-1 min-w-0 flex-col overflow-auto">
          {/* Mobile-only header with hamburger + ledger pill. Desktop keeps
              the pill in the content area (see below) so the existing layout
              is preserved. */}
          <header className="flex h-14 items-center justify-between border-b border-border bg-background px-4 md:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="-ml-2 p-2"
            >
              <Menu className="h-5 w-5" />
            </button>
            <LedgerStatusPill />
          </header>

          <div className="flex-1 px-4 py-6 md:px-8 md:py-7">
            <div className="mb-4 hidden md:flex justify-end">
              <LedgerStatusPill />
            </div>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
