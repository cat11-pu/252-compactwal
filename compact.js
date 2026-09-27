// compact.js：按预算回收段并留账
import { canAppend } from "./wal.js";

function cloneState(state) {
  const source = state || {};
  return {
    checkpoint: source.checkpoint || 0,
    segments: (source.segments || []).slice(),
    retired: (source.retired || []).slice(),
    reclaimed: (source.reclaimed || []).slice(),
    applied: (source.applied || []).slice()
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function codes(spec) {
  return {
    stale: (spec && spec.stale_error_code) || "E_STALE_SEGMENT",
    backward: (spec && spec.backward_error_code) || "E_BACKWARD_CHECKPOINT",
    event: (spec && spec.event_error_code) || "E_BAD_EVENT"
  };
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function step(spec) {
  const state = cloneState(spec && spec.state);
  const events = (spec && spec.events) || [];
  const code = codes(spec);
  let budget = Math.max(0, Number(spec && spec.budget) || 0);
  let judged = 0;
  let reclaimedCount = 0;
  const origin = {};

  for (const event of events) {
    if (!event || typeof event !== "object" || event.id === undefined || typeof event.kind !== "string") {
      fail(code.event, "事件缺少 id 或 kind");
    }
    if (state.applied.indexOf(event.id) !== -1) {
      continue;
    }
    if (event.kind === "append") {
      if (!isNumber(event.segment)) {
        fail(code.event, "append 事件缺 segment");
      }
      if (!canAppend(state, event.segment)) {
        fail(code.stale, "段号不超过检查点");
      }
      if (state.segments.indexOf(event.segment) !== -1
          || state.retired.indexOf(event.segment) !== -1
          || state.reclaimed.indexOf(event.segment) !== -1) {
        fail(code.stale, "段号重复");
      }
      state.segments.push(event.segment);
      origin[event.segment] = event.id;
    } else if (event.kind === "checkpoint") {
      if (!isNumber(event.upto)) {
        fail(code.event, "checkpoint 事件缺 upto");
      }
      if (event.upto < state.checkpoint) {
        fail(code.backward, "检查点回退");
      }
      state.checkpoint = event.upto;
      const keep = [];
      for (const segment of state.segments) {
        if (segment <= event.upto) {
          state.retired.push(segment);
        } else {
          keep.push(segment);
        }
      }
      state.segments = keep;
    } else {
      fail(code.event, "未知的事件 kind");
    }
    state.applied.push(event.id);
    judged += 1;
    while (budget > 0 && state.retired.length > 0) {
      state.reclaimed.push(state.retired.shift());
      budget -= 1;
      reclaimedCount += 1;
    }
  }

  const pendingIds = state.retired
    .map(function (segment) { return origin[segment]; })
    .filter(function (id) { return id !== undefined; });

  return { state: state, segments: state.segments.slice(), retired: state.retired.slice(),
           reclaimed: state.reclaimed.slice(), reclaimed_count: reclaimedCount,
           checkpoint: state.checkpoint, pending_before: state.retired.length,
           pending_ids: pendingIds, catchup: 0, judged: judged, judged_bound: events.length };
}

export function close(spec) {
  const state = cloneState(spec && spec.state);
  let catchup = 0;
  while (state.retired.length > 0) {
    state.reclaimed.push(state.retired.shift());
    catchup += 1;
  }
  return { state: state, catchup: catchup };
}
