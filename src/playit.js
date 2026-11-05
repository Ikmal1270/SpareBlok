// playit.gg tunnel: lets friends join over the internet without port forwarding,
// even behind CGNAT (mobile/5G broadband). Flow:
//   1. download the signed playitd agent (portable, no admin, no service)
//   2. link: user approves SpareBlok in the browser (claim code -> secret key)
//   3. run playitd with SpareBlok's own secret file
//   4. create a "minecraft-java" tunnel to 127.0.0.1:<port> and report its address
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { request, downloadFile } = require('./net');
const { runPowerShell } = require('./util');

const API = 'https://api.playit.gg';
const AGENT_VERSION = 'v1.1.0';
const SIGNER = 'Developed Methods LLC';
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

class PlayitError extends Error {}

class PlayitManager extends EventEmitter {
  constructor({ dir, runtimesDir, appVersion }) {
    super();
    this.dir = dir;
    this.secretFile = path.join(dir, 'playit.toml');
    this.logFile = path.join(dir, 'logs', 'playitd.log');
    this.exe = path.join(runtimesDir, 'playit', 'playitd.exe');
    this.appVersion = appVersion;
    this.proc = null;
    this.claim = null; // { code, cancelled }
    this.pollTimer = null;
    this.state = { phase: 'off' };
    fs.mkdirSync(dir, { recursive: true });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.status());
  }

  status() {
    return {
      ...this.state,
      installed: fs.existsSync(this.exe),
      linked: !!this.readSecret(),
      running: !!this.proc,
    };
  }

  readSecret() {
    try {
      const m = fs.readFileSync(this.secretFile, 'utf8').match(/secret_key\s*=\s*"([0-9a-fA-F]+)"/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  writeSecret(secret) {
    if (!/^[0-9a-fA-F]+$/.test(secret)) throw new PlayitError('playit returned an invalid secret key');
    fs.writeFileSync(this.secretFile, `secret_key = "${secret}"\n`, { mode: 0o600 });
  }

  async api(apiPath, body = {}, auth = true) {
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (auth) {
      const secret = this.readSecret();
      if (!secret) throw new PlayitError('playit is not linked yet');
      headers.Authorization = `Agent-Key ${secret}`;
    }
    const res = await request(API + apiPath, { method: 'POST', body: payload, headers, timeout: 15000 });
    let text = '';
    for await (const chunk of res) text += chunk;
    if (res.statusCode === 429) throw new PlayitError('playit is rate limiting requests. Try again in a minute.');
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new PlayitError(`Unexpected reply from playit (HTTP ${res.statusCode})`);
    }
    if (json.status === 'success') return json.data;
    if (json.status === 'fail') {
      const err = new PlayitError(describeFail(json.data));
      err.code = json.data;
      throw err;
    }
    const err = new PlayitError(json.data?.message || 'playit API error');
    err.code = json.data?.message;
    throw err;
  }

  // --- 1. Agent download ---------------------------------------------------
  async install(onProgress) {
    if (fs.existsSync(this.exe)) return;
    const arch = os.arch() === 'ia32' ? 'x86' : 'x86_64';
    const url = `https://github.com/playit-cloud/playit-agent/releases/download/${AGENT_VERSION}/playitd-windows-${arch}-signed.exe`;
    fs.mkdirSync(path.dirname(this.exe), { recursive: true });
    const tmp = this.exe + '.download';
    this.setState({ phase: 'installing', message: 'Downloading the playit agent...' });
    await downloadFile(url, tmp, (p) => onProgress?.({ ...p, label: 'Downloading playit agent' }));

    // Only run a binary signed by playit's publisher.
    const res = await runPowerShell(
      `$s = Get-AuthenticodeSignature -LiteralPath '${tmp.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`, 20000);
    const [sigStatus, subject = ''] = res.stdout.trim().split('|');
    if (sigStatus !== 'Valid' || !subject.includes(SIGNER)) {
      fs.rmSync(tmp, { force: true });
      throw new PlayitError('The downloaded playit agent failed its signature check, so it was deleted.');
    }
    fs.renameSync(tmp, this.exe);
  }

  // --- 2. Account linking (claim) -------------------------------------------
  // Returns the claim URL immediately; resolves `done` when the user approves.
  startLink() {
    this.cancelLink();
    const code = crypto.randomBytes(5).toString('hex');
    const url = `https://playit.gg/claim/${code}`;
    const claim = { code, cancelled: false };
    this.claim = claim;
    this.setState({ phase: 'linking', claimUrl: url, message: 'Waiting for you to approve SpareBlok in the browser...' });

    const done = (async () => {
      const deadline = Date.now() + CLAIM_TIMEOUT_MS;
      while (!claim.cancelled && Date.now() < deadline) {
        let setup;
        try {
          setup = await this.api('/claim/setup', {
            code, agent_type: 'self-managed', version: `SpareBlok ${this.appVersion}`,
          }, false);
        } catch (e) {
          if (e.code === 'CodeExpired' || e.code === 'InvalidCode') throw new PlayitError('The link expired. Press Link again.');
          await sleep(3000);
          continue;
        }
        if (setup === 'UserRejected') throw new PlayitError('The link was declined in the browser.');
        if (setup === 'UserAccepted') {
          const { secret_key: secret } = await this.api('/claim/exchange', { code }, false);
          this.writeSecret(secret);
          return true;
        }
        await sleep(2000);
      }
      if (claim.cancelled) return false;
      throw new PlayitError('Linking timed out. Press Link again.');
    })();

    return { url, done };
  }

  cancelLink() {
    if (this.claim) this.claim.cancelled = true;
    this.claim = null;
  }

  // --- 3 + 4. Run agent and ensure a Minecraft tunnel -----------------------
  // `bedrockPort` is set while Bedrock players can join through Geyser; they get
  // a second, UDP tunnel.
  async start(port, bedrockPort = null) {
    if (!fs.existsSync(this.exe)) throw new PlayitError('The playit agent is not installed');
    if (!this.readSecret()) throw new PlayitError('playit is not linked yet');
    this.bedrockPort = bedrockPort;
    this.startDaemon();
    this.setState({
      phase: 'starting', message: 'Connecting to playit...', claimUrl: null, bedrockAddress: null, bedrockMessage: null,
    });

    const run = await this.api('/agents/rundata');
    const blocked = accountProblem(run.account_status);
    if (blocked) {
      this.setState({ phase: 'action', message: blocked, actionUrl: 'https://playit.gg/account' });
      return this.status();
    }

    let tunnel = findTunnel(run, port);
    if (!tunnel && !hasPending(run)) {
      this.setState({ phase: 'creating', message: 'Creating your Minecraft tunnel...' });
      try {
        await this.api('/tunnels/create', {
          name: 'SpareBlok Minecraft',
          tunnel_type: 'minecraft-java',
          port_type: 'tcp',
          port_count: 1,
          origin: { type: 'agent', data: { agent_id: run.agent_id, local_ip: '127.0.0.1', local_port: port } },
          enabled: true,
          alloc: null,
          firewall_id: null,
          proxy_protocol: null,
        });
      } catch (e) {
        this.setState({
          phase: 'action',
          message: `playit could not create the tunnel automatically (${e.message}). Add a "Minecraft Java" tunnel for this agent in the playit dashboard, pointing to 127.0.0.1:${port}.`,
          actionUrl: 'https://playit.gg/account/tunnels',
        });
        this.watch(port);
        return this.status();
      }
    }
    if (bedrockPort) await this.ensureBedrockTunnel(run, bedrockPort);
    if (!tunnel) this.setState({ phase: 'creating', message: 'Waiting for playit to assign your address...' });
    else this.applyTunnel(tunnel);
    this.applyBedrockTunnel(run);
    this.watch(port);
    return this.status();
  }

  // A Bedrock problem only shows a note; Java players can still join.
  async ensureBedrockTunnel(run, bedrockPort) {
    if (findBedrockTunnel(run, bedrockPort) || hasPending(run, 'minecraft-bedrock')) return;
    try {
      await this.api('/tunnels/create', {
        name: 'SpareBlok Bedrock',
        tunnel_type: 'minecraft-bedrock',
        port_type: 'udp',
        port_count: 1,
        origin: { type: 'agent', data: { agent_id: run.agent_id, local_ip: '127.0.0.1', local_port: bedrockPort } },
        enabled: true,
        alloc: null,
        firewall_id: null,
        proxy_protocol: null,
      });
    } catch (e) {
      this.setState({
        bedrockMessage: `playit could not create the Bedrock tunnel (${e.message}). Add a "Minecraft Bedrock" tunnel in the playit dashboard, pointing to 127.0.0.1:${bedrockPort}.`,
      });
    }
  }

  // Bedrock has separate "Server Address" and "Port" boxes, so keep them apart.
  applyBedrockTunnel(run) {
    if (!this.bedrockPort) return;
    const t = findBedrockTunnel(run, this.bedrockPort);
    if (!t || !t.port) return;
    this.setState({ bedrockAddress: { host: t.custom_domain || t.assigned_domain, port: t.port.from }, bedrockMessage: null });
  }

  applyTunnel(t) {
    const host = t.custom_domain || t.assigned_domain;
    // Minecraft Java tunnels publish an SRV record, so the bare hostname works.
    const address = t.tunnel_type === 'minecraft-java' ? host : `${host}:${t.port.from}`;
    const disabled = t.disabled ? 'This tunnel is disabled in your playit account.' : null;
    this.setState({
      phase: disabled ? 'action' : 'online',
      address,
      numericAddress: t.port ? `${host}:${t.port.from}` : null,
      message: disabled || 'Friends can join with this address.',
      actionUrl: disabled ? 'https://playit.gg/account/tunnels' : null,
    });
  }

  // Keep the address fresh (tunnel allocation takes a few seconds after create).
  watch(port) {
    clearTimeout(this.pollTimer);
    let failures = 0;
    const tick = async () => {
      if (!this.proc) return;
      try {
        const run = await this.api('/agents/rundata');
        failures = 0;
        const t = findTunnel(run, port);
        if (t) this.applyTunnel(t);
        this.applyBedrockTunnel(run);
      } catch (e) {
        if (++failures === 3) this.setState({ phase: 'error', message: `Lost contact with playit: ${e.message}` });
      }
      // Poll quickly until the address is assigned, then just keep it fresh.
      this.pollTimer = setTimeout(tick, this.state.phase === 'online' ? 60000 : 4000);
    };
    this.pollTimer = setTimeout(tick, 3000);
  }

  startDaemon() {
    if (this.proc) return;
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const proc = spawn(this.exe, [
      '--secret-path', this.secretFile,
      '--log-path', this.logFile,
      '--socket-path', `\\\\.\\pipe\\mchost-playit-${process.pid}`,
    ], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', (e) => this.setState({ phase: 'error', message: `Could not run the playit agent: ${e.message}` }));
    proc.on('close', (code) => {
      this.proc = null;
      clearTimeout(this.pollTimer);
      if (this.state.phase !== 'off') {
        this.setState({ phase: 'error', message: `The playit agent stopped (exit code ${code}).` });
      }
    });
    this.proc = proc;
  }

  stop() {
    clearTimeout(this.pollTimer);
    this.cancelLink();
    this.setState({ phase: 'off', message: null, actionUrl: null });
    if (this.proc) {
      try { this.proc.kill(); } catch (e) { /* already gone */ }
      this.proc = null;
    }
  }

  unlink() {
    this.stop();
    fs.rmSync(this.secretFile, { force: true });
    this.setState({ phase: 'off', address: null, numericAddress: null, bedrockAddress: null });
  }

  logTail(lines = 40) {
    try {
      return fs.readFileSync(this.logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch (e) {
      return [];
    }
  }
}

function findTunnel(run, port) {
  const tunnels = run.tunnels || [];
  return tunnels.find((t) => t.tunnel_type === 'minecraft-java' && t.local_port === port)
    || tunnels.find((t) => t.local_port === port && t.proto !== 'udp')
    || null;
}

function findBedrockTunnel(run, port) {
  const tunnels = run.tunnels || [];
  return tunnels.find((t) => t.tunnel_type === 'minecraft-bedrock' && t.local_port === port)
    || tunnels.find((t) => t.local_port === port && t.proto === 'udp')
    || null;
}

function hasPending(run, type = 'minecraft-java') {
  return (run.pending || []).some((p) => p.tunnel_type === type);
}

function accountProblem(status) {
  switch (status) {
    case 'email-not-verified': return 'Verify your email address on playit.gg, then press Retry.';
    case 'banned': return 'This playit account is banned.';
    case 'agent-over-limit': return 'Your playit account has too many agents. Remove an old one on playit.gg, then press Retry.';
    case 'agent-disabled': return 'This agent is disabled in your playit account.';
    case 'account-delete-scheduled': return 'This playit account is scheduled for deletion.';
    case 'has-message': return 'playit has a message for you. Open your account to read it, then press Retry.';
    default: return null; // ready, guest
  }
}

function describeFail(code) {
  const map = {
    RequiresVerifiedAccount: 'your playit account needs a verified email',
    RequiresPlayitPremium: 'this needs playit Premium',
    AgentNotFound: 'agent not found',
    AgentVersionTooOld: 'agent version too old',
    InvalidAgentKey: 'the saved key is no longer valid. Unlink and link again',
  };
  return map[code] || String(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { PlayitManager };
