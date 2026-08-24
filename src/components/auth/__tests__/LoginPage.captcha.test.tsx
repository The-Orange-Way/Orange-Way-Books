/**
 * Turnstile on the code sign-in send path (DL-0708).
 *
 * The code path calls signInWithOtp, which is a mail send that anyone can
 * drive without an account. /signup already carries Turnstile; this page did
 * not, so the send was reachable at whatever rate the provider allowed and
 * the provider's budget is per project, shared with every other auth email.
 *
 * Two properties matter and neither is visible from reading the component:
 *   1. with no site key configured the page behaves exactly as before, which
 *      is what keeps local dev and the e2e suite working
 *   2. with a key configured the token is required, is actually handed to
 *      Auth, and is cleared after use so a resend cannot reuse a spent one
 *
 * The site key is read once at module load, so each case re-imports the
 * component after stubbing the env. Same shape as the Sentry init tests.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

const captcha = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));

// Stands in for the real widget, which needs a network round trip to
// Cloudflare and cannot run here. It exposes the same two things the
// component touches: an onSuccess callback and a reset() on the ref.
vi.mock('@marsidev/react-turnstile', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const Turnstile = forwardRef(
    (props: { onSuccess?: (t: string) => void; onExpire?: () => void }, ref) => {
      useImperativeHandle(ref, () => ({ reset: captcha.reset }));
      return (
        <div>
          <button type="button" onClick={() => props.onSuccess?.('turnstile-token-1')}>
            solve captcha
          </button>
          <button type="button" onClick={() => props.onExpire?.()}>
            expire captcha
          </button>
        </div>
      );
    },
  );
  return { Turnstile };
});

async function mountFresh() {
  vi.resetModules();
  const { default: LoginPage } = await import('../LoginPage');
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function openCodePath(container: HTMLElement, address = 'someone@example.com') {
  fireEvent.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
  fireEvent.change(container.querySelector('input[type="email"]')!, {
    target: { value: address },
  });
}

describe('LoginPage code sign-in captcha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.signInWithOtp.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('with no site key configured', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    });

    it('renders no widget and leaves Send code enabled', async () => {
      const { container } = await mountFresh();
      openCodePath(container);
      expect(screen.queryByRole('button', { name: /solve captcha/i })).toBeNull();
      expect(screen.getByRole('button', { name: 'Send code' })).not.toBeDisabled();
    });

    it('still sends, and passes no token', async () => {
      const { container } = await mountFresh();
      openCodePath(container);
      fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
      await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
      expect(auth.signInWithOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ captchaToken: undefined }),
        }),
      );
    });
  });

  describe('with a site key configured', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
    });

    it('will not send until the challenge is solved', async () => {
      const { container } = await mountFresh();
      openCodePath(container);
      expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
      // Enter must carry the same guard as the button, or it becomes the way
      // around it.
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
      expect(auth.signInWithOtp).not.toHaveBeenCalled();
    });

    it('hands the token to Auth once solved', async () => {
      const { container } = await mountFresh();
      openCodePath(container);
      fireEvent.click(screen.getByRole('button', { name: /solve captcha/i }));
      const send = screen.getByRole('button', { name: 'Send code' });
      expect(send).not.toBeDisabled();
      fireEvent.click(send);
      await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
      expect(auth.signInWithOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ captchaToken: 'turnstile-token-1' }),
        }),
      );
    });

    it('spends the token, so a resend needs a fresh one', async () => {
      // The 5s double-send lock also disables Resend, so asserting on that
      // button straight after a send would pass whether or not the token was
      // cleared. The clock has to be faked before the send so the lock's
      // timer lands on it, then run out, leaving the missing token as the
      // only thing still holding the button.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { container } = await mountFresh();
        openCodePath(container);
        fireEvent.click(screen.getByRole('button', { name: /solve captcha/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
        await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalledTimes(1));
        // Auth consumes a Turnstile token on use. Holding on to it would
        // leave Resend enabled and the retry would fail with nothing on
        // screen to explain why, so the widget is asked to issue a new one.
        await waitFor(() => expect(captcha.reset).toHaveBeenCalled());

        await act(async () => {
          vi.advanceTimersByTime(6000);
        });

        expect(screen.getByRole('button', { name: /resend code/i })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: /solve captcha/i }));
        expect(screen.getByRole('button', { name: /resend code/i })).not.toBeDisabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops the token when the challenge expires', async () => {
      const { container } = await mountFresh();
      openCodePath(container);
      fireEvent.click(screen.getByRole('button', { name: /solve captcha/i }));
      expect(screen.getByRole('button', { name: 'Send code' })).not.toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /expire captcha/i }));
      expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
    });
  });
});
