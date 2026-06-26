import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// Site key is browser-safe by design (sent to the captcha vendor as-is).
// Stored as VITE_TURNSTILE_SITE_KEY at build time; missing value disables
// the widget gracefully (signup still works for local dev where you don't
// want the captcha challenge in the loop).
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileInstance | null>(null);
  const { toast } = useToast();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // Require a fresh captcha token whenever the widget is in play.
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setLoading(false);
      toast({
        title: 'Captcha required',
        description: 'Please complete the captcha challenge before continuing.',
        variant: 'destructive',
      });
      return;
    }

    // D7 beta gate — short-circuit before Supabase signup if the email
    // isn't on the allowlist. RPC is SECURITY DEFINER, returns boolean,
    // doesn't leak the list. Fails CLOSED: any error denies signup.
    try {
      const { data: allowed, error: rpcError } = await supabase.rpc(
        'is_email_in_beta_allowlist' as never,
        { p_email: email } as never,
      );
      if (rpcError || !allowed) {
        setLoading(false);
        captchaRef.current?.reset();
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
      captchaRef.current?.reset();
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
    // Always reset the widget after a submit, success or fail — tokens
    // are single-use and must not be replayed if the user retries.
    captchaRef.current?.reset();
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
            <img src="/icon-192.png" alt="" className="w-10 h-10 rounded-lg" />
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
            {TURNSTILE_SITE_KEY && (
              <div className="flex justify-center">
                <Turnstile
                  ref={captchaRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={(token) => setCaptchaToken(token)}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                />
              </div>
            )}
            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
              disabled={loading || (!!TURNSTILE_SITE_KEY && !captchaToken)}
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
