/**
 * The OR link and disconnect rules.
 *
 * These exist as tests, rather than as behaviour observed in a click handler,
 * because both rules replace a version that reported success on a failure. A
 * duplicate connect that renders nothing, and a delete that returns 2xx while
 * the row survives, are the two cases asserted hardest below.
 */

import { describe, it, expect } from 'vitest';
import { buildDeletePlan, classifyDeleteReadback } from '../connection-delete';
import { describeLinkResult } from '../link-result';
import { CallProxyError, isSubaccountNotFound } from '../proxy-errors';

describe('describeLinkResult', () => {
  it('reports a genuinely new connection as created, and highlights it', () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-new' },
      knownConnectionIdsBefore: ['c-old'],
    });
    expect(r.outcome).toBe('created');
    expect(r.toast.level).toBe('success');
    expect(r.highlightConnectionId).toBe('c-new');
  });

  it('says something when the wallet was already connected, instead of nothing', () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-old', source_wallets: [] },
      knownConnectionIdsBefore: ['c-old', 'c-other'],
    });
    expect(r.outcome).toBe('already-existed');
    expect(r.toast.level).toBe('info');
    expect(r.toast.message.length).toBeGreaterThan(0);
    expect(r.highlightConnectionId).toBe('c-old');
  });

  it("honours OR's already_existed flag when it is sent, over the membership check", () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-new', already_existed: true },
      knownConnectionIdsBefore: [],
    });
    expect(r.outcome).toBe('already-existed');
  });

  it('honours already_existed false even when the id was already on screen', () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-old', already_existed: false },
      knownConnectionIdsBefore: ['c-old'],
    });
    expect(r.outcome).toBe('created');
  });

  it('refuses to claim added when the refresh does not contain the new id', () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-new' },
      knownConnectionIdsBefore: [],
      connectionIdsAfter: ['c-other'],
    });
    expect(r.outcome).toBe('unknown');
    expect(r.toast.level).toBe('warning');
    expect(r.highlightConnectionId).toBeNull();
  });

  it('claims added when the refresh does contain the new id', () => {
    const r = describeLinkResult({
      result: { connection_id: 'c-new' },
      knownConnectionIdsBefore: [],
      connectionIdsAfter: ['c-other', 'c-new'],
    });
    expect(r.outcome).toBe('created');
  });
});

describe('buildDeletePlan', () => {
  it('sends a private connection to the private endpoint, keyed by row id alone', () => {
    const plan = buildDeletePlan({ isStealth: true, connectionId: 'c-1', subaccountId: 's-1' });
    expect(plan.endpoint).toBe('or-stealth-connection-delete');
    expect(plan.payload).toEqual({ connection_id: 'c-1' });
  });

  it('sends an ordinary connection to the subaccount-scoped endpoint', () => {
    const plan = buildDeletePlan({ isStealth: false, connectionId: 'c-2', subaccountId: 's-1' });
    expect(plan.endpoint).toBe('or-connection-delete');
    expect(plan.payload).toEqual({ subaccount_id: 's-1', connection_id: 'c-2' });
  });

  it('treats an unknown stealth flag as ordinary, not as private', () => {
    const plan = buildDeletePlan({
      isStealth: undefined,
      connectionId: 'c-3',
      subaccountId: 's-1',
    });
    expect(plan.endpoint).toBe('or-connection-delete');
  });
});

describe('classifyDeleteReadback', () => {
  it('calls a row that is still present after a 2xx a silent failure', () => {
    expect(classifyDeleteReadback([{ id: 'c-1' }, { id: 'c-2' }], 'c-1')).toBe('silent-failure');
  });

  it('confirms the delete only when the row is absent from a list we could read', () => {
    expect(classifyDeleteReadback([{ id: 'c-2' }], 'c-1')).toBe('confirmed-gone');
    expect(classifyDeleteReadback([], 'c-1')).toBe('confirmed-gone');
  });

  it('does not claim a verified delete when the list could not be read back', () => {
    expect(classifyDeleteReadback(null, 'c-1')).toBe('unconfirmed');
    expect(classifyDeleteReadback(undefined, 'c-1')).toBe('unconfirmed');
  });
});

describe('isSubaccountNotFound', () => {
  it('matches only a 404 that actually says the subaccount is unknown', () => {
    expect(isSubaccountNotFound(new CallProxyError('Subaccount not found', 404, null))).toBe(true);
  });

  it('does not match another 404, so an unrelated failure is not re-provisioned away', () => {
    expect(isSubaccountNotFound(new CallProxyError('Connection not found', 404, null))).toBe(false);
  });

  it('does not match the same message on another status', () => {
    expect(isSubaccountNotFound(new CallProxyError('Subaccount not found', 500, null))).toBe(false);
  });

  it('does not match a plain Error carrying the same text', () => {
    expect(isSubaccountNotFound(new Error('Subaccount not found'))).toBe(false);
  });

  it('keeps the upstream status and body for the caller to branch on', () => {
    const err = new CallProxyError('rate limited', 429, { retry_after: 30 });
    expect(err.name).toBe('CallProxyError');
    expect(err.status).toBe(429);
    expect(err.body).toEqual({ retry_after: 30 });
  });
});
