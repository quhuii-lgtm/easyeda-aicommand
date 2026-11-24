import type { GerberLayerGeometry, GerberShape } from './silkscreenGerber';
import clipping from './autoCopper/upstream/polygon-clipping.js';

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];
type Side = 'top' | 'bottom';
type MaskLayer = GerberLayerGeometry<'GTS' | 'GBS'>;

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
interface Component { index: number; polygon: Polygon; bounds: Bounds }
interface PairWitness { firstOpening: number; secondOpening: number; distanceMil: number; firstPointMil: Point; secondPointMil: Point }
interface MeasuredPair extends PairWitness { lowerBoundMil: number; upperBoundMil?: number; confirmedPair: boolean }
interface MaskBridgeFinding extends MeasuredPair { classification: 'confirmed-below-threshold' | 'possible-below-threshold' }

export interface MaskBridgeLayerReport {
	layer: 'GTS' | 'GBS';
	side: Side;
	fileName: string;
	openingCount: number;
	closestPair?: MeasuredPair;
	findings: MaskBridgeFinding[];
	units: 'mil';
	complete: boolean;
	status: 'measured' | 'potential' | 'incomplete';
	uncertainties: string[];
	netRelationship: 'unknown';
}

export interface MaskBridgeReport {
	scope: 'exported-gerber-mask-opening-geometry';
	complete: boolean;
	thresholdMil?: number;
	layers: MaskBridgeLayerReport[];
	unknowns: string[];
	coverage: {
		requiresFinalGerber: true;
		netRelationship: 'unknown-without-separately-verified-source-attribution';
	};
}

function merge(shapes: GerberShape[], bound: 'geometryLower' | 'geometryUpper', check?: () => void): MultiPolygon {
	let state: MultiPolygon = [];
	for (let index = 0; index < shapes.length;) {
		check?.();
		const polarity = shapes[index].polarity;
		const run: GerberShape[] = [];
		while (index < shapes.length && shapes[index].polarity === polarity)
			run.push(shapes[index++]);
		const nonEmpty = run.map(shape => shape[bound]).filter(polygon => polygon.length > 0);
		const painted = nonEmpty.length ? clipping.union(...nonEmpty) as MultiPolygon : [];
		if (polarity === 'dark')
			state = state.length ? clipping.union(state, painted) as MultiPolygon : painted;
		else if (state.length && painted.length)
			state = clipping.difference(state, painted) as MultiPolygon;
	}
	check?.();
	return state;
}

function polygonBounds(polygon: Polygon): Bounds | undefined {
	const points = polygon.flat();
	if (!points.length || points.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1])))
		return undefined;
	return {
		minX: Math.min(...points.map(point => point[0])),
		minY: Math.min(...points.map(point => point[1])),
		maxX: Math.max(...points.map(point => point[0])),
		maxY: Math.max(...points.map(point => point[1])),
	};
}

function components(polygons: MultiPolygon): { items: Component[]; invalid: number } {
	const items: Component[] = [];
	let invalid = 0;
	for (const [index, polygon] of polygons.entries()) {
		const bounds = polygonBounds(polygon);
		if (!bounds || polygon.some(ring => ring.length < 4)) {
			invalid++;
			continue;
		}
		items.push({ index, polygon, bounds });
	}
	return { items, invalid };
}

function pointSegmentDistance(point: Point, a: Point, b: Point): { distance: number; nearest: Point } {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
	const nearest: Point = [a[0] + t * dx, a[1] + t * dy];
	return { distance: Math.hypot(point[0] - nearest[0], point[1] - nearest[1]), nearest };
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
	const epsilon = 1e-9;
	return point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon
		&& point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const abC = orientation(a, b, c);
	const abD = orientation(a, b, d);
	const cdA = orientation(c, d, a);
	const cdB = orientation(c, d, b);
	const epsilon = 1e-9;
	if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
		&& ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) {
		return true;
	}
	return (Math.abs(abC) <= epsilon && onSegment(a, b, c))
		|| (Math.abs(abD) <= epsilon && onSegment(a, b, d))
		|| (Math.abs(cdA) <= epsilon && onSegment(c, d, a))
		|| (Math.abs(cdB) <= epsilon && onSegment(c, d, b));
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
	if (segmentsIntersect(a, b, c, d))
		return { distance: 0, first: a, second: a };
	const fromA = pointSegmentDistance(a, c, d);
	const fromB = pointSegmentDistance(b, c, d);
	const fromC = pointSegmentDistance(c, a, b);
	const fromD = pointSegmentDistance(d, a, b);
	const candidates: Array<{ distance: number; first: Point; second: Point }> = [
		{ distance: fromA.distance, first: a, second: fromA.nearest },
		{ distance: fromB.distance, first: b, second: fromB.nearest },
		{ distance: fromC.distance, first: fromC.nearest, second: c },
		{ distance: fromD.distance, first: fromD.nearest, second: d },
	];
	const best = candidates.reduce((current, item) => item.distance < current.distance ? item : current);
	return best;
}

function nearestPair(first: Component, second: Component, check?: () => void): PairWitness {
	let best: PairWitness = {
		firstOpening: first.index,
		secondOpening: second.index,
		distanceMil: Infinity,
		firstPointMil: [0, 0],
		secondPointMil: [0, 0],
	};
	for (const firstRing of first.polygon) {
		for (let firstIndex = 1; firstIndex < firstRing.length; firstIndex++) {
			check?.();
			const a = firstRing[firstIndex - 1];
			const b = firstRing[firstIndex];
			for (const secondRing of second.polygon) {
				for (let secondIndex = 1; secondIndex < secondRing.length; secondIndex++) {
					const c = secondRing[secondIndex - 1];
					const d = secondRing[secondIndex];
					const result = segmentDistance(a, b, c, d);
					if (result.distance < best.distanceMil) {
						best = { firstOpening: first.index, secondOpening: second.index, distanceMil: result.distance, firstPointMil: result.first, secondPointMil: result.second };
					}
				}
			}
		}
	}
	return best;
}

function boxDistance(a: Bounds, b: Bounds): number {
	const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
	const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
	return Math.hypot(dx, dy);
}

function closestPair(polygons: MultiPolygon, check?: () => void) {
	const { items, invalid } = components(polygons);
	const sorted = [...items].sort((a, b) => a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY);
	let best: PairWitness | undefined;
	for (let index = 0; index < sorted.length; index++) {
		check?.();
		const first = sorted[index];
		for (let next = index + 1; next < sorted.length; next++) {
			const second = sorted[next];
			if (best && second.bounds.minX - first.bounds.maxX > best.distanceMil)
				break;
			if (best && boxDistance(first.bounds, second.bounds) > best.distanceMil)
				continue;
			const candidate = nearestPair(first, second, check);
			if (!best || candidate.distanceMil < best.distanceMil)
				best = candidate;
		}
	}
	return { best, openingCount: items.length, invalid };
}

function pairsWithinThreshold(outer: MultiPolygon, inner: MultiPolygon, thresholdMil: number, complete: boolean, check?: () => void) {
	const outerComponents = components(outer).items;
	const innerComponents = new Map(components(inner).items.map(item => [item.index, item]));
	const sorted = [...outerComponents].sort((a, b) => a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY);
	const findings: MaskBridgeFinding[] = [];
	for (let index = 0; index < sorted.length; index++) {
		check?.();
		const first = sorted[index];
		for (let next = index + 1; next < sorted.length; next++) {
			const second = sorted[next];
			if (second.bounds.minX - first.bounds.maxX > thresholdMil)
				break;
			if (boxDistance(first.bounds, second.bounds) > thresholdMil)
				continue;
			const lowerBound = nearestPair(first, second, check);
			if (lowerBound.distanceMil > thresholdMil)
				continue;
			const firstInner = innerComponents.get(first.index);
			const secondInner = innerComponents.get(second.index);
			const upperBound = firstInner && secondInner ? nearestPair(firstInner, secondInner, check) : undefined;
			const stable = Boolean(upperBound && Math.abs(upperBound.distanceMil - lowerBound.distanceMil) <= 0.05);
			findings.push({
				...lowerBound,
				lowerBoundMil: lowerBound.distanceMil,
				...(upperBound ? { upperBoundMil: upperBound.distanceMil } : {}),
				confirmedPair: stable,
				classification: complete && stable && upperBound && upperBound.distanceMil < thresholdMil
					? 'confirmed-below-threshold'
					: 'possible-below-threshold',
			});
		}
	}
	return findings.sort((a, b) => a.lowerBoundMil - b.lowerBoundMil);
}

function layerReport(layer: MaskLayer, options: { thresholdMil?: number; check?: () => void }): MaskBridgeLayerReport {
	const uncertainties: string[] = [];
	if (!layer.complete)
		uncertainties.push('Gerber层解析不完整');
	if (layer.unknowns.length)
		uncertainties.push(...layer.unknowns.map(issue => `Gerber解析未知：${issue}`));
	if (layer.unsupported.length)
		uncertainties.push(...layer.unsupported.map(issue => `Gerber包含未支持内容：${issue}`));
	if (layer.arcApproximationLimited)
		uncertainties.push('圆弧近似达到分段上限');
	const upperPaint = merge(layer.shapes, 'geometryUpper', options.check);
	const lowerPaint = merge(layer.shapes, 'geometryLower', options.check);
	const upper = closestPair(upperPaint, options.check);
	const lower = closestPair(lowerPaint, options.check);
	if (upper.invalid || lower.invalid)
		uncertainties.push('部分开窗多边形无效，最近距离未能完整枚举');
	if (upper.openingCount !== lower.openingCount)
		uncertainties.push('开窗几何上下界的连通分量不同');
	const complete = layer.complete && uncertainties.length === 0;
	const upperMil = upper.best?.distanceMil;
	const lowerMil = lower.best?.distanceMil;
	const pairStable = Boolean(lower.best && upper.best
		&& lower.best.firstOpening === upper.best.firstOpening
		&& lower.best.secondOpening === upper.best.secondOpening
		&& Math.abs(lower.best.distanceMil - upper.best.distanceMil) <= 0.05);
	const confirmed = complete && pairStable;
	if (upper.best && !pairStable)
		uncertainties.push('最近开窗对在几何上下界间变化，不能确认同一对距离');
	const findings = options.thresholdMil === undefined
		? []
		: pairsWithinThreshold(upperPaint, lowerPaint, options.thresholdMil, complete, options.check);
	return {
		layer: layer.layer,
		side: layer.layer === 'GTS' ? 'top' : 'bottom',
		fileName: layer.fileName,
		openingCount: upper.openingCount,
		...(upper.best
			? { closestPair: {
					...upper.best,
					lowerBoundMil: upperMil!,
					upperBoundMil: lowerMil,
					confirmedPair: pairStable,
				} }
			: {}),
		findings,
		units: 'mil',
		complete,
		status: !complete ? 'incomplete' : !upper.best ? 'measured' : confirmed ? 'measured' : 'potential',
		uncertainties,
		netRelationship: 'unknown',
	};
}

/** Measures minimum separation between final solder-mask openings from exported Gerber. */
export function analyzeGerberMaskBridges(
	layers: Array<GerberLayerGeometry<'GTS' | 'GBS'>>,
	options: { minimumBridgeMil?: number; check?: () => void } = {},
): MaskBridgeReport {
	if (!Array.isArray(layers))
		throw new TypeError('Gerber层必须是数组');
	if (options.minimumBridgeMil !== undefined && (!Number.isFinite(options.minimumBridgeMil) || options.minimumBridgeMil < 0))
		throw new TypeError('minimumBridgeMil必须为有限非负mil数值');
	const unknowns: string[] = [];
	const reports: MaskBridgeLayerReport[] = [];
	for (const layer of layers) {
		options.check?.();
		if (layer.layer !== 'GTS' && layer.layer !== 'GBS') {
			unknowns.push(`跳过非阻焊层 ${layer.layer}`);
			continue;
		}
		if (reports.some(report => report.layer === layer.layer)) {
			unknowns.push(`阻焊层 ${layer.layer}重复`);
			continue;
		}
		reports.push(layerReport(layer, { thresholdMil: options.minimumBridgeMil, check: options.check }));
	}
	for (const name of ['GTS', 'GBS'] as const) {
		if (!reports.some(report => report.layer === name))
			unknowns.push(`阻焊层 ${name}缺失`);
	}
	return {
		scope: 'exported-gerber-mask-opening-geometry',
		complete: reports.length === 2 && reports.every(report => report.complete) && unknowns.length === 0,
		...(options.minimumBridgeMil === undefined ? {} : { thresholdMil: options.minimumBridgeMil }),
		layers: reports,
		unknowns,
		coverage: { requiresFinalGerber: true, netRelationship: 'unknown-without-separately-verified-source-attribution' },
	};
}
