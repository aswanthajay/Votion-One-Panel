import { Request, Response } from 'express';
import crypto from 'crypto';
import { dbService } from '../db/database.js';
import { UserRepository } from '../repositories/UserRepository.js';
import { createSessionToken, createTemp2FaToken, verifyTemp2FaToken } from '../middleware.js';
import { getInitialAdminSetupStatus, completeInitialAdminSetup } from '../db/bootstrapAdmin.js';
import { emailService } from '../services/email.js';

export class AuthController {
  private static passkeyChallenges = new Map<string, number>();

  static async login(req: Request, res: Response) {
    const { email, password } = req.body;
    const result = await dbService.validateCredentials(email, password);
    if (!result.success || !result.account) {
      return res.status(401).json({
        success: false,
        error: result.error || 'Invalid email address or password. Please verify your credentials or use Account Recovery.',
      });
    }
    const account = result.account;
    if (account.twoFactorActive) {
      const tempToken = createTemp2FaToken(account.id);
      return res.json({ success: true, twoFactorRequired: true, tempToken });
    }
    const token = createSessionToken(account.id);
    res.cookie('votion_auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      success: true, message: 'Authentication successful', token,
      user: {
        id: account.id, email: account.email, name: account.name, role: account.role,
        phone: account.phone, supportPinConfigured: account.supportPinConfigured, twoFactorActive: account.twoFactorActive,
      },
    });
  }

  static async login2fa(req: Request, res: Response) {
    const { tempToken, totpCode } = req.body;
    const accountId = verifyTemp2FaToken(tempToken);
    if (!accountId) return res.status(401).json({ success: false, error: 'Session expired, login again.' });
    
    const account = await UserRepository.findById(accountId);
    if (!account) return res.status(401).json({ success: false, error: 'Invalid account' });
    
    const secret = await UserRepository.getTotpSecret(account.email);
    if (!secret) return res.status(400).json({ success: false, error: '2FA not configured' });
    
    const { TOTP } = await import('otpauth');
    const totp = new TOTP({ issuer: 'VOTION', label: account.email, algorithm: 'SHA1', digits: 6, period: 30, secret });
    if (totp.validate({ token: String(totpCode), window: 1 }) === null) {
      return res.status(401).json({ success: false, error: 'Invalid 2FA code' });
    }
    
    const token = createSessionToken(account.id);
    res.cookie('votion_auth_token', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      success: true, message: 'Authentication successful', token,
      user: {
        id: account.id, email: account.email, name: account.name, role: account.role,
        phone: account.phone, supportPinConfigured: account.supportPinConfigured, twoFactorActive: account.twoFactorActive,
      },
    });
  }

  static async passkeyChallenge(req: Request, res: Response) {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const challengeBytes = crypto.randomBytes(32);
      const challenge = challengeBytes.toString('base64url');
      
      AuthController.passkeyChallenges.set(challenge, Date.now() + 2 * 60 * 1000);
      for (const [ch, exp] of AuthController.passkeyChallenges.entries()) {
        if (exp < Date.now()) AuthController.passkeyChallenges.delete(ch);
      }

      let allowCredentials: Array<{ id: string; type: 'public-key' }> = [];
      if (email) {
        const keys = await dbService.findPasskeysByEmail(email);
        allowCredentials = keys.map(k => ({ id: k.credentialId, type: 'public-key' }));
      }

      res.json({
        success: true,
        challenge,
        allowCredentials,
        rpId: req.hostname || 'localhost',
        timeout: 60000,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to generate passkey challenge' });
    }
  }

  static async loginPasskey(req: Request, res: Response) {
    try {
      const { credentialId, clientDataJSON } = req.body;
      if (!credentialId) {
        return res.status(400).json({ success: false, error: 'Credential ID is required.' });
      }

      if (clientDataJSON) {
        try {
          const clientDataStr = Buffer.from(clientDataJSON, 'base64url').toString('utf8');
          const clientData = JSON.parse(clientDataStr);
          if (clientData.type && clientData.type !== 'webauthn.get') {
            return res.status(400).json({ success: false, error: 'Invalid WebAuthn client data type.' });
          }
          const challenge = clientData.challenge;
          if (challenge && AuthController.passkeyChallenges.has(challenge)) {
            AuthController.passkeyChallenges.delete(challenge);
          }
        } catch {
          // Graceful fallback
        }
      }

      const passkey = await dbService.findPasskeyByCredentialId(String(credentialId));
      if (!passkey) {
        return res.status(404).json({ success: false, error: 'Passkey not recognized or not registered.' });
      }

      const account = await dbService.findUserByEmail(passkey.accountEmail);
      if (!account) {
        return res.status(404).json({ success: false, error: 'Account linked to this passkey was not found.' });
      }

      const token = createSessionToken(account.id);
      res.cookie('votion_auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      await dbService.logAudit(account.email, 'PASSKEY_LOGIN', account.email, `Authenticated via passkey ${passkey.keyName} (${credentialId.slice(0, 16)})`);

      res.json({
        success: true,
        message: 'Passkey authentication successful',
        token,
        user: {
          id: account.id,
          email: account.email,
          name: account.name,
          role: account.role,
          phone: account.phone || null,
          supportPinConfigured: Boolean(account.support_pin),
          twoFactorActive: Boolean(account.two_factor_active),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Passkey authentication failed' });
    }
  }

  static async setupStatus(_req: Request, res: Response) {
    const setup = await getInitialAdminSetupStatus();
    res.json({ success: true, setupAvailable: setup.available, expiresAt: setup.expiresAt || null });
  }

  static async setupComplete(req: Request, res: Response) {
    const { token, password } = req.body;
    const completed = await completeInitialAdminSetup(token, password);
    if (!completed.success) {
      if (completed.error === 'administrator-already-configured') return res.status(409).json({ success: false, error: 'An administrator account is already configured.' });
      if (completed.error === 'setup-unavailable') return res.status(410).json({ success: false, error: 'This setup link is unavailable.' });
      return res.status(401).json({ success: false, error: 'This setup link is invalid or has expired.' });
    }
    const sessionToken = createSessionToken(completed.account.id);
    res.cookie('votion_auth_token', sessionToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    await dbService.logAudit(completed.account.email, 'INITIAL_ADMIN_SETUP_COMPLETED', 'auth', 'Completed one-time initial administrator setup');
    res.status(201).json({ success: true, message: 'Initial administrator setup is complete.', token: sessionToken, user: completed.account });
  }
}
