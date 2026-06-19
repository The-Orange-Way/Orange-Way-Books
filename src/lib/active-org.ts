// Active-org localStorage helpers. Centralizes the storage-key name.

const ACTIVE_ORG_KEY = 'orangewaybooks.active_org';

export function getActiveOrgId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_ORG_KEY);
}

export function setActiveOrgId(orgId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACTIVE_ORG_KEY, orgId);
}

export function clearActiveOrgId(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACTIVE_ORG_KEY);
}

export { ACTIVE_ORG_KEY };
