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
