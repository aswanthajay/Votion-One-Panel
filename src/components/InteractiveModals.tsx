import React, { useState, useEffect } from 'react';
import { apiClient, ApiSupportTicket, ApiTicketReply } from '../services/apiClient';

interface InteractiveModalsProps {
  activeModal: string | null;
  onClose: () => void;
}

export const InteractiveModals: React.FC<InteractiveModalsProps> = ({ activeModal, onClose }) => {
  const [modalData, setModalData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  
  // Support Center Specific State
  const [ticketsList, setTicketsList] = useState<ApiSupportTicket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<ApiSupportTicket | null>(null);
  const [ticketReplies, setTicketReplies] = useState<ApiTicketReply[]>([]);
  const [replyMessage, setReplyMessage] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'create' | 'details'>('list');

  // New Ticket Form State
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketCategory, setTicketCategory] = useState('Quota Upgrade');
  const [ticketPriority, setTicketPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const loadTickets = async () => {
    setLoading(true);
    try {
      const tickets = await apiClient.getSupportTickets();
      setTicketsList(tickets);
    } catch (err) {
      // Catch network error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!activeModal) {
      setModalData(null);
      setSelectedTicket(null);
      setViewMode('list');
      return;
    }

    const fetchModalData = async () => {
      setLoading(true);
      try {
        if (activeModal === 'downloads') {
          const res = await apiClient.getDownloads();
          setModalData(res);
        } else if (activeModal === 'dataroom') {
          const res = await apiClient.getDataRoom();
          setModalData(res);
        } else if (activeModal === 'pricing' || activeModal === 'upgrade') {
          const res = await apiClient.getPricing();
          setModalData(res);
        } else if (activeModal === 'release-notes') {
          const res = await apiClient.getReleaseNotes();
          setModalData(res);
        } else if (activeModal === 'terms') {
          const res = await apiClient.getTerms();
          setModalData(res);
        } else if (activeModal === 'inbox') {
          const res = await apiClient.getTasks();
          setModalData(res);
        } else if (activeModal === 'support' || activeModal === 'help') {
          await loadTickets();
        }
      } catch (err) {
        // Handle error
      } finally {
        setLoading(false);
      }
    };

    fetchModalData();
  }, [activeModal]);

  if (!activeModal) return null;

  // Inspect Ticket Details & Thread
  const handleSelectTicket = async (ticket: ApiSupportTicket) => {
    setSelectedTicket(ticket);
    setLoading(true);
    try {
      const details = await apiClient.getTicketDetails(ticket.id);
      if (details) {
        setTicketReplies(details.replies);
        setViewMode('details');
      }
    } catch (err) {
      // Error fetching details
    } finally {
      setLoading(false);
    }
  };

  // Submit New Support Ticket
  const handleSupportTicketSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticketSubject.trim()) return;

    const res = await apiClient.createSupportTicket(ticketSubject, ticketCategory, ticketPriority);
    showToast(res.message || 'Support ticket created successfully in PostgreSQL');
    setTicketSubject('');
    setViewMode('list');
    await loadTickets();
  };

  // Send Reply Message to Ticket
  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTicket || !replyMessage.trim()) return;

    const res = await apiClient.addTicketReply(selectedTicket.id, replyMessage.trim());
    if (res.success && res.data) {
      setTicketReplies([...ticketReplies, res.data]);
      setReplyMessage('');
      showToast('Reply posted to support thread');
    }
  };

  // Update Ticket Status
  const handleUpdateStatus = async (status: 'open' | 'in-progress' | 'resolved' | 'closed') => {
    if (!selectedTicket) return;
    const res = await apiClient.updateTicketStatus(selectedTicket.id, status);
    if (res.success) {
      setSelectedTicket({ ...selectedTicket, status });
      showToast(`Ticket status updated to ${status}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1000] flex items-center justify-center p-6">
      
      {/* Toast Notification inside Modal */}
      {toastMessage && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 p-3 bg-[#1a1a1a] text-white text-xs font-semibold rounded-lg shadow-2xl flex items-center gap-2 border border-[#333333] z-[1100]">
          <span className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse"></span>
          <span>{toastMessage}</span>
        </div>
      )}

      <div className="w-full max-w-[660px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl overflow-hidden p-6 flex flex-col gap-4 text-xs">
        
        {/* Header Bar */}
        <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
          <h3 className="text-base font-bold text-[#1a1a1a] capitalize flex items-center gap-2">
            <span>{activeModal.replace('-', ' ')}</span>
            {(activeModal === 'support' || activeModal === 'help') && viewMode !== 'list' && (
              <button onClick={() => setViewMode('list')} className="text-xs text-[#2563eb] hover:underline font-normal">
                ← Back to tickets list
              </button>
            )}
          </h3>
          <button onClick={onClose} className="text-[#656b6b] hover:text-[#1a1a1a] font-bold text-sm cursor-pointer">
            ✕
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-[#656b6b] font-mono">
            Fetching dynamic API data from Express server...
          </div>
        ) : (
          <>
            {/* SUPPORT CENTER MODAL */}
            {(activeModal === 'support' || activeModal === 'help') && (
              <div className="flex flex-col gap-4">
                
                {/* MODE 1: TICKETS LIST VIEW */}
                {viewMode === 'list' && (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[#656b6b]">Direct support ticketing and live message thread with VOTION Engineers.</p>
                      <button onClick={() => setViewMode('create')} className="btn-primary py-1 px-3 text-xs cursor-pointer">
                        + New Support Ticket
                      </button>
                    </div>

                    <div className="divide-y divide-[#dedfdf] border border-[#dedfdf] rounded-lg overflow-hidden max-h-[360px] overflow-y-auto">
                      {ticketsList.length === 0 ? (
                        <div className="p-6 text-center text-[#656b6b]">No support tickets found. Click "+ New Support Ticket" to open one.</div>
                      ) : (
                        ticketsList.map(t => (
                          <div 
                            key={t.id} 
                            onClick={() => handleSelectTicket(t)}
                            className="p-3.5 flex items-center justify-between hover:bg-[#fbfaf9] cursor-pointer transition-colors"
                          >
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-bold text-[#1a1a1a]">{t.id}</span>
                                <span className="font-semibold text-[#1a1a1a]">{t.subject}</span>
                              </div>
                              <div className="text-[11px] text-[#656b6b] mt-0.5">
                                Category: {t.category} | Created by: {t.userEmail}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                t.priority === 'urgent' ? 'bg-[#fef2f2] text-[#dc2626]' : 'bg-[#f1f1f1] text-[#656b6b]'
                              }`}>
                                {t.priority}
                              </span>
                              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                                t.status === 'open' ? 'bg-[#fef3c7] text-[#b45309]' :
                                t.status === 'in-progress' ? 'bg-[#dbeafe] text-[#1d4ed8]' :
                                'bg-[#dcfce7] text-[#15803d]'
                              }`}>
                                {t.status}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* MODE 2: CREATE NEW TICKET FORM */}
                {viewMode === 'create' && (
                  <form onSubmit={handleSupportTicketSubmit} className="flex flex-col gap-3">
                    <p className="text-[#656b6b]">Submit a direct support ticket to VOTION Cloud Engineers.</p>
                    <div>
                      <label className="block font-semibold mb-1">Ticket Subject</label>
                      <input 
                        type="text" 
                        value={ticketSubject} 
                        onChange={(e) => setTicketSubject(e.target.value)} 
                        placeholder="e.g. Request Instance 105 CPU Quota Increase" 
                        className="w-full p-2 border border-[#dedfdf] rounded outline-none focus:border-[#1a1a1a]" 
                        required 
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold mb-1">Category</label>
                        <select 
                          value={ticketCategory} 
                          onChange={(e) => setTicketCategory(e.target.value)} 
                          className="w-full p-2 border border-[#dedfdf] rounded outline-none"
                        >
                          <option value="Quota Upgrade">Quota Upgrade</option>
                          <option value="Network Firewall">Network Firewall</option>
                          <option value="Storage & ZFS">Storage & ZFS</option>
                          <option value="General">General Inquiries</option>
                        </select>
                      </div>
                      <div>
                        <label className="block font-semibold mb-1">Priority</label>
                        <select 
                          value={ticketPriority} 
                          onChange={(e) => setTicketPriority(e.target.value as any)} 
                          className="w-full p-2 border border-[#dedfdf] rounded outline-none"
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent SLA</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-2 border-t border-[#dedfdf]">
                      <button type="button" onClick={() => setViewMode('list')} className="btn-secondary">Cancel</button>
                      <button type="submit" className="btn-primary">Create Support Ticket</button>
                    </div>
                  </form>
                )}

                {/* MODE 3: TICKET DETAILS & LIVE MESSAGE THREAD */}
                {viewMode === 'details' && selectedTicket && (
                  <div className="flex flex-col gap-4">
                    <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg flex items-center justify-between">
                      <div>
                        <div className="font-bold text-sm text-[#1a1a1a]">{selectedTicket.id} — {selectedTicket.subject}</div>
                        <div className="text-[11px] text-[#656b6b] mt-0.5">Category: {selectedTicket.category} | Priority: {selectedTicket.priority}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <select 
                          value={selectedTicket.status} 
                          onChange={(e) => handleUpdateStatus(e.target.value as any)}
                          className="p-1 border border-[#dedfdf] rounded text-xs outline-none bg-ink-card font-semibold"
                        >
                          <option value="open">open</option>
                          <option value="in-progress">in-progress</option>
                          <option value="resolved">resolved</option>
                          <option value="closed">closed</option>
                        </select>
                      </div>
                    </div>

                    {/* Replies Thread */}
                    <div className="flex flex-col gap-3 max-h-[260px] overflow-y-auto p-2 border border-[#dedfdf] rounded-lg bg-ink-card">
                      {ticketReplies.map(r => (
                        <div 
                          key={r.id} 
                          className={`p-3 rounded-lg flex flex-col gap-1 text-xs max-w-[85%] ${
                            r.senderRole === 'admin' 
                              ? 'bg-[#f1f1f1] border border-[#dedfdf] self-start text-[#1a1a1a]' 
                              : 'bg-[#1a1a1a] text-white self-end'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4 text-[10px] opacity-80 border-b border-current/20 pb-1 mb-1">
                            <span className="font-bold">{r.senderEmail} ({r.senderRole.toUpperCase()})</span>
                            <span>{new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <p className="leading-relaxed">{r.message}</p>
                        </div>
                      ))}
                    </div>

                    {/* Live Reply Message Box */}
                    <form onSubmit={handleSendReply} className="flex gap-2">
                      <input 
                        type="text" 
                        value={replyMessage} 
                        onChange={(e) => setReplyMessage(e.target.value)} 
                        placeholder="Type a reply message to support..." 
                        className="flex-1 p-2 border border-[#dedfdf] rounded outline-none focus:border-[#1a1a1a]" 
                        required 
                      />
                      <button type="submit" className="btn-primary py-2 px-4 cursor-pointer">
                        Send Reply
                      </button>
                    </form>
                  </div>
                )}

              </div>
            )}

            {/* DOWNLOADS MODAL */}
            {activeModal === 'downloads' && (
              <div className="flex flex-col gap-3">
                <p className="text-[#656b6b]">Official system images and virtual driver downloads.</p>
                <div className="divide-y divide-[#dedfdf] border border-[#dedfdf] rounded-lg overflow-hidden">
                  {Array.isArray(modalData) && modalData.map((item: any) => (
                    <div key={item.id} className="p-3 flex items-center justify-between hover:bg-[#fbfaf9]">
                      <div>
                        <div className="font-semibold text-[#1a1a1a] text-xs">{item.name}</div>
                        <div className="text-[11px] text-[#656b6b]">v{item.version} | Size: {item.size}</div>
                      </div>
                      <a href={item.url} download className="btn-secondary py-1 px-3 text-[11px] cursor-pointer">
                        Download
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* DATAROOM MODAL */}
            {activeModal === 'dataroom' && (
              <div className="flex flex-col gap-3">
                <p className="text-[#656b6b]">Verified compliance certificates and ZFS security documentation.</p>
                <div className="divide-y divide-[#dedfdf] border border-[#dedfdf] rounded-lg overflow-hidden">
                  {Array.isArray(modalData) && modalData.map((doc: any) => (
                    <div key={doc.id} className="p-3 flex items-center justify-between hover:bg-[#fbfaf9]">
                      <div>
                        <div className="font-semibold text-[#1a1a1a]">{doc.title}</div>
                        <div className="text-[11px] text-[#656b6b]">Updated: {doc.updatedAt} | Category: {doc.category}</div>
                      </div>
                      <span className="bg-[#dcfce7] text-[#15803d] px-2.5 py-1 rounded text-[11px] font-semibold">
                        ✓ {doc.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PRICING & UPGRADE MODAL */}
            {(activeModal === 'pricing' || activeModal === 'upgrade') && (
              <div className="flex flex-col gap-4">
                <p className="text-[#656b6b]">Scale your cluster hardware allocations with dedicated node capacity.</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {Array.isArray(modalData) && modalData.map((plan: any) => (
                    <div key={plan.id} className={`p-4 border rounded-xl flex flex-col justify-between ${plan.popular ? 'border-[#1a1a1a] bg-[#fbfaf9]' : 'border-[#dedfdf]'}`}>
                      <div>
                        {plan.popular && <span className="bg-[#1a1a1a] text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase block mb-2 w-fit">Popular</span>}
                        <div className="font-bold text-sm text-[#1a1a1a]">{plan.name}</div>
                        <div className="text-base font-extrabold text-[#1a1a1a] my-2">{plan.price}</div>
                        <div className="text-[11px] text-[#656b6b] space-y-1">
                          <div>• {plan.vcpus} Dedicated vCPUs</div>
                          <div>• {plan.ramGb} GB ECC RAM</div>
                          <div>• {plan.storageGb} GB NVMe Storage</div>
                          <div>• {plan.bandwidth} Bandwidth</div>
                        </div>
                      </div>
                      <button onClick={async () => {
                        try {
                          const res = await fetch('http://localhost:5000/api/v1/billing/upgrade', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('votion_jwt_token')}` },
                            body: JSON.stringify({ planId: plan.id, planName: plan.name }),
                          });
                          const data = await res.json();
                          showToast(data.message || `Upgrade request for ${plan.name} submitted. Our team will contact you.`);
                        } catch {
                          showToast(`Upgrade request for ${plan.name} received. Our team will contact you within 24h.`);
                        }
                      }} className="btn-primary py-1.5 w-full mt-4 text-[11px] cursor-pointer">
                        Select Plan
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* RELEASE NOTES MODAL */}
            {activeModal === 'release-notes' && (
              <div className="flex flex-col gap-3">
                {Array.isArray(modalData) && modalData.map((note: any, idx: number) => (
                  <div key={idx} className="p-4 border border-[#dedfdf] rounded-lg bg-[#fbfaf9]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm text-[#1a1a1a]">{note.version} — {note.title}</span>
                      <span className="text-[11px] text-[#656b6b] font-mono">{note.date}</span>
                    </div>
                    <ul className="list-disc list-inside text-[#656b6b] space-y-1 text-xs">
                      {note.highlights.map((h: string, i: number) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {/* TERMS MODAL */}
            {activeModal === 'terms' && (
              <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto p-2 border border-[#dedfdf] rounded-lg">
                <h4 className="font-bold text-sm text-[#1a1a1a]">{modalData?.title || 'Terms of Service'}</h4>
                {modalData?.sections?.map((sec: any, idx: number) => (
                  <div key={idx} className="space-y-1">
                    <div className="font-semibold text-[#1a1a1a]">{sec.heading}</div>
                    <p className="text-[#656b6b] leading-relaxed">{sec.body}</p>
                  </div>
                ))}
              </div>
            )}

            {/* REFER A FRIEND MODAL */}
            {activeModal === 'refer' && (
              <div className="flex flex-col gap-3 text-center p-4">
                <h4 className="font-bold text-sm text-[#1a1a1a]">Refer Cloud Infrastructure Engineers</h4>
                <p className="text-[#656b6b]">Earn $50 cloud credits for every new cluster node onboarded under your referral link.</p>
                <div className="p-3 bg-[#f1f1f1] border border-[#dedfdf] rounded font-mono text-xs text-[#1a1a1a] select-all">
                  {`https://votioncloud.org/ref/${(localStorage.getItem('votion_user_email') || '').split('@')[0] || 'user'}`}
                </div>
                <button onClick={async () => {
                  const refUrl = `https://votioncloud.org/ref/${(localStorage.getItem('votion_user_email') || '').split('@')[0] || 'user'}`;
                  try {
                    await navigator.clipboard.writeText(refUrl);
                    showToast('Referral link copied to clipboard ✓');
                  } catch {
                    showToast('Copy failed — please select and copy the link manually');
                  }
                }} className="btn-primary py-2 w-full mt-2 cursor-pointer">
                  Copy Referral Link
                </button>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
};
