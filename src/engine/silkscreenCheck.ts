import { parseSourceLog, type ISourceRecord } from '../pcb/sourcelog';

export type SilkLayer = 'top' | 'bottom';

export interface SilkscreenSourceComparison {
	matches: boolean;
	reason: string;
	representationChanges: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstSourceDifference(expected: unknown, actual: unknown, field: string): string | undefined {
	if (Object.is(expected, actual)) return undefined;
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const length = Math.min(expected.length, actual.length);
		for (let index = 0; index < length; index++) {
			const difference = firstSourceDifference(expected[index], actual[index], `${field}[${index}]`);
			if (difference) return difference;
		}
		return expected.length === actual.length ? undefined : `${field}.length`;
	}
	if (isObject(expected) && isObject(actual)) {
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
		for (const key of keys) {
			if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) return `${field}.${key}`;
			const difference = firstSourceDifference(expected[key], actual[key], `${field}.${key}`);
			if (difference) return difference;
		}
		return undefined;
	}
	return field;
}

function collectKeyOrderChanges(expected: unknown, actual: unknown, field: string, changes: Set<string>): void {
	if (Array.isArray(expected) && Array.isArray(actual)) {
		for (let index = 0; index < Math.min(expected.length, actual.length); index++)
			collectKeyOrderChanges(expected[index], actual[index], `${field}[${index}]`, changes);
		return;
	}
	if (!isObject(expected) || !isObject(actual)) return;
	const expectedKeys = Object.keys(expected);
	const actualKeys = Object.keys(actual);
	if (expectedKeys.length === actualKeys.length && expectedKeys.every(key => Object.hasOwn(actual, key)) && expectedKeys.some((key, index) => actualKeys[index] !== key))
		changes.add(`${field}: 对象键顺序变化`);
	for (const key of expectedKeys)
		if (Object.hasOwn(actual, key)) collectKeyOrderChanges(expected[key], actual[key], `${field}.${key}`, changes);
}

function sourceRecordLabel(record: ISourceRecord | undefined): string {
	return record ? `${String(record.header.type)}(${String(record.header.id ?? '无ID')})` : '缺少记录';
}

function failedSourceComparison(reason: string): SilkscreenSourceComparison {
	return { matches: false, reason, representationChanges: [] };
}

/**
 * Compare the source bracketing a read-only silkscreen check. It tolerates only
 * confirmed host serialization changes: object-key order, volatile DOCHEAD
 * metadata, and PAD_NET ordering/ticket reassignment with unchanged identity/data.
 */
export function compareSilkscreenSourceSnapshots(beforeSource: unknown, afterSource: unknown): SilkscreenSourceComparison {
	if (typeof beforeSource !== 'string' || typeof afterSource !== 'string')
		return failedSourceComparison('丝印源码快照必须是字符串');
	let before: ReturnType<typeof parseSourceLog>;
	let after: ReturnType<typeof parseSourceLog>;
	try { before = parseSourceLog(beforeSource); }
	catch (error) { return failedSourceComparison(`基准源码解析失败：${error instanceof Error ? error.message : String(error)}`); }
	try { after = parseSourceLog(afterSource); }
	catch (error) { return failedSourceComparison(`当前源码解析失败：${error instanceof Error ? error.message : String(error)}`); }
	if (before.docType.toUpperCase() !== 'PCB' || after.docType.toUpperCase() !== 'PCB')
		return failedSourceComparison('源码文档类型不是 PCB');
	if (before.uuid !== after.uuid)
		return failedSourceComparison(`DOCHEAD.uuid 不同：${before.uuid} → ${after.uuid}`);
	const changes = new Set<string>();
	const beforeHeads = before.records.filter(record => record.header.type === 'DOCHEAD');
	const afterHeads = after.records.filter(record => record.header.type === 'DOCHEAD');
	if (beforeHeads.length !== 1 || afterHeads.length !== 1)
		return failedSourceComparison('DOCHEAD 必须且只能有一条');
	const beforeHead = beforeHeads[0];
	const afterHead = afterHeads[0];
	let difference = firstSourceDifference(beforeHead.header, afterHead.header, 'DOCHEAD.header');
	if (difference) return failedSourceComparison(`${difference} 不同`);
	if (!isObject(beforeHead.data) || !isObject(afterHead.data))
		return failedSourceComparison('DOCHEAD.data 不是对象');
	const stableBeforeHead = { ...beforeHead.data };
	const stableAfterHead = { ...afterHead.data };
	for (const key of ['client', 'updateTime', 'version'] as const) {
		if (!Object.is(stableBeforeHead[key], stableAfterHead[key])) changes.add(`DOCHEAD.${key} 变化`);
		delete stableBeforeHead[key];
		delete stableAfterHead[key];
	}
	difference = firstSourceDifference(stableBeforeHead, stableAfterHead, 'DOCHEAD.data');
	if (difference) return failedSourceComparison(`${difference} 不同`);
	collectKeyOrderChanges(beforeHead.data, afterHead.data, 'DOCHEAD.data', changes);

	const beforePadNets = before.records.filter(record => record.header.type === 'PAD_NET');
	const afterPadNets = after.records.filter(record => record.header.type === 'PAD_NET');
	const buildPadNetMap = (records: ISourceRecord[], label: string): Map<string, ISourceRecord> | SilkscreenSourceComparison => {
		const result = new Map<string, ISourceRecord>();
		for (const record of records) {
			if (typeof record.header.id !== 'string' || !record.header.id)
				return failedSourceComparison(`${label} 包含无效 PAD_NET 身份`);
			if (typeof record.header.ticket !== 'number' || !Number.isFinite(record.header.ticket) || !Number.isInteger(record.header.ticket) || record.header.ticket < 0)
				return failedSourceComparison(`${label} 的 PAD_NET(${record.header.id}) ticket 必须是有限非负整数`);
			if (record.data === '')
				return failedSourceComparison(`${label} 包含 PAD_NET 墓碑 ${record.header.id}`);
			if (result.has(record.header.id))
				return failedSourceComparison(`${label} 包含重复 PAD_NET 身份 ${record.header.id}`);
			result.set(record.header.id, record);
		}
		return result;
	};
	const beforePadNetMap = buildPadNetMap(beforePadNets, '基准源码');
	if (!(beforePadNetMap instanceof Map)) return beforePadNetMap;
	const afterPadNetMap = buildPadNetMap(afterPadNets, '当前源码');
	if (!(afterPadNetMap instanceof Map)) return afterPadNetMap;
	if (beforePadNetMap.size !== afterPadNetMap.size)
		return failedSourceComparison(`PAD_NET 身份数量变化：${beforePadNetMap.size} → ${afterPadNetMap.size}`);
	for (const [id, record] of beforePadNetMap) {
		const current = afterPadNetMap.get(id);
		if (!current) return failedSourceComparison(`PAD_NET 身份 ${id} 被删除或更换`);
		const beforeHeader = { ...record.header };
		const afterHeader = { ...current.header };
		delete beforeHeader.ticket;
		delete afterHeader.ticket;
		difference = firstSourceDifference(beforeHeader, afterHeader, `PAD_NET(${id}).header`);
		if (difference) return failedSourceComparison(`${difference} 不同`);
		difference = firstSourceDifference(record.data, current.data, `PAD_NET(${id}).data`);
		if (difference) return failedSourceComparison(`${difference} 不同`);
		if (!Object.is(record.header.ticket, current.header.ticket)) changes.add(`PAD_NET(${id}) ticket 变化`);
		collectKeyOrderChanges(record.header, current.header, `PAD_NET(${id}).header`, changes);
		collectKeyOrderChanges(record.data, current.data, `PAD_NET(${id}).data`, changes);
	}
	for (const id of afterPadNetMap.keys())
		if (!beforePadNetMap.has(id)) return failedSourceComparison(`新增 PAD_NET 身份 ${id}`);
	const beforePadNetOrder = beforePadNets.map(record => record.header.id);
	const afterPadNetOrder = afterPadNets.map(record => record.header.id);
	if (beforePadNetOrder.some((id, index) => afterPadNetOrder[index] !== id)) changes.add('PAD_NET 行序变化');

	const beforeOther = before.records.filter(record => record.header.type !== 'DOCHEAD' && record.header.type !== 'PAD_NET');
	const afterOther = after.records.filter(record => record.header.type !== 'DOCHEAD' && record.header.type !== 'PAD_NET');
	if (beforeOther.length !== afterOther.length)
		return failedSourceComparison(`非 PAD_NET 记录数量变化：${beforeOther.length} → ${afterOther.length}`);
	for (let index = 0; index < beforeOther.length; index++) {
		const expected = beforeOther[index];
		const actual = afterOther[index];
		difference = firstSourceDifference(expected.header, actual.header, `${sourceRecordLabel(expected)}.header`);
		if (difference) return failedSourceComparison(`第 ${index + 1} 条非 PAD_NET 记录的 ${difference} 不同（${sourceRecordLabel(expected)} → ${sourceRecordLabel(actual)}）`);
		difference = firstSourceDifference(expected.data, actual.data, `${sourceRecordLabel(expected)}.data`);
		if (difference) return failedSourceComparison(`第 ${index + 1} 条非 PAD_NET 记录的 ${difference} 不同`);
		collectKeyOrderChanges(expected.header, actual.header, `${sourceRecordLabel(expected)}.header`, changes);
		collectKeyOrderChanges(expected.data, actual.data, `${sourceRecordLabel(expected)}.data`, changes);
	}
	return { matches: true, reason: '丝印只读期间 PCB 设计内容稳定（允许确认的序列化变化）', representationChanges: [...changes] };
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface CheckSilkscreenInput {
	minClearance: number;
}

export interface CheckedBoxObject {
	id: string;
	type: 'text' | 'designator' | 'silk-polyline' | 'silk-line' | 'silk-arc' | 'standalone-pad' | 'component-pad';
	layer: SilkLayer | 'multi';
	box: BBox;
	componentId?: string;
	designator?: string;
	text?: string;
}

export function validateSilkscreenCheckParams(params: Record<string, any>): CheckSilkscreenInput {
	for (const key of Object.keys(params)) {
		if (key !== 'minClearance' && key !== '__docUuid' && key !== '_timeoutMs')
			throw new Error(`pcb.checkSilkscreen 不支持参数 ${key}`);
	}
	const minClearance = params.minClearance === undefined ? 0 : params.minClearance;
	if (typeof minClearance !== 'number' || !Number.isFinite(minClearance) || minClearance < 0)
		throw new Error('minClearance 必须是大于或等于 0 的有限 mil 数值');
	return { minClearance };
}

export function normalizeSdkBox(value: unknown): BBox | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	const box = value as Record<string, unknown>;
	const fields = [box.minX, box.minY, box.maxX, box.maxY];
	if (fields.some(field => typeof field !== 'number' || !Number.isFinite(field)))
		return undefined;
	const [minX, minY, maxX, maxY] = fields as number[];
	if (minX > maxX || minY > maxY)
		return undefined;
	return { minX, minY, maxX, maxY };
}

/** Distance between the SDK-provided axis-aligned boxes; it is not object-to-object clearance. */
export function sdkBoxDistanceMil(first: BBox, second: BBox): number {
	const dx = Math.max(0, first.minX - second.maxX, second.minX - first.maxX);
	const dy = Math.max(0, first.minY - second.maxY, second.minY - first.maxY);
	return Math.hypot(dx, dy);
}

export function silkSide(layerId: unknown): SilkLayer | undefined {
	if (layerId === 3)
		return 'top';
	if (layerId === 4)
		return 'bottom';
	return undefined;
}

export function padSides(layerId: unknown): SilkLayer[] | undefined {
	if (layerId === 1)
		return ['top'];
	if (layerId === 2)
		return ['bottom'];
	if (layerId === 12)
		return ['top', 'bottom'];
	return undefined;
}

export interface PotentialConflict {
	a: CheckedBoxObject;
	b: CheckedBoxObject;
	category: 'silk-to-silk' | 'silk-to-pad-copper';
	sdkBoxDistanceMil: number;
	confirmed: false;
	evidence: 'BOX_NEIGHBOR';
}

export function collectPotentialConflicts(objects: CheckedBoxObject[], minClearance: number): PotentialConflict[] {
	const conflicts: PotentialConflict[] = [];
	const silk = objects.filter(item => item.type === 'text' || item.type === 'designator' || item.type === 'silk-polyline' || item.type === 'silk-line' || item.type === 'silk-arc') as Array<CheckedBoxObject & { type: 'text' | 'designator' | 'silk-polyline' | 'silk-line' | 'silk-arc'; layer: SilkLayer }>;
	const pads = objects.filter(item => item.type === 'standalone-pad' || item.type === 'component-pad') as Array<CheckedBoxObject & { type: 'standalone-pad' | 'component-pad'; layer: SilkLayer | 'multi' }>;
	const pairs = new Set<string>();
	const add = (a: CheckedBoxObject, b: CheckedBoxObject, category: PotentialConflict['category'], sideA: SilkLayer, sideB: SilkLayer) => {
		if (sideA !== sideB || a.id === b.id)
			return;
		const distance = sdkBoxDistanceMil(a.box, b.box);
		if (distance > minClearance)
			return;
		const key = `${category}\u0000${a.id}\u0000${b.id}`;
		if (pairs.has(key))
			return;
		pairs.add(key);
		conflicts.push({ a, b, category, sdkBoxDistanceMil: distance, confirmed: false, evidence: 'BOX_NEIGHBOR' });
	};
	for (let index = 0; index < silk.length; index++) {
		const a = silk[index];
		for (const b of silk.slice(index + 1))
			add(a, b, 'silk-to-silk', a.layer, b.layer);
		for (const pad of pads) {
			const sides = pad.layer === 'multi' ? ['top', 'bottom'] as SilkLayer[] : [pad.layer];
			for (const side of sides)
				add(a, pad, 'silk-to-pad-copper', a.layer, side);
		}
	}
	return conflicts;
}
