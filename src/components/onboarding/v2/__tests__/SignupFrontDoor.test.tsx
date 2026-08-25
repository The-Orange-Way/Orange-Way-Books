/**
 * DL-0429: what /signup opens, and the two properties that are easy to lose.
 *
 * These cases are about routing, not about what either destination renders, so
 * both destinations are stubs. What is being pinned here is which one a
 * visitor gets and what the component asked the auth layer on the way.
 *
 * The flag is read once at module scope, so the stub has to be in place before
 * the import. That is the same shape the captcha path tests use.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted because the mock factories below close over these, and the
// factories are hoisted above the file. Reading the calls back afterwards is
// most of the point of two of these cases.
const auth = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: null as { expires_at?: number } | null } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth },
}));

vi.mock('@/components/auth/SignupPage', () => ({
  default: () => <div data-testid="legacy-signup" />,
}));

vi.mock('../OnboardingWizardV2', () => ({
  default: () => <div data-testid="v2-wizard" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderFrontDoor(flagOn: boolean) {
  vi.stubEnv('VITE_ONBOARDING_V2', flagOn ? 'true' : '');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');
  const { default: SignupFrontDoor } = await import('../SignupFrontDoor');
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupFrontDoor />} />
        <Route path="/app/*" element={<div data-testid="app-tree" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function sessionExpiringIn(seconds: number) {
  return { data: { session: { expires_at: Math.floor(Date.now() / 1000) + seconds } } };
}

describe('SignupFrontDoor', () => {
  it('serves the page this route served before when the flag is off, and asks auth nothing', async () => {
    await renderFrontDoor(false);

    expect(await screen.findByTestId('legacy-signup')).toBeInTheDocument();
    // Not a detail. With the flag off this build must behave as though the
    // change had not shipped, which includes making no request on first paint.
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('opens the wizard for a visitor with no session', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });

    await renderFrontDoor(true);

    expect(await screen.findByTestId('v2-wizard')).toBeInTheDocument();
  });

  it('sends an already signed in visitor to the authenticated tree instead', async () => {
    auth.getSession.mockResolvedValueOnce(sessionExpiringIn(3600));

    await renderFrontDoor(true);

    expect(await screen.findByTestId('app-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('v2-wizard')).not.toBeInTheDocument();
  });

  it('treats an expired session as no session, so the test is liveness and not presence', async () => {
    auth.getSession.mockResolvedValueOnce(sessionExpiringIn(-60));

    await renderFrontDoor(true);

    expect(await screen.findByTestId('v2-wizard')).toBeInTheDocument();
  });

  it('decides once and never subscribes, so signing in partway through cannot eject the customer', async () => {
    await renderFrontDoor(true);

    expect(await screen.findByTestId('v2-wizard')).toBeInTheDocument();
    expect(auth.getSession).toHaveBeenCalledTimes(1);
    // The email step signs the visitor in at step two of seven. A guard that
    // watched auth state would fire on that and throw them out of their own
    // signup, and a re-entry into vault creation is the one failure here that
    // cannot be undone. This assertion is the whole reason the check is a
    // snapshot, so it is worth more than the shape of the snapshot itself.
    expect(auth.onAuthStateChange).not.toHaveBeenCalled();
  });

  it('falls back to the page that creates nothing when the session check fails', async () => {
    auth.getSession.mockRejectedValueOnce(new Error('offline'));

    await renderFrontDoor(true);

    // If we cannot tell whether somebody is signed in, we do not put them into
    // a flow that creates a vault.
    expect(await screen.findByTestId('legacy-signup')).toBeInTheDocument();
  });
});
