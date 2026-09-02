import { Router } from 'express';
import { dbService } from '../db/database.js';
import { emailService } from '../services/email.js';
import { requireAdmin, requireAuth } from '../middleware.js';

export const ticketRouter = Router();
ticketRouter.use(requireAuth);

const adminRoles = new Set(['administrator', 'admin', 'moderator']);
const ticketStatuses = new Set(['open', 'in-progress', 'replied', 'resolved', 'closed']);
const ticketPriorities = new Set(['low', 'medium', 'high', 'urgent']);
const isAdmin = (req: any) => adminRoles.has(req.authUser?.role);
const queryValue = (value: unknown, maxLength = 100) => typeof value === 'string' ? value.trim().slice(0, maxLength) : undefined;

// 1. POST /api/tickets — Create a new support ticket
const handleCreateTicket = async (req: any, res: any) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { subject, category, priority, vmid, message } = req.body;

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ success: false, error: 'Subject is required' });
  }

  const parsedVmid = vmid ? parseInt(String(vmid), 10) : undefined;
  if (Number.isInteger(parsedVmid) && !isAdmin(req)) {
    const linkedVm = await dbService.getVMByVMID(parsedVmid!);
    const isOwner = linkedVm && String(linkedVm.ownerEmail || '').toLowerCase() === userEmail.toLowerCase();
    let hasDelegatedAccess = false;
    if (!isOwner && linkedVm) {
      const delegated = await dbService.getSubUserAccess(parsedVmid!, userEmail.toLowerCase());
      if (delegated) hasDelegatedAccess = true;
    }
    if (!linkedVm || (!isOwner && !hasDelegatedAccess)) {
      return res.status(403).json({ success: false, error: 'You can only link a support ticket to a service assigned to your account.' });
    }
  }
  const normalizedPriority = ticketPriorities.has(String(priority)) ? String(priority) : 'medium';
  const normalizedCategory = typeof category === 'string' && category.trim() ? category.trim().slice(0, 100) : 'General';
  const normalizedMessage = typeof message === 'string' ? message.trim().slice(0, 10_000) : undefined;
  const ticket = await dbService.createSupportTicketWithInitialReply(
    subject.trim().slice(0, 255),
    normalizedCategory,
    normalizedPriority,
    Number.isInteger(parsedVmid) ? parsedVmid : undefined,
    userEmail,
    normalizedMessage,
  );

  // createSupportTicketWithInitialReply returns { ticket, replies }; use the nested ticket.id
  const ticketId = ticket?.ticket?.id;

  res.json({
    success: true,
    message: ticketId ? `Support ticket ${ticketId} created successfully in PostgreSQL` : 'Support ticket created successfully in PostgreSQL',
    data: ticket,
  });
};
ticketRouter.post('/', handleCreateTicket);

// 2. GET /api/tickets — Fetch tickets (clients see only their own; admins see all)
const handleGetTickets = async (req: any, res: any) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const adminViewer = isAdmin(req);
  const filterEmail = adminViewer ? undefined : userEmail;
  const tickets = await dbService.getSupportTickets(filterEmail, {
    search: queryValue(req.query.search),
    status: queryValue(req.query.status, 20),
    priority: queryValue(req.query.priority, 20),
    assignedTo: queryValue(req.query.assignedTo, 255),
    viewerEmail: userEmail,
    viewerRole: adminViewer ? 'admin' : 'client',
  });
  res.json({ success: true, count: tickets.length, data: tickets });
};
ticketRouter.get('/', handleGetTickets);

ticketRouter.get('/summary', async (req: any, res: any) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const adminViewer = isAdmin(req);
  const tickets = await dbService.getSupportTickets(adminViewer ? undefined : userEmail, {
    viewerEmail: userEmail,
    viewerRole: adminViewer ? 'admin' : 'client',
  });
  const byStatus = Object.fromEntries([...ticketStatuses].map(status => [status, 0])) as Record<string, number>;
  const byPriority = Object.fromEntries([...ticketPriorities].map(priority => [priority, 0])) as Record<string, number>;
  for (const ticket of tickets) {
    byStatus[ticket.status] = (byStatus[ticket.status] || 0) + 1;
    byPriority[ticket.priority] = (byPriority[ticket.priority] || 0) + 1;
  }
  res.json({
    success: true,
    data: {
      total: tickets.length,
      open: (byStatus.open || 0) + (byStatus['in-progress'] || 0) + (byStatus.replied || 0),
      unassigned: adminViewer ? tickets.filter(ticket => !ticket.assignedTo).length : undefined,
      unread: tickets.filter(ticket => ticket.unread).length,
      byStatus,
      byPriority,
    },
  });
});

ticketRouter.get('/agents', requireAdmin, async (_req: any, res: any) => {
  res.json({ success: true, data: await dbService.getSupportAgents() });
});

// 3. GET /api/tickets/:id — Fetch full ticket thread history with replies
const handleGetTicketDetails = async (req: any, res: any) => {
  const ticketId = req.params.id;
  const details = await dbService.getTicketDetails(ticketId);

  if (details && (isAdmin(req) || String(details.ticket?.userEmail || '').toLowerCase() === String(req.authUser?.email || '').toLowerCase())) {
    res.json({ success: true, data: details });
  } else {
    res.status(404).json({ success: false, error: `Support ticket ${ticketId} not found` });
  }
};
ticketRouter.get('/:id', handleGetTicketDetails);

ticketRouter.post('/:id/read', async (req: any, res: any) => {
  const viewerEmail = req.authUser?.email;
  if (!viewerEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const details = await dbService.getTicketDetails(req.params.id);
  const adminViewer = isAdmin(req);
  if (!details || (!adminViewer && String(details.ticket?.userEmail || '').toLowerCase() !== String(viewerEmail).toLowerCase())) {
    return res.status(404).json({ success: false, error: 'Support ticket not found' });
  }
  const data = await dbService.markTicketRead(details.ticket.id, viewerEmail, adminViewer ? 'admin' : 'client');
  res.json({ success: true, data });
});

ticketRouter.put('/:id/priority', requireAdmin, async (req: any, res: any) => {
  const priority = queryValue(req.body?.priority, 20);
  if (!priority || !ticketPriorities.has(priority)) return res.status(400).json({ success: false, error: 'Invalid ticket priority' });
  const data = await dbService.updateTicketPriority(req.params.id, priority, req.authUser!.email);
  res.json({ success: true, data });
});

ticketRouter.put('/:id/assignment', requireAdmin, async (req: any, res: any) => {
  const assigneeEmail = req.body?.assigneeEmail === null ? null : queryValue(req.body?.assigneeEmail, 255);
  if (assigneeEmail !== null && !assigneeEmail) return res.status(400).json({ success: false, error: 'A valid assignee email or null is required' });
  if (assigneeEmail) {
    const agentExists = (await dbService.getSupportAgents()).some(agent => agent.email.toLowerCase() === assigneeEmail.toLowerCase());
    if (!agentExists) return res.status(400).json({ success: false, error: 'The selected assignee is not an active support agent.' });
  }
  const data = await dbService.assignTicket(req.params.id, assigneeEmail, req.authUser!.email);
  res.json({ success: true, data });
});

// 4. POST /api/tickets/:id/reply — Add reply to ticket
const handleAddReply = async (req: any, res: any) => {
  const ticketId = req.params.id;
  const senderEmail = req.authUser?.email;
  if (!senderEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const senderRole = (isAdmin(req) ? 'admin' : 'client') as 'admin' | 'client';
  const details = await dbService.getTicketDetails(ticketId);
  const ownsTicket = String(details?.ticket?.userEmail || '').toLowerCase() === String(senderEmail).toLowerCase();
  if (!details || (!isAdmin(req) && !ownsTicket)) {
    return res.status(404).json({ success: false, error: `Support ticket ${ticketId} not found` });
  }
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Message body cannot be empty' });
  }

  const reply = await dbService.addTicketReply(ticketId, senderEmail, message.trim(), senderRole);
  
  // Auto-update ticket status based on sender role
  const newStatus = senderRole === 'admin' ? 'replied' : 'open';
  await dbService.updateTicketStatus(ticketId, newStatus, senderEmail);

  res.json({
    success: true,
    message: 'Reply posted to ticket thread in PostgreSQL',
    data: reply,
  });
};
ticketRouter.post('/:id/reply', handleAddReply);
ticketRouter.post('/:id/replies', handleAddReply);

// 5. PUT /api/tickets/:id/status — Update ticket status ('open', 'replied', 'closed')
const handleUpdateStatus = async (req: any, res: any) => {
  const ticketId = req.params.id;
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, error: 'Status is required' });
  }

  const statusValue = String(status).trim();
  if (!ticketStatuses.has(statusValue)) {
    return res.status(400).json({ success: false, error: 'Invalid ticket status' });
  }

  const updated = await dbService.updateTicketStatus(ticketId, statusValue, userEmail);
  
  // updateTicketStatus returns { success, ticketId, status } — fetch the ticket first to email the owner
  try {
    const details = await dbService.getTicketDetails(ticketId);
    if (details?.ticket?.userEmail) {
      emailService.sendTicketUpdate(details.ticket.userEmail, ticketId, statusValue);
    }
  } catch (e) { /* email failures must not break the status update */ }

  res.json({
    success: true,
    message: `Ticket ${ticketId} status updated to ${statusValue}`,
    data: updated,
  });
};
ticketRouter.put('/:id/status', requireAdmin, handleUpdateStatus);
