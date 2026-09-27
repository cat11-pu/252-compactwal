// compact.js：按预算回收段并留账（基线：一律给空表）
import { canAppend, isRetired } from "./wal.js";

export function step(spec) {
  return { state: spec.state, segments: [], retired: [], reclaimed: [], reclaimed_count: 0,
           checkpoint: 0, pending_before: 0, pending_ids: [], catchup: 0, judged: 0, judged_bound: 0 };
}

export function close(spec) {
  return { state: spec.state, catchup: 0 };
}
