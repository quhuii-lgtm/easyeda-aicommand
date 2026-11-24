import type { CopperGerberLayerName, GerberLayerGeometry } from './silkscreenGerber';
import clipping from './autoCopper/upstream/polygon-clipping.js';

type Point = [number, number];
type Ring = Point[];
type MultiPolygon = Ring[][];
interface GeometryPiece { polygon: Ring[]; bounds: { minX: number; minY: number; maxX: number; maxY: number } }

export interface PanelDrillHit {
	id: string;
	xMm: number;
	yMm: number;
	diameterMm: number;
	plating: 'PLATED' | 'NON_PLATED';
}

export interface PanelOutlinePath {
	id: string;
	pointsMm: Point[];
}

const MM_TO_MIL = 1000 / 25.4;
const EPSILON = 1e-8;

function union(polygons: MultiPolygon[]): MultiPolygon {
	const values = polygons.filter(polygon => polygon.length > 0);
	return values.length ? clipping.union(...values) as MultiPolygon : [];
}

function subtract(subject: MultiPolygon, clips: MultiPolygon): MultiPolygon {
	return subject.length && clips.length ? clipping.difference(subject, clips) as MultiPolygon : subject;
}

function intersect(first: MultiPolygon, second: MultiPolygon): MultiPolygon {
	if (!first.length || !second.length)
		return [];
	const withoutSecond = clipping.difference(first, second) as MultiPolygon;
	return withoutSecond.length ? clipping.difference(first, withoutSecond) as MultiPolygon : first;
}

function paint(layer: GerberLayerGeometry<'GTP' | 'GBP' | CopperGerberLayerName>): { lower: MultiPolygon; upper: MultiPolygon } {
	let lower: MultiPolygon = [];
	let upper: MultiPolygon = [];
	for (let index = 0; index < layer.shapes.length;) {
		const polarity = layer.shapes[index].polarity;
		const runLower: MultiPolygon[] = [];
		const runUpper: MultiPolygon[] = [];
		while (index < layer.shapes.length && layer.shapes[index].polarity === polarity) {
			const shape = layer.shapes[index++];
			runLower.push(shape.geometryLower);
			runUpper.push(shape.geometryUpper);
		}
		const currentLower = union(runLower);
		const currentUpper = union(runUpper);
		if (polarity === 'dark') {
			lower = union([lower, currentLower]);
			upper = union([upper, currentUpper]);
		}
		else {
			lower = subtract(lower, currentUpper);
			upper = subtract(upper, currentLower);
		}
	}
	return { lower, upper };
}

function circle(center: Point, radius: number, inner: boolean): MultiPolygon {
	const count = 256;
	const factor = inner ? Math.cos(Math.PI / count) : 1 / Math.cos(Math.PI / count);
	const points = Array.from({ length: count }, (_, index) => {
		const angle = 2 * Math.PI * index / count;
		return [center[0] + radius * factor * Math.cos(angle), center[1] + radius * factor * Math.sin(angle)] as Point;
	});
	points.push([...points[0]]);
	return [[points]];
}

function area(polygons: MultiPolygon): number {
	return polygons.reduce((sum, polygon) => {
		const ringArea = (ring: Ring) => {
			let value = 0;
			for (let index = 1; index < ring.length; index++)
				value += ring[index - 1][0] * ring[index][1] - ring[index][0] * ring[index - 1][1];
			return value / 2;
		};
		return sum + Math.abs(ringArea(polygon[0] ?? [])) - polygon.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0);
	}, 0);
}

function indexGeometry(polygons: MultiPolygon): GeometryPiece[] {
	return polygons.flatMap((polygon) => {
		const exterior = polygon[0] ?? [];
		if (!exterior.length)
			return [];
		const xs = exterior.map(point => point[0]);
		const ys = exterior.map(point => point[1]);
		return [{
			polygon,
			bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
		}];
	});
}

function piecesOverlappingCircle(pieces: readonly GeometryPiece[], center: Point, radius: number): MultiPolygon {
	const minX = center[0] - radius;
	const maxX = center[0] + radius;
	const minY = center[1] - radius;
	const maxY = center[1] + radius;
	return pieces.filter(piece => piece.bounds.maxX >= minX && piece.bounds.minX <= maxX
		&& piece.bounds.maxY >= minY && piece.bounds.minY <= maxY).map(piece => piece.polygon);
}

function checkedLayer(layer: GerberLayerGeometry<'GTP' | 'GBP'>, expected: 'GTP' | 'GBP') {
	if (layer.layer !== expected || layer.format.sourceUnits !== 'mm' || !layer.complete
		|| layer.unknowns.length || layer.unsupported.length || layer.arcApproximationLimited) {
		return { ok: false as const, reason: `需要唯一完整的${expected}层和支持的毫米 Gerber 几何` };
	}
	const geometry = paint(layer);
	return { ok: true as const, geometry, lowerIndex: indexGeometry(geometry.lower), upperIndex: indexGeometry(geometry.upper) };
}

export function inspectDrillPasteOverlaps(args: {
	drillHits: readonly PanelDrillHit[];
	pasteLayers: readonly GerberLayerGeometry<'GTP' | 'GBP'>[];
	pasteBasis: 'artwork' | 'stencil-file';
}) {
	const results: Array<Record<string, unknown>> = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	const layerState = new Map<'GTP' | 'GBP', ReturnType<typeof checkedLayer>>();
	for (const name of ['GTP', 'GBP'] as const) {
		const matching = args.pasteLayers.filter(layer => layer.layer === name);
		layerState.set(name, matching.length === 1 ? checkedLayer(matching[0], name) : { ok: false, reason: `需要唯一${name}层 Gerber` });
	}
	const validDrills = args.drillHits.filter(hit => hit.id && [hit.xMm, hit.yMm, hit.diameterMm].every(Number.isFinite)
		&& hit.diameterMm > 0 && ['PLATED', 'NON_PLATED'].includes(hit.plating));
	for (const hit of args.drillHits) {
		if (!hit.id || ![hit.xMm, hit.yMm, hit.diameterMm].every(Number.isFinite) || hit.diameterMm <= 0
			|| !['PLATED', 'NON_PLATED'].includes(hit.plating)) {
			skipped.push({ id: hit.id, reason: '钻孔位置、直径或镀层信息无效' });
			continue;
		}
		const centerMil: Point = [hit.xMm * MM_TO_MIL, hit.yMm * MM_TO_MIL];
		const drillRadiusMil = hit.diameterMm * MM_TO_MIL / 2;
		const checkedLayers = (['GTP', 'GBP'] as const).filter(layer => layerState.get(layer)?.ok);
		if (!checkedLayers.length) {
			skipped.push({ id: hit.id, reason: '顶底锡膏 Gerber 不完整，无法判断孔与开口交叉' });
			continue;
		}
		const circleLower = circle(centerMil, drillRadiusMil, true);
		const circleUpper = circle(centerMil, drillRadiusMil, false);
		for (const layer of checkedLayers) {
			const paste = layerState.get(layer)!;
			if (!paste.ok)
				continue;
			const lowerPieces = piecesOverlappingCircle(paste.lowerIndex, centerMil, drillRadiusMil);
			const upperPieces = piecesOverlappingCircle(paste.upperIndex, centerMil, drillRadiusMil);
			const intersectionLower = lowerPieces.flatMap(piece => intersect(circleLower, [piece]));
			const intersectionUpper = upperPieces.flatMap(piece => intersect(circleUpper, [piece]));
			const areaLower = area(intersectionLower);
			const areaUpper = area(intersectionUpper);
			if (areaLower > EPSILON || areaUpper > EPSILON) {
				results.push({
					drillId: hit.id,
					layer,
					plating: hit.plating,
					centerMm: [hit.xMm, hit.yMm],
					diameterMm: hit.diameterMm,
					intersection: areaLower > EPSILON ? 'confirmed' : 'possible',
					overlapAreaMm2: [areaLower, areaUpper].map(value => value / (MM_TO_MIL * MM_TO_MIL)),
					pasteBasis: args.pasteBasis,
					manufacturingStencil: args.pasteBasis === 'stencil-file' ? 'file-geometry-only' : 'not-provided',
				});
			}
		}
		if (['GTP', 'GBP'].some(layer => !layerState.get(layer as 'GTP' | 'GBP')?.ok))
			skipped.push({ id: hit.id, reason: '顶底两个锡膏层未全部核实' });
	}
	const checkedLayers = (['GTP', 'GBP'] as const).filter(layer => layerState.get(layer)?.ok);
	const checkedDrillCount = checkedLayers.length ? validDrills.length : 0;
	return {
		scope: 'panel-drill-to-paste-overlap',
		complete: skipped.length === 0 && args.drillHits.length > 0,
		units: { input: 'mm', output: 'mm2' },
		pasteBasis: args.pasteBasis,
		manufacturingStencil: args.pasteBasis === 'stencil-file' ? 'file-geometry-only' : 'not-provided',
		checkedDrillCount,
		checkedDrillCountByLayer: {
			GTP: layerState.get('GTP')?.ok ? validDrills.length : 0,
			GBP: layerState.get('GBP')?.ok ? validDrills.length : 0,
		},
		results,
		skipped,
	};
}

function segmentDistance(pointValue: Point, a: Point, b: Point) {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared ? Math.max(0, Math.min(1, ((pointValue[0] - a[0]) * dx + (pointValue[1] - a[1]) * dy) / lengthSquared)) : 0;
	return Math.hypot(pointValue[0] - (a[0] + t * dx), pointValue[1] - (a[1] + t * dy));
}

function boardEdgeDistance(hit: PanelDrillHit, outline: readonly PanelOutlinePath[]) {
	let nearest = Number.POSITIVE_INFINITY;
	const pointValue: Point = [hit.xMm, hit.yMm];
	for (const path of outline) {
		for (let index = 1; index < path.pointsMm.length; index++)
			nearest = Math.min(nearest, segmentDistance(pointValue, path.pointsMm[index - 1], path.pointsMm[index]));
	}
	return nearest;
}

export function identifyMouseBiteCandidates(args: {
	drillHits: readonly PanelDrillHit[];
	boardOutlineMm: readonly PanelOutlinePath[];
	copperLayers: readonly GerberLayerGeometry<CopperGerberLayerName>[];
	maximumEdgeDistanceMm?: number;
}) {
	const validOutline = args.boardOutlineMm.length > 0 && args.boardOutlineMm.every(path =>
		path.id && path.pointsMm.length >= 4 && path.pointsMm.every(point => point.every(Number.isFinite))
		&& Math.hypot(path.pointsMm[0][0] - path.pointsMm.at(-1)![0], path.pointsMm[0][1] - path.pointsMm.at(-1)![1]) <= EPSILON,
	);
	const candidates = (validOutline ? args.drillHits : []).filter(hit => hit.plating === 'NON_PLATED'
		&& Number.isFinite(hit.diameterMm) && hit.diameterMm > 0
		&& [hit.xMm, hit.yMm].every(Number.isFinite));
	const edgeLimitMm = args.maximumEdgeDistanceMm ?? 2;
	const uniqueRows: Array<{
		ids: string[];
		axis: 'horizontal' | 'vertical';
		pitchMm: number;
		endpointDistancesMm: [number, number];
		maximumDistanceMm: number;
	}> = [];
	for (const axis of ['horizontal', 'vertical'] as const) {
		const along = axis === 'horizontal' ? (hit: PanelDrillHit) => hit.xMm : (hit: PanelDrillHit) => hit.yMm;
		const across = axis === 'horizontal' ? (hit: PanelDrillHit) => hit.yMm : (hit: PanelDrillHit) => hit.xMm;
		const sorted = [...candidates].sort((first, second) => across(first) - across(second) || along(first) - along(second));
		for (let bandStart = 0; bandStart < sorted.length;) {
			let bandEnd = bandStart + 1;
			while (bandEnd < sorted.length && across(sorted[bandEnd]) - across(sorted[bandStart]) <= 0.02)
				bandEnd++;
			const band = sorted.slice(bandStart, bandEnd).sort((first, second) => along(first) - along(second));
			let run: PanelDrillHit[] = [];
			const addRun = () => {
				if (run.length >= 4) {
					const gaps = run.slice(1).map((hit, index) => along(hit) - along(run[index]));
					const pitchMm = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
					const pitchToleranceMm = Math.max(0.02, pitchMm * 0.02);
					const sameDiameter = run.every(hit => Math.abs(hit.diameterMm - run[0].diameterMm) <= 0.005);
					const uniformPitch = gaps.every(gap => Math.abs(gap - pitchMm) <= pitchToleranceMm);
					if (sameDiameter && uniformPitch) {
						const ids = run.map(hit => hit.id).sort();
						const endpointDistancesMm: [number, number] = [
							boardEdgeDistance(run[0], args.boardOutlineMm),
							boardEdgeDistance(run.at(-1)!, args.boardOutlineMm),
						];
						if (endpointDistancesMm.every(distance => distance <= edgeLimitMm)) {
							uniqueRows.push({
								ids,
								axis,
								pitchMm,
								endpointDistancesMm,
								maximumDistanceMm: Math.max(...run.map(hit => boardEdgeDistance(hit, args.boardOutlineMm))),
							});
						}
					}
				}
				run = [];
			};
			for (const hit of band) {
				if (run.length) {
					const gap = along(hit) - along(run.at(-1)!);
					if (gap < 0.5 || gap > 1.5 || Math.abs(hit.diameterMm - run[0].diameterMm) > 0.005)
						addRun();
				}
				run.push(hit);
			}
			addRun();
			bandStart = bandEnd;
		}
	}
	const edgeLimitedRows = uniqueRows;
	const covered = new Set(edgeLimitedRows.flatMap(row => row.ids));
	const copperNames = args.copperLayers.map(layer => layer.layer);
	const copperComplete = copperNames.filter(layer => layer === 'GTL').length === 1
		&& copperNames.filter(layer => layer === 'GBL').length === 1
		&& new Set(copperNames).size === copperNames.length
		&& args.copperLayers.every(layer =>
			['GTL', 'GBL'].includes(layer.layer) || /^G\d+$/.test(layer.layer)
				? layer.complete && !layer.unknowns.length && !layer.unsupported.length && !layer.arcApproximationLimited
				: false,
		);
	const copperPaint = new Map(args.copperLayers.filter(layer => layer.complete && !layer.unknowns.length && !layer.unsupported.length)
		.map(layer => [layer.layer, indexGeometry(paint(layer).upper)]));
	const copperOverlapIds = new Set<string>();
	for (const hit of candidates) {
		const centerMil: Point = [hit.xMm * MM_TO_MIL, hit.yMm * MM_TO_MIL];
		const radiusMil = hit.diameterMm * MM_TO_MIL / 2;
		const disk = circle(centerMil, radiusMil, true);
		if ([...copperPaint.values()].some(pieces =>
			piecesOverlappingCircle(pieces, centerMil, radiusMil).some(piece => area(intersect(disk, [piece])) > EPSILON))) {
			copperOverlapIds.add(hit.id);
		}
	}
	return {
		scope: 'panel-npth-mouse-bite-candidate-review',
		complete: false,
		geometry: 'drill centers in mm compared with supplied closed GKO paths',
		rowPatternScope: 'horizontal and vertical rows only: at least four non-plated holes, same diameter within 0.005 mm, 0.5-1.5 mm pitch, per-gap uniformity within max(0.02 mm, 2% of mean pitch), both row endpoints within the edge-distance limit; angled rows and other patterns remain unclassified',
		outlineComplete: validOutline,
		copperCoverage: copperComplete ? 'copper Gerber parsed, drill-to-copper clearance not assessed' : 'incomplete',
		candidates: edgeLimitedRows.map(({ ids, axis, pitchMm, endpointDistancesMm, maximumDistanceMm }) => {
			const overlappingIds = ids.filter(id => copperOverlapIds.has(id));
			return {
				classification: 'periodic-npth-row-near-edge-candidate',
				status: overlappingIds.length ? 'review-copper-overlap' : copperComplete ? 'candidate-awaiting-review' : 'copper-coverage-incomplete',
				drillIds: ids,
				drills: ids.map((id) => {
					const hit = args.drillHits.find(drill => drill.id === id)!;
					return { id: hit.id, centerMm: [hit.xMm, hit.yMm], diameterMm: hit.diameterMm };
				}),
				axis,
				pitchMm,
				endpointDistancesToPanelOrBoardEdgeMm: endpointDistancesMm,
				maximumDistanceToPanelOrBoardEdgeMm: maximumDistanceMm,
				reason: `先按同孔径、近似等节距识别整排无镀层孔，再检查两端孔到板框或锣槽均不超过${edgeLimitMm} mm；中间孔允许离轮廓更远，仍只是候选，需人工确认`,
				copperOverlapIds: overlappingIds,
				copperEvidence: overlappingIds.length
					? '孔盘圆形区域与铜图形有直接交叠，需核对'
					: copperComplete ? '孔盘区域未见铜重叠，周边净空未检查' : '铜层几何覆盖不完整，铜关系未确认',
			};
		}),
		unclassifiedNonPlated: args.drillHits.filter(hit => hit.plating === 'NON_PLATED' && !covered.has(hit.id)).map(hit => ({
			id: hit.id,
			centerMm: [hit.xMm, hit.yMm],
			nearestEdgeDistanceMm: boardEdgeDistance(hit, args.boardOutlineMm),
			reason: '未证明其为周期性板边孔列',
		})),
		unclassifiedPlatedCount: args.drillHits.filter(hit => hit.plating === 'PLATED').length,
	};
}
