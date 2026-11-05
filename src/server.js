// Runs the Minecraft server process: start/stop, console I/O, player tracking,
// resource monitoring and crash auto-restart.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeProperties } = require('./properties');
const { parseRam } = require('./capacity');

// "1.5G" -> 1536, "512M" -> 512. Never below 512 MB, which no server can start in.
function heapMB(value) {
  return Math.max(512, Math.round(parseRam(value) * 1024));
}

const PRIORITIES = {
  low: os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  above: os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
};

const NAME = '([A-Za-z0-9_.]{1,20})';
const RE_JOIN = new RegExp(`\\]: ${NAME} joined the game`);
const RE_LEAVE = new RegExp(`\\]: ${NAME} left the game`);
const RE_LIST = /There are (\d+) of a max(?: of)? (\d+) players online:\s*(.*)$/;
const RE_LIST_OLD = /There are (\d+)\/(\d+) players online:\s*(.*)$/;
const RE_DONE = /Done \([\d.,]+m?s\)!/;
const RE_SAVED = /Saved the (game|world)/i;

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.monitor = null;
    this.state = 'offline';
    this.players = new Set();
    this.startedAt = null;
    this.stopRequested = false;
    this.restartTimer = null;
    this.crashTimes = [];
    this.partial = '';
    this.expectListNames = false;
    this.procStats = { cpuPercent: 0, memBytes: 0 };
    this.lastStart = null; // { cfg, java }
    this.joinMessage = null; // tellraw component sent privately to each player on join
  }

  get running() {
    return this.proc !== null;
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, ...extra });
  }

  log(text) {
    this.emit('output', text.endsWith('\n') ? text : text + '\n');
  }

  status() {
    return {
      state: this.state,
      running: this.running,
      pid: this.proc?.pid || null,
      startedAt: this.startedAt,
      players: [...this.players],
      restartPending: !!this.restartTimer,
    };
  }

  buildArgs(cfg) {
    const extra = (cfg.jvmArgs || '').split(/\s+/).filter(Boolean)
      .filter((a) => !/^-Xm[xs]/i.test(a)); // RAM comes from the sliders
    // Java only takes whole numbers ("-Xmx1.5G" refuses to start), so pass megabytes.
    const maxMB = heapMB(cfg.maxRam);
    const minMB = Math.min(heapMB(cfg.minRam), maxMB);
    const args = [
      `-Xmx${maxMB}M`,
      `-Xms${minMB}M`,
      ...extra,
      '-Dfile.encoding=UTF-8',
      '-Dlog4j2.formatMsgNoLookups=true', // Log4Shell mitigation for old versions
    ];
    if (cfg.launch.kind === 'args') args.push(`@${cfg.launch.file}`);
    else args.push('-jar', cfg.launch.file);
    args.push('nogui');
    return args;
  }

  start(cfg, javaPath) {
    if (this.proc) return { success: false, error: 'Server is already running' };
    if (!cfg.launch) return { success: false, error: 'No server installed yet. Install one from the Mod Loader page.' };
    if (!cfg.eulaAccepted) return { success: false, error: 'You must accept the Minecraft EULA first.', needEula: true };

    const dir = cfg.serverDirectory;
    const launchFile = path.join(dir, cfg.launch.file);
    if (!fs.existsSync(launchFile)) {
      return { success: false, error: `Server file missing (${cfg.launch.file}). Reinstall from the Mod Loader page.` };
    }

    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    writeProperties(dir, cfg);
    fs.writeFileSync(path.join(dir, 'eula.txt'),
      '#By changing the setting below to TRUE you are indicating your agreement to the EULA (https://aka.ms/MinecraftEULA).\neula=true\n');

    const args = this.buildArgs(cfg);
    this.log(`[SpareBlok] Starting ${cfg.installedType || cfg.serverType} ${cfg.installedVersion || cfg.mcVersion} with ${cfg.maxRam} RAM`);
    this.log(`[SpareBlok] ${javaPath} ${args.join(' ')}`);

    try {
      this.proc = spawn(javaPath, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.proc = null;
      return { success: false, error: err.message };
    }

    this.lastStart = { cfg, javaPath };
    this.stopRequested = false;
    this.startedAt = Date.now();
    this.players.clear();
    this.emit('players', []);
    this.partial = '';
    this.setState('starting');

    const onData = (data) => this.handleOutput(data.toString());
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.stdin.on('error', () => { /* process already gone */ });

    this.proc.on('error', (err) => {
      this.log(`[SpareBlok] Failed to launch Java: ${err.message}`);
    });
    this.proc.on('close', (code) => this.handleExit(code));

    try {
      os.setPriority(this.proc.pid, PRIORITIES[cfg.processPriority] ?? PRIORITIES.normal);
    } catch (e) { /* high priority may need admin */ }
    this.startMonitor(this.proc.pid);
    return { success: true };
  }

  handleOutput(text) {
    this.emit('output', text);
    const lines = (this.partial + text).split(/\r?\n/);
    this.partial = lines.pop();
    for (const line of lines) this.parseLine(line);
  }

  parseLine(line) {
    let m;
    if (this.state === 'starting' && RE_DONE.test(line)) {
      this.setState('online');
      return;
    }
    if (this.expectListNames) {
      this.expectListNames = false;
      const names = line.replace(/^.*\]:\s*/, '');
      this.setPlayers(names.split(',').map((s) => s.trim()).filter(Boolean));
      return;
    }
    if ((m = line.match(RE_JOIN))) {
      this.players.add(m[1]);
      this.emit('players', [...this.players]);
      this.greet(m[1]);
    } else if ((m = line.match(RE_LEAVE))) {
      this.players.delete(m[1]);
      this.emit('players', [...this.players]);
    } else if ((m = line.match(RE_LIST_OLD) || line.match(RE_LIST))) {
      const count = parseInt(m[1], 10);
      const names = (m[m.length - 1] || '').trim();
      if (count > 0 && !names) this.expectListNames = true; // 1.12 prints names on the next line
      else this.setPlayers(names ? names.split(',').map((s) => s.trim()).filter(Boolean) : []);
    } else if (RE_SAVED.test(line)) {
      this.emit('saved');
    }
  }

  // Wait a moment so the player's chat is ready, and skip them if they already left.
  // Names are limited to [A-Za-z0-9_.] by RE_JOIN, so they are safe inside a command.
  greet(name) {
    if (!this.joinMessage) return;
    setTimeout(() => {
      if (this.proc && this.players.has(name)) this.command(`tellraw ${name} ${this.joinMessage}`);
    }, 2000);
  }

  setPlayers(list) {
    this.players = new Set(list.map((n) => n.replace(/\s*\(.*\)$/, '')));
    this.emit('players', [...this.players]);
  }

  handleExit(code) {
    const wasRequested = this.stopRequested;
    const uptime = Date.now() - (this.startedAt || Date.now());
    this.proc = null;
    this.stopMonitor();
    this.startedAt = null;
    this.players.clear();
    this.emit('players', []);
    this.procStats = { cpuPercent: 0, memBytes: 0 };
    this.log(`[SpareBlok] Server stopped (exit code ${code})`);

    const crashed = !wasRequested && code !== 0;
    this.setState('offline', { code, crashed });
    this.emit('exit', { code, crashed });

    if (crashed && this.lastStart?.cfg.autoRestart) {
      const now = Date.now();
      this.crashTimes = this.crashTimes.filter((t) => now - t < 10 * 60 * 1000);
      this.crashTimes.push(now);
      if (uptime < 30000 && this.crashTimes.length >= 2) {
        this.log('[SpareBlok] Server crashed right after starting - not restarting. Check the log above for the error.');
      } else if (this.crashTimes.length > 3) {
        this.log('[SpareBlok] Server crashed 3 times in 10 minutes - auto-restart paused.');
      } else {
        this.log('[SpareBlok] Server crashed. Restarting in 10 seconds...');
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.emit('auto-restart');
        }, 10000);
        this.emit('state', { state: 'offline', restartPending: true });
      }
    }
  }

  command(cmd) {
    if (!this.proc) return { success: false, error: 'Server is not running' };
    this.proc.stdin.write(cmd.trim() + '\n');
    return { success: true };
  }

  stop(timeoutMs = 60000) {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.proc) return Promise.resolve({ success: false, error: 'Server is not running' });
    this.stopRequested = true;
    this.setState('stopping');
    const proc = this.proc;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log('[SpareBlok] Server did not stop in time - forcing shutdown.');
        proc.kill();
      }, timeoutMs);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve({ success: true });
      });
      try { proc.stdin.write('stop\n'); } catch (e) { proc.kill(); }
    });
  }

  kill() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.proc) return { success: false, error: 'Server is not running' };
    this.stopRequested = true;
    this.proc.kill();
    return { success: true };
  }

  cancelRestart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.emit('state', { state: this.state, restartPending: false });
  }

  // One long-lived PowerShell loop reports CPU time + RAM of the Java process.
  // Much cheaper than spawning a process every few seconds on an old PC.
  startMonitor(pid) {
    this.stopMonitor();
    if (process.platform !== 'win32') return;
    const script = `$id=${pid}; while($true){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if(-not $p){break}; ` +
      `[Console]::Out.WriteLine(('{0}|{1}' -f [math]::Round($p.TotalProcessorTime.TotalMilliseconds),$p.WorkingSet64)); ` +
      `[Console]::Out.Flush(); Start-Sleep -Milliseconds 2000 }`;
    const mon = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let last = null;
    let buf = '';
    const cores = os.cpus().length;
    mon.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [cpuMs, mem] = line.trim().split('|').map(Number);
        if (!Number.isFinite(cpuMs)) continue;
        const now = Date.now();
        if (last) {
          const pct = ((cpuMs - last.cpuMs) / ((now - last.time) * cores)) * 100;
          this.procStats.cpuPercent = Math.max(0, Math.min(100, Math.round(pct)));
        }
        this.procStats.memBytes = mem || 0;
        last = { cpuMs, time: now };
      }
    });
    mon.on('error', () => { /* monitoring is optional */ });
    this.monitor = mon;
  }

  stopMonitor() {
    if (this.monitor) {
      try { this.monitor.kill(); } catch (e) { /* ignore */ }
      this.monitor = null;
    }
  }
}

module.exports = { ServerManager };
