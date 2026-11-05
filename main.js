const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore } = require('./src/config');
const system = require('./src/system');
const java = require('./src/java');
const capacity = require('./src/capacity');
const loaders = require('./src/loaders');
const mods = require('./src/mods');
const backups = require('./src/backups');
const upnp = require('./src/upnp');
const crossplay = require('./src/crossplay');
const { ServerManager } = require('./src/server');
const { PlayitManager } = require('./src/playit');
const { safeJoin } = require('./src/util');
const brand = require('./src/brand');

// The app was called MCHost before; keep using %APPDATA%\mchost so existing
// servers, backups and settings survive the rename. (Leaves explicit overrides alone.)
if (app.getPath('userData') === path.join(app.getPath('appData'), app.getName())) {
  app.setPath('userData', path.join(app.getPath('appData'), 'mchost'));
}

// --- Global State ---
let mainWindow = null;
let tray = null;
let isQuitting = false;
let config;
let playit;
const server = new ServerManager();
const consoleHistory = [];
let busyTask = null; // only one install/download at a time
let autoBackupTimer = null;
let backupInProgress = false;
let migrating = false; // the server folder is being moved; nothing may start the server

const ICON = path.join(__dirname, 'assets', 'icon.png');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// --- Window Creation ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121314' : '#f3f3f1',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Links (Modrinth pages, docs) open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // Alt+F4 / taskbar close while the server runs: let the UI ask what to do.
  mainWindow.on('close', (e) => {
    if (!isQuitting && server.running) {
      e.preventDefault();
      send('confirm-close');
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createTray() {
  if (tray || !fs.existsSync(ICON)) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('double-click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const labels = { offline: 'Offline', starting: 'Starting...', online: 'Online', stopping: 'Stopping...' };
  tray.setToolTip(`${brand.SHORT_NAME} - ${config.get().serverName} (${labels[server.state] || server.state})`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${brand.SHORT_NAME}`, click: showWindow },
    { type: 'separator' },
    server.running
      ? { label: 'Stop Server', click: () => server.stop() }
      : { label: 'Start Server', click: () => startServer().then((r) => !r.success && showWindow()) },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ]));
}

async function quitApp() {
  isQuitting = true;
  if (server.running) {
    send('quitting');
    await server.stop(45000);
  }
  if (config.get().upnp) {
    for (const port of [config.get().port, activeBedrockPort()].filter(Boolean)) {
      await upnp.closePort(port).catch(() => {});
    }
  }
  playit?.stop();
  app.quit();
}

app.whenReady().then(() => {
  if (!gotLock) return;
  config = new ConfigStore(app.getPath('userData'), { defaultMotd: brand.joinMessageText(app.getVersion()) });
  server.joinMessage = brand.joinMessageComponent(app.getVersion());
  nativeTheme.themeSource = config.get().theme || 'system';
  playit = new PlayitManager({
    dir: path.join(app.getPath('userData'), 'playit'),
    runtimesDir: config.runtimesDir,
    appVersion: app.getVersion(),
  });
  playit.on('state', (s) => send('playit-state', s));
  createWindow();
  createTray();
  // Bring the tunnel back up automatically if it was set up before.
  if (config.get().playitEnabled && playit.status().linked && playit.status().installed) {
    startPlayit().catch(() => {});
  }
  setInterval(pushStats, 2000);
  // Benchmark after the UI is up so startup stays snappy on slow machines.
  setTimeout(() => system.getCpuScore(), 1500);
});

app.on('window-all-closed', () => {
  if (!server.running || isQuitting) app.quit();
});

// Any quit path (tray, OS, Ctrl+Q) saves the world first instead of killing Java.
app.on('before-quit', (e) => {
  isQuitting = true;
  if (server.running) {
    e.preventDefault();
    // Already stopping (Stop button): wait for that exit instead of never quitting.
    if (server.state === 'stopping') server.once('exit', () => app.quit());
    else server.stop(30000).then(() => app.quit());
    return;
  }
  server.stopMonitor();
  playit?.stop();
});

// --- Server events -> renderer ---
server.on('output', (text) => {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) consoleHistory.push(line);
  }
  if (consoleHistory.length > 2000) consoleHistory.splice(0, consoleHistory.length - 2000);
  send('server-output', text);
});

server.on('state', (s) => {
  send('server-state', { ...server.status(), ...s });
  updateTray();
  if (s.state === 'online') scheduleAutoBackup();
  if (s.state === 'offline') clearInterval(autoBackupTimer);
});

server.on('players', (list) => send('players', list));
server.on('auto-restart', () => {
  if (!isQuitting) startServer();
});

function pushStats() {
  const sys = system.getSystemInfo();
  send('stats', {
    sysCpu: system.sampleSystemCpu(),
    sysMemUsedGB: Math.round((sys.totalMemGB - sys.freeMemGB) * 10) / 10,
    sysMemTotalGB: sys.totalMemGB,
    procCpu: server.procStats.cpuPercent,
    procMemMB: Math.round(server.procStats.memBytes / 1024 / 1024),
    state: server.state,
    uptime: server.startedAt ? Date.now() - server.startedAt : 0,
    players: server.players.size,
  });
}

function progress(id) {
  return (p) => send('task-progress', { id, ...p });
}

async function runTask(id, label, fn) {
  if (busyTask) throw new Error(`Please wait - ${busyTask} is still running`);
  busyTask = label;
  send('task-progress', { id, label, percent: -1 });
  try {
    const result = await fn();
    send('task-progress', { id, label, done: true });
    return result;
  } catch (err) {
    send('task-progress', { id, label, done: true, error: err.message });
    throw err;
  } finally {
    busyTask = null;
  }
}

// --- Hardware snapshot used by the capacity engine ---
async function hardware() {
  const cfg = config.get();
  const sys = system.getSystemInfo();
  const disk = system.getDiskSpace(cfg.serverDirectory);
  const diskType = await system.getDiskType(cfg.serverDirectory);
  return {
    ...sys,
    cpuScore: system.getCpuScore(),
    disk,
    diskType,
    freeDiskGB: disk.free,
  };
}

function activeType() {
  const cfg = config.get();
  return cfg.installedType || cfg.serverType;
}

function activeVersion() {
  const cfg = config.get();
  return cfg.installedVersion || cfg.mcVersion;
}

function modCount(type = activeType()) {
  try {
    return mods.countEnabled(config.get().serverDirectory, type);
  } catch (e) {
    return 0;
  }
}

async function capacityInput(overrides = {}) {
  const cfg = config.get();
  const hw = await hardware();
  return {
    serverType: activeType(),
    ramGB: capacity.parseRam(cfg.maxRam),
    modCount: modCount(),
    viewDistance: cfg.viewDistance,
    simulationDistance: cfg.simulationDistance,
    maxBackups: cfg.maxBackups,
    uploadMbps: cfg.uploadMbps,
    cpuScore: hw.cpuScore,
    cpuCores: hw.cpuCores,
    diskType: hw.diskType,
    freeDiskGB: hw.freeDiskGB,
    totalRamGB: hw.totalMemGB,
    ...overrides,
  };
}

// --- Java ---
async function ensureJava(mcVersion, serverType) {
  const cfg = config.get();
  if (cfg.javaPath && cfg.javaPath !== 'auto') {
    const probed = await java.probeJava(cfg.javaPath, 'Custom');
    if (probed) return probed.path;
    throw new Error(`Custom Java path does not work: ${cfg.javaPath}`);
  }
  const required = await loaders.requiredJava(mcVersion);
  config.update({ javaMajor: required });
  const installs = await java.detectJava(config.runtimesDir);
  const picked = java.pickJava(installs, required, serverType);
  if (picked) return picked.path;

  server.log(`[SpareBlok] Minecraft ${mcVersion} needs Java ${required}. Downloading a portable Java runtime...`);
  const downloaded = await java.downloadJava(config.runtimesDir, required, progress('java'));
  server.log(`[SpareBlok] Java ${downloaded.version} ready.`);
  return downloaded.path;
}

// --- Server control ---
async function startServer() {
  const cfg = config.get();
  if (server.running) return { success: false, error: 'Server is already running' };
  if (!cfg.launch) return { success: false, error: 'No server installed yet. Go to Mod Loader and install one.' };
  if (!cfg.eulaAccepted) return { success: false, needEula: true, error: 'Please accept the Minecraft EULA first.' };
  if (migrating) return { success: false, error: 'Wait for the server folder to finish moving.' };

  let javaPath;
  try {
    javaPath = busyTask
      ? await ensureJava(activeVersion(), activeType())
      : await runTask('java', 'Preparing Java', () => ensureJava(activeVersion(), activeType()));
  } catch (err) {
    return { success: false, error: err.message };
  }

  const result = server.start(config.get(), javaPath);
  if (result.success && cfg.upnp) {
    for (const port of [cfg.port, activeBedrockPort()].filter(Boolean)) {
      upnp.openPort(port)
        .then((r) => server.log(`[SpareBlok] UPnP: port ${port} forwarded to ${r.internal}${r.externalIp ? ` (public IP ${r.externalIp})` : ''}`))
        .catch((e) => server.log(`[SpareBlok] UPnP failed for port ${port}: ${e.message}`));
    }
  }
  return result;
}

// The Bedrock port while Geyser is on, so the firewall, router and tunnel open it too.
function activeBedrockPort() {
  const bedrock = crossplay.status(config.get().serverDirectory, activeType()).bedrock;
  return bedrock.enabled ? bedrock.port : null;
}

// --- Backups ---
function backupDir() {
  return backups.backupDirFor(config.backupsDir, config.get().serverDirectory);
}

function waitForSave(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    server.once('saved', () => {
      clearTimeout(timer);
      setTimeout(resolve, 500);
    });
  });
}

async function backupNow(label = 'manual') {
  if (backupInProgress) throw new Error('A backup is already in progress');
  backupInProgress = true;
  const live = server.state === 'online';
  try {
    if (live) {
      server.command('save-off');
      server.command('save-all flush');
      await waitForSave(20000);
    }
    send('task-progress', { id: 'backup', label: 'Creating backup...', percent: -1 });
    const { launch } = config.get();
    const result = await backups.createBackup({
      serverDir: config.get().serverDirectory,
      dir: backupDir(),
      label,
      maxBackups: config.get().maxBackups,
      // The server jar is re-downloadable and often the biggest file in the folder.
      exclude: launch?.kind === 'jar' && !launch.file.includes('/') ? [launch.file] : [],
    });
    send('task-progress', { id: 'backup', label: 'Backup complete', done: true });
    server.log(`[SpareBlok] Backup created: ${result.name}`);
    return result;
  } catch (err) {
    send('task-progress', { id: 'backup', label: 'Backup failed', done: true, error: err.message });
    throw err;
  } finally {
    if (live && server.running) server.command('save-on');
    backupInProgress = false;
  }
}

function scheduleAutoBackup() {
  clearInterval(autoBackupTimer);
  const minutes = config.get().autoBackupMinutes;
  if (!minutes) return;
  autoBackupTimer = setInterval(() => {
    if (server.state === 'online') backupNow('auto').catch((e) => server.log(`[SpareBlok] Auto-backup failed: ${e.message}`));
  }, minutes * 60 * 1000);
}

// --- IPC Handlers ---
// Every handler returns { success, ... } on failure instead of throwing so the UI
// can show a friendly message.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// Window controls
handle('window-minimize', () => mainWindow?.minimize());
handle('window-maximize', () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));
handle('window-close', () => {
  if (server.running) return { running: true };
  quitApp();
  return { running: false };
});
handle('hide-to-tray', () => {
  mainWindow?.hide();
  return { success: true };
});
handle('quit-app', () => quitApp());

// System
handle('get-system-info', async () => hardware());
handle('detect-java', () => java.detectJava(config.runtimesDir));
handle('get-app-version', () => app.getVersion());
handle('get-brand', () => ({
  appName: brand.APP_NAME,
  shortName: brand.SHORT_NAME,
  author: brand.AUTHOR,
  version: app.getVersion(),
  joinMessage: brand.joinMessageText(app.getVersion()),
}));

// Config
handle('get-config', () => config.get());
handle('save-config', (patch) => {
  const before = config.get();
  const next = config.update(patch);
  if (patch.autoBackupMinutes !== undefined && patch.autoBackupMinutes !== before.autoBackupMinutes) scheduleAutoBackup();
  if (patch.serverName) updateTray();
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  // The tunnel points at a specific local port; follow the server to its new one.
  if (patch.port !== undefined && patch.port !== before.port && next.playitEnabled && playit.status().linked) {
    playit.stop();
    startPlayit().catch(() => {});
  }
  return next;
});
handle('reset-config', () => config.reset());

// Capacity / performance
handle('estimate-capacity', async (overrides = {}) => {
  const input = await capacityInput(overrides);
  return { input, estimate: capacity.estimateCapacity(input), tiers: capacity.ramTiers(input) };
});
handle('recommend-settings', async (serverType) => {
  const hw = await hardware();
  const type = serverType || activeType();
  return capacity.recommendSettings({ ...hw, maxBackups: config.get().maxBackups }, type, modCount(type));
});
handle('get-presets', () => ({ jvm: capacity.JVM_PRESETS, profiles: capacity.PERFORMANCE_PROFILES, loaders: loaders.LOADERS }));

// Server software
handle('get-mc-versions', (type) => loaders.getVersions(type || config.get().serverType));
handle('install-server', ({ type, version }) => runTask('install', `Installing ${type} ${version}`, async () => {
  if (server.running) throw new Error('Stop the server before changing the server software');
  const cfg = config.get();
  const javaPath = ['forge', 'neoforge'].includes(type) ? await ensureJava(version, type) : null;
  server.log(`[SpareBlok] Installing ${loaders.LOADERS[type].label} ${version}...`);
  const result = await loaders.install({
    type,
    mcVersion: version,
    serverDir: cfg.serverDirectory,
    javaPath,
    previousLaunch: cfg.launch,
    onProgress: progress('install'),
    onLog: (t) => server.log(t),
  });
  config.update({
    serverType: type,
    mcVersion: version,
    installedType: type,
    installedVersion: version,
    loaderVersion: result.loaderVersion,
    launch: result.launch,
    setupComplete: true,
  });
  // Fetch Java now (in the background of this task) so the first start is instant.
  if (!javaPath) await ensureJava(version, type).catch(() => {});
  server.log(`[SpareBlok] ${loaders.LOADERS[type].label} ${version}${result.loaderVersion ? ` (loader ${result.loaderVersion})` : ''} installed.`);
  return { success: true, ...result };
}));
handle('download-java', () => runTask('java', 'Downloading Java', () => ensureJava(activeVersion() || '1.21', activeType())));

// Server process
handle('get-server-status', () => server.status());
handle('start-server', () => startServer());
handle('stop-server', () => server.stop());
handle('kill-server', () => server.kill());
handle('cancel-restart', () => server.cancelRestart());
handle('send-command', (cmd) => server.command(cmd));
handle('get-console-history', () => consoleHistory);
handle('get-player-lists', () => {
  const dir = config.get().serverDirectory;
  const read = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return []; }
  };
  return {
    online: [...server.players],
    ops: read('ops.json'),
    whitelist: read('whitelist.json'),
    banned: read('banned-players.json'),
    bannedIps: read('banned-ips.json'),
  };
});

// Mods & plugins
handle('list-mods', () => ({
  type: activeType(),
  folder: mods.contentDir(config.get().serverDirectory, activeType()),
  items: mods.listContent(config.get().serverDirectory, activeType()),
}));
handle('toggle-mod', (file) => mods.toggleContent(config.get().serverDirectory, activeType(), file));
handle('delete-mod', (file) => mods.deleteContent(config.get().serverDirectory, activeType(), file));
handle('add-mod-files', async (paths) => {
  let files = paths;
  if (!files || !files.length) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add mods or plugins',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Java archives', extensions: ['jar'] }],
    });
    if (res.canceled) return { success: false, cancelled: true };
    files = res.filePaths;
  }
  return { success: true, added: mods.addFiles(config.get().serverDirectory, activeType(), files) };
});
handle('search-mods', ({ query, offset }) => mods.search({ query, offset, type: activeType(), mcVersion: activeVersion() }));
handle('install-mod', (projectId) => runTask('mod', 'Installing mod', async () => {
  const installed = await mods.install({
    serverDir: config.get().serverDirectory,
    type: activeType(),
    mcVersion: activeVersion(),
    projectId,
    onProgress: progress('mod'),
  });
  return { success: true, installed };
}));
handle('discover-mods', ({ list, offset }) => mods.discover({ list, offset, type: activeType(), mcVersion: activeVersion() }));
handle('recommended-mods', () => mods.recommended(activeType()));
handle('install-recommended-mods', () => runTask('mod', 'Installing optimization mods', async () => {
  const results = [];
  for (const rec of mods.recommended(activeType())) {
    try {
      const installed = await mods.install({
        serverDir: config.get().serverDirectory, type: activeType(), mcVersion: activeVersion(),
        projectId: rec.slug, onProgress: progress('mod'),
      });
      results.push({ slug: rec.slug, ok: true, installed });
    } catch (e) {
      results.push({ slug: rec.slug, ok: false, error: e.message });
    }
  }
  return { success: true, results };
}));

// Worlds
handle('list-worlds', () => backups.listWorlds(config.get().serverDirectory, config.get().levelName));
handle('set-active-world', (name) => {
  if (server.running) throw new Error('Stop the server before switching worlds');
  return config.update({ levelName: name.replace(/_(nether|the_end)$/, '') });
});
handle('delete-world', (name) => {
  if (server.running) throw new Error('Stop the server before deleting a world');
  backups.deleteWorld(config.get().serverDirectory, name);
  return { success: true };
});
handle('reset-world', () => {
  if (server.running) throw new Error('Stop the server before regenerating the world');
  backups.resetWorld(config.get().serverDirectory, config.get().levelName);
  return { success: true };
});
handle('import-world', async () => {
  if (server.running) throw new Error('Stop the server before importing a world');
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Select a world folder (contains level.dat)', properties: ['openDirectory'] });
  if (res.canceled) return { success: false, cancelled: true };
  const name = backups.importWorld(config.get().serverDirectory, res.filePaths[0]);
  return { success: true, name };
});

// Backups
handle('list-backups', () => ({ dir: backupDir(), items: backups.listBackups(backupDir()) }));
handle('create-backup', async () => ({ success: true, ...(await backupNow('manual')) }));
handle('restore-backup', async (name) => {
  if (server.running) throw new Error('Stop the server before restoring a backup');
  await runTask('restore', 'Restoring backup', () => backups.restoreBackup({
    serverDir: config.get().serverDirectory,
    file: path.join(backupDir(), path.basename(name)),
  }));
  return { success: true };
});
handle('delete-backup', (name) => {
  backups.deleteBackup(backupDir(), name);
  return { success: true };
});

// Files
handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: 'Select Server Directory' });
  return !result.canceled && result.filePaths.length ? result.filePaths[0] : null;
});
// Moves the whole server (worlds, mods, installed software) and its backups to
// another folder, so it keeps working without a reinstall.
function isEmptyDir(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

handle('move-server-directory', (target) => runTask('move', 'Moving server folder', async () => {
  if (server.running) throw new Error('Stop the server before moving it');
  if (backupInProgress) throw new Error('Wait for the backup to finish before moving the server');
  server.cancelRestart(); // a pending crash auto-restart must not start the server mid-move
  migrating = true;
  try {
    return await moveServerDirectory(target);
  } finally {
    migrating = false;
  }
}));

async function moveServerDirectory(target) {
  const from = path.resolve(config.get().serverDirectory);
  let to = path.resolve(target);
  // Picking a folder that already has things in it (like D:\Games) moves the server into a subfolder.
  if (!isEmptyDir(to)) to = path.join(to, `${brand.SHORT_NAME} Server`);
  if (!isEmptyDir(to)) throw new Error(`${to} is not empty. Pick an empty folder.`);
  const fromKey = from.toLowerCase();
  const toKey = to.toLowerCase();
  if (toKey === fromKey || toKey.startsWith(fromKey + path.sep)) throw new Error('Pick a folder outside the current server folder');

  const oldBackups = backupDir();
  if (fs.existsSync(from)) {
    fs.rmSync(to, { recursive: true, force: true }); // empty, checked above
    // mkdir on a drive root (D:\) fails with EPERM even though it exists.
    if (!fs.existsSync(path.dirname(to))) fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to); // instant on the same drive
    } catch (err) {
      // EXDEV: another drive. EPERM/EBUSY/EACCES: a file is open somewhere (Explorer,
      // antivirus), which blocks renaming the folder but not copying it.
      if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      try {
        await fs.promises.cp(from, to, { recursive: true });
      } catch (copyErr) {
        // Leave the original untouched and remove the half-finished copy.
        await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Could not copy the server to ${to}: ${copyErr.message}`);
      }
      // The copy is complete, so a locked leftover file must not undo the move.
      await fs.promises.rm(from, { recursive: true, force: true })
        .catch(() => server.log(`[SpareBlok] Moved the server, but some old files could not be deleted from ${from}`));
    }
  }
  config.update({ serverDirectory: to });

  // Backups are filed per server folder; bring them along.
  const newBackups = backupDir();
  if (newBackups !== oldBackups) {
    for (const f of fs.readdirSync(oldBackups)) fs.renameSync(path.join(oldBackups, f), path.join(newBackups, f));
    fs.rmSync(oldBackups, { recursive: true, force: true });
  }
  server.log(`[SpareBlok] Server folder moved to ${to}`);
  return { success: true, serverDirectory: to };
}
handle('open-directory', (dirPath) => shell.openPath(dirPath || config.get().serverDirectory));
handle('open-external', (url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
handle('list-server-files', (subPath) => {
  const root = config.get().serverDirectory;
  const dir = safeJoin(root, subPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    let size = 0;
    let modified = 0;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      size = e.isFile() ? st.size : 0;
      modified = st.mtimeMs;
    } catch (err) { /* locked file */ }
    return { name: e.name, isDirectory: e.isDirectory(), size, modified, path: path.join(subPath || '', e.name) };
  });
});
handle('read-server-file', (subPath) => {
  const file = safeJoin(config.get().serverDirectory, subPath);
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('File is too large to edit here (max 2 MB)');
  return { success: true, content: fs.readFileSync(file, 'utf8') };
});
handle('write-server-file', (subPath, content) => {
  const file = safeJoin(config.get().serverDirectory, subPath);
  fs.writeFileSync(file, content);
  return { success: true };
});
handle('delete-server-file', (subPath) => {
  if (server.running) throw new Error('Stop the server before deleting files');
  const root = config.get().serverDirectory;
  const target = safeJoin(root, subPath);
  if (target === path.resolve(root)) throw new Error('Cannot delete the server folder');
  fs.rmSync(target, { recursive: true, force: true });
  return { success: true };
});

// Network
// Split so the page renders instantly; the public IP and firewall lookups are slow.
handle('get-network-info', () => ({
  local: system.getLocalAddresses(), port: config.get().port, upnp: config.get().upnp, bedrockPort: activeBedrockPort(),
}));
handle('get-public-ip', () => system.getPublicIp());
handle('get-firewall-status', () => system.getFirewallStatus(config.get().port, activeBedrockPort()));
handle('add-firewall-rule', () => system.addFirewallRule(config.get().port, activeBedrockPort()));
handle('upnp-open', async () => {
  const r = await upnp.openPort(config.get().port);
  const bedrock = activeBedrockPort();
  if (bedrock) await upnp.openPort(bedrock);
  config.update({ upnp: true });
  return r;
});
handle('upnp-close', async () => {
  config.update({ upnp: false });
  const bedrock = activeBedrockPort();
  if (bedrock) await upnp.closePort(bedrock);
  return upnp.closePort(config.get().port);
});

// Who can join: Bedrock (Geyser + Floodgate), other Java versions (ViaVersion), TLauncher (offline mode)
function crossplayStatus() {
  const cfg = config.get();
  return { ...crossplay.status(cfg.serverDirectory, activeType()), offlineMode: cfg.onlineMode === false, type: activeType() };
}

handle('get-crossplay', () => crossplayStatus());
handle('set-crossplay', ({ feature, on }) => {
  if (feature === 'offline') {
    config.update({ onlineMode: !on });
    return { success: true, ...crossplayStatus() };
  }
  const bedrockBefore = activeBedrockPort();
  return runTask('crossplay', on ? 'Setting up cross-play' : 'Turning off cross-play', async () => {
    await crossplay.setFeature(feature, on, {
      serverDir: config.get().serverDirectory, type: activeType(), mcVersion: activeVersion(), onProgress: progress('crossplay'),
    });
    const bedrockAfter = activeBedrockPort();
    if (bedrockAfter !== bedrockBefore) {
      // Open or close the Bedrock port everywhere the Java port is already open.
      if (config.get().upnp) {
        if (bedrockAfter) upnp.openPort(bedrockAfter).catch((e) => server.log(`[SpareBlok] UPnP failed for port ${bedrockAfter}: ${e.message}`));
        else upnp.closePort(bedrockBefore).catch(() => {});
      }
      if (config.get().playitEnabled && playit.status().linked) {
        playit.stop();
        startPlayit().catch(() => {});
      }
    }
    return { success: true, ...crossplayStatus() };
  });
});
handle('install-login-plugin', () => runTask('crossplay', 'Installing login plugin', async () => {
  await crossplay.installLoginPlugin({
    serverDir: config.get().serverDirectory, type: activeType(), mcVersion: activeVersion(), onProgress: progress('crossplay'),
  });
  return { success: true, ...crossplayStatus() };
}));

// playit.gg tunnel
async function startPlayit() {
  try {
    return { success: true, ...(await playit.start(config.get().port, activeBedrockPort())) };
  } catch (err) {
    playit.setState({ phase: 'error', message: err.message });
    throw err;
  }
}

handle('playit-status', () => ({ ...playit.status(), enabled: !!config.get().playitEnabled }));
// One button does everything: download agent, link in browser, create tunnel.
handle('playit-enable', async () => {
  try {
    await playit.install(progress('playit'));
    send('task-progress', { id: 'playit', label: 'playit agent ready', done: true });
    if (!playit.readSecret()) {
      const { url, done } = playit.startLink();
      shell.openExternal(url);
      if (!(await done)) {
        playit.setState({ phase: 'off', message: null, claimUrl: null });
        return { success: false, cancelled: true };
      }
    }
    config.update({ playitEnabled: true });
    return await startPlayit();
  } catch (err) {
    playit.setState({ phase: 'error', message: err.message });
    return { success: false, error: err.message };
  }
});
handle('playit-open-claim', () => {
  const url = playit.status().claimUrl;
  if (url) shell.openExternal(url);
});
handle('playit-cancel', () => {
  playit.cancelLink();
  return { success: true };
});
handle('playit-retry', () => startPlayit());
handle('playit-disable', () => {
  config.update({ playitEnabled: false });
  playit.stop();
  return { success: true };
});
handle('playit-unlink', () => {
  config.update({ playitEnabled: false });
  playit.unlink();
  return { success: true };
});
handle('playit-log', () => playit.logTail());
