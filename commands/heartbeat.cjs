'use strict';

const { writeHeartbeat } = require('../lib/heartbeat.cjs');

const VALID_PHASES = new Set(['executing', 'idle', 'sleeping']);

module.exports = async function heartbeat(projectRoot, args) {
  if (!projectRoot) throw new Error('heartbeat 需要 <project-root> 参数');
  let phase = 'idle';
  let model = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phase') {
      phase = args[i + 1];
      i++;
    } else if (args[i] === '--model') {
      model = args[i + 1];
      i++;
    }
  }
  if (!VALID_PHASES.has(phase)) {
    throw new Error(`非法 phase: ${phase}（需为 ${[...VALID_PHASES].join('/')} 之一）`);
  }
  const patch = { phase };
  if (model) patch.model = model;
  const ok = writeHeartbeat(projectRoot, patch);
  process.stdout.write(JSON.stringify({ ok, phase, model: model || undefined }) + '\n');
};
