import type { TuneContact, TuneLine, TunePoint } from './lengthTuneTargets';
import { branchPathContactIntervals, branchSegmentContactDistance, type BranchArcContact, type BranchContact } from './branchContactGeometry';

export interface PadBranchItemRequest {
	padId: string;
	waypoints?: TunePoint[];
}
export interface PadBranchSideRequest {
	joinPoint: TunePoint;
	branches: PadBranchItemRequest[];
	trunk?: { primitiveId: string; endpoint: 'start' | 'end' };
}
export interface PadBranchesRequest {
	pair: { positiveNet: string; negativeNet: string };
	layer: number;
	width: number;
	clearanceMil: number;
	positive: PadBranchSideRequest;
	negative: PadBranchSideRequest;
}
export interface PadBranchPlan {
	padId: string;
	net: string;
	path: TunePoint[];
	length: number;
}
export interface PadBranchWriteSegment {
	a: TunePoint;
	b: TunePoint;
	net: string;
	layer: number;
	width: number;
}
export interface PadBranchSidePlan {
	net: string;
	joinPoint: TunePoint;
	trunk?: { primitiveId: string; endpoint: 'start' | 'end' };
	branches: PadBranchPlan[];
	uniqueSegments: PadBranchWriteSegment[];
	additionalSameNetContacts: Array<{ objectId: string; branchPadId: string }>;
}
export interface PadBranchesPlan {
	layer: number;
	width: number;
	clearanceMil: number;
	positive: PadBranchSidePlan;
	negative: PadBranchSidePlan;
}

const EPS = 1e-9;
function fail(message: string): never {
	throw new Error(`PCB重复焊盘分支检查失败：${message}`);
}
const distance = (a: TunePoint, b: TunePoint): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: TunePoint, b: TunePoint): TunePoint => [a[0] - b[0], a[1] - b[1]];
const cross = (a: TunePoint, b: TunePoint): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: TunePoint, b: TunePoint): number => a[0] * b[0] + a[1] * b[1];

function point(value: unknown, name: string): TunePoint {
	if (!Array.isArray(value) || value.length !== 2 || !value.every(x => typeof x === 'number' && Number.isFinite(x)))
		fail(`${name}必须是有限的[x,y] mil坐标`);
	return [value[0], value[1]];
}
function pointSegmentDistance(p: TunePoint, a: TunePoint, b: TunePoint): number {
	const v = sub(b, a);
	const vv = dot(v, v);
	const t = vv ? Math.max(0, Math.min(1, dot(sub(p, a), v) / vv)) : 0;
	return distance(p, [a[0] + v[0] * t, a[1] + v[1] * t]);
}
function segmentsIntersect(a: TunePoint, b: TunePoint, c: TunePoint, d: TunePoint): boolean {
	const orient = (p: TunePoint, q: TunePoint, r: TunePoint) => cross(sub(q, p), sub(r, p));
	const on = (p: TunePoint, q: TunePoint, r: TunePoint) => Math.abs(orient(p, q, r)) <= EPS
		&& r[0] >= Math.min(p[0], q[0]) - EPS && r[0] <= Math.max(p[0], q[0]) + EPS
		&& r[1] >= Math.min(p[1], q[1]) - EPS && r[1] <= Math.max(p[1], q[1]) + EPS;
	const x1 = orient(a, b, c);
	const x2 = orient(a, b, d);
	const x3 = orient(c, d, a);
	const x4 = orient(c, d, b);
	return (x1 * x2 < 0 && x3 * x4 < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
function segmentDistance(a: TunePoint, b: TunePoint, c: TunePoint, d: TunePoint): number {
	return segmentsIntersect(a, b, c, d) ? 0 : Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function pathSegments(path: TunePoint[]): Array<[TunePoint, TunePoint]> {
	return path.slice(1).map((p, i) => [path[i], p]);
}
function pathSelfIntersects(path: TunePoint[], check?: () => void): boolean {
	const segments = pathSegments(path);
	for (let i = 1; i + 1 < path.length; i++) {
		check?.();
		if (collinearSameRay(sub(path[i - 1], path[i]), sub(path[i + 1], path[i])))
			return true;
	}
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 2; j < segments.length; j++) {
			check?.();
			if (segmentsIntersect(...segments[i], ...segments[j]))
				return true;
		}
	}
	return false;
}
function collinearSameRay(a: TunePoint, b: TunePoint): boolean {
	const na = Math.hypot(...a);
	const nb = Math.hypot(...b);
	return na > EPS && nb > EPS && Math.abs(cross(a, b)) <= EPS * na * nb && dot(a, b) > 0;
}

/** Find the maximum common geometric suffix, allowing different collinear segmentation. */
function commonSuffixStart(a: TunePoint[], b: TunePoint[], check?: () => void): TunePoint {
	let ia = a.length - 1;
	let ib = b.length - 1;
	const pa = a[ia];
	const pb = b[ib];
	if (distance(pa, pb) > EPS)
		fail('同侧分支未终止于同一个汇合点');
	let cursor: TunePoint = [...pa];
	while (ia > 0 && ib > 0) {
		check?.();
		const va = sub(a[ia - 1], cursor);
		const vb = sub(b[ib - 1], cursor);
		if (!collinearSameRay(va, vb))
			return cursor;
		const la = distance(cursor, a[ia - 1]);
		const lb = distance(cursor, b[ib - 1]);
		const take = Math.min(la, lb);
		cursor = [cursor[0] + va[0] / la * take, cursor[1] + va[1] / la * take];
		const enda = distance(cursor, a[ia - 1]) <= EPS;
		const endb = distance(cursor, b[ib - 1]) <= EPS;
		if (enda) {
			ia--;
			cursor = a[ia];
		}
		if (endb) {
			ib--;
			cursor = b[ib];
		}
	}
	return cursor;
}

function verifyTree(paths: TunePoint[][], ids: string[], check?: () => void): void {
	for (let i = 0; i < paths.length; i++) {
		check?.();
		if (pathSelfIntersects(paths[i], check))
			fail(`焊盘 ${ids[i]} 的支路自身交叉或回绕`);
		for (let j = i + 1; j < paths.length; j++) {
			check?.();
			const m = commonSuffixStart(paths[i], paths[j], check);
			const ai = paths[i].findIndex(p => distance(p, m) <= EPS);
			const bi = paths[j].findIndex(p => distance(p, m) <= EPS);
			// A merge can fall in the middle of a segment. Split only for this predicate.
			const prefix = (path: TunePoint[], at: number): TunePoint[] => {
				if (at >= 0)
					return path.slice(0, at + 1);
				const s = pathSegments(path).findIndex(([a, b]) => pointSegmentDistance(m, a, b) <= EPS);
				if (s < 0)
					fail('共同后缀起点无法对应到支路');
				return [...path.slice(0, s + 1), m];
			};
			const suffix = (path: TunePoint[], at: number): TunePoint[] => {
				if (at >= 0)
					return [m, ...path.slice(at + 1)];
				const s = pathSegments(path).findIndex(([a, b]) => pointSegmentDistance(m, a, b) <= EPS);
				if (s < 0)
					fail('共同后缀起点无法对应到支路');
				return [m, ...path.slice(s + 1)];
			};
			const ap = prefix(paths[i], ai);
			const bp = prefix(paths[j], bi);
			const as = suffix(paths[i], ai);
			const bs = suffix(paths[j], bi);
			const crossesOutsideM = (p: TunePoint[], q: TunePoint[]): boolean => {
				for (const [a, b] of pathSegments(p)) {
					for (const [c, d] of pathSegments(q)) {
						check?.();
						if (!segmentsIntersect(a, b, c, d))
							continue;
						const bothTouchM = [a, b].some(x => distance(x, m) <= EPS) && [c, d].some(x => distance(x, m) <= EPS);
						if (!bothTouchM)
							return true;
						const av = sub(b, a);
						const cv = sub(d, c);
						if (Math.abs(cross(av, cv)) <= EPS * Math.hypot(...av) * Math.hypot(...cv)) {
							const farA = [a, b].find(x => distance(x, m) > EPS);
							const farB = [c, d].find(x => distance(x, m) > EPS);
							if (farA && farB && collinearSameRay(sub(farA, m), sub(farB, m)))
								return true;
						}
					}
				}
				return false;
			};
			if (crossesOutsideM(ap, bp) || crossesOutsideM(ap, bs) || crossesOutsideM(as, bp))
				fail(`焊盘 ${ids[i]} 与 ${ids[j]} 的支路在共同后缀前另有交叉或重合`);
		}
	}
}

function segmentRectDistance(a: TunePoint, b: TunePoint, c: TunePoint, w: number, h: number, rotation: number): number {
	const angle = -rotation * Math.PI / 180;
	const transform = (p: TunePoint): TunePoint => {
		const x = p[0] - c[0];
		const y = p[1] - c[1];
		return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
	};
	const [p, q] = [transform(a), transform(b)];
	if ([p, q].some(x => Math.abs(x[0]) <= w / 2 && Math.abs(x[1]) <= h / 2))
		return 0;
	const corners: TunePoint[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
	let result = Infinity;
	for (let i = 0; i < 4; i++) result = Math.min(result, segmentDistance(p, q, corners[i], corners[(i + 1) % 4]));
	return result;
}
function segmentContactDistance(a: TunePoint, b: TunePoint, contact: BranchContact): number {
	if (contact.kind === 'capsule' || contact.kind === 'arc')
		return branchSegmentContactDistance(a, b, contact);
	if (contact.kind === 'circle')
		return Math.max(0, pointSegmentDistance(contact.center, a, b) - contact.radius);
	if (contact.kind === 'rect')
		return segmentRectDistance(a, b, contact.center, contact.width, contact.height, contact.rotation);
	return Infinity;
}
function boundsNearSegment(a: TunePoint, b: TunePoint, margin: number, bounds: { xMin: number; xMax: number; yMin: number; yMax: number }): boolean {
	return Math.max(a[0], b[0]) + margin >= bounds.xMin && Math.min(a[0], b[0]) - margin <= bounds.xMax
		&& Math.max(a[1], b[1]) + margin >= bounds.yMin && Math.min(a[1], b[1]) - margin <= bounds.yMax;
}
function normalizePath(start: TunePoint, waypoints: TunePoint[] | undefined, end: TunePoint, id: string, check?: () => void): TunePoint[] {
	if (waypoints !== undefined && !Array.isArray(waypoints))
		fail(`焊盘 ${id} 的 waypoints 必须是数组`);
	const result: TunePoint[] = [];
	const count = (waypoints?.length ?? 0) + 2;
	for (let i = 0; i < count; i++) {
		check?.();
		const p = i === 0 ? start : i === count - 1 ? end : waypoints![i - 1];
		const next = point(p, `焊盘 ${id} 路径点${i + 1}`);
		if (!result.length || distance(next, result.at(-1)!) > EPS)
			result.push(next);
	}
	for (let i = 1; i + 1 < result.length;) {
		check?.();
		if (collinearSameRay(sub(result[i], result[i - 1]), sub(result[i + 1], result[i])))
			result.splice(i, 1);
		else i++;
	}
	for (let i = 1; i < result.length; i++) {
		check?.();
		if (distance(result[i - 1], result[i]) < 1 - EPS)
			fail(`焊盘 ${id} 第 ${i} 段短于最短 1 mil`);
	}
	return result;
}
function lineValidate(line: TuneLine): void {
	if (!line || typeof line.id !== 'string' || !line.id || typeof line.net !== 'string' || !Number.isInteger(line.layer)
		|| typeof line.width !== 'number' || !Number.isFinite(line.width) || line.width <= 0) {
		fail(`现有LINE数据无效：${line?.id ?? 'unknown'}`);
	}
	point(line.a, `LINE ${line.id}.a`);
	point(line.b, `LINE ${line.id}.b`);
}
function validateTrunk(side: PadBranchSideRequest, net: string, layer: number, lines: TuneLine[], arcs: BranchArcContact[]): BranchArcContact | undefined {
	if (!side.trunk)
		return undefined;
	if (typeof side.trunk.primitiveId !== 'string' || !side.trunk.primitiveId || !['start', 'end'].includes(side.trunk.endpoint))
		fail('trunk必须指定实际LINE或ARC ID和start/end');
	const lineHits = lines.filter(line => line.id === side.trunk!.primitiveId);
	const arcHits = arcs.filter(arc => arc.id === side.trunk!.primitiveId);
	if (lineHits.length + arcHits.length !== 1)
		fail(`指定主干图元 ${side.trunk.primitiveId} 不存在、ID重复或跨类型冲突`);
	if (arcHits.length) {
		const arc = arcHits[0];
		if (arc.net !== net || arc.layers?.length !== 1 || arc.layers[0] !== layer)
			fail(`指定主干ARC ${arc.id} 的网络或图层不匹配`);
		const endpoint = side.trunk.endpoint === 'start' ? arc.curve.a : arc.curve.b;
		if (distance(endpoint, point(side.joinPoint, 'joinPoint')) > 0.001)
			fail(`指定主干ARC ${arc.id} 的 ${side.trunk.endpoint} 端点不在汇合点`);
		return arc;
	}
	const line = lineHits[0];
	if (line.net !== net || line.layer !== layer)
		fail(`指定主干LINE ${line.id} 的网络或图层不匹配`);
	const end = side.trunk.endpoint === 'start' ? line.a : line.b;
	if (distance(end, point(side.joinPoint, 'joinPoint')) > 0.001)
		fail(`指定主干LINE ${line.id} 的 ${side.trunk.endpoint} 端点不在汇合点`);
	return undefined;
}
function uniqueRouteSegments(branches: PadBranchPlan[], net: string, layer: number, width: number, check?: () => void): PadBranchWriteSegment[] {
	const groups: Array<{ origin: TunePoint; unit: TunePoint; intervals: Array<[number, number]> }> = [];
	for (const branch of branches) {
		for (const [a, b] of pathSegments(branch.path)) {
			check?.();
			const vector = sub(b, a);
			const length = Math.hypot(...vector);
			const unit: TunePoint = [vector[0] / length, vector[1] / length];
			let group = groups.find((candidate) => {
				const normalDistance = (p: TunePoint) => Math.abs(cross(sub(p, candidate.origin), candidate.unit));
				return normalDistance(a) <= EPS && normalDistance(b) <= EPS;
			});
			if (!group) {
				group = { origin: a, unit, intervals: [] };
				groups.push(group);
			}
			const project = (p: TunePoint) => dot(sub(p, group!.origin), group!.unit);
			group.intervals.push([Math.min(project(a), project(b)), Math.max(project(a), project(b))]);
		}
	}
	const result: PadBranchWriteSegment[] = [];
	for (const group of groups) {
		check?.();
		group.intervals.sort((a, b) => a[0] - b[0]);
		let [start, end] = group.intervals[0];
		const emit = () => {
			const a: TunePoint = [group.origin[0] + group.unit[0] * start, group.origin[1] + group.unit[1] * start];
			const b: TunePoint = [group.origin[0] + group.unit[0] * end, group.origin[1] + group.unit[1] * end];
			if (distance(a, b) >= 1 - EPS)
				result.push({ a, b, net, layer, width });
			else fail(`合并后的写入线段长度小于1 mil：${distance(a, b)}`);
		};
		for (let i = 1; i < group.intervals.length; i++) {
			check?.();
			const next = group.intervals[i];
			if (next[0] <= end + EPS) {
				end = Math.max(end, next[1]);
			}
			else {
				emit();
				[start, end] = next;
			}
		}
		emit();
	}
	return result;
}

type RouteInterval = [number, number];
function mergeIntervals(intervals: RouteInterval[], check?: () => void): RouteInterval[] {
	intervals.sort((a, b) => a[0] - b[0]);
	const merged: RouteInterval[] = [];
	for (const interval of intervals) {
		check?.();
		const last = merged.at(-1);
		if (last && interval[0] <= last[1] + EPS)
			last[1] = Math.max(last[1], interval[1]);
		else merged.push([...interval]);
	}
	return merged;
}

function contactIntervalOnSegment(a: TunePoint, b: TunePoint, limit: number, distanceAt: (t: number) => number, check?: () => void): [number, number] | undefined {
	let left = 0;
	let right = 1;
	for (let i = 0; i < 48; i++) {
		check?.();
		const third = (right - left) / 3;
		const x = left + third;
		const y = right - third;
		if (distanceAt(x) <= distanceAt(y))
			right = y;
		else
			left = x;
	}
	const mid = (left + right) / 2;
	if (distanceAt(mid) > limit + EPS)
		return undefined;
	const boundary = (lo: number, hi: number, insideAtHi: boolean) => {
		for (let i = 0; i < 48; i++) {
			check?.();
			const m = (lo + hi) / 2;
			const inside = distanceAt(m) <= limit + EPS;
			if (inside === insideAtHi)
				hi = m;
			else
				lo = m;
		}
		return (lo + hi) / 2;
	};
	const start = distanceAt(0) <= limit + EPS ? 0 : boundary(0, mid, true);
	const end = distanceAt(1) <= limit + EPS ? 1 : boundary(mid, 1, false);
	const length = distance(a, b);
	return [start * length, end * length];
}

function routeContactIntervals(path: TunePoint[], contact: BranchContact, margin: number, check?: () => void): RouteInterval[] {
	if (contact.kind === 'capsule' || contact.kind === 'arc')
		return branchPathContactIntervals(path, contact, margin, check);
	const intervals: RouteInterval[] = [];
	let offset = 0;
	for (const [a, b] of pathSegments(path)) {
		check?.();
		const interval = contactIntervalOnSegment(a, b, margin, (t) => {
			const p: TunePoint = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
			if (contact.kind === 'circle')
				return Math.max(0, distance(p, contact.center) - contact.radius);
			if (contact.kind === 'rect')
				return segmentRectDistance(p, p, contact.center, contact.width, contact.height, contact.rotation);
			return Infinity;
		}, check);
		const length = distance(a, b);
		if (interval)
			intervals.push([offset + interval[0], offset + interval[1]]);
		offset += length;
	}
	return mergeIntervals(intervals, check);
}

function requireContinuousTouch(intervals: RouteInterval[], id: string, label: string): void {
	if (intervals.length > 1 || (intervals.length === 1 && intervals[0][0] > EPS))
		fail(`${label} ${id} 沿支路分开后再次接触`);
}

function validateBranchCopperTopology(branches: PadBranchPlan[], width: number, check?: () => void): void {
	for (let i = 0; i < branches.length; i++) {
		for (let j = i + 1; j < branches.length; j++) {
			check?.();
			const a = branches[i].path;
			const b = branches[j].path;
			const merge = commonSuffixStart(a, b, check);
			const aSegments = pathSegments(a);
			const bSegments = pathSegments(b);
			const aMerge = aSegments.findIndex(([p, q]) => pointSegmentDistance(merge, p, q) <= EPS);
			const bMerge = bSegments.findIndex(([p, q]) => pointSegmentDistance(merge, p, q) <= EPS);
			if (aMerge < 0 || bMerge < 0)
				fail('共同后缀起点无法对应到支路铜段');
			const aTouches: RouteInterval[] = [];
			const bTouches: RouteInterval[] = [];
			let aOffset = 0;
			for (let ai = 0; ai < aSegments.length; ai++) {
				const aLength = distance(...aSegments[ai]);
				let bOffset = 0;
				for (let bi = 0; bi < bSegments.length; bi++) {
					check?.();
					const [aa, ab] = aSegments[ai];
					const [ba, bb] = bSegments[bi];
					const aInterval = contactIntervalOnSegment(aa, ab, width, t => pointSegmentDistance([aa[0] + (ab[0] - aa[0]) * t, aa[1] + (ab[1] - aa[1]) * t], ba, bb), check);
					if (aInterval)
						aTouches.push([aOffset + aInterval[0], aOffset + aInterval[1]]);
					const bInterval = contactIntervalOnSegment(ba, bb, width, t => pointSegmentDistance([ba[0] + (bb[0] - ba[0]) * t, ba[1] + (bb[1] - ba[1]) * t], aa, ab), check);
					if (bInterval)
						bTouches.push([bOffset + bInterval[0], bOffset + bInterval[1]]);
					bOffset += distance(...bSegments[bi]);
				}
				aOffset += aLength;
			}
			const aTotal = aSegments.reduce((sum, segment) => sum + distance(...segment), 0);
			const bTotal = bSegments.reduce((sum, segment) => sum + distance(...segment), 0);
			const along = (segment: [TunePoint, TunePoint]) => {
				const vector = sub(segment[1], segment[0]);
				const length = Math.hypot(...vector);
				return Math.max(0, Math.min(length, dot(sub(merge, segment[0]), vector) / length));
			};
			const aMergeDistance = aSegments.slice(0, aMerge).reduce((sum, segment) => sum + distance(...segment), 0) + along(aSegments[aMerge]);
			const bMergeDistance = bSegments.slice(0, bMerge).reduce((sum, segment) => sum + distance(...segment), 0) + along(bSegments[bMerge]);
			const aMerged = mergeIntervals(aTouches, check);
			const bMerged = mergeIntervals(bTouches, check);
			if (!aMerged.some(([start, end]) => start <= aMergeDistance + EPS && end >= aTotal - EPS))
				fail(`焊盘 ${branches[i].padId} 的铜接触未连续连接到共同后缀`);
			if (!bMerged.some(([start, end]) => start <= bMergeDistance + EPS && end >= bTotal - EPS))
				fail(`焊盘 ${branches[j].padId} 的铜接触未连续连接到共同后缀`);
			if (aMerged.length > 1 || bMerged.length > 1)
				fail(`焊盘 ${branches[i].padId} 与 ${branches[j].padId} 的铜接触沿支路分开后再次合流`);
		}
	}
}

/** Plan explicit PAD-to-join branches and check local copper spacing/topology. */
export function planPadBranches(request: PadBranchesRequest, pads: BranchContact[], existingLines: TuneLine[], contacts: BranchContact[], check?: () => void, existingArcs: BranchArcContact[] = []): PadBranchesPlan {
	if (!request || typeof request !== 'object')
		fail('request无效');
	const { pair, layer, width, clearanceMil } = request;
	if (!pair || typeof pair.positiveNet !== 'string' || !pair.positiveNet.trim() || typeof pair.negativeNet !== 'string' || !pair.negativeNet.trim() || pair.positiveNet === pair.negativeNet)
		fail('pair必须包含两个不同的非空实际网络名');
	if (!Number.isInteger(layer) || !(layer === 1 || layer === 2 || (layer >= 15 && layer <= 44)))
		fail('layer必须为有效铜层ID');
	if (!(typeof width === 'number' && Number.isFinite(width) && width > 0))
		fail('width必须是有限正数');
	if (!(typeof clearanceMil === 'number' && Number.isFinite(clearanceMil) && clearanceMil >= 0))
		fail('clearanceMil必须是有限非负数');
	if (!Array.isArray(pads) || !Array.isArray(existingLines) || !Array.isArray(contacts) || !Array.isArray(existingArcs))
		fail('pads、existingLines、contacts、existingArcs必须为数组');
	existingLines.forEach(lineValidate);
	const arcIds = new Set<string>();
	for (const arc of existingArcs) {
		if (!arc || arc.kind !== 'arc' || !arc.curve || !Array.isArray(arc.curve.a) || !Array.isArray(arc.curve.b) || !Array.isArray(arc.curve.center)
			|| typeof arc.id !== 'string' || !arc.id || arcIds.has(arc.id)
			|| typeof arc.net !== 'string' || !Number.isFinite(arc.width) || arc.width <= 0 || !Number.isInteger(arc.layers?.[0]) || arc.layers?.length !== 1
			|| arc.curve.type !== 'arc' || !Number.isFinite(arc.curve.radius) || arc.curve.radius <= 0 || !Number.isFinite(arc.curve.sweepDegrees)
			|| Math.abs(arc.curve.sweepDegrees) <= 0 || Math.abs(arc.curve.sweepDegrees) >= 360
			|| ![...arc.curve.a, ...arc.curve.b, ...arc.curve.center, arc.curve.radius, arc.curve.sweepDegrees].every(Number.isFinite))
			fail(`现有ARC数据无效或ID重复：${arc?.id ?? 'unknown'}`);
		arcIds.add(arc.id);
		if (existingLines.some(line => line.id === arc.id))
			fail(`ARC ${arc.id} 与LINE存在跨类型ID冲突`);
	}
	const padById = new Map<string, BranchContact>();
	for (const pad of pads) {
		if (!pad || typeof pad.id !== 'string' || !pad.id || padById.has(pad.id))
			fail(`PAD ID缺失或重复：${pad?.id ?? 'unknown'}`);
		if (pad.kind === 'capsule' && (!Array.isArray(pad.center) || !pad.center.every(Number.isFinite)
			|| !Number.isFinite(pad.width) || pad.width <= 0 || !Number.isFinite(pad.height) || pad.height <= 0 || !Number.isFinite(pad.rotation)))
			fail(`目标PAD ${pad.id} OVAL capsule几何无效`);
		if (arcIds.has(pad.id))
			fail(`PAD ${pad.id} 与ARC存在跨类型ID冲突`);
		padById.set(pad.id, pad);
	}
	for (const contact of contacts) {
		if (!contact || typeof contact.id !== 'string' || !contact.id || typeof contact.net !== 'string')
			fail('导电对象字段无效');
		if (contact.kind === 'capsule' && (!Array.isArray(contact.center) || !contact.center.every(Number.isFinite)
			|| !Number.isFinite(contact.width) || contact.width <= 0 || !Number.isFinite(contact.height) || contact.height <= 0 || !Number.isFinite(contact.rotation)))
			fail(`导电对象 ${contact.id} OVAL capsule几何无效`);
		if (contact.kind === 'arc' && !existingArcs.some(arc => arc.id === contact.id && arc.net === contact.net && arc.width === contact.width
			&& arc.curve.sweepDegrees === contact.curve.sweepDegrees && arc.curve.radius === contact.curve.radius
			&& distance(arc.curve.a, contact.curve.a) <= EPS && distance(arc.curve.b, contact.curve.b) <= EPS
			&& distance(arc.curve.center, contact.curve.center) <= EPS))
			fail(`导电ARC ${contact.id} 缺少匹配的唯一已验证来源`);
	}
	const plannedSides: PadBranchSidePlan[] = [];
	for (const [sideKey, net] of [['positive', pair.positiveNet], ['negative', pair.negativeNet]] as const) {
		check?.();
		const side = request[sideKey];
		if (!side || !Array.isArray(side.branches) || side.branches.length === 0)
			fail(`${sideKey}.branches必须是非空数组`);
		const joinPoint = point(side.joinPoint, `${sideKey}.joinPoint`);
		const trunkArc = validateTrunk(side, net, layer, existingLines, existingArcs);
		const seen = new Set<string>();
		const branches: PadBranchPlan[] = side.branches.map((branch, index) => {
			check?.();
			if (!branch || typeof branch.padId !== 'string' || !branch.padId || seen.has(branch.padId))
				fail(`${sideKey}.branches包含无效或重复焊盘ID`);
			seen.add(branch.padId);
			const pad = padById.get(branch.padId);
			if (!pad)
				fail(`找不到目标PAD ${branch.padId}`);
			if (pad.kind === 'arc' || arcIds.has(branch.padId))
				fail(`目标ID ${branch.padId} 解析为ARC，ARC不能作为目标PAD`);
			if (pad.kind === 'unknown')
				fail(`目标焊盘 ${pad.id} 外形无法确认：${pad.reason ?? 'unknown geometry'}`);
			if (pad.net !== net)
				fail(`目标PAD ${pad.id} 网络为 ${pad.net}，与请求 ${net} 不符`);
			if (pad.layers === null || !pad.layers.includes(layer))
				fail(`目标PAD ${pad.id} 无法确认位于目标铜层 ${layer}`);
			const start = pad.center;
			const path = normalizePath(start, branch.waypoints, joinPoint, `${sideKey}第${index + 1}支路 ${pad.id}`, check);
			if (path.length < 2)
				fail(`目标PAD ${pad.id} 已在汇合点，无需创建支路线`);
			// verifyTree performs the single self-intersection pass below.
			if (pad.kind === 'circle' && pad.holeRadius) {
				const reachesRing = path.slice(1).some(p => distance(pad.center, p) >= pad.holeRadius! - width / 2 - EPS);
				if (!reachesRing)
					fail(`通孔焊盘 ${pad.id} 的连续支路未穿过焊环`);
			}
			return { padId: pad.id, net, path, length: path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0) };
		});
		if (trunkArc) {
			for (const branch of branches) {
				const intervals = routeContactIntervals(branch.path, trunkArc, width / 2, check);
				if (intervals.length !== 1 || intervals[0][1] < branch.length - 0.001)
					fail(`主干ARC ${trunkArc.id} 未沿焊盘 ${branch.padId} 的单一连续末端后缀接触`);
			}
		}
		for (const branch of branches) {
			for (const contact of contacts) {
				if (contact.kind !== 'arc' || contact.id === side.trunk?.primitiveId || contact.net !== branch.net || (contact.layers && !contact.layers.includes(layer)))
					continue;
			const intervals = routeContactIntervals(branch.path, contact, width / 2, check);
			if (intervals.length > 1)
				fail(`支路 ${branch.padId} 与同网ARC ${contact.id} 分离接触多次`);
			}
		}
		verifyTree(branches.map(x => x.path), branches.map(x => x.padId), check);
		validateBranchCopperTopology(branches, width, check);
		const segments = uniqueRouteSegments(branches, net, layer, width, check);
		plannedSides.push({ net, joinPoint, ...(side.trunk ? { trunk: side.trunk } : {}), branches, uniqueSegments: segments, additionalSameNetContacts: [] });
	}
	const sideNets = [plannedSides[0].net, plannedSides[1].net];
	const allBranches = plannedSides.flatMap(side => side.branches.map(branch => ({ side, branch })));
	for (const positive of plannedSides[0].branches) {
		for (const negative of plannedSides[1].branches) {
			for (const [a, b] of pathSegments(positive.path)) {
				for (const [c, d] of pathSegments(negative.path)) {
					check?.();
					const centerDistance = segmentDistance(a, b, c, d);
					if ((clearanceMil === 0 && centerDistance <= width + EPS)
						|| centerDistance < width + clearanceMil - EPS) {
						fail(`正侧支路 ${positive.padId} 与负侧支路 ${negative.padId} 铜边间距不足 ${clearanceMil} mil`);
					}
				}
			}
		}
	}
	for (let i = 0; i < allBranches.length; i++) {
		const { side, branch } = allBranches[i];
		const ownPad = padById.get(branch.padId)!;
		const ownTouches = routeContactIntervals(branch.path, ownPad, width / 2, check);
		requireContinuousTouch(ownTouches, branch.padId, '目标PAD');
		for (const [a, b] of pathSegments(branch.path)) {
			check?.();
			for (const line of existingLines) {
				if (line.layer !== layer)
					continue;
				if (line.net === branch.net && sideNets.includes(line.net)) {
					if (side.trunk?.primitiveId === line.id
						&& (distance(a, side.joinPoint) <= EPS || distance(b, side.joinPoint) <= EPS)) {
						continue;
					}
					if (segmentDistance(a, b, line.a, line.b) <= (width + line.width) / 2 + EPS)
						side.additionalSameNetContacts.push({ objectId: line.id, branchPadId: branch.padId });
					continue;
				}
				const copperDistance = segmentDistance(a, b, line.a, line.b);
				const requiredDistance = (width + line.width) / 2;
				if ((clearanceMil === 0 && copperDistance <= requiredDistance + EPS)
					|| copperDistance < requiredDistance + clearanceMil - EPS) {
					fail(`支路 ${branch.padId} 与异网LINE ${line.id} 铜边间距不足 ${clearanceMil} mil`);
				}
			}
			for (const contact of contacts) {
				if (!contact || typeof contact.id !== 'string' || typeof contact.net !== 'string')
					fail('导电对象字段无效');
				if (contact.layers !== null && !contact.layers.includes(layer))
					continue;
				const margin = width / 2 + clearanceMil;
				if (contact.kind === 'unknown') {
					if (contact.bounds && !boundsNearSegment(a, b, margin, contact.bounds))
						continue;
					fail(`支路 ${branch.padId} 附近导电对象 ${contact.id} 图形或层无法确认：${contact.reason ?? 'unknown'}`);
				}
				const edgeDistance = segmentContactDistance(a, b, contact) - width / 2;
				if (contact.id === branch.padId)
					continue;
				if (contact.net === branch.net) {
					if (edgeDistance <= EPS) {
						const peer = allBranches.find(candidate => candidate.branch.padId === contact.id);
						if (peer) {
							if (peer.side !== side)
								fail(`支路 ${branch.padId} 接触到异网目标PAD ${contact.id}`);
							const merge = commonSuffixStart(branch.path, peer.branch.path, check);
							const suffixIndex = pathSegments(branch.path).findIndex(([p, q]) => pointSegmentDistance(merge, p, q) <= EPS);
							if (suffixIndex < 0)
								fail(`目标PAD ${contact.id} 的共同后缀起点无法对应到支路`);
							const suffix = [merge, ...branch.path.slice(suffixIndex + 1)];
						if (!('center' in contact))
							fail(`图元 ${contact.id} 与目标PAD身份冲突，无法作为焊盘接触`);
							if (!pathSegments(suffix).some(([p, q]) => {
								check?.();
								return pointSegmentDistance(contact.center, p, q) <= EPS;
							})) {
								fail(`目标PAD ${contact.id} 不在支路 ${branch.padId} 的共同后缀上`);
							}
							const intervals = routeContactIntervals(branch.path, contact, width / 2, check);
							if (intervals.length !== 1)
								fail(`支路 ${branch.padId} 对目标PAD ${contact.id} 的铜接触不连续`);
						}
						side.additionalSameNetContacts.push({ objectId: contact.id, branchPadId: branch.padId });
					}
					continue;
				}
				if ((clearanceMil === 0 && edgeDistance <= EPS) || edgeDistance < clearanceMil - EPS)
					fail(`支路 ${branch.padId} 与异网导电对象 ${contact.id} 铜边间距不足 ${clearanceMil} mil`);
			}
		}
	}
	for (const side of plannedSides) {
		const seenContacts = new Set<string>();
		side.additionalSameNetContacts = side.additionalSameNetContacts.filter((contact) => {
			const key = `${contact.objectId}\0${contact.branchPadId}`;
			if (seenContacts.has(key))
				return false;
			seenContacts.add(key);
			return true;
		});
	}
	return { layer, width, clearanceMil, positive: plannedSides[0], negative: plannedSides[1] };
}
