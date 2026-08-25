import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import SignupPage from '@/components/auth/SignupPage';
import OnboardingWizardV2 from './OnboardingWizardV2';
import { ONBOARDING_V2_ENABLED } from './onboarding-flow';

/**
 * The /signup front door (DL-0429).
 *
 * The problem this solves: /signup asked for an email and a password and then
 * promised a confirmation link, while the v2 wizard mounted only after a
 * session existed and asked for the same email again as its second step. A new
 * customer typed their address twice and met two different account-creation
 * mechanisms on the way in. This route now opens the wizard itself, so the
 * first question is what to call you, then the email, then the code.
 *
 * Two properties are worth stating because both are easy to lose in a later
 * edit:
 *
 * 1. The session check is a SNAPSHOT taken once on mount, and it deliberately
 *    does not subscribe to auth state. The email step signs the visitor in
 *    partway through the flow, so a guard that watched for a session appearing
 *    would fire on the customer's own sign-in and eject them from their own
 *    signup between step two and step three. The sibling app shipped that
 *    exact defect and the fix there was to decide once and stay decided,
 *    because a mid-flow reload that re-enters vault creation can leave one
 *    account with two vaults, which is not recoverable.
 *
 * 2. With the flag off this component does nothing at all: no session probe,
 *    no spinner, and the same page this route served before, on first paint.
 *    The flag is read at build time, so an unset value is not a runtime
 *    fallback, it is a build that never contained this path.
 */
type Door = 'checking' | 'wizard' | 'signed-in' | 'legacy';

export default function SignupFrontDoor() {
  const navigate = useNavigate();
  const [door, setDoor] = useState<Door>(ONBOARDING_V2_ENABLED ? 'checking' : 'legacy');

  useEffect(() => {
    if (!ONBOARDING_V2_ENABLED) {
      return;
    }

    let isActive = true;

    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!isActive) {
          return;
        }
        // Liveness, not presence. Same test the email step applies: an expired
        // session belongs to somebody who has to sign in again, so it must not
        // be read as "this person already has an account open".
        const session = data.session;
        const live =
          !!session &&
          typeof session.expires_at === 'number' &&
          session.expires_at * 1000 > Date.now();
        setDoor(live ? 'signed-in' : 'wizard');
      })
      .catch(() => {
        // If we cannot establish whether somebody is signed in, we do not put
        // them into a flow that creates a vault. Fall back to the page this
        // route served before, which creates nothing until it is submitted.
        if (isActive) {
          setDoor('legacy');
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  if (door === 'legacy') {
    return <SignupPage />;
  }

  if (door === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (door === 'signed-in') {
    // Already signed in, so this is not a new account. Hand them to the
    // authenticated tree and let the membership check that already lives there
    // choose between onboarding and the dashboard, rather than deciding twice
    // in two places that can disagree.
    return <Navigate to="/app" replace />;
  }

  return <OnboardingWizardV2 onComplete={() => navigate('/app', { replace: true })} />;
}
