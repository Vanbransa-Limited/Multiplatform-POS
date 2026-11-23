/** Shared checkout standard for current tenants and platform onboarding. */
export function standardReceiptPolicy(tenantId: string, branchIds: string[], authorizationId: string) {
  return { tenantId, mode: 'internal', duration: 'ongoing', entryMode: 'staff_entry',
    policyVersion: 3, branchScope: 'tenant', branchIds: [...new Set(branchIds)].sort(),
    until: null, authorizationId };
}
