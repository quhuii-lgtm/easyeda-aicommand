// test/auditParity.ts
import { readFileSync } from "node:fs";

// src/commands/schematicAuditEngine.ts
var AUDIT_EPS = 0.5;
function auditPtOnSeg(px, py, s, interior = false) {
  const cross = (px - s[0]) * (s[3] - s[1]) - (py - s[1]) * (s[2] - s[0]);
  if (Math.abs(cross) > AUDIT_EPS)
    return false;
  const dot = (px - s[0]) * (px - s[2]) + (py - s[1]) * (py - s[3]);
  return interior ? dot < -AUDIT_EPS : dot <= AUDIT_EPS;
}
function auditSegsTouch(s, t) {
  if (auditPtOnSeg(s[0], s[1], t) || auditPtOnSeg(s[2], s[3], t))
    return true;
  return auditPtOnSeg(t[0], t[1], s) || auditPtOnSeg(t[2], t[3], s);
}
function auditCollinearOverlap(s, t) {
  const axisOf = (seg) => Math.abs(seg[0] - seg[2]) < AUDIT_EPS ? "v" : Math.abs(seg[1] - seg[3]) < AUDIT_EPS ? "h" : "o";
  const a = axisOf(s);
  const b = axisOf(t);
  if (a === "o" || a !== b)
    return 0;
  if (a === "h") {
    if (Math.abs(s[1] - t[1]) > AUDIT_EPS)
      return 0;
    const lo2 = Math.max(Math.min(s[0], s[2]), Math.min(t[0], t[2]));
    const hi2 = Math.min(Math.max(s[0], s[2]), Math.max(t[0], t[2]));
    return Math.max(0, hi2 - lo2);
  }
  if (Math.abs(s[0] - t[0]) > AUDIT_EPS)
    return 0;
  const lo = Math.max(Math.min(s[1], s[3]), Math.min(t[1], t[3]));
  const hi = Math.min(Math.max(s[1], s[3]), Math.max(t[1], t[3]));
  return Math.max(0, hi - lo);
}
function runStructuralAudit(input) {
  const issues = [];
  const add = (rule, type, message, primitiveIds, net, coords) => {
    const it = { rule, type, message, primitiveIds: primitiveIds ?? [] };
    if (net != null)
      it.net = net;
    if (coords)
      it.coords = coords;
    issues.push(it);
  };
  const allSegs = [];
  let zeroCount = 0;
  input.wires.forEach((w, wi) => {
    const line = w.line ?? [];
    const pts = [];
    for (let i = 0; i + 1 < line.length; i += 2)
      pts.push([Number(line[i]), Number(line[i + 1])]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (Math.abs(x1 - x2) < AUDIT_EPS && Math.abs(y1 - y2) < AUDIT_EPS) {
        zeroCount++;
        continue;
      }
      allSegs.push({ wire: wi, seg: [x1, y1, x2, y2] });
    }
  });
  if (zeroCount)
    add("ZERO_LENGTH_SEG", "info", `${zeroCount} \u4E2A\u96F6\u957F\u5EA6\u91CD\u590D\u70B9\uFF08\u753B\u7EBF\u75D5\u8FF9\uFF0C\u65E0\u5BB3\uFF09`);
  const n = allSegs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r)
      r = parent[r];
    while (parent[x] !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  const interiorCross = [];
  for (let i = 0; i < n; i++) {
    const s = allSegs[i].seg;
    for (let j = i + 1; j < n; j++) {
      const t = allSegs[j].seg;
      if (auditSegsTouch(s, t)) {
        union(i, j);
        continue;
      }
      const sThroughT = auditPtOnSeg(s[0], s[1], t, true) || auditPtOnSeg(s[2], s[3], t, true);
      const tThroughS = auditPtOnSeg(t[0], t[1], s, true) || auditPtOnSeg(t[2], t[3], s, true);
      if (sThroughT && tThroughS)
        interiorCross.push([i, j]);
    }
  }
  const pinSegs = /* @__PURE__ */ new Map();
  const pinInfo = /* @__PURE__ */ new Map();
  for (const [dev, pins] of Object.entries(input.pinsByDev)) {
    for (const p of pins) {
      const key = `${dev}.${p.pinNumber ?? "?"}`;
      pinInfo.set(key, p);
      const hits = [];
      for (let i = 0; i < n; i++) {
        if (auditPtOnSeg(p.x, p.y, allSegs[i].seg))
          hits.push(i);
      }
      if (hits.length)
        pinSegs.set(key, hits);
    }
  }
  const pinAt = /* @__PURE__ */ new Map();
  for (const [key, hits] of pinSegs) {
    for (const i of hits) {
      if (!pinAt.has(i))
        pinAt.set(i, []);
      pinAt.get(i).push(key);
    }
  }
  const trees = /* @__PURE__ */ new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!trees.has(r))
      trees.set(r, []);
    trees.get(r).push(i);
  }
  const wireNet = (i) => (input.wires[allSegs[i].wire].net ?? "").trim();
  const wireId = (i) => input.wires[allSegs[i].wire].primitiveId;
  const allPinsFlat = Object.values(input.pinsByDev).flat();
  for (const members of trees.values()) {
    const netMap = /* @__PURE__ */ new Map();
    for (const i of members) {
      const net = wireNet(i) || "(\u65E0\u540D)";
      netMap.set(net, (netMap.get(net) ?? 0) + 1);
    }
    const treeNets = new Set([...netMap.keys()].filter((k) => k !== "(\u65E0\u540D)"));
    const treePins = /* @__PURE__ */ new Set();
    for (const i of members) {
      for (const key of pinAt.get(i) ?? [])
        treePins.add(key);
    }
    const treeLabels = [];
    for (const lb of input.labels) {
      let hit = false;
      if (lb.wireId)
        hit = members.some((i) => wireId(i) === lb.wireId);
      if (!hit && lb.x != null && lb.y != null)
        hit = members.some((i) => auditPtOnSeg(lb.x, lb.y, allSegs[i].seg));
      if (hit)
        treeLabels.push(lb);
    }
    if (netMap.size > 1) {
      const detail = [...netMap.entries()].map(([k, v]) => `${k}\xD7${v}`).join("; ");
      add(
        "MULTI_NET_TREE",
        "blocking",
        `\u4E00\u68F5\u5BFC\u7EBF\u6811\u5185\u51FA\u73B0\u591A\u4E2A\u7F51\u540D\uFF08${detail}\uFF09\uFF0C\u7591\u4F3C\u5F02\u7F51\u6865\u63A5/\u77ED\u8DEF`,
        members.map(wireId),
        [...netMap.keys()].filter((k) => k !== "(\u65E0\u540D)").join("/") || void 0
      );
    }
    for (const lb of treeLabels) {
      const lnet = (lb.net ?? "").trim();
      if (lnet && treeNets.size && !treeNets.has(lnet)) {
        add(
          "LABEL_NET_MISMATCH",
          "blocking",
          `\u6807\u7B7E\u300C${lnet}\u300D\u6302\u5728\u7F51\u540D\u4E3A ${[...treeNets].join("/")} \u7684\u6811\u4E0A`,
          [lb.primitiveId, ...members.slice(0, 3).map(wireId)],
          lnet,
          lb.x != null && lb.y != null ? { x: lb.x, y: lb.y } : void 0
        );
      }
    }
    if (!treeNets.size && !treePins.size && !treeLabels.length) {
      add(
        "ORPHAN_TREE",
        "candidate",
        "\u5B64\u7ACB\u7EBF\u6811\uFF1A\u65E0\u7F51\u540D\u3001\u65E0\u5F15\u811A\u3001\u65E0\u6807\u7B7E",
        members.map(wireId),
        void 0,
        { x: allSegs[members[0]].seg[0], y: allSegs[members[0]].seg[1] }
      );
    }
    const deg = /* @__PURE__ */ new Map();
    for (const i of members) {
      const s = allSegs[i].seg;
      for (const v of [`${s[0]},${s[1]}`, `${s[2]},${s[3]}`]) {
        deg.set(v, (deg.get(v) ?? 0) + 1);
      }
    }
    for (const [v, d] of deg) {
      if (d !== 1)
        continue;
      const [vx, vy] = v.split(",").map(Number);
      const onPin = allPinsFlat.some((p) => Math.abs(p.x - vx) < AUDIT_EPS && Math.abs(p.y - vy) < AUDIT_EPS);
      const nearLabel = input.labels.some((lb) => lb.x != null && lb.y != null && Math.abs(lb.x - vx) <= 15 && Math.abs(lb.y - vy) <= 15);
      if (!onPin && !nearLabel && treeNets.size)
        add("DANGLING_END", "info", `\u7EBF\u5934\u60AC\u7AEF (${vx},${vy}) \u65E0\u5F15\u811A\u65E0\u6807\u7B7E`, members.map(wireId), [...treeNets][0], { x: vx, y: vy });
    }
  }
  for (const lb of input.labels) {
    if (lb.attached === false) {
      const lnet = (lb.net ?? "").trim();
      add(
        "FLOATING_LABEL",
        "candidate",
        `\u6807\u7B7E\u300C${lnet}\u300D\u672A\u6302\u63A5\u4EFB\u4F55\u5BFC\u7EBF\uFF08attached=false\uFF09`,
        [lb.primitiveId],
        lnet || void 0,
        lb.x != null && lb.y != null ? { x: lb.x, y: lb.y } : void 0
      );
    }
  }
  for (const [key, hits] of pinSegs) {
    if (input.ncExempt.has(key))
      continue;
    const p = pinInfo.get(key);
    if (!p)
      continue;
    for (const i of hits) {
      if (auditPtOnSeg(p.x, p.y, allSegs[i].seg, true)) {
        const wnet = wireNet(i);
        add(
          "PIN_INTERIOR_LANDING",
          "candidate",
          `\u5F15\u811A ${key}(${p.pinName ?? ""}) \u843D\u5728 ${wnet || "\u65E0\u540D"} \u5BFC\u7EBF\u5185\u90E8\uFF08\u7A7F\u7EBF/\u538B\u7EBF\uFF09\uFF0C\u5B98\u65B9\u7F51\u540D\uFF1A${wnet || "\uFF08\u65E0\uFF09"}`,
          [wireId(i)],
          wnet || void 0,
          { x: p.x, y: p.y }
        );
        break;
      }
    }
  }
  let sameNetOverlap = 0;
  const seenOv = /* @__PURE__ */ new Set();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ov = auditCollinearOverlap(allSegs[i].seg, allSegs[j].seg);
      if (ov <= AUDIT_EPS)
        continue;
      const ni = wireNet(i), nj = wireNet(j);
      if (ni === nj) {
        sameNetOverlap++;
        continue;
      }
      const ids = [wireId(i), wireId(j)].sort();
      const key = ids.join("|");
      if (seenOv.has(key))
        continue;
      seenOv.add(key);
      add(
        "WIRE_COLLINEAR_OVERLAP",
        "blocking",
        `\u4E0D\u540C\u7F51\u540D\u5BFC\u7EBF\u5171\u7EBF\u91CD\u53E0 ${Math.round(ov)}mil\uFF1A${ni || "\u65E0\u540D"} \xD7 ${nj || "\u65E0\u540D"}`,
        ids,
        `${ni}|${nj}`
      );
    }
  }
  if (sameNetOverlap)
    add("WIRE_OVERLAP_SAME_NET", "info", `${sameNetOverlap} \u5904\u540C\u7F51\u540D\u5BFC\u7EBF\u5171\u7EBF\u91CD\u53E0\uFF08\u65E0\u5BB3\u4F46\u5EFA\u8BAE\u6E05\u7406\uFF09`);
  const seenCross = /* @__PURE__ */ new Set();
  for (const [i, j] of interiorCross) {
    const ni = wireNet(i), nj = wireNet(j);
    if (!ni || !nj || ni === nj)
      continue;
    const ids = [wireId(i), wireId(j)].sort();
    const key = ids.join("|");
    if (seenCross.has(key))
      continue;
    seenCross.add(key);
    add(
      "CROSSING_INTERIOR",
      "candidate",
      `\u5BFC\u7EBF\u5185\u90E8\u5341\u5B57\u4EA4\u53C9\u4E14\u5B98\u65B9\u7F51\u540D\u4E0D\u540C\uFF08${ni} \xD7 ${nj}\uFF09\uFF1A\u5B98\u65B9\u8BED\u4E49\u672A\u63A5\u901A\uFF0C\u5EFA\u8BAE\u76EE\u68C0\u786E\u8BA4\u65E0\u7ED3\u70B9`,
      ids,
      `${ni}|${nj}`
    );
  }
  const rectList = input.rects;
  for (let a = 0; a < rectList.length; a++) {
    for (let b = a + 1; b < rectList.length; b++) {
      const A = rectList[a].span, B = rectList[b].span;
      const ox = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1);
      const oy = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1);
      if (ox > 0 && oy > 0)
        add(
          "RECT_OVERLAP",
          "candidate",
          `\u529F\u80FD\u533A\u6846\u91CD\u53E0\uFF0C\u9762\u79EF ${Math.round(ox * oy)} mil\xB2`,
          [rectList[a].id, rectList[b].id]
        );
    }
  }
  if (rectList.length) {
    for (const c of input.comps) {
      const cx = c.x, cy = c.y;
      if (cx == null || cy == null)
        continue;
      const hit = rectList.some((r) => r.span.x1 - AUDIT_EPS <= cx && cx <= r.span.x2 + AUDIT_EPS && r.span.y1 - AUDIT_EPS <= cy && cy <= r.span.y2 + AUDIT_EPS);
      if (!hit)
        add(
          "COMP_OUTSIDE_REGION",
          "candidate",
          `\u5668\u4EF6 ${c.designator || c.primitiveId} \u539F\u70B9 (${cx},${cy}) \u4E0D\u5728\u4EFB\u4F55\u529F\u80FD\u533A\u6846\u5185`,
          [c.primitiveId],
          void 0,
          { x: cx, y: cy }
        );
    }
  }
  const seenDev = /* @__PURE__ */ new Map();
  for (const c of input.comps) {
    if (!c.designator)
      continue;
    if (seenDev.has(c.designator)) {
      add(
        "DUPLICATE_DESIGNATOR",
        "blocking",
        `\u4F4D\u53F7 ${c.designator} \u51FA\u73B0\u591A\u6B21\uFF08${seenDev.get(c.designator)} \u4E0E ${c.primitiveId}\uFF09`,
        [seenDev.get(c.designator), c.primitiveId]
      );
    } else {
      seenDev.set(c.designator, c.primitiveId);
    }
  }
  const boxes = [];
  for (const c of input.comps) {
    if (!c.designator || seenDev.get(c.designator) !== c.primitiveId)
      continue;
    const pins = input.pinsByDev[c.designator];
    if (!pins?.length)
      continue;
    const xs = pins.map((p) => p.x), ys = pins.map((p) => p.y);
    const m = input.deviceMargin;
    boxes.push({
      dev: c.designator,
      id: c.primitiveId,
      x1: Math.min(...xs) - m,
      y1: Math.min(...ys) - m,
      x2: Math.max(...xs) + m,
      y2: Math.max(...ys) + m
    });
  }
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      const ox = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1);
      const oy = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1);
      if (ox > 0 && oy > 0)
        add(
          "DEVICE_BBOX_OVERLAP",
          "candidate",
          `\u5668\u4EF6 ${A.dev} \xD7 ${B.dev} \u672C\u4F53\u5305\u56F4\u76D2\uFF08\u5F15\u811A\u4E91+${input.deviceMargin}mil \u8FD1\u4F3C\uFF09\u91CD\u53E0 ${Math.round(ox)}\xD7${Math.round(oy)}mil\uFF0C\u9700\u76EE\u68C0\u786E\u8BA4\u5B9E\u9645\u672C\u4F53\u662F\u5426\u76F8\u78B0`,
          [A.id, B.id]
        );
    }
  }
  const stats = {
    wires: input.wires.length,
    segments: n,
    trees: trees.size,
    labels: input.labels.length,
    comps: input.comps.length,
    pins: allPinsFlat.length,
    rects: rectList.length
  };
  return { issues, stats };
}

// test/auditParity.ts
function unwrap(o) {
  return o && typeof o === "object" && "data" in o ? o.data : o;
}
function load(path) {
  const b = JSON.parse(readFileSync(path, "utf-8"));
  const wires = (unwrap(b.wires) ?? []).map((w) => ({
    primitiveId: String(w.primitiveId ?? "?"),
    net: String(w.net ?? ""),
    line: (w.line ?? []).map(Number)
  }));
  const labels = (unwrap(b.labels) ?? []).map((l) => ({
    primitiveId: String(l.primitiveId ?? "?"),
    net: String(l.net ?? ""),
    x: l.x != null ? Number(l.x) : void 0,
    y: l.y != null ? Number(l.y) : void 0,
    attached: l.attached !== false,
    wireId: l.wireId != null ? String(l.wireId) : void 0
  }));
  const comps = (unwrap(b.comps) ?? []).map((c) => ({
    primitiveId: String(c.primitiveId ?? "?"),
    designator: c.designator != null ? String(c.designator) : void 0,
    x: c.x != null ? Number(c.x) : void 0,
    y: c.y != null ? Number(c.y) : void 0
  }));
  const pinsByDev = {};
  for (const [dev, pins] of Object.entries(b.pins ?? {})) {
    pinsByDev[dev] = pins.map((p) => ({
      pinNumber: p.pinNumber != null ? String(p.pinNumber) : void 0,
      pinName: p.pinName != null ? String(p.pinName) : void 0,
      x: Number(p.x),
      y: Number(p.y)
    }));
  }
  const rects = (unwrap(b.rects) ?? []).map((r) => {
    const sp = r.span ?? { x1: Number(r.x), y1: Number(r.y) - Number(r.height), x2: Number(r.x) + Number(r.width), y2: Number(r.y) };
    return { id: String(r.primitiveId ?? r.id ?? "?"), span: { x1: Number(sp.x1), y1: Number(sp.y1), x2: Number(sp.x2), y2: Number(sp.y2) } };
  });
  return { wires, labels, comps, pinsByDev, rects, ncExempt: /* @__PURE__ */ new Set(), deviceMargin: 10 };
}
for (const path of process.argv.slice(2)) {
  const input = load(path);
  const { issues, stats } = runStructuralAudit(input);
  const summary = {};
  for (const it of issues) {
    const key = `${it.rule}[${it.type}]`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  const blocking = issues.filter((i) => i.type === "blocking").length;
  console.log(JSON.stringify({ file: path, blockingCount: blocking, summary, stats }, null, 1));
}
