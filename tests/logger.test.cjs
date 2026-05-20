const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Logger } = require('../lib/logger.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-log-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Logger 写入到 <project>/.tasks/logs/YYYY-MM-DD.log', () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const logger = new Logger(proj);
  logger.info('hello');
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(proj, '.tasks', 'logs', `${today}.log`);
  assert.ok(fs.existsSync(logFile));
  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /\[\d{2}:\d{2}:\d{2}\] hello/);
});

test('Logger 多行追加', () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const logger = new Logger(proj);
  logger.info('first');
  logger.error('boom');
  const today = new Date().toISOString().slice(0, 10);
  const content = fs.readFileSync(path.join(proj, '.tasks', 'logs', `${today}.log`), 'utf8');
  assert.match(content, /first/);
  assert.match(content, /\[error\].*boom/);
});
