const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (callback) => {
  const listener = (_, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('mchost', {
  // Window controls
  minimize: invoke('window-minimize'),
  maximize: invoke('window-maximize'),
  close: invoke('window-close'),
  hideToTray: invoke('hide-to-tray'),
  quitApp: invoke('quit-app'),

  // System info
  getSystemInfo: invoke('get-system-info'),
  detectJava: invoke('detect-java'),
  downloadJava: invoke('download-java'),
  getAppVersion: invoke('get-app-version'),
  getBrand: invoke('get-brand'),

  // Config
  getConfig: invoke('get-config'),
  saveConfig: invoke('save-config'),
  resetConfig: invoke('reset-config'),

  // Performance & capacity
  estimateCapacity: invoke('estimate-capacity'),
  recommendSettings: invoke('recommend-settings'),
  getPresets: invoke('get-presets'),

  // Server software
  getMcVersions: invoke('get-mc-versions'),
  installServer: invoke('install-server'),

  // Server management
  getServerStatus: invoke('get-server-status'),
  startServer: invoke('start-server'),
  stopServer: invoke('stop-server'),
  killServer: invoke('kill-server'),
  cancelRestart: invoke('cancel-restart'),
  sendCommand: invoke('send-command'),
  getConsoleHistory: invoke('get-console-history'),
  getPlayerLists: invoke('get-player-lists'),

  // Mods & plugins
  listMods: invoke('list-mods'),
  toggleMod: invoke('toggle-mod'),
  deleteMod: invoke('delete-mod'),
  addModFiles: invoke('add-mod-files'),
  searchMods: invoke('search-mods'),
  discoverMods: invoke('discover-mods'),
  installMod: invoke('install-mod'),
  recommendedMods: invoke('recommended-mods'),
  installRecommendedMods: invoke('install-recommended-mods'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Worlds
  listWorlds: invoke('list-worlds'),
  setActiveWorld: invoke('set-active-world'),
  deleteWorld: invoke('delete-world'),
  resetWorld: invoke('reset-world'),
  importWorld: invoke('import-world'),

  // Backups
  listBackups: invoke('list-backups'),
  createBackup: invoke('create-backup'),
  restoreBackup: invoke('restore-backup'),
  deleteBackup: invoke('delete-backup'),

  // Files
  selectDirectory: invoke('select-directory'),
  moveServerDirectory: invoke('move-server-directory'),
  openDirectory: invoke('open-directory'),
  openExternal: invoke('open-external'),
  listServerFiles: invoke('list-server-files'),
  readServerFile: invoke('read-server-file'),
  writeServerFile: invoke('write-server-file'),
  deleteServerFile: invoke('delete-server-file'),

  // Network
  getNetworkInfo: invoke('get-network-info'),
  getPublicIp: invoke('get-public-ip'),
  getFirewallStatus: invoke('get-firewall-status'),
  addFirewallRule: invoke('add-firewall-rule'),
  upnpOpen: invoke('upnp-open'),
  upnpClose: invoke('upnp-close'),
  getCrossplay: invoke('get-crossplay'),
  setCrossplay: invoke('set-crossplay'),
  installLoginPlugin: invoke('install-login-plugin'),
  playitStatus: invoke('playit-status'),
  playitEnable: invoke('playit-enable'),
  playitOpenClaim: invoke('playit-open-claim'),
  playitCancel: invoke('playit-cancel'),
  playitRetry: invoke('playit-retry'),
  playitDisable: invoke('playit-disable'),
  playitUnlink: invoke('playit-unlink'),
  playitLog: invoke('playit-log'),
  onPlayitState: on('playit-state'),

  // Events
  onServerOutput: on('server-output'),
  onServerState: on('server-state'),
  onPlayers: on('players'),
  onStats: on('stats'),
  onTaskProgress: on('task-progress'),
  onConfirmClose: on('confirm-close'),
  onQuitting: on('quitting'),
});
