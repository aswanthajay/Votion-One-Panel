import { Request, Response } from 'express';
import { dbService } from '../db/database.js';

export class UserController {
  static async getProfile(req: any, res: any) {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });

    try {
      const accounts = await dbService.getAccounts();
      const account = accounts.find(a => a.email === userEmail);
      if (!account) return res.status(404).json({ success: false, error: 'User profile not found' });
      return res.json({ success: true, data: account });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async updateProfile(req: any, res: any) {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });

    try {
      const updatedUser = await dbService.updateUserProfile(userEmail, req.body);
      if (!updatedUser) {
        return res.status(404).json({ success: false, error: 'Failed to update profile.' });
      }
      return res.json({ success: true, user: updatedUser });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async changePassword(req: any, res: any) {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { currentPassword, newPassword } = req.body;
    try {
      const result = await dbService.changeUserPassword(userEmail, currentPassword, newPassword);
      if (!result.success) return res.status(400).json(result);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getSshKeys(req: any, res: any) {
    try {
      const { prisma } = await import('../db/prisma.js');
      const user = await prisma.accounts.findUnique({ where: { email: req.authUser.email } });
      return res.json({ success: true, data: user?.ssh_keys || '' });
    } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
  }

  static async updateSshKeys(req: any, res: any) {
    try {
      const { prisma } = await import('../db/prisma.js');
      await prisma.accounts.update({
        where: { email: req.authUser.email },
        data: { ssh_keys: req.body.sshKeys || '' }
      });
      return res.json({ success: true, message: 'SSH Keys updated successfully' });
    } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
  }

  static async getApiKeys(req: any, res: any) {
    try {
      const { prisma } = await import('../db/prisma.js');
      const keys = await prisma.stellar_api_keys.findMany({
        where: { user_email: req.authUser.email },
        orderBy: { created_at: 'desc' }
      });
      return res.json({ success: true, data: keys });
    } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
  }

  static async createApiKey(req: any, res: any) {
    try {
      const { name, scope } = req.body;
      const crypto = await import('crypto');
      const rawKey = 'votion_sk_' + crypto.randomBytes(24).toString('base64url');
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyPrefix = rawKey.slice(0, 15);
      
      const { prisma } = await import('../db/prisma.js');
      await prisma.stellar_api_keys.create({
        data: { user_email: req.authUser.email, name: name || 'API Key', key_hash: keyHash, key_prefix: keyPrefix, scope: scope || 'read' }
      });
      return res.json({ success: true, rawKey, message: 'Key created. Please save it now.' });
    } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
  }
  
  static async deleteApiKey(req: any, res: any) {
    try {
      const { prisma } = await import('../db/prisma.js');
      await prisma.stellar_api_keys.delete({
        where: { id: parseInt(req.params.id) }
      });
      return res.json({ success: true, message: 'Key revoked.' });
    } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
  }
}
