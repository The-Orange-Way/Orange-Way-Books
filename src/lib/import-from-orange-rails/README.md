# Import from Orange Rails

OWB-side ingestion for the Mode 2 single-bundle path from Orange Rails. The
wire format is defined in `contract.ts` in this directory.

## What's here

| File               | What it does                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`      | Type definition (`StagedImportPayload`) + runtime validator (`assertStagedImportPayload`) + helper (`stagedRowsToPreview`). Kept in sync manually with `orangerails/src/connectors/contract.ts` until OR is published as an npm package. |
| `contract.test.ts` | Vitest unit tests for the validator and the helper.                                                                                                                                                                                      |

The wizard component lives at `src/components/imports/ImportFromOrangeRailsWizard.tsx`.

## How the contract works

Every Orange Rails connector (Wave, QuickBooks, future Plaid / ShakePay) emits a
single JSON file in the shape defined here. OWB's wizard reads that file,
validates it with `assertStagedImportPayload`, surfaces the connector's
summary / warnings / errors / classification hints, then applies each section
through OWB's existing commit handlers.

The staged row keys (`name`, `code`, `type`, `je_date`, `je_ref_#`, etc.) match
OWB's `ImportPreviewRow.data` exactly — by design of the contract — so OWB's
existing `src/lib/csv/*` validators and the per-page commit handlers accept
these rows with zero translation.

## How to mount the wizard

The wizard is a presentational component. The host page provides three commit
handlers (one per staged section) matching `ImportPopup`'s `onImportRows`
signature:

```tsx
import { ImportFromOrangeRailsWizard } from '@/components/imports/ImportFromOrangeRailsWizard';

function MyPage() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Import from Orange Rails</Button>
      <ImportFromOrangeRailsWizard
        open={open}
        onClose={() => setOpen(false)}
        onApplyAccounts={async (rows) => {
          // Same shape as ImportPopup's existing handler in Admin.tsx
          // (rows[i].data has keys: name, code, type, subtype, normal_balance, category, description)
          ...
          return { created, skipped, failed, errors };
        }}
        onApplyContacts={async (rows) => { ... }}
        onApplyJournalEntries={async (rows) => { ... }}
      />
    </>
  );
}
```

The handlers are passed in (not duplicated inside the wizard) so the existing
inline `ImportPopup`-style handlers in `Admin.tsx` and `JournalEntries.tsx`
can be reused once they're extracted into shared helpers. That extraction is
the next planned change (separate PR).

## ZKA boundary

The payload arrives on the user's machine as plaintext — Orange Rails plugins
run locally on an operator workstation. OWB encrypts each staged row in the browser
before write, using the same crypto path the inline `ImportPopup` widgets
already use. The server never sees plaintext.

## Sync with Orange Rails

When `orangerails/src/connectors/contract.ts` changes (new optional field,
bumped version, new enum value):

1. Update `contract.ts` here to match.
2. Update `contract.test.ts` if the validation rules changed.
3. Bump the wizard's UI if a new section becomes commitable.

When `STAGED_IMPORT_CONTRACT_VERSION` bumps (breaking change), both repos
ship in lockstep.

Eventual end state: OR publishes a typed package; this file becomes
`import { ... } from '@orangerails/connectors'` and the manual sync goes away.
