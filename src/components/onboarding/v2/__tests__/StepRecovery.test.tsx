/**
 * The recovery kit step: showing the real words, and proving the customer
 * wrote them down.
 *
 * Two defects are pinned here, both of which shipped green because this step
 * had no tests at all.
 *
 * 1. The display stage rendered twelve blank grey bars. The words already
 *    existed in flow state, put there by the vault step one screen earlier.
 *    So the screen that tells the customer "write this somewhere safe, this is
 *    the only way to add another device" showed them nothing to write.
 *
 * 2. The verify stage gated on "every box is non-empty". Twelve letter As
 *    passed a screen whose entire purpose is proving the customer holds their
 *    own written copy, which means it proved nothing and a customer with no
 *    saved kit sailed through to a vault they could never recover.
 *
 * The verify positions are chosen randomly per mount, so these read the
 * positions back off the rendered inputs rather than assuming which words are
 * asked for.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StepRecovery } from '../steps';
import { OnboardingStateContext } from '../onboarding-state';
import type { OnboardingStateValue } from '../onboarding-state';
import { VERIFY_COPY } from '../onboarding-copy';

const WORDS = [
  'orange',
  'rails',
  'ledger',
  'satoshi',
  'harbor',
  'mellow',
  'cactus',
  'violet',
  'timber',
  'quartz',
  'nimbus',
  'jasper',
];
const CODE = WORDS.join(' ');

function renderStep(recoveryCode: string | null) {
  const onNext = vi.fn();
  const value = {
    name: '',
    email: '',
    emailVerified: true,
    vaultPassword: '',
    recoveryCode,
    userId: 'user-1',
    vaultSetup: null,
    setName: vi.fn(),
    setEmail: vi.fn(),
    setEmailVerified: vi.fn(),
    setVaultPassword: vi.fn(),
    setRecoveryCode: vi.fn(),
    setUserId: vi.fn(),
    setVaultSetup: vi.fn(),
  } satisfies OnboardingStateValue;

  render(
    <OnboardingStateContext.Provider value={value}>
      <StepRecovery onNext={onNext} onBack={vi.fn()} isFirst={false} isLast={false} />
    </OnboardingStateContext.Provider>,
  );
  return { onNext };
}

/** Advance past the display stage into the word-entry stage. */
function enterVerify() {
  // The acknowledgement is a Radix Checkbox, which renders a button with
  // role="checkbox" rather than an <input>.
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: "I've written it down" }));
}

/**
 * Which word positions this mount decided to ask for, read off the DOM. Each
 * input carries data-testid="verify-word-<zero-based position>".
 */
function askedPositions(): number[] {
  return screen
    .getAllByTestId(/^verify-word-\d+$/)
    .map((el) => Number(el.getAttribute('data-testid')!.replace('verify-word-', '')));
}

function typeAnswers(answers: (position: number) => string) {
  for (const position of askedPositions()) {
    fireEvent.change(screen.getByTestId(`verify-word-${position}`), {
      target: { value: answers(position) },
    });
  }
}

describe('StepRecovery display stage', () => {
  it('shows the real twelve words from flow state', () => {
    renderStep(CODE);
    const list = screen.getByTestId('recovery-words');
    for (const word of WORDS) {
      expect(within(list).getByText(word)).toBeInTheDocument();
    }
  });

  it('shows blanks rather than plausible fake words when there is no code', () => {
    // Unreachable in the real flow, since the vault step runs first. A
    // convincing placeholder is worse than an obvious gap: someone might write
    // it down and believe they have a recovery kit.
    renderStep(null);
    const list = screen.getByTestId('recovery-words');
    for (const word of WORDS) {
      expect(within(list).queryByText(word)).toBeNull();
    }
  });
});

describe('StepRecovery verify stage', () => {
  it('keeps the button disabled when the boxes are full but the words are wrong', () => {
    renderStep(CODE);
    enterVerify();

    typeAnswers(() => 'aaaa');

    expect(screen.getByRole('button', { name: VERIFY_COPY.cta })).toBeDisabled();
    expect(screen.getByTestId('recovery-verify-error')).toHaveTextContent(VERIFY_COPY.mismatch);
  });

  it('enables the button only for the correct words', () => {
    renderStep(CODE);
    enterVerify();

    typeAnswers((position) => WORDS[position]!);

    expect(screen.getByRole('button', { name: VERIFY_COPY.cta })).toBeEnabled();
    expect(screen.queryByTestId('recovery-verify-error')).toBeNull();
  });

  it('accepts a different case and stray whitespace, because people retype from paper', () => {
    renderStep(CODE);
    enterVerify();

    typeAnswers((position) => `  ${WORDS[position]!.toUpperCase()} `);

    expect(screen.getByRole('button', { name: VERIFY_COPY.cta })).toBeEnabled();
  });

  it('says nothing while the customer is still typing', () => {
    renderStep(CODE);
    enterVerify();

    const positions = askedPositions();
    // Only the first box filled: partially typed is not yet wrong.
    fireEvent.change(screen.getByTestId(`verify-word-${positions[0]}`), {
      target: { value: 'aaaa' },
    });

    expect(screen.queryByTestId('recovery-verify-error')).toBeNull();
    expect(screen.getByRole('button', { name: VERIFY_COPY.cta })).toBeDisabled();
  });

  it('refuses to pass when there is no code to check against', () => {
    // verifyRecoveryWords returns false with no code rather than passing
    // vacuously, so a broken upstream cannot open the gate.
    renderStep(null);
    enterVerify();

    typeAnswers(() => 'anything');

    expect(screen.getByRole('button', { name: VERIFY_COPY.cta })).toBeDisabled();
    expect(screen.getByTestId('recovery-verify-error')).toHaveTextContent(VERIFY_COPY.missing);
  });
});
