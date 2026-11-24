import type { LocalPad } from './localRoutingReview';
import type { Point, ScanCopper, ScanPad, ScanTrack, ScanVia } from './routingRemnantAnalysis';
import { normalizeBoardOutlinePolylines } from './boardOutline';
import { routingRemnantSource } from './routingRemnantSource';
import { parseSourceLog, resolveRecords } from './sourcelog';

interface Edge { a: Point; b: Point }
interface CoverageGap { reason: string; id?: string; layers?: number[] }

function outlineShape(id: string, path: unknown, width: number) {
	return {
		getState_PrimitiveId: () => id, getState_Layer: () => 11,
		getState_Polygon: () => ({ getSource: () => path }), getState_LineWidth: () => width,
	};
}

function readOutlineEdges(objects: unknown[]) {
	const normalized = normalizeBoardOutlinePolylines(objects);
	const edges: Edge[] = normalized.lines.map(line => ({
		a: { x: line.getState_StartX(), y: line.getState_StartY() },
		b: { x: line.getState_EndX(), y: line.getState_EndY() },
	}));
	return { edges, issues: normalized.issues };
}

function stitchBoardEdges(edges: Edge[]): Point[][] {
	const vertexKey = ({ x, y }: Point) => `${x},${y}`;
	const vertices = new Map<string, number[]>();
	for (const [index, edge] of edges.entries()) {
		const keys = [vertexKey(edge.a), vertexKey(edge.b)];
		if (keys[0] === keys[1])
			throw new Error('板框存在零长度边');
		for (const key of keys) {
			const incident = vertices.get(key) ?? [];
			incident.push(index);
			vertices.set(key, incident);
		}
	}
	if (!edges.length || [...vertices.values()].some(incident => incident.length !== 2))
		throw new Error('未取得封闭板框，或板框存在分支');
	const pending = new Set(edges.keys());
	const rings: Point[][] = [];
	while (pending.size) {
		const first = pending.values().next().value!;
		const start = edges[first].a;
		const ring = [start];
		let current = edges[first].b;
		pending.delete(first);
		while (vertexKey(current) !== vertexKey(start)) {
			ring.push(current);
			const next = vertices.get(vertexKey(current))?.find(index => pending.has(index));
			if (next === undefined)
				throw new Error('板框无法组成独立闭环');
			pending.delete(next);
			current = vertexKey(edges[next].a) === vertexKey(current) ? edges[next].b : edges[next].a;
		}
		if (ring.length < 3)
			throw new Error('板框闭环的有效顶点不足');
		rings.push(ring);
	}
	return rings;
}

/** Radius encloses the supported pad artwork. It is a conservative obstacle. */
function padObstacle(pad: LocalPad, copperLayers: number[]): ScanPad | undefined {
	const [shape, width, height] = Array.isArray(pad.shape) ? pad.shape : [];
	const layers = pad.layer === 12 ? copperLayers : copperLayers.includes(pad.layer) ? [pad.layer] : [];
	if (!['RECT', 'ELLIPSE', 'OVAL'].includes(shape) || !layers.length
		|| ![pad.x, pad.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0
		|| (pad.special != null && (!Array.isArray(pad.special) || pad.special.length > 0)) || pad.hole != null)
		return undefined;
	return {
		id: pad.id, net: pad.net, x: pad.x, y: pad.y, layers,
		radius: shape === 'RECT' ? Math.hypot(width, height) / 2 : Math.max(width, height) / 2,
		approximate: shape !== 'ELLIPSE' || width !== height,
	};
}

export function routingDetourSource(source: string, sdkPads?: LocalPad[]) {
	const routing = routingRemnantSource(source, sdkPads);
	const records = [...resolveRecords(parseSourceLog(source)).values()];
	const copperLayerIds = routing.layers.map(layer => layer.id);
	const geometryGaps: CoverageGap[] = [];
	const boardEdges: Edge[] = [];
	const boardPolylines: unknown[] = [];
	const blockedNets = new Map<string, string>();
	const availablePads = new Map((sdkPads ?? []).map(pad => [pad.id, pad]));
	const padObstacles: ScanPad[] = [];
	const pathPads: ScanPad[] = [];
	const keepouts: Array<{ id: string; layer?: number; rings: Point[][]; source: string }> = [];
	const understoodRegions = new Set<string>();
	const tracks = [...routing.tracks];
	const vias = [...routing.vias];
	const copper: ScanCopper[] = [...routing.copper];
	const layerFor = (layer: number): number[] | undefined => copperLayerIds.includes(layer) ? [layer] : undefined;
	const recordedViaIds = new Set(vias.map(via => via.id));
	const recordedTrackIds = new Set(tracks.map(track => track.id));
	const coveredPads = new Set<string>();

	if (!sdkPads)
		geometryGaps.push({ reason: '没有完整的实时或配对保存样本焊盘几何' });
	for (const pad of sdkPads ?? []) {
		const obstacle = padObstacle(pad, copperLayerIds);
		if (obstacle) {
			padObstacles.push(obstacle);
			// An inscribed circle gives a positive contact bound on supported SMD pads.
			// The larger outer circle is used separately for obstacle clearance.
			if (pad.net && obstacle.layers.length === 1) {
				const [, width, height] = pad.shape as [string, number, number];
				pathPads.push({ ...obstacle, radius: Math.min(width, height) / 2, approximate: false });
			}
			coveredPads.add(pad.id);
		}
		else {
			geometryGaps.push({ id: pad.id, layers: layerFor(pad.layer), reason: '焊盘形状、钻孔或特殊层铜未完整读回' });
		}
	}
	for (const { header, data } of records) {
		const { type, id = '' } = header;
		const layer = data.layerId;
		const net = typeof data.netName === 'string' ? data.netName : '';
		if (type === 'NET' && (data.differentialName || data.equalLengthGroupName)) {
			const name = JSON.parse(id)[1];
			if (typeof name === 'string' && name)
				blockedNets.set(name, '网络关联差分对或等长组');
		}
		else if (type === 'PAD' || type === 'PAD_NET') {
			const [owner, pin] = type === 'PAD_NET' ? JSON.parse(id).filter((_: unknown, index: number) => index === 1 || index === 3) : [];
			const key = type === 'PAD' ? id : typeof owner === 'string' && typeof pin === 'string' ? owner + pin : '';
			if (!availablePads.has(key))
				geometryGaps.push({ id: key || id, layers: layerFor(layer), reason: '有效源码焊盘缺少对应可用的全局位置' });
		}
		else if (layer === 11 && type === 'LINE') {
			if ([data.startX, data.startY, data.endX, data.endY].every(Number.isFinite))
				boardEdges.push({ a: { x: data.startX, y: data.startY }, b: { x: data.endX, y: data.endY } });
			else
				geometryGaps.push({ id, reason: '板框导线坐标未核实' });
		}
		else if (layer === 11 && type === 'POLY') {
			boardPolylines.push(outlineShape(id, Array.isArray(data.path?.[0]) && data.path.length === 1 ? data.path[0] : data.path, data.width));
		}
		else if (layer === 11 && ['ARC', 'REGION', 'FILL', 'CIRCLE', 'POLYGON'].includes(type)) {
			geometryGaps.push({ id, reason: '板框圆弧或特殊板框图形尚未纳入检查' });
		}
		else if ((type === 'LINE' || type === 'ARC') && copperLayerIds.includes(layer) && !recordedTrackIds.has(id)) {
			if (type === 'LINE' && [data.startX, data.startY, data.endX, data.endY, data.width].every(Number.isFinite) && data.width > 0)
				tracks.push({ id, net, layer, width: data.width, a: { x: data.startX, y: data.startY }, b: { x: data.endX, y: data.endY } });
			else
				geometryGaps.push({ id, layers: [layer], reason: '铜层走线或圆弧未能作为障碍完整读取' });
		}
		else if (type === 'VIA' && !recordedViaIds.has(id)) {
			if ([data.centerX, data.centerY, data.holeDiameter, data.viaDiameter].every(Number.isFinite)
				&& data.viaDiameter > 0 && data.holeDiameter < data.viaDiameter) {
				vias.push({ id, net, x: data.centerX, y: data.centerY, diameter: data.viaDiameter, hole: data.holeDiameter,
					layers: data.viaType === 'NORMAL' ? copperLayerIds : null, locked: data.locked === true });
			}
			else
				geometryGaps.push({ id, reason: '空网或特殊过孔的孔环无法作为障碍核实' });
		}
		else if (type === 'REGION' && data.regionType === 'PROHIBIT' && Array.isArray(data.prohibitType)
			&& data.prohibitType.length && data.prohibitType.every((entry: string) => ['TRACK', 'COPPER'].includes(entry))) {
			if (!data.prohibitType.includes('TRACK')) {
				understoodRegions.add(id);
				continue;
			}
			try {
				if (!copperLayerIds.includes(layer) && layer !== 12)
					throw new Error('禁布图层无法核实');
				const paths = Array.isArray(data.path?.[0]) ? data.path as unknown[][] : [data.path];
				const shape = readOutlineEdges(paths.map((path, index) => outlineShape(`${id}:${index}`, path, data.width)));
				if (shape.issues.length)
					throw new Error(shape.issues.join('；'));
				const rings = stitchBoardEdges(shape.edges);
				keepouts.push({ id, layer: layer === 12 ? undefined : layer, rings, source: 'PCB 源码 REGION TRACK' });
				understoodRegions.add(id);
			}
			catch (error) {
				geometryGaps.push({ id, layers: layerFor(layer), reason: `禁布区几何未核实：${(error as Error).message}` });
			}
		}
		else if (['REGION', 'KEEPOUT', 'SLOT', 'HOLE'].includes(type)) {
			geometryGaps.push({ id, layers: layerFor(layer), reason: `存在需复核的限制区域或机械孔（${type}）` });
		}
	}
	const normalized = readOutlineEdges(boardPolylines);
	for (const issue of normalized.issues)
		geometryGaps.push({ reason: issue });
	boardEdges.push(...normalized.edges);
	let boardRings: Point[][] | undefined;
	try {
		boardRings = stitchBoardEdges(boardEdges);
	}
	catch (error) {
		geometryGaps.push({ reason: (error as Error).message });
	}
	const shapeIssues = routing.issues.filter(issue => !issue.reason.includes('焊盘') && !understoodRegions.has(issue.id));
	for (const issue of shapeIssues)
		geometryGaps.push({ id: issue.id, reason: issue.reason });
	return { routing, records, tracks, vias, padObstacles, pathPads, copper, boardRings, keepouts, geometryGaps, blockedNets, coveredPads: coveredPads.size };
}
