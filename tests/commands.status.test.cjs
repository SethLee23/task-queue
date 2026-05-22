'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const statusCmd = require('../commands/status.cjs');
const { setPaused } = require('../lib/paused.cjs');
const { setWakeNow } = require('../lib/wake.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pause-test-'));
// 隔离 registry，避免污染用户真实 ~/.task-queue/projects.json
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

test('status 默认 paused=false', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, false);
  assert.equal(parsed.pauseReason, null);
});

test('status 在 paused flag 文件存在时报 paused=true 含 reason', async () => {
  const proj = await mkProj();
  setPaused(proj, '人工暂停');
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, true);
  assert.equal(parsed.pauseReason, '人工暂停');
});

test('status 默认 wakeNow=false', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.wakeNow, false);
  assert.equal(parsed.wakeNowReason, null);
});

test('status 在 wake-now flag 存在时报 wakeNow=true 含 reason', async () => {
  const proj = await mkProj();
  setWakeNow(proj, '面板立即执行');
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.wakeNow, true);
  assert.equal(parsed.wakeNowReason, '面板立即执行');
});

test('status 缺 project.config.js 时 idleSleepSeconds 兜底为 270', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.idleSleepSeconds, 270);
});

test('status 输出 desiredModel（未注册项目回退默认 opus）', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.desiredModel, 'opus');
});

test('status 注册过的项目读出真实 desiredModel', async () => {
  const { add, update } = require('../lib/registry.cjs');
  const proj = await mkProj();
  const e = add(proj);
  update(e.slug, { desiredModel: 'sonnet' });
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.desiredModel, 'sonnet');
});

test('status 读 idleSleepSeconds 配置 + clamp', async () => {
  const proj = await mkProj();
  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'),
    'module.exports = { idleSleepSeconds: 600 };');
  const out = await captureStdout(() => statusCmd(proj, []));
  assert.equal(JSON.parse(out).idleSleepSeconds, 600);

  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'),
    'module.exports = { idleSleepSeconds: 99999 };');
  const out2 = await captureStdout(() => statusCmd(proj, []));
  assert.equal(JSON.parse(out2).idleSleepSeconds, 3600);

  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'),
    'module.exports = { idleSleepSeconds: 10 };');
  const out3 = await captureStdout(() => statusCmd(proj, []));
  assert.equal(JSON.parse(out3).idleSleepSeconds, 60);
});
