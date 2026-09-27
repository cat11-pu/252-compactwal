// wal.js：段能不能追加（空状态也合法）
export function canAppend(state, segment) {
  const checkpoint = (state && state.checkpoint) || 0;
  return segment > checkpoint;
}

export function isRetired(state, segment) {
  return ((state && state.retired) || []).indexOf(segment) !== -1;
}
