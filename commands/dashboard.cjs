'use strict';

const { startServer } = require('./dashboard-server.cjs');
const registerCmd = require('./dashboard-register.cjs');
const unregisterCmd = require('./dashboard-unregister.cjs');
const listCmd = require('./dashboard-list.cjs');

function parsePort(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') return parseInt(args[i + 1], 10);
  }
  return parseInt(process.env.TASK_QUEUE_PORT, 10) || 5732;
}

function parseHost(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') return args[i + 1];
  }
  return process.env.TASK_QUEUE_HOST || '127.0.0.1';
}

async function serve(args) {
  const port = parsePort(args);
  const host = parseHost(args);
  const inst = await startServer({ port, host });
  process.stdout.write(`dashboard ready at http://${host}:${inst.port}\n`);
  const shutdown = async () => {
    process.stdout.write('shutting down dashboard...\n');
    await inst.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = async function dashboard(sub, args) {
  if (sub === 'register') {
    // dashboard register <project-root>
    return registerCmd(args[0], args.slice(1));
  }
  if (sub === 'unregister') {
    // dashboard unregister <slug>  (unregisterCmd reads args[0] as slug)
    return unregisterCmd(undefined, args);
  }
  if (sub === 'list') {
    return listCmd(undefined, args);
  }
  if (!sub || sub === 'serve') {
    return serve(args);
  }
  if (sub.startsWith('--')) {
    // dashboard --port 5733  → flags come through the projectRoot slot
    return serve([sub, ...args]);
  }
  throw new Error(`dashboard 未知子命令: ${sub}（可选: serve/register/unregister/list）`);
};
