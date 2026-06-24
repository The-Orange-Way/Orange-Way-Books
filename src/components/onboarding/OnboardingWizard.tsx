import { useState } from 'react';
import { captureException } from '@/lib/observability/sentry';
import StepVaultPassword from './StepVaultPassword';
import StepOrganization from './StepOrganization';
import StepReporting from './StepReporting';
import StepCalendar from './StepCalendar';
import { Progress } from '@/components/ui/progress';
import { Bitcoin, Lock, Building2, BarChart3, Calendar } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { useVault } from '@/context/VaultContext';
import { encryptOrgSettings } from '@/lib/crypto-fields';
import { initChartOfAccounts } from '@/lib/init-chart-of-accounts';
import type { BitcoinDisplay } from '@/types';
import type { User } from '@supabase/supabase-js';

const steps = [
  { label: 'Vault', icon: Lock },
  { label: 'Organization', icon: Building2 },
  { label: 'Reporting', icon: BarChart3 },
  { label: 'Calendar', icon: Calendar },
];

interface OnboardingWizardProps {
  userId: string;
  onComplete: () => void;
}

export default function OnboardingWizard({ userId, onComplete }: OnboardingWizardProps) {
  const { encryptText } = useVault();
  const [currentStep, setCurrentStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [progressDetail, setProgressDetail] = useState<string>('');
  const [orgData, setOrgData] = useState<{
    name: string;
    primaryCurrency: string;
    bitcoinDisplay: BitcoinDisplay;
  }>({
    name: '',
    primaryCurrency: 'BTC',
    bitcoinDisplay: 'btc',
  });
  const [reportingData, setReportingData] = useState<{
    secondaryCurrency: string;
    secondaryBitcoinDisplay: BitcoinDisplay;
    numberFormat: 'US' | 'EU';
    dateFormat: string;
    timeFormat: string;
    timezone: string;
  }>({
    secondaryCurrency: 'none',
    secondaryBitcoinDisplay: 'btc',
    numberFormat: 'US',
    dateFormat: 'MM-DD-YYYY',
    timeFormat: '12h',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [calendarData, setCalendarData] = useState({
    dateFormat: 'MM-DD-YYYY',
    fiscalYearStart: 'january',
  });
  const [vaultVerifier, setVaultVerifier] = useState<string | null>(null);
  const [vaultSalt, setVaultSalt] = useState<string | null>(null);
  const [vaultKeyVersion, setVaultKeyVersion] = useState<number>(1);
  const [encMekCiphertext, setEncMekCiphertext] = useState<string | null>(null);
  const [recoveryCiphertext, setRecoveryCiphertext] = useState<string | null>(null);

  const progress = ((currentStep + 1) / steps.length) * 100;

  const waitForAuthenticatedUser = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.id === userId) {
      return session.user;
    }

    return await new Promise<User>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error('Authentication is still loading. Please wait a moment and try again.'));
      }, 5000);

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (nextSession?.user?.id === userId) {
          window.clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve(nextSession.user);
        }
      });
    });
  };

  const handleFinish = async () => {
    setSaving(true);
    setProgressDetail('');
    try {
      setProgressMessage('🔐 Verifying your identity…');
      const user = await waitForAuthenticatedUser();
      const orgId = crypto.randomUUID();

      // 1. Insert organization (encrypt name for ZKA)
      setProgressMessage('🔐 Encrypting your organization in your browser (server can’t read it)…');
      const encOrgName = await encryptText(orgData.name);
      const { error: orgError } = await supabase
        .from('organizations')
        .insert({ id: orgId, name: encOrgName, key_version: 2 });
      if (orgError) throw orgError;

      // 2. Ensure org_member row exists for the creator.
      //
      // A post-insert trigger on organizations (20260417000400_data_integrity_triggers.sql)
      // already inserts the caller as OWNER, so this upsert is idempotent — we
      // keep it to guarantee the row regardless of whether the trigger is
      // deployed yet.
      const { error: memberError } = await supabase
        .from('org_members')
        .upsert(
          { org_id: orgId, user_id: user.id, role: 'OWNER' },
          { onConflict: 'user_id,org_id' },
        );
      if (memberError) throw memberError;

      // 3. Insert org_settings
      setProgressMessage('🛡️ Sealing your books under zero-knowledge encryption…');
      const secondaryCurrency =
        reportingData.secondaryCurrency === 'none' ? null : reportingData.secondaryCurrency;
      const bitcoinDisplay =
        orgData.primaryCurrency === 'BTC'
          ? orgData.bitcoinDisplay
          : secondaryCurrency === 'BTC'
            ? reportingData.secondaryBitcoinDisplay
            : 'sats';

      const encSettings = await encryptOrgSettings(
        {
          primary_currency: orgData.primaryCurrency,
          secondary_currency: secondaryCurrency,
          bitcoin_display: bitcoinDisplay,
          fiscal_year_type: null,
          fiscal_start_month: null,
          date_format: reportingData.dateFormat || calendarData.dateFormat,
          time_format: reportingData.timeFormat || null,
          number_format: reportingData.numberFormat === 'EU' ? 'eu' : 'us',
          timezone: reportingData.timezone || null,
        },
        encryptText,
      );
      const { error: settingsError } = await supabase.from('org_settings').insert({
        org_id: orgId,
        ...encSettings,
      } as any);
      if (settingsError) throw settingsError;

      // 4. Save vault verifier + per-org salt. vault_key_version stamps
      // the active strategy (currently 1 → deriveVaultV1Kek).
      if (vaultVerifier) {
        const { error: verifierError } = await (supabase as any)
          .from('org_settings')
          .update({
            vault_verifier: vaultVerifier,
            vault_salt: vaultSalt,
            vault_key_version: vaultKeyVersion,
            enc_mek_ciphertext: encMekCiphertext,
            recovery_ciphertext: recoveryCiphertext,
          })
          .eq('org_id', orgId);
        if (verifierError) throw verifierError;
      }

      // 5. Seed chart of accounts in Postgres. Encrypting 43 accounts with
      // Argon2id+AES-GCM takes ~30s on a typical laptop. Blocking the wizard
      // on that wait left customers staring at a spinner before they could
      // touch the app. Now: mark `organizations.ledger_status='provisioning'`
      // synchronously so the dashboard's LedgerStatusPill picks up the
      // in-progress state, then dispatch `initChartOfAccounts` as a
      // fire-and-forget IIFE and call `onComplete()` immediately. The
      // user lands on the dashboard while encryption continues in the
      // background; the IIFE updates `ledger_status='ready'|'failed'` when
      // it finishes, and the pill rerenders. Sonner's toast surface is
      // root-mounted, so the progress toast survives the navigation.
      setProgressMessage('📚 Setting up your chart of accounts…');
      await (supabase as any)
        .from('organizations')
        .update({ ledger_status: 'provisioning', ledger_status_error: null })
        .eq('id', orgId);

      const coaToast = toast.loading('📊 Encrypting accounts…', {
        description: 'Server only sees ciphertext. Safe to keep using the app.',
        duration: Infinity,
      });

      // Fire-and-forget. The wizard unmounts after onComplete(); this IIFE
      // captures `encryptText`, `orgId`, and `coaToast` in its closure.
      // `encryptText` keeps working because the underlying MEK lives in
      // VaultContext (a top-level provider that survives the wizard
      // unmount). If the customer manually locks the vault while seeding
      // is in flight, encryptText throws → catch arm marks
      // `ledger_status='failed'` → dashboard pill shows "Retry".
      // No re-throw, no setState on unmounted wizard, no awaited promise
      // bubbling into handleFinish's try/catch.
      void (async () => {
        try {
          await initChartOfAccounts(orgId, encryptText, (done, total) => {
            toast.loading(`📊 Encrypting accounts (${done}/${total})…`, {
              id: coaToast,
              description: 'Server only sees ciphertext.',
              duration: Infinity,
            });
          });
          await (supabase as any)
            .from('organizations')
            .update({ ledger_status: 'ready', ledger_status_error: null })
            .eq('id', orgId);
          toast.success('✅ Chart of accounts ready', {
            id: coaToast,
            duration: 3000,
          });
        } catch (coaErr) {
          const errMsg = coaErr instanceof Error ? coaErr.message : String(coaErr);
          console.error('Chart of accounts seeding failed:', coaErr);
          captureException(coaErr, { tags: { source: 'onboarding-coa-seed' } });
          // Mark the org as failed so the dashboard's LedgerStatusPill can
          // surface a "Retry" button instead of a perpetual spinner.
          await (supabase as any)
            .from('organizations')
            .update({ ledger_status: 'failed', ledger_status_error: errMsg })
            .eq('id', orgId)
            .then(
              () => undefined,
              () => undefined,
            );
          toast.error('Chart of accounts setup hit an issue', {
            id: coaToast,
            description: errMsg || 'You can retry from the dashboard.',
            duration: 10000,
          });
        }
      })();

      setProgressMessage('✅ Done — your data is encrypted before it ever leaves your browser');
      setProgressDetail('');
      toast.success('Organization created successfully!');
      onComplete();
    } catch (err) {
      console.error('Onboarding failed:', err);

      const message =
        err instanceof Error ? err.message : 'Failed to create organization. Please try again.';

      toast.error(message);
    } finally {
      setSaving(false);
      setProgressMessage('');
      setProgressDetail('');
    }
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      handleFinish();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep((s) => s - 1);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
            <Bitcoin className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-lg font-bold text-foreground">Set Up Orange Way Books</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Step {currentStep + 1} of {steps.length}
          </p>
        </div>

        <div className="flex items-center gap-2 mb-2">
          {steps.map((step, i) => (
            <div key={step.label} className="flex-1 flex flex-col items-center gap-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                  i <= currentStep
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <step.icon className="w-4 h-4" />
              </div>
              <span
                className={`text-[10px] font-medium ${i <= currentStep ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
        <Progress value={progress} className="h-1.5 mb-6" />

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm overflow-hidden">
          {currentStep === 0 && (
            <StepVaultPassword
              onNext={(result) => {
                setVaultVerifier(result.verifier);
                setVaultSalt(result.vaultSalt);
                setVaultKeyVersion(result.vaultKeyVersion);
                setEncMekCiphertext(result.encMekCiphertext);
                setRecoveryCiphertext(result.recoveryCiphertext);
                handleNext();
              }}
            />
          )}
          {currentStep === 1 && (
            <StepOrganization
              data={orgData}
              onChange={setOrgData}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {currentStep === 2 && (
            <StepReporting
              data={reportingData}
              onChange={setReportingData}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {currentStep === 3 && (
            <StepCalendar
              data={calendarData}
              onChange={setCalendarData}
              onNext={handleNext}
              onBack={handleBack}
              saving={saving}
              progressMessage={progressMessage}
              progressDetail={progressDetail}
            />
          )}
        </div>
      </div>
    </div>
  );
}
