import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, Bitcoin } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// Site key is browser-safe by design (sent to hCaptcha as-is). Stored as
// VITE_HCAPTCHA_SITE_KEY at build time; missing value disables the widget
// gracefully (signup still works for local dev where you don't want the
// captcha challenge in the loop).
const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined;

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<HCaptcha>(null);
  const { toast } = useToast();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // Require a fresh captcha token whenever the widget is in play.
    if (HCAPTCHA_SITE_KEY && !captchaToken) {
      setLoading(false);
      toast({
        title: 'Captcha required',
        description: 'Please complete the captcha challenge before continuing.',
        variant: 'destructive',
      });
      return;
    }

    // D7 beta gate, short-circuit before Supabase signup if the email
    // isn't on the allowlist. RPC is SECURITY DEFINER, returns boolean,
    // doesn't leak the list. Fails CLOSED: any error denies signup.
    try {
      const { data: allowed, error: rpcError } = await supabase.rpc(
        'is_email_in_beta_allowlist' as never,
        { p_email: email } as never,
      );
      if (rpcError || !allowed) {
        setLoading(false);
        captchaRef.current?.resetCaptcha();
        setCaptchaToken(null);
        toast({
          title: 'Private beta',
          description:
            'Orange Way Books is currently in private beta. Email hello@orangeway.app to request access.',
          variant: 'destructive',
        });
        return;
      }
    } catch {
      setLoading(false);
      captchaRef.current?.resetCaptcha();
      setCaptchaToken(null);
      toast({
        title: 'Signup unavailable',
        description: 'Could not verify beta access. Please try again later.',
        variant: 'destructive',
      });
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        // Supabase verifies this against the configured hCaptcha secret on
        // the server side. captchaToken is single-use and tied to this signup.
        captchaToken: captchaToken ?? undefined,
      },
    });
    setLoading(false);
    // Always reset the widget after a submit, success or fail, tokens
    // are single-use and must not be replayed if the user retries.
    captchaRef.current?.resetCaptcha();
    setCaptchaToken(null);

    if (error) {
      toast({ title: 'Signup failed', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Check your email', description: 'We sent you a confirmation link.' });
      // Mark the allowlist row as having signed up (best-effort, non-blocking).
      void supabase
        .from('beta_allowlist')
        .update({ signed_up_at: new Date().toISOString() })
        .eq('email', email.toLowerCase());
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Bitcoin className="w-6 h-6 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">Orange Way Books</h1>
          </div>
          <p className="text-muted-foreground text-sm">Create your secure account</p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-6">
            <Lock className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-card-foreground">Create account</h2>
          </div>

          <form onSubmit={handleSignup} className="space-y-4">
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
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {HCAPTCHA_SITE_KEY && (
              <div className="flex justify-center">
                <HCaptcha
                  ref={captchaRef}
                  sitekey={HCAPTCHA_SITE_KEY}
                  onVerify={(token) => setCaptchaToken(token)}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                />
              </div>
            )}
            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
              disabled={loading || (!!HCAPTCHA_SITE_KEY && !captchaToken)}
            >
              {loading ? 'Creating account…' : 'Create Account'}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground mt-4">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
