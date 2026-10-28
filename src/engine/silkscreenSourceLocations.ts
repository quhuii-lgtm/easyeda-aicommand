import { sdkBoxDistanceMil } from './silkscreenCheck';
import type { BBox, CheckedBoxObject, SilkLayer } from './silkscreenCheck';
import type { FootprintSilkResult, FootprintSilkStroke } from './footprintSilkscreen';

export const SOURCE_LOCATION_SEARCH_MARGIN_MIL = 0.01;

export interface ManufacturingLocationConflict {
	category: string;
	layer: SilkLayer;
	locationBoundsMil?: unknown;
	locationUnavailable?: boolean;
	locationUnavailableReason?: string;
	locationTruncated?: boolean;
	locationKind?: 'distance-witness';
	locationEnumerationComplete?: false;
	locationWitness?: { distanceBound: 'lower'; silkGeometry: 'outer-envelope'; kind: 'intersection' | 'contained-point' | 'nearest-points'; silkPointMil: [number, number]; boardPointMil: [number, number]; measuredDistanceMil: number };
}

export interface ManufacturingLocationReport {
	confirmedConflicts?: readonly ManufacturingLocationConflict[];
	potentialConflicts?: readonly ManufacturingLocationConflict[];
}

export type ManufacturingSourceCandidate = {
	channel: 'sdk-object';
	role: 'silkscreen-source' | 'mask-opening-owner-candidate';
	id: string;
	type: CheckedBoxObject['type'];
	componentId?: string;
	designator?: string;
	text?: string;
	side: CheckedBoxObject['layer'];
	bbox: BBox;
	bboxDistanceToLocationMil: number;
	confirmed: false;
} | {
	channel: 'footprint-source';
	role: 'silkscreen-source';
	sourceIdentity: FootprintSilkStroke['sourceIdentity'];
	side: SilkLayer;
	bbox: BBox;
	bboxDistanceToLocationMil: number;
	confirmed: false;
};

export interface ManufacturingSourceLocation {
	bucket: 'confirmed' | 'potential';
	conflictIndex: number;
	category: string;
	layer: SilkLayer;
	areaIndex: number | null;
	locationBoundsMil?: BBox;
	locationTruncated: boolean;
	locationKind?: 'distance-witness';
	locationEnumerationComplete?: false;
	locationWitness?: ManufacturingLocationConflict['locationWitness'];
	status: 'unavailable' | 'candidate' | 'ambiguous';
	reason?: string;
	candidateCount: number;
	candidates: ManufacturingSourceCandidate[];
	roleGroups: ManufacturingSourceRoleGroup[];
}

export interface ManufacturingSourceRoleGroup {
	role: 'silkscreen-source' | 'mask-opening-owner-candidate';
	status: 'unavailable' | 'candidate' | 'ambiguous';
	candidateCount: number;
	candidateIndices: number[];
	reason?: string;
}

export interface ManufacturingSourceLocationsResult {
	scope: 'nearby-source-bbox-candidates-for-manufacturing-location-regions';
	granularity: string;
	searchRule: string;
	searchMarginMil: number;
	complete: false;
	available: boolean;
	unavailableReason?: string;
	locations: ManufacturingSourceLocation[];
}

interface SourceBox {
	channel: 'sdk-object';
	id: string;
	type: CheckedBoxObject['type'];
	componentId?: string;
	designator?: string;
	text?: string;
	side: CheckedBoxObject['layer'];
	bbox: BBox;
}

interface FootprintSourceBox {
	channel: 'footprint-source';
	stroke: FootprintSilkStroke;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function sourceKey(source: SourceBox | FootprintSourceBox): string {
	if (source.channel === 'sdk-object')
		return JSON.stringify([source.channel, source.id]);
	const identity = source.stroke.sourceIdentity;
	return JSON.stringify([source.channel, identity.componentId, identity.footprintUuid, identity.localPrimitiveId, identity.source, identity.libraryUuid ?? '']);
}

function validBox(value: unknown): BBox | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	const item = value as Record<string, unknown>;
	const fields = [item.minX, item.minY, item.maxX, item.maxY];
	if (fields.some(field => typeof field !== 'number' || !Number.isFinite(field)))
		return undefined;
	const [minX, minY, maxX, maxY] = fields as number[];
	if (minX > maxX || minY > maxY)
		return undefined;
	return { minX, minY, maxX, maxY };
}

function sdkObjectRoles(type: CheckedBoxObject['type'] | string): Array<ManufacturingSourceCandidate['role']> {
	switch (type) {
		case 'text':
		case 'designator':
		case 'silk-polyline':
		case 'silk-line':
		case 'silk-arc':
			return ['silkscreen-source'];
		case 'standalone-pad':
		case 'component-pad':
			return ['mask-opening-owner-candidate'];
		default:
			return [];
	}
}

function rolesForCategory(category: string): Array<ManufacturingSourceCandidate['role']> {
	if (category === 'silk-to-mask-opening')
		return ['silkscreen-source', 'mask-opening-owner-candidate'];
	if (category === 'silk-to-board-edge' || category === 'silk-outside-board')
		return ['silkscreen-source'];
	return [];
}

function layerMatches(candidateLayer: CheckedBoxObject['layer'] | SilkLayer, conflictLayer: SilkLayer): boolean {
	return candidateLayer === conflictLayer || candidateLayer === 'multi';
}

function candidateSortKey(candidate: ManufacturingSourceCandidate): string {
	if (candidate.channel === 'sdk-object')
		return JSON.stringify([candidate.channel, candidate.id, candidate.type, candidate.componentId ?? '', candidate.side]);
	const identity = candidate.sourceIdentity;
	return JSON.stringify([candidate.channel, identity.componentId, identity.footprintUuid, identity.localPrimitiveId, identity.source, identity.libraryUuid ?? '', candidate.side]);
}

function sourceCandidatesForArea(
	sources: Array<SourceBox | FootprintSourceBox>,
	conflict: ManufacturingLocationConflict,
	location: BBox,
	searchDistanceMil: number,
	checkBudget?: () => void,
): ManufacturingSourceCandidate[] {
	const candidates = new Map<string, ManufacturingSourceCandidate>();
	for (const source of sources) {
		checkBudget?.();
		if (source.channel === 'sdk-object') {
			const role = sdkObjectRoles(source.type)[0];
			if (!role || !rolesForCategory(conflict.category).includes(role) || !layerMatches(source.side, conflict.layer))
				continue;
			const bboxDistanceToLocationMil = sdkBoxDistanceMil(source.bbox, location);
			if (!Number.isFinite(bboxDistanceToLocationMil) || bboxDistanceToLocationMil > searchDistanceMil)
				continue;
			const candidate: ManufacturingSourceCandidate = {
				channel: source.channel,
				role,
				id: source.id,
				type: source.type,
				componentId: source.componentId,
				designator: source.designator,
				text: source.text,
				side: source.side,
				bbox: { ...source.bbox },
				bboxDistanceToLocationMil,
				confirmed: false,
			};
			const key = sourceKey(source);
			const previous = candidates.get(key);
			if (!previous || bboxDistanceToLocationMil < previous.bboxDistanceToLocationMil)
				candidates.set(key, candidate);
			continue;
		}
		if (!rolesForCategory(conflict.category).includes('silkscreen-source') || source.stroke.side !== conflict.layer)
			continue;
		const bboxDistanceToLocationMil = sdkBoxDistanceMil(source.stroke.bbox, location);
		if (!Number.isFinite(bboxDistanceToLocationMil) || bboxDistanceToLocationMil > searchDistanceMil)
			continue;
		const candidate: ManufacturingSourceCandidate = {
			channel: source.channel,
			role: 'silkscreen-source',
			sourceIdentity: { ...source.stroke.sourceIdentity },
			side: source.stroke.side,
			bbox: { ...source.stroke.bbox },
			bboxDistanceToLocationMil,
			confirmed: false,
		};
		const key = sourceKey(source);
		const previous = candidates.get(key);
		if (!previous || bboxDistanceToLocationMil < previous.bboxDistanceToLocationMil)
			candidates.set(key, candidate);
	}
	return [...candidates.values()].sort((a, b) => compareText(candidateSortKey(a), candidateSortKey(b)));
}

function resultForLocation(
	base: Omit<ManufacturingSourceLocation, 'status' | 'reason' | 'candidateCount' | 'candidates' | 'roleGroups'>,
	candidates: ManufacturingSourceCandidate[],
	noCandidateReason = '未找到符合范围、同面且位于搜索距离内的来源包围盒；这不表示没有制造风险',
): ManufacturingSourceLocation {
	const status = candidates.length === 0 ? 'unavailable' : candidates.length === 1 ? 'candidate' : 'ambiguous';
	const roles = rolesForCategory(base.category);
	const roleGroups: ManufacturingSourceRoleGroup[] = roles.map(role => {
		const candidateIndices = candidates.flatMap((candidate, index) => candidate.role === role ? [index] : []);
		const roleStatus: ManufacturingSourceRoleGroup['status'] = candidateIndices.length === 0 ? 'unavailable' : candidateIndices.length === 1 ? 'candidate' : 'ambiguous';
		const roleReason = roleStatus !== 'unavailable' ? undefined
			: role === 'mask-opening-owner-candidate'
				? '未找到附近的开窗归属候选；pad 包围盒只表示铜对象候选，不证明实际阻焊开窗归属，也不表示没有制造风险'
				: noCandidateReason;
		return {
			role,
			status: roleStatus,
			candidateCount: candidateIndices.length,
			candidateIndices,
			...(roleReason ? { reason: roleReason } : {}),
		};
	});
	return {
		...base,
		status,
		...(candidates.length === 0 ? { reason: noCandidateReason } : {}),
		candidateCount: candidates.length,
		candidates,
		roleGroups,
	};
}

export function locateManufacturingSourceCandidates(args: {
	manufacturing?: ManufacturingLocationReport;
	checkedObjects: readonly CheckedBoxObject[];
	footprintSilkscreen: Pick<FootprintSilkResult, 'strokes' | 'coverage'>;
	minClearanceMil: number;
	checkBudget?: () => void;
}): ManufacturingSourceLocationsResult {
	if (!Number.isFinite(args.minClearanceMil) || args.minClearanceMil < 0)
		throw new TypeError('minClearanceMil must be a finite non-negative mil distance');
	const checkBudget = args.checkBudget;
	const sourcesByKey = new Map<string, SourceBox | FootprintSourceBox>();
	for (const object of args.checkedObjects) {
		checkBudget?.();
		const bbox = validBox(object.box);
		if (!object.id || !bbox)
			continue;
		const source: SourceBox = { channel: 'sdk-object', id: object.id, type: object.type, componentId: object.componentId, designator: object.designator, text: object.text, side: object.layer, bbox };
		if (!sourcesByKey.has(sourceKey(source)))
			sourcesByKey.set(sourceKey(source), source);
	}
	if (args.footprintSilkscreen.coverage.sourceStable) {
		for (const stroke of args.footprintSilkscreen.strokes) {
			checkBudget?.();
			const bbox = validBox(stroke.bbox);
			if (!bbox)
				continue;
			const source: FootprintSourceBox = { channel: 'footprint-source', stroke: { ...stroke, bbox } };
			if (!sourcesByKey.has(sourceKey(source)))
				sourcesByKey.set(sourceKey(source), source);
		}
	}
	const sources = [...sourcesByKey.values()];
	const locations: ManufacturingSourceLocation[] = [];
	if (!args.manufacturing || !Array.isArray(args.manufacturing.confirmedConflicts) || !Array.isArray(args.manufacturing.potentialConflicts)) {
		return {
			scope: 'nearby-source-bbox-candidates-for-manufacturing-location-regions',
			granularity: 'The legacy flat candidate list and status/count retain the combined per-location nearby-candidate view. roleGroups split indices into supported silkscreen sources and, for mask conflicts, nearby mask-opening-owner candidates. Pad bounding boxes are copper-object candidates, not known mask-opening owners; an unavailable owner group does not mean no manufacturing risk. Board-edge locations carry one lower-bound outer-envelope distance witness; outside-board locations remain manufacturing location bounds. Neither is source attribution. Clear-paint is not tracked.',
			searchRule: 'Include same-side in-scope SDK objects and valid footprint strokes when bbox distance to the region is <= minClearanceMil + searchMarginMil.',
			searchMarginMil: SOURCE_LOCATION_SEARCH_MARGIN_MIL,
			complete: false,
			available: false,
			unavailableReason: args.manufacturing && typeof (args.manufacturing as any).unavailableReason === 'string' ? (args.manufacturing as any).unavailableReason : 'manufacturing report did not provide confirmed or potential conflict arrays',
			locations,
		};
	}
	const buckets: Array<[ManufacturingSourceLocation['bucket'], readonly ManufacturingLocationConflict[]]> = [
		['confirmed', args.manufacturing.confirmedConflicts ?? []],
		['potential', args.manufacturing.potentialConflicts ?? []],
	];
	const searchDistanceMil = args.minClearanceMil + SOURCE_LOCATION_SEARCH_MARGIN_MIL;
	for (const [bucket, conflicts] of buckets) {
		for (let conflictIndex = 0; conflictIndex < conflicts.length; conflictIndex++) {
			checkBudget?.();
			const conflict = conflicts[conflictIndex];
			const conflictBase = { bucket, conflictIndex, category: conflict.category, layer: conflict.layer, locationTruncated: conflict.locationTruncated === true, locationKind: conflict.locationKind, locationEnumerationComplete: conflict.locationEnumerationComplete, locationWitness: conflict.locationWitness };
			if (!Array.isArray(conflict.locationBoundsMil)) {
				const reason = conflict.locationUnavailableReason ?? (conflict.locationUnavailable ? 'manufacturing geometry has no location bounds' : 'manufacturing geometry omitted its location bounds');
				locations.push(resultForLocation({ ...conflictBase, areaIndex: null }, [], reason));
				continue;
			}
			if (conflict.locationBoundsMil.length === 0) {
				locations.push(resultForLocation({ ...conflictBase, areaIndex: null }, [], 'manufacturing geometry returned an empty location-bounds list'));
				continue;
			}
			for (let areaIndex = 0; areaIndex < conflict.locationBoundsMil.length; areaIndex++) {
				checkBudget?.();
				const rawBounds = conflict.locationBoundsMil[areaIndex];
				const location = validBox(rawBounds);
				if (!location) {
					locations.push(resultForLocation({ ...conflictBase, areaIndex }, [], 'manufacturing geometry returned an invalid or non-finite location bbox'));
					continue;
				}
				const candidates = sourceCandidatesForArea(sources, conflict, location, searchDistanceMil, checkBudget);
				locations.push(resultForLocation({ ...conflictBase, areaIndex, locationBoundsMil: location }, candidates));
			}
		}
	}
	return {
		scope: 'nearby-source-bbox-candidates-for-manufacturing-location-regions',
		granularity: 'The legacy flat candidate list and status/count retain the combined per-location nearby-candidate view. roleGroups split indices into supported silkscreen sources and, for mask conflicts, nearby mask-opening-owner candidates. Pad bounding boxes are copper-object candidates, not known mask-opening owners; an unavailable owner group does not mean no manufacturing risk. Board-edge locations carry one lower-bound outer-envelope distance witness; outside-board locations remain manufacturing location bounds. Neither is source attribution. Clear-paint is not tracked.',
		searchRule: 'Include same-side in-scope SDK objects and valid footprint strokes when bbox distance to the region is <= minClearanceMil + searchMarginMil.',
		searchMarginMil: SOURCE_LOCATION_SEARCH_MARGIN_MIL,
		complete: false,
		available: true,
		locations,
	};
}
