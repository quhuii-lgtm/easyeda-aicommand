export type TunePoint = [
	number,
	number,
];
export interface TuneLine {
	id: string;
	net: string;
	layer: number | null;
	width: number;
	a: TunePoint;
	b: TunePoint;
	locked?: boolean;
}
export interface TuneRegion {
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
}
export interface TuneSelectionRequest {
	net: string;
	lines: TuneLine[];
	primitiveIds?: string[];
	tunePrimitiveId?: string;
	region?: TuneRegion;
}
export interface TuneSelection {
	orderedIds: string[];
	path: TunePoint[];
	tuneSegmentIndex: number;
	tuneSegmentIndices: number[];
	selectionReason: string;
}
function fail(message: string): never {
	throw new Error(`走线补长目标检查失败：${message}`);
}
function finite(n: unknown, name: string): number {
	if (typeof n !== 'number' || !Number.isFinite(n))
		fail(`${name}必须是有限数值`);
	return n;
}
function samePoint(a: TunePoint, b: TunePoint): boolean {
	return a[0] === b[0] && a[1] === b[1];
}
function validatePoint(p: TunePoint, name: string): TunePoint {
	if (!Array.isArray(p) || p.length !== 2)
		fail(`${name}必须是[x,y]`);
	return [finite(p[0], `${name}.x`), finite(p[1], `${name}.y`)];
}
function validateLine(line: TuneLine): TuneLine {
	if (!line || typeof line.id !== 'string' || !line.id)
		fail('线段id无效');
	if (typeof line.net !== 'string')
		fail(`线段${line.id}的net必须是字符串`);
	if (!(line.layer === null || (Number.isInteger(line.layer) && line.layer >= 0)))
		fail(`线段${line.id}的layer无效`);
	const width = finite(line.width, `线段${line.id}.width`);
	if (!(width > 0))
		fail(`线段${line.id}的width必须大于0`);
	const a = validatePoint(line.a, `线段${line.id}.a`);
	const b = validatePoint(line.b, `线段${line.id}.b`);
	if (samePoint(a, b))
		fail(`线段${line.id}长度为零`);
	return { ...line, a, b };
}
function pointCompare(a: TunePoint, b: TunePoint): number {
	return a[0] - b[0] || a[1] - b[1];
}
function inRegion(line: TuneLine, r: TuneRegion): boolean {
	return [line.a, line.b].every(([x, y]) => x >= r.xMin && x <= r.xMax && y >= r.yMin && y <= r.yMax);
}
export function resolveTuneSelection(request: TuneSelectionRequest): TuneSelection {
	if (!request || typeof request !== 'object' || typeof request.net !== 'string' || !request.net)
		fail('net必须是非空字符串');
	if (!Array.isArray(request.lines))
		fail('lines必须是数组');
	const all = request.lines.map(validateLine);
	const ids = new Set<string>();
	for (const line of all) {
		if (ids.has(line.id))
			fail(`lines包含重复id ${line.id}`);
		ids.add(line.id);
	}
	let selected: TuneLine[];
	let selectionReason: string;
	if (request.primitiveIds !== undefined) {
		if (!Array.isArray(request.primitiveIds) || request.primitiveIds.length === 0)
			fail('primitiveIds必须是非空数组');
		const selectedIds = new Set<string>();
		for (const id of request.primitiveIds) {
			if (typeof id !== 'string' || selectedIds.has(id))
				fail(`primitiveIds包含无效或重复id ${String(id)}`);
			selectedIds.add(id);
			if (!ids.has(id))
				fail(`找不到线段 ${id}`);
		}
		selected = all.filter(line => selectedIds.has(line.id));
		selectionReason = '按调用方明确指定的primitiveIds选择开放单链。';
	}
	else {
		if (!request.region)
			fail('省略primitiveIds时必须提供region');
		const r = request.region;
		for (const [name, value] of Object.entries(r))
			finite(value, `region.${name}`);
		if (!(r.xMin < r.xMax && r.yMin < r.yMax))
			fail('region边界无效');
		const candidates = all.filter(line => line.net === request.net && inRegion(line, r));
		if (candidates.length !== 1)
			fail(`region内完整包含 ${candidates.length} 条候选直线；请明确提供primitiveIds（候选：${candidates.map(x => x.id).join(', ') || '无'}）`);
		selected = candidates;
		selectionReason = `region完整包含唯一候选线段 ${candidates[0].id}。`;
	}
	if (selected.some(line => line.net !== request.net))
		fail('选择中存在不同net的线段');
	const first = selected[0];
	if (selected.some(line => line.layer !== first.layer))
		fail('选择中存在不同layer的线段');
	if (selected.some(line => line.width !== first.width))
		fail('选择中存在不同width的线段');
	if (selected.some(line => line.locked))
		fail('选择中存在锁定线段');
	if (request.tunePrimitiveId !== undefined && !selected.some(line => line.id === request.tunePrimitiveId))
		fail(`tunePrimitiveId ${request.tunePrimitiveId}不属于所选线段`);
	const edges = new Map<TuneLine, [
		TunePoint,
		TunePoint,
	]>();
	const degree = new Map<string, {
		point: TunePoint;
		edges: TuneLine[];
	}>();
	const key = (p: TunePoint) => `${p[0]},${p[1]}`;
	for (const line of selected) {
		edges.set(line, [line.a, line.b]);
		for (const p of [line.a, line.b]) {
			const k = key(p);
			const item = degree.get(k) ?? { point: p, edges: [] };
			item.edges.push(line);
			degree.set(k, item);
		}
	}
	if ([...degree.values()].some(x => x.edges.length > 2))
		fail('所选线段存在分叉');
	const ends = [...degree.values()].filter(x => x.edges.length === 1);
	if (ends.length !== 2)
		fail(ends.length === 0 ? '所选线段形成闭环' : '所选线段不是开放单链');
	const startEnd = [...ends].sort((a, b) => pointCompare(a.point, b.point))[0];
	const ordered: TuneLine[] = [];
	const path: TunePoint[] = [startEnd.point];
	let currentPoint = startEnd.point;
	let previous: TuneLine | undefined;
	while (ordered.length < selected.length) {
		const next = (degree.get(key(currentPoint))?.edges ?? []).find(line => line !== previous);
		if (!next)
			break;
		ordered.push(next);
		const nextPoint = samePoint(next.a, currentPoint) ? next.b : next.a;
		path.push(nextPoint);
		previous = next;
		currentPoint = nextPoint;
	}
	if (ordered.length !== selected.length)
		fail('所选线段不连通，不能组成单一开放链');
	let tuneSegmentIndex: number;
	let tuneSegmentIndices: number[];
	if (request.tunePrimitiveId !== undefined) {
		tuneSegmentIndex = ordered.findIndex(line => line.id === request.tunePrimitiveId);
		tuneSegmentIndices = [tuneSegmentIndex];
	}
	else {
		const r = request.region;
		tuneSegmentIndices = ordered.map((line, i) => r && inRegion(line, r) ? i : -1).filter(i => i >= 0);
		if (!tuneSegmentIndices.length)
			fail('region没有完整容纳任何一条调节候选线段');
		tuneSegmentIndex = tuneSegmentIndices[0];
	}
	return { orderedIds: ordered.map(x => x.id), path, tuneSegmentIndex, tuneSegmentIndices, selectionReason };
}
export type TuneContact = {
	id: string;
	net: string;
	layers: number[] | null;
	kind: 'circle';
	center: TunePoint;
	radius: number;
	holeRadius?: number;
} | {
	id: string;
	net: string;
	layers: number[] | null;
	kind: 'rect';
	center: TunePoint;
	width: number;
	height: number;
	rotation: number;
} | {
	id: string;
	net: string;
	layers: number[] | null;
	kind: 'unknown';
	bounds?: TuneRegion;
	reason?: string;
};
export interface TuneAttachmentRequest {
	targetLine: TuneLine;
	remainingLines: TuneLine[];
	newLocalPath: TunePoint[];
	/** Maps each sampled path edge to its real LINE or ARC primitive index. */
	newEdgePrimitiveIndices?: number[];
	/** Conservative curve sampling error bound, in mil. */
	curveSagittaMil?: number;
	contacts: TuneContact[];
	checkBudget?: () => void;
}
export interface TuneAttachmentResult {
	endpointConnections: Array<{
		objectId: string;
		endpoint: 'start' | 'end';
		kind: string;
	}>;
	interiorConnections: Array<{
		objectId: string;
		kind: string;
		reason: string;
	}>;
	bypassRisks: Array<{
		objectId: string;
		kind: string;
		reason: string;
	}>;
	uncertainContacts: Array<{
		objectId: string;
		reason: string;
	}>;
	coverage: {
		checkedLines: number;
		checkedContacts: number;
		excludedDifferentNet: number;
		excludedDifferentLayer: number;
		unresolved: number;
		complete: false;
	};
}
interface Seg {
	a: TunePoint;
	b: TunePoint;
}
const sub = (a: TunePoint, b: TunePoint): TunePoint => [a[0] - b[0], a[1] - b[1]];
const dot = (a: TunePoint, b: TunePoint) => a[0] * b[0] + a[1] * b[1];
const dist = (a: TunePoint, b: TunePoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pointSeg(p: TunePoint, s: Seg): number {
	const v = sub(s.b, s.a);
	const vv = dot(v, v);
	const t = vv ? Math.max(0, Math.min(1, dot(sub(p, s.a), v) / vv)) : 0;
	return dist(p, [s.a[0] + v[0] * t, s.a[1] + v[1] * t]);
}
function segmentsIntersect(s: Seg, t: Seg): boolean {
	const cross = (a: TunePoint, b: TunePoint, c: TunePoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	const on = (a: TunePoint, b: TunePoint, p: TunePoint) => Math.abs(cross(a, b, p)) < 1e-9 && p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 && p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
	const c1 = cross(s.a, s.b, t.a);
	const c2 = cross(s.a, s.b, t.b);
	const c3 = cross(t.a, t.b, s.a);
	const c4 = cross(t.a, t.b, s.b);
	return (c1 * c2 < 0 && c3 * c4 < 0) || (on(s.a, s.b, t.a) || on(s.a, s.b, t.b) || on(t.a, t.b, s.a) || on(t.a, t.b, s.b));
}
function segDistance(a: Seg, b: Seg): number {
	return segmentsIntersect(a, b) ? 0 : Math.min(pointSeg(a.a, b), pointSeg(a.b, b), pointSeg(b.a, a), pointSeg(b.b, a));
}
function hasSeparatedCrossings(reference: Seg, pieces: Seg[], touchedIndices: number[], clearance: number): boolean {
	const direction = sub(reference.b, reference.a);
	const lengthSquared = dot(direction, direction);
	if (!lengthSquared)
		return false;
	const cross = (a: TunePoint, b: TunePoint) => a[0] * b[1] - a[1] * b[0];
	const parameters: number[] = [];
	for (const index of touchedIndices) {
		const piece = pieces[index];
		const otherDirection = sub(piece.b, piece.a);
		const denominator = cross(direction, otherDirection);
		if (Math.abs(denominator) <= 1e-12)
			continue;
		const delta = sub(piece.a, reference.a);
		const t = cross(delta, otherDirection) / denominator;
		const u = cross(delta, direction) / denominator;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
			parameters.push(t);
	}
	parameters.sort((a, b) => a - b);
	const separation = 2 * clearance / Math.sqrt(lengthSquared);
	return parameters.some((value, i) => i > 0 && value - parameters[i - 1] >= separation - 1e-9);
}
function sameDirectionOverlap(shared: TunePoint, existingOther: TunePoint, pathOther: TunePoint): boolean {
	const existing = sub(existingOther, shared);
	const pathVector = sub(pathOther, shared);
	const existingLength = dist(existingOther, shared);
	const pathLength = dist(pathOther, shared);
	const cross = existing[0] * pathVector[1] - existing[1] * pathVector[0];
	return existingLength > 0 && pathLength > 0
		&& Math.abs(cross) <= 1e-9 * existingLength * pathLength
		&& dot(existing, pathVector) > 0;
}
function pointRectDistance(p: TunePoint, c: TunePoint, w: number, h: number, rotation: number): number {
	const angle = -rotation * Math.PI / 180;
	const dx = p[0] - c[0];
	const dy = p[1] - c[1];
	const x = dx * Math.cos(angle) - dy * Math.sin(angle);
	const y = dx * Math.sin(angle) + dy * Math.cos(angle);
	return Math.hypot(Math.max(Math.abs(x) - w / 2, 0), Math.max(Math.abs(y) - h / 2, 0));
}
function segmentRectDistance(s: Seg, c: TunePoint, w: number, h: number, rotation: number): number {
	const angle = -rotation * Math.PI / 180;
	const tx = (p: TunePoint): TunePoint => {
		const x = p[0] - c[0];
		const y = p[1] - c[1];
		return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
	};
	const a = tx(s.a);
	const b = tx(s.b);
	const rect: TunePoint[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
	if ((a[0] >= -w / 2 && a[0] <= w / 2 && a[1] >= -h / 2 && a[1] <= h / 2) || (b[0] >= -w / 2 && b[0] <= w / 2 && b[1] >= -h / 2 && b[1] <= h / 2))
		return 0;
	let d = Infinity;
	for (let i = 0; i < 4; i++) {
		const edge = { a: rect[i], b: rect[(i + 1) % 4] };
		d = Math.min(d, segDistance({ a, b }, edge));
	}
	return d;
}
function boundsFor(s: Seg, margin: number): TuneRegion {
	return { xMin: Math.min(s.a[0], s.b[0]) - margin, xMax: Math.max(s.a[0], s.b[0]) + margin, yMin: Math.min(s.a[1], s.b[1]) - margin, yMax: Math.max(s.a[1], s.b[1]) + margin };
}
function intersectsBounds(a: TuneRegion, b: TuneRegion): boolean {
	return a.xMin <= b.xMax && a.xMax >= b.xMin && a.yMin <= b.yMax && a.yMax >= b.yMin;
}
export function checkTuneAttachments(request: TuneAttachmentRequest): TuneAttachmentResult {
	if (!request || !request.targetLine || !Array.isArray(request.remainingLines) || !Array.isArray(request.contacts))
		fail('targetLine、remainingLines和contacts必需');
	const target = validateLine(request.targetLine);
	const path = request.newLocalPath.map((p, i) => validatePoint(p, `newLocalPath[${i}]`));
	if (path.length < 2)
		fail('newLocalPath至少需要两个点');
	const edgeCount = path.length - 1;
	let edgePrimitiveIndices: number[];
	if (request.newEdgePrimitiveIndices === undefined) {
		edgePrimitiveIndices = Array.from({ length: edgeCount }, (_, i) => i);
	}
	else {
		if (!Array.isArray(request.newEdgePrimitiveIndices) || request.newEdgePrimitiveIndices.length !== edgeCount)
			fail('newEdgePrimitiveIndices长度必须等于newLocalPath.length - 1');
		edgePrimitiveIndices = request.newEdgePrimitiveIndices.map((index, i) => {
			if (!Number.isInteger(index) || index < 0)
				fail(`newEdgePrimitiveIndices[${i}]必须是非负整数`);
			return index;
		});
		if (edgePrimitiveIndices.some((index, i) => i > 0 && index < edgePrimitiveIndices[i - 1]))
			fail('newEdgePrimitiveIndices必须按路径顺序递增或保持不变');
	}
	const sagitta = request.curveSagittaMil === undefined ? 0 : finite(request.curveSagittaMil, 'curveSagittaMil');
	if (sagitta < 0)
		fail('curveSagittaMil必须大于或等于0');
	const width = target.width;
	const radius = width / 2;
	const newRadius = radius + sagitta;
	const start = path[0];
	const end = path[path.length - 1];
	const oldTarget: Seg = { a: target.a, b: target.b };
	const pathMatchesOldEndpoints = (samePoint(start, target.a) && samePoint(end, target.b))
		|| (samePoint(start, target.b) && samePoint(end, target.a));
	const local: Seg[] = path.slice(1).map((p, i) => ({ a: path[i], b: p }));
	const result: TuneAttachmentResult = { endpointConnections: [], interiorConnections: [], bypassRisks: [], uncertainContacts: [], coverage: { checkedLines: 0, checkedContacts: 0, excludedDifferentNet: 0, excludedDifferentLayer: 0, unresolved: 0, complete: false } };
	const endpointHit = (p: TunePoint, c: TuneContact, pathRadius: number): boolean => {
		if (c.kind === 'circle') {
			const d = dist(p, c.center);
			const hole = Math.max(0, c.holeRadius ?? 0);
			return d <= c.radius + pathRadius && d + pathRadius >= hole;
		}
		if (c.kind === 'rect')
			return pointRectDistance(p, c.center, c.width, c.height, c.rotation) <= pathRadius;
		return false;
	};
	const segmentHit = (s: Seg, c: TuneContact, pathRadius: number): boolean => {
		if (c.kind === 'circle') {
			const minimum = pointSeg(c.center, s);
			const maximum = Math.max(dist(c.center, s.a), dist(c.center, s.b));
			return minimum <= c.radius + pathRadius && maximum + pathRadius >= Math.max(0, c.holeRadius ?? 0);
		}
		if (c.kind === 'rect')
			return segmentRectDistance(s, c.center, c.width, c.height, c.rotation) <= pathRadius;
		return false;
	};
	const endpointRingExtent = (p: TunePoint, edgeStart: number, c: TuneContact): number => {
		if (c.kind !== 'circle' || (c.holeRadius ?? 0) <= 0 || dist(p, c.center) > c.radius + newRadius)
			return -1;
		// Walk the connected endpoint prefix/suffix: the via endpoint may be at the hole
		// center, so the first short sample edges can remain entirely inside the hole.
		const indices = edgeStart === 0 ? Array.from({ length: local.length }, (_, i) => i) : Array.from({ length: local.length }, (_, i) => local.length - 1 - i);
		let hitAt = -1;
		for (const index of indices) {
			const piece = local[index];
			if (segmentHit(piece, c, newRadius))
				hitAt = index;
			const nextPoint = edgeStart === 0 ? piece.b : piece.a;
			if (dist(nextPoint, c.center) > c.radius + newRadius)
				break;
		}
		return hitAt ?? -1;
	};
	const touchedEdges = (c: TuneContact): number[] => local.map((piece, i) => segmentHit(piece, c, newRadius) ? i : -1).filter(i => i >= 0);
	const hasSeparatedIntervals = (indices: number[]): boolean => indices.some((index, i) => i > 0 && index > indices[i - 1] + 1);
	const primitivePosition = new Map<number, number>();
	for (const primitiveIndex of edgePrimitiveIndices) {
		if (!primitivePosition.has(primitiveIndex))
			primitivePosition.set(primitiveIndex, primitivePosition.size);
	}
	const hasNonAdjacentPrimitiveTouches = (indices: number[]): boolean => {
		const positions: number[] = [];
		for (const index of indices) {
			const position = primitivePosition.get(edgePrimitiveIndices[index])!;
			if (positions.at(-1) !== position)
				positions.push(position);
		}
		return positions.some((position, i) => i > 0 && position > positions[i - 1] + 1);
	};
	const isPrefix = (indices: number[]): boolean => indices.length > 0 && indices[0] === 0 && indices.every((index, i) => index === i);
	const isSuffix = (indices: number[]): boolean => indices.length > 0 && indices.at(-1) === local.length - 1
		&& indices.every((index, i) => index === local.length - indices.length + i);
	for (const lineInput of request.remainingLines) {
		request.checkBudget?.();
		const line = validateLine(lineInput);
		if (line.id === target.id)
			continue;
		if (line.net !== target.net) {
			result.coverage.excludedDifferentNet++;
			continue;
		}
		if (line.layer !== target.layer) {
			result.coverage.excludedDifferentLayer++;
			continue;
		}
		result.coverage.checkedLines++;
		const s = { a: line.a, b: line.b };
		const oldHit = segDistance(s, oldTarget) <= (line.width + width) / 2;
		const touchedEdgesForLine = local.map((piece, index) => segDistance(s, piece) <= (line.width + width) / 2 + sagitta ? index : -1).filter(index => index >= 0);
		if (oldHit) {
			const atOldStart = dist(line.a, target.a) <= (line.width + width) / 2 || dist(line.b, target.a) <= (line.width + width) / 2;
			const atOldEnd = dist(line.a, target.b) <= (line.width + width) / 2 || dist(line.b, target.b) <= (line.width + width) / 2;
			const oldStartPathIndex = samePoint(start, target.a) ? 0 : samePoint(end, target.a) ? local.length - 1 : -1;
			const oldEndPathIndex = samePoint(start, target.b) ? 0 : samePoint(end, target.b) ? local.length - 1 : -1;
			const preservedAtEndpoint = pathMatchesOldEndpoints
				&& ((atOldStart && (oldStartPathIndex === 0 ? isPrefix(touchedEdgesForLine) : isSuffix(touchedEdgesForLine)))
					|| (atOldEnd && (oldEndPathIndex === 0 ? isPrefix(touchedEdgesForLine) : isSuffix(touchedEdgesForLine))));
			if (!preservedAtEndpoint)
				result.interiorConnections.push({ objectId: line.id, kind: 'line', reason: '同网同层旧目标线中段存在接入；删除旧线会断开该连接。' });
		}
		const hit = touchedEdgesForLine.length > 0;
		if (!hit)
			continue;
		const atStart = dist(line.a, start) <= (line.width + width) / 2 || dist(line.b, start) <= (line.width + width) / 2;
		const atEnd = dist(line.a, end) <= (line.width + width) / 2 || dist(line.b, end) <= (line.width + width) / 2;
		const endpointTouch = atStart || atEnd;
		const touchesBeyondEndpoint = (atStart && !isPrefix(touchedEdgesForLine))
			|| (atEnd && !isSuffix(touchedEdgesForLine));
		if (atStart && atEnd) {
			result.bypassRisks.push({ objectId: line.id, kind: 'line', reason: '同层同网铜线同时触及新路径首尾，可能形成旁路。' });
		}
		else if (touchesBeyondEndpoint) {
			result.interiorConnections.push({ objectId: line.id, kind: 'line', reason: '共享路径端点的线段还触及非相邻新路径段，形成中段接入或旁路风险。' });
		}
		else if (!endpointTouch && (hasSeparatedIntervals(touchedEdgesForLine) || hasNonAdjacentPrimitiveTouches(touchedEdgesForLine)
			|| hasSeparatedCrossings(s, local, touchedEdgesForLine, (line.width + width) / 2 + sagitta))) {
			result.bypassRisks.push({ objectId: line.id, kind: 'line', reason: '同层同网铜线触及新路径不相邻内部段，可能形成旁路。' });
		}
		else if (endpointTouch) {
			const endpoint = atStart ? start : end;
			const other = samePoint(line.a, endpoint) ? line.b : samePoint(line.b, endpoint) ? line.a : null;
			const adjacent = atStart ? local[0] : local.at(-1)!;
			const localOther = samePoint(adjacent.a, endpoint) ? adjacent.b : adjacent.a;
			const allowedNeighbor = other !== null && (dist(other, endpoint) <= 1e-9 || !sameDirectionOverlap(endpoint, other, localOther));
			if (!allowedNeighbor)
				result.interiorConnections.push({ objectId: line.id, kind: 'line', reason: other && sameDirectionOverlap(endpoint, other, localOther) ? '同层同网线段与新路径端点段共线同向重叠，不能按端点接合豁免。' : '同层同网线段接入路径端点，但接触落在线段中部，可能形成T形支路。' });
		}
		else {
			result.interiorConnections.push({ objectId: line.id, kind: 'line', reason: '同层同网线段在路径内部相交或进入线宽胶囊范围。' });
		}
	}
	for (const c of request.contacts) {
		request.checkBudget?.();
		if (!c || typeof c.id !== 'string' || typeof c.net !== 'string') {
			result.uncertainContacts.push({ objectId: 'unknown', reason: '接触对象字段无效。' });
			result.coverage.unresolved++;
			continue;
		}
		if (c.net !== target.net)
			continue;
		if (c.layers !== null && !c.layers.includes(target.layer as number))
			continue;
		result.coverage.checkedContacts++;
		let bounds: TuneRegion | undefined;
		if (c.kind === 'circle') {
			bounds = { xMin: c.center[0] - c.radius - radius, xMax: c.center[0] + c.radius + radius, yMin: c.center[1] - c.radius - radius, yMax: c.center[1] + c.radius + radius };
		}
		else if (c.kind === 'rect') {
			const e = Math.hypot(c.width, c.height) / 2 + radius;
			bounds = { xMin: c.center[0] - e, xMax: c.center[0] + e, yMin: c.center[1] - e, yMax: c.center[1] + e };
		}
		else {
			bounds = c.bounds;
		}
		const localBounds = local.map(piece => boundsFor(piece, newRadius));
		const oldTargetBounds = boundsFor(oldTarget, radius);
		const oldNear = !bounds || intersectsBounds(oldTargetBounds, bounds);
		const newNear = !bounds || localBounds.some(b => intersectsBounds(b, bounds!));
		if (!oldNear && !newNear)
			continue;
		if (c.kind === 'unknown') {
			result.uncertainContacts.push({ objectId: c.id, reason: c.reason ?? (oldNear && newNear ? '未知形状可能接触旧目标线或新路径。' : oldNear ? '未知形状可能接触旧目标线。' : '未知形状可能接触新路径。') });
			result.coverage.unresolved++;
			continue;
		}
		if (c.layers === null) {
			result.uncertainContacts.push({ objectId: c.id, reason: oldNear && newNear ? '对象图层未知且可能接触旧目标线或新路径。' : oldNear ? '对象图层未知且可能接触旧目标线。' : '对象图层未知且可能接触新路径。' });
			result.coverage.unresolved++;
			continue;
		}
		const oldHit = segmentHit(oldTarget, c, radius);
		const oldRingHit = (p: TunePoint): boolean => c.kind === 'circle' && (c.holeRadius ?? 0) > 0
			&& dist(p, c.center) <= c.radius + radius && segmentHit(oldTarget, c, radius);
		const oldStartHit = endpointHit(target.a, c, radius) || oldRingHit(target.a);
		const oldEndHit = endpointHit(target.b, c, radius) || oldRingHit(target.b);
		const startRingExtent = endpointRingExtent(start, 0, c);
		const endRingExtent = endpointRingExtent(end, local.length - 1, c);
		const startHit = endpointHit(start, c, newRadius) || startRingExtent >= 0;
		const endHit = endpointHit(end, c, newRadius) || endRingExtent >= 0;
		const targetANewHit = (samePoint(start, target.a) && startHit) || (samePoint(end, target.a) && endHit);
		const targetBNewHit = (samePoint(start, target.b) && startHit) || (samePoint(end, target.b) && endHit);
		const oldConnectionPreserved = pathMatchesOldEndpoints && ((oldStartHit && targetANewHit) || (oldEndHit && targetBNewHit));
		if (oldHit && !oldConnectionPreserved)
			result.interiorConnections.push({ objectId: c.id, kind: c.kind, reason: '接触原目标线中段的焊盘或铜对象不会由保留端点继续连接；删除旧线会断开该连接。' });
		if (startHit)
			result.endpointConnections.push({ objectId: c.id, endpoint: 'start', kind: c.kind });
		if (endHit)
			result.endpointConnections.push({ objectId: c.id, endpoint: 'end', kind: c.kind });
		const touchedEdgesForContact = touchedEdges(c);
		const startConnectedRun = startHit && (isPrefix(touchedEdgesForContact)
			|| (startRingExtent >= 0 && touchedEdgesForContact.every(i => i <= startRingExtent)));
		const endConnectedRun = endHit && (isSuffix(touchedEdgesForContact)
			|| (endRingExtent >= 0 && touchedEdgesForContact.every(i => i >= endRingExtent)));
		const startRunEnd = startConnectedRun ? (isPrefix(touchedEdgesForContact) ? touchedEdgesForContact.at(-1)! : startRingExtent) : -1;
		const endRunStart = endConnectedRun ? (isSuffix(touchedEdgesForContact) ? touchedEdgesForContact[0] : endRingExtent) : local.length;
		if (startHit && endHit) {
			result.bypassRisks.push({ objectId: c.id, kind: c.kind, reason: '同一焊盘或铜对象同时接触新路径首尾，可能形成旁路。' });
		}
		else if (!startConnectedRun && !endConnectedRun
			&& (hasSeparatedIntervals(touchedEdgesForContact) || hasNonAdjacentPrimitiveTouches(touchedEdgesForContact))) {
			result.bypassRisks.push({ objectId: c.id, kind: c.kind, reason: '同一焊盘或铜对象触及新路径不相邻内部段，可能形成旁路。' });
		}
		else if (touchedEdgesForContact.some(i => !(startConnectedRun && i <= startRunEnd)
			&& !(endConnectedRun && i >= endRunStart))) {
			result.interiorConnections.push({ objectId: c.id, kind: c.kind, reason: '同层焊盘或铜对象触及新路径非端点段。' });
		}
	}
	return result;
}
