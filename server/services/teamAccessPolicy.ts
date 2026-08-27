export type TeamAccessScope = 'readonly' | 'power' | 'full' | 'owner';
export type DelegatedTeamAccessScope = Exclude<TeamAccessScope, 'owner'>;

export const delegatedTeamAccessScopes: readonly DelegatedTeamAccessScope[] = ['readonly', 'power', 'full'];

const teamAccessScopeRank: Record<TeamAccessScope, number> = {
  readonly: 1,
  power: 2,
  full: 3,
  owner: 4,
};

export const isDelegatedTeamAccessScope = (value: unknown): value is DelegatedTeamAccessScope =>
  typeof value === 'string' && delegatedTeamAccessScopes.includes(value as DelegatedTeamAccessScope);

export const hasTeamAccessScope = (
  grantedScope: TeamAccessScope | null | undefined,
  requiredScope: TeamAccessScope,
): boolean => Boolean(grantedScope && teamAccessScopeRank[grantedScope] >= teamAccessScopeRank[requiredScope]);

export type PendingTeamInvitation = {
  expiresAt: Date | string;
  acceptedAt?: Date | string | null;
  revokedAt?: Date | string | null;
};

/**
 * An invitation remains actionable only until its expiry and only while it has
 * neither been accepted nor revoked. Invalid timestamps fail closed.
 */
export const isPendingTeamInvitationActive = (
  invitation: PendingTeamInvitation,
  now: Date = new Date(),
): boolean => {
  if (invitation.acceptedAt || invitation.revokedAt) return false;
  const expiresAt = new Date(invitation.expiresAt).getTime();
  const currentTime = now.getTime();
  return Number.isFinite(expiresAt) && Number.isFinite(currentTime) && expiresAt > currentTime;
};
