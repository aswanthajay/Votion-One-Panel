import { describe, expect, it } from 'vitest';
import {
  hasTeamAccessScope,
  isPendingTeamInvitationActive,
  type PendingTeamInvitation,
} from './teamAccessPolicy.js';

const now = new Date('2026-08-28T10:00:00.000Z');

const invitation = (overrides: Partial<PendingTeamInvitation> = {}): PendingTeamInvitation => ({
  expiresAt: '2026-08-28T10:15:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  ...overrides,
});

describe('team access permission levels', () => {
  it('allows a Viewer to access read-only service information only', () => {
    expect(hasTeamAccessScope('readonly', 'readonly')).toBe(true);
    expect(hasTeamAccessScope('readonly', 'power')).toBe(false);
    expect(hasTeamAccessScope('readonly', 'full')).toBe(false);
    expect(hasTeamAccessScope('readonly', 'owner')).toBe(false);
  });

  it('allows an Operator to use power-level service controls without manager authority', () => {
    expect(hasTeamAccessScope('power', 'readonly')).toBe(true);
    expect(hasTeamAccessScope('power', 'power')).toBe(true);
    expect(hasTeamAccessScope('power', 'full')).toBe(false);
    expect(hasTeamAccessScope('power', 'owner')).toBe(false);
  });

  it('allows a Manager to administer delegated service controls without owner authority', () => {
    expect(hasTeamAccessScope('full', 'readonly')).toBe(true);
    expect(hasTeamAccessScope('full', 'power')).toBe(true);
    expect(hasTeamAccessScope('full', 'full')).toBe(true);
    expect(hasTeamAccessScope('full', 'owner')).toBe(false);
  });

  it('retains owner-only authority for the service owner', () => {
    expect(hasTeamAccessScope('owner', 'readonly')).toBe(true);
    expect(hasTeamAccessScope('owner', 'power')).toBe(true);
    expect(hasTeamAccessScope('owner', 'full')).toBe(true);
    expect(hasTeamAccessScope('owner', 'owner')).toBe(true);
  });
});

describe('pending team invitation expiry', () => {
  it('keeps a future, unaccepted, and unrevoked invitation actionable', () => {
    expect(isPendingTeamInvitationActive(invitation(), now)).toBe(true);
  });

  it('expires an invitation exactly at its expiry timestamp', () => {
    const expiresAt = '2026-08-28T10:00:00.000Z';
    expect(isPendingTeamInvitationActive(invitation({ expiresAt }), now)).toBe(false);
  });

  it('rejects an invitation after its seven-day lifetime has elapsed', () => {
    expect(isPendingTeamInvitationActive(invitation({ expiresAt: '2026-08-28T09:59:59.999Z' }), now)).toBe(false);
  });

  it('rejects invitations that have already been accepted or revoked', () => {
    expect(isPendingTeamInvitationActive(invitation({ acceptedAt: '2026-08-28T09:30:00.000Z' }), now)).toBe(false);
    expect(isPendingTeamInvitationActive(invitation({ revokedAt: '2026-08-28T09:30:00.000Z' }), now)).toBe(false);
  });

  it('fails closed when an invitation expiry timestamp is invalid', () => {
    expect(isPendingTeamInvitationActive(invitation({ expiresAt: 'not-a-date' }), now)).toBe(false);
  });
});
