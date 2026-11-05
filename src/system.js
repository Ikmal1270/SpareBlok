const os = require('os');
const fs = require('fs');
const path = require('path');
const { runPowerShell, round1 } = require('./util');
const { fetchText } = require('./net');

const GB = 1024 ** 3;

function getSystemInfo() {
  const cpus = os.cpus();
  return {
    totalMemGB: round1(os.totalmem() / GB),
    freeMemGB: round1(os.freemem() / GB),
    cpuCores: cpus.length,
    cpuModel: (cpus[0]?.model || 'Unknown CPU').replace(/\(R\)|\(TM\)|CPU|\s+@.*$/g, '').replace(/\s+/g, ' ').trim(),
    cpuSpeedMHz: cpus[0]?.speed || 0,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    osRelease: os.release(),
  };
}

// Walk up until we find an existing folder so statfs works before the server dir exists.
function existingAncestor(p) {
  let current = path.resolve(p);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function getDiskSpace(dirPath) {
  try {
    const stats = fs.statfsSync(existingAncestor(dirPath));
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return {
      total: round1(total / GB),
      free: round1(free / GB),
      used: round1((total - free) / GB),
      drive: path.parse(path.resolve(dirPath)).root,
    };
  } catch (e) {
    return { total: 0, free: 0, used: 0, drive: '' };
  }
}

// SSD vs HDD matters a lot for chunk loading on old PCs.
const diskTypeCache = new Map();
async function getDiskType(dirPath) {
  const letter = path.parse(path.resolve(dirPath)).root.replace(/[:\\/]/g, '').toUpperCase();
  if (!letter || process.platform !== 'win32') return 'Unknown';
  if (diskTypeCache.has(letter)) return diskTypeCache.get(letter);
  const script = `$n=(Get-Partition -DriveLetter ${letter} -ErrorAction Stop | Get-Disk).Number; ` +
    `$d=Get-PhysicalDisk | Where-Object { $_.DeviceId -eq "$n" } | Select-Object -First 1; ` +
    `Write-Output "$($d.MediaType)|$($d.BusType)"`;
  const res = await runPowerShell(script, 12000);
  const [media = '', bus = ''] = res.stdout.trim().split('|');
  let type = 'Unknown';
  if (/SSD/i.test(media) || /NVMe/i.test(bus)) type = /NVMe/i.test(bus) ? 'NVMe SSD' : 'SSD';
  else if (/HDD/i.test(media)) type = 'HDD';
  diskTypeCache.set(letter, type);
  return type;
}

// Rough single-thread score. Minecraft's main tick loop is single-threaded, so
// single-core speed is what limits player count on old CPUs.
// Calibrated so a Ryzen 5 5600X scores ~100.
let cpuScoreCache = null;
function getCpuScore() {
  if (cpuScoreCache) return cpuScoreCache;
  const arr = new Float64Array(4096);
  const bench = (ms) => {
    const end = Date.now() + ms;
    let it = 0;
    let x = 0;
    while (Date.now() < end) {
      for (let i = 0; i < 4096; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = Math.sqrt(x) + arr[(i * 7) & 4095] * 0.5;
      }
      it++;
    }
    return it / ms;
  };
  bench(80); // warm up the JIT
  const best = Math.max(bench(250), bench(250));
  cpuScoreCache = Math.max(5, Math.round(best / 0.44));
  return cpuScoreCache;
}

// System-wide CPU usage from os.cpus() deltas (no external process needed).
let lastCpuTimes = null;
function sampleSystemCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  let percent = 0;
  if (lastCpuTimes) {
    const dTotal = total - lastCpuTimes.total;
    const dIdle = idle - lastCpuTimes.idle;
    percent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  }
  lastCpuTimes = { idle, total };
  return Math.max(0, Math.min(100, percent));
}

function getLocalAddresses() {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        result.push({ name, address: a.address });
      }
    }
  }
  // Prefer typical home LAN ranges first.
  result.sort((a, b) => Number(/^192\.168\./.test(b.address)) - Number(/^192\.168\./.test(a.address)));
  return result;
}

// IPv4 first: most players' networks can't reach an IPv6-only address.
let publicIpCache = null;
async function getPublicIp() {
  if (publicIpCache && Date.now() - publicIpCache.time < 10 * 60 * 1000) return publicIpCache.ip;
  for (const url of ['https://api4.ipify.org', 'https://ipv4.icanhazip.com', 'https://api.ipify.org']) {
    try {
      const ip = (await fetchText(url, { timeout: 6000 })).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        publicIpCache = { ip, time: Date.now() };
        return ip;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

const FIREWALL_RULE = 'SpareBlok Minecraft Server';
const LEGACY_FIREWALL_RULES = ['MCHost Minecraft Server', 'DIY MC Hosting Minecraft Server']; // rules created before the renames still count

// `bedrockPort` (UDP only) is set while Bedrock players can join through Geyser.
async function getFirewallStatus(port, bedrockPort = null) {
  if (process.platform !== 'win32') return { supported: false };
  const res = await runPowerShell(
    `Get-NetFirewallRule -DisplayName ${[FIREWALL_RULE, ...LEGACY_FIREWALL_RULES].map((r) => `'${r}*'`).join(',')} -ErrorAction SilentlyContinue | ` +
    `Get-NetFirewallPortFilter | Select-Object -ExpandProperty LocalPort`, 15000);
  const ports = res.stdout.split(/\s+/).filter(Boolean);
  const allowed = ports.includes(String(port)) && (!bedrockPort || ports.includes(String(bedrockPort)));
  return { supported: true, allowed };
}

// Firewall rules need admin rights, so this triggers a UAC prompt.
async function addFirewallRule(port, bedrockPort = null) {
  const rules = [['TCP', port], ['UDP', port]];
  if (bedrockPort) rules.push(['UDP', bedrockPort]);
  const inner = rules.map(([proto, p]) =>
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE} ${proto} ${p}' -Direction Inbound -Protocol ${proto} -LocalPort ${p} -Action Allow -Profile Any`,
  ).join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const res = await runPowerShell(
    `try { Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; 'ok' } catch { 'cancelled' }`,
    60000);
  if (!res.stdout.includes('ok')) return { success: false, error: 'Administrator permission was not granted' };
  const status = await getFirewallStatus(port, bedrockPort);
  return status.allowed ? { success: true } : { success: false, error: 'Rule could not be created' };
}

module.exports = {
  getSystemInfo, getDiskSpace, getDiskType, getCpuScore, sampleSystemCpu,
  getLocalAddresses, getPublicIp, getFirewallStatus, addFirewallRule,
};
