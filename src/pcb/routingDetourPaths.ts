/**
 * Read-only centerline path reconstruction for routed PCB tracks.
 * All coordinates and lengths are in mil. Copper fills are intentionally not
 * used to infer a route: a plane can connect branches without exposing a
 * unique centerline path.
 */
import type { Point, ScanCopper, ScanPad, ScanTrack, ScanVia } from './routingRemnantAnalysis';

export interface RoutingPathVertex extends Point {
	layer: number;
	trackIds: string[];
	viaIds: string[];
	padIds: string[];
}

export interface RoutingPathSegment {
	kind: 'track' | 'via';
	id: string;
	from: RoutingPathVertex;
	to: RoutingPathVertex;
	lengthMil: number;
	arc?: boolean;
}

export interface RoutingPathTurn {
	position: RoutingPathVertex;
	angleDegrees: number;
	classification: 'turn' | 'reversal';
	trackIds: string[];
}

export interface RoutingPath {
	id: string;
	net: string;
	trackIds: string[];
	viaIds: string[];
	start: RoutingPathVertex;
	end: RoutingPathVertex;
	vertices: RoutingPathVertex[];
	segments: RoutingPathSegment[];
	lengthMil: number;
	turnCount: number;
	turns: RoutingPathTurn[];
	reversals: RoutingPathTurn[];
	viaCount: number;
	layerSwitchCount: number;
	status: 'traceable' | 'branch-split' | 'ambiguous' | 'closed-loop' | 'unsupported-arc';
	improvability: 'review-required' | 'do-not-suggest';
	constraints: string[];
}

export interface RoutingPathIssue {
	code: string;
	message: string;
	objectIds: string[];
	position?: Point;
	net?: string;
	layers?: number[];
}

export interface RoutingPathAnalysis {
	paths: RoutingPath[];
	issues: RoutingPathIssue[];
	coverage: {
		trackCount: number;
		viaCount: number;
		padCount: number;
		copperCount: number;
		includedTrackIds: string[];
		excludedTrackIds: string[];
		unsupportedArcIds: string[];
		unknownViaSpanIds: string[];
		approximatePadIds: string[];
		copperUsedForConnectivity: false;
	};
}

interface TrackAtom { kind: 'track'; id: string; track: ScanTrack; a: Point; b: Point; from: string; to: string; length: number }
interface ViaAtom { kind: 'via'; id: string; via: ScanVia; from: string; to: string }
type Edge = TrackAtom | ViaAtom;
interface Node { key: string; net: string; layer: number; p: Point; edges: Edge[]; vias: Set<string>; pads: Set<string>; ambiguous: boolean; branched: boolean }
interface Breakpoint { t: number; p: Point }

const EPS = 1e-7;
const NODE_TOL = 0.02; // only coalesces floating-point noise, in mil.
const LINE_CONTACT_TOL = 0.02;
const TURN_EPS_DEGREES = 1;
const REVERSAL_DEGREES = 150;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const dot = (ax: number, ay: number, bx: number, by: number) => ax * bx + ay * by;
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const pointKey = (net: string, layer: number, p: Point) => JSON.stringify([net, layer, Math.round(p.x / NODE_TOL), Math.round(p.y / NODE_TOL)]);

function projection(p: Point, a: Point, b: Point): { t: number; p: Point; distance: number } {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const den = dx * dx + dy * dy;
	const t = den <= EPS ? 0 : Math.max(0, Math.min(1, dot(p.x - a.x, p.y - a.y, dx, dy) / den));
	const q = { x: a.x + t * dx, y: a.y + t * dy };
	return { t, p: q, distance: distance(p, q) };
}

function exactCenterlineIntersection(a: ScanTrack, b: ScanTrack): { points: Point[]; overlap: boolean } {
	const rx = a.b.x - a.a.x;
	const ry = a.b.y - a.a.y;
	const sx = b.b.x - b.a.x;
	const sy = b.b.y - b.a.y;
	const qx = b.a.x - a.a.x;
	const qy = b.a.y - a.a.y;
	const den = cross(rx, ry, sx, sy);
	if (Math.abs(den) <= EPS * Math.max(1, Math.hypot(rx, ry) * Math.hypot(sx, sy))) {
		if (Math.abs(cross(qx, qy, rx, ry)) > LINE_CONTACT_TOL * Math.max(1, Math.hypot(rx, ry)))
			return { points: [], overlap: false };
		const len2 = dot(rx, ry, rx, ry);
		if (len2 <= EPS)
			return { points: [], overlap: false };
		const t0 = dot(b.a.x - a.a.x, b.a.y - a.a.y, rx, ry) / len2;
		const t1 = dot(b.b.x - a.a.x, b.b.y - a.a.y, rx, ry) / len2;
		const lo = Math.max(0, Math.min(t0, t1));
		const hi = Math.min(1, Math.max(t0, t1));
		if (hi < lo - EPS)
			return { points: [], overlap: false };
		if (hi - lo > NODE_TOL / Math.max(1, Math.sqrt(len2)))
			return { points: [], overlap: true };
		const t = (lo + hi) / 2;
		return { points: [{ x: a.a.x + rx * t, y: a.a.y + ry * t }], overlap: false };
	}
	const t = cross(qx, qy, sx, sy) / den;
	const u = cross(qx, qy, rx, ry) / den;
	if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS)
		return { points: [], overlap: false };
	const tc = Math.max(0, Math.min(1, t));
	return { points: [{ x: a.a.x + rx * tc, y: a.a.y + ry * tc }], overlap: false };
}

function trackLength(track: ScanTrack): number {
	const chord = distance(track.a, track.b);
	if (!track.arc || !Number.isFinite(track.arc))
		return chord;
	const radians = Math.abs(track.arc) * Math.PI / 180;
	if (radians <= EPS || radians >= 2 * Math.PI - EPS)
		return chord;
	const denom = 2 * Math.sin(radians / 2);
	return Math.abs(denom) <= EPS ? chord : chord * radians / denom;
}

function turnAngle(previous: TrackAtom, next: TrackAtom, at: Point): number | undefined {
	if (previous.track.arc || next.track.arc)
		return undefined;
	const prevFrom = distance(previous.a, at) <= NODE_TOL ? previous.b : previous.a;
	const nextTo = distance(next.a, at) <= NODE_TOL ? next.b : next.a;
	const ax = at.x - prevFrom.x;
	const ay = at.y - prevFrom.y;
	const bx = nextTo.x - at.x;
	const by = nextTo.y - at.y;
	const la = Math.hypot(ax, ay);
	const lb = Math.hypot(bx, by);
	if (la <= EPS || lb <= EPS)
		return undefined;
	return Math.acos(Math.max(-1, Math.min(1, dot(ax, ay, bx, by) / (la * lb)))) * 180 / Math.PI;
}

/** Reconstruct uniquely traceable centerline runs. It never edits the PCB. */
export function buildRoutingPaths(input: { tracks: ScanTrack[]; vias: ScanVia[]; pads: ScanPad[]; copper: ScanCopper[] }): RoutingPathAnalysis {
	const issues: RoutingPathIssue[] = [];
	const tracks = input.tracks.filter(track => [track.a.x, track.a.y, track.b.x, track.b.y, track.width].every(Number.isFinite) && track.width > 0 && distance(track.a, track.b) > NODE_TOL);
	const excludedTrackIds = input.tracks.filter(track => !tracks.includes(track)).map(track => track.id);
	const ambiguousTrackIds = new Set<string>();	
	for (const track of input.tracks.filter(track => excludedTrackIds.includes(track.id)))
		issues.push({ code: 'invalid-track-geometry', message: '导线坐标或线宽无效，未纳入路径统计。', objectIds: [track.id], net: track.net, layers: [track.layer] });

	const breaks = new Map<ScanTrack, Breakpoint[]>();
	for (const track of tracks)
		breaks.set(track, [{ t: 0, p: track.a }, { t: 1, p: track.b }]);

	// Split only where centerlines meet; width-only contact is reported but not
	// converted into an invented route vertex.
	for (let i = 0; i < tracks.length; i++) {
		const a = tracks[i];
		for (let j = i + 1; j < tracks.length; j++) {
			const b = tracks[j];
			if (a.net !== b.net || a.layer !== b.layer)
				continue;
			if (a.arc || b.arc) {
				const endpointPairs: Array<[Point, ScanTrack]> = [];
				for (const point of [a.a, a.b]) if (projection(point, b.a, b.b).distance <= NODE_TOL) endpointPairs.push([point, b]);
				for (const point of [b.a, b.b]) if (projection(point, a.a, a.b).distance <= NODE_TOL) endpointPairs.push([point, a]);
				for (const [point, track] of endpointPairs) breaks.get(track)!.push({ t: projection(point, track.a, track.b).t, p: projection(point, track.a, track.b).p });
				continue;
			}
			const intersection = exactCenterlineIntersection(a, b);
			if (intersection.overlap) {
				ambiguousTrackIds.add(a.id);
				ambiguousTrackIds.add(b.id);
				issues.push({ code: 'collinear-centerline-overlap', message: '同网同层线段存在中心线重叠，无法唯一确定路径顺序。', objectIds: [a.id, b.id], net: a.net, layers: [a.layer] });
				continue;
			}
			if (intersection.points.length) {
				const p = intersection.points[0];
				for (const track of [a, b]) {
					const at = projection(p, track.a, track.b);
					breaks.get(track)!.push({ t: at.t, p: at.p });
				}
				continue;
			}
			const ab = projection(a.a, b.a, b.b).distance;
			const ae = projection(a.b, b.a, b.b).distance;
			const ba = projection(b.a, a.a, a.b).distance;
			const be = projection(b.b, a.a, a.b).distance;
			if (Math.min(ab, ae, ba, be) <= (a.width + b.width) / 2 + LINE_CONTACT_TOL) {
				ambiguousTrackIds.add(a.id);
				ambiguousTrackIds.add(b.id);
				issues.push({ code: 'non-centerline-track-contact', message: '线宽范围可能相接但中心线不相交；路径不跨接此处，需人工核对真实铜形。', objectIds: [a.id, b.id], net: a.net, layers: [a.layer] });
			}
		}
	}
	// Put only centerline vias into the split list. Width-only contacts remain
	// explicit uncertainty and are never used as a fabricated path vertex.
	for (const via of input.vias) {
		for (const track of tracks) {
			if (track.net !== via.net || (via.layers && !via.layers.includes(track.layer)))
				continue;
			const hit = projection(via, track.a, track.b);
			if (hit.distance <= NODE_TOL)
				breaks.get(track)!.push({ t: hit.t, p: hit.p });
			else if (hit.distance <= (track.width + via.diameter) / 2 + LINE_CONTACT_TOL) {
				ambiguousTrackIds.add(track.id);
				issues.push({ code: via.layers ? 'off-centerline-via-contact' : 'unknown-via-span', message: via.layers
					? '过孔盘与线宽范围可能相接，但没有落在线路中心线上；不作为唯一路径节点。'
					: '附近过孔的层跨度未知，不推断跨层连接。', objectIds: [via.id, track.id], position: hit.p, net: via.net, layers: [track.layer] });
			}
		}
	}

	const trackNodeKeys = new Map<ScanTrack, string[]>();
	const nodes = new Map<string, Node>();
	const getNode = (net: string, layer: number, p: Point): Node => {
		const key = pointKey(net, layer, p);
		let node = nodes.get(key);
		if (!node) {
			node = { key, net, layer, p: { ...p }, edges: [], vias: new Set(), pads: new Set(), ambiguous: false, branched: false };
			nodes.set(key, node);
		}
		return node;
	};
	const trackAtoms: TrackAtom[] = [];
	for (const track of tracks) {
		const points = breaks.get(track)!.sort((a, b) => a.t - b.t).filter((item, index, all) => index === 0 || distance(item.p, all[index - 1].p) > NODE_TOL);
		const keys = points.map(item => getNode(track.net, track.layer, item.p).key);
		trackNodeKeys.set(track, keys);
		const chord = distance(track.a, track.b);
		for (let i = 1; i < points.length; i++) {
			const segmentLength = track.arc ? trackLength(track) * (points[i].t - points[i - 1].t) : chord * (points[i].t - points[i - 1].t);
			const atom: TrackAtom = { kind: 'track', id: track.id, track, a: points[i - 1].p, b: points[i].p, from: keys[i - 1], to: keys[i], length: segmentLength };
			trackAtoms.push(atom);
			nodes.get(atom.from)!.edges.push(atom);
			nodes.get(atom.to)!.edges.push(atom);
		}
	}

	const viasById = new Map(input.vias.map(via => [via.id, via]));
	const unknownViaSpanIds: string[] = [];
	const attachedViaIds = new Set<string>();
	const viaAtoms: ViaAtom[] = [];
	for (const via of input.vias) {
		if (!via.layers || via.layers.length < 2) {
			unknownViaSpanIds.push(via.id);
			const nearby = tracks.filter(track => track.net === via.net && trackNodeKeys.get(track)?.some(key => distance(nodes.get(key)!.p, via) <= (track.width + via.diameter) / 2 + LINE_CONTACT_TOL));
			for (const track of nearby) ambiguousTrackIds.add(track.id);
			if (nearby.length)
				issues.push({ code: 'unknown-via-span', message: '过孔层跨度未知，不能假定其跨层连接；相邻路径需人工复核。', objectIds: [via.id, ...nearby.map(track => track.id)], position: { x: via.x, y: via.y }, net: via.net });
			continue;
		}
		const layerNodes: Node[] = [];
		let centerlineContact = false;
		for (const layer of via.layers) {
			const exactNodes = [...nodes.values()].filter(node => node.net === via.net && node.layer === layer && distance(node.p, via) <= NODE_TOL);
			if (exactNodes.length) {
				layerNodes.push(...exactNodes);
				centerlineContact = true;
				for (const node of exactNodes) {
					node.vias.add(via.id);
					attachedViaIds.add(via.id);
				}
				continue;
			}
			const near = tracks.filter(track => track.net === via.net && track.layer === layer && trackNodeKeys.get(track)?.some(key => {
				const node = nodes.get(key)!;
				return projection(via, track.a, track.b).distance <= (track.width + via.diameter) / 2 + LINE_CONTACT_TOL
			}));
			if (near.length) {
				centerlineContact = true;
				for (const track of near) ambiguousTrackIds.add(track.id);
				issues.push({ code: 'off-centerline-via-contact', message: '过孔盘与线宽范围可能相接，但未落在可追踪的中心线路径节点上；不推断跨层路径。', objectIds: [via.id, ...near.map(track => track.id)], position: { x: via.x, y: via.y }, net: via.net, layers: [layer] });
			}
		}
		const uniqueNodes = [...new Map(layerNodes.map(node => [node.key, node])).values()];
		if (uniqueNodes.length >= 2) {
			for (let i = 0; i < uniqueNodes.length; i++) {
				for (let j = i + 1; j < uniqueNodes.length; j++) {
					const from = uniqueNodes[i];
					const to = uniqueNodes[j];
					const edge: ViaAtom = { kind: 'via', id: via.id, via, from: from.key, to: to.key };
					viaAtoms.push(edge);
					from.edges.push(edge);
					to.edges.push(edge);
				}
			}
			attachedViaIds.add(via.id);
		}
		else if (centerlineContact && uniqueNodes.length === 1)
			attachedViaIds.add(via.id);
	}

	// Pads only provide anchors when their centerline geometry is known. The
	// projected point remains on the route centerline and is split explicitly.
	const approximatePadIds = input.pads.filter(pad => pad.approximate).map(pad => pad.id);
	const padAttachments = new Map<ScanPad, Array<{ track: ScanTrack; t: number; p: Point }>>();
	for (const pad of input.pads) {
		for (const track of tracks) {
			if (pad.net !== track.net || !pad.layers.includes(track.layer))
				continue;
			const hit = projection(pad, track.a, track.b);
			if (hit.distance > pad.radius + track.width / 2 + LINE_CONTACT_TOL)
				continue;
			if (pad.approximate) {
				ambiguousTrackIds.add(track.id);
				issues.push({ code: 'approximate-pad-anchor', message: '焊盘几何为近似值，不能作为精确路径端点。', objectIds: [pad.id, track.id], position: hit.p, net: pad.net, layers: [track.layer] });
				continue;
			}
			breaks.get(track)!.push({ t: hit.t, p: hit.p });
			const list = padAttachments.get(pad) ?? [];
			list.push({ track, t: hit.t, p: hit.p });
			padAttachments.set(pad, list);
		}
	}
	// A pad split may have been added after atomization. Add only the newly
	// requested split nodes by rebuilding the affected track atoms once.
	if ([...padAttachments.values()].some(list => list.length)) {
		for (const atom of trackAtoms) {
			const affected = [...padAttachments].some(([, list]) => list.some(item => item.track === atom.track));
			if (affected) {
				const nodeA = nodes.get(atom.from)!;
				const nodeB = nodes.get(atom.to)!;
				nodeA.edges = nodeA.edges.filter(edge => edge !== atom);
				nodeB.edges = nodeB.edges.filter(edge => edge !== atom);
			}
		}
		for (const track of tracks.filter(track => [...padAttachments.values()].some(list => list.some(item => item.track === track)))) {
			const all = breaks.get(track)!.sort((a, b) => a.t - b.t).filter((item, index, values) => index === 0 || distance(item.p, values[index - 1].p) > NODE_TOL);
			const chord = distance(track.a, track.b);
			for (let i = 1; i < all.length; i++) {
				const from = getNode(track.net, track.layer, all[i - 1].p);
				const to = getNode(track.net, track.layer, all[i].p);
				const atom: TrackAtom = { kind: 'track', id: track.id, track, a: all[i - 1].p, b: all[i].p, from: from.key, to: to.key, length: (track.arc ? trackLength(track) : chord) * (all[i].t - all[i - 1].t) };
				trackAtoms.push(atom);
				from.edges.push(atom);
				to.edges.push(atom);
			}
		}
	}
	for (const [pad, items] of padAttachments) {
		for (const item of items) {
			const node = getNode(pad.net, item.track.layer, item.p);
			node.pads.add(pad.id);
		}
	}

	for (const node of nodes.values()) {
		node.branched = node.edges.length > 2;
		if (node.branched)
			issues.push({ code: 'branch-junction', message: '路径在分支节点处分段；每条支路单独统计，不跨分支推断可缩短性。', objectIds: [...new Set(node.edges.map(edge => edge.id))], position: node.p, net: node.net, layers: [node.layer] });
	}

	const visited = new Set<Edge>();
	const paths: RoutingPath[] = [];
	const markAmbiguousNodes = () => {
		for (const atom of trackAtoms) {
			if (ambiguousTrackIds.has(atom.id)) {
				nodes.get(atom.from)!.ambiguous = true;
				nodes.get(atom.to)!.ambiguous = true;
			}
		}
	};
	markAmbiguousNodes();
	const endpoint = (node: Node, trackIds: string[]): RoutingPathVertex => ({ x: node.p.x, y: node.p.y, layer: node.layer, trackIds: [...new Set(trackIds)], viaIds: [...node.vias], padIds: [...node.pads] });
	const walk = (start: Node, first: Edge, closed = false) => {
		const routeEdges: Edge[] = [];
		let current = start;
		let edge: Edge | undefined = first;
		let guard = 0;
		while (edge && guard++ <= edgesCount + 1) {
			if (visited.has(edge))
				break;
			visited.add(edge);
			routeEdges.push(edge);
			const nextKey = edge.from === current.key ? edge.to : edge.from;
			const next = nodes.get(nextKey)!;
			current = next;
			if (current.key === start.key)
				break;
			if (current.edges.length !== 2)
				break;
			edge = current.edges.find(candidate => !visited.has(candidate));
		}
		if (!routeEdges.length)
			return;
		let orderedNodes: Node[] = [start];
		let cursor = start;
		for (const item of routeEdges) {
			cursor = nodes.get(item.from === cursor.key ? item.to : item.from)!;
			orderedNodes.push(cursor);
		}
		const trackIds = [...new Set(routeEdges.filter((item): item is TrackAtom => item.kind === 'track').map(item => item.id))];
		const viaIds = [...new Set([...routeEdges.filter((item): item is ViaAtom => item.kind === 'via').map(item => item.id), ...orderedNodes.flatMap(node => [...node.vias])])];
		const constraints = new Set<string>();
		if (routeEdges.some(item => item.kind === 'track' && Boolean(item.track.locked))) constraints.add('含锁定导线，不能建议改动。');
		if (routeEdges.some(item => item.kind === 'track' && Boolean(item.track.arc))) constraints.add('含圆弧；当前仅按扫角估算弧长，弧形中心线与弧端转角不完整，不用于缩短建议。');
		if (routeEdges.some((item): item is TrackAtom => item.kind === 'track' && input.copper.some(copper => copper.layer === item.track.layer)))
			constraints.add('存在同层铜区；此模块不判断铜区对替代路径的实际阻挡，提出改线前需单独检查障碍。');
		if (orderedNodes.some(node => node.ambiguous)) constraints.add('路径接触存在歧义或几何覆盖不足，需先人工核对。');
		if (orderedNodes.some(node => node.branched)) constraints.add('经过分支节点，已按支路分段；不可跨分支比较或改线。');
		if (orderedNodes.some(node => node.vias.size)) constraints.add('路径含过孔；换层与过孔用途需结合整板和电气约束复核。');
		if (orderedNodes.some(node => node.pads.size)) constraints.add('路径接触焊盘；焊盘出口和扇出需保持。');
		const turns: RoutingPathTurn[] = [];
		for (let i = 1; i < routeEdges.length; i++) {
			const previous = routeEdges[i - 1];
			const next = routeEdges[i];
			if (previous.kind !== 'track' || next.kind !== 'track' || previous.track.layer !== next.track.layer)
				continue;
			const node = orderedNodes[i];
			const angleDegrees = turnAngle(previous, next, node.p);
			if (angleDegrees === undefined) {
				constraints.add('含圆弧交界，转角统计未覆盖。');
				continue;
			}
			if (angleDegrees >= TURN_EPS_DEGREES)
				turns.push({ position: endpoint(node, trackIds), angleDegrees, classification: angleDegrees >= REVERSAL_DEGREES ? 'reversal' : 'turn', trackIds: [previous.id, next.id] });
		}
		const segments: RoutingPathSegment[] = routeEdges.map((item, i) => {
			const fromNode = orderedNodes[i];
			const toNode = orderedNodes[i + 1];
			return { kind: item.kind, id: item.id, from: endpoint(fromNode, trackIds), to: endpoint(toNode, trackIds), lengthMil: item.kind === 'track' ? item.length : 0, ...(item.kind === 'track' && item.track.arc ? { arc: true } : {}) };
		});
		const trackLengths = routeEdges.reduce((sum, item) => sum + (item.kind === 'track' ? item.length : 0), 0);
		const layerSwitchCount = routeEdges.filter((item): item is ViaAtom => item.kind === 'via' && nodes.get(item.from)!.layer !== nodes.get(item.to)!.layer).length;
		const branch = orderedNodes.some(node => node.branched);
		const ambiguous = orderedNodes.some(node => node.ambiguous);
		const unsupportedArc = routeEdges.some((item): item is TrackAtom => item.kind === 'track' && Boolean(item.track.arc));
		const status: RoutingPath['status'] = closed ? 'closed-loop' : ambiguous ? 'ambiguous' : unsupportedArc ? 'unsupported-arc' : branch ? 'branch-split' : 'traceable';
		if (closed) constraints.add('闭合回路没有唯一自然起点，起点仅为统计选择。');
		if (!orderedNodes[0].pads.size || !orderedNodes.at(-1)!.pads.size) constraints.add('至少一个端点未匹配到已知焊盘，端点语义未知。');
		const anchored = orderedNodes[0].pads.size > 0 && orderedNodes.at(-1)!.pads.size > 0;
		const locked = routeEdges.some(item => item.kind === 'track' && Boolean(item.track.locked));
		const improvability = status === 'traceable' && anchored && !locked ? 'review-required' : 'do-not-suggest';
		const path: RoutingPath = {
			id: `path:${paths.length + 1}`, net: routeEdges.find((item): item is TrackAtom => item.kind === 'track')?.track.net ?? routeEdges.find((item): item is ViaAtom => item.kind === 'via')!.via.net,
			trackIds, viaIds, start: endpoint(orderedNodes[0], trackIds), end: endpoint(orderedNodes.at(-1)!, trackIds),
			vertices: orderedNodes.map(node => endpoint(node, trackIds)), segments, lengthMil: trackLengths,
			turnCount: turns.length, turns, reversals: turns.filter(turn => turn.classification === 'reversal'), viaCount: viaIds.length,
			layerSwitchCount, status, improvability, constraints: [...constraints],
		};
		paths.push(path);
	};
	const edgesCount = trackAtoms.length + viaAtoms.length;
	for (const node of nodes.values()) {
		if (node.edges.length === 2)
			continue;
		for (const edge of node.edges) if (!visited.has(edge)) walk(node, edge);
	}
	for (const node of nodes.values()) {
		for (const edge of node.edges) if (!visited.has(edge)) walk(node, edge, true);
	}
	for (const viaId of unknownViaSpanIds) {
		const via = viasById.get(viaId)!;
		const attached = tracks.filter(track => track.net === via.net && Math.min(projection(via, track.a, track.b).distance, distance(via, track.a), distance(via, track.b)) <= (track.width + via.diameter) / 2 + LINE_CONTACT_TOL);
		if (attached.length && !issues.some(issue => issue.code === 'unknown-via-span' && issue.objectIds.includes(viaId)))
			issues.push({ code: 'unknown-via-span', message: '附近过孔的层跨度未知，不推断跨层连接。', objectIds: [viaId, ...attached.map(track => track.id)], position: { x: via.x, y: via.y }, net: via.net });
	}
	return {
		paths,
		issues,
		coverage: {
			trackCount: input.tracks.length, viaCount: input.vias.length, padCount: input.pads.length, copperCount: input.copper.length,
			includedTrackIds: [...new Set(paths.flatMap(path => path.trackIds))], excludedTrackIds,
			unsupportedArcIds: tracks.filter(track => Boolean(track.arc)).map(track => track.id), unknownViaSpanIds,
			approximatePadIds, copperUsedForConnectivity: false,
		},
	};
}
