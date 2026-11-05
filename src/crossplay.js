// Lets players on other editions, versions and launchers join:
//   Bedrock (phones, Windows, consoles) - Geyser translates the protocol, Floodgate lets them
//                                          in without a Java account
//   Other Java versions                 - ViaVersion (newer clients) + ViaBackwards (older clients)
//   TLauncher / non-premium accounts    - online-mode=false, ideally with a login plugin
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mods = require('./mods');
const { fetchJson, downloadFile } = require('./net');

const BEDROCK_PORT = 19132;
const GEYSER_API = 'https://download.geysermc.org/v2/projects';

const FEATURES = {
  // Exact jar names, so add-ons like "GeyserSkinManager" or "ViaRewind" are never mistaken for these.
  bedrock: {
    label: 'Bedrock support',
    types: ['paper', 'purpur', 'fabric', 'neoforge'],
    match: [/^geyser-(spigot|fabric|neoforge)\b/i, /^floodgate-(spigot|fabric|neoforge)\b/i],
  },
  via: { label: 'Other Java versions', types: ['paper', 'purpur'], match: [/^viaversion-\d/i, /^viabackwards-\d/i] },
};

// Players pick a password with /register, so nobody can join under someone else's name.
const LOGIN_PLUGINS = {
  paper: { slug: 'authmereloaded', title: 'AuthMe Reloaded', match: /^authme/i },
  purpur: { slug: 'authmereloaded', title: 'AuthMe Reloaded', match: /^authme/i },
  fabric: { slug: 'easyauth', title: 'EasyAuth', match: /^easyauth/i },
};

const GEYSER_CONFIG = {
  paper: 'plugins/Geyser-Spigot/config.yml',
  purpur: 'plugins/Geyser-Spigot/config.yml',
  fabric: 'config/Geyser-Fabric/config.yml',
  neoforge: 'config/Geyser-NeoForge/config.yml',
};

function items(serverDir, type) {
  try {
    return mods.listContent(serverDir, type);
  } catch (e) {
    return [];
  }
}

function findItem(list, re) {
  return list.find((m) => re.test(m.file)) || null;
}

// The Bedrock port Geyser listens on (its config exists after the first start).
function bedrockPort(serverDir, type) {
  try {
    const yml = fs.readFileSync(path.join(serverDir, GEYSER_CONFIG[type]), 'utf8');
    const section = yml.match(/^bedrock:[^\n]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n|#[^\n]*\n)*)/m)?.[1] || '';
    const port = parseInt(section.match(/^[ \t]+port:\s*(\d+)/m)?.[1], 10);
    return port > 0 && port < 65536 ? port : BEDROCK_PORT;
  } catch (e) {
    return BEDROCK_PORT;
  }
}

function featureStatus(key, list, type) {
  const f = FEATURES[key];
  if (!f.types.includes(type)) return { supported: false };
  const found = f.match.map((re) => findItem(list, re));
  return {
    supported: true,
    installed: found.every(Boolean),
    enabled: found.every((m) => m && m.enabled),
  };
}

function status(serverDir, type) {
  const list = items(serverDir, type);
  const login = LOGIN_PLUGINS[type];
  const bedrock = featureStatus('bedrock', list, type);
  return {
    bedrock: { ...bedrock, port: bedrockPort(serverDir, type) },
    via: featureStatus('via', list, type),
    loginPlugin: login ? { title: login.title, installed: !!findItem(list, login.match) } : null,
  };
}

// Floodgate for Paper/Purpur isn't on Modrinth, so it comes from GeyserMC's own
// download API, checked against the SHA-256 that API publishes.
async function installFloodgateSpigot(serverDir, type, onProgress) {
  const build = await fetchJson(`${GEYSER_API}/floodgate/versions/latest/builds/latest`);
  const dl = build.downloads?.spigot;
  if (!dl || !/^[\w.-]+\.jar$/.test(dl.name)) throw new Error('GeyserMC did not return a Floodgate download');
  const dest = path.join(mods.contentDir(serverDir, type), dl.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `${GEYSER_API}/floodgate/versions/${build.version}/builds/${build.build}/downloads/spigot`;
  await downloadFile(url, dest, (p) => onProgress?.({ ...p, label: 'Downloading Floodgate' }));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (hash !== dl.sha256) {
    fs.rmSync(dest, { force: true });
    throw new Error('The Floodgate download failed its checksum, so it was deleted.');
  }
  mods.recordInstall(serverDir, type, dl.name, { slug: 'floodgate', title: 'Floodgate', version: `${build.version}-b${build.build}` });
}

async function installFeature(key, { serverDir, type, mcVersion, onProgress }) {
  const fromModrinth = (projectId) => mods.install({ serverDir, type, mcVersion, projectId, onProgress });
  try {
    if (key === 'bedrock') {
      await fromModrinth('geyser');
      if (['paper', 'purpur'].includes(type)) await installFloodgateSpigot(serverDir, type, onProgress);
      else await fromModrinth('floodgate');
    } else if (key === 'via') {
      await fromModrinth('viaversion');
      await fromModrinth('viabackwards');
    }
  } catch (err) {
    if (/has no version for/.test(err.message)) {
      throw new Error(`${err.message}. ${FEATURES[key].label} is available for recent Minecraft versions only.`);
    }
    throw err;
  }
}

// Turning a feature off only disables its jars, so turning it back on is instant
// and keeps its settings.
async function setFeature(key, on, ctx) {
  const f = FEATURES[key];
  if (!f || !f.types.includes(ctx.type)) throw new Error(`${f?.label || key} isn't available for this server software`);
  if (on && !featureStatus(key, items(ctx.serverDir, ctx.type), ctx.type).installed) await installFeature(key, ctx);
  const list = items(ctx.serverDir, ctx.type);
  for (const re of f.match) {
    const m = findItem(list, re);
    if (m && m.enabled !== on) mods.toggleContent(ctx.serverDir, ctx.type, m.file);
  }
  return status(ctx.serverDir, ctx.type);
}

async function installLoginPlugin({ serverDir, type, mcVersion, onProgress }) {
  const login = LOGIN_PLUGINS[type];
  if (!login) throw new Error('No login plugin is available for this server software');
  await mods.install({ serverDir, type, mcVersion, projectId: login.slug, onProgress });
  return status(serverDir, type);
}

module.exports = { BEDROCK_PORT, status, setFeature, installLoginPlugin, bedrockPort };
