'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STALE_THRESHOLD_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 100;

class LockTimeoutError extends Error {
  constructor(lockDir, timeoutMs) {
    super(`Lock timeout after ${timeoutMs}ms on ${lockDir}`);
    this.name = 'LockTimeoutError';
    this.lockDir = lockDir;
  }
}

function tryClaim(lockDir) {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'info.json'),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function isStale(lockDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
    const age = Date.now() - new Date(info.ts).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch (_) {
    return true;
  }
}

function forceRelease(lockDir) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {}
}

async function acquireLock(lockDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (tryClaim(lockDir)) return;
    if (isStale(lockDir)) {
      forceRelease(lockDir);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(lockDir, timeoutMs);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

async function releaseLock(lockDir) {
  forceRelease(lockDir);
}

async function withLock(lockDir, fn, opts) {
  await acquireLock(lockDir, opts);
  try {
    return await fn();
  } finally {
    await releaseLock(lockDir);
  }
}

module.exports = { withLock, acquireLock, releaseLock, LockTimeoutError };
