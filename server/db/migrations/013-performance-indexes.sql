-- 013-performance-indexes.sql
-- Adds missing indexes for high-traffic relational foreign keys and sorting columns to prevent full-table scans.

-- Ticket system
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket_id ON ticket_replies (ticket_id, created_at ASC);

-- Audit logs (heavily queried by user_email and timestamp)
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_timestamp ON audit_logs (user_email, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs (timestamp DESC);

-- Notifications (polled frequently by the frontend via inbox)
CREATE INDEX IF NOT EXISTS idx_notifications_account_created ON notifications (account_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (account_email, is_read) WHERE is_read = false;


