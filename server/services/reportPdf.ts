import PDFDocument from 'pdfkit';
import { dbService, pgPool } from '../db/database.js';
import { proxmoxApi } from './proxmox.js';

// ---------- Palette & helpers ----------
const INK = '#1a1a1a';
const INK_SOFT = '#656b6b';
const ACCENT = '#2563eb';
const ACCENT_SOFT = '#dbeafe';
const GREEN = '#10b981';
const AMBER = '#f59e0b';
const RED = '#ef4444';
const GRAY_LINE = '#dedfdf';
const GRAY_BG = '#fbfaf9';

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtDate(ts: Date | string): string {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function healthColor(pct: number): string {
  if (pct >= 80) return RED;
  if (pct >= 60) return AMBER;
  return GREEN;
}

function chartDataPoints(points: { t: number; v: number }[], maxPoints: number = 60): { t: number; v: number }[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.floor(i * step);
    out.push(points[idx]);
  }
  return out;
}

function drawSparkline(doc: PDFDocument, points: { t: number; v: number }[], x: number, y: number, w: number, h: number, color: string, maxV: number) {
  if (!points || points.length === 0) return;
  const maxVal = maxV > 0 ? maxV : Math.max(...points.map(p => p.v), 1);
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const tSpan = maxT - minT || 1;
  doc.save();
  doc.moveTo(x, y + h);
  doc.rect(x, y, w, h).stroke(GRAY_LINE);
  doc.moveTo(x, y + h - 1);
  points.forEach((p, i) => {
    const px = x + ((p.t - minT) / tSpan) * w;
    const py = y + h - Math.min((p.v / maxVal) * h, h) - 1;
    if (i === 0) doc.moveTo(px, py);
    else doc.lineTo(px, py);
  });
  doc.strokeColor(color).lineWidth(1.2).stroke();
  doc.restore();
}

function sectionHeader(doc: PDFDocument, num: string, title: string, subtitle?: string) {
  doc.moveDown(1);
  const y0 = doc.y;
  doc.rect(doc.page.margins.left - 8, y0 - 4, 8, 22).fill(ACCENT);
  doc.fillColor(ACCENT).fontSize(13).font('Helvetica-Bold').text(`${num}  ${title}`, { continued: false });
  doc.fillColor(INK);
  if (subtitle) {
    doc.fontSize(9).font('Helvetica').fillColor(INK_SOFT).text(subtitle, { lineGap: 3 });
  }
}

function infoBox(doc: PDFDocument, text: string, y0?: number) {
  doc.save();
  const y0b = doc.y;
  const boxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const h = doc.heightOfString(text, { width: boxW - 24, fontSize: 8.5, lineGap: 2, font: 'Helvetica-Oblique' }) + 16;
  if (y0b + h > doc.page.height - 40) doc.addPage();
  doc.fillColor(GRAY_BG).rect(doc.page.margins.left, y0b, boxW, h, 4).fill();
  doc.strokeColor(GRAY_LINE).rect(doc.page.margins.left, y0b, boxW, h, 4).stroke();
  doc.fillColor(INK_SOFT).fontSize(8.5).font('Helvetica-Oblique').text(text, doc.page.margins.left + 12, y0b + 8, {
    width: boxW - 24,
    lineGap: 2,
    align: 'left',
  });
  doc.restore();
  doc.y = y0b + h + 8;
}

function kpiCard(doc: PDFDocument, label: string, value: string, color: string = ACCENT, y0?: number) {
  const cardW = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 16) / 2;
  const baseY = doc.y;
  const x = doc.x;
  doc.save();
  doc.fillColor(GRAY_BG).rect(x, baseY, cardW, 46, 4).fill();
  doc.strokeColor(GRAY_LINE).rect(x, baseY, cardW, 46, 4).stroke();
  doc.fillColor(INK_SOFT).fontSize(8).font('Helvetica').text(label.toUpperCase(), x + 10, baseY + 8, { width: cardW - 20, align: 'left' });
  doc.fillColor(color).fontSize(16).font('Helvetica-Bold').text(value, x + 10, baseY + 24, { width: cardW - 20 });
  doc.restore();
  doc.y = baseY; // keep vertical position stable across cards in the same row
  doc.moveRight(cardW + 16);
}

function row2Kpis(doc: PDFDocument, kpis: { label: string; value: string; color?: string }[]) {
  const startX = doc.page.margins.left;
  doc.save();
  const cardW = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 16) / 2;
  let cx = startX;
  let rowY = doc.y;
  let inRow = 0;
  for (const k of kpis) {
    if (doc.y > doc.page.height - 120) { doc.addPage(); rowY = doc.y; cx = startX; inRow = 0; }
    doc.fillColor(GRAY_BG).rect(cx, rowY, cardW, 46, 4).fill();
    doc.strokeColor(GRAY_LINE).rect(cx, rowY, cardW, 46, 4).stroke();
    doc.fillColor(INK_SOFT).fontSize(8).font('Helvetica').text(k.label.toUpperCase(), cx + 10, rowY + 8, { width: cardW - 20 });
    doc.fillColor(k.color || ACCENT).fontSize(15).font('Helvetica-Bold').text(k.value, cx + 10, rowY + 24, { width: cardW - 20 });
    cx += cardW + 16;
    inRow++;
    if (cx > doc.page.width - doc.page.margins.right) {
      rowY += 56;
      cx = startX;
      inRow = 0;
    }
  }
  doc.restore();
  doc.y = rowY + (inRow > 0 ? 56 : 0);
}

function progressDoc(doc: PDFDocument) {
  if (doc.y > doc.page.height - 120) doc.addPage();
}

// Start a new page for the next section ONLY if the current page is already
// substantially used — prevents blank pages at the end of short sections.
function nextSection(doc: PDFDocument, usedThreshold: number = 420) {
  if (doc.y > usedThreshold) doc.addPage();
  else doc.y = Math.max(doc.y, 20);
}

// ---------- The report ----------
export async function generateMetricsReportPdf(opts: {
  rangeHours: number;
  title?: string;
}) {
  const hours = Math.max(1, Math.min(opts.rangeHours, 720)); // cap at 30 days (720h)
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 72, bottom: 72, left: 56, right: 56 },
    bufferPages: true,
  });

  const now = new Date();
  const since = new Date(now.getTime() - hours * 3600 * 1000);

  // ---------- Data ----------
  const [vms, conns, agg, adminHist, alerts, notifCount] = await Promise.all([
    dbService.getVMs(),
    dbService.getProxmoxConnections(),
    dbService.getNodeTelemetryAggregates(hours),
    dbService.getTelemetryHistory(hours),
    pgPool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical FROM notifications WHERE created_at > NOW() - INTERVAL '1 hour' * $1", [hours]),
    pgPool.query("SELECT COUNT(*)::int AS total FROM notifications"),
  ]);
  let nodes: any[] = [];
  try { nodes = await proxmoxApi.getNodeMetrics(); } catch (e) {}
  const realNodes = (nodes || []).filter((n: any) => !(n as any).simulated);

  // Per-VM telemetry
  const vmTelemetry = new Map<number, any[]>();
  await Promise.all(vms.map(async (vm: any) => {
    try {
      const rows = await dbService.getVmTelemetryHistory(vm.vmid, hours);
      vmTelemetry.set(vm.vmid, rows);
    } catch (e) { vmTelemetry.set(vm.vmid, []); }
  }));

  // ---------- COVER ----------
  doc.fillColor(INK);
  doc.rect(doc.page.margins.left, 52, doc.page.width - doc.page.margins.left - doc.page.margins.right, 6).fill(ACCENT);
  doc.fillColor(INK).fontSize(30).font('Helvetica-Bold').text('Stellar Panel', { align: 'left' });
  doc.fillColor(INK_SOFT).fontSize(12).font('Helvetica').text('Votion One Platform — Stellar Engine Management', { lineGap: 6 });
  doc.moveDown(1);
  doc.fillColor(GRAY_BG).rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 88, 6).fill();
  doc.fillColor(INK).fontSize(18).font('Helvetica-Bold').text(opts.title || 'Infrastructure & Performance Report', doc.page.margins.left + 18, doc.y + 20);
    doc.fillColor(INK_SOFT).fontSize(10).font('Helvetica').text(`Generated ${fmtDate(now)}  ·  Data window: ${fmtDate(since)} to ${fmtDate(now)}`, doc.page.margins.left + 18, doc.y + 52);
  doc.fillColor(INK_SOFT).fontSize(10).font('Helvetica').text(`Coverage: ${Math.round(hours)} hours (${(hours / 24).toFixed(1)} days)  ·  Source: PostgreSQL telemetry store`, doc.page.margins.left + 18, doc.y + 70);
  doc.moveDown(1.2);

  doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text('What is inside this report');
  doc.fillColor(INK_SOFT).fontSize(10).font('Helvetica').text(
    'This report is written to serve everyone — from someone seeing server metrics for the first time, to an experienced operator. ' +
    'Section 1 explains the environment you manage. Section 2 explains what each metric actually means in plain language. ' +
    'Section 3 shows cluster-wide trends over your chosen window. Section 4 dives into every virtual machine, one by one. ' +
    'Section 5 summarizes events and alerts the system detected, and Section 6 explains the data pipeline itself, so you can trust the numbers.',
    { lineGap: 4 }
  );
  doc.addPage();

  // ---------- SECTION 1: INFRASTRUCTURE ----------
  sectionHeader(doc, '1', 'Your infrastructure at a glance', 'The environment this report covers — hardware, network identity, and software versions.');
  const conn = (conns || [])[0];
  const infra = [
    ['Cluster endpoint', 'cluster-stellar-01.votioncloud.org'],
    ['Connection name', conn?.name || '—'],
    ['Platform version', realNodes[0]?.platformVersion || 'N/A'],
    ['Compute engine', 'Stellar Engine (KVM + LXC)'],
  ];
  for (const [k, v] of infra) {
    doc.fillColor(INK_SOFT).fontSize(9).font('Helvetica').text(k, doc.page.margins.left, doc.y + 4, { width: 150 });
    doc.fillColor(INK).fontSize(9).font('Helvetica-Bold').text(String(v), doc.page.margins.left + 150, doc.y + 4, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 150 });
    doc.y += 17;
    if (doc.y > doc.page.height - 90) { doc.addPage(); }
  }
  doc.moveDown(0.5);
  infoBox(doc,
    'Reading this section: each server in your infrastructure is called a node. Stellar Engine is a proprietary virtualization platform that turns a physical server into a hypervisor — a machine that can run many smaller virtual machines (VMs) at the same time. ' +
    'Your panel connects to the cluster API (the internal web service Stellar Engine exposes) to read live metrics.'
  );
  doc.moveDown(0.4);
  if (realNodes.length > 0) {
    for (const n of realNodes) {
      doc.fillColor(INK).fontSize(12).font('Helvetica-Bold').text(n.nodeName);
      row2Kpis(doc, [
        { label: 'CPU usage', value: `${n.cpuUsagePct}%`, color: healthColor(Number(n.cpuUsagePct)) },
        { label: 'Cores', value: String(n.cpuCores || '—') },
        { label: 'RAM used', value: `${Math.round(Number(n.ramUsageBytes) / 1073741824)} / ${Math.round(Number(n.ramTotalBytes) / 1073741824)} GB`, color: healthColor(Number(n.ramUsageBytes) / Math.max(Number(n.ramTotalBytes), 1) * 100) },
        { label: 'Uptime', value: fmtDuration(Number(n.uptimeSeconds)) },
        { label: 'Storage used', value: `${n.storageUsageGb} / ${n.storageTotalGb} GB` },
        { label: 'Root filesystem', value: `${n.rootUsedGb} / ${n.rootTotalGb} GB` },
      ]);
    }
  }
  nextSection(doc);

  // ---------- SECTION 2: METRICS GLOSSARY ----------
  sectionHeader(doc, '2', 'Understanding the metrics', 'Plain-language definitions — no prior knowledge required.');
  const glossary: [string, string, string][] = [
    ['CPU %', 'Processor usage', 'The share of the server\'s total computing power being used right now. 0% means idle; 100% means fully loaded. Averages below ~60% are comfortable; sustained spikes above 90% usually mean something heavy is running or the server needs more cores.'],
    ['RAM (Memory)', 'Working memory', 'The fast, temporary storage a VM uses for active data. Unlike disk space, RAM is limited: when a VM uses all its RAM it starts swapping to disk, which is much slower. "Peak" is the highest point in your window; "average" is the typical load.'],
    ['Network In / Out', 'Data transferred', 'Bytes received (in) and sent (out) over the network. In the charts these are shown as cumulative counters — the line rising means traffic is flowing; the amount it rose in an hour is that hour\'s transfer volume.'],
    ['Disk Read / Write', 'Storage activity', 'How much data the VM read from or wrote to its virtual disks. High, sustained disk writes often indicate backups, database activity, or log-heavy applications.'],
    ['Telemetry', 'The data pipeline', 'Every 15 seconds, the panel asks the cluster for the live numbers of each running VM and stores them in PostgreSQL. This is what feeds every chart, alert, and export — nothing is fabricated.'],
  ];
  for (const [term, short, long] of glossary) {
    doc.fillColor(ACCENT).fontSize(11).font('Helvetica-Bold').text(term, { continued: true });
    doc.fillColor(INK_SOFT).fontSize(11).font('Helvetica').text(` — ${short}`, { continued: false });
    doc.fillColor(INK_SOFT).fontSize(9.5).font('Helvetica').text(long, { lineGap: 3 });
    doc.moveDown(0.3);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  nextSection(doc);
  infoBox(doc,
    'For advanced readers: all values come from the cluster platform\'s /status/current endpoint (RRD-backed counters for network and disk). CPU is a 0–1 ratio converted to percent. ' +
    'RAM is reported in bytes. Network/disk counters are monotonic since VM boot — transfers within the window are computed as last-minus-first sample per bucket.'
  );
  nextSection(doc);

  // ---------- SECTION 3: CLUSTER OVERVIEW ----------
  sectionHeader(doc, '3', 'Cluster-wide performance', `Aggregated across all ${vms.length} VMs for the selected window. Sparklines show the trend — an upward slope means growing load.`);
  // compute cluster aggregates from adminHist
  let cpuVals: number[] = [], ramVals: number[] = [], inVals: number[] = [], outVals: number[] = [], dR = 0, dW = 0;
  adminHist.forEach((r: any) => {
    cpuVals.push(Number(r.cpu_pct) || 0);
    ramVals.push(Number(r.ram_bytes) || 0);
  });
  const sortedIn = [...adminHist].sort((a: any, b: any) => Number(new Date(a.timestamp)) - Number(new Date(b.timestamp)));
  if (sortedIn.length > 1) {
    inVals = sortedIn.map((r: any) => Number(r.net_in_bytes) || 0);
    outVals = sortedIn.map((r: any) => Number(r.net_out_bytes) || 0);
    // Cumulative counters can reset (e.g. on a reboot mid-window). Summing the
    // strictly-positive deltas between consecutive samples gives the true
    // transfer volume regardless of resets, instead of naive last-minus-first.
    let inTotal = 0, outTotal = 0, dRTotal = 0, dWTotal = 0;
    for (let i = 1; i < sortedIn.length; i++) {
      const prev = sortedIn[i - 1], cur = sortedIn[i];
      inTotal += Math.max(0, Number(cur.net_in_bytes || 0) - Number(prev.net_in_bytes || 0));
      outTotal += Math.max(0, Number(cur.net_out_bytes || 0) - Number(prev.net_out_bytes || 0));
      dRTotal += Math.max(0, Number(cur.diskread_bytes || 0) - Number(prev.diskread_bytes || 0));
      dWTotal += Math.max(0, Number(cur.diskwrite_bytes || 0) - Number(prev.diskwrite_bytes || 0));
    }
    dR = dRTotal; dW = dWTotal;
  }
  const avgCpu = cpuVals.length ? +(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length).toFixed(1) : 0;
  const peakCpu = cpuVals.length ? +Math.max(...cpuVals).toFixed(1) : 0;
  const minCpu = cpuVals.length ? +Math.min(...cpuVals).toFixed(1) : 0;
  const avgRamGb = ramVals.length ? (ramVals.reduce((a, b) => a + b, 0) / ramVals.length / 1073741824).toFixed(1) : '0';
  const peakRamGb = ramVals.length ? (Math.max(...ramVals) / 1073741824).toFixed(1) : '0';
  let totalIn = 0, totalOut = 0;
  for (let i = 1; i < inVals.length; i++) totalIn += Math.max(0, inVals[i] - inVals[i - 1]);
  for (let i = 1; i < outVals.length; i++) totalOut += Math.max(0, outVals[i] - outVals[i - 1]);

  row2Kpis(doc, [
    { label: 'Avg CPU (all VMs)', value: `${avgCpu}%`, color: healthColor(avgCpu) },
    { label: 'Peak CPU', value: `${peakCpu}%`, color: healthColor(peakCpu) },
    { label: 'Min CPU', value: `${minCpu}%` },
    { label: 'Avg RAM', value: `${avgRamGb} GB` },
    { label: 'Peak RAM', value: `${peakRamGb} GB`, color: AMBER },
    { label: 'Net received', value: fmtBytes(totalIn), color: GREEN },
    { label: 'Net sent', value: fmtBytes(totalOut), color: ACCENT },
    { label: 'Disk read / write', value: `${fmtBytes(dR)} / ${fmtBytes(dW)}` },
  ]);

  doc.moveDown(0.3);
  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('CPU trend (average across VMs, sparkline)');
  const cpuPts = chartDataPoints(adminHist.map((r: any, i: number) => ({ t: i, v: Number(r.cpu_pct) || 0 })));
  const maxCpuV = Math.max(...cpuPts.map(p => p.v), 1);
  drawSparkline(doc, cpuPts, doc.page.margins.left, doc.y + 6, doc.page.width - doc.page.margins.left - doc.page.margins.right, 54, ACCENT, maxCpuV);
  doc.y += 70;
  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('RAM trend (bytes, sparkline)');
  const ramPts = chartDataPoints(adminHist.map((r: any, i: number) => ({ t: i, v: Number(r.ram_bytes) || 0 })));
  const maxRamV = Math.max(...ramPts.map(p => p.v), 1);
  drawSparkline(doc, ramPts, doc.page.margins.left, doc.y + 6, doc.page.width - doc.page.margins.left - doc.page.margins.right, 54, GREEN, maxRamV);
  doc.y += 70;
  infoBox(doc,
    'How to interpret: the CPU sparkline shows the rolling average load of every VM combined. If the line hugs the bottom, your fleet is under-utilized; a line that stays above 70–80% is a signal to plan capacity. ' +
    'RAM usually stays flat for a VM (applications hold their working set) — a sudden step change means an app started or stopped.'
  );
  doc.addPage();

  // ---------- SECTION 4: PER-VM ----------
  sectionHeader(doc, '4', 'Virtual machine detail', 'One block per VM with its own summary, sparklines, and guidance. VMs are ordered by VMID.');
  for (const vm of vms) {
    progressDoc(doc);
    const rows = vmTelemetry.get(vm.vmid) || [];
    const vAgg = (agg as any[]).find((a: any) => Number(a.vmid) === vm.vmid);
    const vmRecord = vm as any;
    const vmLabel = vmRecord.vm_name || vmRecord.name || `Unnamed VM ${vm.vmid}`;
    doc.fillColor(INK).fontSize(12).font('Helvetica-Bold').text(`VMID ${vm.vmid} — ${vmLabel}`);
    doc.fillColor(INK_SOFT).fontSize(8.5).font('Helvetica-Oblique').text(
      `${(vm as any).status || 'unknown'} · owner ${(vm as any).ownerEmail || (vm as any).owner_email || '—'} · maxmem ${fmtBytes(Number((vm as any).maxmem) || 0)}` +
      (rows.length === 0 ? '  ·  NO TELEMETRY IN WINDOW (VM may have been stopped)' : '')
    );
    doc.y += 12;

    if (rows.length > 0 && vAgg) {
      const maxMem = Number((vm as any).maxmem) || 1;
      // Proxmox reports this guest's memory in units that exceed the allocation
      // (RRD scaling quirk), so percentages are clamped to a sensible 0–100 range.
      const avgRamPct = +Math.min(100, Number(vAgg.avg_ram_bytes) / maxMem * 100).toFixed(1);
      const peakRamPct = +Math.min(100, Number(vAgg.peak_ram_bytes) / maxMem * 100).toFixed(1);
      row2Kpis(doc, [
        { label: 'Samples collected', value: String(rows.length) },
        { label: 'Avg / peak CPU', value: `${vAgg.avg_cpu}% / ${vAgg.peak_cpu}%`, color: healthColor(Number(vAgg.peak_cpu)) },
        { label: 'Avg / peak RAM', value: `${avgRamPct}% / ${peakRamPct}% of ${Math.round(maxMem / 1073741824)} GB`, color: healthColor(peakRamPct) },
        { label: 'Net in / out', value: `${fmtBytes(Number(vAgg.total_net_in_bytes))} / ${fmtBytes(Number(vAgg.total_net_out_bytes))}` },
      ]);
      doc.moveDown(0.2);
      doc.fillColor(INK).fontSize(9.5).font('Helvetica-Bold').text('CPU trend');
      const vCpuPts = chartDataPoints(rows.map((r: any, i: number) => ({ t: i, v: Number(r.cpu_pct) || 0 })));
      drawSparkline(doc, vCpuPts, doc.page.margins.left, doc.y + 5, doc.page.width - doc.page.margins.left - doc.page.margins.right, 40, ACCENT, Math.max(...vCpuPts.map(p => p.v), 1));
      doc.y += 52;
      doc.fillColor(INK).fontSize(9.5).font('Helvetica-Bold').text('RAM usage (bytes)');
      const vRamPts = chartDataPoints(rows.map((r: any, i: number) => ({ t: i, v: Number(r.ram_bytes) || 0 })));
      drawSparkline(doc, vRamPts, doc.page.margins.left, doc.y + 5, doc.page.width - doc.page.margins.left - doc.page.margins.right, 40, GREEN, Math.max(...vRamPts.map(p => p.v), 1));
      doc.y += 52;

      // Plain-language guidance per VM
      const guidance = [];
      if (Number(vAgg.peak_cpu) > 80) guidance.push('CPU peaked above 80% — check what workload caused the spike; consider more cores if this is regular.');
      if (peakRamPct > 85) guidance.push(`RAM reached ${peakRamPct}% of its ${Math.round(maxMem / 1073741824)} GB allocation — this VM is close to its limit; raising maxmem avoids swapping.`);
      if (Number(vAgg.peak_cpu) < 20 && peakRamPct < 30) guidance.push('Lightly used — this VM has headroom to take on more workload, or its allocation could be downsized to save resources.');
      if (guidance.length === 0) guidance.push('Operating within normal bounds for the selected window.');
      infoBox(doc, 'Assessment: ' + guidance.join(' '));
    } else {
      infoBox(doc, 'No telemetry samples were recorded for this VM during the window. This usually means the VM was stopped or suspended for the whole period — a stopped VM has no metrics to record, and the panel never invents them.');
    }
    doc.moveDown(0.4);
  }
  nextSection(doc);

  // ---------- SECTION 5: ALERTS & EVENTS ----------
  sectionHeader(doc, '5', 'Events and alerts detected', `Notifications recorded by the panel's alerting engine during the window. Alerts are fired when live metrics cross thresholds you configure.`);
  const alertTotal = (alerts.rows[0] || {}).total || 0;
  const criticalCount = (alerts.rows[0] || {}).critical || 0;
  row2Kpis(doc, [
    { label: 'Alerts this window', value: String(alertTotal), color: criticalCount > 0 ? RED : GREEN },
    { label: 'Critical alerts', value: String(criticalCount), color: criticalCount > 0 ? RED : GREEN },
    { label: 'Total in system', value: String((notifCount.rows[0] || {}).total || 0) },
    { label: 'VMs monitored', value: String(vms.length) },
  ]);
  if (alertTotal > 0) {
    const res = await pgPool.query(
      "SELECT title, message, severity, created_at FROM notifications WHERE created_at > NOW() - INTERVAL '1 hour' * $1 ORDER BY created_at DESC LIMIT 25",
      [hours]
    );
    doc.moveDown(0.3);
    doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('Most recent alerts');
    doc.moveDown(0.2);
    for (const n of res.rows) {
      const sev = String(n.severity || 'warning').toLowerCase();
      const sevColor = sev === 'critical' ? RED : sev === 'info' ? ACCENT : AMBER;
      progressDoc(doc);
      doc.fillColor(sevColor).fontSize(8).font('Helvetica-Bold').text(`● ${sev.toUpperCase()}`, { continued: true });
      doc.fillColor(INK).fontSize(9).font('Helvetica-Bold').text(String(n.title), { continued: true });
      doc.fillColor(INK_SOFT).fontSize(8).font('Helvetica').text(`  ${fmtDate(n.created_at)}`, { continued: false });
      doc.fillColor(INK_SOFT).fontSize(8.5).font('Helvetica').text(String(n.message), { lineGap: 2 });
      doc.moveDown(0.2);
    }
  } else {
    infoBox(doc, 'No alerts were triggered during this window — every live metric stayed inside its thresholds. This is the healthy baseline the system aims to maintain.');
  }
  nextSection(doc);

  // ---------- SECTION 6: DATA PIPELINE ----------
  sectionHeader(doc, '6', 'How the data is collected and stored', 'Why you can trust these numbers: an explanation of the telemetry pipeline, for transparency.');
  const totalSamples = (await pgPool.query('SELECT COUNT(*)::int AS t FROM vm_telemetry')).rows[0]?.t || 0;
  const firstSample = (await pgPool.query('SELECT MIN(timestamp)::text AS t FROM vm_telemetry')).rows[0]?.t || '—';
  const perVm = (await pgPool.query('SELECT vmid, COUNT(*)::int AS c FROM vm_telemetry GROUP BY vmid ORDER BY 1')).rows;
  const perVmText = perVm.map((r: any) => `VMID ${r.vmid}: ${r.c} samples`).join('   ·   ');
  doc.fillColor(INK_SOFT).fontSize(10).font('Helvetica').text(
    'Every 15 seconds, the panel asks the cluster for the live status of each running virtual machine. The raw numbers — CPU load, memory, network counters, and disk counters — are written directly into the PostgreSQL database (table vm_telemetry), timestamped at the moment of collection. ' +
    'Charts, alerts, and exports all read from this same table, so what you see in the dashboard and what ends up in this PDF is one and the same dataset. ' +
    'The panel never invents, interpolates, or smooths data: if a VM is stopped, no samples exist for it, and the report says so plainly.',
    { lineGap: 5 }
  );
  doc.moveDown(0.5);
  row2Kpis(doc, [
    { label: 'Total samples in database', value: String(totalSamples), color: GREEN },
    { label: 'Recording since', value: fmtDate(firstSample) },
    { label: 'Polling interval', value: '15 seconds' },
    { label: 'Samples per VM', value: perVmText.slice(0, 60) + (perVmText.length > 60 ? '…' : '') },
  ]);
  infoBox(doc,
    'Advanced note: the cluster engine exposes CPU as a 0–1 ratio, memory and counters in bytes, and network/disk as cumulative counters since VM boot. Transfer volumes in a window are computed by summing the positive step changes between consecutive samples, which stays correct even if a VM reboots mid-window. ' +
    'Duplicate samples are rejected by the database (unique constraint on VM + timestamp), so a restarted panel can never double-count history.'
  );

  // ---------- FOOTER (page numbers, drawn inline) ----------
  // Drawn in the 'pageAdded' handler so every page — including ones that PDFKit
  // flushes from its edit buffer — gets its footer at creation time. This avoids
  // the switchToPage() approach, which produced blank footer-only pages at the
  // end of the document because flushed pages were re-edited out of order.
  // pdfkit 0.19 emits 'pageAdded' with no arguments; use bufferedPageCount as
  // the total (pages are buffered until the final write) and derive the number
  // from the current buffer index.
  let pageCount = 0;
  doc.on('pageAdded', () => {
    pageCount++;
    if (pageCount === 1) return; // cover page has no footer
    doc.moveTo(56, doc.page.height - 50).lineTo(doc.page.width - 56, doc.page.height - 50).strokeColor(GRAY_LINE).stroke();
    doc.fillColor(INK_SOFT).fontSize(8).font('Helvetica').text(
      `Stellar Panel — Performance Report  ·  Page ${pageCount}  ·  Generated ${fmtDate(now)}`,
      56, doc.page.height - 40, { width: doc.page.width - 112, align: 'center' }
    );
  });

  return doc;
}