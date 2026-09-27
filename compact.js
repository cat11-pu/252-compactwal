// compact.js：按预算处理一批 append/checkpoint 事件，待回收段留在账上，收尾不限预算清账。
import { canAppend } from "./wal.js";

const STALE_CODE = "E_STALE_SEGMENT";
const BACKWARD_CODE = "E_BACKWARD_CHECKPOINT";
const BAD_CODE = "E_BAD_EVENT";

function cloneState(state) {
  const base = state || {};
  return {
    checkpoint: base.checkpoint || 0,
    segments: (base.segments || []).slice(),
    retired: (base.retired || []).slice(),
    reclaimed: (base.reclaimed || []).slice(),
    applied: (base.applied || []).slice(),
    origins: Object.assign({}, base.origins || {})
  };
}

function failure(spec, fallback, key) {
  const error = new Error(fallback);
  error.code = (spec && spec[key]) || fallback;
  return error;
}

function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}

// 校验并归类事件：未知 kind / 字段不合法 -> E_BAD_EVENT，语义错由调用方处理。
function inspectEvent(event) {
  if (!event || typeof event !== "object") {
    return { bad: true };
  }
  if (event.kind === "append") {
    if (!isInt(event.segment) || event.segment <= 0) return { bad: true };
    return { kind: "append", segment: event.segment, id: event.id };
  }
  if (event.kind === "checkpoint") {
    if (!isInt(event.upto) || event.upto < 0) return { bad: true };
    return { kind: "checkpoint", upto: event.upto, id: event.id };
  }
  return { bad: true };
}

// 在预算内把待回收段真正删掉，回收消耗整批共享预算。
function reclaimWithin(state, budget) {
  let reclaimedNow = 0;
  while (budget > 0 && state.retired.length > 0) {
    const segment = state.retired.shift();
    state.reclaimed.push(segment);
    delete state.origins[segment];
    reclaimedNow += 1;
    budget -= 1;
  }
  return { count: reclaimedNow, budget: budget };
}

export function step(spec) {
  spec = spec || {};
  const state = cloneState(spec.state);
  const events = Array.isArray(spec.events) ? spec.events : [];
  let budget = Number.isFinite(spec.budget) ? Math.max(0, Math.floor(spec.budget)) : 0;

  let reclaimedCount = 0;
  let judged = 0;

  events.forEach(function (event) {
    const parsed = inspectEvent(event);
    if (parsed.bad) {
      throw failure(spec, BAD_CODE, "event_error_code");
    }
    const eventId = parsed.id;
    // 重放：已处理事件直接跳过，不再产生任何工作与回收。
    if (eventId !== undefined && state.applied.indexOf(eventId) !== -1) {
      return;
    }
    judged += 1;

    if (parsed.kind === "append") {
      const segment = parsed.segment;
      if (!canAppend(state, segment) || state.segments.indexOf(segment) !== -1) {
        throw failure(spec, STALE_CODE, "stale_error_code");
      }
      state.segments.push(segment);
      state.origins[segment] = eventId;
    } else {
      const upto = parsed.upto;
      if (upto < state.checkpoint) {
        throw failure(spec, BACKWARD_CODE, "backward_error_code");
      }
      state.checkpoint = upto;
      const move = state.segments.filter(function (segment) { return segment <= upto; });
      state.segments = state.segments.filter(function (segment) { return segment > upto; });
      move.forEach(function (segment) {
        if (state.retired.indexOf(segment) === -1) state.retired.push(segment);
      });
    }

    // 每次事件后按预算回收，用尽则剩下的压在账上带出下一轮。
    const result = reclaimWithin(state, budget);
    reclaimedCount += result.count;
    budget = result.budget;

    if (eventId !== undefined) state.applied.push(eventId);
  });

  const pendingBefore = state.retired.length;
  const pendingIds = state.retired
    .map(function (segment) { return state.origins[segment]; })
    .filter(function (id) { return id !== undefined; });

  return {
    state: state,
    segments: state.segments,
    retired: state.retired,
    reclaimed: state.reclaimed,
    reclaimed_count: reclaimedCount,
    checkpoint: state.checkpoint,
    pending_before: pendingBefore,
    pending_ids: pendingIds,
    catchup: 0,
    judged: judged,
    judged_bound: events.length
  };
}

export function close(spec) {
  spec = spec || {};
  const state = cloneState(spec.state);
  let catchup = 0;
  while (state.retired.length > 0) {
    const segment = state.retired.shift();
    state.reclaimed.push(segment);
    delete state.origins[segment];
    catchup += 1;
  }
  return { state: state, catchup: catchup };
}
