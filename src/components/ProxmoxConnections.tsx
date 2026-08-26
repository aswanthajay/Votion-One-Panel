import React, { useState, useEffect } from 'react';
import { apiClient, ApiProxmoxConnection } from '../services/apiClient';

export const ProxmoxConnections: React.FC = () => {
  const [connections, setConnections] = useState<ApiProxmoxConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHostIp, setNewHostIp] = useState('');
  const [newPort, setNewPort] = useState(8006);
  const [newTokenId, setNewTokenId] = useState('');
  const [newTokenSecret, setNewTokenSecret] = useState('');
  const [newSslFingerprint, setNewSslFingerprint] = useState('');
    const [isTesting, setIsTesting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Edit Connection State
  const [editTarget, setEditTarget] = useState<ApiProxmoxConnection | null>(null);
  const [editName, setEditName] = useState('');
  const [editHostIp, setEditHostIp] = useState('');
  const [editPort, setEditPort] = useState(8006);
  const [editTokenId, setEditTokenId] = useState('');
  const [editTokenSecret, setEditTokenSecret] = useState('');
  const [editSslFingerprint, setEditSslFingerprint] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const loadConnections = async () => {
    setLoading(true);
    let lastError: unknown;

    for (const delayMs of [0, 500, 1500]) {
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        const data = await apiClient.getProxmoxConnections();
        setConnections(data);
        setLoading(false);
        return;
      } catch (error) {
        lastError = error;
        if (!localStorage.getItem('votion_jwt_token')) {
          setLoading(false);
          return;
        }
      }
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    showToast(`Failed to load cluster connections${detail}`);
    setLoading(false);
  };

  useEffect(() => {
    loadConnections();
  }, []);



  const openEditModal = (conn: ApiProxmoxConnection) => {
    setEditTarget(conn);
    setEditName(conn.name);
    setEditHostIp(conn.host_ip);
    setEditPort(conn.port);
    setEditTokenId(conn.token_id || '');
    // Token secret is masked server-side; leave blank to keep the existing secret
    setEditTokenSecret('');
    setEditSslFingerprint(conn.ssl_fingerprint || '');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    setIsEditing(true);
    try {
      const res = await apiClient.updateProxmoxConnection(editTarget.id, {
        name: editName,
        host_ip: editHostIp,
        port: editPort,
        token_id: editTokenId,
        token_secret: editTokenSecret,
        ssl_fingerprint: editSslFingerprint,
      });
      if (res.success) {
        showToast('Connection updated successfully');
        setEditTarget(null);
        loadConnections();
      } else {
        showToast(res.error || 'Failed to update connection');
      }
    } catch (err) {
      showToast('Error updating connection');
    } finally {
      setIsEditing(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await apiClient.deleteProxmoxConnection(id);
      if (res.success) {
        showToast('Connection deleted');
        loadConnections();
      } else {
        showToast(res.error || 'Failed to delete connection');
      }
    } catch (err) {
      showToast('Error deleting connection');
    }
  };

  const handleTestAndSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsTesting(true);
    showToast('Testing connection to the cluster engine...');
    try {
      // Real connectivity test against the cluster engine (not a simulated delay)
      const testResult = await apiClient.testProxmoxConnection({
        host_ip: newHostIp,
        port: newPort,
        token_id: newTokenId,
        token_secret: newTokenSecret,
        ssl_fingerprint: newSslFingerprint,
      });
      if (!testResult?.success || !testResult?.reachable) {
        showToast(`⚠️ ${testResult?.error || testResult?.reason || 'Connection test failed — check host, port, and API token'}`);
        setIsTesting(false);
        return;
      }
      showToast(testResult?.message || 'Cluster engine reachable.');
      const payload = {
        name: newName,
        host_ip: newHostIp,
        port: newPort,
        token_id: newTokenId,
        token_secret: newTokenSecret,
        ssl_fingerprint: newSslFingerprint,
      };
      const res = await apiClient.addProxmoxConnection(payload);
      if (res.success) {
        showToast('Connection Verified & Saved Successfully!');
        setShowAddModal(false);
        setNewName('');
        setNewHostIp('');
        setNewPort(8006);
        setNewTokenId('');
        setNewTokenSecret('');
        setNewSslFingerprint('');
        loadConnections();
      } else {
        showToast(res.error || 'Connection verification failed');
      }
    } catch (err) {
      showToast('Error testing or saving connection');
    } finally {
      setIsTesting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-white">Loading connections...</div>;
  }

  return (
    <main className="app-content">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="mb-6 p-3 bg-[#1a1a1a] text-white text-xs font-semibold rounded-lg flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse"></span>
            <span>{toastMessage}</span>
          </div>
          <button onClick={() => setToastMessage(null)} className="text-white/60 hover:text-white">✕</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="page-heading mb-1">Cluster Connection Manager</h1>
          <p className="text-xs text-[#656b6b]">Link and authenticate dedicated cluster engines</p>
        </div>
        <button 
          onClick={() => setShowAddModal(true)}
          className="btn-primary cursor-pointer flex items-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
          Add Connection
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {connections.map((conn) => (
          <div key={conn.id} className="bg-white border border-[#dedfdf] rounded-xl p-5 shadow-sm flex flex-col relative group hover:border-[#1a1a1a] transition-colors">
            <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => openEditModal(conn)}
                className="bg-[#eff6ff] text-[#2563eb] hover:bg-[#dbeafe] p-1.5 rounded transition-colors"
                title="Edit Connection"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>
              <button
                onClick={() => {
                  setDeleteTarget(conn.id);
                }}
                className="bg-[#fef2f2] text-[#dc2626] hover:bg-[#fecaca] p-1.5 rounded transition-colors"
                title="Delete Connection"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
              </button>
            </div>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-[#f97316]/10 flex items-center justify-center text-[#ea580c]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
              </div>
              <div>
                <h3 className="font-bold text-base text-[#1a1a1a]">{conn.name}</h3>
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#656b6b]">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#10b981]"></div>
                  {conn.host_ip}:{conn.port}
                </div>
              </div>
            </div>
            
            <div className="text-[11px] text-[#656b6b] space-y-2 font-mono bg-[#f5f6f6] rounded border border-[#dedfdf] p-3 mt-auto">
              <div className="flex justify-between">
                <span className="text-[#656b6b] font-semibold">Token ID:</span>
                <span className="text-[#1a1a1a] truncate max-w-[150px]">{conn.token_id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#656b6b] font-semibold">Fingerprint:</span>
                <span className="text-[#1a1a1a] truncate max-w-[150px]">{conn.ssl_fingerprint || 'N/A'}</span>
              </div>
            </div>
          </div>
        ))}
        
        {connections.length === 0 && (
          <div className="col-span-full border border-dashed border-[#dedfdf] bg-[#f9fafa] rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <svg className="text-[#656b6b] mb-4" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
            <h3 className="text-lg font-bold text-[#1a1a1a] mb-2">No Cluster Connections</h3>
            <p className="text-xs text-[#656b6b] max-w-sm">You haven't linked any cluster engines yet. Add a connection to start syncing nodes and VMs.</p>
          </div>
        )}
      </div>

      {/* Confirm Delete Modal (replaces browser confirm()) */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1001] flex items-center justify-center p-6">
          <div className="w-full max-w-[380px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <h3 className="text-base font-bold text-[#dc2626]">Delete Cluster Connection?</h3>
            <p className="text-xs text-[#656b6b]">This permanently removes the connection record from the panel. VMs already running on the cluster are not affected.</p>
            <div className="flex items-center gap-3">
              <button onClick={() => setDeleteTarget(null)} className="btn-secondary flex-1 py-2 cursor-pointer">Cancel</button>
              <button onClick={async () => {
                const id = deleteTarget;
                setDeleteTarget(null);
                await handleDelete(id);
              }} className="theme-destructive-button btn-primary bg-[#dc2626] hover:bg-[#b91c1c] flex-1 py-2 cursor-pointer">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Connection Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1000] flex items-center justify-center p-6">
          <div className="w-full max-w-[460px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6">
            <h3 className="text-base font-bold text-[#1a1a1a] mb-1">Add Cluster Connection</h3>
            <p className="text-xs text-[#656b6b] mb-6">Enter API credentials to securely link a cluster.</p>

            <form onSubmit={handleTestAndSave} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Cluster / Connection Name</label>
                <input 
                  type="text" 
                  autoComplete="off"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Primary US-East Cluster"
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a]"
                  required
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Host IP / FQDN</label>
                  <input 
                    type="text" 
                    autoComplete="off"
                    value={newHostIp}
                    onChange={(e) => setNewHostIp(e.target.value)}
                    placeholder="10.0.10.1"
                    className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Port</label>
                  <input 
                  type="number" 
                  autoComplete="off"
                  value={newPort}
                    onChange={(e) => setNewPort(parseInt(e.target.value, 10))}
                    className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-[#dedfdf] pt-4 mt-2">
                <div className="col-span-2">
                  <p className="text-[10px] text-[#656b6b] mb-2">VNC functionality relies on API Tokens with Privilege Separation Disabled.</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">API Token ID</label>
                <input 
                  type="text" 
                  autoComplete="off"
                  value={newTokenId}
                  onChange={(e) => setNewTokenId(e.target.value)}
                  placeholder="root@pam!votion_token"
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">API Token Secret</label>
                <input 
                  type="password" 
                  autoComplete="new-password"
                  value={newTokenSecret}
                  onChange={(e) => setNewTokenSecret(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">SSL Fingerprint</label>
                <p className="text-[11px] text-[#656b6b] mb-1">Required for self-signed PVE certificates. Use the server’s SHA-256 fingerprint.</p>
                <input 
                  type="text" 
                  autoComplete="off"
                  value={newSslFingerprint}
                  onChange={(e) => setNewSslFingerprint(e.target.value)}
                  placeholder="SHA256:7B:44:91..."
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                />
              </div>
              
              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[#dedfdf]">
                <button 
                  type="button" 
                  onClick={() => setShowAddModal(false)}
                  disabled={isTesting}
                  className="flex-1 py-2 text-[11px] text-[#656b6b] hover:text-[#1a1a1a] font-semibold transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={isTesting}
                  className="btn-primary flex-1 disabled:opacity-50"
                >
                  {isTesting ? 'Verifying...' : 'Test & Save Connection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    
      {/* Edit Connection Modal */}
      {editTarget !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1002] flex items-center justify-center p-6">
          <div className="w-full max-w-[460px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6">
            <h3 className="text-base font-bold text-[#1a1a1a] mb-1">Edit Cluster Connection</h3>
            <p className="text-xs text-[#656b6b] mb-6">Update the details for <span className="font-semibold text-[#1a1a1a]">{editTarget.name}</span>. Leave sensitive fields blank to keep the existing values.</p>

            <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Cluster / Connection Name</label>
                <input
                    type="text"
                    autoComplete="off"
                    value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a]"
                  required
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Host IP / FQDN</label>
                  <input
                    type="text"
                    autoComplete="off"
                    value={editHostIp}
                    onChange={(e) => setEditHostIp(e.target.value)}
                    className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">Port</label>
                  <input
                    type="number"
                    autoComplete="off"
                    value={editPort}
                    onChange={(e) => setEditPort(parseInt(e.target.value, 10))}
                    className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">API Token ID</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={editTokenId}
                  onChange={(e) => setEditTokenId(e.target.value)}
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">API Token Secret (leave blank to keep)</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={editTokenSecret}
                  onChange={(e) => setEditTokenSecret(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1a1a1a] mb-1">SSL Fingerprint</label>
                <p className="text-[11px] text-[#656b6b] mb-1">Required for self-signed PVE certificates. Use the server’s SHA-256 fingerprint.</p>
                <input
                  type="text"
                  autoComplete="off"
                  value={editSslFingerprint}
                  onChange={(e) => setEditSslFingerprint(e.target.value)}
                  className="w-full bg-white border border-[#dedfdf] rounded p-2 text-xs text-[#1a1a1a] outline-none focus:border-[#1a1a1a] font-mono"
                />
              </div>

              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[#dedfdf]">
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  disabled={isEditing}
                  className="flex-1 py-2 text-[11px] text-[#656b6b] hover:text-[#1a1a1a] font-semibold transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isEditing}
                  className="btn-primary flex-1 disabled:opacity-50"
                >
                  {isEditing ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

</main>
  );
};
