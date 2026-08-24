/**
 * The one captcha surface for every auth path in the app.
 *
 * It exists as a shared module rather than an inline block per form because a
 * copy per form is how a form ends up without one. Auth applies captcha at the
 * project level: it is one switch for the whole project, evaluated before
 * anything else, so it is either on for every challenged endpoint or off for
 * all of them. A single form that sends no token is therefore not a degraded
 * experience on that form, it is that path failing outright.
 *
 * Which calls need a token, and which must not have one:
 *
 *   signUp                  yes
 *   signInWithPassword      yes
 *   signInWithOtp           yes
 *   resetPasswordForEmail   yes
 *   verifyOtp               NO. Auth does not challenge the verify step, and
 *                           the token from the send is already spent, so
 *                           requiring one here breaks the second half of a
 *                           sign in that is otherwise working.
 *   updateUser              NO. It authenticates with the session bearer
 *                           token and is not challenged.
 *
 * A token is single use. Auth spends it on the request whether that request
 * succeeded or failed, so every caller resets the widget after every attempt.
 * Resetting only on success is what leaves a form stuck after one typo.
 */
import { forwardRef } from 'react';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';

// Build-time site key. Browser-safe by design: it is handed to the captcha
// vendor as-is. An unset value disables the widget everywhere, which is what
// keeps local development and the end-to-end suites running without a
// challenge to solve.
//
// This is a DIFFERENT switch from captcha protection in the Supabase Auth
// dashboard. The dashboard decides whether Auth REQUIRES a token; this key
// decides whether the browser can PRODUCE one. The two must agree. Auth
// evaluates captcha before anything else and applies it to every endpoint at
// once, so a project with the dashboard switch on and no site key here fails
// every sign-in, reset and send, not just some of them.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

// True when this build can produce a token. Callers use it to require a token
// before submitting, so the guard is one import rather than a copy per form.
export const CAPTCHA_REQUIRED = !!TURNSTILE_SITE_KEY;

export type { TurnstileInstance };

interface CaptchaWidgetProps {
  // Receives a fresh token, or null when it expires or errors.
  onToken: (token: string | null) => void;
}

// Renders nothing when no site key is configured, so a caller can mount it
// unconditionally and let CAPTCHA_REQUIRED drive the submit guard.
export const CaptchaWidget = forwardRef<TurnstileInstance, CaptchaWidgetProps>(
  function CaptchaWidget({ onToken }, ref) {
    if (!TURNSTILE_SITE_KEY) return null;
    return (
      <div className="flex justify-center">
        <Turnstile
          ref={ref}
          siteKey={TURNSTILE_SITE_KEY}
          onSuccess={(token) => onToken(token)}
          onExpire={() => onToken(null)}
          onError={() => onToken(null)}
        />
      </div>
    );
  },
);
