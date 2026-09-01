import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middleware.js';
import { BillingController } from '../../controllers/BillingController.js';

export const billingRouter = Router();

// All billing endpoints require authenticated session
billingRouter.use(requireAuth);

billingRouter.get('/summary', BillingController.getSummary);
billingRouter.get('/invoices', BillingController.getInvoices);
billingRouter.get('/plans', BillingController.getPlans);
billingRouter.get('/config', BillingController.getConfig);

// Admin-only billing configuration mutation
billingRouter.put('/config', requireAdmin, BillingController.updateConfig);
