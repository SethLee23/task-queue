// tests/commands.init-write.test.cjs — init-write 命令单元测试
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const initWrite = require('../commands/init-write.cjs');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-init-write-'));
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

/**
 * 捕获 process.stdout.write 输出，返回拼接后的字符串。
 * 过滤掉 node:test TAP 协议头（"TAP version" 等非 JSON 内容），
 * 仅保留命令本身输出的 JSON 内容块。
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c, ...rest) => {
    const s = String(c);
    // 跳过 TAP 协议输出（以 "TAP version" 或 "#" 或数字开头的行）
    // 只收集以 '{' 或 '[' 开头（JSON）的块
    const trimmed = s.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || chunks.length > 0) {
      chunks.push(s);
    }
    // 仍然调用原始 write，保证 TAP 输出正常（但不计入 chunks）
    return orig(c, ...rest);
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = orig;
  }).then(() => chunks.join(''));
}

/** 标准测试用 answers，模拟 web monorepo scope */
const BASE_ANSWERS = {
  autoCommitScopes: ['web'],
  scopeMapping: {
    web: {
      dir: 'web',
      versionFile: 'web/package.json',
      changelogFile: 'web/README.md',
      buildCommand: 'cd web && npm run build',
    },
  },
  candidateModules: {
    web: ['路由管理', 'FaaS 管理', '插件管理'],
  },
  commitTemplate: {
    web: 'T#0000 web## {version}\n\n【{module}】{desc}；',
  },
  sameDayShareVersion: true,
};

test('正常 init-write：创建目录/文件/gitignore 条目正确', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'normal-'));

  const out = await capture(() =>
    initWrite(proj, [JSON.stringify(BASE_ANSWERS)])
  );

  const result = JSON.parse(out);

  // gitignoreAppended 应为 true（首次追加）
  assert.equal(result.gitignoreAppended, true, 'gitignoreAppended 应为 true');

  // .tasks/project.config.js 存在且为合法 JS（可 require 加载）
  const configPath = path.join(proj, '.tasks', 'project.config.js');
  assert.ok(fs.existsSync(configPath), 'project.config.js 应存在');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(configPath);

  // scopes 字段正确
  assert.deepEqual(config.scopes, {
    web: { dir: 'web', autoCommit: true },
  });

  // buildCommands 字段正确
  assert.deepEqual(config.buildCommands, {
    web: 'cd web && npm run build',
  });

  // versionFiles 字段正确
  assert.deepEqual(config.versionFiles, {
    web: 'web/package.json',
  });

  // changelogFiles 字段正确
  assert.deepEqual(config.changelogFiles, {
    web: 'web/README.md',
  });

  // sameDayShareVersion 字段正确
  assert.equal(config.sameDayShareVersion, true);

  // .tasks/tasks.xlsx 存在
  assert.ok(
    fs.existsSync(path.join(proj, '.tasks', 'tasks.xlsx')),
    'tasks.xlsx 应存在'
  );

  // .tasks/logs/ 目录存在
  const logsDir = path.join(proj, '.tasks', 'logs');
  assert.ok(fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory(), 'logs/ 目录应存在');

  // .gitignore 包含 4 条目
  const gitignoreContent = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8');
  const lines = gitignoreContent.split('\n').map(l => l.trim());
  assert.ok(lines.includes('.tasks/tasks.xlsx'), '.gitignore 应含 .tasks/tasks.xlsx');
  assert.ok(lines.includes('.tasks/tasks.xlsx.bak'), '.gitignore 应含 .tasks/tasks.xlsx.bak');
  assert.ok(lines.includes('.tasks/logs/'), '.gitignore 应含 .tasks/logs/');
  assert.ok(lines.includes('.tasks/*.bak'), '.gitignore 应含 .tasks/*.bak');
});

test('重复调用幂等：第二次 gitignoreAppended 为 false', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'idempotent-'));

  // 第一次调用
  await capture(() => initWrite(proj, [JSON.stringify(BASE_ANSWERS)]));

  // 记录第一次 .gitignore 内容
  const gitignoreAfterFirst = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8');

  // 第二次调用
  const out2 = await capture(() => initWrite(proj, [JSON.stringify(BASE_ANSWERS)]));
  const result2 = JSON.parse(out2);

  // 第二次不应再追加
  assert.equal(result2.gitignoreAppended, false, '第二次调用 gitignoreAppended 应为 false');

  // .gitignore 内容不应改变
  const gitignoreAfterSecond = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8');
  assert.equal(gitignoreAfterFirst, gitignoreAfterSecond, '.gitignore 内容不应重复追加');

  // 4 条目没有重复出现
  const lines = gitignoreAfterSecond.split('\n').map(l => l.trim()).filter(Boolean);
  const countTasksXlsx = lines.filter(l => l === '.tasks/tasks.xlsx').length;
  assert.equal(countTasksXlsx, 1, '.tasks/tasks.xlsx 不应重复');
});

test('inferModule 正确性：web/src/view/Router/ 命中 "路由管理"', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'infer-'));

  await capture(() => initWrite(proj, [JSON.stringify(BASE_ANSWERS)]));

  const configPath = path.join(proj, '.tasks', 'project.config.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(configPath);

  // 单文件命中 Router → '路由管理'
  const result1 = config.inferModule(['web/src/view/Router/foo.tsx'], 'web');
  assert.equal(result1, '路由管理', 'Router 目录应推断为 "路由管理"');

  // FaaS 目录（大写）命中 → 'FaaS 管理'
  const result2 = config.inferModule(['web/src/view/Faas/index.tsx'], 'web');
  assert.equal(result2, 'FaaS 管理', 'Faas 目录应推断为 "FaaS 管理"');

  // 无法命中时返回默认第一项 '路由管理'（BASE_ANSWERS.candidateModules.web[0]）
  const result3 = config.inferModule(['web/src/utils/helper.ts'], 'web');
  assert.equal(result3, '路由管理', '未命中时应返回默认模块');

  // 未知 scope 返回 null
  const result4 = config.inferModule(['core/app.ts'], 'core');
  assert.equal(result4, null, '未知 scope 应返回 null');
});

test('init-write 末尾自动注册到 registry，输出含 registered 字段', async () => {
  process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpBase, `reg-${Date.now()}.json`);
  // 清除 registry 模块缓存，确保读取新 env
  delete require.cache[require.resolve('../lib/registry.cjs')];

  const proj = fs.mkdtempSync(path.join(tmpBase, 'init-reg-'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  const out = await capture(() => initWrite(proj, [JSON.stringify(BASE_ANSWERS)]));
  const parsed = JSON.parse(out);

  assert.ok(parsed.registered, 'init-write 输出应含 registered 字段');
  assert.equal(parsed.registered.root, proj, 'registered.root 应等于 projectRoot');
  assert.ok(parsed.registered.slug, 'registered.slug 应存在');

  const { list } = require('../lib/registry.cjs');
  const roots = list().map(p => p.root);
  assert.ok(roots.includes(proj), 'registry 应包含该 project');

  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

test('inferModule 反向字典含 Settings 和 Global 双 key（均映射"全局设置"）', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'infer-dual-key-'));

  const answers = {
    ...BASE_ANSWERS,
    candidateModules: { web: ['全局设置', '路由管理'] },
    commitTemplate: { web: 'T#0000 web## {version}\n\n【{module}】{desc}；' },
  };

  await capture(() => initWrite(proj, [JSON.stringify(answers)]));

  const cfgPath = path.join(proj, '.tasks', 'project.config.js');
  // 清除 require 缓存，避免同路径被之前测试缓存影响
  delete require.cache[require.resolve(cfgPath)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(cfgPath);

  // Settings 目录命中
  assert.equal(
    cfg.inferModule(['web/src/view/Settings/foo.tsx'], 'web'),
    '全局设置',
    'Settings 目录应推断为 "全局设置"',
  );

  // Global 目录命中
  assert.equal(
    cfg.inferModule(['web/src/view/Global/bar.tsx'], 'web'),
    '全局设置',
    'Global 目录应推断为 "全局设置"',
  );

  // Router 目录命中
  assert.equal(
    cfg.inferModule(['web/src/view/Router/x.tsx'], 'web'),
    '路由管理',
    'Router 目录应推断为 "路由管理"',
  );
});
