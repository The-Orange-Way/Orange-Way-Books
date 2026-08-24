import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  CaptchaWidget,
  CAPTCHA_REQUIRED,
  type TurnstileInstance,
} from '@/components/auth/CaptchaWidget';

// Onboarding v2 creates accounts through signInWithOtp({ shouldCreateUser:
// true }), so those users never get a Supabase password. Password sign-in is
// the only door this page had, which locked every one of them out on their
// second visit. The sibling app shipped that exact defect and it was raised
// as a P0 (DL-0708); this is the same remedy, adapted.
//
// Adapted, not copied: the sibling REPLACED its password form, because it
// could branch on a flag and had no password users to strand. Here the code
// path is additive and the password path keeps its behaviour. Two reasons.
// Accounts predating v2 still have a password and nothing else would let them
// in, and six e2e specs sign in through input[type="password"] on this page
// (see tests/e2e/lib/auth.ts and the /login render assertion in the full
// suite). The default view gains one text link; what those specs depend on is
// that the password field is still here and that the form still offers exactly
// one submit control, and both hold.
type OtpStage = 'address' | 'code';

// Matches the onboarding code input, which is capped at six digits. Auth must
// be configured to issue codes of the same length or the two disagree.
const OTP_LENGTH = 6;

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [otpMode, setOtpMode] = useState(false);
  const [otpStage, setOtpStage] = useState<OtpStage>('address');
  const [otpToken, setOtpToken] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendLocked, setResendLocked] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileInstance | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  // A captcha token is single use: Auth spends it on the request whether that
  // request succeeded or failed. Clear it and reset the widget after every
  // attempt so the next one can acquire a fresh token. Without this a mistyped
  // password would leave the form permanently unsubmittable, and "Resend code"
  // could never obtain the token its own send requires.
  const resetCaptcha = () => {
    setCaptchaToken(null);
    captchaRef.current?.reset();
  };

  // The submit controls are already disabled without a token, so this is the
  // belt to that braces: it keeps a programmatic submit (Enter in a field, a
  // test, a password manager) from firing a request Auth will only reject.
  const captchaMissing = () => {
    if (!CAPTCHA_REQUIRED || captchaToken) return false;
    toast({
      title: 'Complete the challenge',
      description: 'Please complete the captcha challenge before continuing.',
      variant: 'destructive',
    });
    return true;
  };

  const handleLogin = async () => {
    if (captchaMissing()) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken: captchaToken ?? undefined },
    });
    resetCaptcha();
    setLoading(false);
    if (error) {
      // Intentionally generic: Supabase's raw error distinguishes "user not
      // found" from "wrong password", which enables account enumeration.
      // We log the specific reason for the developer; the user sees the
      // same message either way.
      console.warn('[Login] signIn rejected:', error.message);
      toast({
        title: 'Login failed',
        description: 'Invalid email or password.',
        variant: 'destructive',
      });
    } else {
      // App now lives under /app/*; / is the public landing page.
      navigate('/app');
    }
  };

  const handleSendCode = async () => {
    if (!email) {
      toast({
        title: 'Enter your email',
        description: 'Type the email address on your account, then click "Send code" again.',
        variant: 'destructive',
      });
      return;
    }
    if (captchaMissing()) return;
    setOtpLoading(true);
    // shouldCreateUser stays false on every sign-in path. The signup flow is
    // the only place allowed to bring an account into existence; if this were
    // true, a typo here would silently register a new empty account instead
    // of failing.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, captchaToken: captchaToken ?? undefined },
    });
    setOtpLoading(false);
    resetCaptcha();
    if (error) {
      // Same reasoning as handleResetPassword below: the outcome is reported
      // identically whether or not an account exists, so this page cannot be
      // used to test whether an address is registered. The developer gets the
      // real reason in the console.
      console.warn('[Login] OTP send rejected:', error.message);
    }
    setOtpStage('code');
    setOtpToken('');
    // Cheap double-send guard. The provider rate limits too, but its error
    // arrives after the mail has already been queued.
    setResendLocked(true);
    setTimeout(() => setResendLocked(false), 5000);
    toast({
      title: 'Check your email',
      description: `If an account exists for that address we've sent a ${OTP_LENGTH}-digit code.`,
    });
  };

  const handleVerifyCode = async () => {
    setOtpLoading(true);
    // No captchaToken here on purpose: Auth does not challenge the verify
    // step, and the send above already spent the one the widget issued. See
    // the table in CaptchaWidget.
    //
    // type 'email' is the code-in-the-body variant. 'magiclink' is the one
    // that only ever arrives as a clickable URL, which is what we are
    // avoiding. Same choice the onboarding step makes.
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: otpToken,
      type: 'email',
    });
    setOtpLoading(false);
    if (error || !data.session) {
      console.warn('[Login] OTP verify rejected:', error?.message);
      toast({
        title: 'Login failed',
        description: 'That code did not work. It may have expired.',
        variant: 'destructive',
      });
      return;
    }
    navigate('/app');
  };

  const handleResetPassword = async () => {
    if (!email) {
      toast({
        title: 'Enter your email',
        description: 'Type the email address on your account, then click "Reset password" again.',
        variant: 'destructive',
      });
      return;
    }
    if (captchaMissing()) return;
    setResetLoading(true);
    // Supabase's resetPasswordForEmail() is safe to show identically for
    // existing and non-existing addresses: the provider silently no-ops on
    // unknown emails. So we always display the same success toast.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
      captchaToken: captchaToken ?? undefined,
    });
    resetCaptcha();
    setResetLoading(false);
    setResetMode(false);
    toast({
      title: 'Check your email',
      description: "If an account exists for that address we've sent a reset link.",
    });
  };

  const leaveOtpMode = () => {
    setOtpMode(false);
    setOtpStage('address');
    setOtpToken('');
    // Leaving the code path abandons whatever token is in hand, so drop it
    // rather than letting a stale one survive into the next attempt.
    resetCaptcha();
  };

  // One submit handler so the Enter key does the same thing as the visible
  // button in every mode. Only the password button is type="submit"; the
  // others are plain buttons, which keeps a single submit control on the
  // default form for the e2e sign-in helper to find.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (resetMode) {
      void handleResetPassword();
      return;
    }
    if (otpMode) {
      if (otpStage === 'address') {
        void handleSendCode();
        return;
      }
      // Same guard the Sign In button carries. Enter on a short code would
      // otherwise spend a verify attempt that can only fail.
      if (otpToken.length < OTP_LENGTH) return;
      void handleVerifyCode();
      return;
    }
    void handleLogin();
  };

  const heading = resetMode
    ? 'Reset your password'
    : otpMode
      ? 'Sign in with a code'
      : 'Sign in to your account';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2 mb-2">
            <img src="/icon-192.png" alt="" className="w-10 h-10 rounded-lg" />
            <h1 className="text-2xl font-bold text-foreground">Orange Way Books</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Zero-knowledge accounting for Bitcoin businesses
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-6">
            <Lock className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-card-foreground">{heading}</h2>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {otpStage === 'code' && otpMode ? (
              <div className="space-y-2">
                <Label htmlFor="otp-code">Code</Label>
                <p className="text-sm text-muted-foreground">
                  We sent a {OTP_LENGTH}-digit code to {email}. Enter it below.
                </p>
                <Input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={otpToken}
                  onChange={(e) =>
                    setOtpToken(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))
                  }
                  required
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            )}
            {!resetMode && !otpMode && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    onClick={() => setResetMode(true)}
                    className="text-xs text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            )}
            {/* Mounted on every mode, not just the code path. All four sending
                calls this page can make are challenged, "Resend code"
                included, and the widget renders nothing when no site key is
                configured. */}
            <CaptchaWidget ref={captchaRef} onToken={setCaptchaToken} />
            {resetMode ? (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                  disabled={resetLoading || (CAPTCHA_REQUIRED && !captchaToken)}
                  onClick={handleResetPassword}
                >
                  {resetLoading ? 'Sending…' : 'Send reset link'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => setResetMode(false)}
                >
                  Back to sign in
                </Button>
              </div>
            ) : otpMode ? (
              <div className="flex flex-col gap-2">
                {otpStage === 'address' ? (
                  <Button
                    type="button"
                    className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                    disabled={otpLoading || (CAPTCHA_REQUIRED && !captchaToken)}
                    onClick={handleSendCode}
                  >
                    {otpLoading ? 'Sending…' : 'Send code'}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                      disabled={otpLoading || otpToken.length < OTP_LENGTH}
                      onClick={handleVerifyCode}
                    >
                      {otpLoading ? 'Signing in…' : 'Sign In'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={otpLoading || resendLocked || (CAPTCHA_REQUIRED && !captchaToken)}
                      onClick={handleSendCode}
                    >
                      {resendLocked ? 'Resend code in a moment' : 'Resend code'}
                    </Button>
                  </>
                )}
                <Button type="button" variant="outline" className="w-full" onClick={leaveOtpMode}>
                  Back to password sign in
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                  disabled={loading || (CAPTCHA_REQUIRED && !captchaToken)}
                >
                  {loading ? 'Signing in…' : 'Sign In'}
                </Button>
                <button
                  type="button"
                  onClick={() => setOtpMode(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Email me a sign-in code instead
                </button>
              </div>
            )}
          </form>

          {!resetMode && !otpMode && (
            <p className="text-center text-sm text-muted-foreground mt-4">
              Don't have an account?{' '}
              <Link to="/signup" className="text-primary hover:underline font-medium">
                Sign up
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
