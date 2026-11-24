/**
 * Read-only candidates for review of PCB routing remnants.
 * Coordinates and dimensions are mill. Results are geometric evidence only;
 * this module never decides that an object is safe to delete.
 */

export interface Point { x: number; y: number }
export interface ScanTrack { id: string; net: string; layer: number; width: number; a: Point; b: Point; locked?: boolean; arc?: number }
export interface ScanVia { id: string; net: string; x: number; y: number; diameter: number; hole: number; layers: number[] | null; locked?: boolean }
export interface ScanPad { id: string; net: string; x: number; y: number; layers: number[]; radius: number; approximate?: boolean }
export interface ScanCopper { id: string; net: string; layer: number; rings: Point[][]; stroke?: number }
export interface ScanIssue { code: string; message: string; net?: string; layer?: number; objectId?: string }

export interface RemnantCandidate {
	kind: 'single-attachment-branch' | 'collinear-overlap' | 'via-connectivity';
	net: string;
	layer?: number;
	objectIds: string[];
	position: Point;
	locations?: Point[];
	requiresHumanReview: true;
	evidence: string[];
	protectionNotes: string[];
	classification?: 'exact-duplicate' | 'partial-collinear-overlap' | 'one-layer-only' | 'isolated' | 'partial-layer-contact' | 'layer-connected';
	contactsByLayer?: Array<{ layer: number; tracks: string[]; copper: string[]; pads: string[] }>;
}

export interface RoutingRemnantAnalysis {
	candidates: RemnantCandidate[];
	viaConnectivity: Array<{ id: string; net: string; x: number; y: number; layers: number[]; contactsByLayer: Array<{ layer: number; tracks: string[]; copper: string[]; pads: string[] }>; classification: 'isolated' | 'one-layer-only' | 'partial-layer-contact' | 'layer-connected' }>;
	issues: ScanIssue[];
	connectivity: Array<{ net: string; layer: number; trackCount: number; componentCount: number; knownGeometry: boolean }>;
	coverage: { trackCount: number; viaCount: number; padCount: number; copperCount: number; unsupportedArcIds: string[]; unknownViaSpanIds: string[]; approximatePadIds: string[] };
}

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
type NodeKind = 'track' | 'via' | 'pad' | 'copper';
interface GraphNode { key: string; kind: NodeKind; id: string; net: string; layers: number[]; bounds: Bounds; track?: ScanTrack; via?: ScanVia; pad?: ScanPad; copper?: ScanCopper; anchor: boolean }

const EPS = 1e-5;
const TOUCH_TOLERANCE = 0.02; // mil; absorbs floating-point noise only.
const finite = (n: number) => Number.isFinite(n);
const pointDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const dot = (ax: number, ay: number, bx: number, by: number) => ax * bx + ay * by;
const netLayerKey = (net: string, layer: number) => JSON.stringify([net, layer]);

function segmentBounds(a: Point, b: Point, margin = 0): Bounds {
	return { minX: Math.min(a.x, b.x) - margin, minY: Math.min(a.y, b.y) - margin, maxX: Math.max(a.x, b.x) + margin, maxY: Math.max(a.y, b.y) + margin };
}
function pointBounds(p: Point, radius = 0): Bounds {
	return { minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius };
}
function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX + TOUCH_TOLERANCE && a.maxX + TOUCH_TOLERANCE >= b.minX
		&& a.minY <= b.maxY + TOUCH_TOLERANCE && a.maxY + TOUCH_TOLERANCE >= b.minY;
}
function mergedBounds(items: Bounds[]): Bounds {
	return { minX: Math.min(...items.map(x => x.minX)), minY: Math.min(...items.map(x => x.minY)), maxX: Math.max(...items.map(x => x.maxX)), maxY: Math.max(...items.map(x => x.maxY)) };
}
function boundsCenter(b: Bounds): Point {
	return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const d2 = dx * dx + dy * dy;
	if (d2 <= EPS * EPS)
		return pointDistance(p, a);
	const t = Math.max(0, Math.min(1, dot(p.x - a.x, p.y - a.y, dx, dy) / d2));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const cdx = d.x - c.x;
	const cdy = d.y - c.y;
	const den = cross(abx, aby, cdx, cdy);
	const acx = c.x - a.x;
	const acy = c.y - a.y;
	if (Math.abs(den) > EPS) {
		const t = cross(acx, acy, cdx, cdy) / den;
		const u = cross(acx, acy, abx, aby) / den;
		if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
			return 0;
	}
	else if (Math.abs(cross(acx, acy, abx, aby)) <= EPS) {
		const len2 = dot(abx, aby, abx, aby);
		if (len2 <= EPS * EPS)
			return pointSegmentDistance(a, c, d);
		const t0 = dot(c.x - a.x, c.y - a.y, abx, aby) / len2;
		const t1 = dot(d.x - a.x, d.y - a.y, abx, aby) / len2;
		if (Math.max(Math.min(t0, t1), 0) <= Math.min(Math.max(t0, t1), 1) + EPS)
			return 0;
	}
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function ringEdges(ring: Point[], closed: boolean): Array<[Point, Point]> {
	if (ring.length < 2)
		return [];
	const result: Array<[Point, Point]> = [];
	const edgeCount = closed ? ring.length : ring.length - 1;
	for (let i = 0; i < edgeCount; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		if (pointDistance(a, b) > EPS)
			result.push([a, b]);
	}
	return result;
}
function pointInRingsEvenOdd(p: Point, copper: ScanCopper): boolean {
	if (copper.stroke !== undefined)
		return false;
	let inside = false;
	for (const ring of copper.rings) {
		for (const [a, b] of ringEdges(ring, true)) {
			if (pointSegmentDistance(p, a, b) <= TOUCH_TOLERANCE)
				return true;
			if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)
				inside = !inside;
		}
	}
	return inside;
}
function segmentPolygonDistance(a: Point, b: Point, copper: ScanCopper): number {
	if (pointInRingsEvenOdd(a, copper) || pointInRingsEvenOdd(b, copper))
		return 0;
	let best = Infinity;
	for (const ring of copper.rings) {
		for (const [c, d] of ringEdges(ring, copper.stroke === undefined)) {
			best = Math.min(best, segmentDistance(a, b, c, d));
			if (best <= TOUCH_TOLERANCE)
				return 0;
		}
	}
	return best;
}
function polygonBounds(rings: Point[][], margin = 0): Bounds {
	const points = rings.flat();
	return { minX: Math.min(...points.map(p => p.x)) - margin, minY: Math.min(...points.map(p => p.y)) - margin, maxX: Math.max(...points.map(p => p.x)) + margin, maxY: Math.max(...points.map(p => p.y)) + margin };
}
function copperCopperTouch(a: ScanCopper, b: ScanCopper): boolean {
	if (a.rings.some(r => r.some(p => pointInRingsEvenOdd(p, b))) || b.rings.some(r => r.some(p => pointInRingsEvenOdd(p, a)))) {
		return true;
	}
	const allowance = Math.max(a.stroke ?? 0, b.stroke ?? 0) / 2 + TOUCH_TOLERANCE;
	for (const ra of a.rings) {
		for (const [a0, a1] of ringEdges(ra, a.stroke === undefined)) {
			for (const rb of b.rings) {
				for (const [b0, b1] of ringEdges(rb, b.stroke === undefined)) {
					if (segmentDistance(a0, a1, b0, b1) <= allowance)
						return true;
				}
			}
		}
	}
	return false;
}

function trackContact(a: ScanTrack, b: ScanTrack): boolean {
	return segmentDistance(a.a, a.b, b.a, b.b) <= (a.width + b.width) / 2 + TOUCH_TOLERANCE;
}
function trackViaContact(track: ScanTrack, via: ScanVia): boolean {
	return pointSegmentDistance({ x: via.x, y: via.y }, track.a, track.b) <= (track.width + via.diameter) / 2 + TOUCH_TOLERANCE;
}
function trackPadContact(track: ScanTrack, pad: ScanPad): boolean {
	return pointSegmentDistance({ x: pad.x, y: pad.y }, track.a, track.b) <= track.width / 2 + pad.radius + TOUCH_TOLERANCE;
}
function trackCopperContact(track: ScanTrack, copper: ScanCopper): boolean {
	return segmentPolygonDistance(track.a, track.b, copper) <= track.width / 2 + Math.max(0, copper.stroke ?? 0) / 2 + TOUCH_TOLERANCE;
}
function viaCopperContact(via: ScanVia, copper: ScanCopper): boolean {
	const p = { x: via.x, y: via.y };
	if (pointInRingsEvenOdd(p, copper))
		return true;
	let best = Infinity;
	for (const ring of copper.rings) {
		for (const [a, b] of ringEdges(ring, copper.stroke === undefined))
			best = Math.min(best, pointSegmentDistance(p, a, b));
	}
	return best <= via.diameter / 2 + Math.max(0, copper.stroke ?? 0) / 2 + TOUCH_TOLERANCE;
}
function viaPadContact(via: { x: number; y: number; diameter: number }, pad: { x: number; y: number; radius: number }): boolean {
	return pointDistance({ x: via.x, y: via.y }, { x: pad.x, y: pad.y }) <= via.diameter / 2 + pad.radius + TOUCH_TOLERANCE;
}
function viaViaContact(a: ScanVia, b: ScanVia): boolean {
	return pointDistance({ x: a.x, y: a.y }, { x: b.x, y: b.y }) <= (a.diameter + b.diameter) / 2 + TOUCH_TOLERANCE;
}
function pointCopperContact(p: Point, copper: ScanCopper, radius: number): boolean {
	if (pointInRingsEvenOdd(p, copper))
		return true;
	let best = Infinity;
	for (const ring of copper.rings) {
		for (const [a, b] of ringEdges(ring, copper.stroke === undefined))
			best = Math.min(best, pointSegmentDistance(p, a, b));
	}
	return best <= radius + Math.max(0, copper.stroke ?? 0) / 2 + TOUCH_TOLERANCE;
}

function collinearOverlap(a: ScanTrack, b: ScanTrack): { kind: 'exact-duplicate' | 'partial-collinear-overlap'; start: Point; end: Point; overlapLength: number } | undefined {
	const ax = a.b.x - a.a.x;
	const ay = a.b.y - a.a.y;
	const bx = b.b.x - b.a.x;
	const by = b.b.y - b.a.y;
	const lenA = Math.hypot(ax, ay);
	const lenB = Math.hypot(bx, by);
	if (lenA <= EPS || lenB <= EPS)
		return undefined;
	const lineTol = TOUCH_TOLERANCE;
	if (Math.abs(cross(ax / lenA, ay / lenA, bx / lenB, by / lenB)) > 1e-7)
		return undefined;
	const perpendicularDistance = (point: Point) => Math.abs(cross(point.x - a.a.x, point.y - a.a.y, ax / lenA, ay / lenA));
	if (perpendicularDistance(b.a) > lineTol || perpendicularDistance(b.b) > lineTol)
		return undefined;
	const ux = ax / lenA;
	const uy = ay / lenA;
	const p0 = dot(b.a.x - a.a.x, b.a.y - a.a.y, ux, uy);
	const p1 = dot(b.b.x - a.a.x, b.b.y - a.a.y, ux, uy);
	const lo = Math.max(0, Math.min(p0, p1));
	const hi = Math.min(lenA, Math.max(p0, p1));
	if (hi - lo < 0.5)
		return undefined;
	const start = { x: a.a.x + ux * lo, y: a.a.y + uy * lo };
	const end = { x: a.a.x + ux * hi, y: a.a.y + uy * hi };
	const sameEndpoints = (pointDistance(a.a, b.a) <= TOUCH_TOLERANCE && pointDistance(a.b, b.b) <= TOUCH_TOLERANCE)
		|| (pointDistance(a.a, b.b) <= TOUCH_TOLERANCE && pointDistance(a.b, b.a) <= TOUCH_TOLERANCE);
	return { kind: sameEndpoints ? 'exact-duplicate' : 'partial-collinear-overlap', start, end, overlapLength: hi - lo };
}

function createNode(kind: NodeKind, id: string, net: string, layers: number[], bounds: Bounds, props: Partial<GraphNode> = {}): GraphNode {
	return { key: `${kind}:${id}`, kind, id, net, layers, bounds, anchor: kind === 'pad' || kind === 'copper', ...props };
}
/** Build potential-contact pairs with an x-sweep; only overlapping AABBs reach exact geometry tests. */
function sweepPairs(entries: Array<{ nodeIndex: number; layer: number; bounds: Bounds }>): Array<[number, number, number]> {
	const grouped = new Map<number, typeof entries>();
	for (const item of entries) {
		const list = grouped.get(item.layer) ?? [];
		list.push(item);
		grouped.set(item.layer, list);
	}
	const pairs = new Map<string, [number, number, number]>();
	for (const [layer, list] of grouped) {
		list.sort((a, b) => a.bounds.minX - b.bounds.minX);
		let active: typeof list = [];
		for (const current of list) {
			active = active.filter(item => item.bounds.maxX + TOUCH_TOLERANCE >= current.bounds.minX);
			for (const prior of active) {
				if (prior.nodeIndex !== current.nodeIndex && boundsOverlap(prior.bounds, current.bounds)) {
					const lo = Math.min(prior.nodeIndex, current.nodeIndex);
					const hi = Math.max(prior.nodeIndex, current.nodeIndex);
					pairs.set(`${layer}:${lo}:${hi}`, [layer, lo, hi]);
				}
			}
			active.push(current);
		}
	}
	return [...pairs.values()];
}

function findBridges(adjacency: Array<Set<number>>): Array<[number, number]> {
	const discovered = Array.from({ length: adjacency.length }).fill(-1) as number[];
	const low = Array.from({ length: adjacency.length }).fill(-1) as number[];
	const bridges: Array<[number, number]> = [];
	let time = 0;
	const visit = (u: number, parent: number) => {
		discovered[u] = low[u] = time++;
		for (const v of adjacency[u]) {
			if (v === parent)
				continue;
			if (discovered[v] < 0) {
				visit(v, u);
				low[u] = Math.min(low[u], low[v]);
				if (low[v] > discovered[u])
					bridges.push([u, v]);
			}
			else {
				low[u] = Math.min(low[u], discovered[v]);
			}
		}
	};
	for (let i = 0; i < adjacency.length; i++) {
		if (adjacency[i].size && discovered[i] < 0)
			visit(i, -1);
	}
	return bridges;
}

export function analyzeRoutingRemnants(input: { tracks: ScanTrack[]; vias: ScanVia[]; pads: ScanPad[]; copper: ScanCopper[]; issues: ScanIssue[] }): RoutingRemnantAnalysis {
	const issues = [...(input.issues ?? [])];
	const candidates: RemnantCandidate[] = [];
	const unsupportedArcIds: string[] = [];
	const unknownViaSpanIds: string[] = [];
	const approximatePadIds: string[] = [];
	const nodes: GraphNode[] = [];
	const trackNode = new Map<ScanTrack, number>();
	const viaNode = new Map<ScanVia, number>();
	const copperNode = new Map<ScanCopper, number>();
	const blockedNetLayers = new Set<string>();
	const bad = (obj: { id: string; net: string }, why: string, layer?: number) => issues.push({ code: 'invalid-geometry', message: why, net: obj.net, layer, objectId: obj.id });
	const add = (node: GraphNode) => {
		const index = nodes.length;
		nodes.push(node);
		return index;
	};

	for (const track of input.tracks ?? []) {
		if (![track.layer, track.width, track.a?.x, track.a?.y, track.b?.x, track.b?.y].every(finite) || (track.width <= 0 || !track.net)) {
			bad(track, '导线缺少有效网络、图层、宽度或端点；未用于连通判断。', track.layer);
			blockedNetLayers.add(netLayerKey(track.net, track.layer));
			continue;
		}
		if (track.arc !== undefined && Math.abs(track.arc) > EPS) {
			unsupportedArcIds.push(track.id);
			blockedNetLayers.add(netLayerKey(track.net, track.layer));
			issues.push({ code: 'arc-geometry-incomplete', message: '弧线只有角度字段，缺少经过验证的圆心/方向语义；该网络图层不生成悬支结论。', net: track.net, layer: track.layer, objectId: track.id });
		}
		const index = add(createNode('track', track.id, track.net, [track.layer], segmentBounds(track.a, track.b, track.width / 2), { track, anchor: false }));
		trackNode.set(track, index);
	}
	for (const via of input.vias ?? []) {
		if (![via.x, via.y, via.diameter, via.hole].every(finite) || via.diameter <= 0 || via.hole < 0 || !via.net) {
			bad(via, '过孔缺少有效网络、坐标或尺寸；未用于连通判断。');
			continue;
		}
		if (!Array.isArray(via.layers) || via.layers.length === 0 || via.layers.some(layer => !finite(layer))) {
			unknownViaSpanIds.push(via.id);
			issues.push({ code: 'via-span-unknown', message: '过孔层跨度未知；不推断它连接了哪些铜层，也不生成清理候选。', net: via.net, objectId: via.id });
			continue;
		}
		const layers = [...new Set(via.layers)];
		const index = add(createNode('via', via.id, via.net, layers, pointBounds({ x: via.x, y: via.y }, via.diameter / 2), { via, anchor: false }));
		viaNode.set(via, index);
	}
	for (const pad of input.pads ?? []) {
		if (![pad.x, pad.y, pad.radius].every(finite) || pad.radius < 0 || !pad.net || !Array.isArray(pad.layers) || !pad.layers.length) {
			bad(pad, '焊盘缺少有效网络、坐标、保护半径或铜层；未用于连通判断.');
			continue;
		}
		const layers = [...new Set(pad.layers.filter(finite))];
		if (!layers.length) {
			bad(pad, '焊盘铜层列表无效。');
			continue;
		}
		add(createNode('pad', pad.id, pad.net, layers, pointBounds({ x: pad.x, y: pad.y }, pad.radius), { pad, anchor: !pad.approximate }));
		if (pad.approximate)
			approximatePadIds.push(pad.id);
	}
	for (const copper of input.copper ?? []) {
		const valid = !!copper.net && finite(copper.layer) && Array.isArray(copper.rings) && copper.rings.length > 0
			&& copper.rings.every(ring => ring.length >= 2 && ring.every(p => finite(p.x) && finite(p.y)))
			&& (copper.rings.some(ring => ring.length >= 3) || (finite(copper.stroke ?? 0) && (copper.stroke ?? 0) > 0))
			&& (copper.stroke === undefined || (finite(copper.stroke) && copper.stroke >= 0));
		if (!valid) {
			bad(copper, '铜形轮廓无效或为空；未用于连通判断。', copper.layer);
			blockedNetLayers.add(netLayerKey(copper.net, copper.layer));
			continue;
		}
		const index = add(createNode('copper', copper.id, copper.net, [copper.layer], polygonBounds(copper.rings, (copper.stroke ?? 0) / 2), { copper }));
		copperNode.set(copper, index);
	}

	const entries: Array<{ nodeIndex: number; layer: number; bounds: Bounds }> = [];
	nodes.forEach((node, nodeIndex) => node.layers.forEach(layer => entries.push({ nodeIndex, layer, bounds: node.bounds })));
	const pairs = sweepPairs(entries);
	const adjacency = nodes.map(() => new Set<number>());
	const connect = (a: number, b: number) => {
		if (a === b || adjacency[a].has(b))
			return;
		adjacency[a].add(b);
		adjacency[b].add(a);
	};
	const uncertainApproximate = new Set<number>();
	for (const [_layer, i, j] of pairs) {
		const a = nodes[i];
		const b = nodes[j];
		if (a.net !== b.net)
			continue;
		let touches = false;
		if (a.kind === 'track' && b.kind === 'track') {
			touches = trackContact(a.track!, b.track!);
			if (touches) {
				const overlap = collinearOverlap(a.track!, b.track!);
				if (overlap) {
					const exact = overlap.kind === 'exact-duplicate';
					candidates.push({ kind: 'collinear-overlap', net: a.net, layer: _layer, objectIds: [a.id, b.id], position: { x: (overlap.start.x + overlap.end.x) / 2, y: (overlap.start.y + overlap.end.y) / 2 }, requiresHumanReview: true, evidence: [`${exact ? '端点完全重合' : '同层共线部分覆合'}，重合长度约 ${overlap.overlapLength.toFixed(3)} mil。`, `两线宽度 ${a.track!.width}/${b.track!.width} mil。`], protectionNotes: ['重叠可能用于加宽、并联载流或工艺补强；不得仅凭重叠删除。', ...(a.track!.locked || b.track!.locked ? ['至少一段被锁定，先确认锁定用途。'] : [])], classification: overlap.kind });
				}
			}
		}
		else if (a.kind === 'track' && b.kind === 'via') {
			touches = trackViaContact(a.track!, b.via!);
		}
		else if (a.kind === 'via' && b.kind === 'track') {
			touches = trackViaContact(b.track!, a.via!);
		}
		else if (a.kind === 'track' && b.kind === 'pad') {
			const near = trackPadContact(a.track!, b.pad!);
			touches = near && !b.pad!.approximate;
			if (near && b.pad!.approximate)
				uncertainApproximate.add(i);
		}
		else if (a.kind === 'pad' && b.kind === 'track') {
			const near = trackPadContact(b.track!, a.pad!);
			touches = near && !a.pad!.approximate;
			if (near && a.pad!.approximate)
				uncertainApproximate.add(j);
		}
		else if (a.kind === 'track' && b.kind === 'copper') {
			touches = trackCopperContact(a.track!, b.copper!);
		}
		else if (a.kind === 'copper' && b.kind === 'track') {
			touches = trackCopperContact(b.track!, a.copper!);
		}
		else if (a.kind === 'via' && b.kind === 'via') {
			touches = viaViaContact(a.via!, b.via!);
		}
		else if (a.kind === 'via' && b.kind === 'pad') {
			const near = viaPadContact(a.via!, b.pad!);
			touches = near && !b.pad!.approximate;
			if (near && b.pad!.approximate)
				uncertainApproximate.add(i);
		}
		else if (a.kind === 'pad' && b.kind === 'via') {
			const near = viaPadContact(b.via!, a.pad!);
			touches = near && !a.pad!.approximate;
			if (near && a.pad!.approximate)
				uncertainApproximate.add(j);
		}
		else if (a.kind === 'via' && b.kind === 'copper') {
			touches = viaCopperContact(a.via!, b.copper!);
		}
		else if (a.kind === 'copper' && b.kind === 'via') {
			touches = viaCopperContact(b.via!, a.copper!);
		}
		else if (a.kind === 'pad' && b.kind === 'copper') {
			touches = !a.pad!.approximate && pointCopperContact({ x: a.pad!.x, y: a.pad!.y }, b.copper!, a.pad!.radius);
		}
		else if (a.kind === 'copper' && b.kind === 'pad') {
			touches = !b.pad!.approximate && pointCopperContact({ x: b.pad!.x, y: b.pad!.y }, a.copper!, b.pad!.radius);
		}
		else if (a.kind === 'copper' && b.kind === 'copper') {
			touches = copperCopperTouch(a.copper!, b.copper!);
		}
		if (touches)
			connect(i, j);
	}

	// Find copper islands first, then inspect route-only groups. Keeping fill nodes
	// out of the route graph prevents several traces touching one continuous fill
	// from being split into artificial bridge tails.
	const copperIslandByNode = new Map<number, string>();
	const seenCopper = new Set<number>();
	for (const [copper, start] of copperNode) {
		if (seenCopper.has(start))
			continue;
		const islandNodes: number[] = [];
		const stack = [start];
		seenCopper.add(start);
		while (stack.length) {
			const current = stack.pop()!;
			islandNodes.push(current);
			for (const next of adjacency[current]) {
				if (nodes[next].kind === 'copper' && !seenCopper.has(next)) {
					seenCopper.add(next);
					stack.push(next);
				}
			}
		}
		const islandId = islandNodes.map(i => nodes[i].id).sort()[0] ?? copper.id;
		for (const nodeIndex of islandNodes)
			copperIslandByNode.set(nodeIndex, islandId);
	}
	const routeNodeIndexes = nodes.map((node, index) => ({ node, index })).filter(item => item.node.kind === 'track' || item.node.kind === 'via').map(item => item.index);
	const routeAdjacency = nodes.map(() => new Set<number>());
	for (const index of routeNodeIndexes) {
		for (const neighbor of adjacency[index]) {
			if (nodes[neighbor].kind === 'track' || nodes[neighbor].kind === 'via')
				routeAdjacency[index].add(neighbor);
		}
	}
	const freeEndpointLocations = (group: Set<number>): Point[] => {
		const points: Point[] = [];
		for (const index of group) {
			const node = nodes[index];
			if (node.kind !== 'track')
				continue;
			for (const endpoint of [node.track!.a, node.track!.b]) {
				let connected = false;
				for (const neighborIndex of adjacency[index]) {
					const neighbor = nodes[neighborIndex];
					if (neighbor.kind === 'track' && pointSegmentDistance(endpoint, neighbor.track!.a, neighbor.track!.b) <= (node.track!.width + neighbor.track!.width) / 2 + TOUCH_TOLERANCE)
						connected = true;
					if (neighbor.kind === 'via' && neighbor.via!.layers!.includes(node.track!.layer) && pointDistance(endpoint, { x: neighbor.via!.x, y: neighbor.via!.y }) <= (node.track!.width + neighbor.via!.diameter) / 2 + TOUCH_TOLERANCE)
						connected = true;
					if (neighbor.kind === 'pad' && !neighbor.pad!.approximate && neighbor.pad!.layers.includes(node.track!.layer) && pointDistance(endpoint, { x: neighbor.pad!.x, y: neighbor.pad!.y }) <= node.track!.width / 2 + neighbor.pad!.radius + TOUCH_TOLERANCE)
						connected = true;
					if (neighbor.kind === 'copper' && pointCopperContact(endpoint, neighbor.copper!, node.track!.width / 2))
						connected = true;
				}
				if (!connected && !points.some(point => pointDistance(point, endpoint) <= TOUCH_TOLERANCE))
					points.push(endpoint);
			}
		}
		return points;
	};
	const visitedRoute = new Set<number>();
	for (const start of routeNodeIndexes) {
		if (visitedRoute.has(start))
			continue;
		const group = new Set<number>([start]);
		const stack = [start];
		visitedRoute.add(start);
		while (stack.length) {
			const current = stack.pop()!;
			for (const next of adjacency[current]) {
				if ((nodes[next].kind === 'track' || nodes[next].kind === 'via') && !visitedRoute.has(next)) {
					visitedRoute.add(next);
					group.add(next);
					stack.push(next);
				}
			}
		}
		const members = [...group].map(i => nodes[i]);
		if (members.some(node => node.kind === 'track' && blockedNetLayers.has(`${node.net}:${node.layers[0]}`)) || [...group].some(i => uncertainApproximate.has(i)))
			continue;
		const padContacts = new Set<string>();
		const copperIslands = new Set<string>();
		const copperContacts = new Map<string, Set<string>>();
		for (const index of group) {
			for (const neighborIndex of adjacency[index]) {
				const neighbor = nodes[neighborIndex];
				if (neighbor.kind === 'pad')
					padContacts.add(neighbor.id);
				if (neighbor.kind === 'copper') {
					const islandId = copperIslandByNode.get(neighborIndex)!;
					copperIslands.add(islandId);
					const ids = copperContacts.get(islandId) ?? new Set<string>();
					ids.add(neighbor.id);
					copperContacts.set(islandId, ids);
				}
			}
		}
		if (padContacts.size || copperIslands.size !== 1)
			continue;
		const routeIds = members.filter(node => node.kind === 'track' || node.kind === 'via').map(node => node.id).sort();
		const freeEnds = freeEndpointLocations(group);
		const fillIds = [...(copperContacts.values().next().value as Set<string> | undefined ?? [])].sort();
		const hasMultipleFillContacts = fillIds.length > 1;
		if (!freeEnds.length && !hasMultipleFillContacts)
			continue;
		const box = mergedBounds(members.map(node => node.bounds));
		const net = members[0].net;
		const fillEdgeCount = [...group].reduce((count, index) => count + [...adjacency[index]].filter(neighbor => nodes[neighbor].kind === 'copper' && copperIslandByNode.get(neighbor) === [...copperIslands][0]).length, 0);
		candidates.push({ kind: 'single-attachment-branch', net, layer: members.length === 1 && members[0].layers.length === 1 ? members[0].layers[0] : undefined, objectIds: routeIds, position: boundsCenter(box), locations: freeEnds, requiresHumanReview: true, evidence: [`线/孔自身连成 ${members.length} 个对象的一组；在组外只接触一个连续实铜岛（${fillIds.join(', ')}），接入几何边 ${fillEdgeCount} 处。`, `可能的裸端坐标：${freeEnds.map(point => `(${point.x.toFixed(3)}, ${point.y.toFixed(3)})`).join('; ') || '无'}。`], protectionNotes: ['该组没有精确焊盘接触，但仍可能是并联载流、回流、散热或功能预留，必须人工核对后处理。', ...(members.some(node => node.track?.locked || node.via?.locked) ? ['候选组含锁定对象。'] : [])] });
	}
	const routeBranchCandidates: RemnantCandidate[] = [];
	for (const [bridgeA, bridgeB] of findBridges(routeAdjacency)) {
		const side = (start: number) => {
			const group = new Set<number>([start]);
			const stack = [start];
			while (stack.length) {
				const current = stack.pop()!;
				for (const next of routeAdjacency[current]) {
					if ((current === bridgeA && next === bridgeB) || (current === bridgeB && next === bridgeA) || group.has(next))
						continue;
					group.add(next);
					stack.push(next);
				}
			}
			return group;
		};
		const sides = [side(bridgeA), side(bridgeB)];
		for (const [sideIndex, group] of sides.entries()) {
			const external = sides[1 - sideIndex];
			const members = [...group].map(index => nodes[index]);
			const externalMembers = [...external].map(index => nodes[index]);
			if (!externalMembers.length || [...group].some(index => uncertainApproximate.has(index)) || members.some(node => node.kind === 'track' && blockedNetLayers.has(`${node.net}:${node.layers[0]}`)))
				continue;
			const padIds = new Set<string>();
			const candidateIslands = new Set<string>();
			const externalIslands = new Set<string>();
			const fillIds = new Set<string>();
			for (const index of group) {
				for (const neighbor of adjacency[index]) {
					if (nodes[neighbor].kind === 'pad')
						padIds.add(nodes[neighbor].id);
					if (nodes[neighbor].kind === 'copper') {
						candidateIslands.add(copperIslandByNode.get(neighbor)!);
						fillIds.add(nodes[neighbor].id);
					}
				}
			}
			for (const index of external) {
				for (const neighbor of adjacency[index]) {
					if (nodes[neighbor].kind === 'copper')
						externalIslands.add(copperIslandByNode.get(neighbor)!);
				}
			}
			if (padIds.size || candidateIslands.size !== 1 || ![...candidateIslands].some(island => externalIslands.has(island)))
				continue;
			const freeEnds = freeEndpointLocations(group);
			if (!freeEnds.length)
				continue;
			const objectIds = members.map(node => node.id).sort();
			const box = mergedBounds(members.map(node => node.bounds));
			routeBranchCandidates.push({ kind: 'single-attachment-branch', net: members[0].net, layer: members.length === 1 && members[0].layers.length === 1 ? members[0].layers[0] : undefined, objectIds, position: boundsCenter(box), locations: freeEnds, requiresHumanReview: true, evidence: [`去掉铜面后，这组线/孔通过一条路由桥边接到其余网络；桥两侧又接到同一实铜岛（${[...fillIds].sort().join(', ')}），因此铜面会掩盖该悬支。`, `候选组 ${objectIds.join(', ')}；裸端坐标：${freeEnds.map(point => `(${point.x.toFixed(3)}, ${point.y.toFixed(3)})`).join('; ') || '无'}。`], protectionNotes: ['候选侧没有焊盘接触或其他铜岛；多点/并联接入仍可能承担载流或回流，需对照改版前后工程与电气用途后再决定。', ...(members.some(node => node.track?.locked || node.via?.locked) ? ['候选组含锁定对象。'] : [])] });
		}
	}
	for (const candidate of routeBranchCandidates.sort((a, b) => b.objectIds.length - a.objectIds.length)) {
		if (!candidates.some(existing => existing.kind === 'single-attachment-branch' && existing.net === candidate.net && candidate.objectIds.every(id => existing.objectIds.includes(id))))
			candidates.push(candidate);
	}

	const viaConnectivity: RoutingRemnantAnalysis['viaConnectivity'] = [];
	for (const [via, index] of viaNode) {
		const byLayer = new Map<number, { tracks: Set<string>; copper: Set<string>; pads: Set<string> }>();
		for (const layer of via.layers!) byLayer.set(layer, { tracks: new Set(), copper: new Set(), pads: new Set() });
		for (const neighborIndex of adjacency[index]) {
			const neighbor = nodes[neighborIndex];
			for (const layer of neighbor.layers.filter(l => via.layers!.includes(l))) {
				const item = byLayer.get(layer)!;
				if (neighbor.kind === 'track')
					item.tracks.add(neighbor.id);
				if (neighbor.kind === 'copper')
					item.copper.add(neighbor.id);
				if (neighbor.kind === 'pad' && !neighbor.pad!.approximate)
					item.pads.add(neighbor.id);
			}
		}
		const contactsByLayer = [...byLayer].map(([layer, c]) => ({ layer, tracks: [...c.tracks].sort(), copper: [...c.copper].sort(), pads: [...c.pads].sort() }));
		const touchedLayers = contactsByLayer.filter(c => c.tracks.length || c.copper.length || c.pads.length).length;
		let classification: RemnantCandidate['classification'];
		if (!touchedLayers)
			classification = 'isolated';
		else if (touchedLayers === 1)
			classification = via.layers!.length === 1 ? 'layer-connected' : 'one-layer-only';
		else if (touchedLayers < via.layers!.length)
			classification = 'partial-layer-contact';
		else classification = 'layer-connected';
		viaConnectivity.push({ id: via.id, net: via.net, x: via.x, y: via.y, layers: [...via.layers!], contactsByLayer, classification });
		if (classification === 'isolated' || classification === 'one-layer-only') {
			const viaEvidence = classification === 'isolated'
				? '已知层跨度内，未找到同网导线、实铜或精确焊盘几何接触。'
				: `已知 ${via.layers?.length ?? 0} 个铜层中，仅 ${touchedLayers} 层检测到同网几何接触。`;
			const protectionNotes = ['过孔可能用于缝合、散热、屏蔽或多层电源连接，不能默认删除。', '附近对象的网名、几何接触和宿主电气连通语义仍需人工核对。'];
			if (via.locked)
				protectionNotes.push('过孔已锁定。');
			candidates.push({
				kind: 'via-connectivity',
				net: via.net,
				objectIds: [via.id],
				position: { x: via.x, y: via.y },
				requiresHumanReview: true,
				classification,
				evidence: [viaEvidence, `孔径 ${via.hole} mil，外径 ${via.diameter} mil。`],
				contactsByLayer,
				protectionNotes,
			});
		}
	}

	const layerTracks = new Map<string, Set<number>>();
	const layerComponents = new Map<string, number>();
	const visited = new Set<number>();
	for (const [track, index] of trackNode) {
		const layer = track.layer;
		const key = `${track.net}:${layer}`;
		const set = layerTracks.get(key) ?? new Set<number>(); set.add(index); layerTracks.set(key, set);
		if (visited.has(index))
			continue;
		const stack = [index]; visited.add(index);
		while (stack.length) {
			const n = stack.pop()!;
			for (const next of adjacency[n]) {
				if (!visited.has(next) && nodes[next].net === track.net && nodes[next].layers.includes(layer)) { visited.add(next); stack.push(next); }
			}
		}
		layerComponents.set(key, (layerComponents.get(key) ?? 0) + 1);
	}
	const connectivity = [...layerTracks].map(([key, tracks]) => {
		const [net, rawLayer] = key.split(':');
		return { net, layer: Number(rawLayer), trackCount: tracks.size, componentCount: layerComponents.get(key) ?? 0, knownGeometry: !blockedNetLayers.has(key) };
	});

	// Avoid duplicate pair reports from multiple overlapping sweep buckets.
	const uniqueCandidates = new Map<string, RemnantCandidate>();
	for (const candidate of candidates) {
		const key = `${candidate.kind}:${candidate.net}:${candidate.layer ?? '*'}:${candidate.objectIds.slice().sort().join(',')}:${candidate.classification ?? ''}`;
		if (!uniqueCandidates.has(key))
			uniqueCandidates.set(key, candidate);
	}
	return {
		candidates: [...uniqueCandidates.values()].sort((a, b) => a.net.localeCompare(b.net) || (a.layer ?? 0) - (b.layer ?? 0) || a.kind.localeCompare(b.kind) || a.objectIds.join(',').localeCompare(b.objectIds.join(','))),
		viaConnectivity,
		issues,
		connectivity: connectivity.sort((a, b) => a.net.localeCompare(b.net) || a.layer - b.layer),
		coverage: { trackCount: input.tracks.length, viaCount: input.vias.length, padCount: input.pads.length, copperCount: input.copper.length, unsupportedArcIds, unknownViaSpanIds, approximatePadIds },
	};
}
