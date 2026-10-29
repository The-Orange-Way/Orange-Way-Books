/**
 * Which transactions row is each leg when a transfer is saved from an edit. The edited row is the
 * source when the transfer goes OUT of it and the destination when it comes IN, so each row keeps
 * its own wallet. A null id means that leg has no row yet and one is inserted.
 */
export function transferEditTargets(
  direction: 'IN' | 'OUT',
  editedId: string,
  partnerId: string | null,
): { srcId: string | null; destId: string | null } {
  return direction === 'OUT'
    ? { srcId: editedId, destId: partnerId }
    : { srcId: partnerId, destId: editedId };
}

/** One leg's row values: its wallet, encrypted fields and signature columns. */
export interface TransferLegValues {
  account_id: string;
  enc: Record<string, unknown>;
  sig: Record<string, unknown>;
}

/** The three database calls an edit save needs. Each throws on a database error. */
export interface TransferEditDb {
  /** The id of the row whose linked_transfer_id is `id`, or null if there is none. */
  findLinkedTo(id: string): Promise<string | null>;
  update(id: string, values: Record<string, unknown>): Promise<void>;
  insert(values: Record<string, unknown>): Promise<string>;
}

/**
 * Writes both legs of an edited transfer. The partner is written first (inserted if missing), then
 * the edited row in one signed update that also carries its link, so an unsigned row never gets a
 * link-only update and a save that failed halfway is repaired by the next save.
 */
export async function saveTransferEditLegs(
  db: TransferEditDb,
  p: {
    direction: 'IN' | 'OUT';
    editedId: string;
    linkedId: string | null;
    orgId: string;
    date: string;
    journalEntryId: string;
    src: TransferLegValues;
    dest: TransferLegValues;
  },
): Promise<{ srcId: string; destId: string }> {
  const found = p.linkedId ?? (await db.findLinkedTo(p.editedId));
  const edited = p.direction === 'OUT' ? p.src : p.dest;
  const partner = p.direction === 'OUT' ? p.dest : p.src;
  const shared = { date: p.date, journal_entry_id: p.journalEntryId };
  const row = (leg: TransferLegValues, link: string) => ({
    account_id: leg.account_id,
    ...shared,
    linked_transfer_id: link,
    ...leg.enc,
    ...leg.sig,
  });

  let partnerId: string;
  if (found) {
    await db.update(found, row(partner, p.editedId));
    partnerId = found;
  } else {
    partnerId = await db.insert({ org_id: p.orgId, ...row(partner, p.editedId) });
  }
  await db.update(p.editedId, row(edited, partnerId));

  const t = transferEditTargets(p.direction, p.editedId, partnerId);
  return { srcId: t.srcId!, destId: t.destId! };
}
