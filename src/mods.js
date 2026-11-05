// Mods/plugins: manage the local folder and install from Modrinth (with dependencies).
const fs = require('fs');
const path = require('path');
const { fetchJson, downloadFile } = require('./net');
const { LOADERS } = require('./loaders');

const INDEX_FILE = '.mchost-index.json';
const API = 'https://api.modrinth.com/v2';

const MODRINTH_LOADERS = {
  fabric: ['fabric'],
  forge: ['forge'],
  neoforge: ['neoforge'],
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
};

// Server-side performance mods/plugins that are safe defaults for weak hardware.
const RECOMMENDED = {
  fabric: [
    { slug: 'lithium', why: 'Optimizes game logic (mob AI, physics, block ticking)' },
    { slug: 'ferrite-core', why: 'Cuts RAM usage by 30-50%' },
    { slug: 'krypton', why: 'Optimizes the network stack' },
    { slug: 'modernfix', why: 'Faster startup and lower memory use' },
    { slug: 'chunky', why: 'Pre-generates the world so exploring causes less lag' },
  ],
  forge: [
    { slug: 'ferrite-core', why: 'Cuts RAM usage by 30-50%' },
    { slug: 'modernfix', why: 'Faster startup and lower memory use' },
    { slug: 'chunky', why: 'Pre-generates the world so exploring causes less lag' },
  ],
  neoforge: [
    { slug: 'lithium', why: 'Optimizes game logic (mob AI, physics, block ticking)' },
    { slug: 'ferrite-core', why: 'Cuts RAM usage by 30-50%' },
    { slug: 'modernfix', why: 'Faster startup and lower memory use' },
    { slug: 'chunky', why: 'Pre-generates the world so exploring causes less lag' },
  ],
  // Paper and Purpur already include spark (/spark), and it isn't on Modrinth for them.
  paper: [
    { slug: 'chunky', why: 'Pre-generates the world so exploring causes less lag' },
  ],
  purpur: [
    { slug: 'chunky', why: 'Pre-generates the world so exploring causes less lag' },
  ],
};

// Popular picks for the Browse tab, beyond performance. Entries that don't support
// the server's loader and version are hidden.
const ESSENTIALS = {
  plugins: [
    { slug: 'luckperms', why: 'Ranks and permissions' },
    { slug: 'essentialsx', why: 'Homes, warps, /tpa, kits and more' },
    { slug: 'coreprotect', why: 'Look up and roll back griefing' },
    { slug: 'worldedit', why: 'Build and edit large areas fast' },
    { slug: 'worldguard', why: 'Protect spawn and other areas' },
    { slug: 'skinsrestorer', why: 'Shows skins for TLauncher and other non-premium players' },
    { slug: 'simple-voice-chat', why: 'Proximity voice chat (players install the mod too)' },
    { slug: 'tab-was-taken', why: 'Custom player list and name tags' },
    { slug: 'discordsrv', why: 'Links server chat with a Discord channel' },
  ],
  mods: [
    { slug: 'fabric-api', why: 'Needed by most Fabric mods' },
    { slug: 'c2me-fabric', why: 'Faster world generation using every CPU core' },
    { slug: 'luckperms', why: 'Ranks and permissions' },
    { slug: 'worldedit', why: 'Build and edit large areas fast' },
    { slug: 'skinsrestorer', why: 'Shows skins for TLauncher and other non-premium players' },
    { slug: 'simple-voice-chat', why: 'Proximity voice chat (players install the mod too)' },
    { slug: 'no-chat-reports', why: 'Turns off chat reporting on the server' },
    { slug: 'spark', why: 'Profiler to find what causes lag' },
  ],
};

function contentDir(serverDir, type) {
  const sub = LOADERS[type]?.contentDir;
  return sub ? path.join(serverDir, sub) : null;
}

function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeIndex(dir, index) {
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(index, null, 2));
}

function prettyName(file) {
  return file
    .replace(/\.jar(\.disabled)?$/i, '')
    .replace(/[-_+](mc)?\d+(\.\d+)+.*$/i, '')
    .replace(/[-_]/g, ' ')
    .trim() || file;
}

// For jars installed from somewhere other than Modrinth, so they still get a proper name.
function recordInstall(serverDir, type, file, meta) {
  const dir = contentDir(serverDir, type);
  const index = readIndex(dir);
  index[file] = meta;
  writeIndex(dir, index);
}

function listContent(serverDir, type) {
  const dir = contentDir(serverDir, type);
  if (!dir || !fs.existsSync(dir)) return [];
  const index = readIndex(dir);
  return fs.readdirSync(dir)
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((file) => {
      const stat = fs.statSync(path.join(dir, file));
      const meta = index[file.replace(/\.disabled$/, '')] || {};
      return {
        file,
        name: meta.title || prettyName(file),
        enabled: !file.endsWith('.disabled'),
        size: stat.size,
        modified: stat.mtimeMs,
        projectId: meta.projectId || null,
        iconUrl: meta.iconUrl || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countEnabled(serverDir, type) {
  return listContent(serverDir, type).filter((m) => m.enabled).length;
}

function assertName(file) {
  if (!file || file !== path.basename(file)) throw new Error('Invalid file name');
}

function toggleContent(serverDir, type, file) {
  assertName(file);
  const dir = contentDir(serverDir, type);
  const from = path.join(dir, file);
  const to = file.endsWith('.disabled') ? from.replace(/\.disabled$/, '') : from + '.disabled';
  fs.renameSync(from, to);
  return path.basename(to);
}

function deleteContent(serverDir, type, file) {
  assertName(file);
  const dir = contentDir(serverDir, type);
  fs.rmSync(path.join(dir, file), { force: true });
  const index = readIndex(dir);
  delete index[file.replace(/\.disabled$/, '')];
  writeIndex(dir, index);
}

function addFiles(serverDir, type, files) {
  const dir = contentDir(serverDir, type);
  if (!dir) throw new Error('Vanilla servers do not support mods or plugins');
  fs.mkdirSync(dir, { recursive: true });
  const added = [];
  for (const src of files) {
    if (!/\.jar$/i.test(src)) continue;
    fs.copyFileSync(src, path.join(dir, path.basename(src)));
    added.push(path.basename(src));
  }
  return added;
}

async function search({ query, type, mcVersion, offset = 0, limit = 20, index, extraFacets = [] }) {
  const loaders = MODRINTH_LOADERS[type];
  if (!loaders) return { hits: [], total: 0 };
  const isPlugin = LOADERS[type].kind === 'plugins';
  const facets = [
    loaders.map((l) => `categories:${l}`),
    [`project_type:${isPlugin ? 'plugin' : 'mod'}`],
    ...extraFacets,
  ];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (!isPlugin) facets.push(['server_side:required', 'server_side:optional']);

  const params = new URLSearchParams({
    query: query || '',
    facets: JSON.stringify(facets),
    index: index || (query ? 'relevance' : 'downloads'),
    offset: String(offset),
    limit: String(limit),
  });
  const data = await fetchJson(`${API}/search?${params}`);
  return {
    total: data.total_hits,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
      categories: h.display_categories || h.categories,
      serverSide: h.server_side,
    })),
  };
}

// Curated picks that support this loader and version, in curated order.
async function essentials(type, mcVersion) {
  const loaders = MODRINTH_LOADERS[type];
  if (!loaders) return { hits: [], total: 0 };
  const picks = ESSENTIALS[LOADERS[type].kind === 'plugins' ? 'plugins' : 'mods'];
  const ids = encodeURIComponent(JSON.stringify(picks.map((p) => p.slug)));
  const projects = await fetchJson(`${API}/projects?ids=${ids}`);
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const hits = picks
    .map((pick) => ({ pick, p: bySlug.get(pick.slug) }))
    .filter(({ p }) => p && p.loaders.some((l) => loaders.includes(l)) && (!mcVersion || p.game_versions.includes(mcVersion)))
    .map(({ pick, p }) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      why: pick.why,
      downloads: p.downloads,
      iconUrl: p.icon_url,
      serverSide: p.server_side,
    }));
  return { hits, total: hits.length };
}

// "recommended" = curated picks, "popular" = all-time downloads,
// "trending" = projects from the last 6 months that people are following.
async function discover({ list, type, mcVersion, offset = 0 }) {
  if (list === 'recommended') return essentials(type, mcVersion);
  if (list === 'trending') {
    const since = Math.floor(Date.now() / 1000) - 180 * 24 * 3600;
    return search({
      query: '', type, mcVersion, offset, index: 'follows',
      extraFacets: [[`created_timestamp>${since}`], ['downloads>500']],
    });
  }
  return search({ query: '', type, mcVersion, offset, index: 'downloads' });
}

async function bestVersion(projectId, type, mcVersion) {
  const params = new URLSearchParams({
    loaders: JSON.stringify(MODRINTH_LOADERS[type]),
    game_versions: JSON.stringify([mcVersion]),
  });
  const versions = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  return versions.find((v) => v.version_type === 'release') || versions[0] || null;
}

async function install({ serverDir, type, mcVersion, projectId, onProgress, _visited = new Set() }) {
  const dir = contentDir(serverDir, type);
  if (!dir) throw new Error('Vanilla servers do not support mods or plugins');
  if (_visited.has(projectId)) return [];
  _visited.add(projectId);
  fs.mkdirSync(dir, { recursive: true });

  const index = readIndex(dir);
  const existing = Object.entries(index).find(([, v]) => v.projectId === projectId || v.slug === projectId);
  if (existing && fs.existsSync(path.join(dir, existing[0]))) return [];

  const [project, version] = await Promise.all([
    fetchJson(`${API}/project/${encodeURIComponent(projectId)}`),
    bestVersion(projectId, type, mcVersion),
  ]);
  if (!version) throw new Error(`${project.title} has no version for ${LOADERS[type].label} ${mcVersion}`);

  const file = version.files.find((f) => f.primary) || version.files[0];
  assertName(file.filename);
  await downloadFile(file.url, path.join(dir, file.filename),
    (p) => onProgress?.({ ...p, label: `Downloading ${project.title}` }));

  index[file.filename] = { projectId: project.id, slug: project.slug, title: project.title, iconUrl: project.icon_url, version: version.version_number };
  writeIndex(dir, index);
  const installed = [project.title];

  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    try {
      installed.push(...await install({ serverDir, type, mcVersion, projectId: dep.project_id, onProgress, _visited }));
    } catch (e) {
      installed.push(`(dependency failed: ${e.message})`);
    }
  }
  return installed;
}

function recommended(type) {
  return RECOMMENDED[type] || [];
}

module.exports = {
  contentDir, listContent, countEnabled, toggleContent, deleteContent, addFiles, recordInstall,
  search, discover, install, recommended,
};
