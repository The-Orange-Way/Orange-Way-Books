import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, Bitcoin } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
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
    setResetLoading(true);
    // Supabase's resetPasswordForEmail() is safe to show identically for
    // existing and non-existing addresses: the provider silently no-ops on
    // unknown emails. So we always display the same success toast.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
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
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Bitcoin className="w-6 h-6 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">Orange Way Books</h1>
          </div>
          <p className="text-muted-foreground text-sm">Zero-knowledge accounting for Bitcoin businesses</p>
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
            {resetMode ? (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
                  disabled={resetLoading}
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
                disabled={loading}
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
