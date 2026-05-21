'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const claimCmd = require('../commands/claim.cjs');
const doneCmd = require('../commands/done.cjs');
const reviewCmd = require('../commands/review.cjs');
const blockCmd = require('../commands/block.cjs');
const nextCmd = require('../commands/next.cjs');
const addRowCmd = require('../commands/add-row.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-int-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProj() {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.tasks', 'project.config.js'),
    `module.exports = {
      scopes: { web: { dir: 'web', autoCommit: false } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'web/package.json' },
      changelogFiles: { web: 'web/README.md' },
      sameDayShareVersion: true,
      inferModule: () => '全局',
      commitMessage: () => '',
      autoPush: false,
    };`,
  );
  await createBlankWorkbook(path.join(proj, '.tasks', 'tasks.xlsx'));
  return proj;
}

test('claim 后 heartbeat.phase = executing 含 currentTaskId 和 desc', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  await captureStdout(() => claimCmd(proj, ['auto']));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'executing');
  assert.ok(hb.currentTaskId, 'currentTaskId 应被填');
  assert.equal(hb.currentTaskDesc, 'foo');
});

test('done 后 heartbeat.phase = idle，lastFinishedId 填上', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await doneCmd(proj, [String(id)]);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.currentTaskId, null);
  assert.equal(hb.lastFinishedId, id);
});

test('review 后 heartbeat.phase = idle', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await reviewCmd(proj, [String(id), '需 review']);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.lastFinishedId, id);
});

test('block 后 heartbeat.phase = idle', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await blockCmd(proj, [String(id), '阻塞了']);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.lastFinishedId, id);
});

test('next 返回 null 时 heartbeat.phase = sleeping', async () => {
  const proj = await setupProj();
  await captureStdout(() => nextCmd(proj, []));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'sleeping');
  assert.equal(hb.currentTaskId, null);
});

test('next 返回任务时不动 heartbeat（保持原状）', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const out = await captureStdout(() => nextCmd(proj, []));
  assert.notEqual(out.trim(), 'null');
  const hb = readHeartbeat(proj);
  assert.equal(hb, null, 'next 拿到任务时不写 heartbeat（claim 才写）');
});
