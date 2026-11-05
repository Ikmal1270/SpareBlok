// ================================================
// SpareBlok - Minecraft Server Manager
// Renderer Process Application Logic
// ================================================

// --- State ---
let currentConfig = {};
let systemInfo = {};
let javaInstalls = [];
let presets = { jvm: {}, profiles: {}, loaders: {} };
let capacityResult = null;
let serverState = 'offline';
let onlinePlayers = [];
let currentFilePath = '';
let commandHistory = [];
let historyIndex = -1;
let selectedType = 'paper';
let versionCache = {};
let modSearch = { list: 'recommended', query: '', offset: 0, total: 0, key: '' };
let modSearchToken = 0;
let restartPending = false;
let joinOptions = null;
let bedrockLanPort = null;
let installedModIds = new Set();
let perfDirty = false;
let lanAddress = '';
let publicIp = '';
let lastStats = null;
let brandInfo = { appName: 'SpareBlok', shortName: 'SpareBlok', version: '' };
let playitState = { phase: 'off' };
let playitEnabled = false;
const chartData = { cpu: [], ram: [] };
const CHART_POINTS = 90;
const MAX_CONSOLE_LINES = 1000;

const TYPE_LABELS = { vanilla: 'Vanilla', paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const LIMIT_LABELS = { ram: 'RAM', cpu: 'CPU', disk: 'Disk', network: 'Network' };
const LIMIT_ICONS = { ram: 'fa-memory', cpu: 'fa-microchip', disk: 'fa-hdd', network: 'fa-wifi' };
const STATE_LABELS = { offline: 'Offline', starting: 'Starting...', online: 'Online', stopping: 'Stopping...' };

const TOGGLES = [
  ['whitelist', 'Whitelist', 'Only whitelisted players can join', false],
  ['pvp', 'PVP', 'Allow players to attack each other', true],
  ['hardcore', 'Hardcore', 'Players are banned upon death', false],
  ['allowFlight', 'Allow Flight', 'Don\'t kick players for flying (needed by some mods)', false],
  ['forceGamemode', 'Force Gamemode', 'Put players in the default gamemode on join', false],
  ['enableCommandBlock', 'Command Blocks', 'Enable command block usage', false],
  ['allowNether', 'Allow Nether', 'Allow players to travel to the Nether', true],
  ['spawnAnimals', 'Spawn Animals', 'Allow passive mobs to spawn', true],
  ['spawnMonsters', 'Spawn Monsters', 'Allow hostile mobs to spawn', true],
  ['spawnNpcs', 'Spawn Villagers', 'Allow villagers to spawn', true],
  ['generateStructures', 'Generate Structures', 'Generate villages, temples, etc. in new chunks', true],
  ['autoRestart', 'Auto-Restart on Crash', 'Restart the server automatically if it crashes', true],
];

const JVM_HINTS = {
  lowend: 'Serial GC: lowest overhead. Best for 1-2 GB heaps or dual-core CPUs.',
  default: 'G1 garbage collector with sane defaults. Good all-rounder.',
  aikar: 'Tuned G1 flags used by most server hosts. Best for 4 GB+ heaps.',
  custom: 'Write your own flags. -Xmx/-Xms are controlled by the sliders above.',
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  buildToggles();
  try {
    const [cfg, p, version, status, history] = await Promise.all([
      mchost.getConfig(), mchost.getPresets(), mchost.getBrand(),
      mchost.getServerStatus(), mchost.getConsoleHistory(),
    ]);
    currentConfig = cfg;
    presets = p;
    selectedType = cfg.installedType || cfg.serverType || 'paper';
    brandInfo = version;
    document.getElementById('appVersion').textContent = 'v' + brandInfo.version;
    document.getElementById('joinMessagePreview').textContent = brandInfo.joinMessage;
    document.title = brandInfo.appName;
    serverState = status.state;
    onlinePlayers = status.players || [];
    if (Array.isArray(history) && history.length) appendConsole(history.join('\n'));

    highlightTheme();
    updateDashboard();
    updatePropertiesPage();
    updateModLoaderPage();
    updateServerStatus();
    loadMcVersions(selectedType);
    refreshPlayit();

    systemInfo = await mchost.getSystemInfo();
    updatePerformancePage();
    updateHardwareCards();
    refreshCapacity();
    refreshJava();
    refreshNetworkSummary();
    refreshModsCount();

    if (!currentConfig.launch) {
      document.getElementById('setupNotice').classList.remove('hidden');
      if (!currentConfig.setupComplete) openSetupWizard();
    }
  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Failed to initialize: ' + err.message, 'error');
  }
});

function setupEventListeners() {
  // Performance sliders
  const bindSlider = (id, valueId, fmt, onChange) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      document.getElementById(valueId).textContent = fmt(el.value);
      onChange?.();
      markPerfDirty();
    });
  };
  bindSlider('maxRamSlider', 'maxRamValue', (v) => v + ' GB', () => {
    const max = parseFloat(document.getElementById('maxRamSlider').value);
    const min = document.getElementById('minRamSlider');
    if (parseFloat(min.value) > max) {
      min.value = max;
      document.getElementById('minRamValue').textContent = max + ' GB';
    }
    updateRamVisual();
  });
  bindSlider('minRamSlider', 'minRamValue', (v) => v + ' GB', () => {
    const max = parseFloat(document.getElementById('maxRamSlider').value);
    const min = document.getElementById('minRamSlider');
    if (parseFloat(min.value) > max) {
      min.value = max;
      document.getElementById('minRamValue').textContent = max + ' GB';
    }
  });
  bindSlider('viewDistSlider', 'viewDistValue', (v) => v, () => {
    const vd = parseInt(document.getElementById('viewDistSlider').value, 10);
    const sim = document.getElementById('simDistSlider');
    if (parseInt(sim.value, 10) > vd) {
      sim.value = vd;
      document.getElementById('simDistValue').textContent = vd;
    }
    highlightProfile();
  });
  bindSlider('simDistSlider', 'simDistValue', (v) => v, () => {
    const vd = document.getElementById('viewDistSlider');
    const sim = document.getElementById('simDistSlider');
    if (parseInt(sim.value, 10) > parseInt(vd.value, 10)) {
      vd.value = sim.value;
      document.getElementById('viewDistValue').textContent = sim.value;
    }
    highlightProfile();
  });
  document.getElementById('uploadMbps').addEventListener('input', markPerfDirty);
  document.getElementById('processPriority').addEventListener('change', markPerfDirty);
  document.getElementById('jvmArgs').addEventListener('input', () => {
    markPerfDirty();
    highlightJvmPreset(detectJvmPreset(document.getElementById('jvmArgs').value));
  });

  document.getElementById('propMotd').addEventListener('input', renderMotdPreview);
  document.getElementById('mcVersionSelect').addEventListener('change', updateVersionHint);

  // Drag & drop .jar files onto the mods list
  const drop = document.getElementById('modList');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const paths = [...e.dataTransfer.files].map((f) => mchost.getPathForFile(f)).filter((p) => /\.jar$/i.test(p));
    if (!paths.length) return showToast('Only .jar files can be added', 'warning');
    const res = await mchost.addModFiles(paths);
    if (res.success) {
      showToast(`Added ${res.added.length} file(s)`, 'success');
      refreshMods();
    } else showToast(res.error, 'error');
  });

  // Delegated clicks for dynamic lists
  document.getElementById('modList').addEventListener('click', onModListClick);
  document.getElementById('modSearchResults').addEventListener('click', onSearchResultClick);
  document.getElementById('browseTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-list]');
    if (btn) browseMods(btn.dataset.list);
  });
  document.getElementById('joinOptions').addEventListener('change', onJoinOptionChange);
  document.getElementById('joinOptions').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="login-plugin"]')) installLoginPlugin();
  });
  document.getElementById('fileList').addEventListener('click', onFileListClick);
  document.getElementById('fileBreadcrumb').addEventListener('click', (e) => {
    const item = e.target.closest('[data-path]');
    if (item) navigateFiles(item.dataset.path);
  });
  document.getElementById('worldList').addEventListener('click', onWorldListClick);
  document.getElementById('backupList').addEventListener('click', onBackupListClick);
  for (const id of ['onlinePlayers', 'opsList', 'whitelistList', 'bannedList']) {
    document.getElementById(id).addEventListener('click', onPlayerListClick);
  }
  document.getElementById('lanAddresses').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) copyText(btn.dataset.copy);
  });

  // Main process events
  mchost.onServerOutput((data) => appendConsole(data));
  mchost.onServerState((s) => {
    serverState = s.state;
    restartPending = !!s.restartPending;
    if (s.players) onlinePlayers = s.players;
    document.getElementById('restartNotice').classList.toggle('hidden', !s.restartPending);
    updateServerStatus();
    if (s.state === 'online') showToast('Server is online', 'success');
    if (s.state === 'offline' && s.crashed) showToast('Server crashed - check the console', 'error');
    if (s.state === 'offline') refreshFilesIfVisible();
    updateFolderPanel();
  });
  mchost.onPlayers((list) => {
    onlinePlayers = list;
    updatePlayerCount();
    if (isPageActive('players')) refreshPlayers();
  });
  mchost.onStats(updateStats);
  mchost.onPlayitState((s) => {
    const wasOnline = playitState.phase === 'online';
    renderPlayit(s);
    if (s.phase === 'online' && !wasOnline) showToast(`Internet address ready: ${s.address}`, 'success');
  });
  mchost.onTaskProgress(updateTaskProgress);
  mchost.onConfirmClose(() => requestClose());
  mchost.onQuitting(() => showToast('Stopping the server before exiting...', 'info'));

  window.addEventListener('resize', drawChart);
}

// --- Navigation ---
function navigateTo(page) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.removeAttribute('aria-current'));
  const target = document.getElementById('page-' + page);
  target?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.setAttribute('aria-current', 'page');
  document.getElementById('content').scrollTop = 0;
  // Move focus to the new page heading so screen readers announce the change.
  const heading = target?.querySelector('h1');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  document.title = `${heading?.textContent || brandInfo.shortName} - ${brandInfo.appName}`;

  if (page === 'files') refreshFiles();
  if (page === 'players') refreshPlayers();
  if (page === 'performance') updateRamVisual();
  if (page === 'mods') refreshMods();
  if (page === 'properties') refreshJoinOptions();
  if (page === 'worlds') refreshWorlds();
  if (page === 'backups') refreshBackups();
  if (page === 'network') refreshNetwork();
  if (page === 'dashboard') drawChart();
}

function isPageActive(page) {
  return document.getElementById('page-' + page)?.classList.contains('active');
}

// --- Dashboard ---
function updateDashboard() {
  const cfg = currentConfig;
  const type = cfg.installedType || cfg.serverType;
  document.getElementById('sidebarServerName').textContent = cfg.serverName || 'My Server';
  document.getElementById('heroName').textContent = cfg.serverName || 'My Minecraft Server';
  document.getElementById('heroSub').textContent = cfg.launch
    ? `${TYPE_LABELS[type]} ${cfg.installedVersion}${cfg.loaderVersion ? `, loader ${cfg.loaderVersion}` : ''}. Port ${cfg.port}. ${capitalizeFirst(cfg.gamemode)}, ${cfg.difficulty}.`
    : 'No server installed yet';
  document.getElementById('setupNotice').classList.toggle('hidden', !!cfg.launch);
  updatePlayerCount();
  updateJoinAddress();
}

function updatePlayerCount() {
  document.getElementById('metricPlayers').textContent = `${onlinePlayers.length} / ${currentConfig.maxPlayers || 0}`;
  document.getElementById('metricPlayersDetail').textContent = capacityResult
    ? `about ${capacityResult.estimate.recommended} recommended`
    : 'slots';
  document.getElementById('navPlayersCount').textContent = onlinePlayers.length || '';
  renderDashPlayers();
}

function renderDashPlayers() {
  const box = document.getElementById('dashPlayers');
  document.getElementById('dashPlayersCount').textContent = onlinePlayers.length;
  if (!onlinePlayers.length) {
    box.innerHTML = `<div class="list-empty">${serverState === 'online' ? 'No one is online yet. Share the join address.' : 'Server is offline'}</div>`;
    return;
  }
  box.innerHTML = onlinePlayers.map((name) => `
    <div class="player-item">
      <img class="player-head" src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/32" alt="" onerror="this.style.visibility='hidden'">
      <div class="player-info"><span class="player-name">${escapeHtml(name)}</span></div>
    </div>`).join('');
}

// The single address the host should share: playit tunnel > LAN.
function updateJoinAddress() {
  const address = document.getElementById('joinAddress');
  const source = document.getElementById('joinSource');
  const hint = document.getElementById('joinHint');
  if (playitState.phase === 'online' && playitState.address) {
    address.textContent = playitState.address;
    source.innerHTML = '<span class="tag good">Internet</span>';
    hint.textContent = 'Anyone can join with this address through playit.gg.';
  } else if (lanAddress) {
    address.textContent = lanAddress + portSuffix();
    source.innerHTML = '<span class="tag">Same Wi-Fi only</span>';
    hint.innerHTML = 'Friends elsewhere can\'t join yet. <a class="link" onclick="navigateTo(\'network\')">Set up internet access</a>';
  } else {
    address.textContent = 'No network';
    source.textContent = '';
    hint.textContent = 'Connect this PC to a network to host.';
  }
}

function updateStats(s) {
  lastStats = s;
  const maxRamMB = parseRamGB(currentConfig.maxRam) * 1024;
  const running = s.state !== 'offline';
  const ramPct = running ? Math.min(100, (s.procMemMB / maxRamMB) * 100) : (s.sysMemUsedGB / s.sysMemTotalGB) * 100;

  document.getElementById('metricCpu').textContent = (running ? s.procCpu : s.sysCpu) + '%';
  document.getElementById('metricCpuDetail').textContent = running ? `server, system at ${s.sysCpu}%` : 'system, server off';
  document.getElementById('metricRam').textContent = running ? formatMB(s.procMemMB) : `${s.sysMemUsedGB} GB`;
  document.getElementById('metricRamDetail').textContent = running
    ? `of ${currentConfig.maxRam.replace('G', ' GB')} allocated`
    : `of ${s.sysMemTotalGB} GB system RAM`;
  document.getElementById('metricUptime').textContent = running ? formatDuration(s.uptime) : '--';
  document.getElementById('metricUptimeDetail').textContent = running ? 'since last start' : 'server offline';
  document.getElementById('legendCpu').textContent = (running ? s.procCpu : s.sysCpu) + '%';
  document.getElementById('legendRam').textContent = Math.round(ramPct) + '%';

  chartData.cpu.push(running ? s.procCpu : s.sysCpu);
  chartData.ram.push(ramPct);
  if (chartData.cpu.length > CHART_POINTS) {
    chartData.cpu.shift();
    chartData.ram.shift();
  }
  if (isPageActive('dashboard')) drawChart();
}

function drawChart() {
  const canvas = document.getElementById('perfChart');
  if (!canvas || !canvas.offsetParent) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  ctx.strokeStyle = styles.getPropertyValue('--chart-grid').trim();
  ctx.lineWidth = 1;
  ctx.fillStyle = styles.getPropertyValue('--text-3').trim();
  ctx.font = '11px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  for (const pct of [0, 50, 100]) {
    const y = h - 14 - (pct / 100) * (h - 24);
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(pct + '%', 0, y + 3);
  }

  const line = (data, color) => {
    if (data.length < 2) return;
    const step = (w - 30) / (CHART_POINTS - 1);
    const offset = CHART_POINTS - data.length;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = 30 + (i + offset) * step;
      const y = h - 14 - (v / 100) * (h - 24);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const lastX = 30 + (data.length - 1 + offset) * step;
    ctx.lineTo(lastX, h - 14);
    ctx.lineTo(30 + offset * step, h - 14);
    ctx.closePath();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  line(chartData.ram, styles.getPropertyValue('--chart-ram').trim());
  line(chartData.cpu, styles.getPropertyValue('--chart-cpu').trim());
}

// --- Capacity ---
async function refreshCapacity(overrides) {
  const res = await mchost.estimateCapacity(overrides || {});
  if (res.success === false) return;
  if (!overrides) capacityResult = res;
  renderCapacity(res, !overrides);
  return res;
}

function limitBarsHtml(est, compact) {
  const maxVal = Math.max(1, ...Object.values(est.limits));
  return Object.entries(est.limits).map(([k, v]) => {
    const pct = Math.max(3, Math.min(100, (v / maxVal) * 100));
    const isBottleneck = k === est.bottleneck;
    return `
      <div class="limit-row ${isBottleneck ? 'bottleneck' : ''}">
        <span class="limit-name"><i class="fas ${LIMIT_ICONS[k]}"></i> ${LIMIT_LABELS[k]}</span>
        <div class="limit-track"><div class="limit-fill limit-${k}" style="width:${pct}%"></div></div>
        <span class="limit-value">${v >= 500 ? '500+' : v}${compact ? '' : ' players'}</span>
      </div>`;
  }).join('');
}

function renderCapacity(res, isSaved) {
  const est = res.estimate;
  const input = res.input;
  const bottleneck = LIMIT_LABELS[est.bottleneck];

  if (isSaved) {
    document.getElementById('capacityNumber').textContent = est.recommended;
    updatePlayerCount();
    document.getElementById('capRam').textContent = input.ramGB + ' GB';
    document.getElementById('capType').textContent = TYPE_LABELS[input.serverType];
    document.getElementById('capMods').textContent = `${input.modCount} ${presets.loaders[input.serverType]?.kind === 'plugins' ? 'plugins' : 'mods'}`;
    document.getElementById('capBottleneck').textContent = bottleneck;
    document.getElementById('dashLimitBars').innerHTML = limitBarsHtml(est, true);
    renderRamTiers(res.tiers, input.ramGB);
    const hint = document.getElementById('propMaxPlayersHint');
    hint.textContent = `This PC can comfortably handle about ${est.recommended} players with current settings.`;
    hint.classList.toggle('warn-text', currentConfig.maxPlayers > est.max);
  }

  // Performance page (live preview while dragging sliders)
  document.getElementById('perfRecommended').textContent = est.recommended;
  document.getElementById('perfMax').textContent = est.max;
  document.getElementById('perfBottleneck').textContent = bottleneck;
  document.getElementById('perfApplyPlayers').textContent = est.recommended;
  document.getElementById('perfLimitBars').innerHTML = limitBarsHtml(est, false);
  const d = est.details;
  document.getElementById('perfBreakdown').innerHTML = `
    <div class="breakdown-item"><span>${d.profile} base usage</span><span>${d.baseGB} GB</span></div>
    ${d.modRamGB ? `<div class="breakdown-item"><span>Mods/plugins (${input.modCount})</span><span>${d.modRamGB} GB</span></div>` : ''}
    <div class="breakdown-item"><span>RAM per player</span><span>~${d.perPlayerMB} MB</span></div>
    <div class="breakdown-item"><span>Minimum RAM to run</span><span>${d.minRamGB} GB</span></div>
    <div class="breakdown-item"><span>World growth per player</span><span>~${d.perPlayerWorldMB} MB</span></div>
    <div class="breakdown-item"><span>Disk (${d.diskType}) free</span><span>${input.freeDiskGB} GB</span></div>`;
  document.getElementById('perfTips').innerHTML = est.tips.map((t) => `
    <div class="tip tip-${t.level}"><i class="fas ${t.level === 'error' ? 'fa-times-circle' : t.level === 'warning' ? 'fa-exclamation-triangle' : 'fa-lightbulb'}"></i><span>${escapeHtml(t.text)}</span></div>`).join('');
}

function renderRamTiers(tiers, currentRam) {
  const maxVal = Math.max(1, ...tiers.map((t) => t.ramLimit));
  const total = systemInfo.totalMemGB || 64;
  document.getElementById('ramTiers').innerHTML = tiers.map((t) => {
    const tooBig = t.ramGB > total - 1;
    return `
      <div class="tier-row ${t.ramGB === currentRam ? 'current' : ''} ${tooBig ? 'unavailable' : ''}">
        <span class="tier-ram">${t.ramGB} GB</span>
        <div class="tier-bar-container"><div class="tier-bar" style="width:${Math.max(2, (t.ramLimit / maxVal) * 100)}%"></div></div>
        <span class="tier-players">${tooBig ? 'not enough RAM' : `${t.max} players`}${!tooBig && t.bottleneck !== 'ram' ? ` <small>(${LIMIT_LABELS[t.bottleneck]})</small>` : ''}</span>
      </div>`;
  }).join('');
}

// --- Performance Page ---
function updateHardwareCards() {
  const s = systemInfo;
  if (!s.cpuModel) return;
  document.getElementById('perfCpuModel').textContent = s.cpuModel;
  document.getElementById('perfCpuModel').title = s.cpuModel;
  document.getElementById('perfCpuCores').textContent = `${s.cpuCores} threads at ${(s.cpuSpeedMHz / 1000).toFixed(1)} GHz`;
  document.getElementById('perfCpuScore').textContent = s.cpuScore;
  document.getElementById('perfRamTotal').textContent = s.totalMemGB + ' GB';
  document.getElementById('perfRamAvail').textContent = s.freeMemGB + ' GB available now';
  document.getElementById('ramBarFill').style.width = ((s.totalMemGB - s.freeMemGB) / s.totalMemGB * 100).toFixed(0) + '%';
  document.getElementById('perfDiskTotal').textContent = `${s.disk.drive} ${s.disk.total} GB ${s.diskType}`;
  document.getElementById('perfDiskFree').textContent = s.disk.free + ' GB free';
  document.getElementById('diskBarFill').style.width = (s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0).toFixed(0) + '%';
  document.getElementById('metricDisk').textContent = s.disk.free + ' GB';
  document.getElementById('metricDiskDetail').textContent = `on ${s.disk.drive} ${s.diskType}`;

  const maxSlider = document.getElementById('maxRamSlider');
  const minSlider = document.getElementById('minRamSlider');
  const cap = Math.max(1, Math.floor((s.totalMemGB - 1) * 2) / 2);
  maxSlider.max = cap;
  minSlider.max = cap;
  document.getElementById('maxRamHint').textContent =
    `This PC has ${s.totalMemGB} GB. Leave at least ${s.totalMemGB <= 4 ? '1.5' : '2-4'} GB for Windows.`;
}

function updatePerformancePage() {
  const cfg = currentConfig;
  const maxRam = parseRamGB(cfg.maxRam);
  const minRam = parseRamGB(cfg.minRam);
  setSlider('maxRamSlider', 'maxRamValue', maxRam, ' GB');
  setSlider('minRamSlider', 'minRamValue', minRam, ' GB');
  setSlider('viewDistSlider', 'viewDistValue', cfg.viewDistance, '');
  setSlider('simDistSlider', 'simDistValue', cfg.simulationDistance, '');
  document.getElementById('jvmArgs').value = cfg.jvmArgs || '';
  document.getElementById('processPriority').value = cfg.processPriority || 'normal';
  document.getElementById('uploadMbps').value = cfg.uploadMbps || '';
  highlightJvmPreset(cfg.jvmPreset || detectJvmPreset(cfg.jvmArgs));
  highlightProfile();
  updateRamVisual();
  perfDirty = false;
  document.getElementById('perfUnsaved').classList.add('hidden');
  if (capacityResult) renderCapacity(capacityResult, false);
}

function setSlider(id, valueId, value, suffix) {
  const el = document.getElementById(id);
  el.value = value;
  document.getElementById(valueId).textContent = el.value + suffix;
}

let perfTimer = null;
function markPerfDirty() {
  perfDirty = true;
  document.getElementById('perfUnsaved').classList.remove('hidden');
  clearTimeout(perfTimer);
  perfTimer = setTimeout(() => refreshCapacity(perfOverrides()), 120);
}

function perfOverrides() {
  return {
    ramGB: parseFloat(document.getElementById('maxRamSlider').value),
    viewDistance: parseInt(document.getElementById('viewDistSlider').value, 10),
    simulationDistance: parseInt(document.getElementById('simDistSlider').value, 10),
    uploadMbps: parseFloat(document.getElementById('uploadMbps').value) || 0,
  };
}

function updateRamVisual() {
  if (!systemInfo.totalMemGB) return;
  const maxRam = parseFloat(document.getElementById('maxRamSlider').value);
  const total = systemInfo.totalMemGB;
  // RAM used by Windows & other apps (excluding the server itself if it's running now).
  const serverNowGB = serverState !== 'offline' && lastStats ? lastStats.procMemMB / 1024 : 0;
  const usedNow = lastStats ? lastStats.sysMemUsedGB : total - systemInfo.freeMemGB;
  const systemUsed = Math.max(0.5, usedNow - serverNowGB);
  const free = Math.max(0, total - systemUsed - maxRam);
  const over = systemUsed + maxRam > total;

  document.getElementById('ramBarSystem').style.width = (systemUsed / total * 100).toFixed(1) + '%';
  document.getElementById('ramBarAllocated').style.width = (Math.min(maxRam, total) / total * 100).toFixed(1) + '%';
  document.getElementById('ramBarFree').style.width = (free / total * 100).toFixed(1) + '%';
  document.getElementById('ramBarAllocated').classList.toggle('over', over || free < 1);
  document.getElementById('ramLabelSystem').textContent = `Windows & apps: ${systemUsed.toFixed(1)} GB`;
  document.getElementById('ramLabelAllocated').textContent = `Server: ${maxRam} GB`;
  document.getElementById('ramLabelFree').textContent = `Free: ${free.toFixed(1)} GB`;
}

function detectJvmPreset(args) {
  for (const [k, v] of Object.entries(presets.jvm || {})) if (v === (args || '').trim()) return k;
  return 'custom';
}

function highlightJvmPreset(preset) {
  document.querySelectorAll('#jvmPresetButtons .preset-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
  document.getElementById('jvmPresetHint').textContent = JVM_HINTS[preset] || '';
}

function setJvmPreset(preset) {
  if (preset !== 'custom') document.getElementById('jvmArgs').value = presets.jvm[preset];
  highlightJvmPreset(preset);
  markPerfDirty();
}

function highlightProfile() {
  const vd = parseInt(document.getElementById('viewDistSlider').value, 10);
  const sd = parseInt(document.getElementById('simDistSlider').value, 10);
  let match = null;
  for (const [k, p] of Object.entries(presets.profiles || {})) {
    if (p.viewDistance === vd && p.simulationDistance === sd) match = k;
  }
  document.querySelectorAll('#profileGrid .choice').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.profile === match)));
  return match;
}

function applyProfile(key) {
  const p = presets.profiles[key];
  setSlider('viewDistSlider', 'viewDistValue', p.viewDistance, '');
  setSlider('simDistSlider', 'simDistValue', p.simulationDistance, '');
  highlightProfile();
  markPerfDirty();
}

async function savePerformanceSettings() {
  const maxRam = parseFloat(document.getElementById('maxRamSlider').value);
  const minRam = Math.min(maxRam, parseFloat(document.getElementById('minRamSlider').value));
  const jvmArgs = document.getElementById('jvmArgs').value.trim();
  currentConfig = await mchost.saveConfig({
    maxRam: maxRam + 'G',
    minRam: minRam + 'G',
    viewDistance: parseInt(document.getElementById('viewDistSlider').value, 10),
    simulationDistance: parseInt(document.getElementById('simDistSlider').value, 10),
    jvmArgs,
    jvmPreset: detectJvmPreset(jvmArgs),
    processPriority: document.getElementById('processPriority').value,
    uploadMbps: parseFloat(document.getElementById('uploadMbps').value) || 0,
    performanceProfile: highlightProfile() || 'custom',
  });
  perfDirty = false;
  document.getElementById('perfUnsaved').classList.add('hidden');
  updateDashboard();
  updatePropertiesPage();
  await refreshCapacity();
  showToast(serverState === 'offline' ? 'Performance settings saved' : 'Saved. Restart the server to apply.', 'success');
}

async function applyRecommendedPlayers() {
  const n = parseInt(document.getElementById('perfApplyPlayers').textContent, 10);
  if (!n) return showToast('Not enough resources for any players with these settings', 'warning');
  if (perfDirty) await savePerformanceSettings();
  currentConfig = await mchost.saveConfig({ maxPlayers: n });
  updateDashboard();
  updatePropertiesPage();
  refreshCapacity();
  showToast(`Max players set to ${n}`, 'success');
}

async function autoOptimize() {
  const rec = await mchost.recommendSettings();
  if (rec.success === false) return showToast(rec.error, 'error');
  const typeNow = currentConfig.installedType || currentConfig.serverType;
  const suggestion = rec.suggestedType !== typeNow
    ? `<div class="tip tip-info"><i class="fas fa-lightbulb"></i><span>For this CPU, <strong>${TYPE_LABELS[rec.suggestedType]}</strong> would handle noticeably more players than ${TYPE_LABELS[typeNow]}.</span></div>`
    : '';
  const ok = await showModal({
    title: '<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Optimized settings for this PC',
    body: `
      <p>Based on <strong>${escapeHtml(systemInfo.cpuModel)}</strong> (score ${systemInfo.cpuScore}), ${systemInfo.totalMemGB} GB RAM and a ${systemInfo.diskType} drive:</p>
      <div class="breakdown-list">
        <div class="breakdown-item"><span>Profile</span><span>${presets.profiles[rec.performanceProfile].label}</span></div>
        <div class="breakdown-item"><span>RAM</span><span>${rec.minRam.replace('G', '')}-${rec.maxRam.replace('G', ' GB')}</span></div>
        <div class="breakdown-item"><span>View / simulation distance</span><span>${rec.viewDistance} / ${rec.simulationDistance}</span></div>
        <div class="breakdown-item"><span>JVM flags</span><span>${{ lowend: 'Low-End', default: 'Default', aikar: "Aikar's" }[rec.jvmPreset]}</span></div>
        <div class="breakdown-item recommended"><span>Max players</span><span>${rec.maxPlayers}</span></div>
      </div>
      ${suggestion}`,
    actions: [
      { label: 'Cancel', value: false, cls: 'btn-ghost' },
      { label: '<i class="fas fa-check"></i> Apply', value: true, cls: 'btn-primary' },
    ],
  });
  if (!ok) return;
  currentConfig = await mchost.saveConfig({
    performanceProfile: rec.performanceProfile,
    maxRam: rec.maxRam,
    minRam: rec.minRam,
    viewDistance: rec.viewDistance,
    simulationDistance: rec.simulationDistance,
    jvmPreset: rec.jvmPreset,
    jvmArgs: rec.jvmArgs,
    maxPlayers: rec.maxPlayers,
  });
  updatePerformancePage();
  updatePropertiesPage();
  updateDashboard();
  await refreshCapacity();
  showToast('Optimized settings applied', 'success');
}

async function refreshSystemInfo() {
  systemInfo = await mchost.getSystemInfo();
  updateHardwareCards();
  updateRamVisual();
  await refreshJava();
  await refreshCapacity(perfDirty ? perfOverrides() : undefined);
  showToast('System info refreshed', 'info');
}

// --- Server Properties ---
function buildToggles() {
  document.getElementById('togglesGrid').innerHTML = TOGGLES.map(([key, name, desc]) => `
    <div class="toggle-item">
      <div class="toggle-info">
        <label class="toggle-name" for="prop_${key}">${name}</label>
        <span class="toggle-desc" id="prop_${key}_desc">${desc}</span>
      </div>
      <span class="toggle-switch">
        <input type="checkbox" id="prop_${key}" aria-describedby="prop_${key}_desc">
        <span class="toggle-slider"></span>
      </span>
    </div>`).join('');
}

function updatePropertiesPage() {
  const cfg = currentConfig;
  document.getElementById('propServerName').value = cfg.serverName || '';
  document.getElementById('propMotd').value = cfg.motd || '';
  document.getElementById('propPort').value = cfg.port || 25565;
  document.getElementById('propMaxPlayers').value = cfg.maxPlayers || 10;
  document.getElementById('propGamemode').value = cfg.gamemode || 'survival';
  document.getElementById('propDifficulty').value = cfg.difficulty || 'normal';
  document.getElementById('propSpawnProtection').value = cfg.spawnProtection ?? 16;
  document.getElementById('propLevelType').value = cfg.levelType || 'default';
  document.getElementById('propSeed').value = cfg.levelSeed || '';
  document.getElementById('propResourcePack').value = cfg.resourcePack || '';
  document.getElementById('propDistanceSummary').textContent = `View ${cfg.viewDistance}, simulation ${cfg.simulationDistance}`;
  for (const [key, , , def] of TOGGLES) {
    document.getElementById('prop_' + key).checked = cfg[key] ?? def;
  }
  renderMotdPreview();
  updateFolderPanel();
}

// --- Who can join: Bedrock, other Java versions, TLauncher ---
// These apply right away (they install or switch plugins), separate from Save changes.
async function refreshJoinOptions() {
  const res = await mchost.getCrossplay();
  if (res.success === false) return;
  joinOptions = res;
  renderJoinOptions();
}

function joinRow({ key, icon, title, desc, on, supported = true, fixed, extra = '' }) {
  const control = fixed
    ? '<span class="tag good">Always on</span>'
    : supported
      ? `<label class="toggle-switch">
          <input type="checkbox" data-feature="${key}" ${on ? 'checked' : ''} aria-labelledby="join_${key}" aria-describedby="join_${key}_desc">
          <span class="toggle-slider"></span>
        </label>`
      : '<span class="tag">Not available</span>';
  return `
    <div class="check-item ${on || fixed ? 'done' : ''}">
      <div class="check-icon"><i class="${icon}" aria-hidden="true"></i></div>
      <div class="check-info">
        <span class="check-title" id="join_${key}">${title}</span>
        <span class="check-desc" id="join_${key}_desc">${desc}</span>
        ${extra}
      </div>
      ${control}
    </div>`;
}

function renderJoinOptions() {
  const el = document.getElementById('joinOptions');
  if (!currentConfig.launch || !joinOptions) {
    el.innerHTML = '<p class="setting-hint">Install a server on the Mod Loader page first.</p>';
    return;
  }
  const c = joinOptions;
  const version = currentConfig.installedVersion;
  const login = c.loginPlugin;
  let loginExtra = '';
  if (c.offlineMode && login && !login.installed) {
    loginExtra = `<div style="margin-top: 8px;"><button class="btn btn-secondary btn-sm" data-action="login-plugin"><i class="fas fa-lock" aria-hidden="true"></i> Install ${escapeHtml(login.title)}</button></div>`;
  } else if (c.offlineMode && login?.installed) {
    loginExtra = `<span class="check-desc"><i class="fas fa-lock" aria-hidden="true"></i> ${escapeHtml(login.title)} is installed. New players type <code>/register password password</code>, then <code>/login password</code> when they come back.</span>`;
  }
  el.innerHTML = [
    joinRow({
      key: 'java', icon: 'fab fa-java', title: 'Java Edition', fixed: true,
      desc: `The official launcher on Minecraft ${escapeHtml(version)}.`,
    }),
    joinRow({
      key: 'bedrock', icon: 'fas fa-mobile-screen', title: 'Bedrock Edition', on: c.bedrock.enabled, supported: c.bedrock.supported,
      desc: c.bedrock.supported
        ? `Phones, tablets, Windows 10/11 and consoles join on port ${c.bedrock.port} (UDP). Installs Geyser and Floodgate. Works best on the newest Minecraft version, because Bedrock players always run the latest one.`
        : 'Switch to Paper, Purpur, Fabric or NeoForge on the Mod Loader page to let Bedrock players join.',
    }),
    joinRow({
      key: 'via', icon: 'fas fa-code-branch', title: 'Other Java versions', on: c.via.enabled, supported: c.via.supported,
      desc: c.via.supported
        ? `Players on older or newer versions can join, not only ${escapeHtml(version)}. Installs ViaVersion and ViaBackwards.`
        : 'Switch to Paper or Purpur on the Mod Loader page to let players on other versions join.',
    }),
    joinRow({
      key: 'offline', icon: 'fas fa-key', title: 'TLauncher and non-premium players', on: c.offlineMode,
      desc: 'Turns off Mojang account checks (online-mode=false), so players without a paid account can join. Anyone can then use any name, so turn on the whitelist or install a login plugin.',
      extra: loginExtra,
    }),
  ].join('');
}

async function onJoinOptionChange(e) {
  const input = e.target.closest('input[data-feature]');
  if (!input) return;
  const feature = input.dataset.feature;
  const on = input.checked;
  if (feature === 'offline' && on) {
    const ok = await confirmDialog('Allow TLauncher and non-premium players?',
      'Mojang account checks will be off. Anyone can join with any name, including yours, so also turn on the whitelist or install a login plugin.<br><br>' +
      'Players who already played here start with an empty inventory, because offline mode gives each player a different ID.',
      'Allow', true);
    if (!ok) {
      input.checked = false;
      return;
    }
  }
  input.disabled = true;
  const res = await mchost.setCrossplay({ feature, on });
  if (res.success === false) {
    showToast(res.error, 'error');
  } else {
    joinOptions = res;
    currentConfig = await mchost.getConfig();
    showToast(serverState === 'offline' ? 'Saved' : 'Saved. Restart the server to apply it.', 'success');
  }
  renderJoinOptions();
  refreshModsCount();
}

async function installLoginPlugin() {
  const res = await mchost.installLoginPlugin();
  if (res.success === false) return showToast(res.error, 'error');
  joinOptions = res;
  showToast(`Installed ${res.loginPlugin.title}`, 'success');
  renderJoinOptions();
  refreshModsCount();
}

// --- Server folder ---
// Migrating needs the server fully stopped, with no crash auto-restart pending.
function updateFolderPanel() {
  document.getElementById('serverDirInput').value = currentConfig.serverDirectory || '';
  const offline = serverState === 'offline' && !restartPending;
  document.getElementById('migrateBtn').disabled = !offline;
  document.getElementById('migrateHint').textContent = offline
    ? 'Moves your worlds, mods, server software and backups to another folder or drive. Pick your fastest drive (SSD) with the most free space.'
    : 'Stop the server to migrate it.';
}

async function saveProperties() {
  const port = parseInt(document.getElementById('propPort').value, 10);
  if (!(port >= 1024 && port <= 65535)) return showToast('Port must be between 1024 and 65535', 'warning');
  const maxPlayers = Math.max(1, parseInt(document.getElementById('propMaxPlayers').value, 10) || 10);
  const updates = {
    serverName: document.getElementById('propServerName').value.trim() || 'My Minecraft Server',
    motd: document.getElementById('propMotd').value,
    port,
    maxPlayers,
    gamemode: document.getElementById('propGamemode').value,
    difficulty: document.getElementById('propDifficulty').value,
    spawnProtection: Math.max(0, parseInt(document.getElementById('propSpawnProtection').value, 10) || 0),
    levelType: document.getElementById('propLevelType').value,
    levelSeed: document.getElementById('propSeed').value.trim(),
    resourcePack: document.getElementById('propResourcePack').value.trim(),
  };
  for (const [key] of TOGGLES) updates[key] = document.getElementById('prop_' + key).checked;

  if (capacityResult && maxPlayers > capacityResult.estimate.max) {
    showToast(`Heads up: ${maxPlayers} slots is more than this PC can likely handle (~${capacityResult.estimate.max})`, 'warning');
  }
  currentConfig = await mchost.saveConfig(updates);
  updateDashboard();
  refreshCapacity();
  showToast(serverState === 'offline' ? 'Server properties saved' : 'Saved. Restart the server to apply.', 'success');
}

const MC_COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

function renderMotdPreview() {
  const text = document.getElementById('propMotd').value || '';
  let html = '';
  let style = { color: '#AAAAAA', bold: false, italic: false, underline: false, strike: false };
  const parts = text.split(/[&§]([0-9a-fk-or])/i);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = parts[i].toLowerCase();
      if (MC_COLORS[code]) style = { ...style, color: MC_COLORS[code], bold: false, italic: false, underline: false, strike: false };
      else if (code === 'l') style.bold = true;
      else if (code === 'o') style.italic = true;
      else if (code === 'n') style.underline = true;
      else if (code === 'm') style.strike = true;
      else if (code === 'r') style = { color: '#AAAAAA', bold: false, italic: false, underline: false, strike: false };
      continue;
    }
    if (!parts[i]) continue;
    const css = `color:${style.color};${style.bold ? 'font-weight:700;' : ''}${style.italic ? 'font-style:italic;' : ''}` +
      `text-decoration:${[style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ') || 'none'}`;
    html += `<span style="${css}">${escapeHtml(parts[i])}</span>`;
  }
  document.getElementById('motdPreview').innerHTML = `
    <div class="motd-icon"><i class="fas fa-cube"></i></div>
    <div><div class="motd-name">${escapeHtml(document.getElementById('propServerName').value || 'Minecraft Server')}</div>
    <div class="motd-text">${html || '<span style="color:#AAAAAA">A Minecraft Server</span>'}</div></div>`;

  // The multiplayer list shows 2 lines of about 45 characters; the rest is cut off.
  const plain = text.replace(/[&§][0-9a-fk-or]/gi, '');
  const fit = document.getElementById('motdFit');
  fit.classList.toggle('hidden', plain.length <= MOTD_VISIBLE_CHARS);
  fit.textContent = `The server list shows about ${MOTD_VISIBLE_CHARS} characters, so the end of this message (${plain.length} characters) is cut off. The preview above shows what players see.`;
}

const MOTD_VISIBLE_CHARS = 90;

// --- Mod Loader ---
function updateModLoaderPage() {
  const cfg = currentConfig;
  document.querySelectorAll('.server-type-card').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.type === selectedType));
    card.querySelector('.installed-flag').classList.toggle('hidden', !(cfg.launch && card.dataset.type === cfg.installedType));
  });
  if (cfg.launch) {
    document.getElementById('installedValue').textContent = `${TYPE_LABELS[cfg.installedType]} ${cfg.installedVersion}`;
    document.getElementById('installedDetail').textContent =
      `${cfg.loaderVersion ? `Loader ${cfg.loaderVersion}, ` : ''}Java ${cfg.javaMajor}, ${cfg.launch.file.split('/').pop()}`;
    document.getElementById('installedCard').classList.add('ok');
  } else {
    document.getElementById('installedValue').textContent = 'Nothing yet';
    document.getElementById('installedDetail').textContent = 'Pick a server type and version below, then press Install';
    document.getElementById('installedCard').classList.remove('ok');
  }
  updateInstallButton();
}

function updateInstallButton() {
  const cfg = currentConfig;
  const version = document.getElementById('mcVersionSelect').value;
  const btn = document.getElementById('installBtn');
  const same = cfg.launch && cfg.installedType === selectedType && cfg.installedVersion === version;
  btn.innerHTML = same
    ? '<i class="fas fa-rotate-right" aria-hidden="true"></i> Reinstall'
    : cfg.launch ? '<i class="fas fa-right-left" aria-hidden="true"></i> Switch' : '<i class="fas fa-download" aria-hidden="true"></i> Install';
}

function selectServerType(type) {
  selectedType = type;
  updateModLoaderPage();
  loadMcVersions(type);
}

async function loadMcVersions(type) {
  const select = document.getElementById('mcVersionSelect');
  select.innerHTML = '<option value="">Loading versions...</option>';
  select.disabled = true;
  let versions = versionCache[type];
  if (!versions) {
    versions = await mchost.getMcVersions(type);
    if (!Array.isArray(versions)) {
      select.innerHTML = '<option value="">Could not load versions (offline?)</option>';
      document.getElementById('versionHint').textContent = versions.error || '';
      return;
    }
    versionCache[type] = versions;
  }
  if (type !== selectedType) return; // user clicked another card meanwhile
  const preferred = currentConfig.installedType === type ? currentConfig.installedVersion : versions[0];
  select.innerHTML = versions.map((v, i) =>
    `<option value="${escapeHtml(v)}" ${v === preferred ? 'selected' : ''}>${escapeHtml(v)}${i === 0 ? ' (latest)' : ''}${v === currentConfig.installedVersion && type === currentConfig.installedType ? ' - installed' : ''}</option>`).join('');
  select.disabled = false;
  document.getElementById('versionHint').textContent = `${versions.length} versions available for ${TYPE_LABELS[type]}`;
  updateVersionHint();
}

function updateVersionHint() {
  const v = document.getElementById('mcVersionSelect').value;
  const hint = document.getElementById('installHint');
  const notes = {
    vanilla: 'Official server jar from Mojang.',
    paper: 'Latest stable Paper build. Plugins go in the plugins folder.',
    purpur: 'Latest Purpur build. Compatible with Paper plugins.',
    fabric: 'Latest stable Fabric loader. Most mods also need Fabric API (installed automatically as a dependency).',
    forge: 'Recommended Forge build. The installer runs automatically (takes 1-3 minutes).',
    neoforge: 'Latest stable NeoForge. The installer runs automatically (takes 1-3 minutes).',
  };
  hint.textContent = `${notes[selectedType]} The correct Java version for ${v || 'this version'} is downloaded automatically if needed.`;
  updateInstallButton();
}

async function installServer() {
  const version = document.getElementById('mcVersionSelect').value;
  if (!version) return showToast('Please select a version', 'warning');
  if (serverState !== 'offline') return showToast('Stop the server first', 'warning');

  const cfg = currentConfig;
  if (cfg.launch && cfg.installedType !== selectedType) {
    const ok = await confirmDialog('Switch server software?',
      `You're switching from <strong>${TYPE_LABELS[cfg.installedType]}</strong> to <strong>${TYPE_LABELS[selectedType]}</strong>. ` +
      'Your worlds are kept, but mods/plugins built for the old loader won\'t load. Consider making a backup first.',
      'Switch', false);
    if (!ok) return;
  } else if (cfg.launch && cfg.installedVersion && version !== cfg.installedVersion && compareVersions(version, cfg.installedVersion) < 0) {
    const ok = await confirmDialog('Downgrade Minecraft?',
      `Going from ${cfg.installedVersion} down to ${version} can <strong>corrupt your world</strong>. Make a backup first!`, 'Downgrade anyway', true);
    if (!ok) return;
  }

  const btn = document.getElementById('installBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner small"></div> Installing...';
  const result = await mchost.installServer({ type: selectedType, version });
  btn.disabled = false;
  if (result.success) {
    currentConfig = await mchost.getConfig();
    showToast(`${TYPE_LABELS[selectedType]} ${version} installed`, 'success');
    versionCache[selectedType] = null;
    loadMcVersions(selectedType);
    refreshModsCount();
    refreshJava();
    refreshCapacity();
  } else {
    showToast('Install failed: ' + result.error, 'error');
  }
  updateDashboard();
  updateModLoaderPage();
}

async function chooseServerDirectory() {
  if (serverState !== 'offline' || restartPending) return showToast('Stop the server first', 'warning');
  const dir = await mchost.selectDirectory();
  if (!dir) return;
  const choice = await showModal({
    title: 'Migrate server folder?',
    body: `<p><strong>Move my server</strong> moves your worlds, mods, installed software and backups to <code>${escapeHtml(dir)}</code>. ` +
      'Everything keeps working, no reinstall needed.</p>' +
      '<p><strong>Start a separate server</strong> leaves your current server where it is and uses the new folder from scratch. ' +
      'If that folder already contains a server, re-install the matching software and version on this page so SpareBlok knows how to start it.</p>',
    actions: [
      { label: 'Cancel', value: null, cls: 'btn-ghost' },
      { label: 'Start a separate server', value: 'switch', cls: 'btn-secondary' },
      { label: 'Move my server', value: 'move', cls: 'btn-primary' },
    ],
  });
  if (!choice) return;
  if (serverState !== 'offline' || restartPending) return showToast('Stop the server first', 'warning');
  if (choice === 'move') {
    const result = await mchost.moveServerDirectory(dir);
    if (result?.success === false) return showToast('Move failed: ' + result.error, 'error');
    currentConfig = await mchost.getConfig();
  } else {
    currentConfig = await mchost.saveConfig({ serverDirectory: dir, launch: null, installedType: '', installedVersion: '' });
  }
  updateFolderPanel();
  refreshJoinOptions();
  updateModLoaderPage();
  updateDashboard();
  systemInfo = await mchost.getSystemInfo();
  updateHardwareCards();
  refreshCapacity();
  showToast('Server directory updated', 'success');
}

// --- Java ---
async function refreshJava() {
  const res = await mchost.detectJava();
  javaInstalls = Array.isArray(res) ? res : [];
  const status = document.getElementById('javaStatus');
  const need = currentConfig.javaMajor;
  const custom = currentConfig.javaPath && currentConfig.javaPath !== 'auto';
  const match = custom ? javaInstalls.find((j) => j.path === currentConfig.javaPath)
    : javaInstalls.find((j) => j.major === need) || javaInstalls.find((j) => j.major >= need);

  status.className = 'java-status ' + (match ? 'ok' : 'pending');
  if (match) {
    status.innerHTML = `<i class="fab fa-java" aria-hidden="true"></i><span>Java ${escapeHtml(match.version)}</span>`;
    document.getElementById('perfJavaVersion').textContent = 'Java ' + match.version;
    document.getElementById('perfJavaPath').textContent = match.source;
  } else {
    status.innerHTML = `<i class="fab fa-java" aria-hidden="true"></i><span>Java ${need} auto-installs</span>`;
    document.getElementById('perfJavaVersion').textContent = javaInstalls.length ? `Java ${javaInstalls[0].version}` : 'Not installed';
    document.getElementById('perfJavaPath').textContent = `Java ${need} will be downloaded automatically`;
  }

  const select = document.getElementById('javaSelect');
  select.innerHTML = `<option value="auto">Automatic (recommended) - needs Java ${need}</option>` +
    javaInstalls.map((j) => `<option value="${escapeHtml(j.path)}">Java ${escapeHtml(j.version)} - ${escapeHtml(j.source)} (${escapeHtml(j.path)})</option>`).join('');
  select.value = custom ? currentConfig.javaPath : 'auto';
  if (custom && select.value !== currentConfig.javaPath) select.value = 'auto';
}

async function saveJavaChoice() {
  const value = document.getElementById('javaSelect').value;
  currentConfig = await mchost.saveConfig({ javaPath: value });
  const j = javaInstalls.find((x) => x.path === value);
  if (j && j.major < currentConfig.javaMajor) {
    showToast(`Warning: this Minecraft version needs Java ${currentConfig.javaMajor}+`, 'warning');
  } else showToast('Java selection saved', 'success');
  refreshJava();
}

// --- Mods & Plugins ---
function contentNoun(type, plural = true) {
  const kind = presets.loaders[type]?.kind;
  if (kind === 'plugins') return plural ? 'plugins' : 'plugin';
  return plural ? 'mods' : 'mod';
}

async function refreshModsCount() {
  const res = await mchost.listMods();
  if (res.success === false) return;
  const enabled = res.items.filter((m) => m.enabled).length;
  document.getElementById('navModsCount').textContent = enabled || '';
  const kind = presets.loaders[res.type]?.kind;
  document.getElementById('navModsLabel').textContent = kind === 'plugins' ? 'Plugins' : kind === 'mods' ? 'Mods' : 'Mods & Plugins';
}

async function refreshMods() {
  const res = await mchost.listMods();
  if (res.success === false) return showToast(res.error, 'error');
  const type = res.type;
  const kind = presets.loaders[type]?.kind;
  const noun = contentNoun(type);
  const vanilla = kind === 'vanilla' || !currentConfig.launch;

  document.getElementById('modsVanillaNotice').classList.toggle('hidden', !vanilla);
  document.getElementById('modsContent').classList.toggle('hidden', vanilla);
  document.getElementById('modsTitle').textContent = kind === 'plugins' ? 'Plugins' : 'Mods';
  document.getElementById('modsSubtitle').textContent = currentConfig.launch
    ? `${TYPE_LABELS[type]} ${currentConfig.installedVersion}. Install from Modrinth or drop in your own .jar files.`
    : 'Install a server first';
  document.getElementById('modSearchInput').placeholder = `Search ${noun} for ${TYPE_LABELS[type]} ${currentConfig.installedVersion || ''}...`;
  if (vanilla) return;

  installedModIds = new Set(res.items.map((m) => m.projectId).filter(Boolean));
  document.getElementById('modsInstalledCount').textContent = res.items.length;
  const list = document.getElementById('modList');
  if (!res.items.length) {
    list.innerHTML = `<div class="file-empty"><i class="fas fa-puzzle-piece" aria-hidden="true"></i><p>No ${noun} installed yet. Search Modrinth, or drag .jar files here.</p></div>`;
  } else {
    list.innerHTML = res.items.map((m) => `
      <div class="mod-item ${m.enabled ? '' : 'disabled'}" data-file="${escapeHtml(m.file)}">
        ${m.iconUrl ? `<img class="mod-icon" src="${escapeHtml(m.iconUrl)}" alt="">` : '<div class="mod-icon placeholder"><i class="fas fa-puzzle-piece" aria-hidden="true"></i></div>'}
        <div class="mod-info">
          <span class="mod-name">${escapeHtml(m.name)}${m.enabled ? '' : ' <span class="tag">Off</span>'}</span>
          <span class="mod-file">${escapeHtml(m.file)}, ${formatFileSize(m.size)}</span>
        </div>
        <span class="toggle-switch small">
          <input type="checkbox" data-action="toggle" ${m.enabled ? 'checked' : ''} aria-label="Enable ${escapeHtml(m.name)}">
          <span class="toggle-slider"></span>
        </span>
        <button class="icon-btn danger" data-action="delete" aria-label="Delete ${escapeHtml(m.name)}" title="Delete"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
      </div>`).join('');
  }
  document.getElementById('navModsCount').textContent = res.items.filter((m) => m.enabled).length || '';
  renderRecommended();
  const key = `${type} ${currentConfig.installedVersion}`;
  if (modSearch.key !== key) {
    modSearch.key = key;
    browseMods('recommended');
  }
}

async function onModListClick(e) {
  const item = e.target.closest('.mod-item');
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!item || !action) return;
  const file = item.dataset.file;
  if (serverState !== 'offline') showToast('Changes take effect after a server restart', 'info');
  if (action === 'toggle') {
    const res = await mchost.toggleMod(file);
    if (res?.success === false) showToast(res.error, 'error');
  } else if (action === 'delete') {
    if (!await confirmDialog('Delete file?', `Delete <code>${escapeHtml(file)}</code>?`, 'Delete', true)) return;
    const res = await mchost.deleteMod(file);
    if (res?.success === false) showToast(res.error, 'error');
  }
  refreshMods();
  refreshCapacity();
}

async function addModFiles() {
  const res = await mchost.addModFiles();
  if (res.cancelled) return;
  if (!res.success) return showToast(res.error, 'error');
  showToast(`Added ${res.added.length} file(s)`, 'success');
  refreshMods();
  refreshCapacity();
}

function openModsFolder() {
  mchost.listMods().then((res) => res.folder && mchost.openDirectory(res.folder));
}

const BROWSE_HINTS = {
  recommended: 'Hand-picked for most servers. Only ones that support your version are shown.',
  popular: 'Most downloaded of all time.',
  trending: 'New in the last 6 months, ranked by how many people follow them.',
  search: '',
};

function browseMods(list) {
  document.getElementById('modSearchInput').value = '';
  loadModResults(list, '');
}

function searchMods(more = false) {
  if (more) return loadModResults(modSearch.list, modSearch.query, true);
  const query = document.getElementById('modSearchInput').value.trim();
  return loadModResults(query ? 'search' : 'popular', query);
}

async function loadModResults(list, query, more = false) {
  const results = document.getElementById('modSearchResults');
  const token = ++modSearchToken;
  if (!more) {
    modSearch = { ...modSearch, list, query, offset: 0, total: 0 };
    document.querySelectorAll('#browseTabs [data-list]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.list === list)));
    document.getElementById('browseHint').textContent = BROWSE_HINTS[list];
    results.innerHTML = '<div class="file-empty"><div class="loading-spinner"></div><p>Loading from Modrinth...</p></div>';
  }
  const res = list === 'search'
    ? await mchost.searchMods({ query, offset: modSearch.offset })
    : await mchost.discoverMods({ list, offset: modSearch.offset });
  if (token !== modSearchToken) return; // a newer tab or search replaced this one
  if (res.success === false) {
    results.innerHTML = `<div class="file-empty"><i class="fas fa-exclamation-triangle"></i><p>${escapeHtml(res.error)}</p></div>`;
    return;
  }
  modSearch.total = res.total;
  modSearch.offset += res.hits.length;
  const html = res.hits.map((h) => `
    <div class="search-item" data-id="${escapeHtml(h.id)}">
      ${h.iconUrl ? `<img class="mod-icon" src="${escapeHtml(h.iconUrl)}" alt="">` : '<div class="mod-icon placeholder"><i class="fas fa-cube"></i></div>'}
      <div class="mod-info">
        <span class="mod-name">${escapeHtml(h.title)}${h.author ? ` <small>by ${escapeHtml(h.author)}</small>` : ''}</span>
        ${h.why ? `<span class="mod-why"><i class="fas fa-star" aria-hidden="true"></i> ${escapeHtml(h.why)}</span>` : ''}
        <span class="mod-desc">${escapeHtml(h.description)}</span>
        <span class="mod-file"><i class="fas fa-download"></i> ${formatNumber(h.downloads)}
          ${h.serverSide === 'required' ? '<span class="feature-tag good">server-side</span>' : ''}
          <a class="link" data-action="open" data-slug="${escapeHtml(h.slug)}">details</a></span>
      </div>
      ${installedModIds.has(h.id)
        ? '<button class="btn btn-sm btn-ghost" disabled><i class="fas fa-check"></i> Installed</button>'
        : '<button class="btn btn-sm btn-primary" data-action="install"><i class="fas fa-download"></i> Install</button>'}
    </div>`).join('');
  if (more) results.insertAdjacentHTML('beforeend', html);
  else results.innerHTML = html || '<div class="file-empty"><i class="fas fa-search"></i><p>No results for this version</p></div>';
  document.getElementById('modSearchMore').classList.toggle('hidden', modSearch.offset >= modSearch.total);
}

async function onSearchResultClick(e) {
  const item = e.target.closest('.search-item');
  const actionEl = e.target.closest('[data-action]');
  if (!item || !actionEl) return;
  if (actionEl.dataset.action === 'open') {
    const kind = presets.loaders[currentConfig.installedType]?.kind === 'plugins' ? 'plugin' : 'mod';
    return mchost.openExternal(`https://modrinth.com/${kind}/${actionEl.dataset.slug}`);
  }
  actionEl.disabled = true;
  actionEl.innerHTML = '<div class="loading-spinner small"></div>';
  const res = await mchost.installMod(item.dataset.id);
  if (res.success) {
    actionEl.innerHTML = '<i class="fas fa-check"></i> Installed';
    actionEl.className = 'btn btn-sm btn-ghost';
    showToast(`Installed ${res.installed.join(', ') || 'mod'}`, 'success');
    refreshMods();
    refreshCapacity();
  } else {
    actionEl.disabled = false;
    actionEl.innerHTML = '<i class="fas fa-download"></i> Install';
    showToast(res.error, 'error');
  }
}

async function renderRecommended() {
  const recs = await mchost.recommendedMods();
  const panel = document.getElementById('recommendedPanel');
  if (!Array.isArray(recs) || !recs.length) return panel.classList.add('hidden');
  panel.classList.remove('hidden');
  document.getElementById('recommendedList').innerHTML = recs.map((r) => `
    <div class="recommended-item">
      <i class="fas fa-check-circle"></i>
      <div><strong>${escapeHtml(r.slug.replace(/-/g, ' '))}</strong><span>${escapeHtml(r.why)}</span></div>
    </div>`).join('');
}

async function installRecommended() {
  const res = await mchost.installRecommendedMods();
  if (!res.success) return showToast(res.error, 'error');
  const ok = res.results.filter((r) => r.ok).length;
  const failed = res.results.filter((r) => !r.ok);
  showToast(`Installed ${ok} optimization ${contentNoun(currentConfig.installedType)}` +
    (failed.length ? ` (${failed.length} not available for this version)` : ''), failed.length ? 'warning' : 'success');
  refreshMods();
  refreshCapacity();
}

// --- Console ---
function classifyLine(line) {
  if (/\b(WARN|WARNING)\b/.test(line)) return 'warn';
  if (/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(line)) return 'error';
  if (/^\[SpareBlok\]/.test(line)) return 'mchost';
  if (/Done \(|joined the game/.test(line)) return 'success';
  if (/\bINFO\b/.test(line)) return 'info';
  return '';
}

function appendConsole(text) {
  const output = document.getElementById('consoleOutput');
  const dash = document.getElementById('dashConsole');
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return;

  output.querySelector('.console-empty')?.remove();
  dash.querySelector('.console-empty')?.remove();
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'console-line ' + classifyLine(line);
    div.textContent = line;
    frag.appendChild(div);
  }
  // Append only the new lines - re-rendering the whole log is too slow on old PCs.
  output.appendChild(frag);
  while (output.childElementCount > MAX_CONSOLE_LINES) output.firstElementChild.remove();
  if (document.getElementById('consoleAutoScroll').checked) output.scrollTop = output.scrollHeight;

  for (const line of lines.slice(-12)) {
    const div = document.createElement('div');
    div.className = 'console-line ' + classifyLine(line);
    div.textContent = line;
    dash.appendChild(div);
  }
  while (dash.childElementCount > 12) dash.firstElementChild.remove();
  dash.scrollTop = dash.scrollHeight;
}

function clearConsole() {
  document.getElementById('consoleOutput').innerHTML = '<div class="console-empty"><i class="fas fa-terminal"></i><p>Console cleared</p></div>';
}

function handleConsoleKey(event) {
  const input = event.target;
  if (event.key === 'Enter') sendConsoleCommand();
  else if (event.key === 'ArrowUp' && commandHistory.length) {
    historyIndex = Math.min(commandHistory.length - 1, historyIndex + 1);
    input.value = commandHistory[commandHistory.length - 1 - historyIndex];
    event.preventDefault();
  } else if (event.key === 'ArrowDown') {
    historyIndex = Math.max(-1, historyIndex - 1);
    input.value = historyIndex >= 0 ? commandHistory[commandHistory.length - 1 - historyIndex] : '';
    event.preventDefault();
  }
}

async function sendConsoleCommand() {
  const input = document.getElementById('consoleInput');
  const command = input.value.trim().replace(/^\//, '');
  if (!command) return;
  if (commandHistory[commandHistory.length - 1] !== command) commandHistory.push(command);
  if (commandHistory.length > 100) commandHistory.shift();
  historyIndex = -1;
  appendConsole(`> ${command}`);
  const result = await mchost.sendCommand(command);
  if (!result.success) showToast(result.error, 'error');
  input.value = '';
  input.focus();
}

async function quickCommand(cmd) {
  const result = await mchost.sendCommand(cmd);
  if (!result.success) return showToast(result.error, 'error');
  appendConsole(`> ${cmd}`);
}

async function promptCommand(prefix, title) {
  const value = await promptDialog(title, '');
  if (value) quickCommand(prefix + value);
}

// --- Server Control ---
async function toggleServer() {
  if (serverState === 'online' || serverState === 'starting') {
    const res = await mchost.stopServer();
    if (res.success === false) showToast(res.error, 'error');
    return;
  }
  if (serverState === 'stopping') return;
  await startServer();
}

async function startServer() {
  if (perfDirty) {
    const save = await confirmDialog('Unsaved performance settings', 'Save your Performance changes before starting?', 'Save & Start');
    if (save) await savePerformanceSettings();
  }
  const btn = document.getElementById('startStopBtn');
  btn.innerHTML = '<div class="loading-spinner small"></div> Preparing...';
  btn.disabled = true;
  let result = await mchost.startServer();
  if (result.needEula) {
    btn.disabled = false;
    updateServerStatus();
    if (await showEulaDialog()) result = await mchost.startServer();
    else return;
  }
  btn.disabled = false;
  if (!result.success) {
    showToast(result.error, 'error');
    if (/No server installed/.test(result.error)) navigateTo('modloader');
  }
  updateServerStatus();
}

async function restartServer() {
  if (serverState === 'offline') return startServer();
  showToast('Restarting server...', 'info');
  await mchost.stopServer();
  await startServer();
}

async function killServer() {
  if (!await confirmDialog('Force stop?', 'Killing the server skips saving - recent progress may be lost. Use only if it is frozen.', 'Kill', true)) return;
  mchost.killServer();
}

async function cancelRestart() {
  await mchost.cancelRestart();
  document.getElementById('restartNotice').classList.add('hidden');
}

function updateServerStatus() {
  const btn = document.getElementById('startStopBtn');
  const running = serverState !== 'offline';
  const dotClass = 'status-dot ' + (serverState === 'online' ? 'online' : running ? 'starting' : '');

  btn.disabled = serverState === 'stopping';
  if (serverState === 'online' || serverState === 'starting') {
    btn.innerHTML = '<i class="fas fa-stop" aria-hidden="true"></i> Stop server';
    btn.className = 'btn btn-danger btn-lg';
  } else if (serverState === 'stopping') {
    btn.innerHTML = '<span class="loading-spinner small" aria-hidden="true"></span> Stopping...';
    btn.className = 'btn btn-danger btn-lg';
  } else {
    btn.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> Start server';
    btn.className = 'btn btn-primary btn-lg';
  }
  document.getElementById('restartBtn').disabled = serverState === 'stopping';
  document.getElementById('killBtn').disabled = !running;
  document.getElementById('statusHero').dataset.state = serverState;
  document.getElementById('heroStateText').textContent = STATE_LABELS[serverState] || serverState;
  document.querySelector('#statusHero .status-dot').className = dotClass;
  document.querySelector('#sidebarStatus .status-dot').className = dotClass;
  document.querySelector('#sidebarStatus .status-text').textContent = STATE_LABELS[serverState] || serverState;
  updatePlayerCount();
}

// --- Players ---
async function refreshPlayers(sendList = false) {
  if (sendList && serverState === 'online') await mchost.sendCommand('list');
  const lists = await mchost.getPlayerLists();
  if (lists.success === false) return;
  const online = lists.online.length ? lists.online : onlinePlayers;
  const opNames = new Set(lists.ops.map((o) => o.name.toLowerCase()));

  const renderList = (id, countId, entries, actions, empty) => {
    document.getElementById(countId).textContent = entries.length;
    document.getElementById(id).innerHTML = entries.length ? entries.map((e) => `
      <div class="player-item" data-name="${escapeHtml(e.name)}">
        <img class="player-head" src="https://mc-heads.net/avatar/${encodeURIComponent(e.name)}/32" alt="" onerror="this.style.visibility='hidden'">
        <div class="player-info">
          <span class="player-name">${escapeHtml(e.name)}${opNames.has(e.name.toLowerCase()) && id !== 'opsList' ? ' <i class="fas fa-crown op-crown" title="Operator"></i>' : ''}</span>
          ${e.sub ? `<span class="player-sub">${escapeHtml(e.sub)}</span>` : ''}
        </div>
        <div class="player-actions">${actions.map(([cmd, icon, title, cls]) =>
          `<button class="icon-btn ${cls || ''}" data-cmd="${cmd}" title="${title}" aria-label="${title}: ${escapeHtml(e.name)}"><i class="fas ${icon}" aria-hidden="true"></i></button>`).join('')}</div>
      </div>`).join('') : `<div class="list-empty">${empty}</div>`;
  };

  renderList('onlinePlayers', 'onlineCount', online.map((name) => ({ name })),
    [['op', 'fa-crown', 'Make operator'], ['kick', 'fa-door-open', 'Kick'], ['ban', 'fa-ban', 'Ban', 'danger']],
    serverState === 'online' ? 'No one is online' : 'Server is offline');
  renderList('opsList', 'opsCount', lists.ops.map((o) => ({ name: o.name, sub: `level ${o.level}` })),
    [['deop', 'fa-user-minus', 'Remove operator', 'danger']], 'No operators');
  renderList('whitelistList', 'whitelistCount', lists.whitelist.map((w) => ({ name: w.name })),
    [['whitelist remove', 'fa-user-times', 'Remove from whitelist', 'danger']], 'Whitelist is empty');
  renderList('bannedList', 'bannedCount', lists.banned.map((b) => ({ name: b.name, sub: b.reason })),
    [['pardon', 'fa-user-check', 'Unban']], 'No banned players');
  document.getElementById('whitelistState').textContent = currentConfig.whitelist ? 'enforced' : 'off (enable in Properties)';
}

async function runPlayerCommand(cmd, name) {
  if (serverState !== 'online') return showToast('Start the server to manage players', 'warning');
  if (cmd === 'ban' && !await confirmDialog('Ban player?', `Ban <strong>${escapeHtml(name)}</strong> from the server?`, 'Ban', true)) return;
  const res = await mchost.sendCommand(`${cmd} ${name}`);
  if (!res.success) return showToast(res.error, 'error');
  showToast(`${cmd} ${name}`, 'success');
  setTimeout(() => refreshPlayers(), 800);
}

function onPlayerListClick(e) {
  const btn = e.target.closest('[data-cmd]');
  if (!btn) return;
  runPlayerCommand(btn.dataset.cmd, btn.closest('.player-item').dataset.name);
}

function playerAction(cmd) {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!/^[A-Za-z0-9_.]{2,20}$/.test(name)) return showToast('Enter a valid player name', 'warning');
  runPlayerCommand(cmd, name);
}

// --- Worlds ---
async function refreshWorlds() {
  const worlds = await mchost.listWorlds();
  const list = document.getElementById('worldList');
  if (!Array.isArray(worlds) || !worlds.length) {
    list.innerHTML = '<div class="file-empty"><i class="fas fa-earth-americas" aria-hidden="true"></i><p>No worlds yet. The server creates one the first time it starts.</p></div>';
    return;
  }
  const icons = { overworld: 'fa-sun', nether: 'fa-fire', end: 'fa-dragon' };
  list.innerHTML = worlds.map((w) => `
    <div class="world-item ${w.active ? 'active' : ''}" data-name="${escapeHtml(w.name)}">
      <div class="world-icon ${w.dimension}"><i class="fas ${icons[w.dimension]}" aria-hidden="true"></i></div>
      <div class="mod-info">
        <span class="mod-name">${escapeHtml(w.name)} ${w.active ? '<span class="tag good">In use</span>' : ''}</span>
        <span class="mod-file">${capitalizeFirst(w.dimension)}, ${formatFileSize(w.size)}, last played ${new Date(w.modified).toLocaleString()}</span>
      </div>
      ${!w.active && w.dimension === 'overworld' ? '<button class="btn btn-sm btn-secondary" data-action="activate">Use world</button>' : ''}
      <button class="icon-btn" data-action="open" aria-label="Open ${escapeHtml(w.name)} folder" title="Open folder"><i class="fas fa-folder-open" aria-hidden="true"></i></button>
      <button class="icon-btn danger" data-action="delete" aria-label="Delete ${escapeHtml(w.name)}" title="Delete"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

async function onWorldListClick(e) {
  const item = e.target.closest('.world-item');
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!item || !action) return;
  const name = item.dataset.name;
  if (action === 'open') return mchost.openDirectory(currentConfig.serverDirectory + '\\' + name);
  if (action === 'activate') {
    const res = await mchost.setActiveWorld(name);
    if (res.success === false) return showToast(res.error, 'error');
    currentConfig = res;
    showToast(`"${name}" will load on next start`, 'success');
  }
  if (action === 'delete') {
    if (!await confirmDialog('Delete world?', `Permanently delete <strong>${escapeHtml(name)}</strong>? This cannot be undone.`, 'Delete', true)) return;
    const res = await mchost.deleteWorld(name);
    if (res.success === false) return showToast(res.error, 'error');
    showToast('World deleted', 'success');
  }
  refreshWorlds();
}

async function importWorld() {
  const res = await mchost.importWorld();
  if (res.cancelled) return;
  if (!res.success) return showToast(res.error, 'error');
  showToast(`Imported as "${res.name}"`, 'success');
  refreshWorlds();
}

async function resetWorld() {
  const ok = await confirmDialog('Regenerate world?',
    `This deletes <strong>${escapeHtml(currentConfig.levelName)}</strong> (and its Nether/End). A new world is generated on next start using seed "${escapeHtml(currentConfig.levelSeed || 'random')}". Make a backup first if you want to keep it!`,
    'Delete & Regenerate', true);
  if (!ok) return;
  const res = await mchost.resetWorld();
  if (res.success === false) return showToast(res.error, 'error');
  showToast('World removed - a fresh one is generated on next start', 'success');
  refreshWorlds();
}

// --- Files ---
const TEXT_EXT = /\.(properties|txt|json|json5|yml|yaml|toml|cfg|conf|ini|log|md|mcmeta|snbt|csv|sk)$/i;

async function refreshFiles() {
  updateBreadcrumb();
  const fileList = document.getElementById('fileList');
  const files = await mchost.listServerFiles(currentFilePath);
  if (!Array.isArray(files)) {
    fileList.innerHTML = `<div class="file-empty"><i class="fas fa-exclamation-triangle"></i><p>${escapeHtml(files.error)}</p></div>`;
    return;
  }
  if (!files.length) {
    fileList.innerHTML = '<div class="file-empty"><i class="fas fa-folder-open"></i><p>This folder is empty.</p></div>';
    return;
  }
  files.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
  fileList.innerHTML = files.map((f) => {
    let icon = 'fas fa-file file-icon file';
    if (f.isDirectory) icon = 'fas fa-folder file-icon folder';
    else if (/\.jar$/i.test(f.name)) icon = 'fas fa-cube file-icon jar';
    else if (/\.(properties|yml|yaml|json|toml|cfg)$/i.test(f.name)) icon = 'fas fa-cog file-icon config';
    else if (/\.(log|txt|gz)$/i.test(f.name)) icon = 'fas fa-file-alt file-icon file';
    const editable = !f.isDirectory && TEXT_EXT.test(f.name);
    const openable = f.isDirectory || editable;
    const name = openable
      ? `<button class="file-name file-open" data-action="open">${escapeHtml(f.name)}</button>`
      : `<span class="file-name">${escapeHtml(f.name)}</span>`;
    return `
      <div class="file-item ${openable ? 'clickable' : ''}" data-path="${escapeHtml(f.path)}" data-dir="${f.isDirectory}" data-edit="${editable}">
        <i class="${icon}" aria-hidden="true"></i>
        ${name}
        <span class="file-date">${f.modified ? new Date(f.modified).toLocaleDateString() : ''}</span>
        <span class="file-size">${f.isDirectory ? '' : formatFileSize(f.size)}</span>
        <button class="icon-btn danger file-delete" data-action="delete" aria-label="Delete ${escapeHtml(f.name)}" title="Delete"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
      </div>`;
  }).join('');
}

function refreshFilesIfVisible() {
  if (isPageActive('files')) refreshFiles();
}

async function onFileListClick(e) {
  const item = e.target.closest('.file-item');
  if (!item) return;
  const filePath = item.dataset.path;
  if (e.target.closest('[data-action="delete"]')) {
    if (!await confirmDialog('Delete?', `Delete <code>${escapeHtml(filePath)}</code>${item.dataset.dir === 'true' ? ' and everything inside it' : ''}?`, 'Delete', true)) return;
    const res = await mchost.deleteServerFile(filePath);
    if (res.success === false) return showToast(res.error, 'error');
    return refreshFiles();
  }
  if (item.dataset.dir === 'true') return navigateFiles(filePath);
  if (item.dataset.edit === 'true') openFileEditor(filePath);
}

function navigateFiles(subPath) {
  currentFilePath = subPath;
  refreshFiles();
}

function updateBreadcrumb() {
  let html = `<span class="breadcrumb-item ${!currentFilePath ? 'active' : ''}" data-path=""><i class="fas fa-home"></i> server</span>`;
  if (currentFilePath) {
    const parts = currentFilePath.split(/[/\\]/);
    let acc = '';
    parts.forEach((part, i) => {
      acc += (i > 0 ? '\\' : '') + part;
      html += ` <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-item ${i === parts.length - 1 ? 'active' : ''}" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</span>`;
    });
  }
  document.getElementById('fileBreadcrumb').innerHTML = html;
}

async function openFileEditor(filePath) {
  const res = await mchost.readServerFile(filePath);
  if (!res.success) return showToast(res.error, 'error');
  const readOnly = /\.log$/i.test(filePath);
  const isProps = /server\.properties$/i.test(filePath);
  const saved = await showModal({
    title: `<i class="fas fa-file-code"></i> ${escapeHtml(filePath)}`,
    wide: true,
    body: `${isProps ? '<div class="tip tip-warning"><i class="fas fa-exclamation-triangle"></i><span>Settings managed by SpareBlok (port, MOTD, distances...) are overwritten on start. Change those in the app instead.</span></div>' : ''}
      <textarea class="form-textarea monospace file-editor" id="fileEditorText" spellcheck="false" ${readOnly ? 'readonly' : ''}></textarea>`,
    onOpen: () => { document.getElementById('fileEditorText').value = res.content; },
    actions: readOnly
      ? [{ label: 'Close', value: false, cls: 'btn-ghost' }]
      : [{ label: 'Cancel', value: false, cls: 'btn-ghost' }, { label: '<i class="fas fa-save"></i> Save', value: true, cls: 'btn-primary', collect: () => document.getElementById('fileEditorText').value }],
  });
  if (typeof saved !== 'string') return;
  const w = await mchost.writeServerFile(filePath, saved);
  if (w.success) showToast('File saved' + (serverState !== 'offline' ? ' - restart to apply' : ''), 'success');
  else showToast(w.error, 'error');
}

// --- Backups ---
async function refreshBackups() {
  document.getElementById('autoBackupSelect').value = String(currentConfig.autoBackupMinutes || 0);
  document.getElementById('maxBackupsSelect').value = String(currentConfig.maxBackups || 5);
  const res = await mchost.listBackups();
  const list = document.getElementById('backupList');
  if (res.success === false) {
    list.innerHTML = `<div class="file-empty"><i class="fas fa-exclamation-triangle"></i><p>${escapeHtml(res.error)}</p></div>`;
    return;
  }
  document.getElementById('backupCount').textContent = res.items.length;
  document.getElementById('backupTotalSize').textContent = res.items.length
    ? 'Total ' + formatFileSize(res.items.reduce((s, b) => s + b.size, 0)) : '';
  if (!res.items.length) {
    list.innerHTML = '<div class="file-empty"><i class="fas fa-archive"></i><p>No backups yet. Create one before big changes!</p></div>';
    return;
  }
  list.innerHTML = res.items.map((b, i) => `
    <div class="backup-item" data-name="${escapeHtml(b.name)}">
      <div class="backup-item-icon ${b.name.includes('-auto') ? 'auto' : ''}"><i class="fas ${b.name.includes('-auto') ? 'fa-clock' : 'fa-box-archive'}" aria-hidden="true"></i></div>
      <div class="mod-info">
        <span class="mod-name">${new Date(b.created).toLocaleString()} ${i === 0 ? '<span class="tag good">Latest</span>' : ''} ${b.name.includes('-auto') ? '<span class="tag">Scheduled</span>' : ''}</span>
        <span class="mod-file">${escapeHtml(b.name)}, ${formatFileSize(b.size)}</span>
      </div>
      <button class="btn btn-sm btn-secondary" data-action="restore">Restore</button>
      <button class="icon-btn danger" data-action="delete" aria-label="Delete backup from ${new Date(b.created).toLocaleString()}" title="Delete"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

async function onBackupListClick(e) {
  const item = e.target.closest('.backup-item');
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!item || !action) return;
  const name = item.dataset.name;
  if (action === 'restore') {
    if (serverState !== 'offline') return showToast('Stop the server before restoring', 'warning');
    if (!await confirmDialog('Restore backup?', 'Your current worlds are <strong>replaced</strong> with the backup. Configs, mods and plugins from the backup overwrite current ones.', 'Restore', true)) return;
    const res = await mchost.restoreBackup(name);
    if (res.success === false) return showToast(res.error, 'error');
    showToast('Backup restored', 'success');
  } else if (action === 'delete') {
    if (!await confirmDialog('Delete backup?', `Delete <code>${escapeHtml(name)}</code>?`, 'Delete', true)) return;
    await mchost.deleteBackup(name);
  }
  refreshBackups();
}

async function createBackup() {
  const res = await mchost.createBackup();
  if (res.success) showToast(`Backup created (${formatFileSize(res.size)})`, 'success');
  else showToast('Backup failed: ' + res.error, 'error');
  if (isPageActive('backups')) refreshBackups();
  systemInfo = await mchost.getSystemInfo();
  updateHardwareCards();
}

async function saveBackupSettings() {
  currentConfig = await mchost.saveConfig({
    autoBackupMinutes: parseInt(document.getElementById('autoBackupSelect').value, 10),
    maxBackups: parseInt(document.getElementById('maxBackupsSelect').value, 10),
  });
  refreshCapacity();
  showToast('Backup settings saved', 'success');
}

function openBackupsFolder() {
  mchost.listBackups().then((res) => res.dir && mchost.openDirectory(res.dir));
}

// --- Network ---
function portSuffix() {
  return currentConfig.port === 25565 ? '' : ':' + currentConfig.port;
}

async function refreshNetworkSummary() {
  const info = await mchost.getNetworkInfo();
  if (info.success === false) return;
  applyNetworkInfo(info);
  refreshPublicIp();
}

const CGNAT_RANGE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

async function refreshPublicIp() {
  const ip = await mchost.getPublicIp();
  publicIp = typeof ip === 'string' ? ip : '';
  document.getElementById('publicAddress').textContent = publicIp ? publicIp + portSuffix() : 'Could not detect (offline?)';
  document.getElementById('cgnatHint').textContent = CGNAT_RANGE.test(publicIp)
    ? 'This address is in the CGNAT range, so port forwarding will not work. Use playit.gg above.'
    : '';
}

async function refreshFirewall() {
  const fw = await mchost.getFirewallStatus();
  const port = currentConfig.port;
  const fwDesc = document.getElementById('firewallDesc');
  const ports = bedrockLanPort ? `Ports ${port} and ${bedrockLanPort} (Bedrock)` : `Port ${port}`;
  if (!fw || fw.success === false || !fw.supported) fwDesc.textContent = 'Not available on this system.';
  else if (fw.allowed) fwDesc.textContent = `${ports} ${bedrockLanPort ? 'are' : 'is'} allowed for incoming connections.`;
  else fwDesc.textContent = `${ports} may be blocked. Windows usually asks on first start. Allowing it needs administrator approval.`;
  document.getElementById('checkFirewall').classList.toggle('done', !!fw?.allowed);
  document.getElementById('firewallBtn').classList.toggle('hidden', !!fw?.allowed);
}

function applyNetworkInfo(info) {
  const suffix = portSuffix();
  lanAddress = info.local[0]?.address || '';
  document.getElementById('guidePort').textContent = info.port;
  document.getElementById('guideLocalIp').textContent = lanAddress || 'this PC';
  document.getElementById('lanReady').classList.toggle('hidden', !info.local.length);
  document.getElementById('lanAddresses').innerHTML = info.local.length ? info.local.map((a) => `
    <div class="connect-row">
      <span class="connect-label">${escapeHtml(a.name)}</span>
      <code class="connect-address">${escapeHtml(a.address + suffix)}</code>
      <button class="icon-btn" data-copy="${escapeHtml(a.address + suffix)}" aria-label="Copy ${escapeHtml(a.address + suffix)}"><i class="far fa-copy" aria-hidden="true"></i></button>
    </div>`).join('') : '<p class="setting-hint">No network adapter is connected.</p>';
  bedrockLanPort = info.bedrockPort || null;
  if (bedrockLanPort && info.local.length) {
    document.getElementById('lanAddresses').insertAdjacentHTML('beforeend',
      `<p class="setting-hint" style="margin-top: 8px;"><i class="fas fa-mobile-screen" aria-hidden="true"></i> Bedrock players: Servers tab, Add Server, the same address and port <code>${bedrockLanPort}</code>.</p>`);
  }
  document.getElementById('upnpToggle').checked = !!info.upnp;
  document.getElementById('checkUpnp').classList.toggle('done', !!info.upnp);
  updateJoinAddress();
}

async function refreshNetwork() {
  document.getElementById('firewallDesc').textContent = 'Checking...';
  const info = await mchost.getNetworkInfo();
  if (info.success === false) return showToast(info.error, 'error');
  applyNetworkInfo(info);
  refreshPublicIp();
  refreshFirewall();
  refreshPlayit();
}

async function addFirewallRule() {
  showToast('Windows will ask for administrator approval', 'info');
  const res = await mchost.addFirewallRule();
  if (res.success) showToast('Firewall rule added', 'success');
  else showToast(res.error, 'error');
  refreshFirewall();
}

async function toggleUpnp() {
  const on = document.getElementById('upnpToggle').checked;
  const desc = document.getElementById('upnpDesc');
  desc.textContent = on ? 'Asking your router...' : 'Removing the port forward...';
  const res = on ? await mchost.upnpOpen() : await mchost.upnpClose();
  if (res.success) {
    desc.textContent = on
      ? `Router ${res.router} forwards the port to ${res.internal}${res.externalIp ? `. Public IP ${res.externalIp}` : ''}. Renewed on every server start.`
      : 'Automatic router forwarding is off.';
    showToast(on ? 'Port forwarded with UPnP' : 'UPnP port forward removed', 'success');
  } else {
    document.getElementById('upnpToggle').checked = false;
    desc.textContent = res.error;
  }
  currentConfig = await mchost.getConfig();
  document.getElementById('checkUpnp').classList.toggle('done', !!currentConfig.upnp);
}

// --- playit.gg tunnel ---
async function refreshPlayit() {
  const s = await mchost.playitStatus();
  if (s.success === false) return;
  playitEnabled = !!s.enabled;
  renderPlayit(s);
}

function renderPlayit(s) {
  playitState = s;
  const phase = s.phase || 'off';
  const busy = ['installing', 'starting', 'creating'].includes(phase);

  // Stepper: done / current per step
  const tunnelDone = phase === 'online';
  const current = !s.installed || phase === 'installing' ? 'install'
    : !s.linked || phase === 'linking' ? 'link'
      : tunnelDone ? null : 'tunnel';
  const done = { install: s.installed && phase !== 'installing', link: s.linked && phase !== 'linking', tunnel: tunnelDone };
  document.querySelectorAll('#playitSteps .step').forEach((li) => {
    const key = li.dataset.step;
    li.classList.toggle('done', !!done[key]);
    li.classList.toggle('current', key === current && (playitEnabled || busy || phase === 'linking'));
    li.querySelector('.step-mark').innerHTML = done[key] ? '<i class="fas fa-check"></i>' : String(['install', 'link', 'tunnel'].indexOf(key) + 1);
    li.setAttribute('aria-current', key === current ? 'step' : 'false');
  });

  const panel = document.getElementById('playitPanel');
  panel.className = 'tunnel-panel' + (phase === 'error' ? ' error' : phase === 'action' ? ' action' : '');
  const msg = escapeHtml(s.message || '');
  let html;

  if (phase === 'online') {
    html = `
      <div class="tunnel-status"><span class="status-dot online" aria-hidden="true"></span><span class="msg">Tunnel online. Friends add this address in Multiplayer. It stays the same every time.</span></div>
      <div class="tunnel-address-row">
        <code class="tunnel-address" id="playitAddress">${escapeHtml(s.address)}</code>
        <button class="btn btn-primary" onclick="copyText(document.getElementById('playitAddress').textContent)"><i class="far fa-copy" aria-hidden="true"></i> Copy</button>
      </div>
      ${s.numericAddress && s.numericAddress !== s.address ? `<p class="setting-hint" style="margin-top: 6px;">If it doesn't connect, try <code>${escapeHtml(s.numericAddress)}</code>.</p>` : ''}
      ${s.bedrockAddress ? `<p class="setting-hint" style="margin-top: 6px;"><i class="fas fa-mobile-screen" aria-hidden="true"></i> Bedrock players: Server Address <code>${escapeHtml(s.bedrockAddress.host)}</code>, Port <code>${escapeHtml(String(s.bedrockAddress.port))}</code></p>` : ''}
      ${s.bedrockMessage ? `<p class="setting-hint warn-text" style="margin-top: 6px;">${escapeHtml(s.bedrockMessage)}</p>` : ''}
      <div class="tunnel-actions">
        <button class="btn btn-ghost btn-sm" onclick="mchost.openExternal('https://playit.gg/account/tunnels')"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> playit dashboard</button>
        <button class="btn btn-ghost btn-sm" onclick="playitDisable()">Turn off</button>
        <button class="btn btn-danger-ghost btn-sm" onclick="playitUnlink()">Unlink account</button>
      </div>`;
  } else if (phase === 'linking') {
    html = `
      <div class="tunnel-status"><span class="loading-spinner" aria-hidden="true"></span><span class="msg"><strong>Approve SpareBlok in your browser.</strong> A playit.gg page opened. Sign in or continue as a guest, then press Approve. This page updates by itself.</span></div>
      <div class="tunnel-actions">
        <button class="btn btn-secondary btn-sm" onclick="mchost.playitOpenClaim()"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Open approval page</button>
        <button class="btn btn-ghost btn-sm" onclick="playitCancel()">Cancel</button>
      </div>`;
  } else if (busy) {
    html = `<div class="tunnel-status"><span class="loading-spinner" aria-hidden="true"></span><span class="msg">${msg || 'Working...'}</span></div>`;
  } else if (phase === 'action') {
    html = `
      <div class="tunnel-status"><i class="fas fa-triangle-exclamation" style="color: var(--warning)" aria-hidden="true"></i><span class="msg">${msg}</span></div>
      <div class="tunnel-actions">
        ${s.actionUrl ? `<button class="btn btn-secondary btn-sm" onclick="mchost.openExternal('${escapeHtml(s.actionUrl)}')"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Open playit.gg</button>` : ''}
        <button class="btn btn-primary btn-sm" onclick="playitRetry()">Retry</button>
        <button class="btn btn-ghost btn-sm" onclick="playitDisable()">Turn off</button>
      </div>`;
  } else if (phase === 'error') {
    html = `
      <div class="tunnel-status"><i class="fas fa-circle-xmark" style="color: var(--danger)" aria-hidden="true"></i><span class="msg">${msg || 'Something went wrong.'}</span></div>
      <div class="tunnel-actions">
        <button class="btn btn-primary btn-sm" onclick="${s.linked ? 'playitRetry()' : 'playitSetup()'}">Retry</button>
        <button class="btn btn-ghost btn-sm" onclick="playitDisable()">Turn off</button>
        ${s.linked ? '<button class="btn btn-danger-ghost btn-sm" onclick="playitUnlink()">Unlink account</button>' : ''}
      </div>`;
  } else if (s.linked) {
    html = `
      <div class="tunnel-status"><i class="fas fa-link" style="color: var(--text-3)" aria-hidden="true"></i><span class="msg">Your playit account is linked. Turn the tunnel on to get your public address.</span></div>
      <div class="tunnel-actions">
        <button class="btn btn-primary" onclick="playitSetup()"><i class="fas fa-power-off" aria-hidden="true"></i> Turn on</button>
        <button class="btn btn-danger-ghost btn-sm" onclick="playitUnlink()">Unlink account</button>
      </div>`;
  } else {
    html = `
      <p class="method-desc" style="margin-top: 0;">SpareBlok downloads the official, signed playit agent, opens playit.gg for you to approve, then creates the Minecraft tunnel. The tunnel runs only while SpareBlok is open.</p>
      <div class="tunnel-actions"><button class="btn btn-primary" onclick="playitSetup()"><i class="fas fa-route" aria-hidden="true"></i> Set up playit</button></div>`;
  }
  panel.innerHTML = html;
  updateJoinAddress();
}

async function playitSetup() {
  renderPlayit({ ...playitState, phase: 'installing', message: 'Preparing the playit agent...' });
  const res = await mchost.playitEnable();
  if (res.success) {
    playitEnabled = true;
    if (res.phase === 'online') showToast('playit tunnel is online', 'success');
  } else if (!res.cancelled) {
    showToast(res.error, 'error');
  }
  refreshPlayit();
}

async function playitCancel() {
  await mchost.playitCancel();
}

async function playitRetry() {
  const res = await mchost.playitRetry();
  if (res.success === false) showToast(res.error, 'error');
}

async function playitDisable() {
  await mchost.playitDisable();
  playitEnabled = false;
  refreshPlayit();
}

async function playitUnlink() {
  const ok = await confirmDialog('Unlink playit account?',
    'The tunnel stops and SpareBlok forgets its playit key. Your tunnel stays in your playit account, so linking again later gives the same address.',
    'Unlink', true);
  if (!ok) return;
  await mchost.playitUnlink();
  playitEnabled = false;
  refreshPlayit();
}

// --- Theme ---
async function setTheme(theme) {
  currentConfig = await mchost.saveConfig({ theme });
  highlightTheme();
  // Canvas colors come from CSS variables, so redraw after the theme flips.
  requestAnimationFrame(drawChart);
}

function highlightTheme() {
  document.querySelectorAll('#themeSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === (currentConfig.theme || 'system'))));
}

// --- Setup wizard & dialogs ---
async function openSetupWizard() {
  const hw = systemInfo.cpuModel ? systemInfo : await mchost.getSystemInfo();
  systemInfo = hw;
  const rec = await mchost.recommendSettings('paper');
  const recType = rec.suggestedType || 'paper';
  const typeOptions = Object.entries(TYPE_LABELS).map(([k, label]) =>
    `<option value="${k}" ${k === recType ? 'selected' : ''}>${label}${k === recType ? ' (recommended)' : ''}</option>`).join('');

  const result = await showModal({
    title: '<i class="fas fa-cube" aria-hidden="true"></i> Welcome to SpareBlok',
    wide: true,
    body: `
      <p>Let's set up a Minecraft server tuned for this PC. Everything (server files and Java) is downloaded automatically.</p>
      <div class="wizard-hw">
        <div><i class="fas fa-microchip"></i><span>${escapeHtml(hw.cpuModel)}</span><small>${hw.cpuCores} threads, score ${hw.cpuScore}</small></div>
        <div><i class="fas fa-memory"></i><span>${hw.totalMemGB} GB RAM</span><small>${hw.freeMemGB} GB free</small></div>
        <div><i class="fas fa-hard-drive"></i><span>${hw.disk.free} GB free</span><small>${hw.diskType}, ${escapeHtml(hw.disk.drive)}</small></div>
      </div>
      <div class="properties-grid">
        <div class="form-group">
          <label class="setting-label">Server software</label>
          <select class="form-select" id="wizType"></select>
        </div>
        <div class="form-group">
          <label class="setting-label">Minecraft version</label>
          <select class="form-select" id="wizVersion"><option>Loading...</option></select>
        </div>
      </div>
      <div class="wizard-rec" id="wizRec"></div>
      <label class="inline-check eula-check">
        <input type="checkbox" id="wizEula">
        I agree to the <a class="link" onclick="mchost.openExternal('https://aka.ms/MinecraftEULA')">Minecraft EULA</a>
      </label>`,
    onOpen: () => {
      const typeSel = document.getElementById('wizType');
      typeSel.innerHTML = typeOptions;
      const loadWizard = async () => {
        const type = typeSel.value;
        const verSel = document.getElementById('wizVersion');
        verSel.innerHTML = '<option>Loading...</option>';
        const [versions, r] = await Promise.all([
          versionCache[type] ? Promise.resolve(versionCache[type]) : mchost.getMcVersions(type),
          mchost.recommendSettings(type),
        ]);
        if (Array.isArray(versions)) {
          versionCache[type] = versions;
          verSel.innerHTML = versions.slice(0, 40).map((v, i) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}${i === 0 ? ' (latest)' : ''}</option>`).join('');
        } else verSel.innerHTML = '<option value="">Offline - cannot load versions</option>';
        document.getElementById('wizRec').innerHTML = `
          <div class="breakdown-list">
            <div class="breakdown-item"><span>Performance profile</span><span>${presets.profiles[r.performanceProfile].label}</span></div>
            <div class="breakdown-item"><span>RAM for server</span><span>${r.maxRam.replace('G', ' GB')}</span></div>
            <div class="breakdown-item"><span>View / simulation distance</span><span>${r.viewDistance} / ${r.simulationDistance}</span></div>
            <div class="breakdown-item recommended"><span>Players this PC can handle</span><span>~${r.estimate.recommended}</span></div>
          </div>`;
        document.getElementById('wizRec').dataset.rec = JSON.stringify(r);
      };
      typeSel.addEventListener('change', loadWizard);
      loadWizard();
    },
    actions: [
      { label: 'Skip, I\'ll configure it myself', value: null, cls: 'btn-ghost' },
      {
        label: '<i class="fas fa-download" aria-hidden="true"></i> Set up server',
        cls: 'btn-primary',
        collect: () => {
          if (!document.getElementById('wizEula').checked) {
            showToast('Please accept the Minecraft EULA to continue', 'warning');
            return undefined; // keep dialog open
          }
          const version = document.getElementById('wizVersion').value;
          if (!version) return undefined;
          return { type: document.getElementById('wizType').value, version, rec: JSON.parse(document.getElementById('wizRec').dataset.rec || '{}') };
        },
      },
    ],
  });

  if (!result) {
    currentConfig = await mchost.saveConfig({ setupComplete: true });
    return;
  }
  const r = result.rec;
  currentConfig = await mchost.saveConfig({
    eulaAccepted: true,
    performanceProfile: r.performanceProfile,
    maxRam: r.maxRam,
    minRam: r.minRam,
    viewDistance: r.viewDistance,
    simulationDistance: r.simulationDistance,
    jvmPreset: r.jvmPreset,
    jvmArgs: r.jvmArgs,
    maxPlayers: r.maxPlayers,
  });
  updatePerformancePage();
  updatePropertiesPage();
  selectedType = result.type;
  navigateTo('modloader');
  updateModLoaderPage();
  await loadMcVersions(result.type);
  document.getElementById('mcVersionSelect').value = result.version;
  await installServer();
  if (currentConfig.launch) {
    navigateTo('dashboard');
    showToast('All set. Press Start server when you are ready.', 'success');
  }
}

async function showEulaDialog() {
  const ok = await showModal({
    title: '<i class="fas fa-file-contract"></i> Minecraft EULA',
    body: '<p>To run a Minecraft server you must agree to the Minecraft End User License Agreement.</p>' +
      '<p><a class="link" onclick="mchost.openExternal(\'https://aka.ms/MinecraftEULA\')">Read the EULA <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a></p>',
    actions: [
      { label: 'Cancel', value: false, cls: 'btn-ghost' },
      { label: 'I agree', value: true, cls: 'btn-primary' },
    ],
  });
  if (ok) currentConfig = await mchost.saveConfig({ eulaAccepted: true });
  return ok;
}

async function requestClose() {
  const res = await mchost.close();
  if (!res?.running) return;
  const choice = await showModal({
    title: '<i class="fas fa-server"></i> The server is still running',
    body: '<p>Minimize to the system tray to keep hosting, or stop the server and exit.</p>',
    actions: [
      { label: 'Cancel', value: null, cls: 'btn-ghost' },
      { label: 'Stop and exit', value: 'quit', cls: 'btn-danger' },
      { label: 'Keep running in tray', value: 'tray', cls: 'btn-primary' },
    ],
  });
  if (choice === 'tray') {
    showToast('SpareBlok is still running in the system tray', 'info');
    mchost.hideToTray();
  } else if (choice === 'quit') {
    showToast('Stopping the server and exiting...', 'info');
    mchost.quitApp();
  }
}

// Native <dialog>: focus trap, Escape, inert background and focus return for free.
let modalResolve = null;
function showModal({ title, body, actions, wide, onOpen }) {
  const modal = document.getElementById('modal');
  if (modalResolve) modalResolve(null);
  if (modal.open) modal.close();
  modal.className = 'modal' + (wide ? ' wide' : '');
  modal.innerHTML = `<div class="modal-inner"><h2 id="modalTitle">${title}</h2><div class="modal-body">${body}</div><div class="modal-actions"></div></div>`;
  const bar = modal.querySelector('.modal-actions');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modalResolve = null;
      resolve(value);
    };
    modalResolve = finish;
    const close = (value) => {
      finish(value);
      if (modal.open) modal.close();
    };
    modal.onclose = () => finish(null); // Escape key
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (a.cls || 'btn-ghost');
      btn.innerHTML = a.label;
      btn.onclick = () => {
        if (a.collect) {
          const v = a.collect();
          if (v !== undefined) close(v);
        } else close(a.value);
      };
      bar.appendChild(btn);
    });
    modal.showModal();
    onOpen?.();
    // Destructive dialogs start on Cancel so Enter never deletes by accident.
    const safeDefault = bar.lastElementChild?.classList.contains('btn-danger') ? bar.firstElementChild : bar.lastElementChild;
    (modal.querySelector('.modal-body input:not([type=checkbox]), .modal-body textarea, .modal-body select') || safeDefault)?.focus();
  });
}

function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return showModal({
    title,
    body: `<p>${message}</p>`,
    actions: [
      { label: 'Cancel', value: false, cls: 'btn-ghost' },
      { label: okLabel, value: true, cls: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });
}

function promptDialog(title, initial) {
  return showModal({
    title,
    body: `<input type="text" class="form-input" id="promptInput" value="${escapeHtml(initial)}" onkeydown="if(event.key==='Enter') this.closest('.modal').querySelector('.btn-primary').click()">`,
    actions: [
      { label: 'Cancel', value: null, cls: 'btn-ghost' },
      { label: 'OK', cls: 'btn-primary', collect: () => document.getElementById('promptInput').value.trim() },
    ],
  });
}

// --- Background task progress ---
let taskHideTimer = null;
function updateTaskProgress(t) {
  const card = document.getElementById('taskCard');
  clearTimeout(taskHideTimer);
  card.classList.remove('hidden', 'error', 'done');
  document.getElementById('taskLabel').textContent = t.error ? `${t.label}: ${t.error}` : t.label;
  const fill = document.getElementById('taskFill');
  if (t.done) {
    card.classList.add(t.error ? 'error' : 'done');
    fill.classList.remove('indeterminate');
    fill.style.width = '100%';
    document.getElementById('taskPercent').textContent = t.error ? '' : '✓';
    taskHideTimer = setTimeout(() => card.classList.add('hidden'), t.error ? 6000 : 1500);
    return;
  }
  if (t.percent >= 0) {
    fill.classList.remove('indeterminate');
    fill.style.width = t.percent + '%';
    document.getElementById('taskPercent').textContent = t.total
      ? `${t.percent}%, ${formatFileSize(t.downloaded)} / ${formatFileSize(t.total)}`
      : `${t.percent}%`;
  } else {
    fill.classList.add('indeterminate');
    document.getElementById('taskPercent').textContent = '';
  }
}

// --- Toast Notifications ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const icons = {
    success: 'fas fa-circle-check',
    error: 'fas fa-circle-xmark',
    warning: 'fas fa-triangle-exclamation',
    info: 'fas fa-circle-info',
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="${icons[type]} toast-icon" aria-hidden="true"></i><span class="toast-message"></span>`;
  // Success messages stay calm: no exclamation marks.
  toast.querySelector('.toast-message').textContent = type === 'success' ? message.replace(/!+$/, '') : message;
  container.appendChild(toast);
  while (container.childElementCount > 4) container.firstElementChild.remove();
  let timer;
  const dismiss = () => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 220);
  };
  const arm = () => { timer = setTimeout(dismiss, type === 'error' ? 7000 : 4500); };
  toast.addEventListener('mouseenter', () => clearTimeout(timer)); // pause while reading
  toast.addEventListener('mouseleave', arm);
  arm();
}

// --- Helper Functions ---
function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatMB(mb) {
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb + ' MB';
}

function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function parseRamGB(value) {
  const n = parseFloat(String(value || '0'));
  return /m/i.test(String(value)) ? n / 1024 : n;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function copyText(text) {
  if (!text || text === '--') return;
  navigator.clipboard.writeText(text).then(() => showToast(`Copied ${text}`, 'success'));
}
