import { Request, Response } from 'express';
import { dbService } from '../db/database.js';

export class BillingController {
  static async getSummary(req: Request, res: Response) {
    try {
      const user = (req as any).authUser;
      const isAdmin = user && ['admin', 'administrator', 'moderator'].includes(String(user.role || '').toLowerCase());
      const accountEmail = isAdmin ? (req.query.account_email ? String(req.query.account_email) : undefined) : user?.email;
      const summary = await dbService.getBillingSummary(accountEmail);
      return res.json({ success: true, data: summary });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getInvoices(req: Request, res: Response) {
    try {
      const user = (req as any).authUser;
      const isAdmin = user && ['admin', 'administrator', 'moderator'].includes(String(user.role || '').toLowerCase());
      const accountEmail = isAdmin ? (req.query.account_email ? String(req.query.account_email) : undefined) : user?.email;
      const status = req.query.status ? String(req.query.status) : undefined;
      const parsedLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
      const invoices = await dbService.getBillingInvoices(
        accountEmail,
        status,
        parsedLimit
      );
      return res.json({ success: true, count: invoices.length, data: invoices });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getPlans(req: Request, res: Response) {
    try {
      const user = (req as any).authUser;
      const isAdmin = user && ['admin', 'administrator', 'moderator'].includes(String(user.role || '').toLowerCase());
      const plans = await dbService.getPricingPlans(!isAdmin);
      return res.json({ success: true, data: plans });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message, data: [] });
    }
  }

  static async getConfig(req: Request, res: Response) {
    try {
      const config = await dbService.getBillingConfig();
      return res.json({ success: true, data: config });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async updateConfig(req: Request, res: Response) {
    try {
      const config = await dbService.updateBillingConfig(req.body);
      return res.json({ success: true, message: 'Billing configuration updated successfully.', data: config });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }
}
