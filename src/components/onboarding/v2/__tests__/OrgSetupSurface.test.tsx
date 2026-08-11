/**
 * OrgSetupSurface, screen 1 of the post-onboarding org setup (DL-0718).
 *
 * Slice 1 is UI plus local state only: it validates the organization name and
 * gates the Finish control on it, and does not persist anything. These tests
 * pin that contract so a later slice that adds persistence cannot silently
 * change the validation behaviour without a red test.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OrgSetupSurface from '../OrgSetupSurface';

describe('OrgSetupSurface (screen 1, org name)', () => {
  it('disables Finish until a non-blank name is entered', () => {
    render(<OrgSetupSurface onComplete={vi.fn()} />);

    const finish = screen.getByRole('button', { name: 'Finish setup' });
    expect(finish).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: 'Satoshi Holdings Ltd' },
    });
    expect(finish).toBeEnabled();
  });

  it('treats a whitespace-only name as blank', () => {
    render(<OrgSetupSurface onComplete={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
  });

  it('calls onComplete once when Finish is pressed with a valid name', () => {
    const onComplete = vi.fn();
    render(<OrgSetupSurface onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
