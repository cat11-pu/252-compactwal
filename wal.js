// wal.js：段能不能追加 / 是否已回收（空状态也合法）
export function canAppend(state, segment) {
  const checkpoint = (state && typeof state.checkpoint === "number") ? state.checkpoint : 0;
  return segment > checkpoint;
}

export function isRetired(state, segment) {
  if (!state) return false;
  const reclaimed = state.reclaimed || [];
  const pending = state.retired || [];
  return reclaimed.indexOf(segment) !== -1 || pending.indexOf(segment) !== -1;
}
