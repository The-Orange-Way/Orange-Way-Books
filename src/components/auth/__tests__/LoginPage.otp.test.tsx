/**
 * Code sign-in on /login (DL-0708).
 *
 * Onboarding v2 registers accounts with signInWithOtp({ shouldCreateUser:
 * true }), so those users hold no Supabase password. Before this path existed
 * the sign-in page offered nothing but a password field and they could not
 * get back in. The sibling app shipped that defect first and it was a P0.
 *
 * These cover the three properties that are not obvious from reading the
 * component, and that a later refactor could quietly drop:
 *   1. the password field survives on the default view (six e2e specs drive
 *      it, see tests/e2e/lib/auth.ts)
 *   2. the sign-in page never creates an account
 *   3. a wrong or unknown address is not distinguishable from a real one
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));

/**
 * Build the page with the onboarding v2 flag in a known state (DL-0429).
 *
 * The flag is read once at module scope, so it has to be stubbed before the
 * import rather than anywhere later, and the module registry has to be fresh
 * on every call or a second mount silently reuses the first one's value.
 * Nothing injects the flag under the test runner, so the default here is on:
 * every case below except the last is about behaviour that only exists once
 * the control is reachable.
 *
 * react-router-dom is imported here too, because resetting the registry would
 * otherwise hand the test a router the component is not the one using.
 */
async function mount(flagOn = true) {
  vi.resetModules();
  vi.stubEnv('VITE_ONBOARDING_V2', flagOn ? 'true' : '');
  const { MemoryRouter } = await import('react-router-dom');
  const { default: LoginPage } = await import('../LoginPage');
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

async function reachCodeStage(container: HTMLElement, address = 'someone@example.com') {
  fireEvent.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
  fireEvent.change(container.querySelector('input[type="email"]')!, {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
}

describe('LoginPage code sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.signInWithOtp.mockResolvedValue({ error: null });
    auth.verifyOtp.mockResolvedValue({ data: { session: { user: { id: 'u1' } } }, error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('still shows the password field by default', async () => {
    const { container } = await mount();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
  });

  it('never creates an account from the sign-in page', async () => {
    const { container } = await mount();
    await reachCodeStage(container);
    expect(auth.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ shouldCreateUser: false }),
      }),
    );
  });

  it('asks for the code in the body, not a magic link', async () => {
    const { container } = await mount();
    await reachCodeStage(container);
    fireEvent.change(container.querySelector('#otp-code')!, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() =>
      expect(auth.verifyOtp).toHaveBeenCalledWith(expect.objectContaining({ type: 'email' })),
    );
  });

  it('keeps non-digits and overlong input out of the code field', async () => {
    const { container } = await mount();
    await reachCodeStage(container);
    const code = container.querySelector('#otp-code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'a1b2c3d4e5' } });
    expect(code.value).toBe('12345');
    fireEvent.change(code, { target: { value: '1234567890' } });
    expect(code.value).toBe('123456');
  });

  it('does not reveal whether an address has an account', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: { message: 'Signups not allowed for otp' } });
    const { container } = await mount();
    await reachCodeStage(container, 'nobody@example.com');
    // Same destination as the success path, and the provider's reason is
    // never rendered: otherwise this page answers "is this address
    // registered?" for anyone who asks.
    expect(container.querySelector('#otp-code')).not.toBeNull();
    expect(screen.queryByText(/signups not allowed/i)).toBeNull();
  });

  it('does not spend a verify attempt when Enter is pressed on a short code', async () => {
    const { container } = await mount();
    await reachCodeStage(container);
    const code = container.querySelector('#otp-code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: '123' } });
    // The Sign In button is disabled below OTP_LENGTH, so Enter is the only
    // way to reach verifyOtp early. It must carry the same guard.
    fireEvent.submit(code.closest('form') as HTMLFormElement);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.submit(code.closest('form') as HTMLFormElement);
    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it('leaves password sign-in reachable and untouched', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /back to password sign in/i }));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('does not offer the code path at all when onboarding v2 is off', async () => {
    // The only accounts that need this door are the passwordless ones the v2
    // front door creates, and those cannot exist while the front door itself
    // is flag gated off. It matters that the control is absent rather than
    // merely useless: the send swallows its own error on purpose, so on a
    // project whose Auth does not issue email codes the customer is told a
    // code is coming and then waits for mail that never arrives, with nothing
    // on screen to report.
    const off = await mount(false);
    expect(screen.queryByRole('button', { name: /email me a sign-in code/i })).toBeNull();
    expect(off.container.querySelector('input[type="password"]')).not.toBeNull();
    off.unmount();

    const on = await mount(true);
    expect(screen.queryByRole('button', { name: /email me a sign-in code/i })).not.toBeNull();
    expect(on.container.querySelector('input[type="password"]')).not.toBeNull();
  });
});
