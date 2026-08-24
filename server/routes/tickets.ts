import { Router } from 'express';
import { dbService } from '../db/database.js';
import { emailService } from '../services/email.js';
import { requireAdmin, requireAuth } from '../middleware.js';

export const ticketRouter = Router();
ticketRouter.use(requireAuth);

const adminRoles = new Set(['administrator', 'admin', 'moderator']);
const ticketStatuses = new Set(['open', 'in-progress', 'replied', 'resolved', 'closed']);
const isAdmin = (req: any) => adminRoles.has(req.authUser?.role);

// 1. POST /api/tickets — Create a new support ticket
const handleCreateTicket = async (req: any, res: any) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { subject, category, priority, vmid, message } = req.body;

  if (!subject || !subject.trim()) {
    return res.status(400).json({ success: false, error: 'Subject is required' });
  }

  const parsedVmid = vmid ? parseInt(String(vmid), 10) : undefined;
  const ticket = await dbService.createSupportTicket(subject.trim(), category || 'General', priority || 'medium', parsedVmid, userEmail);

  // createSupportTicket returns { ticket, replies }; use the nested ticket.id
  const ticketId = ticket?.ticket?.id;
  if (message && message.trim() && ticketId) {
    await dbService.addTicketReply(ticketId, userEmail, message.trim(), 'client');
  }

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
  const filterEmail = isAdmin(req) ? undefined : userEmail;

  const tickets = await dbService.getSupportTickets(filterEmail);
  res.json({ success: true, count: tickets.length, data: tickets });
};
ticketRouter.get('/', handleGetTickets);

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
