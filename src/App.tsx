import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate, useLocation, Link } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VaultProvider, useVault } from '@/context/VaultContext';
import { supabase } from '@/lib/supabase';
import type { Session } from '@supabase/supabase-js';

import AppShell from '@/components/layout/AppShell';
import VaultUnlockScreen from '@/components/layout/VaultUnlockScreen';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';
import LoginPage from '@/components/auth/LoginPage';
import ResetPasswordPage from '@/pages/ResetPasswordPage';
import SignupPage from '@/components/auth/SignupPage';
import NotFound from '@/pages/NotFound';

import Dashboard from '@/pages/Dashboard';
import Accounts from '@/pages/Accounts';
import Transactions from '@/pages/Transactions';
import JournalEntries from '@/pages/JournalEntries';
import Reports from '@/pages/Reports';
import Admin from '@/pages/Admin';
import AccountRegister from '@/pages/AccountRegister';
import Payments from '@/pages/Payments';
import Invoices from '@/pages/Invoices';
import PublicInvoice from '@/pages/PublicInvoice';
import Connections from '@/pages/Connections';
import ContactsPage from '@/pages/Contacts';
import CashFlowPage from '@/pages/CashFlow';
import Billing from '@/pages/Billing';
import Flash from '@/pages/admin/flash/Flash';
import FlashCallback from '@/pages/admin/flash/FlashCallback';
import ChangeVaultPassword from '@/pages/settings/ChangeVaultPassword';
import RecoveryCode from '@/pages/settings/RecoveryCode';
import MasterRecovery from '@/pages/settings/MasterRecovery';
import OpeningBalances from '@/pages/settings/OpeningBalances';
import Periods from '@/pages/settings/Periods';
import BulkReceiptLinker from '@/pages/settings/BulkReceiptLinker';
import ImportFromOr from '@/pages/settings/ImportFromOr';
import ImportJobs from '@/pages/settings/ImportJobs';
import DemoData from '@/pages/settings/DemoData';
import Security from '@/pages/settings/Security';

// Public marketing surface — readable by AI crawlers and search engines.
import MarketingLayout from '@/marketing/MarketingLayout';
import Landing from '@/marketing/pages/Landing';
import Features from '@/marketing/pages/Features';
import SecurityPage from '@/marketing/pages/Security';
import Pricing from '@/marketing/pages/Pricing';
import Faq from '@/marketing/pages/Faq';
import About from '@/marketing/pages/About';
import Contact from '@/marketing/pages/Contact';
import CompareHub from '@/marketing/pages/CompareHub';
import CompareStub from '@/marketing/pages/CompareStub';
import DocsIndex from '@/marketing/pages/DocsIndex';
import AiAgentsPage from '@/marketing/pages/AiAgents';
import Privacy from '@/marketing/pages/Privacy';

const queryClient = new QueryClient();

/**
 * Root router. Public marketing pages render unconditionally so AI crawlers
 * and unauthenticated visitors see real content. The authenticated app
 * lives under /app/* and is gated by AuthGate.
 */
function RootRouter() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;

    // PostHog identify is intentionally NOT called. Tying the analytics
    // distinct_id to the auth.uid would contradict the "no personally
    // identifying telemetry" stance. Events stay anonymous per-tab even
    // when telemetry is enabled (SaaS builds); self-hosted builds skip
    // PostHog initialization entirely. See src/main.tsx.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isActive) return;
      setSession(session);
      setSessionLoaded(true);
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!isActive) return;
      setSession(session);
      setSessionLoaded(true);
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <Routes>
      {/* Public marketing routes — always available, no auth required. */}
      <Route element={<MarketingLayout session={session} />}>
        {/* Authenticated users hitting `/` (e.g. after email confirmation,
            which lands them at the Site URL with the auth hash) get sent
            straight to the app. Unauthenticated users see Landing. */}
        <Route path="/" element={session ? <Navigate to="/app" replace /> : <Landing />} />
        <Route path="/features" element={<Features />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/faq" element={<Faq />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/compare" element={<CompareHub />} />
        <Route path="/compare/:slug" element={<CompareStub />} />
        <Route path="/docs" element={<DocsIndex />} />
        <Route path="/ai" element={<AiAgentsPage />} />
        <Route path="/privacy" element={<Privacy />} />
      </Route>

      {/* Auth pages */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/signup" element={<SignupPage />} />

      {/* Public hosted invoice view — Bitwarden Send pattern (key in URL fragment) */}
      <Route path="/i/:urlId" element={<PublicInvoice />} />

      {/* Authenticated app */}
      <Route path="/app/*" element={<AuthGate session={session} sessionLoaded={sessionLoaded} />} />

      {/* Backward-compatibility: old top-level app paths redirect to /app/*. */}
      <Route path="/accounts" element={<Navigate to="/app/accounts" replace />} />
      <Route path="/transactions" element={<Navigate to="/app/transactions" replace />} />
      <Route path="/journal" element={<Navigate to="/app/journal" replace />} />
      <Route path="/reports" element={<Navigate to="/app/reports" replace />} />
      <Route path="/payments" element={<Navigate to="/app/payments" replace />} />
      <Route path="/connections" element={<Navigate to="/app/connections" replace />} />
      <Route path="/admin" element={<Navigate to="/app/admin" replace />} />
      <Route path="/settings/security" element={<Navigate to="/app/settings/security" replace />} />
      <Route
        path="/settings/change-password"
        element={<Navigate to="/app/settings/change-password" replace />}
      />
      <Route path="/settings/roles" element={<Navigate to="/app/admin?tab=roles" replace />} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function AuthGate({ session, sessionLoaded }: { session: Session | null; sessionLoaded: boolean }) {
  if (!sessionLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    // Authenticated routes require a session — bounce to login and remember
    // the originally-requested path so we can return after sign-in.
    return <Navigate to="/login" replace />;
  }

  return <VaultGate session={session} />;
}

function VaultGate({ session }: { session: Session }) {
  const { isUnlocked } = useVault();
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    let isActive = true;

    const checkMembership = async () => {
      // Fetch ALL memberships ordered deterministically so we pick the same
      // org every time (and can honor the user's active-org selection).
      const { data, error } = await supabase
        .from('org_members')
        .select('org_id, joined_at')
        .eq('user_id', session.user.id)
        .order('joined_at', { ascending: true });

      if (!isActive) return;

      if (error) {
        console.error('Failed to check onboarding status:', error);
        setNeedsOnboarding(true);
        return;
      }

      const memberships = data ?? [];
      if (memberships.length === 0) {
        setNeedsOnboarding(true);
        return;
      }

      // Honor stored active-org id only if the user is actually a member
      // of that org; otherwise fall back to the oldest membership and
      // persist it so every subsequent call uses the same org.
      const stored = localStorage.getItem('orangewaybooks.active_org');
      const storedIsValid = stored && memberships.some((m: any) => m.org_id === stored);
      if (!storedIsValid) {
        localStorage.setItem('orangewaybooks.active_org', memberships[0].org_id);
      }

      setNeedsOnboarding(false);
    };

    void checkMembership();

    return () => {
      isActive = false;
    };
  }, [session.user.id]);

  // Still checking onboarding status
  if (needsOnboarding === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // New user: onboarding wizard (Step 0 = vault password creation)
  if (needsOnboarding) {
    return (
      <OnboardingWizard userId={session.user.id} onComplete={() => setNeedsOnboarding(false)} />
    );
  }

  // Returning user: vault unlock screen
  if (!isUnlocked) {
    return <VaultUnlockScreen />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* Authenticated app — mounted under /app/* by RootRouter. */}
        <Route index element={<Dashboard />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="journal" element={<JournalEntries />} />
        <Route path="reports" element={<Reports />} />
        <Route path="payments" element={<Payments />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="connections" element={<Connections />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="cash-flow" element={<CashFlowPage />} />
        <Route path="billing" element={<Billing />} />
        <Route path="admin" element={<Admin />} />
        <Route path="admin/flash" element={<Flash />} />
        <Route path="admin/flash/callback" element={<FlashCallback />} />
        <Route path="accounts/:accountId/register" element={<AccountRegister />} />
        <Route path="settings/security" element={<Security />} />
        <Route path="settings/change-password" element={<ChangeVaultPassword />} />
        <Route path="settings/recovery-code" element={<RecoveryCode />} />
        <Route path="settings/master-recovery" element={<MasterRecovery />} />
        <Route path="settings/opening-balances" element={<OpeningBalances />} />
        <Route path="settings/periods" element={<Periods />} />
        <Route path="settings/bulk-receipt-linker" element={<BulkReceiptLinker />} />
        <Route path="settings/import-from-or" element={<ImportFromOr />} />
        <Route path="settings/import-jobs" element={<ImportJobs />} />
        <Route path="settings/demo-data" element={<DemoData />} />
        <Route path="settings/roles" element={<Navigate to="/app/admin?tab=roles" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

// One-time analytics-notice banner shown once per browser, dismissed via
// localStorage (UI state, not tracking — exempt from consent under
// GDPR Article 6 because it's strictly necessary for the banner not to
// nag). Same wording shipped across every Orange Way Books-family surface.
function AnalyticsNotice() {
  const location = useLocation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Marketing pages only. The signed-in app, the auth screens, and
    // public-invoice share links are all transactional surfaces where
    // the notice is clutter (and on /signup it competes for attention
    // with the captcha widget). Re-evaluate on every SPA route change
    // so navigating from marketing → /app hides the banner.
    const p = location.pathname;
    const isAppOrAuth =
      p.startsWith('/app') ||
      p.startsWith('/login') ||
      p.startsWith('/signup') ||
      p.startsWith('/reset-password') ||
      p.startsWith('/i/');
    if (isAppOrAuth) {
      setShow(false);
      return;
    }
    setShow(localStorage.getItem('orangewaybooks.notice_dismissed') !== '1');
  }, [location.pathname]);
  useEffect(() => {
    if (!show) return;
    const onScroll = () => {
      if (window.scrollY > 600) {
        localStorage.setItem('orangewaybooks.notice_dismissed', '1');
        setShow(false);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [show]);
  if (!show) return null;
  const dismiss = () => {
    localStorage.setItem('orangewaybooks.notice_dismissed', '1');
    setShow(false);
  };
  return (
    <div
      style={{
        position: 'fixed',
        left: 20,
        bottom: 20,
        zIndex: 9999,
        maxWidth: 320,
        padding: '14px 16px',
        background: '#0F172A',
        color: '#FAFAF9',
        borderRadius: 14,
        boxShadow: '0 12px 32px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.18)',
        font: "12.5px/1.5 -apple-system, 'Plus Jakarta Sans', system-ui, sans-serif",
        animation: 'bbnotin 260ms cubic-bezier(0.16,1,0.3,1)',
      }}
      role="region"
      aria-label="Analytics notice"
    >
      <style>{`@keyframes bbnotin{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          background: 'transparent',
          color: '#94A3B8',
          border: 0,
          fontSize: 18,
          lineHeight: 1,
          padding: '4px 6px',
          cursor: 'pointer',
          borderRadius: 6,
        }}
      >
        ×
      </button>
      <p style={{ margin: '0 0 10px 0', paddingRight: 18 }}>
        Anonymous analytics:{' '}
        <strong style={{ color: '#fff' }}>no tracking, no profiles, no cookies.</strong> A session
        cookie is set only if you sign in, and is deleted when you sign out.{' '}
        <Link
          to="/privacy"
          onClick={dismiss}
          style={{ color: '#F7931A', textDecoration: 'underline' }}
        >
          Privacy policy
        </Link>
        .
      </p>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: '#F7931A',
          color: '#fff',
          border: 0,
          borderRadius: 8,
          padding: '6px 14px',
          font: 'inherit',
          fontWeight: 600,
          fontSize: 12.5,
          cursor: 'pointer',
        }}
      >
        Got it
      </button>
    </div>
  );
}

const App = () => (
  <HelmetProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <VaultProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <RootRouter />
            <AnalyticsNotice />
          </BrowserRouter>
        </VaultProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </HelmetProvider>
);

export default App;
