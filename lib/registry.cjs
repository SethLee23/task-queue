'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rootToSlug } = require('./slug.cjs');

const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
const DEFAULT_MODEL = 'opus';

function getRegistryPath() {
  return process.env.TASK_QUEUE_REGISTRY_PATH
    || path.join(os.homedir(), '.task-queue', 'projects.json');
}

function readRaw() {
  const p = getRegistryPath();
  if (!fs.existsSync(p)) return { version: 1, projects: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { version: 1, projects: [] };
  }
}

function writeRaw(data) {
  const p = getRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function uniqueSlug(baseSlug, existing) {
  if (!existing.some(p => p.slug === baseSlug)) return baseSlug;
  for (let i = 2; i < 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (!existing.some(p => p.slug === candidate)) return candidate;
  }
  throw new Error(`slug 冲突过多: ${baseSlug}`);
}

/**
 * 给 entry 补默认字段（向后兼容旧 registry）。
 * @param {object} entry
 * @returns {object}
 */
function normalize(entry) {
  if (!entry) return entry;
  const desiredModel = VALID_MODELS.includes(entry.desiredModel) ? entry.desiredModel : DEFAULT_MODEL;
  const hidden = entry.hidden === true;
  return { ...entry, desiredModel, hidden };
}

function add(root) {
  const data = readRaw();
  const existing = data.projects.find(p => p.root === root);
  if (existing) return normalize(existing);
  const slug = uniqueSlug(rootToSlug(root), data.projects);
  const entry = {
    slug,
    root,
    name: path.basename(root),
    registeredAt: new Date().toISOString(),
    desiredModel: DEFAULT_MODEL,
    hidden: false,
  };
  data.projects.push(entry);
  writeRaw(data);
  return entry;
}

function remove(slug) {
  const data = readRaw();
  const before = data.projects.length;
  data.projects = data.projects.filter(p => p.slug !== slug);
  if (data.projects.length !== before) writeRaw(data);
}

function list() {
  return readRaw().projects.map(normalize);
}

/**
 * 按 slug 部分更新 entry，仅允许更新预定义字段（防止注入未知键）。
 * @param {string} slug
 * @param {{ desiredModel?: string, hidden?: boolean }} patch
 * @returns {object} 更新后的 entry
 */
function update(slug, patch) {
  const data = readRaw();
  const idx = data.projects.findIndex(p => p.slug === slug);
  if (idx === -1) throw new Error(`registry 中未找到 slug=${slug}`);
  const entry = data.projects[idx];
  if (patch.desiredModel !== undefined) {
    if (!VALID_MODELS.includes(patch.desiredModel)) {
      throw new Error(`不支持的 desiredModel: ${patch.desiredModel}（可选: ${VALID_MODELS.join('/')}）`);
    }
    entry.desiredModel = patch.desiredModel;
  }
  if (patch.hidden !== undefined) {
    if (typeof patch.hidden !== 'boolean') {
      throw new Error(`hidden 必须是 boolean: ${patch.hidden}`);
    }
    entry.hidden = patch.hidden;
  }
  data.projects[idx] = entry;
  writeRaw(data);
  return normalize(entry);
}

/**
 * 按项目根目录查 desiredModel，缺失或非法均回退默认值。
 * @param {string} root
 * @returns {string}
 */
function getDesiredModelByRoot(root) {
  const entry = readRaw().projects.find(p => p.root === root);
  return normalize(entry || {}).desiredModel || DEFAULT_MODEL;
}

module.exports = {
  add, remove, list, update,
  getRegistryPath, getDesiredModelByRoot,
  VALID_MODELS, DEFAULT_MODEL,
};
