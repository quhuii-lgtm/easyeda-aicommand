import type { CheckedBoxObject, SilkLayer } from './silkscreenCheck';
import { selectDsnPadPhysicalViews, type DsnPadPhysicalSelection, type DsnPadPhysicalShape } from './dsnPadPhysicalView';

interface SourceRecord { header: Record<string, any>; data: any; line: number }
interface BBox { minX: number; minY: number; maxX: number; maxY: number }
interface EffectiveResult { records: Map<string, SourceRecord>; errors: Array<{ id?: string; reason: string }>; uuid?: string }
type CurvePoint = [number, number];
type CurvePrimitive = { type: 'line'; a: CurvePoint; b: CurvePoint }
	| { type: 'arc'; a: CurvePoint; b: CurvePoint; center: CurvePoint; radius: number; sweepDegrees: number };
type FootprintSilkSegment = { type: 'line'; a: { x: number; y: number }; b: { x: number; y: number } }
	| { type: 'arc'; a: { x: number; y: number }; b: { x: number; y: number }; center: { x: number; y: number }; radius: number; sweepDegrees: number };

function arcFromEndpoints(a: CurvePoint, b: CurvePoint, sweepDegrees: number): Extract<CurvePrimitive, { type: 'arc' }> | undefined {
	if (![...a, ...b, sweepDegrees].every(Number.isFinite) || Math.abs(sweepDegrees) <= 0 || Math.abs(sweepDegrees) >= 360)
		return undefined;
	const dx = b[0] - a[0]; const dy = b[1] - a[1]; const chord = Math.hypot(dx, dy);
	if (!(chord > 0) || !Number.isFinite(chord))
		return undefined;
	const theta = sweepDegrees * Math.PI / 180;
	const radius = chord / (2 * Math.abs(Math.sin(theta / 2)));
	const offset = chord / (2 * Math.tan(theta / 2));
	const center: CurvePoint = [(a[0] + b[0]) / 2 - dy / chord * offset, (a[1] + b[1]) / 2 + dx / chord * offset];
	if (![radius, ...center].every(Number.isFinite))
		return undefined;
	return { type: 'arc', a: [...a], b: [...b], center, radius, sweepDegrees };
}

function arcBounds(segment: Extract<CurvePrimitive, { type: 'arc' }>): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
	const tau = Math.PI * 2;
	const mod = (value: number) => ((value % tau) + tau) % tau;
	const start = Math.atan2(segment.a[1] - segment.center[1], segment.a[0] - segment.center[0]);
	const sweep = segment.sweepDegrees * Math.PI / 180;
	const bounds = { xMin: Math.min(segment.a[0], segment.b[0]), yMin: Math.min(segment.a[1], segment.b[1]), xMax: Math.max(segment.a[0], segment.b[0]), yMax: Math.max(segment.a[1], segment.b[1]) };
	for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
		const onSweep = sweep >= 0 ? mod(angle - start) <= sweep + 1e-12 : mod(start - angle) <= -sweep + 1e-12;
		if (!onSweep)
			continue;
		const x = segment.center[0] + segment.radius * Math.cos(angle); const y = segment.center[1] + segment.radius * Math.sin(angle);
		if (!Number.isFinite(x) || !Number.isFinite(y))
			return undefined;
		bounds.xMin = Math.min(bounds.xMin, x); bounds.yMin = Math.min(bounds.yMin, y);
		bounds.xMax = Math.max(bounds.xMax, x); bounds.yMax = Math.max(bounds.yMax, y);
	}
	return bounds;
}

function primitiveBounds(segment: CurvePrimitive): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
	if (segment.type === 'arc')
		return arcBounds(segment);
	return { xMin: Math.min(segment.a[0], segment.b[0]), yMin: Math.min(segment.a[1], segment.b[1]), xMax: Math.max(segment.a[0], segment.b[0]), yMax: Math.max(segment.a[1], segment.b[1]) };
}

export interface FootprintSilkStroke {
	confirmed: false;
	sourceIdentity: { componentId: string; footprintUuid: string; localPrimitiveId: string; source: 'document-embedded' | 'project-library'; libraryUuid?: string };
	local: { a: { x: number; y: number }; b: { x: number; y: number }; points: Array<{ x: number; y: number }>; segments: FootprintSilkSegment[]; closed: boolean; segmentCount: number; width: number; layerId: number };
	global: { a: { x: number; y: number }; b: { x: number; y: number }; points: Array<{ x: number; y: number }>; segments: FootprintSilkSegment[]; closed: boolean; segmentCount: number; width: number };
	side: SilkLayer;
	bbox: BBox;
}

export interface FootprintSilkResult {
	strokes: FootprintSilkStroke[];
	potentialConflicts: Array<{ a: unknown; b: unknown; category: string; confirmed: false; evidence: 'BOX_NEIGHBOR'; bboxDistanceMil: number }>;
	unsupported: Array<{ type: string; componentId?: string; designator?: string; footprintUuid?: string; localPrimitiveId?: string; reason: string }>;
	coverage: { scope: string; supportedSubset: string; effectiveFootprintCount: number; mappedComponentCount: number; checkedStrokeCount: number; excludedOutOfScopePolyCount: number; unsupportedCount: number; complete: false; sourcesAvailable: boolean; sourceStable: boolean; sources: Array<{ footprintUuid: string; source: 'document-embedded' | 'project-library'; libraryUuid?: string }> };
	sourceSummary: unknown;
}

export interface ProjectLibrarySource {
	footprintUuid: string;
	libraryUuid?: string;
	documentSource?: string;
	status: 'found' | 'missing' | 'sdk-error' | 'invalid';
	reason?: string;
}

export type FootprintPadMaskSourcePad =
  | { shape: 'RECT'; localCopperLayerId: 1 | 2 | 12; widthMil: number; heightMil: number; radiusMil: 0; sourceTopSolderExpansion: unknown; sourceBottomSolderExpansion: unknown; expansionMapping: 'local-layer1-follows-component-side' | 'local-layer2-opposite-component-side' | 'local-surface-1-follows-component-side' | 'local-surface-2-opposite-component-side'; selectedExpansionField: 'topSolderExpansion' | 'bottomSolderExpansion'; solderExpansionMil: number; expansionResolution: PadMaskExpansionResolution; normalizedSpecialView?: RuntimeNormalizedSpecialPadView; runtimePhysicalView?: RuntimePhysicalPadView; dsnPhysicalView?: DsnPadPhysicalSelection; localSurface?: 1 | 2; sourceDrillMetadata?: Record<string, unknown>; runtimeBBoxModel?: 'default-and-special-union' | 'normalized-physical-1-12-2-union' | 'runtime-physical-top-bottom-all-inner-union' | 'dsn-outer-and-runtime-special-union' }
  | { shape: 'ELLIPSE'; localCopperLayerId: 1 | 2 | 12; diameterMil: number; sourceTopSolderExpansion: unknown; sourceBottomSolderExpansion: unknown; expansionMapping: 'local-layer1-follows-component-side' | 'local-layer2-opposite-component-side' | 'local-surface-1-follows-component-side' | 'local-surface-2-opposite-component-side'; selectedExpansionField: 'topSolderExpansion' | 'bottomSolderExpansion'; solderExpansionMil: number; expansionResolution: PadMaskExpansionResolution; normalizedSpecialView?: RuntimeNormalizedSpecialPadView; runtimePhysicalView?: RuntimePhysicalPadView; dsnPhysicalView?: DsnPadPhysicalSelection; sourceHeightMil?: number; shapeInterpretation?: 'circle-width-based-runtime'; localSurface?: 1 | 2; sourceDrillMetadata?: Record<string, unknown>; runtimeBBoxModel?: 'default-and-special-union' | 'normalized-physical-1-12-2-union' | 'runtime-physical-top-bottom-all-inner-union' | 'dsn-outer-and-runtime-special-union' }
  | { shape: 'OVAL'; localCopperLayerId: 1 | 2 | 12; widthMil: number; heightMil: number; sourceTopSolderExpansion: unknown; sourceBottomSolderExpansion: unknown; expansionMapping: 'local-layer1-follows-component-side' | 'local-layer2-opposite-component-side' | 'local-surface-1-follows-component-side' | 'local-surface-2-opposite-component-side'; selectedExpansionField: 'topSolderExpansion' | 'bottomSolderExpansion'; solderExpansionMil: number; expansionResolution: PadMaskExpansionResolution; normalizedSpecialView?: RuntimeNormalizedSpecialPadView; runtimePhysicalView?: RuntimePhysicalPadView; dsnPhysicalView?: DsnPadPhysicalSelection; shapeInterpretation: 'capsule'; localSurface?: 1 | 2; sourceDrillMetadata?: Record<string, unknown>; runtimeBBoxModel?: 'default-and-special-union' | 'normalized-physical-1-12-2-union' | 'runtime-physical-top-bottom-all-inner-union' | 'dsn-outer-and-runtime-special-union' };

export type PadMaskExpansionResolution = { resolution: 'source-explicit' | 'runtime-effective'; sourceValue: unknown; runtimePadId?: string; physicalSide: 'top' | 'bottom'; runtimeField: 'topSolderMask' | 'bottomSolderMask'; runtimeValue?: number };
export interface RuntimeNormalizedSpecialPadViewEntry { startLayer: 1 | 12 | 2; endLayer: 1 | 12 | 2; shape: PadShapeSourceData; sourceIndices: number[]; precision: 'exact' | 'rounded-0.1mil' }
export interface RuntimeNormalizedSpecialPadView { sourceSpecialPad: unknown[]; entries: RuntimeNormalizedSpecialPadViewEntry[]; bboxModel: 'normalized-physical-1-12-2-union' }
export interface RuntimePhysicalPadViewShape { key: 'top' | 'bottom' | `inner:${string}`; shape: PadShapeSourceData; sourceIndices: number[]; precision: 'exact' | 'rounded-0.1mil' }
export interface RuntimePhysicalPadView { raw: Record<string, unknown>; shapes: RuntimePhysicalPadViewShape[]; bboxModel: 'runtime-physical-top-bottom-all-inner-union'; rawDimensionUnitScaleToMil: 10 }

export type FootprintPadMaskCopperGeometry =
	| { centerMil: [number, number]; rotationDegrees: number; widthMil: number; heightMil: number; cornerPointsMil: Array<[number, number]> }
	| { centerMil: [number, number]; diameterMil: number };

export type FootprintPadMaskGeometry =
	| { centerMil: [number, number]; rotationDegrees: number; coreWidthMil: number; coreHeightMil: number; coreCornerPointsMil: Array<[number, number]>; expansionRadiusMil: number; pureRect?: true; outerBoundsMil: BBox }
	| { centerMil: [number, number]; openingDiameterMil: number; outerBoundsMil: BBox }
	| { centerMil: [number, number]; rotationDegrees: number; axisHalfLengthMil: number; coreRadiusMil: number; expansionRadiusMil: number; openingDiameterMil: number; axisEndpointsMil: [[number, number], [number, number]]; outerBoundsMil: BBox };

interface FootprintPadMaskCandidateCommon {
	sourceIdentity: { componentId: string; footprintUuid: string; localPrimitiveId: string; source: 'document-embedded' | 'project-library'; libraryUuid?: string };
	componentId: string;
	padNumber: string;
	layer: 'top' | 'bottom';
	runtimePad: { id: string; shape: string; rotation: number; boxMil: BBox; centerMil: [number, number]; layer?: number; runtimeBBoxModel?: 'default-and-special-union' | 'normalized-physical-1-12-2-union' | 'runtime-physical-top-bottom-all-inner-union' | 'dsn-outer-and-runtime-special-union' };
}

export type FootprintPadMaskCandidate = FootprintPadMaskCandidateCommon & (
	| { sourcePad: Extract<FootprintPadMaskSourcePad, { shape: 'RECT' }>; copperGeometry: Extract<FootprintPadMaskCopperGeometry, { widthMil: number }>; maskGeometry: Extract<FootprintPadMaskGeometry, { coreWidthMil: number }> }
	| { sourcePad: Extract<FootprintPadMaskSourcePad, { shape: 'ELLIPSE' }>; copperGeometry: Extract<FootprintPadMaskCopperGeometry, { diameterMil: number }>; maskGeometry: Extract<FootprintPadMaskGeometry, { openingDiameterMil: number }> }
	| { sourcePad: Extract<FootprintPadMaskSourcePad, { shape: 'OVAL' }>; copperGeometry: Extract<FootprintPadMaskCopperGeometry, { widthMil: number }>; maskGeometry: Extract<FootprintPadMaskGeometry, { axisHalfLengthMil: number }> }
);

export interface FootprintPadMaskCandidateReport {
	scope: 'stable-footprint-pad-and-runtime-mask-candidates';
	available: boolean;
	unavailableReason?: string;
	complete: false;
	sourceStable: boolean;
	modelAssumptions: string[];
	candidates: FootprintPadMaskCandidate[];
	closed: Array<{ sourceIdentity: FootprintPadMaskCandidate['sourceIdentity']; componentId: string; padNumber: string; layer: 'top' | 'bottom'; runtimePadId: string; shape: 'RECT' | 'ELLIPSE' | 'OVAL'; selectedExpansionField: 'topSolderExpansion' | 'bottomSolderExpansion'; solderExpansionMil: number; expansionResolution: PadMaskExpansionResolution; normalizedSpecialView?: RuntimeNormalizedSpecialPadView; runtimePhysicalView?: RuntimePhysicalPadView; dsnPhysicalView?: DsnPadPhysicalSelection; centerMil: [number, number]; rotationDegrees: number; widthMil: number; heightMil: number; state: 'model-predicted-closed' }>;
	overrideNeeded: Array<{ sourceIdentity: FootprintPadMaskCandidate['sourceIdentity']; componentId: string; padNumber: string; runtimePadId: string; physicalSide: 'top' | 'bottom'; sourceField: 'topSolderExpansion' | 'bottomSolderExpansion'; sourceValue: number; runtimeField: 'topSolderMask' | 'bottomSolderMask'; runtimeValue: number; state: 'override-needed' }>;
	skipped: Array<{ componentId?: string; padNumber?: string; reason: string; physicalPadViewDiagnostic?: Record<string, unknown> }>;
}

type PadShapeSourceData = { padType: 'RECT' | 'ELLIPSE' | 'OVAL'; width: number; height: number; radius?: number };
function normalizePadShapeSource(value: unknown): PadShapeSourceData | undefined {
	if (!obj(value) || !['RECT', 'ELLIPSE', 'OVAL'].includes(value.padType) || !finite(value.width) || !(value.width > 0) || !finite(value.height) || !(value.height > 0)) return undefined;
	if (value.padType === 'RECT' && value.radius !== 0) return undefined;
	if (value.attrsMap !== undefined && (!obj(value.attrsMap) || Object.keys(value.attrsMap).length !== 0)) return undefined;
	return { padType: value.padType, width: value.width, height: value.height, radius: value.padType === 'RECT' ? 0 : finite(value.radius) ? value.radius : 0 };
}
function normalizeRuntimePadShape(value: unknown): PadShapeSourceData | undefined {
	if (!Array.isArray(value) || (value[0] === 'RECT' ? value.length !== 4 : value[0] === 'ELLIPSE' || value[0] === 'OVAL' ? value.length !== 3 : true)) return undefined;
	const normalized = normalizePadShapeSource({ padType: value[0], width: value[1], height: value[2], ...(value[0] === 'RECT' ? { radius: value[3] } : {}) });
	return normalized;
}
function normalizedShapeNumbers(shape: PadShapeSourceData): number[] {
	return shape.padType === 'ELLIPSE' ? [shape.width, shape.width] : shape.padType === 'RECT' ? [shape.width, shape.height, shape.radius ?? 0] : [shape.width, shape.height];
}
function normalizedShapeKey(shape: PadShapeSourceData): string {
	return JSON.stringify([shape.padType, ...normalizedShapeNumbers(shape)]);
}
function resolveRuntimeSpecialView(sourceDefault: PadShapeSourceData, sourceSpecial: unknown[], runtimeState: unknown): RuntimeNormalizedSpecialPadView | undefined {
	if (!Array.isArray(runtimeState) || runtimeState.length !== 3) return undefined;
	const expectedLayers = [1, 12, 2] as const;
	const runtimeByLayer = new Map<number, { startLayer: 1 | 12 | 2; endLayer: 1 | 12 | 2; shape: PadShapeSourceData }>();
	for (const entry of runtimeState) {
		if (!Array.isArray(entry) || entry.length !== 3 || !expectedLayers.includes(entry[0]) || entry[1] !== entry[0] || runtimeByLayer.has(entry[0])) return undefined;
		const shape = normalizeRuntimePadShape(entry[2]);
		if (!shape) return undefined;
		runtimeByLayer.set(entry[0], { startLayer: entry[0], endLayer: entry[1], shape });
	}
	if (runtimeByLayer.size !== 3 || expectedLayers.some(layer => !runtimeByLayer.has(layer))) return undefined;
	const runtimeEntries = expectedLayers.map(layer => runtimeByLayer.get(layer)!);
	const declarations: Array<{ sourceIndex: number; shape: PadShapeSourceData }> = [{ sourceIndex: -1, shape: sourceDefault }];
	for (let index = 0; index < sourceSpecial.length; index++) {
		const entry = sourceSpecial[index];
		if (!obj(entry) || !obj(entry.pad)) return undefined;
		const shape = normalizePadShapeSource(entry.pad);
		if (!shape) return undefined;
		declarations.push({ sourceIndex: index, shape });
	}
	const entries: RuntimeNormalizedSpecialPadViewEntry[] = [];
	for (const runtimeEntry of runtimeEntries) {
		const runtimeNumbers = normalizedShapeNumbers(runtimeEntry.shape);
		const matches = declarations.filter(declaration => {
			if (declaration.shape.padType !== runtimeEntry.shape.padType) return false;
			const sourceNumbers = normalizedShapeNumbers(declaration.shape);
			return sourceNumbers.length === runtimeNumbers.length && sourceNumbers.every((value, index) => value === runtimeNumbers[index] || runtimeNumbers[index] === Math.round(value * 10) / 10);
		});
		const geometries = new Set(matches.map(item => normalizedShapeKey(item.shape)));
		if (!matches.length || geometries.size !== 1) return undefined;
		const hasExact = matches.some(item => normalizedShapeNumbers(item.shape).every((value, index) => value === runtimeNumbers[index]));
		entries.push({ ...runtimeEntry, shape: matches[0].shape, sourceIndices: matches.map(item => item.sourceIndex).sort((a, b) => a - b), precision: hasExact ? 'exact' : 'rounded-0.1mil' });
	}
	return { sourceSpecialPad: sourceSpecial.map(item => item), entries, bboxModel: 'normalized-physical-1-12-2-union' };
}
interface RuntimeSpecialShapeSet { entries: Array<{ shape: PadShapeSourceData; sourceIndices: number[]; precision: 'exact' | 'rounded-0.1mil' }>; bboxModel: 'runtime-special-shapes-keys-ignored' }
function resolveRuntimeSpecialShapes(sourceDefault: PadShapeSourceData, sourceSpecial: unknown[], runtimeState: unknown): RuntimeSpecialShapeSet | undefined {
	if (!Array.isArray(runtimeState) || runtimeState.length === 0) return undefined;
	const declarations: Array<{ sourceIndex: number; shape: PadShapeSourceData }> = [{ sourceIndex: -1, shape: sourceDefault }];
	for (let index = 0; index < sourceSpecial.length; index++) {
		const entry = sourceSpecial[index]; if (!obj(entry) || !obj(entry.pad)) return undefined;
		const shape = normalizePadShapeSource(entry.pad); if (!shape) return undefined;
		declarations.push({ sourceIndex: index, shape });
	}
	const entries: RuntimeSpecialShapeSet['entries'] = [];
	for (const entry of runtimeState) {
		if (!Array.isArray(entry) || entry.length !== 3) return undefined;
		const runtimeShape = normalizeRuntimePadShape(entry[2]); if (!runtimeShape) return undefined;
		const runtimeNumbers = normalizedShapeNumbers(runtimeShape);
		const matches = declarations.filter(declaration => {
			if (declaration.shape.padType !== runtimeShape.padType) return false;
			const sourceNumbers = normalizedShapeNumbers(declaration.shape);
			return sourceNumbers.length === runtimeNumbers.length && sourceNumbers.every((value, index) => value === runtimeNumbers[index] || runtimeNumbers[index] === Math.round(value * 10) / 10);
		});
		if (!matches.length || new Set(matches.map(match => normalizedShapeKey(match.shape))).size !== 1) return undefined;
		const exact = matches.some(match => normalizedShapeNumbers(match.shape).every((value, index) => value === runtimeNumbers[index]));
		entries.push({ shape: matches[0].shape, sourceIndices: matches.map(match => match.sourceIndex).sort((a, b) => a - b), precision: exact ? 'exact' : 'rounded-0.1mil' });
	}
	return { entries, bboxModel: 'runtime-special-shapes-keys-ignored' };
}
function runtimeSpecialStateHasDuplicateKeys(state: unknown): boolean {
	if (!Array.isArray(state)) return false;
	const keys = new Set<string>();
	for (const entry of state) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const key = JSON.stringify([entry[0], entry[1]]);
		if (keys.has(key)) return true;
		keys.add(key);
	}
	return false;
}
function isConfirmedEmptyNetPrimitiveQuery(state: unknown): boolean {
	if (!obj(state)) return false;
	const request = obj(state.requestNetwork) ? state.requestNetwork : undefined;
	return state.status === 'invalid' && state.api === 'pcb_Net.getAllPrimitivesByNet'
		&& request?.type === 'string' && request.value === '' && state.resultStatus === 'value'
		&& state.resultCount === 0 && state.idMatchCount === 0;
}
function resolveRuntimePhysicalPadView(sourceDefault: PadShapeSourceData, sourceSpecial: unknown[], state: unknown, snapshot: { id?: unknown; componentId?: unknown; layer?: unknown; net?: unknown }, diagnostic?: Record<string, unknown>): RuntimePhysicalPadView | undefined {
	const fail = (category: string, field: string): undefined => { if (diagnostic) Object.assign(diagnostic, { category, field }); return undefined; };
	if (!obj(state) || state.status !== 'value' || !obj(state.raw)) return fail('supplemental-view-unavailable', 'runtimePhysicalPadView');
	const raw = state.raw;
	if (typeof raw.globalIndex !== 'string' || !raw.globalIndex || raw.globalIndex !== snapshot.id
		|| typeof raw.parentId !== 'string' || raw.parentId !== snapshot.componentId || raw.layerId !== 12 || raw.pcbItemPrimitiveType !== 'Pad'
		|| typeof snapshot.net !== 'string' || typeof raw.net !== 'string' || raw.net !== snapshot.net
		|| raw.layerId !== snapshot.layer || (typeof snapshot.id !== 'string' || !snapshot.id)) return fail('identity-or-network-mismatch', 'raw.identity');
	const declarations: Array<{ sourceIndex: number; shape: PadShapeSourceData }> = [{ sourceIndex: -1, shape: sourceDefault }];
	for (let index = 0; index < sourceSpecial.length; index++) {
		const entry = sourceSpecial[index]; if (!obj(entry) || !obj(entry.pad)) return fail('invalid-source-shape', `sourceSpecial[${index}]`);
		const shape = normalizePadShapeSource(entry.pad); if (!shape) return fail('invalid-source-shape', `sourceSpecial[${index}].pad`);
		declarations.push({ sourceIndex: index, shape });
	}
	const rawShapes: Array<{ key: RuntimePhysicalPadViewShape['key']; type: unknown; width: unknown; height: unknown; ratio: unknown; pl?: unknown }> = [];
	for (const face of ['top', 'bottom'] as const) {
		const prefix = face;
		rawShapes.push({ key: face, type: raw[`${prefix}Type`], width: raw[`${prefix}Width`], height: raw[`${prefix}Height`], ratio: raw[`${prefix}Ratio`] });
	}
	if (!obj(raw.inner)) return fail('missing-or-invalid-inner', 'raw.inner');
	for (const key of Object.keys(raw.inner).sort()) {
		const item = raw.inner[key]; if (!obj(item)) return fail('invalid-inner-entry', `raw.inner.${key}`);
		if (!Object.prototype.hasOwnProperty.call(item, 'pl')) return fail('missing-inner-pl', `raw.inner.${key}.pl`);
		rawShapes.push({ key: `inner:${key}`, type: item.type, width: item.width, height: item.height, ratio: item.ratio, pl: item.pl });
	}
	const shapes: RuntimePhysicalPadViewShape[] = [];
	for (const item of rawShapes) {
		if (!['RECT', 'ELLIPSE', 'OVAL'].includes(String(item.type)) || !finite(item.width) || item.width <= 0 || !finite(item.height) || item.height <= 0 || !finite(item.ratio)
			|| (item.pl !== undefined && item.pl !== null && !finite(item.pl))) return fail('unsupported-shape-or-invalid-dimensions', item.key);
		const padType = item.type as PadShapeSourceData['padType'];
		const shape: PadShapeSourceData = padType === 'RECT'
			? { padType, width: item.width * 10, height: item.height * 10, radius: 0 }
			: padType === 'ELLIPSE'
				? { padType, width: item.width * 10, height: item.width * 10, radius: 0 }
				: { padType, width: item.width * 10, height: item.height * 10, radius: 0 };
		if (![shape.width, shape.height].every(Number.isFinite)) return fail('dimension-conversion-overflow', item.key);
		if (item.ratio !== 0 || (item.key.startsWith('inner:') && item.pl !== null)) return fail('unsupported-ratio-or-pl', item.key);
		const runtimeNumbers = normalizedShapeNumbers(shape);
		const nearRawExact = (a: number, b: number) => Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
		const matches = declarations.filter(declaration => {
			if (declaration.shape.padType !== shape.padType) return false;
			const sourceNumbers = normalizedShapeNumbers(declaration.shape);
			return sourceNumbers.length === runtimeNumbers.length && sourceNumbers.every((value, index) => nearRawExact(value, runtimeNumbers[index]));
		});
		if (!matches.length) return fail('no-source-geometry-match', item.key);
		if (new Set(matches.map(match => normalizedShapeKey(match.shape))).size !== 1) return fail('ambiguous-source-geometry', item.key);
		shapes.push({ key: item.key, shape: matches[0].shape, sourceIndices: matches.map(match => match.sourceIndex).sort((a, b) => a - b), precision: 'exact' });
	}
	if (!shapes.some(item => item.key === 'top') || !shapes.some(item => item.key === 'bottom')) return fail('missing-physical-face', 'top/bottom');
	return { raw: { ...raw }, shapes, bboxModel: 'runtime-physical-top-bottom-all-inner-union', rawDimensionUnitScaleToMil: 10 };
}
function padShapeGetterMatches(snapshot: unknown, shapes: PadShapeSourceData[]): boolean {
	if (!Array.isArray(snapshot) || !shapes.length) return false;
	return shapes.some(shape => {
		const expected: unknown[] = shape.padType === 'RECT'
			? [shape.padType, shape.width, shape.height, shape.radius ?? 0]
			: shape.padType === 'ELLIPSE'
				? [shape.padType, shape.width, shape.width]
				: [shape.padType, shape.width, shape.height];
		if (snapshot.length !== expected.length) return false;
		return expected.every((source, index) => {
			const actual = snapshot[index];
			return typeof source === 'string' ? actual === source : typeof actual === 'number' && Number.isFinite(actual) && (actual === source || actual === Math.round((source as number) * 10) / 10);
		});
	});
}
function projectedPadShapeBounds(shape: PadShapeSourceData, center: [number, number], theta: number): BBox | undefined {
	const [cx, cy] = center;
	if (shape.padType === 'ELLIPSE') {
		const radius = shape.width / 2;
		const box = { minX: cx - radius, minY: cy - radius, maxX: cx + radius, maxY: cy + radius };
		return [radius, ...Object.values(box)].every(Number.isFinite) ? box : undefined;
	}
	if (shape.padType === 'OVAL') {
		const radius = Math.min(shape.width, shape.height) / 2;
		const axis = Math.abs(shape.width - shape.height) / 2;
		const angle = theta + (shape.width >= shape.height ? 0 : Math.PI / 2);
		const dx = axis * Math.cos(angle); const dy = axis * Math.sin(angle);
		const box = { minX: cx - Math.abs(dx) - radius, minY: cy - Math.abs(dy) - radius, maxX: cx + Math.abs(dx) + radius, maxY: cy + Math.abs(dy) + radius };
		return [radius, axis, dx, dy, ...Object.values(box)].every(Number.isFinite) ? box : undefined;
	}
	const corners: Array<[number, number]> = [[-shape.width / 2, -shape.height / 2], [shape.width / 2, -shape.height / 2], [shape.width / 2, shape.height / 2], [-shape.width / 2, shape.height / 2]].map(([x, y]) => [cx + x * Math.cos(theta) - y * Math.sin(theta), cy + x * Math.sin(theta) + y * Math.cos(theta)]);
	if (!corners.flat().every(Number.isFinite)) return undefined;
	return { minX: Math.min(...corners.map(p => p[0])), minY: Math.min(...corners.map(p => p[1])), maxX: Math.max(...corners.map(p => p[0])), maxY: Math.max(...corners.map(p => p[1])) };
}

export function projectComponentFootprintSilkUnsupported(items: FootprintSilkResult['unsupported']): Array<{ type: string; componentId?: string; designator?: string; reason: string }> {
	return items.filter(item => item.type === 'component-footprint-silk').map(item => ({
		type: item.type,
		componentId: item.componentId,
		designator: item.designator,
		reason: item.reason,
	}));
}

function componentMappingReason(reason: string): string {
	return reason.startsWith('来源映射未确认：') ? reason : `来源映射未确认：${reason}`;
}

export function invalidateFootprintSilkscreenSource(result: FootprintSilkResult, affectedComponents: Array<{ componentId: string; designator?: string }>, reason: string, componentReason = '预检期间封装来源通道变化或不可用，本次无法确认该器件封装丝印映射'): void {
	result.strokes = [];
	result.potentialConflicts = [];
	result.coverage.sourceStable = false;
	result.unsupported.push({ type: 'footprint-source', reason });
	for (const component of affectedComponents)
		result.unsupported.push({ type: 'component-footprint-silk', componentId: component.componentId, designator: component.designator, reason: componentMappingReason(componentReason) });
	result.coverage.checkedStrokeCount = 0;
	result.coverage.excludedOutOfScopePolyCount = 0;
	result.coverage.unsupportedCount = result.unsupported.length;
}

function obj(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
function key(type: string, id: string): string { return `${type}\u0000${id}`; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function fmtError(value: unknown): string { return value instanceof Error ? value.message : String(value); }

export async function readEmbeddedFootprintSources(host: { sdk: any; read: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> }, label: string): Promise<{ available: boolean; value?: unknown; reason?: string }> {
	if (typeof host.sdk.sys_FileManager?.getDocumentFootprintSources !== 'function')
		return { available: false, reason: 'sys_FileManager.getDocumentFootprintSources() 不存在' };
	return host.read(label, async () => {
		try {
			const value = await host.sdk.sys_FileManager.getDocumentFootprintSources();
			return Array.isArray(value) ? { available: true, value } : { available: false, reason: 'getDocumentFootprintSources() 未返回数组' };
		}
		catch (error) {
			return { available: false, reason: `嵌入封装来源读取失败：${fmtError(error)}` };
		}
	});
}

export async function readProjectLibraryUuid(host: { sdk: any; read: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> }, label: string): Promise<{ available: boolean; libraryUuid?: string; reason?: string }> {
	if (typeof host.sdk.lib_LibrariesList?.getProjectLibraryUuid !== 'function')
		return { available: false, reason: 'lib_LibrariesList.getProjectLibraryUuid() 不存在' };
	return host.read(label, async () => {
		let value: unknown;
		try { value = await host.sdk.lib_LibrariesList.getProjectLibraryUuid(); }
		catch (error) { return { available: false, reason: `读取当前工程库 UUID 时 SDK 异常：${fmtError(error)}` }; }
		if (typeof value !== 'string' || !value.trim())
			return { available: false, reason: 'getProjectLibraryUuid() 未返回有效工程库 UUID' };
		return { available: true, libraryUuid: value.trim() };
	});
}

export async function readProjectLibraryFootprintSource(host: { sdk: any; read: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> }, footprintUuid: string, libraryUuid: string, label: string, checkBudget?: () => void): Promise<ProjectLibrarySource> {
	if (typeof host.sdk.lib_Footprint?.getDocumentSource !== 'function')
		return { footprintUuid, libraryUuid, status: 'invalid', reason: 'lib_Footprint.getDocumentSource() 不存在' };
	return host.read(label, async () => {
		let value: unknown;
		try { value = await host.sdk.lib_Footprint.getDocumentSource(footprintUuid, libraryUuid); }
		catch (error) { return { footprintUuid, libraryUuid, status: 'sdk-error', reason: `工程库封装来源读取时 SDK 异常：${fmtError(error)}` }; }
		if (value === undefined || value === null || typeof value === 'string' && !value.trim())
			return { footprintUuid, libraryUuid, status: 'missing', reason: `工程库 ${libraryUuid} 未返回封装 ${footprintUuid} 的源码` };
		if (typeof value !== 'string')
			return { footprintUuid, libraryUuid, status: 'invalid', reason: '工程库封装来源不是字符串' };
		checkBudget?.();
		const parsed = effective(value, footprintUuid, checkBudget);
		if (parsed.errors.length)
			return { footprintUuid, libraryUuid, documentSource: value, status: 'invalid', reason: `工程库封装来源格式或 UUID 核验失败：${parsed.errors.map(item => item.reason).join('；')}` };
		return { footprintUuid, libraryUuid, documentSource: value, status: 'found' };
	});
}

export async function readProjectLibrarySources(host: { sdk: any; read: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> }, uuids: string[], label: string, checkBudget?: () => void): Promise<ProjectLibrarySource[]> {
	const unique = [...new Set(uuids)].sort((a, b) => a.localeCompare(b));
	if (!unique.length)
		return [];
	const library = await readProjectLibraryUuid(host, `${label}：读取当前工程库身份`);
	const sources: ProjectLibrarySource[] = [];
	for (const footprintUuid of unique) {
		checkBudget?.();
		if (!library.available || !library.libraryUuid) {
			sources.push({ footprintUuid, status: 'sdk-error', reason: library.reason ?? '当前工程库身份不可用' });
			continue;
		}
		sources.push(await readProjectLibraryFootprintSource(host, footprintUuid, library.libraryUuid, `${label}：读取工程库封装 ${footprintUuid}`, checkBudget));
	}
	return sources;
}

/** Strict last-ticket resolution for footprint sources; never use the generic order-sensitive resolver here. */
function effective(source: string, expectedUuid?: string, checkBudget?: () => void): EffectiveResult {
	const records = new Map<string, SourceRecord>();
	const errors: EffectiveResult['errors'] = [];
	let uuid: string | undefined;
	const headUuids = new Set<string>();
	const conflicts = new Set<string>();
	const tickets = new Map<string, number>();
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		checkBudget?.();
		if (!raw.trim())
			continue;
		try {
			const separator = raw.indexOf('||');
			if (separator < 0)
				throw new Error('源码行格式非法');
			const header = JSON.parse(raw.slice(0, separator));
			let text = raw.slice(separator + 2);
			if (text.endsWith('|'))
				text = text.slice(0, -1);
			const data = text === '' ? '' : JSON.parse(text);
			if (!obj(header) || typeof header.type !== 'string' || !header.type)
				throw new Error('记录头 type 非法');
			if (header.type === 'DOCHEAD') {
				if (!obj(data) || data.docType !== 'FOOTPRINT' || typeof data.uuid !== 'string' || !data.uuid)
					throw new Error('DOCHEAD 不是带有效 UUID 的 FOOTPRINT');
				headUuids.add(data.uuid); uuid ??= data.uuid; continue;
			}
			if (typeof header.id !== 'string' || !header.id || !Number.isSafeInteger(header.ticket) || header.ticket < 0)
				throw new Error('记录缺少有效字符串 ID 或有限非负整数 ticket');
			const k = key(header.type, header.id);
			const current = records.get(k); const previousTicket = tickets.get(k);
			if (previousTicket === undefined || header.ticket > previousTicket) {
				tickets.set(k, header.ticket);
				records.set(k, { header, data, line: index + 1 }); conflicts.delete(k);
			}
			else if (header.ticket === previousTicket && !conflicts.has(k) && current && JSON.stringify(data) !== JSON.stringify(current.data)) {
				conflicts.add(k); records.delete(k);
			}
		}
		catch (error) { errors.push({ reason: `第 ${index + 1} 行：${fmtError(error)}` }); }
	}
	for (const k of conflicts) errors.push({ id: k.split('\u0000')[1], reason: '同一类型/ID 出现同 ticket 不同数据' });
	if (headUuids.size !== 1 || (expectedUuid && !headUuids.has(expectedUuid)))
		errors.push({ reason: `DOCHEAD UUID 缺失、冲突或与实例不符（${[...headUuids].join(', ') || '无'}）` });
	return { records, errors, uuid };
}

function summary(sources: unknown, checkBudget?: () => void, projectLibrarySources: ProjectLibrarySource[] = []): { available: boolean; summary: unknown; effective: Map<string, EffectiveResult>; errors: FootprintSilkResult['unsupported']; conflicts: Set<string>; origins: Map<string, { source: 'document-embedded' | 'project-library'; libraryUuid?: string }> } {
	const effectiveSources = new Map<string, EffectiveResult>();
	const errors: FootprintSilkResult['unsupported'] = [];
	const conflicts = new Set<string>();
	const origins = new Map<string, { source: 'document-embedded' | 'project-library'; libraryUuid?: string }>();
	if (!Array.isArray(sources))
		return { available: false, summary: null, effective: effectiveSources, errors: [{ type: 'footprint-source', reason: 'getDocumentFootprintSources 未返回数组' }], conflicts, origins };
	const grouped = new Map<string, string[]>();
	const embeddedClaims = new Set<string>();
	const invalidItems: Array<{ index: number; reason: string }> = [];
	for (const [index, item] of sources.entries()) {
		checkBudget?.();
		if (obj(item) && typeof item.footprintUuid === 'string' && item.footprintUuid)
			embeddedClaims.add(item.footprintUuid);
		if (!obj(item) || typeof item.footprintUuid !== 'string' || !item.footprintUuid || typeof item.documentSource !== 'string') {
			const reason = '封装来源项缺少有效 footprintUuid 或 documentSource';
			errors.push({ type: 'footprint-source', reason: `来源项 ${index}：${reason}` }); invalidItems.push({ index, reason }); continue;
		}
		const list = grouped.get(item.footprintUuid) ?? []; list.push(item.documentSource); grouped.set(item.footprintUuid, list);
	}
	const summaries: Array<{ footprintUuid: string; sourceCount: number; variants: unknown[]; conflict: boolean }> = [];
	for (const [uuid, texts] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
		checkBudget?.();
		const distinct = [...new Set(texts)];
		const isConflict = distinct.length !== 1;
		if (isConflict) { conflicts.add(uuid); errors.push({ type: 'footprint-source', footprintUuid: uuid, reason: '同一 footprintUuid 返回多个不同 documentSource' }); }
		const parsedVariants = distinct.map((sourceText, variantIndex) => {
			checkBudget?.();
			const parsed = effective(sourceText, uuid, checkBudget);
			for (const issue of parsed.errors) errors.push({ type: 'footprint-source', footprintUuid: uuid, localPrimitiveId: issue.id, reason: `来源变体 ${variantIndex + 1}：${issue.reason}` });
			const rows = [...parsed.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => [k, r.header.ticket, r.data]);
			return { parsed, summary: { effective: rows, errors: parsed.errors } };
		});
		if (!isConflict && parsedVariants[0]) {
			effectiveSources.set(uuid, parsedVariants[0].parsed);
			if (!parsedVariants[0].parsed.errors.length)
				origins.set(uuid, { source: 'document-embedded' });
		}
		summaries.push({ footprintUuid: uuid, sourceCount: texts.length, variants: parsedVariants.map(item => item.summary), conflict: isConflict });
	}
	const projectSummaries: Array<{ footprintUuid: string; libraryUuid?: string; status: string; reason?: string; effective?: unknown; errors?: unknown }> = [];
	for (const item of projectLibrarySources) {
		checkBudget?.();
		let parsed: EffectiveResult | undefined;
		if (typeof item.documentSource === 'string') {
			parsed = effective(item.documentSource, item.footprintUuid, checkBudget);
			if (parsed.errors.length) {
				for (const issue of parsed.errors)
					errors.push({ type: 'footprint-source', footprintUuid: item.footprintUuid, localPrimitiveId: issue.id, reason: `工程库来源：${issue.reason}` });
			}
		}
		projectSummaries.push({
			footprintUuid: item.footprintUuid,
			libraryUuid: item.libraryUuid,
			status: item.status,
			reason: item.reason,
			...(parsed ? { effective: [...parsed.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, record]) => [k, record.header.ticket, record.data]), errors: parsed.errors } : {}),
		});
		if (!embeddedClaims.has(item.footprintUuid) && item.status === 'found' && item.libraryUuid && parsed && !parsed.errors.length) {
			effectiveSources.set(item.footprintUuid, parsed);
			origins.set(item.footprintUuid, { source: 'project-library', libraryUuid: item.libraryUuid });
		}
		else if (!embeddedClaims.has(item.footprintUuid) && item.status !== 'found') {
			errors.push({ type: 'footprint-source', footprintUuid: item.footprintUuid, reason: item.reason ?? '工程库封装来源不可用' });
		}
	}
	return { available: true, summary: { sources: summaries, embeddedClaims: [...embeddedClaims].sort((a, b) => a.localeCompare(b)), invalidItems, projectLibrarySources: projectSummaries }, effective: effectiveSources, errors, conflicts, origins };
}

export function summarizeEmbeddedFootprintSources(sources: unknown, checkBudget?: () => void): unknown {
	return summary(sources, checkBudget).summary;
}

export function summarizeFootprintSourceSet(sources: unknown, projectLibrarySources: ProjectLibrarySource[], checkBudget?: () => void): unknown {
	return summary(sources, checkBudget, projectLibrarySources).summary;
}

function parseBoard(records: SourceRecord[], checkBudget?: () => void): EffectiveResult {
	const effectiveRecords = new Map<string, SourceRecord>();
	const errors: EffectiveResult['errors'] = [];
	const conflicted = new Set<string>();
	const tickets = new Map<string, number>();
	for (const record of records) {
		checkBudget?.();
		const type = record.header?.type; const id = record.header?.id; const ticket = record.header?.ticket;
		if (type === 'DOCHEAD')
			continue;
		if (typeof type !== 'string' || typeof id !== 'string' || !id || !Number.isSafeInteger(ticket) || ticket < 0) {
			errors.push({ id: typeof id === 'string' ? id : undefined, reason: `PCB 第 ${record.line} 行身份或 ticket 无效` }); continue;
		}
		const k = key(type, id); const current = effectiveRecords.get(k); const previousTicket = tickets.get(k);
		if (previousTicket === undefined || ticket > previousTicket) { tickets.set(k, ticket); effectiveRecords.set(k, record); conflicted.delete(k); }
		else if (ticket === previousTicket && !conflicted.has(k) && current && JSON.stringify(record.data) !== JSON.stringify(current.data)) { effectiveRecords.delete(k); conflicted.add(k); }
	}
	for (const k of conflicted) errors.push({ id: k.split('\u0000')[1], reason: 'PCB 同一类型/ID 出现同 ticket 不同数据' });
	for (const [k, record] of effectiveRecords) {
		if (record.data === '')
			effectiveRecords.delete(k);
	}
	return { records: effectiveRecords, errors };
}

export function findMissingProjectLibraryFootprintUuids(pcbRecords: SourceRecord[], components: any[], embeddedSources: unknown, checkBudget?: () => void): string[] {
	if (!Array.isArray(embeddedSources))
		return [];
	const embeddedClaims = new Set<string>();
	for (const item of embeddedSources) {
		checkBudget?.();
		if (obj(item) && typeof item.footprintUuid === 'string' && item.footprintUuid)
			embeddedClaims.add(item.footprintUuid);
	}
	const board = parseBoard(pcbRecords, checkBudget);
	if (board.errors.length)
		return [];
	const records = [...board.records.values()];
	const componentsById = new Map<string, any[]>();
	for (const component of components) {
		checkBudget?.();
		let id: unknown;
		try { id = component?.getState_PrimitiveId?.(); }
		catch { continue; }
		if (typeof id === 'string' && id)
			componentsById.set(id, [...(componentsById.get(id) ?? []), component]);
	}
	const targets = new Set<string>();
	for (const componentRecord of records) {
		checkBudget?.();
		if (componentRecord.header.type !== 'COMPONENT' || !obj(componentRecord.data) || typeof componentRecord.header.id !== 'string')
			continue;
		const componentId = componentRecord.header.id;
		const attrs: SourceRecord[] = [];
		for (const record of records) {
			checkBudget?.();
			if (record.header.type === 'ATTR' && obj(record.data) && record.data.key === 'Footprint' && record.data.parentId === componentId)
				attrs.push(record);
		}
		if (attrs.length !== 1 || typeof attrs[0].data.value !== 'string' || !attrs[0].data.value || (componentRecord.data.layerId !== 1 && componentRecord.data.layerId !== 2))
			continue;
		const runtime = componentsById.get(componentId) ?? [];
		if (runtime.length !== 1)
			continue;
		const instance = runtime[0];
		let fp: any, x: unknown, y: unknown, angle: unknown, layerId: unknown;
		try {
			fp = instance?.getState_Footprint?.();
			x = instance?.getState_X?.();
			y = instance?.getState_Y?.();
			angle = instance?.getState_Rotation?.();
			layerId = instance?.getState_Layer?.();
		}
		catch { continue; }
		const data = componentRecord.data;
		if (fp?.uuid !== attrs[0].data.value || layerId !== data.layerId || !finite(x) || !finite(y) || !finite(angle) || !finite(data.x) || !finite(data.y) || !finite(data.angle)
			|| Math.abs(x - data.x) > 1e-6 || Math.abs(y - data.y) > 1e-6 || Math.abs(angle - data.angle) > 1e-6) {
			continue;
		}
		const uuid = attrs[0].data.value;
		if (!embeddedClaims.has(uuid))
			targets.add(uuid);
	}
	return [...targets].sort((a, b) => a.localeCompare(b));
}

function curveBoundsBox(segments: CurvePrimitive[], width: number, checkBudget?: () => void): BBox | undefined {
	const r = width / 2;
	const box: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const segment of segments) {
		checkBudget?.();
		const bounds = primitiveBounds(segment);
		if (!bounds || ![bounds.xMin, bounds.yMin, bounds.xMax, bounds.yMax].every(Number.isFinite))
			return undefined;
		box.minX = Math.min(box.minX, bounds.xMin); box.minY = Math.min(box.minY, bounds.yMin);
		box.maxX = Math.max(box.maxX, bounds.xMax); box.maxY = Math.max(box.maxY, bounds.yMax);
	}
	const expanded = { minX: box.minX - r, minY: box.minY - r, maxX: box.maxX + r, maxY: box.maxY + r };
	return Object.values(expanded).every(Number.isFinite) ? expanded : undefined;
}

function parseCurvePath(path: unknown, checkBudget?: () => void): { points: CurvePoint[]; segments: CurvePrimitive[]; closed: boolean } | undefined {
	if (!Array.isArray(path) || path.length < 5 || !finite(path[0]) || !finite(path[1]))
		return undefined;
	const points: CurvePoint[] = [[path[0], path[1]]];
	const segments: CurvePrimitive[] = [];
	let index = 2;
	while (index < path.length) {
		checkBudget?.();
		const command = path[index];
		if (command === 'L') {
			index++;
			if (index + 1 >= path.length || !finite(path[index]) || !finite(path[index + 1]))
				return undefined;
			while (index + 1 < path.length && typeof path[index] === 'number') {
				checkBudget?.();
				if (!finite(path[index]) || !finite(path[index + 1]))
					return undefined;
				const a = points[points.length - 1]; const b: CurvePoint = [path[index], path[index + 1]];
				segments.push({ type: 'line', a, b }); points.push(b); index += 2;
			}
			continue;
		}
		if (command === 'ARC') {
			if (index + 3 >= path.length || !finite(path[index + 1]) || !finite(path[index + 2]) || !finite(path[index + 3]))
				return undefined;
			const a = points[points.length - 1]; const b: CurvePoint = [path[index + 2], path[index + 3]];
			const arc = arcFromEndpoints(a, b, path[index + 1]);
			if (!arc)
				return undefined;
			segments.push(arc);
			points.push(b); index += 4;
			continue;
		}
		return undefined;
	}
	if (!segments.length)
			return undefined;
	const first = points[0]; const last = points[points.length - 1];
	return { points, segments, closed: first[0] === last[0] && first[1] === last[1] };
}
function gap(a: BBox, b: BBox): number {
	const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
	const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
	return Math.hypot(dx, dy);
}

export function analyzeFootprintSilkscreen(args: {
	pcbRecords: SourceRecord[];
	components: any[];
	footprintSources: unknown;
	projectLibrarySources?: ProjectLibrarySource[];
	minClearance: number;
	checkedObjects: CheckedBoxObject[];
	checkBudget?: () => void;
}): FootprintSilkResult {
	const checkBudget = args.checkBudget;
	const footprintData = summary(args.footprintSources, checkBudget, args.projectLibrarySources ?? []);
	const unsupported = [...footprintData.errors];
	const board = parseBoard(args.pcbRecords, checkBudget);
	const boardErrors = board.errors.length > 0;
	const sourceComponents: SourceRecord[] = []; const sourceAttrs: SourceRecord[] = [];
	for (const r of board.records.values()) {
		checkBudget?.();
		if (r.header.type === 'COMPONENT' && obj(r.data))
			sourceComponents.push(r);
		if (r.header.type === 'ATTR' && obj(r.data) && r.data.key === 'Footprint')
			sourceAttrs.push(r);
	}
	const runtimeById = new Map<string, any[]>();
	for (const object of args.components) {
		checkBudget?.();
		const id = object?.getState_PrimitiveId?.();
		if (typeof id === 'string' && id)
			runtimeById.set(id, [...(runtimeById.get(id) ?? []), object]);
		else unsupported.push({ type: 'component', reason: 'SDK 器件缺少 getState_PrimitiveId()' });
	}
	const mappedIds = new Set<string>();
	const strokes: FootprintSilkStroke[] = [];
	let excludedOutOfScopePolyCount = 0;
	for (const componentRecord of sourceComponents) {
		checkBudget?.();
		const componentId = componentRecord.header.id;
		if (typeof componentId !== 'string')
			continue;
		const data = componentRecord.data;
		let sourceDesignator = String((data as any).designator ?? (data as any).attrs?.Designator ?? '');
		for (const candidate of board.records.values()) {
			checkBudget?.();
			if (candidate.header.type === 'ATTR' && obj(candidate.data) && candidate.data.parentId === componentId && candidate.data.key === 'Designator' && typeof candidate.data.value === 'string') {
				sourceDesignator = candidate.data.value;
				break;
			}
		}
		const attrs: SourceRecord[] = [];
		for (const r of sourceAttrs) {
			checkBudget?.(); if (r.data.parentId === componentId)
				attrs.push(r);
		}
		if (attrs.length !== 1 || typeof attrs[0]?.data.value !== 'string' || !attrs[0].data.value) {
			unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, reason: componentMappingReason('effective COMPONENT 未关联唯一且有效的 Footprint ATTR') }); continue;
		}
		const footprintUuid = attrs[0].data.value;
		const runtime = runtimeById.get(componentId) ?? [];
		if (runtime.length !== 1) { unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason(runtime.length ? 'SDK getAll() 返回重复器件 ID' : 'effective COMPONENT 缺少对应 SDK 器件') }); continue; }
		const instance = runtime[0];
		let fp: any, actual: { x: unknown; y: unknown; angle: unknown; layerId: unknown };
		try {
			fp = instance?.getState_Footprint?.();
			actual = { x: instance?.getState_X?.(), y: instance?.getState_Y?.(), angle: instance?.getState_Rotation?.(), layerId: instance?.getState_Layer?.() };
		}
		catch (error) { unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason(`SDK 器件状态读回失败：${fmtError(error)}`) }); continue; }
		if (fp?.uuid !== footprintUuid || !finite(actual.x) || !finite(actual.y) || !finite(actual.angle) || actual.layerId !== data.layerId
			|| !finite(data.x) || !finite(data.y) || !finite(data.angle) || Math.abs(actual.x - data.x) > 1e-6 || Math.abs(actual.y - data.y) > 1e-6 || Math.abs(actual.angle - data.angle) > 1e-6) {
			unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason('SDK 器件 footprint UUID、层、坐标或旋转与 effective COMPONENT/ATTR 不一致') }); continue;
		}
		const side: SilkLayer | undefined = data.layerId === 1 ? 'top' : data.layerId === 2 ? 'bottom' : undefined;
		if (!side) { unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason(`器件层 ${String(data.layerId)} 未映射到顶/底面`) }); continue; }
		const source = footprintData.effective.get(footprintUuid);
		if (!footprintData.available || !source) {
			const projectFailure = args.projectLibrarySources?.find(item => item.footprintUuid === footprintUuid && item.reason)?.reason;
			unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason(projectFailure ?? '当前文档未提供唯一且有效的该 footprintUuid 嵌入或当前工程库封装来源') }); continue;
		}
		if (footprintData.conflicts.has(footprintUuid) || source.errors.length > 0) { unsupported.push({ type: 'component-footprint-silk', componentId, designator: sourceDesignator, footprintUuid, reason: componentMappingReason('嵌入封装来源包含不同副本、非法记录或 UUID 冲突，未确认该器件丝印') }); continue; }
		mappedIds.add(componentId);
		const theta = actual.angle * Math.PI / 180; const c = Math.cos(theta); const s = Math.sin(theta);
		for (const record of source.records.values()) {
			checkBudget?.();
			const id = record.header.id;
			const item = record.data;
			if (!['POLY', 'POLYLINE', 'LINE', 'ARC'].includes(record.header.type))
				continue;
			if (record.header.type !== 'POLY') {
				if (obj(item) && (item.layerId === 3 || item.layerId === 4))
					unsupported.push({ type: `footprint-${record.header.type.toLowerCase()}`, componentId, footprintUuid, localPrimitiveId: id, reason: `封装来源 ${record.header.type} 尚未映射为支持的 L/ARC POLY` });
				continue;
			}
			if (obj(item) && typeof item.layerId === 'number' && Number.isFinite(item.layerId) && item.layerId !== 3 && item.layerId !== 4) {
				excludedOutOfScopePolyCount++;
				continue;
			}
			if (!obj(item) || (item.layerId !== 3 && item.layerId !== 4)) {
				unsupported.push({ type: 'footprint-poly', componentId, footprintUuid, localPrimitiveId: id, reason: `局部图层 ${String(obj(item) ? item.layerId : '缺失')} 不是已映射的 3/4 丝印层` }); continue;
			}
			const path = obj(item) ? parseCurvePath(item.path, checkBudget) : undefined;
			if (!path) { unsupported.push({ type: 'footprint-poly', componentId, footprintUuid, localPrimitiveId: id, reason: '仅支持 [x0,y0,"L",x1,y1,x2,y2,...] 的 L 坐标对及 ["ARC",sweepDegrees,x,y] 圆弧；弧角必须有限且非零、绝对值小于360，端点不得重合；曲线、未知指令或非法路径整体不支持' }); continue; }
			if (!finite(item.width) || item.width <= 0) { unsupported.push({ type: 'footprint-poly', componentId, footprintUuid, localPrimitiveId: id, reason: '线宽必须是有限正数' }); continue; }
			const transform = (u: number, v: number) => data.layerId === 1
				? { x: data.x + u * c - v * s, y: data.y + u * s + v * c }
				: { x: data.x + u * c + v * s, y: data.y + u * s - v * c };
			const asObject = (point: CurvePoint) => ({ x: point[0], y: point[1] });
			const globalPoint = (point: CurvePoint): CurvePoint => { const mapped = transform(point[0], point[1]); return [mapped.x, mapped.y]; };
			const localPoints = path.points.map(asObject); const globalCurvePoints = path.points.map(globalPoint); const globalPoints = globalCurvePoints.map(asObject);
			const localSegments = path.segments;
			const globalSegments: CurvePrimitive[] = path.segments.map(segment => {
				const a = globalPoint(segment.a); const b = globalPoint(segment.b);
				if (segment.type === 'line')
					return { type: 'line', a, b };
				return { type: 'arc', a, b, center: globalPoint(segment.center), radius: segment.radius, sweepDegrees: data.layerId === 2 ? -segment.sweepDegrees : segment.sweepDegrees };
			});
			const transformedValues = [...globalCurvePoints.flat(), ...globalSegments.flatMap(segment => segment.type === 'arc' ? [...segment.center, segment.radius, segment.sweepDegrees] : [] )];
			if (!transformedValues.every(Number.isFinite)) { unsupported.push({ type: 'footprint-poly', componentId, footprintUuid, localPrimitiveId: id, reason: '局部路径变换后出现非有限坐标或圆弧参数，整条路径不支持' }); continue; }
			const bbox = curveBoundsBox(globalSegments, item.width, checkBudget);
			if (!bbox) { unsupported.push({ type: 'footprint-poly', componentId, footprintUuid, localPrimitiveId: id, reason: '路径精确边界或线宽扩展后溢出，整条路径不支持' }); continue; }
			const toPublicSegments = (segments: CurvePrimitive[]): FootprintSilkSegment[] => segments.map(segment => segment.type === 'line'
				? { type: 'line', a: asObject(segment.a), b: asObject(segment.b) }
				: { type: 'arc', a: asObject(segment.a), b: asObject(segment.b), center: asObject(segment.center), radius: segment.radius, sweepDegrees: segment.sweepDegrees });
			const a = localPoints[0]; const b = localPoints[localPoints.length - 1];
			const localSide: SilkLayer = item.layerId === 3 ? 'top' : 'bottom';
			const side: SilkLayer = data.layerId === 1 ? localSide : localSide === 'top' ? 'bottom' : 'top';
			const origin = footprintData.origins.get(footprintUuid) ?? { source: 'document-embedded' as const };
			strokes.push({ confirmed: false, sourceIdentity: { componentId, footprintUuid, localPrimitiveId: id, ...origin }, local: { a, b, points: localPoints, segments: toPublicSegments(localSegments), closed: path.closed, segmentCount: localSegments.length, width: item.width, layerId: item.layerId }, global: { a: globalPoints[0], b: globalPoints[globalPoints.length - 1], points: globalPoints, segments: toPublicSegments(globalSegments), closed: path.closed, segmentCount: globalSegments.length, width: item.width }, side, bbox });
		}
	}
	for (const id of runtimeById.keys()) {
		checkBudget?.(); if (!sourceComponents.some(r => r.header.id === id))
			unsupported.push({ type: 'component-footprint-silk', componentId: id, reason: componentMappingReason('SDK 器件 ID 未出现在 effective PCB COMPONENT 记录中') });
	}
	if (boardErrors) {
		for (const issue of board.errors) unsupported.push({ type: 'pcb-source', reason: `${issue.id ? `PCB 记录 ${issue.id}：` : ''}${issue.reason}` });
	}
	const potentialConflicts: FootprintSilkResult['potentialConflicts'] = [];
	for (const stroke of strokes) {
		checkBudget?.();
		for (const object of args.checkedObjects) {
			checkBudget?.();
			if (object.componentId === stroke.sourceIdentity.componentId)
				continue;
			if (object.layer !== stroke.side && object.layer !== 'multi')
				continue;
			if (!['text', 'designator', 'standalone-pad', 'component-pad'].includes(object.type))
				continue;
			const distance = gap(stroke.bbox, object.box);
			if (distance <= args.minClearance)
				potentialConflicts.push({ a: { sourceIdentity: stroke.sourceIdentity, side: stroke.side, bbox: stroke.bbox }, b: { id: object.id, type: object.type, componentId: object.componentId, side: object.layer, bbox: object.box }, category: object.type.includes('pad') ? 'silk-to-pad-copper' : 'silk-to-silk', confirmed: false, evidence: 'BOX_NEIGHBOR', bboxDistanceMil: distance });
		}
	}
	for (let i = 0; i < strokes.length; i++) {
		checkBudget?.(); for (let j = i + 1; j < strokes.length; j++) {
			checkBudget?.();
			const a = strokes[i]; const b = strokes[j];
			if (a.sourceIdentity.componentId === b.sourceIdentity.componentId || a.side !== b.side)
				continue;
			const distance = gap(a.bbox, b.bbox);
			if (distance <= args.minClearance)
				potentialConflicts.push({ a: { sourceIdentity: a.sourceIdentity, side: a.side, bbox: a.bbox }, b: { sourceIdentity: b.sourceIdentity, side: b.side, bbox: b.bbox }, category: 'silk-to-silk', confirmed: false, evidence: 'BOX_NEIGHBOR', bboxDistanceMil: distance });
		}
	}
	const sources = [...footprintData.origins.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([footprintUuid, origin]) => ({ footprintUuid, ...origin }));
	return { strokes, potentialConflicts, unsupported, coverage: { scope: 'document-embedded-or-project-library-footprint-source', supportedSubset: 'POLY on local layer 3/4, finite positive width, complete L coordinate-pair and ARC signed-sweep paths; exact line/arc bounds with closed paths; other curves and unknown commands unsupported', effectiveFootprintCount: footprintData.origins.size, mappedComponentCount: mappedIds.size, checkedStrokeCount: strokes.length, excludedOutOfScopePolyCount, unsupportedCount: unsupported.length, complete: false, sourcesAvailable: footprintData.available, sourceStable: false, sources }, sourceSummary: footprintData.summary };
}

/** Extract bounded signed-expansion RECT/ELLIPSE/OVAL candidates from source values or same-snapshot runtime effective values. */
export function extractFootprintPadMaskCandidates(args: {
	pcbRecords: SourceRecord[];
	components: any[];
	footprintSources: unknown;
	projectLibrarySources: ProjectLibrarySource[];
	padSnapshots: Array<{ id: string; componentId: string; padNumber: string | number; layer: string | number; rotation: number; shape: string; shapeState?: unknown; maskExpansionState?: unknown; holeState?: unknown; specialPadState?: unknown; runtimePhysicalPadView?: unknown; net?: unknown; holeOffsetX?: unknown; holeOffsetY?: unknown; holeRotation?: unknown; metallization?: unknown; box: BBox; readError?: string }>;
	sourceStable: boolean;
	nativeDsnText?: string;
	checkBudget?: () => void;
}): FootprintPadMaskCandidateReport {
	const skipped: FootprintPadMaskCandidateReport['skipped'] = [];
	const candidates: FootprintPadMaskCandidate[] = [];
	const closed: FootprintPadMaskCandidateReport['closed'] = [];
	const modelAssumptions: string[] = [];
	const overrideNeeded: FootprintPadMaskCandidateReport['overrideNeeded'] = [];
	const unavailable = (reason: string): FootprintPadMaskCandidateReport => ({ scope: 'stable-footprint-pad-and-runtime-mask-candidates', available: false, unavailableReason: reason, complete: false, sourceStable: args.sourceStable, modelAssumptions, candidates, closed, overrideNeeded, skipped });
	const resolveExpansion = (sourceValue: unknown, sourceField: 'topSolderExpansion' | 'bottomSolderExpansion', physicalSide: 'top' | 'bottom', snapshot: { id?: unknown; maskExpansionState?: unknown }, identity: { sourceIdentity: FootprintPadMaskCandidate['sourceIdentity']; componentId: string; padNumber: string }): { value: number; resolution: PadMaskExpansionResolution } | undefined => {
		const runtimeField = physicalSide === 'top' ? 'topSolderMask' as const : 'bottomSolderMask' as const;
		const state = obj(snapshot.maskExpansionState) ? snapshot.maskExpansionState : undefined;
		const runtimeValues = state?.status === 'value' && obj(state.value) ? state.value : undefined;
		const runtimeValue = runtimeValues?.[runtimeField];
		if (finite(sourceValue)) {
			if (finite(runtimeValue) && runtimeValue !== sourceValue) {
				if (typeof snapshot.id === 'string' && snapshot.id) overrideNeeded.push({ ...identity, runtimePadId: snapshot.id, physicalSide, sourceField, sourceValue, runtimeField, runtimeValue, state: 'override-needed' });
				else skipped.push({ componentId: identity.componentId, padNumber: identity.padNumber, reason: '源扩张与运行时有效mask值矛盾，但PAD ID不可用' });
				return undefined;
			}
			return { value: sourceValue, resolution: { resolution: 'source-explicit', sourceValue, ...(typeof snapshot.id === 'string' && snapshot.id ? { runtimePadId: snapshot.id } : {}), physicalSide, runtimeField, ...(finite(runtimeValue) ? { runtimeValue } : {}) } };
		}
		if (sourceValue !== null) { skipped.push({ componentId: identity.componentId, padNumber: identity.padNumber, reason: `源${sourceField}不是有限数或严格null` }); return undefined; }
		if (!state || state.status !== 'value' || !finite(runtimeValue) || typeof snapshot.id !== 'string' || !snapshot.id) {
			skipped.push({ componentId: identity.componentId, padNumber: identity.padNumber, reason: `源${sourceField}为null，无法从同一PAD快照读取有限${runtimeField}（状态 ${typeof state?.status === 'string' ? state.status : 'unavailable'}）` }); return undefined;
		}
		return { value: runtimeValue, resolution: { resolution: 'runtime-effective', sourceValue, runtimePadId: snapshot.id, physicalSide, runtimeField, runtimeValue } };
	};
	if (!args.sourceStable)
		return unavailable('封装源码或前后运行时PAD快照不稳定，无法关联候选');
	if (!Array.isArray(args.pcbRecords) || !Array.isArray(args.components) || !Array.isArray(args.padSnapshots))
		return unavailable('PCB源码、器件或运行时PAD快照不是完整数组');
	const checkBudget = args.checkBudget;
	const footprintData = summary(args.footprintSources, checkBudget, args.projectLibrarySources ?? []);
	const board = parseBoard(args.pcbRecords, checkBudget);
	if (!footprintData.available || board.errors.length)
		return unavailable(!footprintData.available ? '封装源码不可用' : `PCB源码记录不完整：${board.errors[0]?.reason ?? '未知错误'}`);
	const runtimeComponents = new Map<string, any[]>();
	for (const component of args.components) {
		checkBudget?.();
		try {
			const id = component?.getState_PrimitiveId?.();
			if (typeof id === 'string' && id)
				runtimeComponents.set(id, [...(runtimeComponents.get(id) ?? []), component]);
		}
		catch { /* handled as missing runtime parent below */ }
	}
	const componentRecords = new Map<string, SourceRecord[]>();
	const footprintAttrs = new Map<string, SourceRecord[]>();
	const padNets = new Map<string, SourceRecord[]>();
	for (const record of board.records.values()) {
		checkBudget?.();
		if (record.header.type === 'COMPONENT' && obj(record.data) && typeof record.header.id === 'string')
			componentRecords.set(record.header.id, [...(componentRecords.get(record.header.id) ?? []), record]);
		else if (record.header.type === 'ATTR' && obj(record.data) && record.data.key === 'Footprint' && typeof record.data.parentId === 'string')
			footprintAttrs.set(record.data.parentId, [...(footprintAttrs.get(record.data.parentId) ?? []), record]);
		else if (record.header.type === 'PAD_NET') {
			let identity: unknown;
			try { identity = JSON.parse(record.header.id); } catch { continue; }
			if (Array.isArray(identity) && identity.length === 4 && identity[0] === 'PAD_NET' && identity.slice(1).every(item => typeof item === 'string')) {
				const tuple = JSON.stringify(identity.slice(1));
				padNets.set(tuple, [...(padNets.get(tuple) ?? []), record]);
			}
		}
	}
	const snapshotsByTuple = new Map<string, typeof args.padSnapshots>();
	const snapshotsByRuntimeId = new Map<string, typeof args.padSnapshots>();
	for (const snapshot of args.padSnapshots) {
		checkBudget?.();
		const tuple = JSON.stringify([snapshot.componentId, String(snapshot.padNumber)]);
		snapshotsByTuple.set(tuple, [...(snapshotsByTuple.get(tuple) ?? []), snapshot]);
		if (typeof snapshot.id === 'string' && snapshot.id)
			snapshotsByRuntimeId.set(snapshot.id, [...(snapshotsByRuntimeId.get(snapshot.id) ?? []), snapshot]);
	}
	for (const [componentId, componentList] of componentRecords) {
		checkBudget?.();
		const attrs = footprintAttrs.get(componentId) ?? [];
		if (componentList.length !== 1 || attrs.length !== 1 || typeof attrs[0].data.value !== 'string' || !attrs[0].data.value) {
			if ((args.padSnapshots ?? []).some(snapshot => snapshot.componentId === componentId))
				skipped.push({ componentId, reason: 'effective COMPONENT 未关联唯一有效 Footprint ATTR' });
			continue;
		}
		const componentData = componentList[0].data;
		const side = componentData.layerId === 1 ? 'top' : componentData.layerId === 2 ? 'bottom' : undefined;
		const runtimeList = runtimeComponents.get(componentId) ?? [];
		if (!side || runtimeList.length !== 1 || !finite(componentData.x) || !finite(componentData.y)) {
			skipped.push({ componentId, reason: !side ? '器件层未映射到顶/底面' : runtimeList.length !== 1 ? '运行时父组件缺失或ID重复' : 'effective COMPONENT坐标不可用于浮点误差上界' });
			continue;
		}
		const footprintUuid = attrs[0].data.value;
		const source = footprintData.effective.get(footprintUuid);
		const origin = footprintData.origins.get(footprintUuid);
		if (!source || !origin || footprintData.conflicts.has(footprintUuid) || source.errors.length || footprintData.errors.some(error => error.footprintUuid === footprintUuid)) {
			skipped.push({ componentId, reason: '封装来源缺失、冲突或解析含错误' });
			continue;
		}
		const sourcePads = [...source.records.values()].filter(record => record.header.type === 'PAD');
		const sourcePadNumbers = new Map<string, SourceRecord[]>();
		for (const record of sourcePads) {
			checkBudget?.();
			if (obj(record.data) && typeof record.data.num === 'string')
				sourcePadNumbers.set(record.data.num, [...(sourcePadNumbers.get(record.data.num) ?? []), record]);
		}
		for (const snapshot of args.padSnapshots.filter(item => item.componentId === componentId)) {
			checkBudget?.();
			const number = String(snapshot.padNumber);
			const sourceMatches = sourcePadNumbers.get(number) ?? [];
			const reason = (text: string) => skipped.push({ componentId, padNumber: number, reason: text });
			if (snapshot.readError) { reason(`运行时PAD读回失败：${snapshot.readError}`); continue; }
			if (typeof snapshot.id === 'string' && snapshot.id && board.records.has(key('PAD', snapshot.id))) { reason('effective PCB PAD记录覆盖了该运行时PAD'); continue; }
			if (sourceMatches.length !== 1 || typeof sourceMatches[0].header.id !== 'string' || !sourceMatches[0].header.id) { reason('封装PAD编号无匹配或重复'); continue; }
			const localPrimitiveId = sourceMatches[0].header.id;
			const netRecords = padNets.get(JSON.stringify([componentId, number, localPrimitiveId])) ?? [];
			if (netRecords.length !== 1 || !obj(netRecords[0].data)) { reason('未找到唯一的effective PAD_NET身份元组'); continue; }
			const padNet = netRecords[0].data;
			if (!obj(padNet.attrsMap) || Object.keys(padNet.attrsMap).length !== 0) { reason('PAD_NET attrsMap未知或含有效覆盖'); continue; }
			if (padNet.padLen !== null && padNet.padLen !== undefined && padNet.padLen !== 0) { reason('effective PAD_NET.padLen存在几何修正'); continue; }
			const pad = sourceMatches[0].data;
			if (!obj(pad) || (pad.attrsMap !== undefined && (!obj(pad.attrsMap) || Object.keys(pad.attrsMap).length !== 0))) { reason('封装PAD attrsMap未知或含有效覆盖'); continue; }
			if (pad.layerId !== 1 && pad.layerId !== 2 && pad.layerId !== 12) { reason(`封装PAD local layer ${String(pad.layerId)} 未验证；仅支持严格layerId===1、2或12`); continue; }
			if (pad.layerId === 12) {
				if (pad.padType !== 'NORMAL' || !obj(pad.defaultPad) || !obj(pad.hole) || pad.hole.holeType !== 'ROUND' || !finite(pad.hole.width) || !(pad.hole.width > 0) || !finite(pad.hole.height) || pad.hole.height !== pad.hole.width
					|| !Array.isArray(pad.specialPad) || (pad.padLen !== null && pad.padLen !== 0)) { reason('Multi-Layer local layer 12 PAD必须为NORMAL、ROUND正等径孔、specialPad数组且padLen为零'); continue; }
				const defaultShape = normalizePadShapeSource(pad.defaultPad);
				if (!defaultShape) { reason('Multi-Layer PAD defaultPad形状、尺寸、圆角或attrsMap未知'); continue; }
				const sourceSpecialLayerCounts = new Map<unknown, number>();
				for (const entry of pad.specialPad) if (obj(entry)) sourceSpecialLayerCounts.set(entry.startLayer, (sourceSpecialLayerCounts.get(entry.startLayer) ?? 0) + 1);
				const complexSpecial = pad.specialPad.some((entry: unknown) => obj(entry) && entry.startLayer !== entry.endLayer) || [...sourceSpecialLayerCounts.values()].some(count => count > 1);
				const duplicateRuntimeKeys = runtimeSpecialStateHasDuplicateKeys(snapshot.specialPadState);
				const physicalPadParseDiagnostic: Record<string, unknown> = {};
				const runtimePhysicalView = complexSpecial && duplicateRuntimeKeys ? resolveRuntimePhysicalPadView(defaultShape, pad.specialPad, snapshot.runtimePhysicalPadView, snapshot, physicalPadParseDiagnostic) : undefined;
				const normalizedSpecialView = complexSpecial && !duplicateRuntimeKeys ? resolveRuntimeSpecialView(defaultShape, pad.specialPad, snapshot.specialPadState) : undefined;
				let dsnPhysicalView: DsnPadPhysicalSelection | undefined;
				let dsnRuntimeSpecialShapes: RuntimeSpecialShapeSet | undefined;
				const confirmedEmptyNetQuery = snapshot.net === '' && isConfirmedEmptyNetPrimitiveQuery(snapshot.runtimePhysicalPadView);
				if (complexSpecial && duplicateRuntimeKeys && !runtimePhysicalView && confirmedEmptyNetQuery && typeof args.nativeDsnText === 'string') {
					const sourceShapeCandidates: PadShapeSourceData[] = [defaultShape];
					let sourceShapeSetValid = true;
					for (const entry of pad.specialPad) {
						if (!obj(entry) || !obj(entry.pad)) { sourceShapeSetValid = false; break; }
						const shape = normalizePadShapeSource(entry.pad); if (!shape) { sourceShapeSetValid = false; break; }
						sourceShapeCandidates.push(shape);
					}
					if (sourceShapeSetValid && typeof snapshot.id === 'string' && snapshot.id && finite(snapshot.rotation) && snapshot.box && [snapshot.box.minX, snapshot.box.minY, snapshot.box.maxX, snapshot.box.maxY].every(Number.isFinite)) {
						const dsnCandidates = sourceShapeCandidates.map(shape => ({ componentId, localPadId: localPrimitiveId, centerMil: [(snapshot.box.minX + snapshot.box.maxX) / 2, (snapshot.box.minY + snapshot.box.maxY) / 2] as [number, number], rotationDegrees: snapshot.rotation, shape: { padType: shape.padType, widthMil: shape.width, heightMil: shape.height, radiusMil: shape.radius ?? 0 } satisfies DsnPadPhysicalShape }));
						const identityUniverse = [...padNets.keys()].flatMap(tuple => { try { const parts = JSON.parse(tuple); return Array.isArray(parts) && parts.length === 3 && parts.every(item => typeof item === 'string') ? [{ componentId: parts[0], localPadId: parts[2] }] : []; } catch { return []; } });
						const dsnSelection = selectDsnPadPhysicalViews({ dsnText: args.nativeDsnText, candidates: dsnCandidates, identityUniverse });
						const selectedDsnView = dsnSelection.selections.find(item => item.sourceIdentity.componentId === componentId && item.sourceIdentity.localPadId === localPrimitiveId);
						dsnPhysicalView = selectedDsnView ? { ...selectedDsnView, rawQueryFailure: snapshot.runtimePhysicalPadView as Record<string, unknown> } : undefined;
						if (dsnPhysicalView?.top.state === 'selected' && dsnPhysicalView.bottom.state === 'selected') dsnRuntimeSpecialShapes = resolveRuntimeSpecialShapes(defaultShape, pad.specialPad, snapshot.specialPadState);
					}
					if (!dsnRuntimeSpecialShapes || !dsnPhysicalView || dsnPhysicalView.top.state !== 'selected' || dsnPhysicalView.bottom.state !== 'selected') {
						const diagnostic = { supplementalRead: snapshot.runtimePhysicalPadView, dsnPhysicalView: dsnPhysicalView ?? { state: 'unknown', reason: !sourceShapeSetValid ? 'source contains unsupported special shape' : 'DSN selection returned no result for this source PAD' }, parseFailure: physicalPadParseDiagnostic };
						skipped.push({ componentId, padNumber: number, reason: '空网raw查询返回空结果；DSN外层source候选选择或runtime special tuple重建仍未知', physicalPadViewDiagnostic: diagnostic });
						continue;
					}
				}
				if (complexSpecial && !(runtimePhysicalView || normalizedSpecialView || dsnPhysicalView)) {
					if (duplicateRuntimeKeys) skipped.push({ componentId, padNumber: number, reason: '重复SDK special层键未能从同一PAD快照恢复唯一raw物理视图，且不符合经确认的空网空结果DSN选择触发条件', physicalPadViewDiagnostic: { supplementalRead: obj(snapshot.runtimePhysicalPadView) ? snapshot.runtimePhysicalPadView : { status: 'unavailable' }, parseFailure: physicalPadParseDiagnostic } });
					else reason('复杂specialPad未能从同快照恢复唯一完整的物理1/SDK归一项12/物理2有效形状视图');
					continue;
				}
				const specialBySurface = new Map<number, PadShapeSourceData>();
				let invalidSpecial = false;
				if (normalizedSpecialView) {
					for (const entry of normalizedSpecialView.entries) if (entry.startLayer === 1 || entry.startLayer === 2) specialBySurface.set(entry.startLayer, entry.shape);
				}
				else if (runtimePhysicalView) {
					for (const entry of runtimePhysicalView.shapes) if (entry.key === 'top') specialBySurface.set(1, entry.shape); else if (entry.key === 'bottom') specialBySurface.set(2, entry.shape);
				}
				else if (dsnPhysicalView) {
					if (dsnPhysicalView.top.state === 'selected') specialBySurface.set(1, { padType: dsnPhysicalView.top.shape.padType, width: dsnPhysicalView.top.shape.widthMil, height: dsnPhysicalView.top.shape.heightMil, radius: dsnPhysicalView.top.shape.radiusMil ?? 0 });
					if (dsnPhysicalView.bottom.state === 'selected') specialBySurface.set(2, { padType: dsnPhysicalView.bottom.shape.padType, width: dsnPhysicalView.bottom.shape.widthMil, height: dsnPhysicalView.bottom.shape.heightMil, radius: dsnPhysicalView.bottom.shape.radiusMil ?? 0 });
				}
				else {
					for (const entry of pad.specialPad) {
						checkBudget?.();
						if (!obj(entry) || ![1, 2].includes(entry.startLayer) || entry.endLayer !== entry.startLayer || specialBySurface.has(entry.startLayer)) { invalidSpecial = true; break; }
						const specialShape = normalizePadShapeSource(entry.pad);
						if (!specialShape) { invalidSpecial = true; break; }
						specialBySurface.set(entry.startLayer, specialShape);
					}
				}
				if (invalidSpecial) { reason('Multi-Layer PAD specialPad存在覆盖范围、重复层、shape或attrsMap未知项'); continue; }
				const outerEffectiveShapes = dsnPhysicalView ? [specialBySurface.get(1), specialBySurface.get(2)].filter((shape): shape is PadShapeSourceData => !!shape) : [specialBySurface.get(1) ?? defaultShape, specialBySurface.get(2) ?? defaultShape];
				if (typeof snapshot.id !== 'string' || !snapshot.id || !Array.isArray(snapshot.shapeState) || snapshot.shape !== snapshot.shapeState[0]
					|| !finite(snapshot.rotation) || snapshot.layer !== 12 || !snapshot.box || ![snapshot.box.minX, snapshot.box.minY, snapshot.box.maxX, snapshot.box.maxY].every(Number.isFinite)) { reason('Multi-Layer运行时PAD ID、full shapeState、rotation、layer12或bbox不可用'); continue; }
				const matches = snapshotsByTuple.get(JSON.stringify([componentId, number])) ?? [];
				if (matches.length !== 1 || matches[0] !== snapshot) { reason('运行时PAD编号关联不唯一'); continue; }
				if ((snapshotsByRuntimeId.get(snapshot.id) ?? []).length !== 1) { reason('运行时PAD ID不唯一'); continue; }
				if (!padShapeGetterMatches(snapshot.shapeState, outerEffectiveShapes)) { reason('运行时getState_Pad完整值不匹配任何有效外层surface形状'); continue; }
				const centerMil: [number, number] = [(snapshot.box.minX + snapshot.box.maxX) / 2, (snapshot.box.minY + snapshot.box.maxY) / 2];
				const theta = snapshot.rotation * Math.PI / 180;
				const unionShapes = runtimePhysicalView ? runtimePhysicalView.shapes.map(entry => entry.shape) : normalizedSpecialView ? normalizedSpecialView.entries.map(entry => entry.shape) : dsnRuntimeSpecialShapes ? dsnRuntimeSpecialShapes.entries.map(entry => entry.shape) : [defaultShape, ...specialBySurface.values()];
				const unionBounds = unionShapes.map(shape => projectedPadShapeBounds(shape, centerMil, theta));
				if (!unionBounds.every((bounds): bounds is BBox => !!bounds)) { reason('Multi-Layer default/special union派生几何非有限'); continue; }
				const union = { minX: Math.min(...unionBounds.map(box => box.minX)), minY: Math.min(...unionBounds.map(box => box.minY)), maxX: Math.max(...unionBounds.map(box => box.maxX)), maxY: Math.max(...unionBounds.map(box => box.maxY)) };
				const expectedWidth = union.maxX - union.minX; const expectedHeight = union.maxY - union.minY;
				const actualWidth = snapshot.box.maxX - snapshot.box.minX; const actualHeight = snapshot.box.maxY - snapshot.box.minY;
				const roundingScale = Math.max(1, ...Object.values(snapshot.box).map(Math.abs), Math.abs(componentData.x), Math.abs(componentData.y), ...[expectedWidth, expectedHeight, actualWidth, actualHeight].map(Math.abs));
				const floatingPointAllowance = 8 * Number.EPSILON * roundingScale;
				if (![...centerMil, expectedWidth, expectedHeight, actualWidth, actualHeight, floatingPointAllowance].every(Number.isFinite) || Math.abs(expectedWidth - actualWidth) > floatingPointAllowance || Math.abs(expectedHeight - actualHeight) > floatingPointAllowance) { reason(runtimePhysicalView ? 'raw top/bottom/all-inner runtime physical union bbox不匹配运行时铜bbox' : normalizedSpecialView ? '物理1/SDK归一项12/物理2归一有效视图union bbox不匹配运行时铜bbox' : dsnRuntimeSpecialShapes ? 'DSN选中外层与SDK全部special tuple source geometry union bbox不匹配运行时铜bbox' : 'default与全部special声明形状的union投影bbox不匹配运行时铜bbox'); continue; }
				if (runtimePhysicalView && !modelAssumptions.includes('重复SDK special层键时使用同快照具名raw物理top/bottom/all-inner形状union bbox；inner键不解释为物理铜层，source仅用于完整精度几何匹配。')) modelAssumptions.push('重复SDK special层键时使用同快照具名raw物理top/bottom/all-inner形状union bbox；inner键不解释为物理铜层，source仅用于完整精度几何匹配。');
				if (normalizedSpecialView && !modelAssumptions.includes('复杂Multi-Layer specialPad使用同一快照归一物理1/SDK归一项12/物理2形状及三者union bbox；源声明仅用于完整精度形状匹配，不推断范围优先级。')) modelAssumptions.push('复杂Multi-Layer specialPad使用同一快照归一物理1/SDK归一项12/物理2形状及三者union bbox；源声明仅用于完整精度形状匹配，不推断范围优先级。');
				if (dsnRuntimeSpecialShapes && !modelAssumptions.includes('DSN空网外层选择来源于export，不等于精确铜几何；runtime bbox union仅使用SDK返回的全部special tuple匹配source shapes（忽略tuple面键），不加入未返回的default、不使用DSN inner或全部source声明；polygon aperture 0.1仅为导出序列化标记，Gerber制造关联保持独立。')) modelAssumptions.push('DSN空网外层选择来源于export，不等于精确铜几何；runtime bbox union仅使用SDK返回的全部special tuple匹配source shapes（忽略tuple面键），不加入未返回的default、不使用DSN inner或全部source声明；polygon aperture 0.1仅为导出序列化标记，Gerber制造关联保持独立。');
				const sourceIdentity = { componentId, footprintUuid, localPrimitiveId, ...origin };
				const sourceDrillMetadata = { sourceHole: pad.hole, padOffsetX: pad.padOffsetX, padOffsetY: pad.padOffsetY, relativeAngle: pad.relativeAngle, plated: pad.plated };
				const runtimePad = { id: snapshot.id, shape: snapshot.shape, rotation: snapshot.rotation, boxMil: { ...snapshot.box }, centerMil, layer: 12 as const, runtimeBBoxModel: dsnRuntimeSpecialShapes ? 'dsn-outer-and-runtime-special-union' as const : runtimePhysicalView ? 'runtime-physical-top-bottom-all-inner-union' as const : normalizedSpecialView ? 'normalized-physical-1-12-2-union' as const : 'default-and-special-union' as const };
				for (const localSurface of [1, 2] as const) {
					const selectedExpansionField = localSurface === 1 ? 'topSolderExpansion' as const : 'bottomSolderExpansion' as const;
					const componentCopperLayer = localSurface === 1 ? componentData.layerId : 3 - componentData.layerId;
					if (componentCopperLayer !== 1 && componentCopperLayer !== 2) { reason('component层无法将localSurface映射到顶/底铜面'); continue; }
					const layer = componentCopperLayer === 1 ? 'top' as const : 'bottom' as const;
					// SDK-normalized tuple keys are physical layer IDs; source singleton overrides stay keyed by local surface IDs.
					const shapeLayerKey = normalizedSpecialView || runtimePhysicalView || dsnPhysicalView ? componentCopperLayer : localSurface;
					const selectedShape = specialBySurface.get(shapeLayerKey) ?? defaultShape;
					const sourceExpansionValue = localSurface === 1 ? pad.topSolderExpansion : pad.bottomSolderExpansion;
					const resolved = resolveExpansion(sourceExpansionValue, selectedExpansionField, layer, snapshot, { sourceIdentity, componentId, padNumber: number });
					if (!resolved) continue;
					const expansionValue = resolved.value;
					const commonModel = { localCopperLayerId: 12 as const, localSurface, sourceTopSolderExpansion: pad.topSolderExpansion, sourceBottomSolderExpansion: pad.bottomSolderExpansion, expansionMapping: localSurface === 1 ? 'local-surface-1-follows-component-side' as const : 'local-surface-2-opposite-component-side' as const, selectedExpansionField, solderExpansionMil: expansionValue, sourceDrillMetadata, runtimeBBoxModel: dsnRuntimeSpecialShapes ? 'dsn-outer-and-runtime-special-union' as const : runtimePhysicalView ? 'runtime-physical-top-bottom-all-inner-union' as const : normalizedSpecialView ? 'normalized-physical-1-12-2-union' as const : 'default-and-special-union' as const, ...(normalizedSpecialView ? { normalizedSpecialView } : {}), ...(runtimePhysicalView ? { runtimePhysicalView } : {}), ...(dsnPhysicalView ? { dsnPhysicalView } : {}) };
					const commonModelWithResolution = { ...commonModel, expansionResolution: resolved.resolution };
					const modeledShape = selectedShape.padType === 'ELLIPSE' ? 'ELLIPSE' : selectedShape.padType === 'OVAL' ? 'OVAL' : 'RECT';
					const derivedWidth = selectedShape.width + 2 * expansionValue; const derivedHeight = selectedShape.height + 2 * expansionValue;
					if (![derivedWidth, derivedHeight].every(Number.isFinite)) { reason(`localSurface ${localSurface}RECT扩张派生尺寸溢出或非有限`); continue; }
					const collapsed = modeledShape === 'RECT' ? derivedWidth <= 0 || derivedHeight <= 0 : modeledShape === 'ELLIPSE' ? derivedWidth <= 0 : Math.min(selectedShape.width, selectedShape.height) / 2 + expansionValue <= 0;
					if (collapsed) { closed.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePadId: runtimePad.id, shape: modeledShape, selectedExpansionField, solderExpansionMil: expansionValue, expansionResolution: resolved.resolution, ...(normalizedSpecialView ? { normalizedSpecialView } : {}), ...(runtimePhysicalView ? { runtimePhysicalView } : {}), centerMil, rotationDegrees: snapshot.rotation, widthMil: selectedShape.width, heightMil: selectedShape.height, state: 'model-predicted-closed' }); continue; }
					if (selectedShape.padType === 'ELLIPSE') {
						const diameterMil = selectedShape.width; const openingDiameterMil = diameterMil + 2 * expansionValue;
						const outerBoundsMil = { minX: centerMil[0] - openingDiameterMil / 2, minY: centerMil[1] - openingDiameterMil / 2, maxX: centerMil[0] + openingDiameterMil / 2, maxY: centerMil[1] + openingDiameterMil / 2 };
						if (!(openingDiameterMil > 0) || ![openingDiameterMil, ...Object.values(outerBoundsMil)].every(Number.isFinite)) { reason(`localSurface ${localSurface}圆形开窗派生值溢出`); continue; }
						candidates.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePad, sourcePad: { shape: 'ELLIPSE', ...commonModelWithResolution, diameterMil, ...(selectedShape.height !== selectedShape.width ? { sourceHeightMil: selectedShape.height, shapeInterpretation: 'circle-width-based-runtime' as const } : {}) }, copperGeometry: { centerMil, diameterMil }, maskGeometry: { centerMil, openingDiameterMil, outerBoundsMil } });
						continue;
					}
					if (selectedShape.padType === 'OVAL') {
						const widthMil = selectedShape.width; const heightMil = selectedShape.height; const axisHalfLengthMil = Math.abs(widthMil - heightMil) / 2; const coreRadiusMil = Math.min(widthMil, heightMil) / 2;
						const thetaAxis = theta + (widthMil >= heightMil ? 0 : Math.PI / 2); const axisDx = axisHalfLengthMil * Math.cos(thetaAxis); const axisDy = axisHalfLengthMil * Math.sin(thetaAxis); const openingDiameterMil = 2 * (coreRadiusMil + expansionValue); const outerRadius = coreRadiusMil + expansionValue;
						const axisEndpointsMil: [[number, number], [number, number]] = [[centerMil[0] - axisDx, centerMil[1] - axisDy], [centerMil[0] + axisDx, centerMil[1] + axisDy]];
						const outerBoundsMil = { minX: centerMil[0] - Math.abs(axisDx) - outerRadius, minY: centerMil[1] - Math.abs(axisDy) - outerRadius, maxX: centerMil[0] + Math.abs(axisDx) + outerRadius, maxY: centerMil[1] + Math.abs(axisDy) + outerRadius };
						if (![axisHalfLengthMil, coreRadiusMil, openingDiameterMil, outerRadius, ...axisEndpointsMil.flat(), ...Object.values(outerBoundsMil)].every(Number.isFinite)) { reason(`localSurface ${localSurface}OVAL开窗派生值溢出`); continue; }
						candidates.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePad, sourcePad: { shape: 'OVAL', ...commonModelWithResolution, widthMil, heightMil, shapeInterpretation: 'capsule' }, copperGeometry: { centerMil, rotationDegrees: snapshot.rotation, widthMil, heightMil, cornerPointsMil: [] }, maskGeometry: { centerMil, rotationDegrees: snapshot.rotation, axisHalfLengthMil, coreRadiusMil, expansionRadiusMil: expansionValue, openingDiameterMil, axisEndpointsMil, outerBoundsMil } });
						continue;
					}
					const widthMil = selectedShape.width; const heightMil = selectedShape.height;
					const rectCorners = (w: number, h: number): Array<[number, number]> => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [centerMil[0] + x * Math.cos(theta) - y * Math.sin(theta), centerMil[1] + x * Math.sin(theta) + y * Math.cos(theta)]);
					const corners = rectCorners(widthMil, heightMil);
					const pureRect = expansionValue <= 0;
					const maskWidth = pureRect ? widthMil + 2 * expansionValue : widthMil;
					const maskHeight = pureRect ? heightMil + 2 * expansionValue : heightMil;
					const maskCorners = pureRect ? rectCorners(maskWidth, maskHeight) : corners;
					const coreBounds = { minX: Math.min(...maskCorners.map(p => p[0])), minY: Math.min(...maskCorners.map(p => p[1])), maxX: Math.max(...maskCorners.map(p => p[0])), maxY: Math.max(...maskCorners.map(p => p[1])) };
					const outerBoundsMil = pureRect ? coreBounds : { minX: coreBounds.minX - expansionValue, minY: coreBounds.minY - expansionValue, maxX: coreBounds.maxX + expansionValue, maxY: coreBounds.maxY + expansionValue };
					if (![...maskCorners.flat(), ...Object.values(outerBoundsMil)].every(Number.isFinite)) { reason(`localSurface ${localSurface}RECT开窗派生值溢出`); continue; }
					candidates.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePad, sourcePad: { shape: 'RECT', ...commonModelWithResolution, widthMil, heightMil, radiusMil: 0 }, copperGeometry: { centerMil, rotationDegrees: snapshot.rotation, widthMil, heightMil, cornerPointsMil: corners }, maskGeometry: { centerMil, rotationDegrees: snapshot.rotation, coreWidthMil: maskWidth, coreHeightMil: maskHeight, coreCornerPointsMil: maskCorners, expansionRadiusMil: pureRect ? 0 : expansionValue, ...(pureRect ? { pureRect: true as const } : {}), outerBoundsMil } });
				}
				continue;
			}
			if (pad.hole !== null || pad.padType !== 'NORMAL' || !obj(pad.defaultPad) || !['RECT', 'ELLIPSE', 'OVAL'].includes(pad.defaultPad.padType)
				|| !finite(pad.defaultPad.width) || !(pad.defaultPad.width > 0) || !finite(pad.defaultPad.height) || !(pad.defaultPad.height > 0)
				|| (pad.defaultPad.padType === 'RECT' && pad.defaultPad.radius !== 0) || !Array.isArray(pad.specialPad) || pad.specialPad.length !== 0
				|| (pad.padLen !== null && pad.padLen !== 0)) { reason('封装PAD不属于无孔、NORMAL、受支持外形且无特殊覆盖或几何修正的普通PAD'); continue; }
			const isCircleEllipse = pad.defaultPad.padType === 'ELLIPSE';
			const isOval = pad.defaultPad.padType === 'OVAL';
			const sourceTopSolderExpansion = pad.topSolderExpansion;
			const sourceBottomSolderExpansion = pad.bottomSolderExpansion;
			const selectedExpansionField = pad.layerId === 1 ? 'topSolderExpansion' as const : 'bottomSolderExpansion' as const;
			if (typeof snapshot.id !== 'string' || !snapshot.id || snapshot.shape !== (isCircleEllipse ? 'ELLIPSE' : isOval ? 'OVAL' : 'RECT') || !finite(snapshot.rotation) || !finite(snapshot.layer) || !snapshot.box || ![snapshot.box.minX, snapshot.box.minY, snapshot.box.maxX, snapshot.box.maxY].every(Number.isFinite)) { reason('运行时PAD ID、shape、层、旋转或bbox不可用'); continue; }
			const expectedRuntimeLayer = pad.layerId === 1 ? componentData.layerId : 3 - componentData.layerId;
			if ((componentData.layerId !== 1 && componentData.layerId !== 2) || snapshot.layer !== expectedRuntimeLayer) { reason('运行时PAD铜层与封装局部层及父器件层关系不一致'); continue; }
			const matches = snapshotsByTuple.get(JSON.stringify([componentId, number])) ?? [];
			if (matches.length !== 1 || matches[0] !== snapshot) { reason('运行时PAD编号关联不唯一'); continue; }
			if ((snapshotsByRuntimeId.get(snapshot.id) ?? []).length !== 1) { reason('运行时PAD ID不唯一'); continue; }
			const widthMil = pad.defaultPad.width;
			const heightMil = pad.defaultPad.height;
			const centerMil: [number, number] = [(snapshot.box.minX + snapshot.box.maxX) / 2, (snapshot.box.minY + snapshot.box.maxY) / 2];
			const theta = snapshot.rotation * Math.PI / 180;
			const ovalHorizontal = widthMil >= heightMil;
			const ovalRadius = Math.min(widthMil, heightMil) / 2;
			const ovalHalfAxis = Math.abs(widthMil - heightMil) / 2;
			const ovalTheta = theta + (ovalHorizontal ? 0 : Math.PI / 2);
			const expectedWidth = isCircleEllipse ? widthMil : isOval ? 2 * (ovalRadius + ovalHalfAxis * Math.abs(Math.cos(ovalTheta))) : Math.abs(widthMil * Math.cos(theta)) + Math.abs(heightMil * Math.sin(theta));
			const expectedHeight = isCircleEllipse ? widthMil : isOval ? 2 * (ovalRadius + ovalHalfAxis * Math.abs(Math.sin(ovalTheta))) : Math.abs(widthMil * Math.sin(theta)) + Math.abs(heightMil * Math.cos(theta));
			const actualWidth = snapshot.box.maxX - snapshot.box.minX;
			const actualHeight = snapshot.box.maxY - snapshot.box.minY;
			const roundingScale = Math.max(1, Math.abs(snapshot.box.minX), Math.abs(snapshot.box.minY), Math.abs(snapshot.box.maxX), Math.abs(snapshot.box.maxY), Math.abs(componentData.x), Math.abs(componentData.y), widthMil, heightMil, Math.abs(expectedWidth), Math.abs(expectedHeight), Math.abs(actualWidth), Math.abs(actualHeight));
			const floatingPointAllowance = 8 * Number.EPSILON * roundingScale;
			if (Math.abs(expectedWidth - actualWidth) > floatingPointAllowance || Math.abs(expectedHeight - actualHeight) > floatingPointAllowance) { reason(`源${isCircleEllipse ? 'ELLIPSE' : 'RECT'}投影尺寸与运行时铜bbox尺寸不一致`); continue; }
			const sourceIdentity = { componentId, footprintUuid, localPrimitiveId, ...origin };
			const layer = expectedRuntimeLayer === 1 ? 'top' : 'bottom';
			const runtimePad = { id: snapshot.id, shape: snapshot.shape, rotation: snapshot.rotation, boxMil: { ...snapshot.box }, centerMil };
			const expansionMapping = pad.layerId === 1 ? 'local-layer1-follows-component-side' as const : 'local-layer2-opposite-component-side' as const;
			const sourceExpansionValue = pad.layerId === 1 ? sourceTopSolderExpansion : sourceBottomSolderExpansion;
			const resolved = resolveExpansion(sourceExpansionValue, selectedExpansionField, layer, snapshot, { sourceIdentity, componentId, padNumber: number });
			if (!resolved) continue;
			const expansionValue = resolved.value;
			const derivedWidth = widthMil + 2 * expansionValue; const derivedHeight = heightMil + 2 * expansionValue;
			if (![derivedWidth, derivedHeight].every(Number.isFinite)) { reason(isCircleEllipse ? '圆形ELLIPSE派生中心、开窗直径或外包围盒溢出' : '焊盘扩张派生尺寸溢出或非有限'); continue; }
			const closedShape = isCircleEllipse ? derivedWidth <= 0 : isOval ? Math.min(widthMil, heightMil) / 2 + expansionValue <= 0 : derivedWidth <= 0 || derivedHeight <= 0;
			if (closedShape) { closed.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePadId: runtimePad.id, shape: isCircleEllipse ? 'ELLIPSE' : isOval ? 'OVAL' : 'RECT', selectedExpansionField, solderExpansionMil: expansionValue, expansionResolution: resolved.resolution, centerMil, rotationDegrees: snapshot.rotation, widthMil, heightMil, state: 'model-predicted-closed' }); continue; }
			if (isCircleEllipse) {
				const diameterMil = widthMil;
				const openingDiameterMil = diameterMil + 2 * expansionValue;
				const outerBoundsMil = { minX: centerMil[0] - openingDiameterMil / 2, minY: centerMil[1] - openingDiameterMil / 2, maxX: centerMil[0] + openingDiameterMil / 2, maxY: centerMil[1] + openingDiameterMil / 2 };
				if (!centerMil.every(Number.isFinite) || !(openingDiameterMil > 0) || !Number.isFinite(openingDiameterMil) || ![outerBoundsMil.minX, outerBoundsMil.minY, outerBoundsMil.maxX, outerBoundsMil.maxY].every(Number.isFinite)) { reason('圆形ELLIPSE派生中心、开窗直径或外包围盒不是有限正几何'); continue; }
				candidates.push({
					sourceIdentity, componentId, padNumber: number, layer, runtimePad,
				sourcePad: { shape: 'ELLIPSE', localCopperLayerId: pad.layerId, diameterMil, ...(heightMil !== widthMil ? { sourceHeightMil: heightMil, shapeInterpretation: 'circle-width-based-runtime' as const } : {}), sourceTopSolderExpansion, sourceBottomSolderExpansion, expansionMapping, selectedExpansionField, solderExpansionMil: expansionValue, expansionResolution: resolved.resolution },
					copperGeometry: { centerMil, diameterMil },
					maskGeometry: { centerMil, openingDiameterMil, outerBoundsMil },
				});
				continue;
			}
			if (isOval) {
				const axisHalfLengthMil = ovalHalfAxis;
				const coreRadiusMil = ovalRadius;
				const openingDiameterMil = 2 * (coreRadiusMil + expansionValue);
				const axisRadians = theta + (ovalHorizontal ? 0 : Math.PI / 2);
				const axisDx = axisHalfLengthMil * Math.cos(axisRadians);
				const axisDy = axisHalfLengthMil * Math.sin(axisRadians);
				const axisEndpointsMil: [[number, number], [number, number]] = [[centerMil[0] - axisDx, centerMil[1] - axisDy], [centerMil[0] + axisDx, centerMil[1] + axisDy]];
				const outerRadius = coreRadiusMil + expansionValue;
				const outerBoundsMil = { minX: centerMil[0] - Math.abs(axisDx) - outerRadius, minY: centerMil[1] - Math.abs(axisDy) - outerRadius, maxX: centerMil[0] + Math.abs(axisDx) + outerRadius, maxY: centerMil[1] + Math.abs(axisDy) + outerRadius };
				if (![...centerMil, axisHalfLengthMil, coreRadiusMil, expansionValue, openingDiameterMil, ...axisEndpointsMil.flat(), outerRadius, outerBoundsMil.minX, outerBoundsMil.minY, outerBoundsMil.maxX, outerBoundsMil.maxY].every(Number.isFinite) || !(openingDiameterMil > 0)) { reason('OVAL派生中心、半径、端点或外包围盒不是有限正几何'); continue; }
				candidates.push({ sourceIdentity, componentId, padNumber: number, layer, runtimePad,
					sourcePad: { shape: 'OVAL', localCopperLayerId: pad.layerId, widthMil, heightMil, sourceTopSolderExpansion, sourceBottomSolderExpansion, expansionMapping, selectedExpansionField, solderExpansionMil: expansionValue, expansionResolution: resolved.resolution, shapeInterpretation: 'capsule' },
					copperGeometry: { centerMil, rotationDegrees: snapshot.rotation, widthMil, heightMil, cornerPointsMil: [] },
					maskGeometry: { centerMil, rotationDegrees: snapshot.rotation, axisHalfLengthMil, coreRadiusMil, expansionRadiusMil: expansionValue, openingDiameterMil, axisEndpointsMil, outerBoundsMil },
				});
				continue;
			}
			const rotateCorners = (w: number, h: number): Array<[number, number]> => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [centerMil[0] + x * Math.cos(theta) - y * Math.sin(theta), centerMil[1] + x * Math.sin(theta) + y * Math.cos(theta)]);
			const coreCorners = rotateCorners(widthMil, heightMil);
			const maskWidth = widthMil + 2 * expansionValue;
			const maskHeight = heightMil + 2 * expansionValue;
			const pureRect = expansionValue <= 0;
			const maskCorners = pureRect ? rotateCorners(maskWidth, maskHeight) : coreCorners;
			const coreBounds = { minX: Math.min(...maskCorners.map(point => point[0])), minY: Math.min(...maskCorners.map(point => point[1])), maxX: Math.max(...maskCorners.map(point => point[0])), maxY: Math.max(...maskCorners.map(point => point[1])) };
			candidates.push({
				sourceIdentity, componentId, padNumber: number, layer, runtimePad,
				sourcePad: { shape: 'RECT', localCopperLayerId: pad.layerId, widthMil, heightMil, radiusMil: 0, sourceTopSolderExpansion, sourceBottomSolderExpansion, expansionMapping, selectedExpansionField, solderExpansionMil: expansionValue, expansionResolution: resolved.resolution },
				copperGeometry: { centerMil, rotationDegrees: snapshot.rotation, widthMil, heightMil, cornerPointsMil: rotateCorners(widthMil, heightMil) },
				maskGeometry: { centerMil, rotationDegrees: snapshot.rotation, coreWidthMil: pureRect ? maskWidth : widthMil, coreHeightMil: pureRect ? maskHeight : heightMil, coreCornerPointsMil: pureRect ? maskCorners : coreCorners, expansionRadiusMil: pureRect ? 0 : expansionValue, ...(pureRect ? { pureRect: true as const } : {}), outerBoundsMil: pureRect ? coreBounds : { minX: coreBounds.minX - expansionValue, minY: coreBounds.minY - expansionValue, maxX: coreBounds.maxX + expansionValue, maxY: coreBounds.maxY + expansionValue } },
			});
		}
	}
	return { scope: 'stable-footprint-pad-and-runtime-mask-candidates', available: true, complete: false, sourceStable: true, modelAssumptions, candidates, closed, overrideNeeded, skipped };
}

export function compareFootprintSourceSummaries(before: unknown, after: unknown): boolean {
	return JSON.stringify(before) === JSON.stringify(after);
}

export function unavailableFootprintSilkscreen(reason: string): FootprintSilkResult {
	return { strokes: [], potentialConflicts: [], unsupported: [{ type: 'footprint-source', reason }], coverage: { scope: 'document-embedded-or-project-library-footprint-source', supportedSubset: 'POLY on local layer 3/4, finite positive width, complete L coordinate-pair and ARC signed-sweep paths; exact line/arc bounds with closed paths; other curves and unknown commands unsupported', effectiveFootprintCount: 0, mappedComponentCount: 0, checkedStrokeCount: 0, excludedOutOfScopePolyCount: 0, unsupportedCount: 1, complete: false, sourcesAvailable: false, sourceStable: false, sources: [] }, sourceSummary: null };
}
