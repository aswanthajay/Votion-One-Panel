import { Router } from 'express';
import { requireAuth, requireOperator } from '../middleware.js';
import { ReimageExecutionError, reimageExecutionService } from '../services/reimageExecution.js';

export const operatorRouter = Router();
operatorRouter.use(requireAuth, requireOperator);

function sendExecutionError(res: any, error: unknown) {
  if (error instanceof ReimageExecutionError) {
    const status = ['EXECUTION_NOT_FOUND', 'APPROVED_REQUEST_NOT_FOUND'].includes(error.code) ? 404 : 409;
    return res.status(status).json({ success: false, code: error.code, error: error.message });
  }
  return res.status(500).json({ success: false, error: 'Operator execution request failed.' });
}

operatorRouter.get('/reimage-requests', async (_req, res) => {
  try {
    const data = await reimageExecutionService.listApprovedRequests();
    res.json({ success: true, data, message: 'Approved requests only. No Proxmox operation was performed.' });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.get('/reimage-executions', async (req, res) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const data = await reimageExecutionService.listExecutions(req.authUser!.email, state);
    res.json({ success: true, data, executionEnabled: reimageExecutionService.isEnabled(), message: 'Execution history contains sanitized workflow state only.' });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.post('/reimage-requests/:requestId/executions', async (req, res) => {
  try {
    const result = await reimageExecutionService.createExecution(req.params.requestId, req.authUser!.email);
    res.status(201).json({ success: true, ...result, message: 'Execution record created. No Proxmox operation was performed.' });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.post('/reimage-executions/:executionId/preflight', async (req, res) => {
  try {
    const result = await reimageExecutionService.preflight(req.params.executionId, req.authUser!.email);
    res.json({ success: true, ...result, message: 'Read-only preflight passed. No Proxmox mutation was performed.' });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.post('/reimage-executions/:executionId/confirm', async (req, res) => {
  try {
    const result = await reimageExecutionService.confirm(req.params.executionId, req.authUser!.email, {
      planHash: String(req.body?.planHash || ''),
      confirmationPhrase: String(req.body?.confirmationPhrase || ''),
      expectedVmid: Number(req.body?.expectedVmid),
      expectedImageProfileVersion: String(req.body?.expectedImageProfileVersion || ''),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.get('/reimage-executions/:executionId', async (req, res) => {
  try {
    const result = await reimageExecutionService.getStatus(req.params.executionId, req.authUser!.email);
    res.json({ success: true, ...result });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

operatorRouter.post('/reimage-executions/:executionId/cancel', async (req, res) => {
  try {
    const result = await reimageExecutionService.cancel(req.params.executionId, req.authUser!.email);
    res.json({ success: true, ...result });
  } catch (error) {
    sendExecutionError(res, error);
  }
});
