/**
 * Read-only geometric evidence for selected PCB routes. Geometry approximations
 * are reported with their error bounds; this module never claims full DRC or
 * electrical connectivity, which also depends on host connectivity semantics.
 */
import { curveFromEndpoints } from './arcTuneGeometry';

export interface LocalPoint { x: number; y: number }
export interface LocalBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface LocalTrace { id: string; net: string; layer: number; width: number; start: LocalPoint; end: LocalPoint }
export interface LocalArc extends LocalTrace { sweepDegrees: number }
export interface LocalVia { id: string; net: string; x: number; y: number; diameter: number; holeDiameter: number; viaType: number }
export interface LocalPad { id: string; net: string; layer: number; x: number; y: number; rotation: number; shape?: unknown; hole?: unknown; special?: unknown }

const EPS = 1e-7;
const ARC_SAGITTA_TOLERANCE_MIL = 0.01;
const TURN_TOLERANCE_MIL = 1e-5;

interface Segment { a: LocalPoint; b: LocalPoint }
interface Routed { id: string; net: string; layer: number; width: number; points: LocalPoint[]; approximationErrorMil: number; kind: 'line' | 'arc' }
interface Circle { id: string; net: string; layers: number[] | null; x: number; y: number; radius: number; innerRadius: number; kind: 'via'; approximate: boolean }

function distance(a: LocalPoint, b: LocalPoint) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
function pointSegmentDistance(p: LocalPoint, a: LocalPoint, b: LocalPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const den = dx * dx + dy * dy;
	if (!den)
		return distance(p, a);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function orientation(a: LocalPoint, b: LocalPoint, c: LocalPoint) {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(p: LocalPoint, a: LocalPoint, b: LocalPoint) {
	return Math.abs(orientation(a, b, p)) <= EPS * Math.max(1, distance(a, b))
		&& p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
		&& p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}
function intersects(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint) {
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	if ((Math.abs(o1) <= EPS && onSegment(c, a, b)) || (Math.abs(o2) <= EPS && onSegment(d, a, b))
		|| (Math.abs(o3) <= EPS && onSegment(a, c, d)) || (Math.abs(o4) <= EPS && onSegment(b, c, d))) {
		return true;
	}
	return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}
function segmentDistance(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint) {
	if (intersects(a, b, c, d))
		return 0;
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function segments(points: LocalPoint[]): Segment[] {
	return points.slice(1).map((b, i) => ({ a: points[i], b }));
}
function routeDistance(a: Routed, b: Routed) {
	let result = Infinity;
	for (const sa of segments(a.points)) {
		for (const sb of segments(b.points)) result = Math.min(result, segmentDistance(sa.a, sa.b, sb.a, sb.b));
	}
	return result - a.approximationErrorMil - b.approximationErrorMil;
}
function routeCircleDistance(route: Routed, circle: Circle) {
	let centerline = Infinity;
	for (const segment of segments(route.points))
		centerline = Math.min(centerline, pointSegmentDistance({ x: circle.x, y: circle.y }, segment.a, segment.b));
	const radialGap = centerline < circle.innerRadius
		? circle.innerRadius - centerline
		: centerline > circle.radius ? centerline - circle.radius : 0;
	return radialGap - route.approximationErrorMil;
}
function arcRoute(arc: LocalArc): Routed | undefined {
	if (![arc.start.x, arc.start.y, arc.end.x, arc.end.y, arc.sweepDegrees, arc.width].every(Number.isFinite) || arc.width <= 0
		|| Math.abs(arc.sweepDegrees) <= 0 || Math.abs(arc.sweepDegrees) >= 360 || distance(arc.start, arc.end) <= EPS) {
		return undefined;
	}
	const curve = curveFromEndpoints([arc.start.x, arc.start.y], [arc.end.x, arc.end.y], arc.sweepDegrees);
	const sweep = Math.abs(curve.sweepDegrees) * Math.PI / 180;
	const step = curve.radius <= ARC_SAGITTA_TOLERANCE_MIL ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA_TOLERANCE_MIL / curve.radius));
	const count = Math.min(4096, Math.max(1, Math.ceil(sweep / Math.max(1e-5, step))));
	const start = Math.atan2(arc.start.y - curve.center[1], arc.start.x - curve.center[0]);
	const points = Array.from({ length: count + 1 }, (_, i) => {
		if (i === 0)
			return arc.start;
		if (i === count)
			return arc.end;
		const angle = start + curve.sweepDegrees * Math.PI / 180 * i / count;
		return { x: curve.center[0] + curve.radius * Math.cos(angle), y: curve.center[1] + curve.radius * Math.sin(angle) };
	});
	const approximationErrorMil = curve.radius * (1 - Math.cos(sweep / (2 * count)));
	return { id: arc.id, net: arc.net, layer: arc.layer, width: arc.width, points, approximationErrorMil, kind: 'arc' };
}
function lineRoute(line: LocalTrace): Routed {
	return { id: line.id, net: line.net, layer: line.layer, width: line.width, points: [line.start, line.end], approximationErrorMil: 0, kind: 'line' };
}
function inRegion(route: Routed, region?: LocalBounds) {
	if (!region)
		return true;
	const margin = route.width / 2 + route.approximationErrorMil;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of route.points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	return maxX + margin >= region.minX && minX - margin <= region.maxX && maxY + margin >= region.minY && minY - margin <= region.maxY;
}
function pointInside(point: LocalPoint, polygon: LocalPoint[]) {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (onSegment(point, a, b))
			return true;
		if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
			inside = !inside;
	}
	return inside;
}
function padPolygon(pad: LocalPad): { polygon: LocalPoint[]; error: number; exact: boolean } | undefined {
	// A solid polygon cannot represent the drill void of a through-hole pad, or
	// per-layer special copper. Exclude those shapes rather than treating the void
	// as conductive or assuming the shape is identical on every copper layer.
	if (pad.hole != null || (pad.special != null && (!Array.isArray(pad.special) || pad.special.length > 0)))
		return undefined;
	const shape = pad.shape;
	if (!Array.isArray(shape) || typeof shape[0] !== 'string')
		return undefined;
	const type = shape[0];
	const width = Number(shape[1]);
	const height = Number(shape[2]);
	if (![pad.x, pad.y, pad.rotation, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
		return undefined;
	const angle = pad.rotation * Math.PI / 180;
	const transform = (x: number, y: number): LocalPoint => ({ x: pad.x + x * Math.cos(angle) - y * Math.sin(angle), y: pad.y + x * Math.sin(angle) + y * Math.cos(angle) });
	let local: LocalPoint[] = [];
	let exact = false;
	let edgeError = 0;
	if (type === 'ELLIPSE' || type === 'OVAL') {
		if (type === 'ELLIPSE' || Math.abs(width - height) <= EPS) {
			const rx = width / 2;
			const ry = height / 2;
			const maxRadius = Math.max(rx, ry);
			const step = maxRadius > ARC_SAGITTA_TOLERANCE_MIL ? 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA_TOLERANCE_MIL / maxRadius)) : Math.PI / 4;
			const n = Math.min(4096, Math.max(32, Math.ceil(Math.PI * 2 / Math.max(1e-5, step))));
			edgeError = maxRadius * (1 - Math.cos(Math.PI / n));
			local = Array.from({ length: n }, (_, i) => ({ x: rx * Math.cos(i * Math.PI * 2 / n), y: ry * Math.sin(i * Math.PI * 2 / n) }));
			exact = Math.abs(width - height) <= EPS;
		}
		else {
			const majorX = width > height;
			const r = Math.min(width, height) / 2;
			const half = Math.abs(width - height) / 2;
			const step = r > ARC_SAGITTA_TOLERANCE_MIL ? 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA_TOLERANCE_MIL / r)) : Math.PI / 4;
			const steps = Math.min(4096, Math.max(16, Math.ceil(Math.PI / Math.max(1e-5, step))));
			edgeError = r * (1 - Math.cos(Math.PI / (2 * steps)));
			const capA = majorX ? -Math.PI / 2 : Math.PI;
			const capB = majorX ? Math.PI / 2 : 0;
			for (let i = 0; i <= steps; i++) {
				const a = capA + Math.PI * i / steps;
				const t = majorX ? { x: half + r * Math.cos(a), y: r * Math.sin(a) } : { x: r * Math.cos(a), y: -half + r * Math.sin(a) };
				local.push(t);
			}
			for (let i = 0; i <= steps; i++) {
				const a = capB + Math.PI * i / steps;
				const t = majorX ? { x: -half + r * Math.cos(a), y: r * Math.sin(a) } : { x: r * Math.cos(a), y: half + r * Math.sin(a) };
				local.push(t);
			}
		}
	}
	else if (type === 'RECT') {
		const roundPercent = Number(shape[3] ?? 0);
		if (!Number.isFinite(roundPercent) || roundPercent < 0 || roundPercent > 100)
			return undefined;
		// EasyEDA's RECT getter stores round as a percentage of the half of the
		// shorter side, not a mil radius. This conversion is also used by the
		// established KiRouting input adapter and standalone-pad write/readback.
		const radius = Math.min(width, height) * roundPercent / 200;
		if (radius === 0) {
			local = [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }];
		}
		else {
			local = [];
			const step = radius > ARC_SAGITTA_TOLERANCE_MIL ? 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA_TOLERANCE_MIL / radius)) : Math.PI / 4;
			const cornerSteps = Math.min(4096, Math.max(9, Math.ceil(Math.PI / 2 / Math.max(1e-5, step))));
			edgeError = radius * (1 - Math.cos(Math.PI / (4 * cornerSteps)));
			for (const [cx, cy, start] of [[width / 2 - radius, height / 2 - radius, 0], [-width / 2 + radius, height / 2 - radius, 90], [-width / 2 + radius, -height / 2 + radius, 180], [width / 2 - radius, -height / 2 + radius, 270]]) {
				for (let i = 0; i <= cornerSteps; i++) {
					const a = (start + i * 90 / cornerSteps) * Math.PI / 180;
					local.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
				}
			}
		}
	}
	else if (type === 'NGON') {
		const sideCount = Number(shape[2]);
		if (!Number.isInteger(sideCount) || sideCount < 3 || sideCount > 256)
			return undefined;
		local = Array.from({ length: sideCount }, (_, i) => ({ x: width / 2 * Math.cos(2 * Math.PI * i / sideCount), y: width / 2 * Math.sin(2 * Math.PI * i / sideCount) }));
		exact = true;
	}
	else {
		return undefined;
	}
	const polygon = local.map(p => transform(p.x, p.y));
	return { polygon, error: edgeError, exact: exact && edgeError === 0 };
}
function octilinearDeviation(start: LocalPoint, end: LocalPoint) {
	const dx = Math.abs(end.x - start.x);
	const dy = Math.abs(end.y - start.y);
	return Math.min(dx, dy, Math.abs(dx - dy));
}
function minimumByLayer<T extends { layer: number; clearanceMil: number; pair: [string, string]; netPair: [string, string]; obstacle: string; approximationErrorMil: number }>(items: T[]) {
	const map = new Map<number, T>();
	for (const item of items) {
		if (!map.has(item.layer) || item.clearanceMil < map.get(item.layer)!.clearanceMil)
			map.set(item.layer, item);
	}
	return [...map.values()].map(({ layer, clearanceMil, pair, netPair, obstacle, approximationErrorMil }) => ({ layer, clearanceMil, centerlineClearanceMil: clearanceMil, pair, netPair, obstacle, approximationErrorMil }));
}

export function analyzeLocalRouting(input: { nets?: string[]; region?: LocalBounds; lines: LocalTrace[]; arcs?: LocalArc[]; vias?: LocalVia[]; pads?: LocalPad[] }) {
	const selectedNets = input.nets?.length ? new Set(input.nets) : undefined;
	const knownArcs = (input.arcs ?? []).map(arc => ({ arc, route: arcRoute(arc) })).filter((entry): entry is { arc: LocalArc; route: Routed } => !!entry.route);
	const malformedArcIds = (input.arcs ?? []).filter(arc => !arcRoute(arc)).map(arc => arc.id);
	const unsupportedTraceIds = input.lines.filter(line => !Number.isFinite(line.width) || line.width <= 0).map(line => line.id);
	const allRoutes = [
		...input.lines.filter(line => line.width > 0 && distance(line.start, line.end) > EPS).map(lineRoute),
		...knownArcs.map(item => item.route),
	];
	const selectedRoutes = allRoutes.filter(route => route.net.trim() && (!selectedNets || selectedNets.has(route.net)) && inRegion(route, input.region));
	const selectedIds = new Set(selectedRoutes.map(route => route.id));
	const padShapes = (input.pads ?? []).map(pad => ({ pad, geometry: padPolygon(pad) }));
	const supportedPadLayers = new Set([1, 2, 12]);
	const unsupportedPadIds = padShapes.filter(item => !item.geometry || !supportedPadLayers.has(item.pad.layer)).map(item => item.pad.id);
	const unsupportedPadLayerIds = padShapes.filter(item => !supportedPadLayers.has(item.pad.layer)).map(item => item.pad.id);
	const unidentifiedNetObjectCount = input.lines.filter(line => !line.net.trim()).length
		+ (input.arcs ?? []).filter(arc => !arc.net.trim()).length
		+ (input.vias ?? []).filter(via => !via.net.trim()).length
		+ (input.pads ?? []).filter(pad => !pad.net.trim()).length;
	const circles: Circle[] = [];
	const unsupportedViaIds = (input.vias ?? []).filter(via => via.viaType !== 0 || !Number.isFinite(via.diameter) || via.diameter <= 0
		|| !Number.isFinite(via.holeDiameter) || via.holeDiameter <= 0 || via.holeDiameter >= via.diameter).map(via => via.id);
	for (const via of input.vias ?? []) {
		if (via.viaType === 0 && Number.isFinite(via.diameter) && via.diameter > 0 && Number.isFinite(via.holeDiameter) && via.holeDiameter > 0 && via.holeDiameter < via.diameter)
			circles.push({ id: via.id, net: via.net, layers: null, x: via.x, y: via.y, radius: via.diameter / 2, innerRadius: via.holeDiameter / 2, kind: 'via', approximate: false });
	}
	const candidates: Array<{ layer: number; clearanceMil: number; pair: [string, string]; netPair: [string, string]; obstacle: string; approximationErrorMil: number }> = [];
	const geometricPadContactCandidates: Array<{ routeId: string; padId: string; net: string; layer: number; padShapeApproximationErrorMil: number }> = [];
	for (const route of selectedRoutes) {
		for (const peer of allRoutes) {
			if (peer.net && route.layer === peer.layer && route.net !== peer.net && (selectedIds.has(peer.id) ? route.id < peer.id : true)) {
				candidates.push({ layer: route.layer, clearanceMil: routeDistance(route, peer) - (route.width + peer.width) / 2, pair: [route.id, peer.id], netPair: [route.net, peer.net], obstacle: `${route.kind}-${peer.kind}`, approximationErrorMil: route.approximationErrorMil + peer.approximationErrorMil });
			}
		}
		for (const circle of circles) {
			if (circle.net !== route.net && (!circle.layers || circle.layers.includes(route.layer))) {
				const clearanceMil = routeCircleDistance(route, circle) - route.width / 2;
				if (circle.net)
					candidates.push({ layer: route.layer, clearanceMil, pair: [route.id, circle.id], netPair: [route.net, circle.net], obstacle: circle.kind, approximationErrorMil: route.approximationErrorMil });
			}
		}
		for (const { pad, geometry } of padShapes) {
			if (!geometry || !supportedPadLayers.has(pad.layer))
				continue;
			const layerMatches = pad.layer === 12 || pad.layer === route.layer;
			if (!layerMatches)
				continue;
			let centerDistance = Infinity;
			for (let i = 0; i < geometry.polygon.length; i++) centerDistance = Math.min(centerDistance, ...segments(route.points).map(s => segmentDistance(s.a, s.b, geometry.polygon[i], geometry.polygon[(i + 1) % geometry.polygon.length])));
			if (route.points.some(p => pointInside(p, geometry.polygon)))
				centerDistance = 0;
			const padError = geometry.error;
			if (!pad.net)
				continue;
			if (pad.net === route.net) {
				if (centerDistance <= route.width / 2 + route.approximationErrorMil + padError)
					geometricPadContactCandidates.push({ routeId: route.id, padId: pad.id, net: route.net, layer: route.layer, padShapeApproximationErrorMil: padError });
			}
			else {
				candidates.push({ layer: route.layer, clearanceMil: centerDistance - route.width / 2 - route.approximationErrorMil - padError, pair: [route.id, pad.id], netPair: [route.net, pad.net], obstacle: 'pad-shape', approximationErrorMil: route.approximationErrorMil + padError });
			}
		}
	}
	const clearanceByLayer = minimumByLayer(candidates);
	const unknownNetProximity: Array<{ layer: number; clearanceMil: number; routeId: string; objectId: string; objectType: string; approximationErrorMil: number }> = [];
	for (const route of selectedRoutes) {
		for (const peer of allRoutes) {
			if (!peer.net && route.layer === peer.layer)
				unknownNetProximity.push({ layer: route.layer, clearanceMil: routeDistance(route, peer) - (route.width + peer.width) / 2, routeId: route.id, objectId: peer.id, objectType: peer.kind, approximationErrorMil: route.approximationErrorMil + peer.approximationErrorMil });
		}
		for (const circle of circles) {
			if (!circle.net && (!circle.layers || circle.layers.includes(route.layer)))
				unknownNetProximity.push({ layer: route.layer, clearanceMil: routeCircleDistance(route, circle) - route.width / 2, routeId: route.id, objectId: circle.id, objectType: circle.kind, approximationErrorMil: route.approximationErrorMil });
		}
		for (const { pad, geometry } of padShapes) {
			if (!pad.net && geometry && supportedPadLayers.has(pad.layer) && (pad.layer === 12 || pad.layer === route.layer)) {
				let edgeDistance = Infinity;
				for (const segment of segments(route.points)) {
					for (let i = 0; i < geometry.polygon.length; i++)
						edgeDistance = Math.min(edgeDistance, segmentDistance(segment.a, segment.b, geometry.polygon[i], geometry.polygon[(i + 1) % geometry.polygon.length]));
				}
				if (route.points.some(point => pointInside(point, geometry.polygon)))
					edgeDistance = 0;
				unknownNetProximity.push({ layer: route.layer, clearanceMil: edgeDistance - route.width / 2 - route.approximationErrorMil - geometry.error, routeId: route.id, objectId: pad.id, objectType: 'pad-shape', approximationErrorMil: route.approximationErrorMil + geometry.error });
			}
		}
	}
	const nearestUnknownNetByLayer = new Map<number, typeof unknownNetProximity[number]>();
	for (const item of unknownNetProximity) {
		if (!nearestUnknownNetByLayer.has(item.layer) || item.clearanceMil < nearestUnknownNetByLayer.get(item.layer)!.clearanceMil)
			nearestUnknownNetByLayer.set(item.layer, item);
	}
	const parent = new Map(selectedRoutes.map((_, i) => [i, i]));
	const root = (index: number): number => {
		let result = index;
		while (parent.get(result) !== result)
			result = parent.get(result)!;
		let current = index;
		while (parent.get(current) !== current) {
			const next = parent.get(current)!;
			parent.set(current, result);
			current = next;
		}
		return result;
	};
	const join = (a: number, b: number) => {
		const ra = root(a);
		const rb = root(b);
		if (ra !== rb)
			parent.set(rb, ra);
	};
	const turns: Array<{ net: string; layer: number; at: LocalPoint; fromId: string; toId: string; deflectionDegrees: number }> = [];
	const non45Segments: Array<{ id: string; net: string; layer: number; start: LocalPoint; end: LocalPoint; deviationMil: number }> = [];
	for (let i = 0; i < selectedRoutes.length; i++) {
		const a = selectedRoutes[i];
		if (a.kind === 'line') {
			for (const s of segments(a.points)) {
				const deviationMil = octilinearDeviation(s.a, s.b);
				if (deviationMil > TURN_TOLERANCE_MIL)
					non45Segments.push({ id: a.id, net: a.net, layer: a.layer, start: s.a, end: s.b, deviationMil });
			}
		}
		for (let j = i + 1; j < selectedRoutes.length; j++) {
			const b = selectedRoutes[j];
			if (a.net !== b.net || a.layer !== b.layer)
				continue;
			if (segments(a.points).some(sa => segments(b.points).some(sb => intersects(sa.a, sa.b, sb.a, sb.b))))
				join(i, j);
			// Keep turn reporting limited to explicit line endpoint pairs. Arc tangency is not
			// inferred from tessellated samples because that would invent bends.
			if (a.kind !== 'line' || b.kind !== 'line')
				continue;
			for (const p of [a.points[0], a.points.at(-1)!]) {
				for (const q of [b.points[0], b.points.at(-1)!]) {
					if (distance(p, q) <= EPS) {
						const farA = p === a.points[0] ? a.points.at(-1)! : a.points[0];
						const farB = q === b.points[0] ? b.points.at(-1)! : b.points[0];
						const va = { x: farA.x - p.x, y: farA.y - p.y };
						const vb = { x: farB.x - p.x, y: farB.y - p.y };
						const angle = Math.acos(Math.max(-1, Math.min(1, (va.x * vb.x + va.y * vb.y) / (Math.hypot(va.x, va.y) * Math.hypot(vb.x, vb.y))))) * 180 / Math.PI;
						if (octilinearDeviation(p, farA) > TURN_TOLERANCE_MIL || octilinearDeviation(p, farB) > TURN_TOLERANCE_MIL)
							turns.push({ net: a.net, layer: a.layer, at: p, fromId: a.id, toId: b.id, deflectionDegrees: 180 - angle });
					}
				}
			}
		}
	}
	const componentSizes = new Map<number, number>();
	for (let i = 0; i < selectedRoutes.length; i++) {
		const key = root(i);
		componentSizes.set(key, (componentSizes.get(key) ?? 0) + 1);
	}
	const selectedPads = padShapes.filter(({ pad }) => (!selectedNets || selectedNets.has(pad.net)) && (!input.region || (pad.x >= input.region.minX && pad.x <= input.region.maxX && pad.y >= input.region.minY && pad.y <= input.region.maxY)));
	const selectedVias = (input.vias ?? []).filter(via => (!selectedNets || selectedNets.has(via.net)) && (!input.region || (via.x >= input.region.minX && via.x <= input.region.maxX && via.y >= input.region.minY && via.y <= input.region.maxY)));
	const selectedArcIds = knownArcs.filter(({ arc }) => (!selectedNets || selectedNets.has(arc.net)) && inRegion(arcRoute(arc)!, input.region)).map(({ arc }) => arc.id);
	const traceCount = selectedRoutes.filter(route => route.kind === 'line').length;
	return {
		scope: { nets: selectedNets ? [...selectedNets] : null, region: input.region ?? null, regionSelection: input.region ? '线和圆弧按展开后包围框；焊盘和过孔按中心点选入，选中对象按完整几何测量' : null },
		tracks: { count: traceCount, arcCount: selectedArcIds.length, degenerateTraceCount: input.lines.filter(line => selectedNets?.has(line.net) && distance(line.start, line.end) <= EPS).length, unidentifiedNetTraceCount: input.lines.filter(line => !line.net.trim()).length, traceGraphComponents: componentSizes.size, traceGraphComponentSizes: [...componentSizes.values()], netsWithoutSelectedSegments: selectedNets ? [...selectedNets].filter(net => !selectedRoutes.some(route => route.net === net)) : [], fullNetConnectivityVerified: false },
		turns: { count: turns.length, non45Deflections: turns, non45Segments, toleranceMil: TURN_TOLERANCE_MIL, toleranceSource: 'CP61 verify-turns.cjs component-delta check' },
		minimumTraceClearance: { method: '选中直线/圆弧与已读同层异网直线/圆弧、支持的焊盘外形和通孔环；圆弧按弦段展开并扣除误差上界', unit: 'mil', byLayer: clearanceByLayer, includesPadsViasArcsCopperAreas: false, includesArcsPadsThroughVias: true, includesCopperAreas: false },
		unknownNetGeometry: { objectCount: unidentifiedNetObjectCount, nearestByLayer: [...nearestUnknownNetByLayer.values()], includedInMinimumClearance: false, reason: '未分配网络的几何单独报告为距离参考；网络身份未知，不能判断它是否为异网违规' },
		contacts: { geometricallyIntersectingSameNetRoutePairs: selectedRoutes.flatMap((a, i) => selectedRoutes.slice(i + 1).filter(b => a.net === b.net && a.layer === b.layer && segments(a.points).some(sa => segments(b.points).some(sb => intersects(sa.a, sa.b, sb.a, sb.b)))).map(b => [a.id, b.id])), sameNetRouteToSupportedPadShapeCandidates: geometricPadContactCandidates, electricalConnectivityProven: false },
		objects: { arcs: selectedArcIds.length, vias: selectedVias.length, pads: selectedPads.length, countsFilteredBy: selectedNets ? 'requested nets' : 'all read objects', unsupportedTraceIds, unsupportedArcIds: malformedArcIds, unsupportedPadIds, unsupportedPadLayerIds, unsupportedViaIds },
		coverage: { traceGraph: selectedRoutes.length ? 'partial' : 'unknown', traceToPadContacts: geometricPadContactCandidates.length ? 'geometric-candidate' : selectedPads.length ? 'evaluated-no-overlap-candidate' : 'unknown', viaLayerSpan: unsupportedViaIds.length ? 'unknown' : 'through-vias-only', crossLayerRouting: 'unknown', traceCopperAreaClearance: 'unknown', filledCopperIslands: 'unknown', unidentifiedNetObjectCount, clearanceNetIdentity: unidentifiedNetObjectCount ? 'unknown-geometry-reported-separately' : 'known-for-read-categories', geometryCompleteness: 'partial', unsupportedGeometry: [...(unsupportedTraceIds.length ? ['线宽非正或无法使用的走线'] : []), ...(unsupportedPadIds.length ? ['通孔焊盘、特殊层焊盘或复杂多边形焊盘'] : []), ...(unsupportedPadLayerIds.length ? ['焊盘位于未支持层'] : []), ...(unsupportedViaIds.length ? ['盲埋孔层跨度或无效通孔环尺寸'] : []), ...(malformedArcIds.length ? ['几何无效或线宽非正的圆弧'] : []), '铜区实填几何'], arcChordTargetToleranceMil: ARC_SAGITTA_TOLERANCE_MIL, maxArcChordErrorMil: selectedRoutes.reduce((max, route) => Math.max(max, route.approximationErrorMil), 0), coordinateToleranceMil: EPS },
	};
}
