import React, { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { API_ORIGIN } from '../services/apiClient';

interface VncTerminalProps {
  vmid: number;
  node: string;
  type: 'qemu' | 'lxc';
}

export const VncTerminal: React.FC<VncTerminalProps> = ({ vmid, node, type }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rfb, setRfb] = useState<any>(null);
  const [status, setStatus] = useState<string>('Initializing VNC Proxy...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activeRfb: any = null;

    const initVnc = async () => {
      try {
        const apiHost = API_ORIGIN;
        const apiUrl = new URL(`${apiHost}/api/vnc/init`, window.location.origin);
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vmid, node, type })
        });
        const json = await res.json();
        
        if (!json.success) {
          setError(json.error || 'Failed to initialize VNC proxy');
          return;
        }

        const { ticket, port } = json.data;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsBase = new URL(apiHost || '/', window.location.origin);
        const wsPath = `${wsBase.pathname.replace(/\/$/, '')}/api/vnc/ws`;
        const wsUrl = `${wsProtocol}://${wsBase.host}${wsPath}?node=${node}&vmid=${vmid}&type=${type}&port=${port}&ticket=${encodeURIComponent(ticket)}`;
        
        setStatus('Connecting to WebSocket proxy...');
        
        if (containerRef.current) {
          activeRfb = new RFB(containerRef.current, wsUrl, {
            credentials: { password: ticket },
            wsProtocols: ['binary']
          });

          // Enable noVNC's internal scaling
          activeRfb.scaleViewport = true;
          activeRfb.resizeSession = false;

          activeRfb.addEventListener('connect', () => {
            setStatus('Connected');
          });

          activeRfb.addEventListener('disconnect', (e: any) => {
            setStatus(`Disconnected ${e.detail.clean ? 'cleanly' : 'unexpectedly'}`);
          });

          activeRfb.addEventListener('credentialsrequired', () => {
             activeRfb.sendCredentials({ password: ticket });
          });

          setRfb(activeRfb);
        }
      } catch (err: any) {
        setError(err.message);
      }
    };

    initVnc();

    return () => {
      if (activeRfb) {
        activeRfb.disconnect();
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [vmid, node]);

  const sendCtrlAltDel = () => {
    if (rfb) {
      rfb.sendCtrlAltDel();
    }
  };

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#fef2f2] text-[#991b1b] p-6 font-mono text-sm text-center border border-[#fecaca] rounded-xl">
        <span className="text-3xl mb-3">⚠️</span>
        <span className="font-bold mb-1">VNC Connection Failed</span>
        <span className="text-[#991b1b]/80 text-xs max-w-md">{error}</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col relative bg-[#fbfaf9] border border-[#dedfdf] rounded-xl overflow-hidden">
      {status !== 'Connected' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#fbfaf9]/80 backdrop-blur-sm text-[#1a1a1a] font-mono text-sm">
          <div className="w-5 h-5 border-2 border-[#15803d] border-t-transparent rounded-full animate-spin mb-3"></div>
          {status}
        </div>
      )}
      
      {/* VNC Top Toolbar */}
      <div className="h-10 bg-[#fbfaf9] border-b border-[#dedfdf] flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${status === 'Connected' ? 'bg-[#15803d] shadow-[0_0_8px_#16a34a]' : 'bg-[#eab308]'}`}></span>
          <span className="text-xs font-mono text-[#1a1a1a] font-semibold">{status}</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={sendCtrlAltDel}
            disabled={status !== 'Connected'}
            className="text-[10px] font-mono font-bold bg-white border border-[#dedfdf] text-[#1a1a1a] px-2 py-1 rounded hover:bg-[#f1f1f1] disabled:opacity-50 transition-colors cursor-pointer"
          >
            CTRL+ALT+DEL
          </button>
        </div>
      </div>
      
      {/* VNC Canvas Container */}
      <div 
        ref={containerRef} 
        className="flex-1 w-full h-full bg-[#1a1a1a] relative cursor-crosshair overflow-hidden"
      >
        {/* RFB will inject the canvas here */}
      </div>
    </div>
  );
};
