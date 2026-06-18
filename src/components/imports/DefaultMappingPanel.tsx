/**
 * Last-mile fallback UI shown above the wizard's "Import everything" button
 * when the OR-staged payload has journal-entry rows with empty Account or
 * Contact. The component is intentionally dumb: it renders dropdowns from
 * caller-supplied option lists and reports the user's pick back through a
 * single callback. No payload knowledge here.
 */

import { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DefaultMappingOption, DefaultMappingSelections } from '@/lib/import-from-orange-rails/apply-defaults';

const NONE_VALUE = '__none__';

export interface DefaultMappingPanelProps {
  accountOptions: DefaultMappingOption[];
  contactOptions: DefaultMappingOption[];
  selections: DefaultMappingSelections;
  onChange: (next: DefaultMappingSelections) => void;
  hasEmptyAccounts: boolean;
  hasEmptyContacts: boolean;
}

export function DefaultMappingPanel({
  accountOptions,
  contactOptions,
  selections,
  onChange,
  hasEmptyAccounts,
  hasEmptyContacts,
}: DefaultMappingPanelProps) {
  const handleAccount = useCallback(
    (value: string) => {
      if (value === NONE_VALUE) {
        onChange({ ...selections, defaultAccount: null });
        return;
      }
      const picked = accountOptions.find((o) => o.code === value) ?? null;
      onChange({ ...selections, defaultAccount: picked });
    },
    [accountOptions, onChange, selections],
  );

  const handleContact = useCallback(
    (value: string) => {
      if (value === NONE_VALUE) {
        onChange({ ...selections, defaultContact: null });
        return;
      }
      const picked = contactOptions.find((o) => o.code === value) ?? null;
      onChange({ ...selections, defaultContact: picked });
    },
    [contactOptions, onChange, selections],
  );

  return (
    <div
      className="rounded border border-yellow-500/40 bg-yellow-500/10 p-4 space-y-3"
      data-testid="default-mapping-panel"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        Some rows are missing a category
      </div>
      <p className="text-xs text-muted-foreground">
        Pick a default for rows that arrived without an Account or Contact.
        Rows that already have one are not touched.
      </p>

      {hasEmptyAccounts && (
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="default-account-select">
            Default account for rows without one
          </label>
          <Select
            value={selections.defaultAccount?.code ?? NONE_VALUE}
            onValueChange={handleAccount}
          >
            <SelectTrigger id="default-account-select" data-testid="default-account-select">
              <SelectValue placeholder="Skip — leave empty" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>Skip — leave empty</SelectItem>
              {accountOptions.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.code ? `${o.code} — ${o.name}` : o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {hasEmptyContacts && (
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="default-contact-select">
            Default contact for rows without one
          </label>
          <Select
            value={selections.defaultContact?.code ?? NONE_VALUE}
            onValueChange={handleContact}
          >
            <SelectTrigger id="default-contact-select" data-testid="default-contact-select">
              <SelectValue placeholder="Skip — leave empty" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>Skip — leave empty</SelectItem>
              {contactOptions.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
