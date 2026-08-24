export interface ProxmoxVmMetadataInterface {
  name: string;
  macAddress: string | null;
  bridge: string | null;
  ipAddress: string | null;
  gateway: string | null;
  source: 'cloud-init' | 'guest-agent' | 'proxmox-config';
}

export interface ProxmoxVmMetadata {
  network: {
    source: 'cloud-init' | 'guest-agent' | 'proxmox-config' | 'unavailable';
    primaryIp: string | null;
    configuredIp: string | null;
    gateway: string | null;
    macAddress: string | null;
    interfaces: ProxmoxVmMetadataInterface[];
    guestAgentAvailable: boolean;
  };
  hardware: {
    type: 'qemu' | 'lxc';
    vcpus: number | null;
    sockets: number | null;
    coresPerSocket: number | null;
    memoryMb: number | null;
    ballooning: boolean | null;
    machine: string | null;
    bios: string | null;
    cpuType: string | null;
    bootOrder: string | null;
    disks: Array<{
      device: string;
      storage: string | null;
      sizeGb: number | null;
    }>;
    networkAdapters: number;
    qemuGuestAgent: boolean | null;
    osType: string | null;
    features: string[];
  };
  fetchedAt: string;
}

interface ParsedOptionMap {
  [key: string]: string;
}

interface GuestAgentInterface {
  name?: string;
  'hardware-address'?: string;
  'ip-addresses'?: Array<{ 'ip-address'?: string; 'ip-address-type'?: string }>;
}

const parseOptions = (value: unknown): ParsedOptionMap => {
  const options: ParsedOptionMap = {};
  String(value || '').split(',').forEach(part => {
    const separator = part.indexOf('=');
    if (separator <= 0) return;
    const key = part.slice(0, separator).trim().toLowerCase();
    const optionValue = part.slice(separator + 1).trim();
    if (key && optionValue) options[key] = optionValue;
  });
  return options;
};

const cleanIp = (value: unknown): string | null => {
  const ip = String(value || '').trim();
  if (!ip || /^(dhcp|manual|auto|none)$/i.test(ip)) return null;
  return ip.split('/')[0] || null;
};

const parseSizeGb = (value: unknown): number | null => {
  const match = String(value || '').trim().match(/([\d.]+)\s*([kmgtp]?)(?:i?b)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'T' ? 1024 : unit === 'G' ? 1 : unit === 'M' ? 1 / 1024 : unit === 'K' ? 1 / (1024 * 1024) : unit === 'P' ? 1024 * 1024 : 1 / (1024 * 1024 * 1024);
  return Number((amount * multiplier).toFixed(2));
};

const parseDisk = (device: string, value: unknown) => {
  const raw = String(value || '').split(',');
  const volume = raw.shift() || '';
  const storage = volume.includes(':') ? volume.split(':')[0] : null;
  const options = parseOptions(raw.join(','));
  return {
    device,
    storage,
    sizeGb: parseSizeGb(options.size),
  };
};

const getGuestAgentIp = (entry: GuestAgentInterface): string | null => {
  const addresses = Array.isArray(entry['ip-addresses']) ? entry['ip-addresses'] : [];
  const ipv4 = addresses.find(address => address['ip-address-type'] === 'ipv4' && !String(address['ip-address'] || '').startsWith('127.'));
  return cleanIp(ipv4?.['ip-address']);
};

export function mapProxmoxVmMetadata(
  config: Record<string, unknown>,
  type: 'qemu' | 'lxc',
  guestAgentInterfaces: GuestAgentInterface[] = [],
): ProxmoxVmMetadata {
  const cloudInitKeys = Object.keys(config).filter(key => /^ipconfig\d+$/.test(key)).sort();
  const networkKeys = Object.keys(config).filter(key => /^net\d+$/.test(key)).sort();
  const cloudInitInterfaces: ProxmoxVmMetadataInterface[] = cloudInitKeys.map(ipconfigKey => {
    const index = ipconfigKey.replace('ipconfig', '');
    const ipOptions = parseOptions(config[ipconfigKey]);
    const netOptions = parseOptions(config[`net${index}`]);
    const macAddress = netOptions.virtio || netOptions.e1000 || netOptions.rtl8139 || netOptions.vmxnet3 || netOptions.macaddr || null;
    return {
      name: `net${index}`,
      macAddress,
      bridge: netOptions.bridge || null,
      ipAddress: cleanIp(ipOptions.ip),
      gateway: cleanIp(ipOptions.gw),
      source: 'cloud-init',
    };
  });

  const configInterfaces: ProxmoxVmMetadataInterface[] = networkKeys
    .filter(key => !cloudInitInterfaces.some(entry => entry.name === key))
    .map(key => {
      const options = parseOptions(config[key]);
      return {
        name: key,
        macAddress: options.virtio || options.e1000 || options.rtl8139 || options.vmxnet3 || options.macaddr || null,
        bridge: options.bridge || null,
        ipAddress: null,
        gateway: null,
        source: 'proxmox-config',
      };
    });

  const guestInterfaces = guestAgentInterfaces.map(entry => ({
    name: String(entry.name || 'interface'),
    macAddress: String(entry['hardware-address'] || '').trim() || null,
    bridge: null,
    ipAddress: getGuestAgentIp(entry),
    gateway: null,
    source: 'guest-agent' as const,
  })).filter(entry => entry.ipAddress || entry.macAddress);

  const interfaces = cloudInitInterfaces.length > 0 ? cloudInitInterfaces : configInterfaces;
  const primaryGuestInterface = guestInterfaces.find(entry => entry.ipAddress) || guestInterfaces[0];
  const primaryConfiguredInterface = interfaces.find(entry => entry.ipAddress) || interfaces[0];
  const primaryIp = primaryGuestInterface?.ipAddress || primaryConfiguredInterface?.ipAddress || null;
  const configuredIp = primaryConfiguredInterface?.ipAddress || null;
  const gateway = primaryConfiguredInterface?.gateway || null;
  const macAddress = primaryConfiguredInterface?.macAddress || primaryGuestInterface?.macAddress || null;
  const mergedInterfaces = interfaces.map(entry => {
    const agentMatch = guestInterfaces.find(agent => agent.macAddress && entry.macAddress && agent.macAddress.toLowerCase() === entry.macAddress.toLowerCase());
    return agentMatch?.ipAddress ? { ...entry, ipAddress: agentMatch.ipAddress } : entry;
  });
  const displayedInterfaces = mergedInterfaces.length > 0 ? mergedInterfaces : guestInterfaces;

  const coresPerSocket = Number(config.cores) || null;
  const sockets = Number(config.sockets) || (coresPerSocket ? 1 : null);
  const configuredVcpus = Number(config.vcpus);
  const vcpus = Number.isFinite(configuredVcpus) && configuredVcpus > 0
    ? configuredVcpus
    : coresPerSocket && sockets ? coresPerSocket * sockets : null;
  const diskKeys = Object.keys(config).filter(key => type === 'lxc' ? key === 'rootfs' : /^(scsi|virtio|sata|ide)\d+$/.test(key)).sort();
  const agentValue = config.agent;
  const qemuGuestAgent = type === 'qemu'
    ? (agentValue === undefined ? null : Boolean(Number(agentValue) || agentValue === true || String(agentValue).startsWith('1')))
    : null;

  return {
    network: {
      source: cloudInitInterfaces.length > 0 ? 'cloud-init' : guestInterfaces.length > 0 ? 'guest-agent' : configInterfaces.length > 0 ? 'proxmox-config' : 'unavailable',
      primaryIp,
      configuredIp,
      gateway,
      macAddress,
      interfaces: displayedInterfaces,
      guestAgentAvailable: guestInterfaces.length > 0,
    },
    hardware: {
      type,
      vcpus,
      sockets,
      coresPerSocket,
      memoryMb: Number(config.memory) > 0 ? Number(config.memory) : null,
      ballooning: config.balloon === undefined ? null : Boolean(Number(config.balloon)),
      machine: String(config.machine || '').trim() || null,
      bios: String(config.bios || '').trim() || null,
      cpuType: String(config.cpu || '').trim() || null,
      bootOrder: String(config.boot || '').trim() || null,
      disks: diskKeys.map(key => parseDisk(key, config[key])),
      networkAdapters: networkKeys.length,
      qemuGuestAgent,
      osType: String(config.ostype || '').trim() || null,
      features: String(config.features || '').split(';').map(value => value.trim()).filter(Boolean),
    },
    fetchedAt: new Date().toISOString(),
  };
}
