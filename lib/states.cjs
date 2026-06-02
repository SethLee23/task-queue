const STATES = Object.freeze({
  TODO: '待办',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  REVIEW: '已完成-待review',
  BLOCKED: '阻塞-等答疑',
  SKIPPED: '跳过',
});

const IN_PROGRESS_SHEET_STATES = [
  STATES.TODO,
  STATES.IN_PROGRESS,
  STATES.REVIEW,
  STATES.BLOCKED,
];

const ARCHIVED_SHEET_STATES = [STATES.DONE, STATES.SKIPPED];

const VALID_TRANSITIONS = new Map([
  [STATES.TODO,         new Set([STATES.IN_PROGRESS, STATES.SKIPPED])],
  [STATES.IN_PROGRESS,  new Set([STATES.DONE, STATES.REVIEW, STATES.BLOCKED, STATES.TODO])],
  [STATES.REVIEW,       new Set([STATES.DONE, STATES.SKIPPED, STATES.TODO])],
  [STATES.BLOCKED,      new Set([STATES.TODO, STATES.SKIPPED, STATES.DONE])],
  [STATES.DONE,         new Set()],
  [STATES.SKIPPED,      new Set()],
]);

function canTransition(from, to) {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed ? allowed.has(to) : false;
}

const PRIORITY_ORDER = ['高', '中', '低'];

function normalizePriority(p) {
  const idx = PRIORITY_ORDER.indexOf(p);
  return idx === -1 ? PRIORITY_ORDER.length + 1 : idx + 1;
}

module.exports = {
  STATES,
  IN_PROGRESS_SHEET_STATES,
  ARCHIVED_SHEET_STATES,
  canTransition,
  normalizePriority,
  PRIORITY_ORDER,
};
