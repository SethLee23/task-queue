'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rootToSlug } = require('./slug.cjs');

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

function add(root) {
  const data = readRaw();
  const existing = data.projects.find(p => p.root === root);
  if (existing) return existing;
  const slug = uniqueSlug(rootToSlug(root), data.projects);
  const entry = {
    slug,
    root,
    name: path.basename(root),
    registeredAt: new Date().toISOString(),
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
  return readRaw().projects;
}

module.exports = { add, remove, list, getRegistryPath };
