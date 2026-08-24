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

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileInstance | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  // A captcha token is single use: Auth spends it on the request whether that
  // request succeeded or failed. Clear it and reset the widget after every
  // attempt so the next one can acquire a fresh token. Without this a mistyped
  // password would leave the form permanently unsubmittable.
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
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
            <h2 className="text-lg font-semibold text-card-foreground">
              {resetMode ? 'Reset your password' : 'Sign in to your account'}
            </h2>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
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
            {!resetMode && (
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
            ) : (
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                disabled={loading || (CAPTCHA_REQUIRED && !captchaToken)}
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </Button>
            )}
          </form>

          {!resetMode && (
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
