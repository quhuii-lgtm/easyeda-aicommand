import JSZip from 'jszip';
import clipping from './autoCopper/upstream/polygon-clipping.js';
import type { FootprintPadMaskCandidate, FootprintPadMaskCandidateReport, FootprintSilkResult, FootprintSilkStroke } from '../engine/footprintSilkscreen';

type Point = [number, number];
type Ring = Point[];
type MultiPolygon = Ring[][];
type BBox = { minX: number; minY: number; maxX: number; maxY: number };
type CirclePadMaskCandidate = Extract<FootprintPadMaskCandidate, { sourcePad: { shape: 'ELLIPSE' } }>;
function isCirclePadMaskCandidate(candidate: FootprintPadMaskCandidate): candidate is CirclePadMaskCandidate {
	return candidate.sourcePad.shape === 'ELLIPSE';
}
type OvalPadMaskCandidate = Extract<FootprintPadMaskCandidate, { sourcePad: { shape: 'OVAL' } }>;
function isOvalPadMaskCandidate(candidate: FootprintPadMaskCandidate): candidate is OvalPadMaskCandidate { return candidate.sourcePad.shape === 'OVAL'; }
type Polarity = 'dark' | 'clear';
interface Aperture { id: number; shape: 'C' | 'R' | 'O' | 'RoundRect' | 'Oval' | 'Rect' | 'unsupported'; parameters: number[]; rawShape: string; circleDiameterToken?: string }
export interface GerberArcApproximation {
	start: Point;
	end: Point;
	center: Point;
	radiusMil: number;
	sweepDegrees: number;
	radiusResidualMil: number;
	maxSagittaMil: number;
	/** Centerline-model compensation delta + sagitta + numeric margin; excludes capsule-cap polygon approximation error. Final ink bounds come from inner/outer geometry inclusion. */
	maxEnvelopeErrorMil: number;
	segmentCount: number;
}
export interface GerberShape { kind: 'stroke' | 'flash' | 'region'; polarity: Polarity; apertureId?: number; centerline?: Point[]; flashCenterMil?: Point; circleDiameterToken?: string; arcApproximation?: GerberArcApproximation; geometryLower: MultiPolygon; geometryUpper: MultiPolygon }
export type GerberLayerName = 'GTO' | 'GBO' | 'GTS' | 'GBS' | 'GKO';
export interface GerberLayerGeometry {
	layer: GerberLayerName;
	fileName: string;
	contentBytes: number;
	complete: boolean;
	units: 'mil';
	format: { coordinateFormat: string; absolute: boolean; sourceUnits: 'mm' | 'in' | 'unknown' };
	counts: { draws: number; moves: number; flashes: number; regions: number; regionContours: number; dark: number; clear: number };
	arcApproximation: { arcCount: number; maxRadiusResidualMil: number; maxSagittaMil: number; maxEnvelopeErrorMil: number };
	shapes: GerberShape[];
	boardOutline: Point[][];
	unknowns: string[];
	unsupported: string[];
	usedMacros: string[];
	arcApproximationLimited: boolean;
	apertures: Array<{ id: number; shape: Aperture['shape']; rawShape: string; parameters: number[] }>;
}
type LayerParse = GerberLayerGeometry;

export interface GerberConflict {
	category: 'silk-to-mask-opening' | 'silk-to-board-edge' | 'silk-outside-board';
	layer: 'top' | 'bottom';
	thresholdMil: number;
	distanceLowerBoundMil?: number;
	distanceUpperBoundMil?: number;
	status: 'confirmed' | 'potential';
	confirmed: boolean;
	method: 'polygon-inner-outer-bounds';
	locationBoundsMil?: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
	locationUnavailable?: boolean;
	locationUnavailableReason?: string;
	locationTruncated?: boolean;
	locationKind?: 'distance-witness';
	locationEnumerationComplete?: false;
	locationWitness?: { distanceBound: 'lower'; silkGeometry: 'outer-envelope'; kind: 'intersection' | 'contained-point' | 'nearest-points'; silkPointMil: Point; boardPointMil: Point; measuredDistanceMil: number };
}

export interface GerberSilkscreenReport {
	scope: 'exported-manufacturing-only';
	complete: boolean;
	clearanceThresholdMil: number;
	polygonApproximation: { targetSagittaMil: number; numericAreaEpsilonMil2: number; numericDistanceMarginMil: number; maxArcSegments: number; usedMaximumSegments: boolean };
	arcApproximation: { arcCount: number; maxRadiusResidualMil: number; maxSagittaMil: number; maxEnvelopeErrorMil: number };
	files: Array<{
		layer: GerberLayerName;
		fileName: string;
		contentBytes: number;
		complete: boolean;
		units: 'mil';
		format: LayerParse['format'];
		counts: LayerParse['counts'];
		arcApproximation: LayerParse['arcApproximation'];
		boardOutlineBoundsMil?: { minX: number; minY: number; maxX: number; maxY: number };
		apertures: LayerParse['apertures'];
		usedMacros: string[];
		arcApproximationLimited: boolean;
		unknowns: string[];
		unsupported: string[];
	}>;
	confirmedConflicts: GerberConflict[];
	potentialConflicts: GerberConflict[];
	unknowns: string[];
	coverage: { boardOutline: 'single-simple-closed-loop' | 'incomplete'; supportedGerberSubset: string[]; excluded: string[] };
}

export interface FootprintArcBoardParticipationWitness {
	pointMil: Point;
	fullLowerContains: boolean;
	omittedShapeUpperContains: boolean;
	nearFullLowerBoundary: boolean;
	nearOmittedUpperBoundary: boolean;
}

export interface FootprintArcBoardParticipationResult {
	sourceIdentity: FootprintSilkStroke['sourceIdentity'];
	side: 'top' | 'bottom';
	sourceGeometryRelation: 'centerline-crosses-board-edge';
	sourceIntersectionPointsMil: Point[];
	manufacturingContribution: 'verified-at-witnesses' | 'not-verified';
	sourceMapping: 'geometry-correlated' | 'not-matched' | 'ambiguous-manufacturing-match' | 'geometry-match-uncertain';
	uniqueSourceAttribution: false;
	contactEnumerationComplete: false;
	witnesses: FootprintArcBoardParticipationWitness[];
	matchedManufacturingRefs: Array<{ layer: 'GTO' | 'GBO'; fileName: string; contentBytes: number; shapeIndex: number }>;
	uncertainManufacturingRefs: Array<{ layer: 'GTO' | 'GBO'; fileName: string; contentBytes: number; shapeIndex: number }>;
	unresolvedContactReason?: string;
	reason?: string;
}

export interface FootprintArcBoardParticipationReport {
	scope: 'exported-manufacturing-footprint-arc-board-participation';
	available: boolean;
	availableReason?: string;
	complete: false;
	checkedArcCount: number;
	results: FootprintArcBoardParticipationResult[];
	skipped: Array<{ sourceIdentity?: FootprintSilkStroke['sourceIdentity']; side?: 'top' | 'bottom'; reason: string }>;
}

export interface ManufacturingMaskShapeParticipationReference {
	layer: 'GTO' | 'GBO' | 'GTS' | 'GBS';
	fileName: string;
	contentBytes: number;
	shapeIndex: number;
}

export interface ManufacturingMaskShapeParticipation {
	reference: ManufacturingMaskShapeParticipationReference;
	geometryUpperContainsOrNearWitness: boolean;
	geometryLowerContainsWitness: boolean;
	geometryLowerEmpty: boolean;
	geometryLowerBoundaryMarginMil: number | null;
	omittedFinalUpperContainsWitness: boolean;
	omittedFinalUpperEmpty: boolean;
	omittedFinalUpperBoundaryMarginMil: number | null;
	necessaryAtWitness: boolean;
	reason?: string;
}

export interface ManufacturingMaskSideParticipation {
	layer: 'GTO' | 'GBO' | 'GTS' | 'GBS';
	darkUpperCandidateCount: number;
	uniqueDarkCoverage: boolean;
	darkUpperCandidates: ManufacturingMaskShapeParticipation[];
	necessaryContributorCount: number;
	necessaryContributorRefs: ManufacturingMaskShapeParticipationReference[];
	necessaryContribution: boolean;
	reason?: string;
}

export interface ManufacturingMaskOverlapParticipationResult {
	conflictBucket: 'confirmed';
	conflictIndex: number;
	areaIndex: number;
	layer: 'top' | 'bottom';
	locationBoundsMil: BBox;
	locationTruncated: boolean;
	witnessCandidateEnumerationComplete: boolean;
	uniqueSourceAttribution: false;
	contactEnumerationComplete: false;
	manufacturingContribution: 'verified-at-witnesses' | 'not-verified';
	witness?: {
		pointMil: Point;
		overlapLowerContains: boolean;
		silkLowerContains: boolean;
		maskLowerContains: boolean;
		overlapBoundaryMarginMil: number;
		silkLowerBoundaryMarginMil: number;
		maskLowerBoundaryMarginMil: number;
		silk: ManufacturingMaskSideParticipation;
		mask: ManufacturingMaskSideParticipation;
	};
	reason?: string;
}

export interface ManufacturingMaskOverlapParticipationReport {
	scope: 'exported-manufacturing-silkscreen-mask-overlap-participation';
	available: boolean;
	unavailableReason?: string;
	complete: false;
	skipped: Array<{ conflictBucket: 'confirmed'; conflictIndex: number; areaIndex: number | null; reason: string }>;
	results: ManufacturingMaskOverlapParticipationResult[];
}

export interface PadMaskOpeningAssociationMatch {
	sourceIdentity: FootprintSilkStroke['sourceIdentity'];
	runtimePadId: string;
	padNumber: string;
	side: 'top' | 'bottom';
	sourcePadModel: FootprintPadMaskCandidateReport['candidates'][number]['sourcePad'];
	association: 'geometry-correlated' | 'not-matched' | 'ambiguous' | 'geometry-match-uncertain' | 'model-predicted-closed';
	uniqueSourceAttribution: false;
	maskReferences: ManufacturingMaskShapeParticipationReference[];
	necessaryMaskReferences: ManufacturingMaskShapeParticipationReference[];
	geometryChecks:
		| { roundRectOnly: true; flashCenterMatched: boolean; allFourCoreCornersMatched: boolean; positiveRadiusMatched: boolean; formatSupported: boolean }
		| { pureRectOnly: true; flashCenterMatched: boolean; dimensionsMatched: boolean; angleMatched: boolean; formatSupported: boolean }
		| { circleOnly: true; flashCenterMatched: boolean; positiveDiameterMatched: boolean; diameterRule: 'fixed-1e-5-mm-half-quantum' | 'exact-epsilon-only' | 'unverified-precision'; formatSupported: boolean }
		| { capsuleOnly: true; flashCenterMatched: boolean; endpointsMatched: boolean; positiveDiameterMatched: boolean; diameterRule: 'fixed-1e-5-mm-half-quantum' | 'exact-epsilon-only' | 'unverified-precision'; formatSupported: boolean };
	manufacturingOpeningStatus?: 'not-evaluated' | 'observed-no-positive-area-opening' | 'unattributed-opening-present' | 'geometry-match-uncertain';
	manufacturingOpeningScope?: 'source-copper-region';
	uncertainMaskReferences?: ManufacturingMaskShapeParticipationReference[];
	witnessLinks: Array<{ reference: ManufacturingMaskShapeParticipationReference; conflictIndex: number; areaIndex: number; pointMil: Point; insideCandidateMask: boolean }>;
	reason?: string;
}

export interface PadMaskOpeningAssociationReport {
	scope: 'manufacturing-pad-mask-opening-association';
	available: boolean;
	unavailableReason?: string;
	complete: false;
	sourceStable: boolean;
	uniqueSourceAttribution: false;
	modelAssumptions: string[];
	matches: PadMaskOpeningAssociationMatch[];
	skipped: Array<{ componentId?: string; padNumber?: string; reason: string }>;
}

const supportedFiles: Record<GerberLayerName, RegExp> = {
	GTO: /Gerber_TopSilkscreenLayer\.GTO$/iu,
	GBO: /Gerber_BottomSilkscreenLayer\.GBO$/iu,
	GTS: /Gerber_TopSolderMaskLayer\.GTS$/iu,
	GBS: /Gerber_BottomSolderMaskLayer\.GBS$/iu,
	GKO: /Gerber_BoardOutlineLayer\.GKO$/iu,
};
const exactRoundRectMacro = '1,1,$1,$2,$3*1,1,$1,$4,$5*1,1,$1,0-$2,0-$3*1,1,$1,0-$4,0-$5*20,1,$1,$2,$3,$4,$5,0*20,1,$1,$4,$5,0-$2,0-$3,0*20,1,$1,0-$2,0-$3,0-$4,0-$5,0*20,1,$1,0-$4,0-$5,$2,$3,0*4,1,4,$2,$3,$4,$5,0-$2,0-$3,0-$4,0-$5,$2,$3,0';
const exactOvalMacro = '1,1,$1,$2,$3*1,1,$1,$4,$5*20,1,$1,$2,$3,$4,$5,0';
const exactRectMacro = '21,1,$1,$2,0,0,$3';
const MM_TO_MIL = 1000 / 25.4;
type GerberMmPrecisionMatch = 'quantized' | 'exact' | 'unknown' | 'mismatch';
function compareGerberFiveDigitMm(actual: number, expected: number): GerberMmPrecisionMatch {
	if (!Number.isFinite(actual) || !Number.isFinite(expected)) return 'mismatch';
	const floating = 8 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected));
	const quantum = 1e-5;
	const onGrid = Math.abs(actual - Math.round(actual / quantum) * quantum) <= floating;
	const difference = Math.abs(actual - expected);
	if (onGrid) return difference <= quantum / 2 + floating ? 'quantized' : 'mismatch';
	if (difference <= floating) return 'exact';
	return difference <= quantum / 2 + floating ? 'unknown' : 'mismatch';
}
const TARGET_SAGITTA_MIL = 0.01;
const NUMERIC_AREA_EPSILON_MIL2 = 1e-6;
const NUMERIC_DISTANCE_MARGIN_MIL = 0.01;
const MAX_AR_SEGMENTS = 4096;
const clippingApi = clipping as unknown as {
	union: (...polygons: any[]) => any;
	difference: (subject: any, ...clips: any[]) => any;
};

function bounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
	if (!points.length)
		return undefined;
	return {
		minX: Math.min(...points.map(([x]) => x)),
		minY: Math.min(...points.map(([, y]) => y)),
		maxX: Math.max(...points.map(([x]) => x)),
		maxY: Math.max(...points.map(([, y]) => y)),
	};
}
function polygonBounds(polygons: MultiPolygon, maxEntries = 8): { entries: Array<{ minX: number; minY: number; maxX: number; maxY: number }>; truncated: boolean } {
	const entries = polygons.map(poly => bounds(poly[0] ?? [])).filter((value): value is NonNullable<typeof value> => value !== undefined);
	return { entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
}

function point(x: number, y: number): Point {
	return [x, y];
}
function near(a: number, b: number, epsilon = 1e-8): boolean {
	return Math.abs(a - b) <= epsilon;
}
function samePoint(a: Point, b: Point): boolean {
	return near(a[0], b[0]) && near(a[1], b[1]);
}
function closeRing(points: Point[]): Ring {
	const result = points.map(([x, y]) => [x, y] as Point);
	if (result.length && !samePoint(result[0], result[result.length - 1]))
		result.push([...result[0]] as Point);
	return result;
}
function polygon(ring: Ring): MultiPolygon {
	return ring.length >= 4 ? [[ring]] : [];
}
function polygonUnion(polygons: MultiPolygon[]): MultiPolygon {
	const nonEmpty = polygons.filter(value => value.length > 0);
	if (!nonEmpty.length)
		return [];
	return clippingApi.union(...nonEmpty) as MultiPolygon;
}
function subtractPolygons(subject: MultiPolygon, clips: MultiPolygon): MultiPolygon {
	if (!subject.length || !clips.length)
		return subject;
	return clippingApi.difference(subject, clips) as MultiPolygon;
}
function intersectPolygons(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
	if (!a.length || !b.length)
		return [];
	const aWithoutB = clippingApi.difference(a, b) as MultiPolygon;
	if (!aWithoutB.length)
		return a;
	return clippingApi.difference(a, aWithoutB) as MultiPolygon;
}

function arcSegments(radius: number, maxSegments = MAX_AR_SEGMENTS): { count: number; limited: boolean } {
	if (!(radius > 0) || !Number.isFinite(radius))
		return { count: 16, limited: false };
	const ratio = Math.max(-1, Math.min(1, 1 - TARGET_SAGITTA_MIL / radius));
	const angle = Math.acos(ratio);
	const count = Math.max(16, Math.ceil(Math.PI * 2 / Math.max(angle, Math.PI / maxSegments)));
	return { count: Math.min(maxSegments, count), limited: count > maxSegments };
}
function circleRing(center: Point, radius: number, mode: 'inner' | 'outer', count: number): Ring {
	const step = Math.PI * 2 / count;
	const adjustedRadius = mode === 'inner' ? radius * Math.cos(step / 2) : radius / Math.cos(step / 2);
	return closeRing(Array.from({ length: count }, (_, i) => {
		const angle = i * step;
		return point(center[0] + adjustedRadius * Math.cos(angle), center[1] + adjustedRadius * Math.sin(angle));
	}));
}
function capsuleRing(a: Point, b: Point, radius: number, mode: 'inner' | 'outer', count: number): Ring {
	if (samePoint(a, b))
		return circleRing(a, radius, mode, count);
	const startAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
	const stepCount = Math.max(8, Math.ceil(count / 2));
	const step = Math.PI / stepCount;
	const adjustedRadius = mode === 'inner' ? radius * Math.cos(step / 2) : radius / Math.cos(step / 2);
	const points: Point[] = [];
	for (let i = 0; i <= stepCount; i++) {
		const angle = startAngle - Math.PI / 2 + i * step;
		points.push(point(b[0] + adjustedRadius * Math.cos(angle), b[1] + adjustedRadius * Math.sin(angle)));
	}
	for (let i = 0; i <= stepCount; i++) {
		const angle = startAngle + Math.PI / 2 + i * step;
		points.push(point(a[0] + adjustedRadius * Math.cos(angle), a[1] + adjustedRadius * Math.sin(angle)));
	}
	return closeRing(points);
}
function polygonUnionBatched(polygons: MultiPolygon[], checkBudget?: () => void): MultiPolygon {
	let remaining = polygons.filter(value => value.length > 0);
	while (remaining.length > 1) {
		const next: MultiPolygon[] = [];
		for (let index = 0; index < remaining.length; index += 32) {
			checkBudget?.();
			next.push(polygonUnion(remaining.slice(index, index + 32)));
		}
		remaining = next.filter(value => value.length > 0);
	}
	return remaining[0] ?? [];
}
function arcStrokeGeometry(start: Point, end: Point, center: Point, clockwise: boolean, fullCircle: boolean, halfWidth: number, checkBudget?: () => void): { lower: MultiPolygon; upper: MultiPolygon; approximation: GerberArcApproximation; limited: boolean } | undefined {
	const radiusA = Math.hypot(start[0] - center[0], start[1] - center[1]);
	const radiusB = Math.hypot(end[0] - center[0], end[1] - center[1]);
	const radiusResidualMil = Math.abs(radiusA - radiusB) / 2;
	const radius = (radiusA + radiusB) / 2;
	if (![radiusA, radiusB, radiusResidualMil, radius, halfWidth].every(Number.isFinite) || !(radiusA > 0 && radiusB > 0 && radius > 0 && halfWidth > 0))
		return undefined;
	const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
	const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
	const tau = Math.PI * 2;
	const mod = (value: number) => ((value % tau) + tau) % tau;
	const sweepRadians = fullCircle ? (clockwise ? -tau : tau) : clockwise ? -mod(startAngle - endAngle) : mod(endAngle - startAngle);
	if (!Number.isFinite(sweepRadians) || Math.abs(sweepRadians) <= 1e-14)
		return undefined;
	const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - TARGET_SAGITTA_MIL / radius)));
	if (!(maxStep > 0) || !Number.isFinite(maxStep))
		return undefined;
	const requiredSegments = Math.max(1, Math.ceil(Math.abs(sweepRadians) / maxStep));
	const limited = requiredSegments > MAX_AR_SEGMENTS;
	const segmentCount = Math.min(MAX_AR_SEGMENTS, requiredSegments);
	const maxSagittaMil = radius * (1 - Math.cos(Math.abs(sweepRadians) / (2 * segmentCount)));
	const maxEnvelopeErrorMil = radiusResidualMil + maxSagittaMil + NUMERIC_DISTANCE_MARGIN_MIL;
	if (![maxSagittaMil, maxEnvelopeErrorMil].every(Number.isFinite))
		return undefined;
	const projected: Point[] = [];
	for (let index = 0; index <= segmentCount; index++) {
		if ((index & 63) === 0)
			checkBudget?.();
		const angle = startAngle + sweepRadians * index / segmentCount;
		const next = point(center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle));
		if (!next.every(Number.isFinite))
			return undefined;
		projected.push(next);
	}
	if (fullCircle)
		projected[projected.length - 1] = [...projected[0]];
	const upperRadius = halfWidth + maxEnvelopeErrorMil;
	const lowerRadius = halfWidth - maxEnvelopeErrorMil;
	if (!Number.isFinite(upperRadius) || !(upperRadius > 0))
		return undefined;
	const capSegments = arcSegments(upperRadius);
	const capCount = capSegments.count;
	const upperParts: MultiPolygon[] = [];
	const lowerParts: MultiPolygon[] = [];
	for (let index = 1; index < projected.length; index++) {
		if ((index & 31) === 0)
			checkBudget?.();
		upperParts.push(polygon(capsuleRing(projected[index - 1], projected[index], upperRadius, 'outer', capCount)));
		if (lowerRadius > 0)
			lowerParts.push(polygon(capsuleRing(projected[index - 1], projected[index], lowerRadius, 'inner', capCount)));
	}
	return {
		lower: polygonUnionBatched(lowerParts, checkBudget),
		upper: polygonUnionBatched(upperParts, checkBudget),
		approximation: { start: [...start], end: [...end], center: [...center], radiusMil: radius, sweepDegrees: sweepRadians * 180 / Math.PI, radiusResidualMil, maxSagittaMil, maxEnvelopeErrorMil, segmentCount },
		limited: limited || capSegments.limited,
	};
}
function rectFlash(center: Point, width: number, height: number): Ring {
	return closeRing([
		point(center[0] - width / 2, center[1] - height / 2),
		point(center[0] + width / 2, center[1] - height / 2),
		point(center[0] + width / 2, center[1] + height / 2),
		point(center[0] - width / 2, center[1] + height / 2),
	]);
}
function cross(a: Point, b: Point, c: Point): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function convexHull(points: Point[]): Point[] {
	const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const lower: Point[] = [];
	for (const p of sorted) {
		while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: Point[] = [];
	for (const p of [...sorted].reverse()) {
		while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
		upper.push(p);
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
function rectSweep(a: Point, b: Point, width: number, height: number): Ring {
	const cornersA = rectFlash(a, width, height).slice(0, -1);
	const cornersB = rectFlash(b, width, height).slice(0, -1);
	return closeRing(convexHull([...cornersA, ...cornersB]));
}
function roundRectMacroGeometry(center: Point, p1: Point, p2: Point, radius: number, count: number): { lower: MultiPolygon; upper: MultiPolygon } | undefined {
	const determinant = p1[0] * p2[1] - p1[1] * p2[0];
	const scale = Math.max(...p1.map(Math.abs), ...p2.map(Math.abs));
	if (![...center, ...p1, ...p2, radius, determinant, scale].every(Number.isFinite) || !(radius > 0 && scale > 0))
		return undefined;
	if (Math.abs(determinant) <= Number.EPSILON * scale * scale * 16)
		return undefined;
	const local = [p1, p2, [-p1[0], -p1[1]] as Point, [-p2[0], -p2[1]] as Point];
	const turns = local.map((vertex, index) => cross(vertex, local[(index + 1) % 4], local[(index + 2) % 4]));
	if (!turns.every(value => Number.isFinite(value) && Math.sign(value) === Math.sign(determinant)))
		return undefined;
	const base = polygon(closeRing(local.map(([x, y]) => point(center[0] + x, center[1] + y))));
	const upperRadius = radius + NUMERIC_DISTANCE_MARGIN_MIL;
	const lowerRadius = radius - NUMERIC_DISTANCE_MARGIN_MIL;
	if (!Number.isFinite(upperRadius) || !(upperRadius > 0))
		return undefined;
	const capsuleCount = count;
	const outerCapsules: MultiPolygon[] = [];
	const innerCapsules: MultiPolygon[] = [];
	for (let index = 0; index < 4; index++) {
		const aLocal = local[index];
		const bLocal = local[(index + 1) % 4];
		const a = point(center[0] + aLocal[0], center[1] + aLocal[1]);
		const b = point(center[0] + bLocal[0], center[1] + bLocal[1]);
		if (![...a, ...b].every(Number.isFinite))
			return undefined;
		outerCapsules.push(polygon(capsuleRing(a, b, upperRadius, 'outer', capsuleCount)));
		if (lowerRadius > 0)
			innerCapsules.push(polygon(capsuleRing(a, b, lowerRadius, 'inner', capsuleCount)));
	}
	return {
		lower: polygonUnion([base, ...innerCapsules]),
		upper: polygonUnion([base, ...outerCapsules]),
	};
}

function parseNumberList(value: string): number[] | undefined {
	const values = value.split('X').map(Number);
	return values.length && values.every(Number.isFinite) ? values : undefined;
}
function tokenizeGerber(source: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < source.length) {
		if (/\s/u.test(source[index])) {
			index++;
			continue;
		}
		if (source[index] === '%') {
			const end = source.indexOf('%', index + 1);
			if (end < 0) {
				tokens.push(`UNKNOWN:${source.slice(index)}`);
				break;
			}
			tokens.push(`%${source.slice(index + 1, end)}%`);
			index = end + 1;
			continue;
		}
		const end = source.indexOf('*', index);
		if (end < 0) {
			tokens.push(`UNKNOWN:${source.slice(index)}`);
			break;
		}
		const token = source.slice(index, end).trim();
		if (token)
			tokens.push(token);
		index = end + 1;
	}
	return tokens;
}
function parseAperture(token: string, macroNames: Set<string>): Aperture | undefined {
	const match = token.match(/^%ADD(\d+)([A-Za-z][A-Za-z0-9]*)(?:,([^*]*))?%$/u);
	if (!match)
		return undefined;
	const id = Number(match[1]);
	const rawShape = match[2];
	const rawParams = match[3] ?? '';
	if (rawShape === 'C' || rawShape === 'R' || rawShape === 'O') {
		const parameters = parseNumberList(rawParams);
		return { id, shape: rawShape, parameters: parameters ?? [], rawShape, ...(rawShape === 'C' && parameters?.length === 1 ? { circleDiameterToken: rawParams } : {}) };
	}
	if (macroNames.has(rawShape) && rawShape === 'RoundRect') {
		const parameters = parseNumberList(rawParams);
		return { id, shape: 'RoundRect', parameters: parameters ?? [], rawShape };
	}
	if (macroNames.has(rawShape) && rawShape === 'Oval') {
		const values = rawParams.split('X');
		const parameters = values.length === 5 && values.every(value => value.trim() !== '' && Number.isFinite(Number(value))) ? values.map(Number) : undefined;
		return { id, shape: 'Oval', parameters: parameters ?? [], rawShape };
	}
	if (macroNames.has(rawShape) && rawShape === 'Rect') {
		const values = rawParams.split('X');
		const parameters = values.length === 3 && values.every(value => value.trim() !== '' && Number.isFinite(Number(value))) ? values.map(Number) : undefined;
		return { id, shape: 'Rect', parameters: parameters ?? [], rawShape };
	}
	return { id, shape: 'unsupported', parameters: parseNumberList(rawParams) ?? [], rawShape };
}
function shapeGeometry(aperture: Aperture, start: Point, end: Point, mode: 'flash' | 'stroke', segments: number): { lower: MultiPolygon; upper: MultiPolygon; centerline?: Point[] } | undefined {
	if (aperture.shape === 'C') {
		const diameter = aperture.parameters[0] * MM_TO_MIL;
		if (!(diameter > 0))
			return undefined;
		if (mode === 'flash')
			return { lower: polygon(circleRing(start, diameter / 2, 'inner', segments)), upper: polygon(circleRing(start, diameter / 2, 'outer', segments)) };
		return { lower: polygon(capsuleRing(start, end, diameter / 2, 'inner', segments)), upper: polygon(capsuleRing(start, end, diameter / 2, 'outer', segments)), centerline: [start, end] };
	}
	if (aperture.shape === 'R') {
		const width = aperture.parameters[0] * MM_TO_MIL;
		const height = aperture.parameters[1] * MM_TO_MIL;
		if (!(width > 0 && height > 0))
			return undefined;
		const ring = mode === 'flash' ? rectFlash(start, width, height) : rectSweep(start, end, width, height);
		return { lower: polygon(ring), upper: polygon(ring), centerline: mode === 'stroke' ? [start, end] : undefined };
	}
	if (aperture.shape === 'Rect') {
		if (mode !== 'flash' || aperture.parameters.length !== 3) return undefined;
		const [widthMm, heightMm, angleDegrees] = aperture.parameters;
		const width = widthMm * MM_TO_MIL; const height = heightMm * MM_TO_MIL;
		if (![width, height, angleDegrees].every(Number.isFinite) || !(width > 0 && height > 0)) return undefined;
		const angle = ((angleDegrees % 360) + 360) % 360;
		const radians = angle * Math.PI / 180;
		const cosine = Math.cos(radians); const sine = Math.sin(radians);
		const ring = rectFlash(point(0, 0), width, height).map(([x, y]) => point(start[0] + x * cosine - y * sine, start[1] + x * sine + y * cosine));
		if (![cosine, sine, ...ring.flat()].every(Number.isFinite)) return undefined;
		return { lower: polygon(ring), upper: polygon(ring) };
	}
	if (aperture.shape === 'RoundRect') {
		if (mode !== 'flash' || aperture.parameters.length !== 5)
			return undefined;
		const [diameterMm, x1Mm, y1Mm, x2Mm, y2Mm] = aperture.parameters;
		const d = diameterMm * MM_TO_MIL;
		const p1 = point(x1Mm * MM_TO_MIL, y1Mm * MM_TO_MIL);
		const p2 = point(x2Mm * MM_TO_MIL, y2Mm * MM_TO_MIL);
		const geom = roundRectMacroGeometry(start, p1, p2, d / 2, segments);
		if (!geom)
			return undefined;
		return geom;
	}
	if (aperture.shape === 'O' || aperture.shape === 'Oval') {
		if (mode !== 'flash' || aperture.shape === 'Oval' && aperture.parameters.length !== 5)
			return undefined;
		const [firstMm, secondMm] = aperture.parameters;
		let x1Mm = 0; let y1Mm = 0; let x2Mm = 0; let y2Mm = 0;
		if (aperture.shape === 'O') {
			if (firstMm >= secondMm) { x1Mm = -(firstMm - secondMm) / 2; x2Mm = (firstMm - secondMm) / 2; }
			else { y1Mm = -(secondMm - firstMm) / 2; y2Mm = (secondMm - firstMm) / 2; }
		}
		else [, x1Mm, y1Mm, x2Mm, y2Mm] = aperture.parameters;
		const p1 = point(start[0] + x1Mm * MM_TO_MIL, start[1] + y1Mm * MM_TO_MIL);
		const p2 = point(start[0] + x2Mm * MM_TO_MIL, start[1] + y2Mm * MM_TO_MIL);
		const radius = (aperture.shape === 'O' ? Math.min(firstMm, secondMm) : firstMm) * MM_TO_MIL / 2;
		if (!(radius > 0) || ![...p1, ...p2, radius].every(Number.isFinite)) return undefined;
		return { lower: polygon(capsuleRing(p1, p2, radius, 'inner', segments)), upper: polygon(capsuleRing(p1, p2, radius, 'outer', segments)) };
	}
	return undefined;
}

function isSimpleClosedRing(ring: Point[]): boolean {
	if (ring.length < 4 || !samePoint(ring[0], ring.at(-1)!))
		return false;
	const segments = ringSegments(ring);
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 1; j < segments.length; j++) {
			if (j === i + 1 || (i === 0 && j === segments.length - 1))
				continue;
			if (segmentDistance(...segments[i], ...segments[j]) <= 1e-9)
				return false;
		}
	}
	return Math.abs(ringArea(ring)) > 1e-9;
}
export function parseGerberLayerGeometry(layer: GerberLayerName, fileName: string, source: string, checkBudget?: () => void): LayerParse {
	const unknowns: string[] = [];
	const unsupported: string[] = [];
	const macroNames = new Set<string>();
	const macroBodies = new Map<string, string>();
	const apertures = new Map<number, Aperture>();
	const shapes: GerberShape[] = [];
	const boardOutline: Point[][] = [];
	const counts = { draws: 0, moves: 0, flashes: 0, regions: 0, regionContours: 0, dark: 0, clear: 0 };
	const arcApproximation = { arcCount: 0, maxRadiusResidualMil: 0, maxSagittaMil: 0, maxEnvelopeErrorMil: 0 };
	const tokens = tokenizeGerber(source);
	const formatDeclarations = tokens.map((token, index) => ({ index, match: token.match(/^%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%$/u) })).filter(item => item.match);
	const unitDeclarations = tokens.map((token, index) => ({ index, match: token.match(/^%MO(MM|IN)\*%$/u) })).filter(item => item.match);
	const firstGraphicIndex = tokens.findIndex((token) => {
		const coordinateCommand = /^(?:G\d+)?(?:[XYIJ][+-]?\d+)*(?:D0?[123])?$/u.test(token) && /[XYIJ]/u.test(token);
		return token === 'G36' || token === 'D03' || token === 'D3' || coordinateCommand;
	});
	const format = formatDeclarations[0]?.match;
	const units = unitDeclarations[0]?.match?.[1];
	if (!format || format[1] !== 'L' || format[2] !== 'A' || format[3] !== '4' || format[4] !== '5' || format[5] !== '4' || format[6] !== '5')
		unknowns.push('坐标格式不是已支持的FSLA45');
	if (units !== 'MM')
		unknowns.push('源单位不是已支持的毫米');
	const formatSignature = (match: RegExpMatchArray | null) => match?.slice(1).join('/') ?? '';
	if (formatDeclarations.some(item => formatSignature(item.match) !== formatSignature(format)))
		unsupported.push('FS声明互相冲突');
	if (unitDeclarations.some(item => item.match?.[1] !== units))
		unsupported.push('MO声明互相冲突');
	if (firstGraphicIndex >= 0 && formatDeclarations.some(item => item.index > firstGraphicIndex && formatSignature(item.match) !== formatSignature(format)))
		unsupported.push('绘制后FS格式发生变化');
	if (firstGraphicIndex >= 0 && unitDeclarations.some(item => item.index > firstGraphicIndex && item.match?.[1] !== units))
		unsupported.push('绘制后MO单位发生变化');
	if (firstGraphicIndex >= 0 && (formatDeclarations[0]?.index ?? -1) > firstGraphicIndex)
		unsupported.push('首次绘制前没有坐标格式声明');
	if (firstGraphicIndex >= 0 && (unitDeclarations[0]?.index ?? -1) > firstGraphicIndex)
		unsupported.push('首次绘制前没有单位声明');
	let currentPoint: Point = point(0, 0);
	let positionKnown = false;
	let currentAperture: Aperture | undefined;
	let currentOperation = 2;
	let plotMode: 'linear' | 'cw' | 'ccw' = 'linear';
	let quadrantMode: 'unset' | 'single' | 'multi' = 'unset';
	let currentPolarity: Polarity = 'dark';
	let regionOpen = false;
	let regionHasUnsupportedRecord = false;
	let regionContours: Point[][] = [];
	let activeContour: Point[] | undefined;
	let modalX: number | undefined;
	let modalY: number | undefined;
	let sawEnd = false;
	let tokenIndex = 0;
	let arcApproximationLimited = false;
	const addFlash = (target: Point) => {
		counts.flashes++;
		if (!positionKnown) {
			unsupported.push('D03没有当前坐标，无法确定闪光位置');
			return;
		}
		if (!currentAperture) {
			unsupported.push('D03前未选择光圈');
			return;
		}
		const segmentInfo = arcSegments(currentAperture.parameters[0] * MM_TO_MIL / 2);
		arcApproximationLimited ||= segmentInfo.limited;
		const geom = shapeGeometry(currentAperture, target, target, 'flash', segmentInfo.count);
		if (!geom)
			unsupported.push(`不支持D${currentAperture.id}的D03形状`);
		else shapes.push({ kind: 'flash', polarity: currentPolarity, apertureId: currentAperture.id, flashCenterMil: [...target], ...(currentAperture.shape === 'C' && currentAperture.parameters.length === 1 && currentAperture.circleDiameterToken !== undefined ? { circleDiameterToken: currentAperture.circleDiameterToken } : {}), geometryLower: geom.lower, geometryUpper: geom.upper });
	};
	for (const token of tokens) {
		if ((tokenIndex++ & 127) === 0)
			checkBudget?.();
		if (token.startsWith('G04'))
			continue;
		if (token === 'M02') {
			sawEnd = true;
			continue;
		}
		if (token.startsWith('%AM')) {
			const match = token.match(/^%AM([^*]+)\*([\s\S]*)%$/u);
			if (!match) {
				unsupported.push(`无法解析宏: ${token.slice(0, 60)}`);
				continue;
			}
			macroNames.add(match[1]);
			macroBodies.set(match[1], match[2].replace(/\s+/gu, '').replace(/\*$/u, ''));
			continue;
		}
		if (token.startsWith('%ADD')) {
			const aperture = parseAperture(token.replace(/\*%$/u, '%'), macroNames);
			if (!aperture) {
				unsupported.push(`无法解析光圈定义: ${token}`);
				continue;
			}
			const validAperture = aperture.shape === 'C'
				? aperture.parameters.length === 1 && aperture.parameters[0] > 0
				: aperture.shape === 'R'
					? aperture.parameters.length === 2 && aperture.parameters.every(value => value > 0)
					: aperture.shape === 'O'
						? aperture.parameters.length === 2 && aperture.parameters.every(value => Number.isFinite(value) && value > 0)
					: aperture.shape === 'RoundRect'
						? aperture.parameters.length === 5 && aperture.parameters.every(Number.isFinite) && aperture.parameters[0] > 0
						: aperture.shape === 'Oval'
							? aperture.parameters.length === 5 && aperture.parameters.every(Number.isFinite) && aperture.parameters[0] > 0
						: aperture.shape === 'Rect'
							? aperture.parameters.length === 3 && Number.isFinite(aperture.parameters[0]) && aperture.parameters[0] > 0 && Number.isFinite(aperture.parameters[1]) && aperture.parameters[1] > 0 && Number.isFinite(aperture.parameters[2])
						: aperture.parameters.length > 0 && aperture.parameters.every(Number.isFinite);
			if (!validAperture) {
				unsupported.push(`光圈 ${aperture.id} 参数数量、符号或值无效`);
				continue;
			}
			if (aperture.shape === 'RoundRect' && macroBodies.get('RoundRect') !== exactRoundRectMacro) {
				unsupported.push(`光圈 ${aperture.id} 使用未经精确确认的RoundRect宏`);
				continue;
			}
			if (aperture.shape === 'Oval' && macroBodies.get('Oval') !== exactOvalMacro) {
				unsupported.push(`光圈 ${aperture.id} 使用未经精确确认的Oval宏`);
				continue;
			}
			if (aperture.shape === 'Rect' && macroBodies.get('Rect') !== exactRectMacro) {
				unsupported.push(`光圈 ${aperture.id} 使用未经精确确认的Rect宏`);
				continue;
			}
			apertures.set(aperture.id, aperture);
			continue;
		}
		if (token === '%LPD*%') {
			currentPolarity = 'dark';
			continue;
		}
		if (token === '%LPC*%') {
			currentPolarity = 'clear';
			continue;
		}
		if (token.startsWith('%FS') || token.startsWith('%MO'))
			continue;
		if (token === 'G75') {
			quadrantMode = 'multi';
			continue;
		}
		if (token === 'G74') {
			quadrantMode = 'single';
			continue;
		}
		if (token === 'G01') {
			plotMode = 'linear';
			continue;
		}
		if (token === 'G36') {
			if (regionOpen) {
				unsupported.push('区域嵌套');
				continue;
			}
			regionOpen = true;
			regionContours = [];
			activeContour = undefined;
			counts.regions++;
			continue;
		}
		if (token === 'G37') {
			if (!regionOpen) {
				unsupported.push('没有对应G36的G37');
				continue;
			}
			for (const contour of regionContours) {
				if (regionHasUnsupportedRecord)
					break;
				if (!isSimpleClosedRing(contour)) {
					unsupported.push('区域轮廓未闭合或自相交');
					continue;
				}
				const geom = polygon(contour);
				shapes.push({ kind: 'region', polarity: currentPolarity, geometryLower: geom, geometryUpper: geom });
				counts.regionContours++;
			}
			regionOpen = false;
			if (regionHasUnsupportedRecord)
				unsupported.push('包含不支持记录的区域未参与几何检查');
			regionHasUnsupportedRecord = false;
			regionContours = [];
			activeContour = undefined;
			continue;
		}
		const apertureSelect = token.match(/^G54D(\d+)$/u) ?? token.match(/^D(\d+)$/u);
		if (apertureSelect) {
			const code = Number(apertureSelect[1]);
			if (code >= 10) {
				currentAperture = apertures.get(code);
				if (!currentAperture)
					unsupported.push(`选择了未定义的光圈D${code}`);
			}
			else if (code >= 1 && code <= 3) {
				currentOperation = code;
				if (code === 3)
					addFlash(currentPoint);
			}
			else {
				unsupported.push(`未知D代码 ${token}`);
			}
			continue;
		}
		const command = token.match(/^(?:G(\d+))?((?:[XYIJ][+-]?\d+)*)(?:D(0?[123]))?$/u);
		if (command && (command[1] || command[2] || command[3])) {
			const gcode = command[1] ? Number(command[1]) : undefined;
			if (gcode === 1) {
				plotMode = 'linear';
			}
			else if (gcode === 2) {
				plotMode = 'cw';
			}
			else if (gcode === 3) {
				plotMode = 'ccw';
			}
			else if (gcode !== undefined) {
				unsupported.push(`不支持的插补/控制G代码 G${gcode}`);
				if (regionOpen)
					regionHasUnsupportedRecord = true;
				positionKnown = false;
				continue;
			}
			const coords = command[2];
			const fields = [...coords.matchAll(/([XYIJ])([+-]?\d+)/gu)];
			const repeatedField = fields.find((field, index) => fields.findIndex(candidate => candidate[1] === field[1]) !== index)?.[1];
			if (repeatedField) {
				unsupported.push(`同一Gerber记录重复字段 ${repeatedField}`);
				if (regionOpen)
					regionHasUnsupportedRecord = true;
				positionKnown = false;
				continue;
			}
			const fieldValue = (name: string) => fields.find(field => field[1] === name)?.[2];
			const xText = fieldValue('X');
			const yText = fieldValue('Y');
			const iText = fieldValue('I');
			const jText = fieldValue('J');
			const hasOffsets = iText !== undefined || jText !== undefined;
			if (xText !== undefined) {
				modalX = Number(xText) / 100000 * MM_TO_MIL;
			}
			if (yText !== undefined) {
				modalY = Number(yText) / 100000 * MM_TO_MIL;
			}
			if ((xText !== undefined || yText !== undefined) && (modalX === undefined || modalY === undefined)) {
				unsupported.push('坐标轴缺失且此前没有模态坐标');
				continue;
			}
			if (coords && modalX === undefined && modalY === undefined) {
				unsupported.push('当前记录没有可用XY端点坐标');
				positionKnown = false;
				continue;
			}
			const op = command[3] ? Number(command[3]) : currentOperation;
			if (command[3])
				currentOperation = op;
			if (!coords)
				continue;
			if (hasOffsets && op !== 1) {
				unsupported.push('I/J仅支持与D01圆弧插补同记录出现');
				if (regionOpen) {
					regionHasUnsupportedRecord = true;
				}
				continue;
			}
			const target = point(modalX!, modalY!);
			if (op === 2) {
				counts.moves++;
				currentPoint = target;
				positionKnown = true;
				if (regionOpen) {
					activeContour = [target];
					regionContours.push(activeContour);
				}
			}
			else if (op === 1) {
				counts.draws++;
				if (!positionKnown) {
					unsupported.push('当前位置未知，D01绘制已跳过直到下一个D02');
				}
				else if (plotMode !== 'linear') {
					let reason = '圆弧几何参数无效';
					if (quadrantMode !== 'multi')
						reason = '圆弧缺少G75多象限模式';
					else if (regionOpen)
						reason = '不支持G36/G37区域圆弧';
					else if (layer === 'GKO')
						reason = '不支持GKO圆弧板框';
					else if (!currentAperture)
						reason = '圆弧D01前未选择光圈';
					else if (currentAperture.shape !== 'C')
						reason = '圆弧D01仅支持C光圈';
					else if (iText === undefined || jText === undefined)
						reason = '圆弧D01必须在同一记录显式包含I和J';
					if (quadrantMode !== 'multi' || regionOpen || layer === 'GKO' || !currentAperture || currentAperture.shape !== 'C' || iText === undefined || jText === undefined) {
						unsupported.push(reason);
						if (regionOpen) {
							regionHasUnsupportedRecord = true;
						}
						positionKnown = false;
					}
					else {
						const center = point(currentPoint[0] + Number(iText) / 100000 * MM_TO_MIL, currentPoint[1] + Number(jText) / 100000 * MM_TO_MIL);
						const fullCircle = samePoint(currentPoint, target);
						const diameter = currentAperture.parameters[0] * MM_TO_MIL;
						const geom = arcStrokeGeometry(currentPoint, target, center, plotMode === 'cw', fullCircle, diameter / 2, checkBudget);
						if (!geom) {
							unsupported.push(reason);
							positionKnown = false;
						}
						else {
							shapes.push({ kind: 'stroke', polarity: currentPolarity, apertureId: currentAperture.id, arcApproximation: geom.approximation, geometryLower: geom.lower, geometryUpper: geom.upper });
							arcApproximation.arcCount++;
							arcApproximation.maxRadiusResidualMil = Math.max(arcApproximation.maxRadiusResidualMil, geom.approximation.radiusResidualMil);
							arcApproximation.maxSagittaMil = Math.max(arcApproximation.maxSagittaMil, geom.approximation.maxSagittaMil);
							arcApproximation.maxEnvelopeErrorMil = Math.max(arcApproximation.maxEnvelopeErrorMil, geom.approximation.maxEnvelopeErrorMil);
							arcApproximationLimited ||= geom.limited;
						}
					}
				}
				else if (hasOffsets) {
					unsupported.push('直线插补D01不接受I/J圆弧偏移');
					positionKnown = false;
				}
				else if (regionOpen) {
					if (!activeContour) {
						unsupported.push('区域D01前缺少D02起点');
					}
					else {
						activeContour.push(target);
					}
				}
				else {
					if (!currentAperture) {
						unsupported.push('D01前未选择光圈');
					}
					else {
						const segmentInfo = arcSegments(currentAperture.parameters[0] * MM_TO_MIL / 2);
						arcApproximationLimited ||= segmentInfo.limited;
						const geom = shapeGeometry(currentAperture, currentPoint, target, 'stroke', segmentInfo.count);
						if (!geom)
							unsupported.push(`不支持D${currentAperture.id}的D01形状`);
						else shapes.push({ kind: 'stroke', polarity: currentPolarity, apertureId: currentAperture.id, centerline: geom.centerline, geometryLower: geom.lower, geometryUpper: geom.upper });
					}
				}
				currentPoint = target;
			}
			else if (op === 3) {
				currentPoint = target;
				positionKnown = true;
				addFlash(target);
			}
			else {
				unsupported.push(`未知操作D${op}`);
			}
			continue;
		}
		if (token.startsWith('D') && /^D\d+$/u.test(token)) {
			unsupported.push(`未知D代码 ${token}`);
			if (regionOpen)
				regionHasUnsupportedRecord = true;
			positionKnown = false;
			continue;
		}
		if (token.startsWith('G') || token.startsWith('%') || token.startsWith('M')) {
			unsupported.push(`不支持的Gerber命令: ${token.slice(0, 80)}`);
			if (regionOpen)
				regionHasUnsupportedRecord = true;
			positionKnown = false;
		}
		else {
			unknowns.push(`无法识别的Gerber记录: ${token.slice(0, 80)}`);
			if (regionOpen)
				regionHasUnsupportedRecord = true;
			positionKnown = false;
		}
	}
	if (!sawEnd)
		unknowns.push('缺少M02结束记录');
	if (arcApproximationLimited)
		unsupported.push('圆弧多边形近似超过固定段数上限');
	if (regionOpen)
		unsupported.push('G36区域未由G37结束');
	for (const shape of shapes) counts[shape.polarity]++;
	if (layer === 'GKO') {
		if (shapes.some(shape => shape.kind !== 'stroke' || shape.polarity !== 'dark'))
			unsupported.push('GKO包含非dark D01线框图形');
		const outlines = shapes.filter(shape => shape.kind === 'stroke' && shape.centerline).map(shape => shape.centerline!);
		const chains: Point[][] = [];
		for (const [a, b] of outlines) {
			let attached = false;
			for (const chain of chains) {
				if (samePoint(chain.at(-1)!, a)) {
					chain.push(b);
					attached = true;
					break;
				}
				if (samePoint(chain.at(-1)!, b)) {
					chain.push(a);
					attached = true;
					break;
				}
				if (samePoint(chain[0], b)) {
					chain.unshift(a);
					attached = true;
					break;
				}
				if (samePoint(chain[0], a)) {
					chain.unshift(b);
					attached = true;
					break;
				}
			}
			if (!attached)
				chains.push([a, b]);
		}
		if (chains.length !== 1 || !isSimpleClosedRing(chains[0]))
			unsupported.push('GKO不是唯一简单闭合线框');
		else boardOutline.push(chains[0]);
	}
	const macros = [...new Set(shapes.flatMap(shape => shape.apertureId === undefined ? [] : ['RoundRect', 'Oval', 'Rect'].filter(name => apertures.get(shape.apertureId!)?.shape === name)))];
	return {
		layer,
		fileName,
		contentBytes: new TextEncoder().encode(source).byteLength,
		complete: unknowns.length === 0 && unsupported.length === 0 && !arcApproximationLimited,
		units: 'mil',
		format: {
			coordinateFormat: format ? `${format[3]}.${format[4]}` : 'unknown',
			absolute: format?.[2] === 'A',
			sourceUnits: units === 'MM' ? 'mm' : units === 'IN' ? 'in' : 'unknown',
		},
		counts,
		arcApproximation,
		shapes,
		boardOutline,
		unknowns,
		unsupported,
		usedMacros: macros,
		arcApproximationLimited,
		apertures: [...apertures.values()].map(({ id, shape, rawShape, parameters }) => ({ id, shape, rawShape, parameters })),
	};
}

function finalPaint(layer: LayerParse, checkBudget?: () => void): { lower: MultiPolygon; upper: MultiPolygon } {
	let lower: MultiPolygon = [];
	let upper: MultiPolygon = [];
	for (let index = 0; index < layer.shapes.length;) {
		checkBudget?.();
		const polarity = layer.shapes[index].polarity;
		const run: GerberShape[] = [];
		while (index < layer.shapes.length && layer.shapes[index].polarity === polarity)
			run.push(layer.shapes[index++]);
		const runLower = polygonUnion(run.map(shape => shape.geometryLower));
		const runUpper = polygonUnion(run.map(shape => shape.geometryUpper));
		if (polarity === 'dark') {
			lower = polygonUnion([lower, runLower]);
			upper = polygonUnion([upper, runUpper]);
		}
		else {
			lower = subtractPolygons(lower, runUpper);
			upper = subtractPolygons(upper, runLower);
		}
	}
	checkBudget?.();
	return { lower, upper };
}
function cloneReadOnlySnapshot<T>(value: T, checkBudget?: () => void): T {
	const clone = (input: unknown): unknown => {
		if (Array.isArray(input)) {
			return input.map(child => { checkBudget?.(); return clone(child); });
		}
		if (input && typeof input === 'object') {
			return Object.fromEntries(Object.entries(input).map(([key, child]) => { checkBudget?.(); return [key, clone(child)]; }));
		}
		return input;
	};
	const freeze = (input: unknown): void => {
		if (!input || typeof input !== 'object' || Object.isFrozen(input))
			return;
		Object.freeze(input);
		for (const child of Object.values(input as Record<string, unknown>)) {
			checkBudget?.();
			freeze(child);
		}
	};
	const result = clone(value) as T;
	freeze(result);
	return result;
}
function ringSegments(ring: Ring): Array<[Point, Point]> {
	const result: Array<[Point, Point]> = [];
	for (let i = 1; i < ring.length; i++) result.push([ring[i - 1], ring[i]]);
	return result;
}
function orient(a: Point, b: Point, c: Point): number {
	return cross(a, b, c);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
	return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orient(a, b, c);
	const o2 = orient(a, b, d);
	const o3 = orient(c, d, a);
	const o4 = orient(c, d, b);
	return (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
		|| (Math.abs(o1) < 1e-9 && onSegment(a, b, c))
		|| (Math.abs(o2) < 1e-9 && onSegment(a, b, d))
		|| (Math.abs(o3) < 1e-9 && onSegment(c, d, a))
		|| (Math.abs(o4) < 1e-9 && onSegment(c, d, b));
}
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function pointInRing(p: Point, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i];
		const b = ring[j];
		if (((a[1] > p[1]) !== (b[1] > p[1])) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])
			inside = !inside;
	}
	return inside;
}
function pointInPolygons(p: Point, polygons: MultiPolygon): boolean {
	return polygons.some(poly => pointInRing(p, poly[0]) && !poly.slice(1).some(hole => pointInRing(p, hole)));
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	if (segmentsIntersect(a, b, c, d))
		return 0;
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function polygonsDistance(a: MultiPolygon, b: MultiPolygon, checkBudget?: () => void): number {
	if (!a.length || !b.length)
		return Number.POSITIVE_INFINITY;
	const intersection = intersectPolygons(a, b);
	if (intersection.length > 0)
		return 0;
	const makeSegments = (polygons: MultiPolygon) => polygons.flatMap(poly => poly.flatMap(ringSegments)).map(([start, end]) => ({
		start, end,
		minX: Math.min(start[0], end[0]), maxX: Math.max(start[0], end[0]),
		minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]),
		coordinateScale: Math.max(Math.abs(start[0]), Math.abs(start[1]), Math.abs(end[0]), Math.abs(end[1])),
	}));
	const aSegments = makeSegments(a);
	const bSegments = makeSegments(b);
	let best = Number.POSITIVE_INFINITY;
	let segmentCount = 0;
	for (const aSegment of aSegments) {
		for (const bSegment of bSegments) {
			if ((segmentCount++ & 1023) === 0)
				checkBudget?.();
			if (Number.isFinite(best)) {
				const gapX = Math.max(aSegment.minX - bSegment.maxX, bSegment.minX - aSegment.maxX, 0);
				const gapY = Math.max(aSegment.minY - bSegment.maxY, bSegment.minY - aSegment.maxY, 0);
				const roundingScale = Math.max(1, aSegment.coordinateScale, bSegment.coordinateScale, best);
				const guard = 1e-9 + 8 * Number.EPSILON * roundingScale;
				if (gapX > best + guard || gapY > best + guard)
					continue;
			}
			best = Math.min(best, segmentDistance(aSegment.start, aSegment.end, bSegment.start, bSegment.end));
			if (best <= 1e-9)
				return 0;
		}
	}
	return best;
}
function ringArea(ring: Ring): number {
	let area = 0;
	for (let i = 1; i < ring.length; i++) area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
	return area / 2;
}
function polygonArea(polygons: MultiPolygon): number {
	return Math.abs(polygons.reduce((sum, poly) => sum + Math.abs(ringArea(poly[0] ?? [])) - poly.slice(1).reduce((area, ring) => area + Math.abs(ringArea(ring)), 0), 0));
}
function polylineDistance(polygons: MultiPolygon, line: Point[], checkBudget?: () => void): number {
	if (!polygons.length || line.length < 2)
		return Number.POSITIVE_INFINITY;
	const lineSegments = line.slice(1).map((end, index): [Point, Point] => [line[index], end]);
	if (lineSegments.some(([a, b]) => pointInPolygons(a, polygons) || pointInPolygons(b, polygons) || pointInPolygons(point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), polygons)))
		return 0;
	const polygonEdges = polygons.flatMap(poly => poly.flatMap(ringSegments));
	let best = Number.POSITIVE_INFINITY;
	let segmentCount = 0;
	for (const [a, b] of polygonEdges) {
		for (const [c, d] of lineSegments) {
			if ((segmentCount++ & 1023) === 0)
				checkBudget?.();
			best = Math.min(best, segmentDistance(a, b, c, d));
			if (best <= 1e-9)
				return 0;
		}
	}
	return best;
}

type PolylineDistanceWitness = NonNullable<GerberConflict['locationWitness']>;
const LOCATION_WITNESS_TOLERANCE_MIL = 1e-9;

function vectorCross(a: Point, b: Point): number {
	return a[0] * b[1] - a[1] * b[0];
}

function pointOnSegmentExact(p: Point, a: Point, b: Point): boolean {
	return vectorCross([p[0] - a[0], p[1] - a[1]], [b[0] - a[0], b[1] - a[1]]) === 0
		&& p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
		&& p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function exactSegmentIntersectionPoint(a: Point, b: Point, c: Point, d: Point): Point | undefined {
	const r: Point = [b[0] - a[0], b[1] - a[1]];
	const s: Point = [d[0] - c[0], d[1] - c[1]];
	const qmp: Point = [c[0] - a[0], c[1] - a[1]];
	const denominator = vectorCross(r, s);
	if (denominator !== 0) {
		const t = vectorCross(qmp, s) / denominator;
		const u = vectorCross(qmp, r) / denominator;
		if (t < 0 || t > 1 || u < 0 || u > 1)
			return undefined;
		const result: Point = [a[0] + t * r[0], a[1] + t * r[1]];
		return result.every(Number.isFinite) ? result : undefined;
	}
	if (vectorCross(qmp, r) !== 0)
		return undefined;
	for (const candidate of [a, b, c, d]) {
		if (pointOnSegmentExact(candidate, a, b) && pointOnSegmentExact(candidate, c, d))
			return [...candidate];
	}
	return undefined;
}

function projectedPoint(p: Point, a: Point, b: Point): Point {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
	return [a[0] + t * dx, a[1] + t * dy];
}

function nearestSegmentPoints(a: Point, b: Point, c: Point, d: Point): { first: Point; second: Point; distance: number } {
	const pairs: Array<[Point, Point]> = [
		[a, projectedPoint(a, c, d)], [b, projectedPoint(b, c, d)],
		[projectedPoint(c, a, b), c], [projectedPoint(d, a, b), d],
	];
	let best: { first: Point; second: Point; distance: number } | undefined;
	for (const [first, second] of pairs) {
		const distance = Math.hypot(first[0] - second[0], first[1] - second[1]);
		if (Number.isFinite(distance) && (!best || distance < best.distance))
			best = { first, second, distance };
	}
	return best ?? { first: [...a], second: [...c], distance: Number.POSITIVE_INFINITY };
}

function pointOnPolygonBoundary(pointValue: Point, polygons: MultiPolygon, tolerance: number, checkBudget?: () => void): boolean {
	for (const poly of polygons) {
		for (const ring of poly) {
			for (const [a, b] of ringSegments(ring)) {
				checkBudget?.();
				if (pointSegmentDistance(pointValue, a, b) <= tolerance)
					return true;
			}
		}
	}
	return false;
}

function pointOnPolyline(pointValue: Point, line: Point[], tolerance: number, checkBudget?: () => void): boolean {
	for (const [a, b] of ringSegments(line)) {
		checkBudget?.();
		if (pointSegmentDistance(pointValue, a, b) <= tolerance)
			return true;
	}
	return false;
}

function verifiedPolylineDistanceWitness(polygons: MultiPolygon, line: Point[], distanceBound: number, checkBudget?: () => void): PolylineDistanceWitness | undefined {
	if (!Number.isFinite(distanceBound) || !polygons.length || line.length < 2 || line.some(p => !p.every(Number.isFinite)))
		return undefined;
	const validate = (witness: PolylineDistanceWitness): PolylineDistanceWitness | undefined => {
		const { silkPointMil, boardPointMil, measuredDistanceMil } = witness;
		if (![...silkPointMil, ...boardPointMil, measuredDistanceMil].every(Number.isFinite)
			|| Math.abs(Math.hypot(silkPointMil[0] - boardPointMil[0], silkPointMil[1] - boardPointMil[1]) - measuredDistanceMil) > LOCATION_WITNESS_TOLERANCE_MIL
			|| Math.abs(distanceBound - measuredDistanceMil) > LOCATION_WITNESS_TOLERANCE_MIL
			|| !pointOnPolyline(boardPointMil, line, LOCATION_WITNESS_TOLERANCE_MIL, checkBudget))
			return undefined;
		const silkValid = witness.kind === 'contained-point'
			? pointInPolygons(silkPointMil, polygons)
			: pointOnPolygonBoundary(silkPointMil, polygons, LOCATION_WITNESS_TOLERANCE_MIL, checkBudget);
		return silkValid ? witness : undefined;
	};

	for (const [lineA, lineB] of ringSegments(line)) {
		checkBudget?.();
		for (const containedPoint of [lineA, [(lineA[0] + lineB[0]) / 2, (lineA[1] + lineB[1]) / 2] as Point, lineB]) {
			if (pointInPolygons(containedPoint, polygons))
				return validate({ distanceBound: 'lower', silkGeometry: 'outer-envelope', kind: 'contained-point', silkPointMil: [...containedPoint], boardPointMil: [...containedPoint], measuredDistanceMil: 0 });
		}
	}

	let best: PolylineDistanceWitness | undefined;
	let segmentCount = 0;
	for (const poly of polygons) {
		for (const ring of poly) {
			for (const [silkA, silkB] of ringSegments(ring)) {
				for (const [boardA, boardB] of ringSegments(line)) {
					if ((segmentCount++ & 1023) === 0)
						checkBudget?.();
					const intersection = exactSegmentIntersectionPoint(silkA, silkB, boardA, boardB);
					if (intersection)
						return validate({ distanceBound: 'lower', silkGeometry: 'outer-envelope', kind: 'intersection', silkPointMil: intersection, boardPointMil: [...intersection], measuredDistanceMil: 0 });
					const nearest = nearestSegmentPoints(silkA, silkB, boardA, boardB);
					if (Number.isFinite(nearest.distance) && (!best || nearest.distance < best.measuredDistanceMil))
						best = { distanceBound: 'lower', silkGeometry: 'outer-envelope', kind: 'nearest-points', silkPointMil: nearest.first, boardPointMil: nearest.second, measuredDistanceMil: nearest.distance };
				}
			}
		}
	}
	return best ? validate(best) : undefined;
}

function witnessBounds(witness: PolylineDistanceWitness): Array<{ minX: number; minY: number; maxX: number; maxY: number }> {
	const points = [witness.silkPointMil, witness.boardPointMil];
	return [{ minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0])), maxY: Math.max(...points.map(p => p[1])) }];
}

function compareGeometry(category: GerberConflict['category'], layer: 'top' | 'bottom', silkLower: MultiPolygon, silkUpper: MultiPolygon, obstacleLower: MultiPolygon, obstacleUpper: MultiPolygon, threshold: number, areaEpsilon: number, polyline?: Point[], checkBudget?: () => void): GerberConflict | undefined {
	const distanceLower = polyline
		? polylineDistance(silkUpper, polyline, checkBudget)
		: polygonsDistance(silkUpper, obstacleUpper, checkBudget);
	checkBudget?.();
	const distanceUpper = polyline
		? polylineDistance(silkLower, polyline, checkBudget)
		: polygonsDistance(silkLower, obstacleLower, checkBudget);
	checkBudget?.();
	const intersectionLower = polyline ? [] : intersectPolygons(silkLower, obstacleLower);
	checkBudget?.();
	const innerArea = polygonArea(intersectionLower);
	const confirmed = threshold === 0
		? innerArea > areaEpsilon
		: Number.isFinite(distanceUpper) && distanceUpper < threshold - NUMERIC_DISTANCE_MARGIN_MIL;
	const potential = threshold === 0
		? distanceLower <= NUMERIC_DISTANCE_MARGIN_MIL
		: distanceLower <= threshold + NUMERIC_DISTANCE_MARGIN_MIL;
	if (!confirmed && !potential)
		return undefined;
	const location = confirmed && innerArea > areaEpsilon ? polygonBounds(intersectionLower) : undefined;
	const distanceWitness = category === 'silk-to-board-edge' && polyline
		? verifiedPolylineDistanceWitness(silkUpper, polyline, distanceLower, checkBudget)
		: undefined;
	const witnessLocationBounds = distanceWitness ? witnessBounds(distanceWitness) : undefined;
	const locationUnavailableReason = category === 'silk-to-board-edge' && polyline && !distanceWitness
		? `板边距离见证不能在${LOCATION_WITNESS_TOLERANCE_MIL}mil验证误差内与distanceLowerBoundMil核对`
		: undefined;
	return {
		category,
		layer,
		thresholdMil: threshold,
		distanceLowerBoundMil: Number.isFinite(distanceLower) ? distanceLower : undefined,
		distanceUpperBoundMil: Number.isFinite(distanceUpper) ? distanceUpper : undefined,
		status: confirmed ? 'confirmed' : 'potential',
		confirmed,
		method: 'polygon-inner-outer-bounds',
		...(distanceWitness ? {
			locationBoundsMil: witnessLocationBounds,
			locationKind: 'distance-witness' as const,
			locationEnumerationComplete: false as const,
			locationWitness: distanceWitness,
		} : location ? { locationBoundsMil: location.entries, locationTruncated: location.truncated } : { locationUnavailable: true, ...(locationUnavailableReason ? { locationUnavailableReason } : {}) }),
	};
}
function compareOutsideBoard(layer: 'top' | 'bottom', silkLower: MultiPolygon, silkUpper: MultiPolygon, boardPolygon: MultiPolygon, areaEpsilon: number, checkBudget?: () => void): GerberConflict | undefined {
	checkBudget?.();
	const certainlyOutside = subtractPolygons(silkLower, boardPolygon);
	checkBudget?.();
	const possiblyOutside = subtractPolygons(silkUpper, boardPolygon);
	checkBudget?.();
	const lowerArea = polygonArea(certainlyOutside);
	const upperArea = polygonArea(possiblyOutside);
	if (lowerArea <= areaEpsilon && upperArea <= areaEpsilon)
		return undefined;
	const confirmed = lowerArea > areaEpsilon;
	const location = confirmed ? polygonBounds(certainlyOutside) : undefined;
	return {
		category: 'silk-outside-board',
		layer,
		thresholdMil: 0,
		status: confirmed ? 'confirmed' : 'potential',
		confirmed,
		method: 'polygon-inner-outer-bounds',
		...(location ? { locationBoundsMil: location.entries, locationTruncated: location.truncated } : { locationUnavailable: true }),
	};
}

export async function analyzeSilkscreenGerber(bytes: Uint8Array, minClearanceMil: number, checkBudget?: () => void, captureParsedLayers?: (layers: readonly GerberLayerGeometry[]) => void): Promise<GerberSilkscreenReport> {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
		throw new TypeError('Gerber ZIP must be a non-empty Uint8Array');
	if (typeof minClearanceMil !== 'number' || !Number.isFinite(minClearanceMil) || minClearanceMil < 0)
		throw new TypeError('minClearanceMil must be a finite non-negative number');
	checkBudget?.();
	const zip = await JSZip.loadAsync(bytes);
	const parsedFiles: LayerParse[] = [];
	const unknowns: string[] = [];
	let usedMaximumSegments = false;
	for (const layer of Object.keys(supportedFiles) as GerberLayerName[]) {
		checkBudget?.();
		const matches = Object.values(zip.files).filter(file => !file.dir && supportedFiles[layer].test(file.name));
		if (matches.length !== 1) {
			unknowns.push(`${layer}文件${matches.length === 0 ? '缺失' : '重复'}`);
			continue;
		}
		const source = await matches[0].async('string');
		checkBudget?.();
		const parsed = parseGerberLayerGeometry(layer, matches[0].name, source, checkBudget);
		usedMaximumSegments ||= parsed.arcApproximationLimited;
		parsedFiles.push(parsed);
	}
	const layerMap = new Map(parsedFiles.map(layer => [layer.layer, layer]));
	const allParsed = (Object.keys(supportedFiles) as GerberLayerName[]).every(layer => layerMap.has(layer) && layerMap.get(layer)!.complete);
	const gko = layerMap.get('GKO');
	const outlineValid = !!gko?.complete && gko.boardOutline.length === 1;
	const conflictCandidates: GerberConflict[] = [];
	if (allParsed && outlineValid) {
		for (const [side, silkName, maskName] of [['top', 'GTO', 'GTS'], ['bottom', 'GBO', 'GBS']] as const) {
			checkBudget?.();
			const silkLayer = layerMap.get(silkName)!;
			const maskLayer = layerMap.get(maskName)!;
			const silk = finalPaint(silkLayer, checkBudget);
			const mask = finalPaint(maskLayer, checkBudget);
			const boardPolygon = polygon(closeRing(gko!.boardOutline[0]));
			const candidates = [
				compareGeometry('silk-to-mask-opening', side, silk.lower, silk.upper, mask.lower, mask.upper, minClearanceMil, NUMERIC_AREA_EPSILON_MIL2, undefined, checkBudget),
				compareGeometry('silk-to-board-edge', side, silk.lower, silk.upper, [], [], minClearanceMil, NUMERIC_AREA_EPSILON_MIL2, gko!.boardOutline[0], checkBudget),
				compareOutsideBoard(side, silk.lower, silk.upper, boardPolygon, NUMERIC_AREA_EPSILON_MIL2, checkBudget),
			].filter((candidate): candidate is GerberConflict => candidate !== undefined);
			conflictCandidates.push(...candidates);
		}
	}
	const unsupportedCount = parsedFiles.reduce((sum, file) => sum + file.unsupported.length + file.unknowns.length, 0);
	const arcSummary = parsedFiles.reduce((summary, file) => ({
		arcCount: summary.arcCount + file.arcApproximation.arcCount,
		maxRadiusResidualMil: Math.max(summary.maxRadiusResidualMil, file.arcApproximation.maxRadiusResidualMil),
		maxSagittaMil: Math.max(summary.maxSagittaMil, file.arcApproximation.maxSagittaMil),
		maxEnvelopeErrorMil: Math.max(summary.maxEnvelopeErrorMil, file.arcApproximation.maxEnvelopeErrorMil),
	}), { arcCount: 0, maxRadiusResidualMil: 0, maxSagittaMil: 0, maxEnvelopeErrorMil: 0 });
	unknowns.push(...parsedFiles.flatMap(file => [...file.unsupported.map(issue => `${file.layer}: ${issue}`), ...file.unknowns.map(issue => `${file.layer}: ${issue}`)]));
	if (!outlineValid)
		unknowns.push('GKO板框未能确认是唯一简单闭合线框');
	const report: GerberSilkscreenReport = {
		scope: 'exported-manufacturing-only',
		complete: allParsed && outlineValid && unsupportedCount === 0,
		clearanceThresholdMil: minClearanceMil,
		polygonApproximation: { targetSagittaMil: TARGET_SAGITTA_MIL, numericAreaEpsilonMil2: NUMERIC_AREA_EPSILON_MIL2, numericDistanceMarginMil: NUMERIC_DISTANCE_MARGIN_MIL, maxArcSegments: MAX_AR_SEGMENTS, usedMaximumSegments },
		arcApproximation: arcSummary,
		files: parsedFiles.map(file => ({
			layer: file.layer,
			fileName: file.fileName,
			contentBytes: file.contentBytes,
			complete: file.complete,
			units: file.units,
			format: file.format,
			counts: file.counts,
			arcApproximation: file.arcApproximation,
			boardOutlineBoundsMil: file.boardOutline.length ? bounds(file.boardOutline[0]) : undefined,
			apertures: file.apertures,
			usedMacros: file.usedMacros,
			arcApproximationLimited: file.arcApproximationLimited,
			unknowns: file.unknowns,
			unsupported: file.unsupported,
		})),
		confirmedConflicts: conflictCandidates.filter(item => item.confirmed),
		potentialConflicts: conflictCandidates.filter(item => !item.confirmed),
		unknowns,
		coverage: {
			boardOutline: outlineValid ? 'single-simple-closed-loop' : 'incomplete',
			supportedGerberSubset: ['FSLA45 absolute millimeter coordinates', 'G01 line interpolation', 'G75 multi-quadrant G02/G03 circular strokes with C apertures outside regions and GKO', 'D01/D02/D03 modal operations', 'C/R/O apertures', 'exact RoundRect, flash-only Oval, and flash-only Rect macros', 'G36/G37 simple closed contours, independently union-filled', 'LPD/LPC polarity'],
			excluded: ['G74 or unset-quadrant arcs; non-C aperture arcs; GKO and region arcs; malformed or unsupported arc records', 'region cut-in/self-intersecting contours', 'multiple or self-intersecting GKO loops', 'unknown aperture macros', 'source-object identity and pre-export design semantics'],
		},
	};
	captureParsedLayers?.(cloneReadOnlySnapshot(parsedFiles, checkBudget));
	return report;
}

type ParticipationArc = Extract<FootprintSilkStroke['global']['segments'][number], { type: 'arc' }>;
type ManufacturingArcMatch = 'match' | 'none' | 'uncertain';

const GERBER_MM_QUANTUM_MIL = 1e-5 * MM_TO_MIL;

function pointDistance(a: Point, b: Point): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function boardArcIntersections(arc: ParticipationArc, board: Point[][], checkBudget?: () => void): { points: Point[]; uncertain: boolean; reason?: string } {
	const center: Point = [arc.center.x, arc.center.y];
	const radius = arc.radius;
	const sweepRadians = arc.sweepDegrees * Math.PI / 180;
	if (![...center, radius, arc.sweepDegrees, arc.a.x, arc.a.y, arc.b.x, arc.b.y].every(Number.isFinite)
		|| !(radius > 0) || !(Math.abs(sweepRadians) > 0 && Math.abs(sweepRadians) < 2 * Math.PI))
		return { points: [], uncertain: true, reason: '源ARC几何参数非法或扫角接近整圆边界' };
	const magnitude = Math.abs(arc.sweepDegrees);
	const startAngle = Math.atan2(arc.a.y - center[1], arc.a.x - center[0]);
	const direction = Math.sign(sweepRadians);
	const sourcePositionError = 3 * Math.SQRT2 * GERBER_MM_QUANTUM_MIL + Number.EPSILON * Math.max(1, ...center.map(Math.abs), radius) * 64;
	const intersectionTolerance = sourcePositionError + Math.SQRT2 * GERBER_MM_QUANTUM_MIL;
	const angleTolerance = Math.asin(Math.min(1, intersectionTolerance / radius));
	if (Math.min(magnitude, Math.abs(360 - magnitude)) <= angleTolerance * 180 / Math.PI)
		return { points: [], uncertain: true, reason: '源ARC扫角位于量化误差覆盖的0/360度分支边界' };
	const mod = (value: number) => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
	const points: Point[] = [];
	let uncertain = false;
	for (const ring of board) {
		for (const [lineA, lineB] of ringSegments(ring)) {
			checkBudget?.();
			const dx = lineB[0] - lineA[0];
			const dy = lineB[1] - lineA[1];
			const length = Math.hypot(dx, dy);
			if (!(length > 0) || !Number.isFinite(length)) {
				uncertain = true;
				continue;
			}
			const fx = lineA[0] - center[0];
			const fy = lineA[1] - center[1];
			const projected = -(fx * dx + fy * dy) / (length * length);
			const distanceToLine = Math.abs(dx * fy - dy * fx) / length;
			if (Math.abs(distanceToLine - radius) <= intersectionTolerance) {
				uncertain = true;
				continue;
			}
			if (distanceToLine > radius)
				continue;
			const halfChord = Math.sqrt(Math.max(0, radius * radius - distanceToLine * distanceToLine)) / length;
			for (const t of [projected - halfChord, projected + halfChord]) {
				const segmentMargin = intersectionTolerance / length;
				if (t < -segmentMargin || t > 1 + segmentMargin)
					continue;
				if (t <= segmentMargin || t >= 1 - segmentMargin) {
					uncertain = true;
					continue;
				}
				const candidate: Point = [lineA[0] + t * dx, lineA[1] + t * dy];
				const angle = Math.atan2(candidate[1] - center[1], candidate[0] - center[0]);
				const progress = direction > 0 ? mod(angle - startAngle) : mod(startAngle - angle);
				if (progress <= angleTolerance || Math.abs(progress - Math.abs(sweepRadians)) <= angleTolerance) {
					uncertain = true;
					continue;
				}
				if (progress > Math.abs(sweepRadians))
					continue;
				if (!points.some(existing => pointDistance(existing, candidate) <= intersectionTolerance))
					points.push(candidate);
			}
		}
	}
	return { points, uncertain, ...(uncertain ? { reason: '板边交点接近切点、板框顶点或源弧端点，无法稳健区分' } : {}) };
}

function compareFootprintArcToManufacturing(arc: ParticipationArc, width: number, shape: GerberShape, aperture: GerberLayerGeometry['apertures'][number] | undefined): ManufacturingArcMatch {
	const gerber = shape.arcApproximation;
	if (shape.kind !== 'stroke' || shape.polarity !== 'dark' || !gerber || !aperture || aperture.shape !== 'C' || aperture.parameters.length !== 1)
		return 'none';
	const manufacturingWidthMil = aperture.parameters[0] * MM_TO_MIL;
	const widthRoundingError = Number.EPSILON * Math.max(1, Math.abs(manufacturingWidthMil), Math.abs(width)) * 8;
	if (!Number.isFinite(width) || Math.abs(manufacturingWidthMil - width) > widthRoundingError)
		return 'none';
	const sourceStart: Point = [arc.a.x, arc.a.y];
	const sourceEnd: Point = [arc.b.x, arc.b.y];
	const sourceCenter: Point = [arc.center.x, arc.center.y];
	const scale = Math.max(1, ...sourceStart.map(Math.abs), ...sourceEnd.map(Math.abs), ...sourceCenter.map(Math.abs), arc.radius);
	const floatingError = Number.EPSILON * scale * 64;
	const endpointError = Math.SQRT2 * GERBER_MM_QUANTUM_MIL + floatingError;
	const centerError = 2 * Math.SQRT2 * GERBER_MM_QUANTUM_MIL + floatingError;
	const radiusError = 3 * Math.SQRT2 * GERBER_MM_QUANTUM_MIL + gerber.radiusResidualMil + floatingError;
	if (pointDistance(sourceStart, gerber.start) > endpointError || pointDistance(sourceEnd, gerber.end) > endpointError
		|| pointDistance(sourceCenter, gerber.center) > centerError || Math.abs(arc.radius - gerber.radiusMil) > radiusError)
		return 'none';
	const vectorError = endpointError + centerError;
	if (!(arc.radius > vectorError))
		return 'uncertain';
	const endpointAngleError = Math.asin(vectorError / arc.radius);
	const sweepErrorDegrees = 2 * endpointAngleError * 180 / Math.PI + floatingError;
	const sourceSweep = arc.sweepDegrees;
	const manufacturingSweep = gerber.sweepDegrees;
	for (const sweep of [sourceSweep, manufacturingSweep]) {
		const magnitude = Math.abs(sweep);
		if (Math.min(magnitude, Math.abs(360 - magnitude)) <= sweepErrorDegrees)
			return 'uncertain';
	}
	if (Math.sign(sourceSweep) !== Math.sign(manufacturingSweep))
		return 'none';
	return Math.abs(sourceSweep - manufacturingSweep) <= sweepErrorDegrees ? 'match' : 'none';
}

function boundaryDistanceToPoint(value: Point, polygons: MultiPolygon, checkBudget?: () => void): number {
	let nearest = Number.POSITIVE_INFINITY;
	for (const poly of polygons) {
		for (const ring of poly) {
			for (const [a, b] of ringSegments(ring)) {
				checkBudget?.();
				nearest = Math.min(nearest, pointSegmentDistance(value, a, b));
			}
		}
	}
	return nearest;
}

function layerIsQuantizedMillimeters(layer: GerberLayerGeometry): boolean {
	return layer.complete && layer.units === 'mil' && layer.format.coordinateFormat === '4.5' && layer.format.absolute && layer.format.sourceUnits === 'mm';
}

export function analyzeFootprintArcBoardParticipation(args: {
	layers: readonly GerberLayerGeometry[];
	footprintSilkscreen: Pick<FootprintSilkResult, 'strokes' | 'coverage'>;
	checkBudget?: () => void;
}): FootprintArcBoardParticipationReport {
	const checkBudget = args.checkBudget;
	const empty = (available: boolean, availableReason?: string): FootprintArcBoardParticipationReport => ({
		scope: 'exported-manufacturing-footprint-arc-board-participation', available, ...(availableReason ? { availableReason } : {}), complete: false, checkedArcCount: 0, results: [],
		skipped: args.footprintSilkscreen.strokes.map(stroke => ({ sourceIdentity: { ...stroke.sourceIdentity }, side: stroke.side, reason: availableReason ?? '来源弧未进入可检查范围' })),
	});
	if (!args.footprintSilkscreen.coverage.sourceStable)
		return empty(false, '封装丝印来源映射不稳定，本次不可进行几何关联');
	const gko = args.layers.filter(layer => layer.layer === 'GKO');
	if (gko.length !== 1 || !layerIsQuantizedMillimeters(gko[0]) || gko[0].boardOutline.length !== 1 || !isSimpleClosedRing(gko[0].boardOutline[0]))
		return empty(false, '需要唯一、完整且受支持的简单GKO线框才能判断源圆弧与板边交点');
	const board = gko[0].boardOutline;
	const layerBySide: Record<'top' | 'bottom', GerberLayerGeometry | undefined> = {
		top: args.layers.find(layer => layer.layer === 'GTO'),
		bottom: args.layers.find(layer => layer.layer === 'GBO'),
	};
	const paintCache = new Map<GerberLayerGeometry, { lower: MultiPolygon; upper: MultiPolygon }>();
	const omittedPaintCache = new Map<string, { lower: MultiPolygon; upper: MultiPolygon }>();
	const results: FootprintArcBoardParticipationResult[] = [];
	const skipped: FootprintArcBoardParticipationReport['skipped'] = [];
	let checkedArcCount = 0;
	for (const stroke of args.footprintSilkscreen.strokes) {
		checkBudget?.();
		if (stroke.global.segments.length !== 1 || stroke.global.segments[0]?.type !== 'arc') {
			skipped.push({ sourceIdentity: { ...stroke.sourceIdentity }, side: stroke.side, reason: '仅检查由单段ARC组成的稳定封装丝印来源' });
			continue;
		}
		checkedArcCount++;
		const layer = layerBySide[stroke.side];
		if (!layer || !layerIsQuantizedMillimeters(layer)) {
			skipped.push({ sourceIdentity: { ...stroke.sourceIdentity }, side: stroke.side, reason: `${stroke.side}丝印Gerber层缺失、不完整或坐标格式不受支持` });
			continue;
		}
		const arc = stroke.global.segments[0] as ParticipationArc;
		const crossings = boardArcIntersections(arc, board, checkBudget);
		if (!crossings.points.length) {
			skipped.push({ sourceIdentity: { ...stroke.sourceIdentity }, side: stroke.side, reason: crossings.reason ?? '源圆弧中心线未与GKO板边相交' });
			continue;
		}
		if (crossings.uncertain)
			skipped.push({ sourceIdentity: { ...stroke.sourceIdentity }, side: stroke.side, reason: crossings.reason ?? '附加板边接触未能稳健分类' });
		if (!paintCache.has(layer))
			paintCache.set(layer, finalPaint(layer, checkBudget));
		const fullPaint = paintCache.get(layer)!;
		const matches: FootprintArcBoardParticipationResult['matchedManufacturingRefs'] = [];
		const uncertainMatches: Array<{ fileName: string; contentBytes: number; layer: 'GTO' | 'GBO'; shapeIndex: number }> = [];
		for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
			checkBudget?.();
			const shape = layer.shapes[shapeIndex];
			if (shape.polarity !== 'dark' || !shape.arcApproximation || shape.apertureId === undefined)
				continue;
			const aperture = layer.apertures.find(item => item.id === shape.apertureId);
			const comparison = compareFootprintArcToManufacturing(arc, stroke.global.width, shape, aperture);
			if (comparison === 'match')
				matches.push({ fileName: layer.fileName, contentBytes: layer.contentBytes, layer: layer.layer as 'GTO' | 'GBO', shapeIndex });
			else if (comparison === 'uncertain')
				uncertainMatches.push({ fileName: layer.fileName, contentBytes: layer.contentBytes, layer: layer.layer as 'GTO' | 'GBO', shapeIndex });
		}
		const base = {
			sourceIdentity: { ...stroke.sourceIdentity },
			side: stroke.side,
			sourceGeometryRelation: 'centerline-crosses-board-edge' as const,
			sourceIntersectionPointsMil: crossings.points.map(pointValue => [...pointValue] as Point),
			uniqueSourceAttribution: false as const,
			contactEnumerationComplete: false as const,
			witnesses: [] as FootprintArcBoardParticipationWitness[],
			matchedManufacturingRefs: matches,
			uncertainManufacturingRefs: uncertainMatches,
			...(crossings.uncertain ? { unresolvedContactReason: crossings.reason ?? '附加板边接触未能稳健分类' } : {}),
		};
		if (matches.length === 0) {
			results.push({ ...base, sourceMapping: uncertainMatches.length ? 'geometry-match-uncertain' : 'not-matched', manufacturingContribution: 'not-verified', reason: uncertainMatches.length ? '制造弧匹配位于数值分支边界，未选择候选' : '没有完整匹配的同面dark C光圈制造弧' });
			continue;
		}
		if (matches.length > 1) {
			results.push({ ...base, sourceMapping: 'ambiguous-manufacturing-match', manufacturingContribution: 'not-verified', reason: '存在多个完整几何匹配的dark制造弧，不按最近或顺序任选' });
			continue;
		}
		if (uncertainMatches.length > 0) {
			results.push({ ...base, sourceMapping: 'geometry-match-uncertain', manufacturingContribution: 'not-verified', reason: '除唯一完整匹配外，还存在数值边界附近的制造弧候选，不能排除重复匹配' });
			continue;
		}
		const match = matches[0];
		const shape = layer.shapes[match.shapeIndex];
		const omissionKey = `${match.layer}:${match.shapeIndex}`;
		let omittedPaint = omittedPaintCache.get(omissionKey);
		if (!omittedPaint) {
			omittedPaint = finalPaint({ ...layer, shapes: layer.shapes.filter((_, index) => index !== match.shapeIndex) }, checkBudget);
			omittedPaintCache.set(omissionKey, omittedPaint);
		}
		const approximation = shape.arcApproximation!;
		const scale = Math.max(1, ...approximation.center.map(Math.abs), approximation.radiusMil);
		const boundaryMargin = 3 * Math.SQRT2 * GERBER_MM_QUANTUM_MIL + approximation.radiusResidualMil + approximation.maxEnvelopeErrorMil + Number.EPSILON * scale * 64;
		const witnesses = crossings.points.map(pointValue => {
			checkBudget?.();
			const fullBoundaryDistance = boundaryDistanceToPoint(pointValue, fullPaint.lower, checkBudget);
			const omittedBoundaryDistance = boundaryDistanceToPoint(pointValue, omittedPaint!.upper, checkBudget);
			return {
				pointMil: [...pointValue] as Point,
				fullLowerContains: pointInPolygons(pointValue, fullPaint.lower),
				omittedShapeUpperContains: pointInPolygons(pointValue, omittedPaint!.upper),
				nearFullLowerBoundary: fullBoundaryDistance <= boundaryMargin,
				nearOmittedUpperBoundary: omittedBoundaryDistance <= boundaryMargin,
			};
		});
		const contributionVerified = witnesses.length > 0 && witnesses.every(witness => witness.fullLowerContains && !witness.omittedShapeUpperContains && !witness.nearFullLowerBoundary && !witness.nearOmittedUpperBoundary);
		results.push({
			...base,
			sourceMapping: 'geometry-correlated',
			manufacturingContribution: contributionVerified ? 'verified-at-witnesses' : 'not-verified',
			witnesses,
			...(!contributionVerified ? { reason: '至少一个源圆弧/板边交点未能严格证明该制造图元对最终油墨的必要贡献' } : {}),
		});
	}
	return { scope: 'exported-manufacturing-footprint-arc-board-participation', available: true, complete: false, checkedArcCount, results, skipped };
}

function validParticipationBounds(value: unknown): BBox | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	const item = value as Record<string, unknown>;
	const values = [item.minX, item.minY, item.maxX, item.maxY];
	if (values.some(field => typeof field !== 'number' || !Number.isFinite(field)))
		return undefined;
	const [minX, minY, maxX, maxY] = values as number[];
	if (minX > maxX || minY > maxY)
		return undefined;
	return { minX, minY, maxX, maxY };
}

function rectanglePolygon(box: BBox): MultiPolygon {
	return polygon(closeRing([[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]]));
}

function strictInteriorPoint(polygons: MultiPolygon, marginMil: number, checkBudget?: () => void): { pointMil: Point; boundaryMarginMil: number } | undefined {
	let best: { pointMil: Point; boundaryMarginMil: number } | undefined;
	for (const poly of polygons) {
		checkBudget?.();
		const yValues = [...new Set(poly.flatMap(ring => ring.map(value => value[1])))].sort((a, b) => a - b);
		for (let index = 1; index < yValues.length; index++) {
			const y0 = yValues[index - 1];
			const y1 = yValues[index];
			if (!(y1 > y0))
				continue;
			for (const fraction of [0.5, 0.25, 0.75]) {
				checkBudget?.();
				const y = y0 + (y1 - y0) * fraction;
				const intersections: number[] = [];
				for (const ring of poly) {
					for (const [a, b] of ringSegments(ring)) {
						checkBudget?.();
						if ((a[1] > y) === (b[1] > y))
							continue;
						const x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
						if (Number.isFinite(x))
							intersections.push(x);
					}
				}
			intersections.sort((a, b) => a - b);
			for (let crossing = 1; crossing < intersections.length; crossing++) {
				const left = intersections[crossing - 1];
				const right = intersections[crossing];
				if (!(right > left))
					continue;
				const candidate: Point = [(left + right) / 2, y];
				if (!pointInPolygons(candidate, [poly]))
					continue;
				const boundaryMarginMil = boundaryDistanceToPoint(candidate, [poly], checkBudget);
				if (!(boundaryMarginMil > marginMil))
					continue;
				if (!best || boundaryMarginMil > best.boundaryMarginMil
					|| (boundaryMarginMil === best.boundaryMarginMil && (candidate[1] < best.pointMil[1] || (candidate[1] === best.pointMil[1] && candidate[0] < best.pointMil[0]))))
					best = { pointMil: candidate, boundaryMarginMil };
			}
		}
	}
	}
	return best;
}

function pointInsideOrNearPolygon(pointValue: Point, polygons: MultiPolygon, tolerance: number, checkBudget?: () => void): boolean {
	return pointInPolygons(pointValue, polygons) || pointOnPolygonBoundary(pointValue, polygons, tolerance, checkBudget);
}

function maskShapeReference(layer: GerberLayerGeometry, shapeIndex: number): ManufacturingMaskShapeParticipationReference {
	return { layer: layer.layer as 'GTO' | 'GBO' | 'GTS' | 'GBS', fileName: layer.fileName, contentBytes: layer.contentBytes, shapeIndex };
}

export function analyzeManufacturingMaskOverlapParticipation(args: {
	layers: readonly GerberLayerGeometry[];
	manufacturing: { confirmedConflicts?: readonly GerberConflict[]; unavailableReason?: string; complete?: boolean };
	checkBudget?: () => void;
}): ManufacturingMaskOverlapParticipationReport {
	const checkBudget = args.checkBudget;
	const skipped: ManufacturingMaskOverlapParticipationReport['skipped'] = [];
	const results: ManufacturingMaskOverlapParticipationResult[] = [];
	const unavailable = (unavailableReason: string): ManufacturingMaskOverlapParticipationReport => ({
		scope: 'exported-manufacturing-silkscreen-mask-overlap-participation', available: false, unavailableReason, complete: false, skipped, results,
	});
	if (!Array.isArray(args.manufacturing?.confirmedConflicts))
		return unavailable(args.manufacturing?.unavailableReason ?? '制造报告没有可读的confirmedConflicts列表');
	const fullPaintCache = new Map<GerberLayerGeometry, { lower: MultiPolygon; upper: MultiPolygon }>();
	const omissionPaintCache = new Map<string, { lower: MultiPolygon; upper: MultiPolygon }>();
	const regionMarginMil = NUMERIC_DISTANCE_MARGIN_MIL;
	const eligibleConflicts = args.manufacturing.confirmedConflicts
		.map((conflict, conflictIndex) => ({ conflict, conflictIndex }))
		.filter(({ conflict }) => conflict.category === 'silk-to-mask-opening' && conflict.status === 'confirmed' && conflict.confirmed === true);
	for (const { conflict, conflictIndex } of eligibleConflicts) {
		checkBudget?.();
		const silkName = conflict.layer === 'top' ? 'GTO' : 'GBO';
		const maskName = conflict.layer === 'top' ? 'GTS' : 'GBS';
		const silkMatches = args.layers.filter(layer => layer.layer === silkName);
		const maskMatches = args.layers.filter(layer => layer.layer === maskName);
		const silkLayer = silkMatches[0];
		const maskLayer = maskMatches[0];
		const layerReason = silkMatches.length !== 1 || !silkLayer?.complete
			? `同次制造图层缺少唯一完整的${silkName}`
			: maskMatches.length !== 1 || !maskLayer?.complete
				? `同次制造图层缺少唯一完整的${maskName}`
				: undefined;
		const boundsValue = conflict.locationBoundsMil;
		if (!Array.isArray(boundsValue)) {
			skipped.push({ conflictBucket: 'confirmed', conflictIndex, areaIndex: null, reason: conflict.locationUnavailableReason ?? (conflict.locationUnavailable ? 'confirmed制造交叠没有location bounds' : 'confirmed制造交叠省略了location bounds') });
			continue;
		}
		if (boundsValue.length === 0) {
			skipped.push({ conflictBucket: 'confirmed', conflictIndex, areaIndex: null, reason: 'confirmed制造交叠返回了空location bounds列表' });
			continue;
		}
		if (conflict.locationTruncated)
			skipped.push({ conflictBucket: 'confirmed', conflictIndex, areaIndex: null, reason: 'confirmed制造交叠的location bounds被截断，只能核对返回的区域' });
		for (let areaIndex = 0; areaIndex < boundsValue.length; areaIndex++) {
			checkBudget?.();
			const locationBoundsMil = validParticipationBounds(boundsValue[areaIndex]);
			if (!locationBoundsMil) {
				skipped.push({ conflictBucket: 'confirmed', conflictIndex, areaIndex, reason: 'confirmed制造交叠包含无效location bbox' });
				continue;
			}
			const makeUnavailableResult = (reason: string): ManufacturingMaskOverlapParticipationResult => ({
				conflictBucket: 'confirmed', conflictIndex, areaIndex, layer: conflict.layer, locationBoundsMil, locationTruncated: conflict.locationTruncated === true,
				witnessCandidateEnumerationComplete: false, uniqueSourceAttribution: false, contactEnumerationComplete: false,
				manufacturingContribution: 'not-verified', reason,
			});
			if (layerReason) {
				results.push(makeUnavailableResult(layerReason));
				continue;
			}
			if (!fullPaintCache.has(silkLayer!))
				fullPaintCache.set(silkLayer!, finalPaint(silkLayer!, checkBudget));
			if (!fullPaintCache.has(maskLayer!))
				fullPaintCache.set(maskLayer!, finalPaint(maskLayer!, checkBudget));
			const silkPaint = fullPaintCache.get(silkLayer!)!;
			const maskPaint = fullPaintCache.get(maskLayer!)!;
			checkBudget?.();
			const overlapLower = intersectPolygons(silkPaint.lower, maskPaint.lower);
			checkBudget?.();
			const clippedOverlap = intersectPolygons(overlapLower, rectanglePolygon(locationBoundsMil));
			const overlapArea = polygonArea(clippedOverlap);
			if (!Number.isFinite(overlapArea) || !(overlapArea > 0)) {
				results.push(makeUnavailableResult('该location bbox内的最终silk.lower与mask.lower没有正面积几何交集'));
				continue;
			}
			const interior = strictInteriorPoint(clippedOverlap, regionMarginMil, checkBudget);
			if (!interior) {
				results.push(makeUnavailableResult('正面积交集中找不到远离所有边界至少0.01mil的严格内部点'));
				continue;
			}
			const pointValue = interior.pointMil;
			const overlapBoundaryMarginMil = boundaryDistanceToPoint(pointValue, clippedOverlap, checkBudget);
			const silkLowerBoundaryMarginMil = boundaryDistanceToPoint(pointValue, silkPaint.lower, checkBudget);
			const maskLowerBoundaryMarginMil = boundaryDistanceToPoint(pointValue, maskPaint.lower, checkBudget);
			const overlapLowerContains = pointInPolygons(pointValue, overlapLower);
			const silkLowerContains = pointInPolygons(pointValue, silkPaint.lower);
			const maskLowerContains = pointInPolygons(pointValue, maskPaint.lower);
			const strictPoint = overlapLowerContains && silkLowerContains && maskLowerContains
				&& overlapBoundaryMarginMil > regionMarginMil
				&& silkLowerBoundaryMarginMil > regionMarginMil
				&& maskLowerBoundaryMarginMil > regionMarginMil;
			if (!strictPoint) {
				results.push(makeUnavailableResult('扫描候选点未能通过最终lower交集成员或边界余量复核'));
				continue;
			}
			const sideEvidence = (layer: GerberLayerGeometry): ManufacturingMaskSideParticipation => {
				const darkIndices: number[] = [];
				for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
					checkBudget?.();
					const shape = layer.shapes[shapeIndex];
					if (shape.polarity === 'dark' && pointInsideOrNearPolygon(pointValue, shape.geometryUpper, regionMarginMil, checkBudget))
						darkIndices.push(shapeIndex);
				}
			const darkCoveringShapes = darkIndices.map(shapeIndex => {
				checkBudget?.();
				const shape = layer.shapes[shapeIndex];
				const geometryLowerContainsWitness = pointInPolygons(pointValue, shape.geometryLower);
				const geometryLowerBoundaryMarginMil = boundaryDistanceToPoint(pointValue, shape.geometryLower, checkBudget);
				const geometryLowerEmpty = shape.geometryLower.length === 0;
				const key = `${layer.layer}:${shapeIndex}`;
				let omittedPaint = omissionPaintCache.get(key);
				if (!omittedPaint) {
					omittedPaint = finalPaint({ ...layer, shapes: layer.shapes.filter((_, index) => index !== shapeIndex) }, checkBudget);
					omissionPaintCache.set(key, omittedPaint);
				}
				const omittedFinalUpperContainsWitness = pointInPolygons(pointValue, omittedPaint.upper);
				const omittedFinalUpperBoundaryMarginMil = boundaryDistanceToPoint(pointValue, omittedPaint.upper, checkBudget);
				const necessaryAtWitness = geometryLowerContainsWitness && geometryLowerBoundaryMarginMil > regionMarginMil
					&& !omittedFinalUpperContainsWitness && omittedFinalUpperBoundaryMarginMil > regionMarginMil;
				return {
					reference: maskShapeReference(layer, shapeIndex),
					geometryUpperContainsOrNearWitness: true,
					geometryLowerContainsWitness,
					geometryLowerEmpty,
					geometryLowerBoundaryMarginMil: Number.isFinite(geometryLowerBoundaryMarginMil) ? geometryLowerBoundaryMarginMil : null,
					omittedFinalUpperContainsWitness,
					omittedFinalUpperEmpty: omittedPaint.upper.length === 0,
					omittedFinalUpperBoundaryMarginMil: Number.isFinite(omittedFinalUpperBoundaryMarginMil) ? omittedFinalUpperBoundaryMarginMil : null,
					necessaryAtWitness,
					...(!necessaryAtWitness ? { reason: !geometryLowerContainsWitness ? 'dark图元geometry.lower不含内部见证点' : geometryLowerBoundaryMarginMil <= regionMarginMil ? '见证点过于接近dark图元geometry.lower边界' : omittedFinalUpperContainsWitness ? '省略该dark图元后最终upper仍覆盖见证点' : '省略重放后的最终upper边界离见证点不足0.01mil' } : {}),
				};
			});
			const necessaryContributors = darkCoveringShapes.filter(candidate => candidate.necessaryAtWitness);
			const uniqueDarkCoverage = darkCoveringShapes.length === 1
				&& darkCoveringShapes[0].geometryLowerContainsWitness
				&& !darkCoveringShapes[0].geometryLowerEmpty
				&& typeof darkCoveringShapes[0].geometryLowerBoundaryMarginMil === 'number'
				&& darkCoveringShapes[0].geometryLowerBoundaryMarginMil > regionMarginMil;
			const necessaryContribution = necessaryContributors.length === 1;
			const reason = darkCoveringShapes.length === 0
				? '没有dark图元的保守upper覆盖内部见证点'
				: necessaryContributors.length > 1
					? `有${necessaryContributors.length}个dark图元分别通过省略重放，必要贡献不唯一`
					: necessaryContributors.length === 0
						? darkCoveringShapes.length === 1 ? darkCoveringShapes[0].reason ?? '省略重放未证明必要贡献' : '没有候选dark图元通过lower严格内点和逐个省略最终upper验证'
						: undefined;
			return {
				layer: layer.layer as ManufacturingMaskSideParticipation['layer'], darkUpperCandidateCount: darkCoveringShapes.length,
				uniqueDarkCoverage, darkUpperCandidates: darkCoveringShapes, necessaryContributorCount: necessaryContributors.length,
				necessaryContributorRefs: necessaryContributors.map(candidate => candidate.reference), necessaryContribution,
				...(reason ? { reason } : {}),
			};
			};
			const silkEvidence = sideEvidence(silkLayer!);
			const maskEvidence = sideEvidence(maskLayer!);
			const manufacturingContribution = silkEvidence.necessaryContribution && maskEvidence.necessaryContribution ? 'verified-at-witnesses' : 'not-verified';
			results.push({
				conflictBucket: 'confirmed', conflictIndex, areaIndex, layer: conflict.layer, locationBoundsMil, locationTruncated: conflict.locationTruncated === true,
				witnessCandidateEnumerationComplete: true, uniqueSourceAttribution: false, contactEnumerationComplete: false, manufacturingContribution,
				witness: {
					pointMil: [...pointValue], overlapLowerContains, silkLowerContains, maskLowerContains,
					overlapBoundaryMarginMil, silkLowerBoundaryMarginMil, maskLowerBoundaryMarginMil,
					silk: silkEvidence, mask: maskEvidence,
				},
				...(!(silkEvidence.necessaryContribution && maskEvidence.necessaryContribution) ? { reason: [silkEvidence.reason && `GTO/GBO: ${silkEvidence.reason}`, maskEvidence.reason && `GTS/GBS: ${maskEvidence.reason}`].filter(Boolean).join('；') } : {}),
			});
		}
	}
	return { scope: 'exported-manufacturing-silkscreen-mask-overlap-participation', available: true, complete: false, skipped, results };
}

/** Geometry-correlate eligible source/runtime pads with every exact dark RoundRect mask flash. */
export function analyzePadMaskOpeningAssociations(args: {
	layers: readonly GerberLayerGeometry[];
	padCandidates: FootprintPadMaskCandidateReport;
	maskParticipation: ManufacturingMaskOverlapParticipationReport;
	checkBudget?: () => void;
}): PadMaskOpeningAssociationReport {
	const skipped: PadMaskOpeningAssociationReport['skipped'] = (args.padCandidates?.skipped ?? []).map(item => ({ ...item }));
	const matches: PadMaskOpeningAssociationMatch[] = [];
	const sourceStable = args.padCandidates?.sourceStable === true;
	const modelAssumptions = args.padCandidates?.modelAssumptions ?? [];
	const unavailable = (reason: string): PadMaskOpeningAssociationReport => ({ scope: 'manufacturing-pad-mask-opening-association', available: false, unavailableReason: reason, complete: false, sourceStable, uniqueSourceAttribution: false, modelAssumptions, matches, skipped });
	if (!Array.isArray(args.layers) || !args.padCandidates || !Array.isArray(args.padCandidates.candidates) || !args.maskParticipation || !Array.isArray(args.maskParticipation.results))
		return unavailable('焊盘候选或制造mask参与报告缺失');
	if (!args.padCandidates.available || !sourceStable)
		return unavailable(args.padCandidates.unavailableReason ?? '源或运行时焊盘快照不稳定');
	const halfCoordinateQuantumMil = 0.000005 * MM_TO_MIL;
	const halfRadiusQuantumMil = halfCoordinateQuantumMil / 2;
	const layersByName = new Map<GerberLayerName, GerberLayerGeometry>(args.layers.map(layer => [layer.layer, layer] as const));
	const maskLayerForSide = (side: 'top' | 'bottom') => side === 'top' ? 'GTS' as const : 'GBS' as const;
	const closedCopperEnvelope = (closed: FootprintPadMaskCandidateReport['closed'][number]): { lower: MultiPolygon; upper: MultiPolygon } => {
		const center: Point = closed.centerMil;
		if (closed.shape === 'ELLIPSE') { const radius = closed.widthMil / 2; return { lower: polygon(circleRing(center, radius, 'inner', 128)), upper: polygon(circleRing(center, radius, 'outer', 128)) }; }
		if (closed.shape === 'OVAL') {
			const radius = Math.min(closed.widthMil, closed.heightMil) / 2; const halfAxis = Math.abs(closed.widthMil - closed.heightMil) / 2; const angle = closed.rotationDegrees * Math.PI / 180 + (closed.widthMil >= closed.heightMil ? 0 : Math.PI / 2); const dx = halfAxis * Math.cos(angle); const dy = halfAxis * Math.sin(angle);
			return { lower: polygon(capsuleRing([center[0] - dx, center[1] - dy], [center[0] + dx, center[1] + dy], radius, 'inner', 128)), upper: polygon(capsuleRing([center[0] - dx, center[1] - dy], [center[0] + dx, center[1] + dy], radius, 'outer', 128)) };
		}
		const angle = closed.rotationDegrees * Math.PI / 180; const points = [[-closed.widthMil / 2, -closed.heightMil / 2], [closed.widthMil / 2, -closed.heightMil / 2], [closed.widthMil / 2, closed.heightMil / 2], [-closed.widthMil / 2, closed.heightMil / 2]].map(([x, y]) => [center[0] + x * Math.cos(angle) - y * Math.sin(angle), center[1] + x * Math.sin(angle) + y * Math.cos(angle)] as Point);
		return { lower: polygon(closeRing(points)), upper: polygon(closeRing(points)) };
	};
	for (const closed of args.padCandidates.closed ?? []) {
		args.checkBudget?.();
		const layerName = maskLayerForSide(closed.layer);
		const matchingLayers = args.layers.filter(layer => layer.layer === layerName);
		let manufacturingOpeningStatus: NonNullable<PadMaskOpeningAssociationMatch['manufacturingOpeningStatus']> = 'not-evaluated';
		let reason = '按源pad尺寸及签名扩张预测开窗退化；缺少唯一完整目标层，不能作制造开窗观测';
		if (sourceStable && matchingLayers.length === 1 && matchingLayers[0].complete && matchingLayers[0].format.absolute && matchingLayers[0].format.sourceUnits === 'mm' && matchingLayers[0].format.coordinateFormat === '4.5') {
			const layer = matchingLayers[0];
			const paint = finalPaint(layer as LayerParse, args.checkBudget);
			const copper = closedCopperEnvelope(closed);
			const upperOverlap = intersectPolygons(paint.upper, copper.upper);
			const lowerOverlap = intersectPolygons(paint.lower, copper.lower);
			const lowerArea = polygonArea(lowerOverlap);
			if (upperOverlap.length === 0) {
				const boundaryGap = paint.upper.length ? polygonsDistance(paint.upper, copper.upper, args.checkBudget) : Number.POSITIVE_INFINITY;
				if (boundaryGap === 0) { manufacturingOpeningStatus = 'geometry-match-uncertain'; reason = '最终mask正性与源铜区域外包边界接触，不能判作无开窗'; }
				else { manufacturingOpeningStatus = 'observed-no-positive-area-opening'; reason = '唯一完整mask层最终正性与该源铜区域的外包上界无交集'; }
			}
			else if (lowerOverlap.length > 0 && lowerArea > NUMERIC_AREA_EPSILON_MIL2) { manufacturingOpeningStatus = 'unattributed-opening-present'; reason = '最终mask正性与该源铜区域存在可靠正面积交集，无法将其归因到此pad'; }
			else { manufacturingOpeningStatus = 'geometry-match-uncertain'; reason = '目标铜区域与最终mask正性仅可能相交或面积过小，无法稳健分类'; }
		}
		matches.push({ sourceIdentity: closed.sourceIdentity, runtimePadId: closed.runtimePadId, padNumber: closed.padNumber, side: closed.layer, sourcePadModel: { shape: closed.shape, selectedExpansionField: closed.selectedExpansionField, solderExpansionMil: closed.solderExpansionMil } as PadMaskOpeningAssociationMatch['sourcePadModel'], association: 'model-predicted-closed', uniqueSourceAttribution: false, maskReferences: [], necessaryMaskReferences: [], geometryChecks: { circleOnly: true, flashCenterMatched: false, positiveDiameterMatched: false, diameterRule: 'unverified-precision', formatSupported: false }, manufacturingOpeningStatus, manufacturingOpeningScope: 'source-copper-region', witnessLinks: [], reason });
	}
	const pointMatchesFs45 = (candidate: FootprintPadMaskCandidate, actual: Point, expected: Point): boolean => {
		const box = candidate.runtimePad.boxMil;
		const xRoundingBound = Number.EPSILON * (Math.abs(box.minX) + Math.abs(box.maxX) + Math.abs(actual[0]) + Math.abs(expected[0]));
		const yRoundingBound = Number.EPSILON * (Math.abs(box.minY) + Math.abs(box.maxY) + Math.abs(actual[1]) + Math.abs(expected[1]));
		return Math.abs(actual[0] - expected[0]) <= halfCoordinateQuantumMil + xRoundingBound
			&& Math.abs(actual[1] - expected[1]) <= halfCoordinateQuantumMil + yRoundingBound;
	};
	const containsCandidateMaskPoint = (candidate: FootprintPadMaskCandidate, pointValue: Point): boolean => {
		if (isCirclePadMaskCandidate(candidate)) {
			const geometry = candidate.maskGeometry;
			return Math.hypot(pointValue[0] - geometry.centerMil[0], pointValue[1] - geometry.centerMil[1]) < geometry.openingDiameterMil / 2;
		}
		if (isOvalPadMaskCandidate(candidate)) {
			const [[x1, y1], [x2, y2]] = candidate.maskGeometry.axisEndpointsMil;
			const dx = x2 - x1; const dy = y2 - y1;
			const denominator = dx * dx + dy * dy;
			const t = denominator > 0 ? Math.max(0, Math.min(1, ((pointValue[0] - x1) * dx + (pointValue[1] - y1) * dy) / denominator)) : 0;
			return Math.hypot(pointValue[0] - (x1 + t * dx), pointValue[1] - (y1 + t * dy)) < candidate.maskGeometry.openingDiameterMil / 2;
		}
		const geometry = candidate.maskGeometry;
		const theta = -geometry.rotationDegrees * Math.PI / 180;
		const dx = pointValue[0] - geometry.centerMil[0];
		const dy = pointValue[1] - geometry.centerMil[1];
		const x = dx * Math.cos(theta) - dy * Math.sin(theta);
		const y = dx * Math.sin(theta) + dy * Math.cos(theta);
		if (geometry.pureRect) return Math.abs(x) <= geometry.coreWidthMil / 2 && Math.abs(y) <= geometry.coreHeightMil / 2;
		const outsideX = Math.max(Math.abs(x) - geometry.coreWidthMil / 2, 0);
		const outsideY = Math.max(Math.abs(y) - geometry.coreHeightMil / 2, 0);
		return Math.hypot(outsideX, outsideY) < geometry.expansionRadiusMil;
	};
	for (const candidate of args.padCandidates.candidates) {
		args.checkBudget?.();
		const layerName = maskLayerForSide(candidate.layer);
		const layer = layersByName.get(layerName);
		if (!layer || !layer.complete || layer.units !== 'mil' || !layer.format.absolute || layer.format.sourceUnits !== 'mm' || layer.format.coordinateFormat !== '4.5') {
			const geometryChecks = isCirclePadMaskCandidate(candidate)
				? { circleOnly: true as const, flashCenterMatched: false, positiveDiameterMatched: false, diameterRule: 'unverified-precision' as const, formatSupported: false }
				: isOvalPadMaskCandidate(candidate)
					? { capsuleOnly: true as const, flashCenterMatched: false, endpointsMatched: false, positiveDiameterMatched: false, diameterRule: 'unverified-precision' as const, formatSupported: false }
					: candidate.maskGeometry.pureRect ? { pureRectOnly: true as const, flashCenterMatched: false, dimensionsMatched: false, angleMatched: false, formatSupported: false }
					: { roundRectOnly: true as const, flashCenterMatched: false, allFourCoreCornersMatched: false, positiveRadiusMatched: false, formatSupported: false };
			matches.push({ sourceIdentity: candidate.sourceIdentity, runtimePadId: candidate.runtimePad.id, padNumber: candidate.padNumber, side: candidate.layer, sourcePadModel: candidate.sourcePad, association: 'geometry-match-uncertain', uniqueSourceAttribution: false, maskReferences: [], necessaryMaskReferences: [], geometryChecks, witnessLinks: [], reason: '目标mask层缺失/不完整或坐标格式不是FS45绝对毫米' });
			continue;
		}
		if (isOvalPadMaskCandidate(candidate)) {
			const geometry = candidate.maskGeometry;
			const apertureCandidates: Array<{ reference: ManufacturingMaskShapeParticipationReference; center: boolean; endpoints: boolean; diameter: boolean; diameterRule: 'fixed-1e-5-mm-half-quantum' | 'exact-epsilon-only' }> = [];
			const uncertainReferences: ManufacturingMaskShapeParticipationReference[] = [];
			let centerMatched = false;
			for (const [shapeIndex, shape] of layer.shapes.entries()) {
				args.checkBudget?.();
				if (shape.kind !== 'flash' || shape.polarity !== 'dark' || !shape.flashCenterMil) continue;
				const aperture = layer.apertures.find(item => item.id === shape.apertureId);
				if (!aperture) continue;
				const reference = { layer: layerName, fileName: layer.fileName, contentBytes: layer.contentBytes, shapeIndex };
				const center = pointMatchesFs45(candidate, shape.flashCenterMil, geometry.centerMil);
				if (!center) continue;
				centerMatched = true;
				if (aperture.shape === 'C') {
					if (geometry.axisHalfLengthMil !== 0 || aperture.parameters.length !== 1 || !Number.isFinite(aperture.parameters[0]) || !(aperture.parameters[0] > 0)) continue;
					const diameterMm = aperture.parameters[0];
					if (shape.circleDiameterToken === undefined || !Number.isFinite(Number(shape.circleDiameterToken)) || Number(shape.circleDiameterToken) !== diameterMm) { uncertainReferences.push(reference); continue; }
					const diameterResult = compareGerberFiveDigitMm(diameterMm, geometry.openingDiameterMil / MM_TO_MIL);
					if (diameterResult === 'unknown') uncertainReferences.push(reference);
					else if (diameterResult === 'quantized' || diameterResult === 'exact') apertureCandidates.push({ reference, center, endpoints: true, diameter: true, diameterRule: diameterResult === 'quantized' ? 'fixed-1e-5-mm-half-quantum' : 'exact-epsilon-only' });
					continue;
				}
				if (aperture.shape !== 'O' && aperture.shape !== 'Oval') continue;
				if (aperture.shape === 'Oval') {
					if (aperture.parameters.length !== 5 || !aperture.parameters.every(Number.isFinite) || !(aperture.parameters[0] > 0)) continue;
					const [diameterMm, x1Mm, y1Mm, x2Mm, y2Mm] = aperture.parameters;
					const expectedDiameterMm = geometry.openingDiameterMil / MM_TO_MIL;
					const diameterResult = compareGerberFiveDigitMm(diameterMm, expectedDiameterMm);
					const actualEndpointsMm: [Point, Point] = [[x1Mm, y1Mm], [x2Mm, y2Mm]];
					const expectedEndpointsMm = geometry.axisEndpointsMil.map(([x, y]) => [(x - geometry.centerMil[0]) / MM_TO_MIL, (y - geometry.centerMil[1]) / MM_TO_MIL] as Point) as [Point, Point];
					const endpointAssignment = (a: Point, b: Point) => {
						const comparisons = [compareGerberFiveDigitMm(a[0], b[0]), compareGerberFiveDigitMm(a[1], b[1])];
						return { matches: comparisons.every(value => value === 'quantized' || value === 'exact'), uncertain: comparisons.some(value => value === 'unknown') && comparisons.every(value => value !== 'mismatch') };
					};
					const direct = [endpointAssignment(actualEndpointsMm[0], expectedEndpointsMm[0]), endpointAssignment(actualEndpointsMm[1], expectedEndpointsMm[1])];
					const swapped = [endpointAssignment(actualEndpointsMm[0], expectedEndpointsMm[1]), endpointAssignment(actualEndpointsMm[1], expectedEndpointsMm[0])];
					const endpoints = direct.every(item => item.matches) || swapped.every(item => item.matches);
					const endpointPrecisionUnknown = !endpoints && (direct.every(item => item.matches || item.uncertain) || swapped.every(item => item.matches || item.uncertain));
					const parameterPrecisionUnknown = diameterResult === 'unknown' && (endpoints || endpointPrecisionUnknown)
						|| diameterResult !== 'mismatch' && endpointPrecisionUnknown;
					if (parameterPrecisionUnknown) uncertainReferences.push(reference);
					if (diameterResult === 'mismatch' || diameterResult === 'unknown') continue;
					if (endpoints) apertureCandidates.push({ reference, center, endpoints, diameter: true, diameterRule: diameterResult === 'quantized' ? 'fixed-1e-5-mm-half-quantum' : 'exact-epsilon-only' });
					continue;
				}
				if (aperture.parameters.length !== 2 || !aperture.parameters.every(value => Number.isFinite(value) && value > 0)) continue;
				const expectedWidthMm = (geometry.outerBoundsMil.maxX - geometry.outerBoundsMil.minX) / MM_TO_MIL;
				const expectedHeightMm = (geometry.outerBoundsMil.maxY - geometry.outerBoundsMil.minY) / MM_TO_MIL;
				const axisAngle = geometry.rotationDegrees * Math.PI / 180 + (candidate.sourcePad.widthMil >= candidate.sourcePad.heightMil ? 0 : Math.PI / 2);
				const axisUnitX = Math.cos(axisAngle); const axisUnitY = Math.sin(axisAngle);
				const axisTrigMargin = 8 * Number.EPSILON * Math.max(1, Math.abs(axisUnitX), Math.abs(axisUnitY));
				const axisIsXorY = geometry.axisHalfLengthMil === 0 || Math.abs(axisUnitX) <= axisTrigMargin || Math.abs(axisUnitY) <= axisTrigMargin;
				if (!axisIsXorY) continue;
				const widthResult = compareGerberFiveDigitMm(aperture.parameters[0], expectedWidthMm);
				const heightResult = compareGerberFiveDigitMm(aperture.parameters[1], expectedHeightMm);
				if ((widthResult === 'unknown' && heightResult !== 'mismatch') || (heightResult === 'unknown' && widthResult !== 'mismatch')) {
					uncertainReferences.push(reference);
					continue;
				}
				if ((widthResult === 'quantized' || widthResult === 'exact') && (heightResult === 'quantized' || heightResult === 'exact'))
					apertureCandidates.push({ reference, center, endpoints: true, diameter: true, diameterRule: widthResult === 'quantized' || heightResult === 'quantized' ? 'fixed-1e-5-mm-half-quantum' : 'exact-epsilon-only' });
			}
			const unresolvedPrecision = uncertainReferences.length > 0;
			const status = unresolvedPrecision ? 'geometry-match-uncertain' as const : apertureCandidates.length > 1 ? 'ambiguous' as const : apertureCandidates.length === 1 ? 'geometry-correlated' as const : 'not-matched' as const;
			const refs = apertureCandidates.map(item => item.reference);
			const unique = status === 'geometry-correlated' ? refs[0] : undefined;
			const sameReference = (a: ManufacturingMaskShapeParticipationReference, b: ManufacturingMaskShapeParticipationReference) => a.layer === b.layer && a.fileName === b.fileName && a.contentBytes === b.contentBytes && a.shapeIndex === b.shapeIndex;
			const necessaryMaskReferences = unique ? args.maskParticipation.results.flatMap(result => result.witness && result.layer === candidate.layer && result.manufacturingContribution === 'verified-at-witnesses' && result.witness.mask.necessaryContribution && containsCandidateMaskPoint(candidate, result.witness.pointMil) ? result.witness.mask.necessaryContributorRefs.filter(reference => sameReference(reference, unique)) : []) : [];
			const witnessLinks = unique ? args.maskParticipation.results.flatMap(result => result.witness && result.layer === candidate.layer && result.manufacturingContribution === 'verified-at-witnesses' && result.witness.mask.necessaryContribution && containsCandidateMaskPoint(candidate, result.witness.pointMil) ? result.witness.mask.necessaryContributorRefs.filter(reference => sameReference(reference, unique)).map(reference => ({ reference, conflictIndex: result.conflictIndex, areaIndex: result.areaIndex, pointMil: [...result.witness!.pointMil] as Point, insideCandidateMask: true })) : []) : [];
			matches.push({ sourceIdentity: candidate.sourceIdentity, runtimePadId: candidate.runtimePad.id, padNumber: candidate.padNumber, side: candidate.layer, sourcePadModel: candidate.sourcePad, association: status, uniqueSourceAttribution: false, maskReferences: refs, uncertainMaskReferences: uncertainReferences, necessaryMaskReferences, witnessLinks,
				geometryChecks: { capsuleOnly: true, flashCenterMatched: centerMatched, endpointsMatched: apertureCandidates.some(item => item.endpoints), positiveDiameterMatched: apertureCandidates.some(item => item.diameter), diameterRule: unresolvedPrecision ? 'unverified-precision' : apertureCandidates[0]?.diameterRule ?? 'unverified-precision', formatSupported: true },
				...(status !== 'geometry-correlated' ? { reason: unresolvedPrecision ? '匹配中心存在精度未确认的OVAL候选，不能唯一关联' : status === 'ambiguous' ? '多个胶囊flash几何匹配，未任选来源' : centerMatched ? '同中心胶囊的端点或直径不匹配' : '未找到同中心且匹配端点和直径的O/Oval dark flash' } : {}) });
			continue;
		}
		if (isCirclePadMaskCandidate(candidate)) {
			const maskGeometry = candidate.maskGeometry;
			const circleMatches: Array<{ reference: ManufacturingMaskShapeParticipationReference; flashCenterMatched: boolean; positiveDiameterMatched: boolean; diameterRule: 'fixed-1e-5-mm-half-quantum' | 'exact-epsilon-only' }> = [];
			const uncertainReferences: ManufacturingMaskShapeParticipationReference[] = [];
			let flashCenterMatched = false;
			let sawCircle = false;
			let exactEpsilonMatch = false;
			for (const [shapeIndex, shape] of layer.shapes.entries()) {
				args.checkBudget?.();
				if (shape.kind !== 'flash' || shape.polarity !== 'dark' || shape.flashCenterMil === undefined)
					continue;
				const aperture = layer.apertures.find(item => item.id === shape.apertureId);
				if (!aperture || aperture.shape !== 'C')
					continue;
				sawCircle = true;
				if (aperture.parameters.length !== 1 || !Number.isFinite(aperture.parameters[0]) || !(aperture.parameters[0] > 0))
					continue;
				const reference: ManufacturingMaskShapeParticipationReference = { layer: layerName, fileName: layer.fileName, contentBytes: layer.contentBytes, shapeIndex };
				if (!pointMatchesFs45(candidate, shape.flashCenterMil, maskGeometry.centerMil))
					continue;
				flashCenterMatched = true;
				const diameterMm = aperture.parameters[0];
				if (shape.circleDiameterToken === undefined || !Number.isFinite(Number(shape.circleDiameterToken)) || Number(shape.circleDiameterToken) !== diameterMm) {
					uncertainReferences.push(reference);
					continue;
				}
				const idealDiameterMm = maskGeometry.openingDiameterMil / MM_TO_MIL;
				const floatingPointAllowance = 8 * Number.EPSILON * Math.max(1, Math.abs(diameterMm), Math.abs(idealDiameterMm));
				const quantumMm = 1e-5;
				const nearestQuantumMm = Math.round(diameterMm / quantumMm) * quantumMm;
				const onQuantizationGrid = Math.abs(diameterMm - nearestQuantumMm) <= floatingPointAllowance;
				const differenceMm = Math.abs(diameterMm - idealDiameterMm);
				if (onQuantizationGrid && diameterMm > 0 && differenceMm <= quantumMm / 2 + floatingPointAllowance) {
					circleMatches.push({ reference, flashCenterMatched: true, positiveDiameterMatched: true, diameterRule: 'fixed-1e-5-mm-half-quantum' });
				}
				else if (diameterMm > 0 && differenceMm <= floatingPointAllowance) {
					exactEpsilonMatch = true;
					circleMatches.push({ reference, flashCenterMatched: true, positiveDiameterMatched: true, diameterRule: 'exact-epsilon-only' });
				}
				else if (!onQuantizationGrid) {
					uncertainReferences.push(reference);
				}
			}
			const maskReferences = circleMatches.map(item => item.reference);
			const unresolvedPrecision = uncertainReferences.length > 0;
			const status = unresolvedPrecision ? 'geometry-match-uncertain' as const : circleMatches.length > 1 ? 'ambiguous' as const : circleMatches.length === 1 ? 'geometry-correlated' as const : sawCircle ? 'not-matched' as const : 'geometry-match-uncertain' as const;
			const uniquelyMatchedReference = status === 'geometry-correlated' ? circleMatches[0].reference : undefined;
			const sameReference = (reference: ManufacturingMaskShapeParticipationReference, other: ManufacturingMaskShapeParticipationReference) => reference.layer === other.layer && reference.fileName === other.fileName && reference.contentBytes === other.contentBytes && reference.shapeIndex === other.shapeIndex;
			const necessaryMaskReferences = uniquelyMatchedReference ? args.maskParticipation.results.flatMap(result => {
				if (!result.witness || result.layer !== candidate.layer || result.manufacturingContribution !== 'verified-at-witnesses' || !result.witness.mask.necessaryContribution)
					return [];
				return result.witness.mask.necessaryContributorRefs.filter(reference => sameReference(reference, uniquelyMatchedReference) && containsCandidateMaskPoint(candidate, result.witness!.pointMil));
			}) : [];
			const witnessLinks = uniquelyMatchedReference ? args.maskParticipation.results.flatMap(result => {
				if (!result.witness || result.layer !== candidate.layer || result.manufacturingContribution !== 'verified-at-witnesses' || !result.witness.mask.necessaryContribution || !result.witness.mask.necessaryContributorRefs.some(reference => sameReference(reference, uniquelyMatchedReference)))
					return [];
				const pointValue = result.witness.pointMil;
				return result.witness.mask.necessaryContributorRefs.filter(reference => sameReference(reference, uniquelyMatchedReference) && containsCandidateMaskPoint(candidate, pointValue)).map(reference => ({ reference, conflictIndex: result.conflictIndex, areaIndex: result.areaIndex, pointMil: [...pointValue] as Point, insideCandidateMask: true }));
			}) : [];
			const diameterRule = unresolvedPrecision ? 'unverified-precision' as const : exactEpsilonMatch ? 'exact-epsilon-only' as const : 'fixed-1e-5-mm-half-quantum' as const;
			matches.push({
				sourceIdentity: candidate.sourceIdentity, runtimePadId: candidate.runtimePad.id, padNumber: candidate.padNumber, side: candidate.layer, sourcePadModel: candidate.sourcePad,
				association: status, uniqueSourceAttribution: false, maskReferences, necessaryMaskReferences,
				geometryChecks: { circleOnly: true, flashCenterMatched, positiveDiameterMatched: circleMatches.length > 0, diameterRule, formatSupported: true },
				uncertainMaskReferences: uncertainReferences, witnessLinks,
				...(status !== 'geometry-correlated' ? { reason: unresolvedPrecision ? '同中心存在直径参数精度未验证的C flash，未将其他flash单独确认为关联' : status === 'ambiguous' ? '多个C flash与该圆形开窗几何匹配，未任选来源' : status === 'not-matched' ? '当前制造范围内未找到中心和直径匹配的单参数C flash' : '目标层没有可检查的dark C flash' } : {}),
			});
			continue;
		}
		if (candidate.maskGeometry.pureRect) {
			const rectMatches: ManufacturingMaskShapeParticipationReference[] = [];
			const uncertainRectReferences: ManufacturingMaskShapeParticipationReference[] = [];
			let centerMatched = false;
			let dimensionsMatched = false;
			let angleMatched = false;
			const compareAngle = (actual: number, expected: number): 'match' | 'mismatch' | 'unknown' => {
				const normalize = (value: number) => ((value % 360) + 360) % 360;
				const normalizedActual = normalize(actual); const normalizedExpected = normalize(expected);
				const delta = Math.abs((((normalizedActual - normalizedExpected) % 180) + 270) % 180 - 90);
				const floating = 8 * Number.EPSILON * Math.max(1, Math.abs(normalizedActual), Math.abs(normalizedExpected));
				const grid = Math.abs(normalizedActual / 0.01 - Math.round(normalizedActual / 0.01)) <= floating / 0.01;
				if (grid) return delta <= 0.005 + floating ? 'match' : 'mismatch';
				if (delta <= floating) return 'match';
				return delta <= 0.005 + floating ? 'unknown' : 'mismatch';
			};
			for (const [shapeIndex, shape] of layer.shapes.entries()) {
				args.checkBudget?.();
				if (shape.kind !== 'flash' || shape.polarity !== 'dark' || !shape.flashCenterMil || !pointMatchesFs45(candidate, shape.flashCenterMil, candidate.maskGeometry.centerMil)) continue;
				centerMatched = true;
				const aperture = layer.apertures.find(item => item.id === shape.apertureId);
				if (!aperture || (aperture.shape !== 'Rect' && aperture.shape !== 'R')) continue;
				const ref = { layer: layerName, fileName: layer.fileName, contentBytes: layer.contentBytes, shapeIndex };
				if (aperture.parameters.length !== (aperture.shape === 'Rect' ? 3 : 2) || !aperture.parameters.every(Number.isFinite)) { uncertainRectReferences.push(ref); continue; }
				const [widthMm, heightMm, rawAngle] = aperture.parameters;
				const angle = aperture.shape === 'Rect' ? rawAngle : 0;
				const w = candidate.maskGeometry.coreWidthMil / MM_TO_MIL;
				const h = candidate.maskGeometry.coreHeightMil / MM_TO_MIL;
				const directWidth = compareGerberFiveDigitMm(widthMm, w); const directHeight = compareGerberFiveDigitMm(heightMm, h);
				const swapWidth = compareGerberFiveDigitMm(widthMm, h); const swapHeight = compareGerberFiveDigitMm(heightMm, w);
				const direct = directWidth === 'exact' || directWidth === 'quantized' ? directHeight === 'exact' || directHeight === 'quantized' : false;
				const swapped = swapWidth === 'exact' || swapWidth === 'quantized' ? swapHeight === 'exact' || swapHeight === 'quantized' : false;
				if ([directWidth, directHeight, swapWidth, swapHeight].includes('unknown')) { uncertainRectReferences.push(ref); continue; }
				const thisDimensionsMatched = direct || swapped;
				dimensionsMatched ||= thisDimensionsMatched;
				const expectedAngle = candidate.maskGeometry.rotationDegrees;
				const directAngle = compareAngle(angle, expectedAngle);
				const swappedAngle = compareAngle(angle, expectedAngle + 90);
				if (direct && directAngle === 'unknown' || swapped && swappedAngle === 'unknown') { uncertainRectReferences.push(ref); continue; }
				const thisAngleMatched = direct && directAngle === 'match' || swapped && swappedAngle === 'match';
				angleMatched ||= thisAngleMatched;
				if (thisDimensionsMatched && thisAngleMatched) rectMatches.push(ref);
			}
			const status = uncertainRectReferences.length ? 'geometry-match-uncertain' as const : rectMatches.length > 1 ? 'ambiguous' as const : rectMatches.length === 1 ? 'geometry-correlated' as const : 'not-matched' as const;
			const only = status === 'geometry-correlated' ? rectMatches[0] : undefined;
			const same = (a: ManufacturingMaskShapeParticipationReference, b: ManufacturingMaskShapeParticipationReference) => a.layer === b.layer && a.fileName === b.fileName && a.contentBytes === b.contentBytes && a.shapeIndex === b.shapeIndex;
			const strictInside = (pointValue: Point): boolean => { const angle = -candidate.maskGeometry.rotationDegrees * Math.PI / 180; const dx = pointValue[0] - candidate.maskGeometry.centerMil[0]; const dy = pointValue[1] - candidate.maskGeometry.centerMil[1]; const x = dx * Math.cos(angle) - dy * Math.sin(angle); const y = dx * Math.sin(angle) + dy * Math.cos(angle); const margin = 2 * halfCoordinateQuantumMil; return Math.abs(x) < candidate.maskGeometry.coreWidthMil / 2 - margin && Math.abs(y) < candidate.maskGeometry.coreHeightMil / 2 - margin; };
			const eligibleWitnesses = only ? args.maskParticipation.results.flatMap(result => result.witness && result.layer === candidate.layer && result.manufacturingContribution === 'verified-at-witnesses' && result.witness.mask.necessaryContribution && strictInside(result.witness.pointMil) ? result.witness.mask.necessaryContributorRefs.filter(reference => same(reference, only)).map(reference => ({ reference, conflictIndex: result.conflictIndex, areaIndex: result.areaIndex, pointMil: [...result.witness!.pointMil] as Point, insideCandidateMask: true as const })) : []) : [];
			const necessaryMaskReferencesInside = eligibleWitnesses.map(item => item.reference);
			const witnessLinks = eligibleWitnesses;
			matches.push({ sourceIdentity: candidate.sourceIdentity, runtimePadId: candidate.runtimePad.id, padNumber: candidate.padNumber, side: candidate.layer, sourcePadModel: candidate.sourcePad, association: status, uniqueSourceAttribution: false, maskReferences: rectMatches, uncertainMaskReferences: uncertainRectReferences, necessaryMaskReferences: necessaryMaskReferencesInside, geometryChecks: { pureRectOnly: true, flashCenterMatched: centerMatched, dimensionsMatched, angleMatched, formatSupported: true }, witnessLinks, ...(status !== 'geometry-correlated' ? { reason: uncertainRectReferences.length ? 'Rect候选存在未能判定的精度参数，阻断确定关联' : rectMatches.length > 1 ? '多个Rect或R aperture与纯矩形mask匹配，未任选来源' : '未找到中心、尺寸和对应角度匹配的矩形flash' } : {}) });
			continue;
		}
		const candidates = layer.shapes.flatMap((shape, shapeIndex) => {
			args.checkBudget?.();
			if (shape.kind !== 'flash' || shape.polarity !== 'dark' || shape.flashCenterMil === undefined)
				return [];
			const aperture = layer.apertures.find(item => item.id === shape.apertureId);
			if (!aperture || aperture.shape !== 'RoundRect' || aperture.parameters.length !== 5 || !aperture.parameters.every(Number.isFinite))
				return [];
			const [diameterMm, x1Mm, y1Mm, x2Mm, y2Mm] = aperture.parameters;
			const radiusMil = diameterMm * MM_TO_MIL / 2;
			const flashCenterMatched = pointMatchesFs45(candidate, shape.flashCenterMil!, candidate.maskGeometry.centerMil);
			const radiusRoundingBound = Number.EPSILON * (Math.abs(radiusMil) + Math.abs(candidate.maskGeometry.expansionRadiusMil));
			const positiveRadiusMatched = radiusMil > 0 && Math.abs(radiusMil - candidate.maskGeometry.expansionRadiusMil) <= halfRadiusQuantumMil + radiusRoundingBound;
			const actualCornerCenters: Point[] = [[x1Mm, y1Mm], [x2Mm, y2Mm], [-x1Mm, -y1Mm], [-x2Mm, -y2Mm]].map(([x, y]) => [x * MM_TO_MIL, y * MM_TO_MIL]);
			const expectedCorners = candidate.copperGeometry.cornerPointsMil.map(([x, y]) => [x - candidate.copperGeometry.centerMil[0], y - candidate.copperGeometry.centerMil[1]] as Point);
			const allFourCoreCornersMatched = actualCornerCenters.length === 4 && expectedCorners.length === 4
				&& actualCornerCenters.every(actual => expectedCorners.some(expected => pointMatchesFs45(candidate, actual, expected)))
				&& expectedCorners.every(expected => actualCornerCenters.some(actual => pointMatchesFs45(candidate, actual, expected)));
			return [{ shapeIndex, reference: { layer: layerName, fileName: layer.fileName, contentBytes: layer.contentBytes, shapeIndex }, flashCenterMatched, positiveRadiusMatched, allFourCoreCornersMatched }];
		});
		const geometricMatches = candidates.filter(candidateMatch => candidateMatch.flashCenterMatched && candidateMatch.positiveRadiusMatched && candidateMatch.allFourCoreCornersMatched);
		const maskReferences = geometricMatches.map(candidateMatch => candidateMatch.reference);
		const uniquelyMatchedReference = geometricMatches.length === 1 ? geometricMatches[0].reference : undefined;
		const sameReference = (reference: ManufacturingMaskShapeParticipationReference, other: ManufacturingMaskShapeParticipationReference) => reference.layer === other.layer && reference.fileName === other.fileName && reference.contentBytes === other.contentBytes && reference.shapeIndex === other.shapeIndex;
		const necessaryMaskReferences = uniquelyMatchedReference ? args.maskParticipation.results.flatMap(result => {
			if (!result.witness || result.layer !== candidate.layer || result.manufacturingContribution !== 'verified-at-witnesses')
				return [];
			const sideEvidence = result.witness.mask;
			if (!sideEvidence.necessaryContribution)
				return [];
			return sideEvidence.necessaryContributorRefs.filter(reference => sameReference(reference, uniquelyMatchedReference) && containsCandidateMaskPoint(candidate, result.witness!.pointMil));
		}) : [];
		const witnessLinks = uniquelyMatchedReference ? args.maskParticipation.results.flatMap(result => {
			if (!result.witness || result.layer !== candidate.layer || result.manufacturingContribution !== 'verified-at-witnesses')
				return [];
			if (!result.witness.mask.necessaryContribution || !result.witness.mask.necessaryContributorRefs.some(reference => sameReference(reference, uniquelyMatchedReference)))
				return [];
			const pointValue = result.witness.pointMil;
			return result.witness.mask.necessaryContributorRefs.filter(reference => sameReference(reference, uniquelyMatchedReference) && containsCandidateMaskPoint(candidate, pointValue)).map(reference => ({ reference, conflictIndex: result.conflictIndex, areaIndex: result.areaIndex, pointMil: [...pointValue] as Point, insideCandidateMask: true }));
		}) : [];
		const first = geometricMatches.length === 1 ? geometricMatches[0] : undefined;
		const status = geometricMatches.length > 1 ? 'ambiguous' as const : geometricMatches.length === 1 ? 'geometry-correlated' as const : candidates.length > 0 ? 'not-matched' as const : 'geometry-match-uncertain' as const;
		matches.push({
			sourceIdentity: candidate.sourceIdentity, runtimePadId: candidate.runtimePad.id, padNumber: candidate.padNumber, side: candidate.layer, sourcePadModel: candidate.sourcePad,
			association: status, uniqueSourceAttribution: false, maskReferences, necessaryMaskReferences,
			geometryChecks: { roundRectOnly: true, flashCenterMatched: first?.flashCenterMatched ?? geometricMatches.some(item => item.flashCenterMatched), allFourCoreCornersMatched: first?.allFourCoreCornersMatched ?? geometricMatches.some(item => item.allFourCoreCornersMatched), positiveRadiusMatched: first?.positiveRadiusMatched ?? geometricMatches.some(item => item.positiveRadiusMatched), formatSupported: true },
			witnessLinks,
			...(status !== 'geometry-correlated' ? { reason: status === 'ambiguous' ? '多个制造flash与该焊盘mask几何完全匹配，未任选来源' : status === 'not-matched' ? '当前已解析范围内未找到同时匹配中心、四个核角点和正扩张半径的flash' : '目标层没有可检查的dark RoundRect flash' } : {}),
		});
	}
	return { scope: 'manufacturing-pad-mask-opening-association', available: true, complete: false, sourceStable, uniqueSourceAttribution: false, modelAssumptions, matches, skipped };
}
