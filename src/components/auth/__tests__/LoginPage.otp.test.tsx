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
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LoginPage from '../LoginPage';

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));

function mount() {
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

  it('still shows the password field by default', () => {
    const { container } = mount();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
  });

  it('never creates an account from the sign-in page', async () => {
    const { container } = mount();
    await reachCodeStage(container);
    expect(auth.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ shouldCreateUser: false }),
      }),
    );
  });

  it('asks for the code in the body, not a magic link', async () => {
    const { container } = mount();
    await reachCodeStage(container);
    fireEvent.change(container.querySelector('#otp-code')!, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() =>
      expect(auth.verifyOtp).toHaveBeenCalledWith(expect.objectContaining({ type: 'email' })),
    );
  });

  it('keeps non-digits and overlong input out of the code field', async () => {
    const { container } = mount();
    await reachCodeStage(container);
    const code = container.querySelector('#otp-code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'a1b2c3d4e5' } });
    expect(code.value).toBe('12345');
    fireEvent.change(code, { target: { value: '1234567890' } });
    expect(code.value).toBe('123456');
  });

  it('does not reveal whether an address has an account', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: { message: 'Signups not allowed for otp' } });
    const { container } = mount();
    await reachCodeStage(container, 'nobody@example.com');
    // Same destination as the success path, and the provider's reason is
    // never rendered: otherwise this page answers "is this address
    // registered?" for anyone who asks.
    expect(container.querySelector('#otp-code')).not.toBeNull();
    expect(screen.queryByText(/signups not allowed/i)).toBeNull();
  });

  it('leaves password sign-in reachable and untouched', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /back to password sign in/i }));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});
