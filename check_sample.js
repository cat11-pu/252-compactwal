import fs from "node:fs";
import { canAppend, isRetired } from "./wal.js";
import { step, close } from "./compact.js";

// 验收断言：上面每条值收进 emit，最后与期望值逐项比对，不符就非零退出。
const __lines = [];
function emit(label, value) { __lines.push([String(label).replace(/ =$/, ""), value]); }


const spec = JSON.parse(fs.readFileSync(process.argv[2] || "sample/wal.json", "utf8"));
const events = spec.events || [];
const half = Math.ceil(events.length / 2);
const first = step(spec);
const closed = close(Object.assign({}, spec, { state: first.state }));
const r1 = step(Object.assign({}, spec, { events: events.slice(0, half) }));
const r2 = step(Object.assign({}, spec, { state: r1.state, events: events.slice(half) }));
const closedTwo = close(Object.assign({}, spec, { state: r2.state }));
const replay = step(Object.assign({}, spec, { state: closed.state }));
const wide = step(Object.assign({}, spec, { budget: spec.budget + 2 }));
const full = step(Object.assign({}, spec, { budget: events.length + 2 }));
const fullClosed = close(Object.assign({}, spec, { state: full.state }));
const fingerprint = function (state) {
  return JSON.stringify({ segments: state.segments, retired: state.retired,
                          checkpoint: state.checkpoint, applied: state.applied.length });
};

emit("存活段序列 =", JSON.stringify(closed.state.segments));
emit("已回收序列 =", JSON.stringify(closed.state.reclaimed));
emit("首轮回收条数 =", first.reclaimed_count);
emit("二档回收条数 =", wide.reclaimed_count);
emit("收尾前待回收段数 =", first.pending_before);
emit("收尾补齐条数 =", closed.catchup);
emit("收尾后待回收段数 =", closed.state.retired.length);
emit("收尾检查点 =", closed.state.checkpoint);
emit("两个预算档回收不同 =", first.reclaimed_count !== wide.reclaimed_count);
emit("拆两轮中间态不同 =", fingerprint(r2.state) !== fingerprint(first.state));
emit("拆两轮收尾态一致 =", fingerprint(closedTwo.state) === fingerprint(closed.state));
emit("重放新增回收 =", replay.reclaimed_count);
emit("工作计数未超上界 =", first.judged <= first.judged_bound);
emit("与全量对照差异 =", fingerprint(closed.state) === fingerprint(fullClosed.state) ? 0 : 1);


// ---- 异常路径探针：真调用实现，看它报出什么码（不是从样例里抄）----
try {
  step(Object.assign({}, { state: { checkpoint: 2, segments: [], retired: [], reclaimed: [], applied: [] },
    events: [{ id: 1, kind: "append", segment: 2 }], budget: 1 }));
  emit("过时段写错的错误码", "没有报错");
} catch (error) {
  emit("过时段写错的错误码", error && error.code ? error.code : String(error.message));
}
try {
  step(Object.assign({}, { state: { checkpoint: 3, segments: [], retired: [], reclaimed: [], applied: [] },
    events: [{ id: 1, kind: "checkpoint", upto: 1 }], budget: 1 }));
  emit("回退检查点写错的错误码", "没有报错");
} catch (error) {
  emit("回退检查点写错的错误码", error && error.code ? error.code : String(error.message));
}
try {
  step(Object.assign({}, { state: { checkpoint: 0, segments: [], retired: [], reclaimed: [], applied: [] },
    events: [{ id: 1, kind: "peek" }], budget: 1 }));
  emit("事件写错的错误码", "没有报错");
} catch (error) {
  emit("事件写错的错误码", error && error.code ? error.code : String(error.message));
}


// ---- 期望值（参考模型算出，与题面给的验收数值一致）----
const EXPECTED = {
  "存活段序列": [
    4
  ],
  "已回收序列": [
    1,
    2,
    3
  ],
  "首轮回收条数": 1,
  "二档回收条数": 3,
  "收尾前待回收段数": 2,
  "收尾补齐条数": 2,
  "收尾后待回收段数": 0,
  "收尾检查点": 3,
  "两个预算档回收不同": true,
  "拆两轮中间态不同": true,
  "拆两轮收尾态一致": true,
  "重放新增回收": 0,
  "工作计数未超上界": true,
  "与全量对照差异": 0,
  "过时段写错的错误码": "E_STALE_SEGMENT",
  "回退检查点写错的错误码": "E_BACKWARD_CHECKPOINT",
  "事件写错的错误码": "E_BAD_EVENT"
};
// 有的值在收进来之前已经 stringify 过，比较前先试着解析回来，避免类型错配把正确实现判成不过。
function __same(got, want) {
  if (typeof got === "string") {
    try { const parsed = JSON.parse(got); if (JSON.stringify(parsed) === JSON.stringify(want)) return true; } catch (error) { /* 不是 JSON 就按原文比 */ }
  }
  return JSON.stringify(got) === JSON.stringify(want);
}
let __bad = 0;
for (const [label, want] of Object.entries(EXPECTED)) {
  const found = __lines.find((pair) => pair[0] === label);
  if (!found) { __bad += 1; console.log("缺失验收项 " + label); continue; }
  const got = found[1];
  if (__same(got, want)) { console.log("一致 " + label + " = " + JSON.stringify(got)); }
  else { __bad += 1; console.log("不一致 " + label + " 期望 " + JSON.stringify(want) + " 实际 " + JSON.stringify(got)); }
}
console.log("验收项 " + (Object.keys(EXPECTED).length - __bad) + "/" + Object.keys(EXPECTED).length + " 通过");

// ---- 七条机检断言：每条直接调用实现取真值，断言失败计入退出码 ----
function __probeCode(fn) {
  try { fn(); return null; } catch (error) { return error && error.code ? error.code : null; }
}
const __emptyState = function (checkpoint) {
  return { checkpoint: checkpoint, segments: [], retired: [], reclaimed: [], applied: [] };
};
const __probes = {
  stale: __probeCode(function () {
    step({ state: __emptyState(2), events: [{ id: 1, kind: "append", "segment": 2 }], budget: 1 });
  }),
  backward: __probeCode(function () {
    step({ state: __emptyState(3), events: [{ id: 1, kind: "checkpoint", upto: 1 }], budget: 1 });
  }),
  bad: __probeCode(function () {
    step({ state: __emptyState(0), events: [{ id: 1, kind: "peek" }], budget: 1 });
  })
};
const __assertions = [
  ["两档回收不同", first.reclaimed_count !== wide.reclaimed_count],
  ["收尾前待回收段大于零而收尾后归零", first.pending_before > 0 && closed.state.retired.length === 0],
  ["拆两轮中间态不同而收尾态一致",
    fingerprint(r2.state) !== fingerprint(first.state)
      && fingerprint(closedTwo.state) === fingerprint(closed.state)],
  ["重放不再回收", replay.reclaimed_count === 0],
  ["工作计数不超事件条数", first.judged <= events.length],
  ["与全量对照为零", fingerprint(closed.state) === fingerprint(fullClosed.state)],
  ["状态异常探针真调",
    __probes.stale === (spec.stale_error_code || "E_STALE_SEGMENT")
      && __probes.backward === (spec.backward_error_code || "E_BACKWARD_CHECKPOINT")
      && __probes.bad === (spec.event_error_code || "E_BAD_EVENT")]
];
let __assertBad = 0;
__assertions.forEach(function (pair, index) {
  if (pair[1]) { console.log("断言" + (index + 1) + " 通过 " + pair[0]); }
  else { __assertBad += 1; __bad += 1; console.log("断言" + (index + 1) + " 失败 " + pair[0]); }
});
console.log("机检断言 " + (__assertions.length - __assertBad) + "/" + __assertions.length + " 通过");

process.exit(__bad === 0 ? 0 : 1);
