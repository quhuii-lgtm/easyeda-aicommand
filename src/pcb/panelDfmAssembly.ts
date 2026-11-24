import { readTable } from './manufacturingPreflight';

type AssemblyMode = 'smt' | 'manual' | 'omit';
interface Placement { designator: string; x: number; y: number; rotation: number; side: 'top' | 'bottom'; footprint: string }
interface Rectangle { designator: string; partNumber: string; source: string; widthMm: number; lengthMm: number; rotationOffsetDeg?: number }
interface Point { x: number; y: number }
interface Segment { unitDesignator?: string; scope?: 'panel' | 'unit'; side: 'top' | 'bottom'; id: string; a: Point; b: Point }
interface TraceItem { designator: string; unit: string | null; originalDesignator: string | null; mode: AssemblyMode | null; partNumber: string | null; footprint: string | null; partSource: string | null; placement: Placement | null }
type DimensionItem = TraceItem & ({ bodyGeometry: null; status: 'unverified'; reason: string } | { bodyGeometry: Point[]; bodyDimensionSource: string; status: 'measured' });
type EdgeItem = { designator: string; unit: string | null; side: 'top' | 'bottom' } & ({ distanceMm: null; status: 'unverified'; reason: string } | { id: string; distanceMm: number; status: 'below-threshold' | 'meets-threshold' | 'measured-threshold-unspecified' });

function tableRows(base64: string, columns: string[], optionalColumns: string[] = []) {
	const { rows } = readTable(base64);
	const header = rows[0];
	const indexes = new Map<string, number>();
	for (const name of [...columns, ...optionalColumns]) {
		const matches = header.flatMap((value, index) => value.trim() === name ? [index] : []);
		if (matches.length > 1 || (!optionalColumns.includes(name) && matches.length !== 1))
			throw new Error(`需要唯一列 ${name}`);
		if (matches.length === 1)
			indexes.set(name, matches[0]);
	}
	return rows.slice(1).map(row => Object.fromEntries([...indexes].map(([name, index]) => [name, row[index].trim()])));
}

function finitePositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseCoordinate(value: string, label: string): number {
	const match = /^(-?\d+(?:\.\d+)?)\s*mm$/i.exec(value);
	if (!match || !Number.isFinite(Number(match[1])))
		throw new Error(`${label} 必须是毫米数`);
	return Number(match[1]);
}

function parsePlacement(base64: string) {
	const rows = tableRows(base64, ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], ['Footprint']);
	const values: Placement[] = [];
	const duplicates: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const designator = row.Designator;
		if (!designator || seen.has(designator)) {
			duplicates.push(designator || '(空位号)');
			continue;
		}
		seen.add(designator);
		const side = /^(?:top|t)$/i.test(row.Layer) ? 'top' : /^(?:bottom|b)$/i.test(row.Layer) ? 'bottom' : undefined;
		const rotation = Number(row.Rotation);
		if (!side || !Number.isFinite(rotation)) {
			duplicates.push(`${designator}（层或角度无效）`);
			continue;
		}
		values.push({ designator, x: parseCoordinate(row['Mid X'], `${designator} Mid X`), y: parseCoordinate(row['Mid Y'], `${designator} Mid Y`), rotation, side, footprint: row.Footprint ?? '' });
	}
	return { values, duplicates };
}

function parseBom(base64: string) {
	const { rows } = readTable(base64);
	const header = rows[0].map(value => value.trim());
	const column = (name: string, aliases: string[] = [], required = true) => {
		for (const candidate of [name, ...aliases]) {
			const matches = header.flatMap((value, index) => value === candidate ? [index] : []);
			if (matches.length > 1)
				throw new Error(`需要唯一列 ${candidate}`);
			if (matches.length === 1)
				return { name: candidate, index: matches[0] };
		}
		if (required)
			throw new Error(`需要唯一列 ${name}`);
		return undefined;
	};
	const refColumn = column('Designator')!;
	const quantityColumn = column('Quantity')!;
	const footprintColumn = column('Footprint', [], false);
	const partColumn = column('LCSC Part #', ['Supplier Part', 'Manufacturer Part', 'MPN'], false);
	const values = new Map<string, { footprint: string; partNumber: string; partSource: string | null }>();
	const issues: string[] = [];
	for (const row of rows.slice(1)) {
		const designatorCell = row[refColumn.index].trim();
		const refs = designatorCell.split(',').map((ref: string) => ref.trim()).filter(Boolean);
		if (refs.length !== Number(row[quantityColumn.index])) {
			issues.push(`BOM 数量与位号数不符：${designatorCell}`);
			continue;
		}
		for (const designator of refs) {
			if (values.has(designator)) {
				issues.push(`BOM 位号重复：${designator}`);
			}
			else {
				values.set(designator, { footprint: footprintColumn ? row[footprintColumn.index].trim() : '', partNumber: partColumn ? row[partColumn.index].trim() : '', partSource: partColumn?.name ?? null });
			}
		}
	}
	return { values, issues };
}

function parseAssignments(base64: string) {
	const rows = tableRows(base64, ['Unit', 'Original', 'Panel', 'Assembly']);
	const values = new Map<string, { unit: string; original: string; mode: AssemblyMode }>();
	const excluded: Array<{ unit: string; original: string; mode: 'manual' | 'omit' }> = [];
	const issues: string[] = [];
	for (const row of rows) {
		const mode = /^smt$/i.test(row.Assembly)
			? 'smt'
			: /^(?:manual|hand|手焊|手装)$/i.test(row.Assembly)
				? 'manual'
				: /^(?:omit|dnp|不装)$/i.test(row.Assembly) ? 'omit' : undefined;
		if (!row.Unit || !row.Original || !mode) {
			issues.push(`拼板装配映射不完整：${row.Panel || '(空位号)'}`);
			continue;
		}
		if (!row.Panel) {
			if (mode === 'smt')
				issues.push(`机贴位号缺少拼板位号：${row.Original}`);
			else excluded.push({ unit: row.Unit, original: row.Original, mode });
			continue;
		}
		if (values.has(row.Panel))
			issues.push(`拼板装配映射重复：${row.Panel}`);
		else values.set(row.Panel, { unit: row.Unit, original: row.Original, mode });
	}
	return { values, excluded, issues };
}

function rectangleAt(item: Placement, dimensions: Rectangle): Point[] {
	const angle = (item.rotation + (dimensions.rotationOffsetDeg ?? 0)) * Math.PI / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return [[-dimensions.widthMm / 2, -dimensions.lengthMm / 2], [dimensions.widthMm / 2, -dimensions.lengthMm / 2], [dimensions.widthMm / 2, dimensions.lengthMm / 2], [-dimensions.widthMm / 2, dimensions.lengthMm / 2]]
		.map(([x, y]) => ({ x: item.x + x * cos - y * sin, y: item.y + x * sin + y * cos }));
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length2 = dx * dx + dy * dy;
	const ratio = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
	return Math.hypot(p.x - (a.x + ratio * dx), p.y - (a.y + ratio * dy));
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const epsilon = 1e-9;
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
		&& ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) {
		return true;
	}
	return (Math.abs(o1) <= epsilon && pointSegmentDistance(c, a, b) <= epsilon)
		|| (Math.abs(o2) <= epsilon && pointSegmentDistance(d, a, b) <= epsilon)
		|| (Math.abs(o3) <= epsilon && pointSegmentDistance(a, c, d) <= epsilon)
		|| (Math.abs(o4) <= epsilon && pointSegmentDistance(b, c, d) <= epsilon);
}

function rectangleDistance(a: Point[], b: Point[]): number {
	if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a))
		return 0;
	let minimum = Infinity;
	for (let i = 0; i < 4; i++) {
		const a0 = a[i];
		const a1 = a[(i + 1) % 4];
		for (let j = 0; j < 4; j++) {
			const b0 = b[j];
			const b1 = b[(j + 1) % 4];
			if (segmentsIntersect(a0, a1, b0, b1))
				return 0;
			minimum = Math.min(minimum, pointSegmentDistance(a0, b0, b1), pointSegmentDistance(b0, a0, a1));
		}
	}
	return minimum;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (pointSegmentDistance(point, a, b) <= 1e-9)
			return true;
		if ((a.y > point.y) !== (b.y > point.y)
			&& point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

function rectangleToSegmentDistance(rectangle: Point[], segment: Segment): number {
	if (pointInPolygon(segment.a, rectangle) || pointInPolygon(segment.b, rectangle))
		return 0;
	let minimum = Infinity;
	for (let i = 0; i < 4; i++) {
		const a = rectangle[i];
		const b = rectangle[(i + 1) % 4];
		if (segmentsIntersect(a, b, segment.a, segment.b))
			return 0;
		minimum = Math.min(minimum, pointSegmentDistance(a, segment.a, segment.b), pointSegmentDistance(segment.a, a, b), pointSegmentDistance(segment.b, a, b));
	}
	return minimum;
}

export function auditPanelAssembly(input: {
	bomBase64: string;
	placementBase64: string;
	assignmentBase64?: string;
	bodyDimensions?: Rectangle[];
	outlineSegments?: Segment[];
	minimumBodyClearanceMm?: number;
	minimumBodyToEdgeMm?: number;
}) {
	for (const threshold of [input.minimumBodyClearanceMm, input.minimumBodyToEdgeMm]) {
		if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0))
			throw new Error('几何间距阈值必须为非负毫米数');
	}
	const { values: bom, issues: bomIssues } = parseBom(input.bomBase64);
	const { values: placements, duplicates: placementIssues } = parsePlacement(input.placementBase64);
	const { values: assignments, excluded: excludedAssignments, issues: assignmentIssues } = input.assignmentBase64
		? parseAssignments(input.assignmentBase64)
		: { values: new Map<string, { unit: string; original: string; mode: AssemblyMode }>(), excluded: [], issues: [] };
	const issues = [...bomIssues, ...placementIssues, ...assignmentIssues];
	const bomRefs = new Set(bom.keys());
	const placementRefs = new Set(placements.map(item => item.designator));
	const placementsById = new Map(placements.map(item => [item.designator, item]));
	const assignmentRefs = new Set(assignments.keys());
	const hasAssignments = Boolean(input.assignmentBase64);
	const expectedSmtRefs = hasAssignments
		? [...assignmentRefs].filter(ref => assignments.get(ref)!.mode === 'smt')
		: [...bomRefs];
	const missingBom = (hasAssignments ? expectedSmtRefs : [...placementRefs]).filter(ref => !bomRefs.has(ref)).sort();
	const unexpectedBom = [...bomRefs].filter(ref => hasAssignments
		? assignments.get(ref)?.mode !== 'smt'
		: !placementRefs.has(ref)).sort();
	const missingPlacement = [...bomRefs].filter(ref => (!hasAssignments || assignments.get(ref)?.mode === 'smt') && !placementRefs.has(ref)).sort();
	const unexpectedPlacement = [...placementRefs].filter(ref => hasAssignments
		? assignments.get(ref)?.mode !== 'smt'
		: !bomRefs.has(ref)).sort();
	if (!hasAssignments && [...bomRefs].some(ref => !placementRefs.has(ref)))
		issues.push('缺少机贴名单映射，无法判断没有贴片坐标的位号属于手装还是数据缺失');
	for (const ref of missingBom) issues.push(`机贴名单位号缺少 BOM：${ref}`);
	for (const ref of unexpectedBom) issues.push(`BOM 含非机贴位号：${ref}`);
	for (const ref of missingPlacement) issues.push(`机贴位号缺少贴片坐标：${ref}`);
	for (const ref of unexpectedPlacement) issues.push(`贴片坐标含非机贴位号：${ref}`);
	const top = placements.filter(item => item.side === 'top');
	const bottom = placements.filter(item => item.side === 'bottom');
	const countByMode = (mode: AssemblyMode) => hasAssignments
		? [...assignments.values()].filter(item => item.mode === mode).length + excludedAssignments.filter(item => item.mode === mode).length
		: null;
	const materialTraceability = [...bom].map(([designator, item]) => {
		const assignment = assignments.get(designator);
		return { designator, unit: assignment?.unit ?? null, originalDesignator: assignment?.original ?? null, mode: assignment?.mode ?? null, partNumber: item.partNumber || null, footprint: item.footprint || null, partSource: item.partSource, placement: placementsById.get(designator) ?? null };
	});
	const dimensions = new Map<string, Rectangle>();
	for (const dimension of input.bodyDimensions ?? []) {
		if (!dimension.designator || !dimension.partNumber || !dimension.source || !finitePositive(dimension.widthMm)
			|| !finitePositive(dimension.lengthMm) || !Number.isFinite(dimension.rotationOffsetDeg ?? 0)) {
			throw new Error('实配本体尺寸需要位号、料号、来源及有效长宽');
		}
		if (dimensions.has(dimension.designator))
			throw new Error(`实配本体尺寸重复：${dimension.designator}`);
		dimensions.set(dimension.designator, dimension);
	}
	const bodyChecks = [];
	const dimensionItems: DimensionItem[] = materialTraceability.flatMap((item): DimensionItem[] => {
		if ((hasAssignments && item.mode !== 'smt') || !item.placement)
			return [];
		const dimension = dimensions.get(item.designator);
		if (!dimension)
			return [{ ...item, bodyGeometry: null, status: 'unverified' as const, reason: '缺少带来源的实配本体长宽' }];
		if (dimension.partNumber !== item.partNumber)
			return [{ ...item, bodyGeometry: null, status: 'unverified' as const, reason: '尺寸来源料号与 BOM 料号不一致' }];
		return [{ ...item, bodyGeometry: rectangleAt(item.placement, dimension), bodyDimensionSource: dimension.source, status: 'measured' as const }];
	});
	const measured = dimensionItems.filter(item => item.status === 'measured');
	const nearestByDesignator = new Map<string, { other: string; distance: number; first: typeof measured[number]; second: typeof measured[number] }>();
	for (let i = 0; i < measured.length; i++) {
		const a = measured[i];
		for (let j = i + 1; j < measured.length; j++) {
			const b = measured[j];
			if (a.placement!.side !== b.placement!.side)
				continue;
			const distance = rectangleDistance(a.bodyGeometry!, b.bodyGeometry!);
			if (input.minimumBodyClearanceMm === undefined) {
				for (const [current, other] of [[a, b], [b, a]] as const) {
					const nearest = nearestByDesignator.get(current.designator);
					if (!nearest || distance < nearest.distance)
						nearestByDesignator.set(current.designator, { other: other.designator, distance, first: a, second: b });
				}
			}
			else if (distance <= input.minimumBodyClearanceMm) {
				bodyChecks.push({ first: a.designator, second: b.designator, side: a.placement!.side, distanceMm: distance, status: distance < input.minimumBodyClearanceMm ? 'below-threshold' : 'meets-threshold', sources: [a.bodyDimensionSource, b.bodyDimensionSource] });
			}
		}
	}
	if (input.minimumBodyClearanceMm === undefined) {
		for (const [designator, item] of nearestByDesignator) {
			bodyChecks.push({ first: designator, second: item.other, side: item.first.placement!.side, distanceMm: item.distance, status: 'measured-threshold-unspecified', sources: [item.first.bodyDimensionSource, item.second.bodyDimensionSource] });
		}
	}
	const edgeChecks: EdgeItem[] = measured.flatMap((item): EdgeItem[] => {
		const matching = (input.outlineSegments ?? []).filter(segment => segment.side === item.placement!.side
			&& (segment.scope === 'panel' || (!segment.scope && !segment.unitDesignator) || segment.unitDesignator === item.unit));
		if (!matching.length)
			return [{ designator: item.designator, unit: item.unit, side: item.placement!.side, distanceMm: null, status: 'unverified' as const, reason: '缺少所属单板及对应面的板框或锣槽边界' }];
		const distances = matching.map(segment => ({ id: segment.id, distanceMm: rectangleToSegmentDistance(item.bodyGeometry!, segment) }))
			.sort((a, b) => a.distanceMm - b.distanceMm);
		const nearest = distances[0];
		return input.minimumBodyToEdgeMm === undefined || nearest.distanceMm <= input.minimumBodyToEdgeMm
			? [{ designator: item.designator, unit: item.unit, side: item.placement!.side, ...nearest, status: input.minimumBodyToEdgeMm === undefined
					? 'measured-threshold-unspecified' as const
					: nearest.distanceMm < input.minimumBodyToEdgeMm ? 'below-threshold' as const : 'meets-threshold' as const }]
			: [];
	});
	const capped = <T>(items: T[], limit = 50) => ({
		count: items.length,
		items: items.length > limit ? items.slice(0, limit) : items,
		omittedCount: Math.max(0, items.length - limit),
	});
	return {
		complete: issues.length === 0 && !placementIssues.length,
		inputCounts: { bom: bom.size, placement: placements.length, assignment: assignments.size + excludedAssignments.length },
		assemblyCounts: { topSmt: top.length, bottomSmt: bottom.length, manual: countByMode('manual'), omit: countByMode('omit'), basis: hasAssignments ? 'explicit assignment map' : 'BOM and placement designators match; manual/omit classification unavailable' },
		reconciliation: { missingBom, unexpectedBom, missingPlacement, unexpectedPlacement, issues },
		excludedAssignments,
		materialTraceability,
		bodyGeometry: { status: input.bodyDimensions?.length ? 'partial-model-review' as const : 'unverified' as const, providedModels: input.bodyDimensions?.length ?? 0, unverified: capped(dimensionItems.filter(item => item.status === 'unverified')), intercomponent: input.minimumBodyClearanceMm === undefined ? capped(bodyChecks) : { count: bodyChecks.length, items: bodyChecks, omittedCount: 0 }, minimumClearanceMm: input.minimumBodyClearanceMm ?? null },
		boardEdge: { status: input.outlineSegments?.length ? 'partial-model-review' as const : 'unverified' as const, measurements: input.minimumBodyToEdgeMm === undefined ? capped(edgeChecks) : { count: edgeChecks.length, items: edgeChecks, omittedCount: 0 }, minimumDistanceMm: input.minimumBodyToEdgeMm ?? null },
		readOnly: true,
	};
}
