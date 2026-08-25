/**
 * Every auth path carries a captcha token, and the two that must not carry one
 * still do not.
 *
 * Captcha is a project-level switch in Auth, evaluated before anything else and
 * applied to every challenged endpoint at once. So a form that sends no token
 * does not degrade, it stops working entirely the moment the switch is on. This
 * file pins the wiring per call site rather than trusting that the next person
 * to add an auth form remembers the widget.
 *
 * Both configurations are covered on purpose:
 *
 *   key set    the deployed shape. A token is required, the submit controls are
 *              disabled without one, and it reaches the call.
 *   key unset  the shape CI and local development build in. Nothing renders,
 *              nothing is disabled, and the calls go through unchanged. The
 *              end-to-end suites sign in with a password against a build with no
 *              site key, so this is the property that keeps them green.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The spies are typed with the signature each call site actually uses, not left
 * bare. A bare vi.fn() gives mock.calls an empty tuple type, so reading the
 * argument back is a type error, and the whole point here is reading the
 * argument back.
 */
type Challenged = { captchaToken?: string };

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn<
    (creds: { email: string; password: string; options?: Challenged }) => Promise<{
      error: null;
    }>
  >(async () => ({ error: null })),
  resetPasswordForEmail: vi.fn<
    (
      email: string,
      options?: Challenged & { redirectTo?: string },
    ) => Promise<{ data: object; error: null }>
  >(async () => ({ data: {}, error: null })),
  signInWithOtp: vi.fn<
    (creds: {
      email: string;
      options?: Challenged & { shouldCreateUser?: boolean };
    }) => Promise<{ error: null }>
  >(async () => ({ error: null })),
  verifyOtp: vi.fn<
    (params: { email: string; token: string; type: string }) => Promise<{
      data: { session: { user: { id: string } } };
      error: null;
    }>
  >(async () => ({
    data: { session: { user: { id: 'user-1' } } },
    error: null,
  })),
  signUp: vi.fn<
    (creds: {
      email: string;
      password: string;
      options?: Challenged & { emailRedirectTo?: string };
    }) => Promise<{ error: null }>
  >(async () => ({ error: null })),
  getSession: vi.fn<() => Promise<{ data: { session: null } }>>(async () => ({
    data: { session: null },
  })),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth,
    // The signup page checks a beta allowlist before it calls Auth, and marks
    // the row afterwards. Neither is what this file is about, so both are
    // permissive stubs that keep the captcha assertions on the happy path.
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: vi.fn(() => ({ update: () => ({ eq: async () => ({ error: null }) }) })),
  },
}));

/**
 * A stand-in for the vendor widget. It talks to nothing, it hands the test the
 * success callback so a token can be delivered on demand, and its reset() is a
 * spy so that "single use" is observable rather than assumed.
 */
const vendor = vi.hoisted(() => ({
  onSuccess: null as ((token: string) => void) | null,
  onExpire: null as (() => void) | null,
  reset: vi.fn(),
}));

vi.mock('@marsidev/react-turnstile', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    Turnstile: forwardRef(function TurnstileStub(
      props: { onSuccess?: (token: string) => void; onExpire?: () => void },
      ref: unknown,
    ) {
      vendor.onSuccess = props.onSuccess ?? null;
      vendor.onExpire = props.onExpire ?? null;
      useImperativeHandle(ref as never, () => ({ reset: vendor.reset }));
      return null;
    }),
  };
});

/** An obvious placeholder standing in for a solved challenge. */
const SOLVED = 'solved-challenge-placeholder';
/** Any non-empty value turns the widget on. The value itself is never used. */
const SITE_KEY_PRESENT = 'placeholder-for-tests';

/** Hand the form a token the way a solved challenge would. */
async function solveCaptcha() {
  await act(async () => {
    vendor.onSuccess?.(SOLVED);
  });
}

/**
 * Let a solved challenge lapse, the way the vendor does after a few minutes.
 * The widget reports that as a null token, so a form holding a stale one has
 * to notice and go back to un-submittable.
 */
async function expireCaptcha() {
  await act(async () => {
    vendor.onExpire?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vendor.onSuccess = null;
  vendor.onExpire = null;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Load a module after deciding whether this build has a site key. The key is
 * read once at module scope, so the stub has to be in place before the import.
 */
function withSiteKey(present: boolean) {
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', present ? SITE_KEY_PRESENT : '');
}

async function renderLogin(keyPresent: boolean) {
  const { MemoryRouter } = await import('react-router-dom');
  withSiteKey(keyPresent);
  const { default: LoginPage } = await import('../LoginPage');
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function fillLogin() {
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'someone@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'not-a-real-secret' },
  });
}

describe('sign in with a password', () => {
  it('will not submit without a token, then sends it', async () => {
    await renderLogin(true);
    fillLogin();

    const submit = screen.getByRole('button', { name: 'Sign In' });
    expect(submit).toBeDisabled();

    await solveCaptcha();
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalled());
    expect(auth.signInWithPassword.mock.calls[0][0]).toMatchObject({
      options: { captchaToken: SOLVED },
    });
  });

  it('clears the token after an attempt, because a token is single use', async () => {
    await renderLogin(true);
    fillLogin();
    await solveCaptcha();

    const submit = screen.getByRole('button', { name: 'Sign In' });
    fireEvent.click(submit);

    await waitFor(() => expect(vendor.reset).toHaveBeenCalled());
    // Back to un-submittable: the next attempt has to solve a fresh challenge
    // rather than replay the spent one.
    await waitFor(() => expect(submit).toBeDisabled());
  });

  it('is unchanged when the build has no site key', async () => {
    await renderLogin(false);
    fillLogin();

    const submit = screen.getByRole('button', { name: 'Sign In' });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalled());
    expect(auth.signInWithPassword.mock.calls[0][0]).toMatchObject({
      options: { captchaToken: undefined },
    });
    expect(vendor.onSuccess).toBeNull();
  });
});

describe('sign in with a code', () => {
  async function openCodePath(keyPresent: boolean) {
    await renderLogin(keyPresent);
    fireEvent.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'someone@example.com' },
    });
  }

  it('will not send until the challenge is solved, and Enter does not go around it', async () => {
    await openCodePath(true);

    const send = screen.getByRole('button', { name: 'Send code' });
    expect(send).toBeDisabled();

    // Submitting the form is the one way to reach the handler while the button
    // is disabled, so the guard has to live in the handler as well as on the
    // control. Otherwise the keyboard is a hole in the same door.
    fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it('hands the token to the send, and spends it', async () => {
    await openCodePath(true);
    await solveCaptcha();

    const send = screen.getByRole('button', { name: 'Send code' });
    expect(send).not.toBeDisabled();

    fireEvent.click(send);
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
    expect(auth.signInWithOtp.mock.calls[0][0]).toMatchObject({
      options: { shouldCreateUser: false, captchaToken: SOLVED },
    });
    await waitFor(() => expect(vendor.reset).toHaveBeenCalled());
  });

  it('needs a fresh challenge before it will resend', async () => {
    await openCodePath(true);
    await solveCaptcha();

    // The five second double-send lock disables Resend too, so asserting on it
    // straight after the send would pass whether or not the token was cleared.
    // Run the lock out first: then the missing token is the only thing left
    // holding the button. Timers go in after the render so the module imports
    // above are not waiting on a clock that no longer moves on its own.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
      await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());

      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      const resend = screen.getByRole('button', { name: /resend code/i });
      expect(resend).toBeDisabled();

      await solveCaptcha();
      expect(resend).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a token on verify, which Auth does not challenge', async () => {
    await openCodePath(true);
    await solveCaptcha();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());

    // The send just spent the token, and nothing here solves another one.
    // Requiring one at this step would break the second half of every code
    // sign-in, which is why the widget's own table marks verify as exempt.
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(auth.verifyOtp).toHaveBeenCalled());
    expect(auth.verifyOtp.mock.calls[0][0]).not.toHaveProperty('options');
    expect(JSON.stringify(auth.verifyOtp.mock.calls)).not.toContain(SOLVED);
  });

  it('drops the token when the challenge expires', async () => {
    await openCodePath(true);
    await solveCaptcha();
    expect(screen.getByRole('button', { name: 'Send code' })).not.toBeDisabled();

    await expireCaptcha();
    // A lapsed token is refused by the provider, so submitting with one still
    // held would fail in a way that reads as a broken account rather than as a
    // stale challenge.
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('is unchanged when the build has no site key', async () => {
    await openCodePath(false);

    const send = screen.getByRole('button', { name: 'Send code' });
    expect(send).not.toBeDisabled();

    fireEvent.click(send);
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
    expect(auth.signInWithOtp.mock.calls[0][0]).toMatchObject({
      options: { captchaToken: undefined },
    });
    expect(vendor.onSuccess).toBeNull();
  });
});

describe('password reset', () => {
  it('sends the token with the reset request', async () => {
    await renderLogin(true);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'someone@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    const send = screen.getByRole('button', { name: 'Send reset link' });
    expect(send).toBeDisabled();

    await solveCaptcha();
    fireEvent.click(send);

    await waitFor(() => expect(auth.resetPasswordForEmail).toHaveBeenCalled());
    expect(auth.resetPasswordForEmail.mock.calls[0][1]).toMatchObject({
      captchaToken: SOLVED,
    });
  });
});

describe('signup', () => {
  it('sends the token with the signup request', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    withSiteKey(true);
    const { default: SignupPage } = await import('../SignupPage');
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'someone@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'not-a-real-secret' },
    });

    const submit = screen.getByRole('button', { name: 'Create Account' });
    expect(submit).toBeDisabled();

    await solveCaptcha();
    fireEvent.click(submit);

    await waitFor(() => expect(auth.signUp).toHaveBeenCalled());
    expect(auth.signUp.mock.calls[0][0]).toMatchObject({
      options: { captchaToken: SOLVED },
    });
  });
});

describe('the onboarding email step', () => {
  async function renderStepEmail() {
    withSiteKey(true);
    const steps = await import('../../onboarding/v2/steps');
    const state = await import('../../onboarding/v2/onboarding-state');
    const value = {
      name: '',
      email: 'someone@example.com',
      emailVerified: false,
      vaultPassword: '',
      recoveryCode: null,
      userId: null,
      vaultSetup: null,
      setName: vi.fn(),
      setEmail: vi.fn(),
      setEmailVerified: vi.fn(),
      setVaultPassword: vi.fn(),
      setRecoveryCode: vi.fn(),
      setUserId: vi.fn(),
      setVaultSetup: vi.fn(),
    };
    render(
      <state.OnboardingStateContext.Provider value={value}>
        <steps.StepEmail onNext={vi.fn()} onBack={vi.fn()} isFirst isLast={false} />
      </state.OnboardingStateContext.Provider>,
    );
    // The step probes for a live session on mount and skips the code round trip
    // when it finds one. Let that settle before asserting on the send button.
    await waitFor(() => expect(auth.getSession).toHaveBeenCalled());
  }

  it('sends the token with the code request and resets after', async () => {
    await renderStepEmail();

    const send = screen.getByRole('button', { name: 'Send my code' });
    expect(send).toBeDisabled();

    await solveCaptcha();
    expect(send).not.toBeDisabled();

    fireEvent.click(send);
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
    expect(auth.signInWithOtp.mock.calls[0][0]).toMatchObject({
      options: { shouldCreateUser: true, captchaToken: SOLVED },
    });
    await waitFor(() => expect(vendor.reset).toHaveBeenCalled());
  });

  it('does not send a token on verify, which Auth does not challenge', async () => {
    await renderStepEmail();
    await solveCaptcha();
    fireEvent.click(screen.getByRole('button', { name: 'Send my code' }));
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());

    fireEvent.change(await screen.findByLabelText('One-time code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(auth.verifyOtp).toHaveBeenCalled());
    expect(auth.verifyOtp.mock.calls[0][0]).not.toHaveProperty('options');
    expect(JSON.stringify(auth.verifyOtp.mock.calls)).not.toContain(SOLVED);
  });
});
