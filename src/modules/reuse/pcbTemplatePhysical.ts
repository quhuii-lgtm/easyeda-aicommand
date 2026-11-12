import { cloneJsonData } from './jsonDataClone';

type JsonObject = Record<string, unknown>;
type SourceRecord = { header: JsonObject; data: unknown };
type ParsedPcb = { uuid: string; effective: Map<string, SourceRecord> };

/** Unrounded PAD evidence. Missing or unsupported fields must never be inferred as copper geometry. */
export type PadCopperState = {
	primitiveId?: string | number;
	parentComponentPrimitiveId?: string | number;
	padNumber: string;
	net: string;
	layer?: string | number;
	x?: number;
	y?: number;
	rotation?: number;
	shape?: unknown;
	hole?: unknown;
	specialPad?: unknown;
	holeOffsetX?: number | null;
	holeOffsetY?: number | null;
	holeRotation?: number | null;
	geometryComplete?: boolean;
};

type FootprintOwnerMaster = {
	sourceUid: string;
	sourceComponentId: string;
	legacyComponentId: string;
	master: { rows: unknown[][] };
	associatedRows: unknown[][];
};

export type NativePcbTemplateInstance = {
	placementOperationId: string;
	templateCapture: {
		templateSource: string;
		components: Array<{ sourceUid: string; sourceComponentId: string }>;
		sourcePads?: Array<{ sourceUid: string; sourceComponentId: string; pads: PadCopperState[] }>;
		resources?: unknown[];
		legacyBodyCapture?: { instances: FootprintOwnerMaster[] };
	};
	sourceUidMappings: Array<{ sourceUid: string; actualTargetUid: string }>;
	netMappings: Array<{ sourceNet: string; targetNet: string }>;
};

export type TemplatePhysicalPreflight = {
	ready: boolean;
	unsupportedTypes: string[];
	unsupportedFields: string[];
	instances: number;
	expectedPhysicalRecords: number;
	excludedBoardOutlineRecords: number;
	reason?: string;
};

export type LineGroupNormalization = {
	status: 'conditional_on_final_footprint_verification';
	placementOperationId: string;
	sourceNativeGroupId: string | number;
	targetNativeGroupId: string | number;
	sourceLineCount: number;
	targetLineCount: number;
	sourceLineIds: string[];
	targetLineIds: string[];
	merges: Array<{ sourceLineIds: string[]; targetLineId: string }>;
	padCovered: Array<{ sourceLineId: string; padCoverageAssociationId: string }>;
};

export type TemplatePhysicalVerification = {
	matched: Array<{ placementOperationId: string; type: string; count: number }>;
	missingExpected: Array<{ placementOperationId: string; type: string; signature: string; count: number }>;
	unexplainedAdded: Array<{ type: string; id: string; data: unknown }>;
	changedExisting: Array<{ type: string; id: string; before: unknown; after: unknown }>;
	removedExisting: Array<{ type: string; id: string; data: unknown }>;
	stableTransform: Array<{ placementOperationId: string; rotationDegrees: number; dx: number; dy: number; componentCount: number }>;
	componentAssociationErrors: string[];
	padNetAssociationErrors: string[];
	pouredAssociationErrors: string[];
	hostGeneratedPoured: Array<{ id: string; parentPourId: string; netName: string; layerId: number; fillCount: number; filledCount: number }>;
	physicalAssociationErrors: string[];
	explainedAdded: Array<{ type: string; id: string }>;
	componentGroups: Array<{ placementOperationId: string; sourceUid: string; targetUid: string; targetComponentId: string; sourceNativeGroupId: string | number; targetNativeGroupId: string | number }>;
	verifiedGroups: Array<{ placementOperationId: string; sourceNativeGroupId: string | number; targetNativeGroupId: string | number; proofKind: 'new_group' | 'reused_empty_group'; groupRecord: { type: 'GROUP'; id: string; data: unknown }; memberComponentIds: string[] }>;
	lineGroupNormalizations: LineGroupNormalization[];
	pourNameAllocations: Array<{ placementOperationId: string; sourceId: string; targetId: string; sourceName: string; targetName: string; collisionChain: string[]; order: number; orderBasis: 'source_order' | 'compatible_equal_order'; compatibleSourceOrder: string[] }>;
	lineMergeAssociations: Array<{ placementOperationId: string; sourceIds: string[]; targetIds: string[] }>;
	padCoveredLineAssociations: Array<{ associationId: string; placementOperationId: string; sourceIds: string[]; targetIds: string[]; sourceUid: string; sourcePadPrimitiveId: string | number; targetUid: string; targetPadPrimitiveId: string | number; sourceComponentId: string; targetComponentId: string; padNumber: string; sourceSnapshot: string; targetSnapshot: string; minimumMargin: number }>;
	preflight: TemplatePhysicalPreflight;
	verified: boolean;
};

export type TemplatePhysicalVerificationOptions = {
	actualTargetPads?: Array<{ targetUid: string; componentId: string; pads: PadCopperState[] }>;
};

export function revalidatePadCoveredLineAssociations(
	associations: TemplatePhysicalVerification['padCoveredLineAssociations'],
	placementOperationId: string,
	actualTargetPads: Array<{ targetUid: string; componentId: string; pads: PadCopperState[] }> | undefined,
): { verified: boolean; mismatches: string[] } {
	const relevant = associations.filter(item => item.placementOperationId === placementOperationId);
	if (!relevant.length) return { verified: true, mismatches: [] };
	if (!Array.isArray(actualTargetPads)) return { verified: false, mismatches: ['缺少恢复后的 typed PAD 读回'] };
	const mismatches: string[] = [];
	for (const association of relevant) {
		const groups = actualTargetPads.filter(item => item.targetUid === association.targetUid && item.componentId === association.targetComponentId);
		const matches = groups.flatMap(group => group.pads).filter(pad => pad.primitiveId === association.targetPadPrimitiveId
			&& pad.parentComponentPrimitiveId === association.targetComponentId && pad.padNumber === association.padNumber);
		if (groups.length !== 1 || matches.length !== 1 || stable(matches[0]) !== association.targetSnapshot)
			mismatches.push(`PAD ${association.targetUid}/${String(association.targetPadPrimitiveId)} 恢复后几何、编号、网络、层或绑定变化`);
	}
	return { verified: mismatches.length === 0, mismatches };
}

const SUPPORTED_PHYSICAL_TYPES = new Set(['LINE', 'VIA', 'STRING', 'POUR']);
const SUPPORTED_ASSOCIATION_TYPES = new Set(['COMPONENT', 'ATTR', 'PAD_NET', 'NET', 'RULE_SELECTOR', 'POURED', 'GROUP']);
const KNOWN_NON_PHYSICAL_TYPES = new Set([
	'DOCHEAD', 'CANVAS', 'LAYER', 'LAYER_PHYS', 'ACTIVE_LAYER', 'PRIMITIVE', 'SILK_OPTS',
	'D3_ATTRIBUTE', 'PREFERENCE', 'PANELIZE', 'RULE_TEMPLATE', 'RULE', 'META',
]);
const EPSILON = 1e-4;

function fail(message: string): never { throw new Error(message); }
function isObject(value: unknown): value is JsonObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function recordKey(record: SourceRecord): string { return `${String(record.header.type)}\u0000${String(record.header.id)}`; }

function parsePcbSource(source: unknown, expectedLabel: string): ParsedPcb {
	if (typeof source !== 'string' || !source.trim()) fail(`${expectedLabel} PCB 源码为空`);
	const records: SourceRecord[] = [];
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/[\r\n]+$/, '');
		if (!line.trim()) continue;
		const split = line.indexOf('||');
		if (split < 0) fail(`${expectedLabel} PCB 源码第 ${i + 1} 行缺少 ||`);
		try {
			const header: unknown = JSON.parse(line.slice(0, split));
			let payload = line.slice(split + 2);
			if (payload.endsWith('|')) payload = payload.slice(0, -1);
			const data: unknown = payload === '' ? '' : JSON.parse(payload);
			if (!isObject(header) || typeof header.type !== 'string' || !header.type.trim()) fail(`${expectedLabel} PCB 源码第 ${i + 1} 行 header 无效`);
			if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim())) fail(`${expectedLabel} PCB 源码第 ${i + 1} 行缺少记录 id`);
			if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket))) fail(`${expectedLabel} PCB 源码第 ${i + 1} 行 ticket 无效`);
			records.push({ header, data });
		}
		catch (error) {
			if (error instanceof Error && error.message.startsWith(`${expectedLabel} PCB 源码`)) throw error;
			fail(`${expectedLabel} PCB 源码第 ${i + 1} 行 JSON 无效`);
		}
	}
	const heads = records.filter(record => record.header.type === 'DOCHEAD');
	if (!heads.length || heads.some(record => !isObject(record.data) || record.data.docType !== 'PCB' || typeof record.data.uuid !== 'string'))
		fail(`${expectedLabel} PCB DOCHEAD 身份无效或缺失`);
	const uuid = String((heads[0].data as JsonObject).uuid);
	if (heads.some(record => (record.data as JsonObject).uuid !== uuid)) fail(`${expectedLabel} PCB 含多个不同 DOCHEAD 身份`);
	const highest = new Map<string, SourceRecord>();
	for (const record of records) {
		if (record.header.type === 'DOCHEAD') continue;
		const key = recordKey(record);
		const previous = highest.get(key);
		if (!previous || Number(record.header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) highest.set(key, record);
	}
	const effective = new Map<string, SourceRecord>();
	for (const [key, record] of highest) if (record.data !== '') effective.set(key, record);
	return { uuid, effective };
}

function dataOf(record: SourceRecord): JsonObject | undefined { return isObject(record.data) ? record.data : undefined; }
function allocatePourName(sourceName: string, occupied: Set<string>): { targetName: string; collisionChain: string[] } {
	const initial = sourceName.toUpperCase();
	const collisionChain = [initial];
	if (!occupied.has(initial)) { occupied.add(initial); return { targetName: initial, collisionChain }; }
	const suffix = /^(.*?)(\d+)$/.exec(initial);
	const prefix = suffix ? suffix[1] : initial;
	let number = suffix ? Number.parseInt(suffix[2], 10) + 1 : 1;
	while (!Number.isFinite(number)) fail(`POUR 名称 ${sourceName} 的官方编号无法继续递增`);
	for (;;) {
		const candidate = `${prefix}${number}`;
		if (candidate === `${prefix}Infinity` || !Number.isFinite(number)) fail(`POUR 名称 ${sourceName} 的官方编号无法继续递增`);
		collisionChain.push(candidate);
		if (!occupied.has(candidate)) { occupied.add(candidate); return { targetName: candidate, collisionChain }; }
		const next = number + 1;
		if (!Number.isFinite(next) || next === number) fail(`POUR 名称 ${sourceName} 的官方编号无法继续递增`);
		number = next;
	}
}
function sourceComponentById(source: ParsedPcb, id: string): JsonObject | undefined {
	const record = source.effective.get(`COMPONENT\u0000${id}`);
	return record ? dataOf(record) : undefined;
}
function sourceUid(component: JsonObject | undefined): string | undefined {
	return component && isObject(component.attrs) && typeof component.attrs['Unique ID'] === 'string' ? component.attrs['Unique ID'] : undefined;
}
function numberField(data: JsonObject | undefined, key: string, context: string): number {
	const value = data?.[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context}.${key} 缺少有限数值`);
	return value;
}
function mappedNet(net: unknown, mappings: Map<string, string>, context: string): unknown {
	if (typeof net !== 'string' || net === '') return net;
	if (!mappings.has(net)) fail(`${context} 网络 ${net} 没有明确映射`);
	return mappings.get(net);
}

function physicalExpectedFields(type: string): string[] {
	if (type === 'LINE') return ['startX', 'startY', 'endX', 'endY'];
	if (type === 'VIA') return ['centerX', 'centerY'];
	if (type === 'STRING') return ['x', 'y'];
	return [];
}
function suspiciousGeometryField(field: string): boolean {
	return /^(x|y)\d*$/i.test(field) || /(start|end|center)[xy]$/i.test(field) || /(coord|point|vertex|radius|rotation)/i.test(field);
}
function excludedBoardOutline(record: SourceRecord): boolean {
	const data = dataOf(record);
	return record.header.type === 'POLY' && data?.layerId === 11;
}

type FootprintOwnedPoly = { sourceUid: string; sourceComponentId: string; localId: string };
function footprintOwnedPolys(instance: NativePcbTemplateInstance, source: ParsedPcb): Map<string, FootprintOwnedPoly> {
	const bodyInstances = instance.templateCapture.legacyBodyCapture?.instances;
	const owned = new Map<string, FootprintOwnedPoly>();
	if (!Array.isArray(bodyInstances)) return owned;
	for (const component of instance.templateCapture.components) {
		const sourceData = sourceComponentById(source, component.sourceComponentId);
		if (sourceUid(sourceData) !== component.sourceUid) continue;
		const bodies = bodyInstances.filter(body => body.sourceUid === component.sourceUid && body.sourceComponentId === component.sourceComponentId);
		if (bodies.length !== 1) continue;
		const body = bodies[0];
		if (typeof body.legacyComponentId !== 'string' || !Array.isArray(body.master?.rows) || !Array.isArray(body.associatedRows)) continue;
		const associatedLocalIds = new Set(body.associatedRows.flatMap(row => {
			if (!Array.isArray(row) || row[0] !== 'POLY' || typeof row[1] !== 'string' || !row[1].startsWith(body.legacyComponentId)) return [];
			return [row[1].slice(body.legacyComponentId.length)];
		}));
		const masterLocalIds = new Set(body.master.rows.flatMap(row => row[0] === 'POLY' && typeof row[1] === 'string' ? [row[1]] : []));
		for (const localId of masterLocalIds) {
			if (!associatedLocalIds.has(localId)) continue;
			const key = `POLY\u0000${component.sourceComponentId}${localId}`;
			if (source.effective.has(key)) owned.set(key, { sourceUid: component.sourceUid, sourceComponentId: component.sourceComponentId, localId });
		}
	}
	return owned;
}

function transformPointTuple(values: unknown[], offset: number, transform: Transform, context: string): void {
	const x = values[offset], y = values[offset + 1];
	if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) fail(`${context} 缺少合法坐标对`);
	const radians = transform.rotationDegrees * Math.PI / 180;
	values[offset] = x * Math.cos(radians) - y * Math.sin(radians) + transform.dx;
	values[offset + 1] = x * Math.sin(radians) + y * Math.cos(radians) + transform.dy;
}

/** PCB polygon source grammar from the local SDK declarations; unrecognized commands fail closed. */
function transformPolygonSource(value: unknown, transform: Transform, context: string): unknown[] {
	if (!Array.isArray(value) || value.length < 3) fail(`${context} path 不是有效多边形源数组`);
	const path = cloneJsonData(value) as unknown[];
	const transformFirst = (offset: number) => transformPointTuple(path, offset, transform, context);
	if (path[0] === 'R') {
		if (path.length !== 7 || !path.slice(1).every((item, index) => index === 0 || index === 1 || typeof item === 'number' && Number.isFinite(item)))
			fail(`${context} R path 字段无效`);
		transformFirst(1);
		path[5] = ((Number(path[5]) + transform.rotationDegrees) % 360 + 360) % 360;
		return path;
	}
	if (path[0] === 'CIRCLE') {
		if (path.length !== 4 || !path.slice(1).every(item => typeof item === 'number' && Number.isFinite(item))) fail(`${context} CIRCLE path 字段无效`);
		transformFirst(1);
		return path;
	}
	if (typeof path[0] !== 'number' || typeof path[1] !== 'number') fail(`${context} 需以起点坐标或 R/CIRCLE 模式开头`);
	transformFirst(0);
	let index = 2;
	while (index < path.length) {
		const command = path[index++];
		if (command === 'L') {
			let points = 0;
			while (index < path.length && typeof path[index] === 'number') {
				if (index + 1 >= path.length || typeof path[index + 1] !== 'number') fail(`${context} L path 坐标对不完整`);
				transformPointTuple(path, index, transform, context);
				index += 2;
				points++;
			}
			if (!points) fail(`${context} L path 缺少终点坐标`);
		}
		else if (command === 'ARC' || command === 'CARC') {
			if (index + 2 >= path.length || typeof path[index] !== 'number' || !Number.isFinite(path[index])) fail(`${context} ${command} path 缺少圆弧角或终点坐标`);
			index++;
			transformPointTuple(path, index, transform, context);
			index += 2;
		}
		else if (command === 'C') {
			if (index + 5 >= path.length) fail(`${context} C path 缺少贝塞尔控制点`);
			transformPointTuple(path, index, transform, context);
			transformPointTuple(path, index + 2, transform, context);
			transformPointTuple(path, index + 4, transform, context);
			index += 6;
		}
		else fail(`${context} path 命令不支持：${String(command)}`);
	}
	return path;
}

function transformComplexPath(value: unknown, transform: Transform, context: string): unknown {
	if (!Array.isArray(value) || value.length === 0) fail(`${context} path 必须是非空复杂多边形数组`);
	if (value.some(item => typeof item === 'string' || typeof item === 'number')) return transformPolygonSource(value, transform, context);
	return value.map((path, index) => transformPolygonSource(path, transform, `${context}.path[${index}]`));
}

export function transformFootprintOwnedPolygonPath(value: unknown, transform: Pick<Transform, 'rotationDegrees' | 'dx' | 'dy'>, context = 'owned POLY'): unknown {
	return transformComplexPath(value, { ...transform, componentCount: 0 }, context);
}

function validatePolygonSource(value: unknown, context: string): void {
	transformPolygonSource(value, { rotationDegrees: 0, dx: 0, dy: 0, componentCount: 0 }, context);
}

function pouredParentId(record: SourceRecord): string | undefined {
	try {
		const id: unknown = JSON.parse(String(record.header.id));
		return Array.isArray(id) && id[0] === 'POURED' && typeof id[1] === 'string' ? id[1] : undefined;
	}
	catch { return undefined; }
}

function validatePouredPayload(record: SourceRecord, pourId: string): { fillCount: number; filledCount: number } {
	const data = dataOf(record);
	if (!data || !Array.isArray(data.pourFill)) fail(`POURED ${record.header.id} 缺少合法 pourFill 数组`);
	let filledCount = 0;
	for (let index = 0; index < data.pourFill.length; index++) {
		const fill = data.pourFill[index];
		if (!isObject(fill) || typeof fill.id !== 'string' || typeof fill.fill !== 'boolean'
			|| typeof fill.strokeWidth !== 'number' || !Number.isFinite(fill.strokeWidth) || fill.strokeWidth < 0)
			fail(`POURED ${record.header.id} 的 fill[${index}] 属性无效`);
		if (fill.fill) {
			validateComplexPath(fill.path, `POURED ${record.header.id}.pourFill[${index}]`);
			filledCount++;
		}
		else if (fill.path !== undefined) validateComplexPath(fill.path, `POURED ${record.header.id}.pourFill[${index}]`);
	}
	return { fillCount: data.pourFill.length, filledCount };
}

function validateComplexPath(value: unknown, context: string): void {
	if (!Array.isArray(value) || value.length === 0) fail(`${context}.path 必须是非空复杂多边形数组`);
	if (value.some(item => typeof item === 'string' || typeof item === 'number')) { validatePolygonSource(value, context); return; }
	value.forEach((path, index) => validatePolygonSource(path, `${context}.path[${index}]`));
}

function validateInstance(instance: NativePcbTemplateInstance, index: number): ParsedPcb {
	if (!instance || typeof instance.placementOperationId !== 'string' || !instance.placementOperationId.trim()) fail(`templateInstances[${index}] 缺少 placementOperationId`);
	if (!instance.templateCapture || !Array.isArray(instance.templateCapture.components)) fail(`templateInstances[${index}] 缺少已捕获模板组件`);
	if (!Array.isArray(instance.sourceUidMappings) || !Array.isArray(instance.netMappings)) fail(`templateInstances[${index}] 缺少 UID/net 映射数组`);
	return parsePcbSource(instance.templateCapture.templateSource, `模板 ${instance.placementOperationId}`);
}

function inspectTemplates(instances: NativePcbTemplateInstance[]): { preflight: TemplatePhysicalPreflight; sources: ParsedPcb[] } {
	if (!Array.isArray(instances) || instances.length === 0) fail('templateInstances 必须包含至少一个已确认放置实例');
	const sources = instances.map(validateInstance);
	const unsupportedTypes = new Set<string>();
	const unsupportedFields = new Set<string>();
	let expectedPhysicalRecords = 0;
	let excludedBoardOutlineRecords = 0;
	for (let index = 0; index < instances.length; index++) {
		const source = sources[index];
		const instance = instances[index];
		const ownedPolys = footprintOwnedPolys(instance, source);
		let outlineCount = 0;
		const sourceUids = new Set(instance.templateCapture.components.map(item => item.sourceUid));
		const targetUids = new Set<string>();
		for (const mapping of instance.sourceUidMappings) {
			if (!sourceUids.has(mapping.sourceUid)) unsupportedFields.add(`sourceUidMappings.${mapping.sourceUid}:missing-template-component`);
			if (targetUids.has(mapping.actualTargetUid)) unsupportedFields.add(`sourceUidMappings.${mapping.actualTargetUid}:duplicate-target-uid`);
			targetUids.add(mapping.actualTargetUid);
		}
		for (const sourceUidValue of sourceUids) if (!instance.sourceUidMappings.some(mapping => mapping.sourceUid === sourceUidValue))
			unsupportedFields.add(`sourceUidMappings.${sourceUidValue}:missing-target-uid`);
		const mappedNets = new Set(instance.netMappings.map(item => item.sourceNet));
		if (mappedNets.size !== instance.netMappings.length) unsupportedFields.add(`netMappings.${instance.placementOperationId}:duplicate-source-net`);
		const targetNetNames = new Set(instance.netMappings.map(item => item.targetNet));
		if (targetNetNames.size !== instance.netMappings.length) unsupportedFields.add(`netMappings.${instance.placementOperationId}:multiple-source-nets-collapse-to-one-target`);
		for (const record of source.effective.values()) {
			const type = String(record.header.type);
			if (type === 'GROUP') {
				if (!dataOf(record)) unsupportedFields.add(`GROUP.${String(record.header.id)}:required-object-data`);
				continue;
			}
			if (type === 'POLY') {
				if (!excludedBoardOutline(record) && !ownedPolys.has(recordKey(record))) { unsupportedTypes.add(type); continue; }
				expectedPhysicalRecords++;
				if (excludedBoardOutline(record)) outlineCount++;
				const data = dataOf(record);
				if (!data || typeof data.width !== 'number' || !Number.isFinite(data.width) || typeof data.locked !== 'boolean'
					|| typeof data.netName !== 'string' || typeof data.layerId !== 'number') unsupportedFields.add(`POLY.${String(record.header.id)}:required-fields`);
				try { validateComplexPath(data?.path, `POLY ${record.header.id}`); }
				catch (error) { unsupportedFields.add(`POLY.path:${error instanceof Error ? error.message : String(error)}`); }
				continue;
			}
			if (type === 'POUR') {
				expectedPhysicalRecords++;
				const data = dataOf(record);
				if (!data) { unsupportedFields.add('POUR.*'); continue; }
				if (typeof data.netName !== 'string') unsupportedFields.add('POUR.netName');
				else if (data.netName && !mappedNets.has(data.netName)) unsupportedFields.add(`POUR.netName:${data.netName}:missing-net-mapping`);
				if (typeof data.layerId !== 'number') unsupportedFields.add('POUR.layerId');
				if (typeof data.width !== 'number' || !Number.isFinite(data.width)) unsupportedFields.add('POUR.width');
				if (typeof data.order !== 'number' || !Number.isFinite(data.order)) unsupportedFields.add('POUR.order');
				try { validateComplexPath(data.path, `POUR ${record.header.id}`); }
				catch (error) { unsupportedFields.add(`POUR.path:${error instanceof Error ? error.message : String(error)}`); }
				continue;
			}
			if (type === 'POURED') {
				const parentId = pouredParentId(record);
				const parent = parentId ? source.effective.get(`POUR\u0000${parentId}`) : undefined;
				if (!parent || !dataOf(parent) || typeof dataOf(parent)!.netName !== 'string' || typeof dataOf(parent)!.layerId !== 'number')
					unsupportedFields.add(`POURED.parent:${String(record.header.id)}:missing-valid-POUR-net-layer`);
				try { validatePouredPayload(record, parentId ?? ''); }
				catch (error) { unsupportedFields.add(`POURED.payload:${error instanceof Error ? error.message : String(error)}`); }
				continue;
			}
			if (SUPPORTED_PHYSICAL_TYPES.has(type)) {
				expectedPhysicalRecords++;
				const data = dataOf(record);
				if (!data) { unsupportedFields.add(`${type}.*`); continue; }
				for (const key of physicalExpectedFields(type)) if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) unsupportedFields.add(`${type}.${key}`);
				for (const key of Object.keys(data)) if (suspiciousGeometryField(key) && !physicalExpectedFields(type).includes(key)) unsupportedFields.add(`${type}.${key}`);
				if (type !== 'STRING') {
					if (typeof data.netName !== 'string') unsupportedFields.add(`${type}.netName`);
					else if (data.netName && !mappedNets.has(data.netName)) unsupportedFields.add(`${type}.netName:${data.netName}:missing-net-mapping`);
				}
				if (type === 'VIA' ? typeof data.viaType !== 'string' : typeof data.layerId !== 'number')
					unsupportedFields.add(`${type}.${type === 'VIA' ? 'viaType' : 'layerId'}`);
			}
			else if (!SUPPORTED_ASSOCIATION_TYPES.has(type) && !KNOWN_NON_PHYSICAL_TYPES.has(type)) unsupportedTypes.add(type);
		}
		if (outlineCount > 1) unsupportedFields.add(`POLY.${instance.placementOperationId}:multiple-template-outlines`);
	}
	const preflight: TemplatePhysicalPreflight = {
		ready: unsupportedTypes.size === 0 && unsupportedFields.size === 0,
		unsupportedTypes: [...unsupportedTypes].sort(),
		unsupportedFields: [...unsupportedFields].sort(),
		instances: instances.length,
		expectedPhysicalRecords,
		excludedBoardOutlineRecords,
		...((unsupportedTypes.size || unsupportedFields.size) ? { reason: '模板含当前物理解释器不能完整平移或匹配的有效 PCB 记录' } : {}),
	};
	return { preflight, sources };
}

export function preflightTemplatePhysical(instances: NativePcbTemplateInstance[]): TemplatePhysicalPreflight {
	return inspectTemplates(instances).preflight;
}

type Transform = { rotationDegrees: number; dx: number; dy: number; componentCount: number; coordinateScale?: number };
function deriveTransform(instance: NativePcbTemplateInstance, source: ParsedPcb, target: ParsedPcb): { transform?: Transform; errors: string[] } {
	const errors: string[] = [];
	const sourceToTargetUid = new Map<string, string>();
	for (const mapping of instance.sourceUidMappings) {
		if (!mapping || typeof mapping.sourceUid !== 'string' || typeof mapping.actualTargetUid !== 'string'
			|| sourceToTargetUid.has(mapping.sourceUid) || [...sourceToTargetUid.values()].includes(mapping.actualTargetUid)) errors.push('sourceUidMappings 必须双向唯一');
		else sourceToTargetUid.set(mapping.sourceUid, mapping.actualTargetUid);
	}
	const templateComponentByUid = new Map<string, { id: string; data: JsonObject }>();
	for (const item of instance.templateCapture.components) {
		const data = sourceComponentById(source, item.sourceComponentId);
		if (!data || sourceUid(data) !== item.sourceUid || templateComponentByUid.has(item.sourceUid)) errors.push(`模板组件身份不符或重复：${item.sourceUid}`);
		else templateComponentByUid.set(item.sourceUid, { id: item.sourceComponentId, data });
	}
	const actualComponents = [...target.effective.values()].filter(record => record.header.type === 'COMPONENT' && dataOf(record));
	const points: Array<{ sx: number; sy: number; tx: number; ty: number; rotation: number }> = [];
	for (const [sourceUidValue, targetUid] of sourceToTargetUid) {
		const templateComponent = templateComponentByUid.get(sourceUidValue);
		const targetMatches = actualComponents.filter(record => sourceUid(dataOf(record)) === targetUid);
		if (!templateComponent || targetMatches.length !== 1) { errors.push(`模板/目标器件对应不唯一：${sourceUidValue} → ${targetUid}`); continue; }
		const sourceData = templateComponent.data;
		const targetData = dataOf(targetMatches[0])!;
		const sx = Number(sourceData.x), sy = Number(sourceData.y), tx = Number(targetData.x), ty = Number(targetData.y);
		const sa = Number(sourceData.angle ?? 0), ta = Number(targetData.angle ?? 0);
		if (![sx, sy, tx, ty, sa, ta].every(Number.isFinite)) { errors.push(`模板/目标器件坐标或角度无效：${sourceUidValue}`); continue; }
		points.push({ sx, sy, tx, ty, rotation: ((ta - sa) % 360 + 360) % 360 });
	}
	if (!points.length) return { errors: [...errors, '没有可用于推导 PCB 刚体变换的匹配器件'] };
	const rotationDegrees = points[0].rotation;
	const radians = rotationDegrees * Math.PI / 180;
	const dx = points[0].tx - (points[0].sx * Math.cos(radians) - points[0].sy * Math.sin(radians));
	const dy = points[0].ty - (points[0].sx * Math.sin(radians) + points[0].sy * Math.cos(radians));
	for (const point of points) {
		const expectedX = point.sx * Math.cos(radians) - point.sy * Math.sin(radians) + dx;
		const expectedY = point.sx * Math.sin(radians) + point.sy * Math.cos(radians) + dy;
		if (point.rotation !== rotationDegrees || Math.abs(point.tx - expectedX) > EPSILON || Math.abs(point.ty - expectedY) > EPSILON)
			errors.push('模板组件不能由同一刚体变换解释');
	}
	return errors.length ? { errors } : { transform: { rotationDegrees, dx, dy, componentCount: points.length }, errors };
}

function transformPoint(data: JsonObject, xKey: string, yKey: string, transform: Transform): void {
	const radians = transform.rotationDegrees * Math.PI / 180;
	const x = numberField(data, xKey, '模板物理对象');
	const y = numberField(data, yKey, '模板物理对象');
	data[xKey] = x * Math.cos(radians) - y * Math.sin(radians) + transform.dx;
	data[yKey] = x * Math.sin(radians) + y * Math.cos(radians) + transform.dy;
}
type NativeGroupId = string | number;
const GROUP_REFERENCE_TYPES = new Set(['COMPONENT', 'LINE', 'VIA', 'STRING', 'POUR', 'POLY']);
function groupReferences(records: Iterable<SourceRecord>, groupId: NativeGroupId): { matching: SourceRecord[]; unknown: SourceRecord[] } {
	const key = groupIdKey(groupId);
	const matching: SourceRecord[] = [];
	const unknown: SourceRecord[] = [];
	for (const record of records) {
		const data = dataOf(record);
		if (!data || !Object.hasOwn(data, 'groupId')) continue;
		const referencedKey = groupIdKey(data.groupId);
		if (referencedKey === undefined) { unknown.push(record); continue; }
		if (referencedKey !== key) continue;
		if (GROUP_REFERENCE_TYPES.has(String(record.header.type))) matching.push(record);
		else unknown.push(record);
	}
	return { matching, unknown };
}
function nonzeroGroupId(value: NativeGroupId): boolean { return value !== 0 && value !== '0' && value !== ''; }
type GroupBindingResult = {
	groupIds: Map<string, NativeGroupId>;
	componentGroups: TemplatePhysicalVerification['componentGroups'];
	verifiedGroups: TemplatePhysicalVerification['verifiedGroups'];
	errors: string[];
};
function groupIdKey(value: unknown): string | undefined {
	return typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ? `${typeof value}:${String(value)}` : undefined;
}
function deriveGroupBindings(instance: NativePcbTemplateInstance, source: ParsedPcb, before: ParsedPcb, after: ParsedPcb,
	instances: NativePcbTemplateInstance[], sources: ParsedPcb[]): GroupBindingResult {
	const errors: string[] = [];
	const groupIds = new Map<string, NativeGroupId>();
	const componentGroups: GroupBindingResult['componentGroups'] = [];
	const verifiedGroups: GroupBindingResult['verifiedGroups'] = [];
	const sourceUidToTargetUid = new Map(instance.sourceUidMappings.map(mapping => [mapping.sourceUid, mapping.actualTargetUid]));
	const sourceGroupMembers = new Map<string, { sourceGroupId: NativeGroupId; targetGroupId: NativeGroupId; sourceUid: string; targetUid: string; targetComponentId: string }[]>();
	const targetByUid = new Map<string, SourceRecord[]>();
	for (const record of after.effective.values()) {
		if (record.header.type !== 'COMPONENT') continue;
		const uid = sourceUid(dataOf(record));
		if (uid) targetByUid.set(uid, [...(targetByUid.get(uid) ?? []), record]);
	}
	for (const component of instance.templateCapture.components) {
		const sourceRecord = source.effective.get(`COMPONENT\u0000${component.sourceComponentId}`);
		const sourceData = sourceRecord ? dataOf(sourceRecord) : undefined;
		const targetUid = sourceUidToTargetUid.get(component.sourceUid);
		const targetMatches = targetUid ? targetByUid.get(targetUid) ?? [] : [];
		const targetRecord = targetMatches[0];
		const targetData = targetRecord ? dataOf(targetRecord) : undefined;
		const sourceGroupId = sourceData?.groupId;
		const targetGroupId = targetData?.groupId;
		if (!sourceData || sourceUid(sourceData) !== component.sourceUid || !targetUid || targetMatches.length !== 1) {
			errors.push(`${instance.placementOperationId}: GROUP 组件/组映射不完整：${component.sourceUid}`);
			continue;
		}
		if (sourceGroupId === undefined && targetGroupId === undefined) continue;
		if (groupIdKey(sourceGroupId) === undefined || groupIdKey(targetGroupId) === undefined) {
			errors.push(`${instance.placementOperationId}: GROUP 源/目标组字段不对称：${component.sourceUid}`);
			continue;
		}
		const key = groupIdKey(sourceGroupId)!;
		const existingTarget = groupIds.get(key);
		if (existingTarget !== undefined && existingTarget !== targetGroupId)
			errors.push(`${instance.placementOperationId}: 同一来源组映射到多个目标组：${String(sourceGroupId)}`);
		else groupIds.set(key, targetGroupId as NativeGroupId);
		sourceGroupMembers.set(key, [...(sourceGroupMembers.get(key) ?? []), {
			sourceGroupId: sourceGroupId as NativeGroupId, targetGroupId: targetGroupId as NativeGroupId,
			sourceUid: component.sourceUid, targetUid, targetComponentId: String(targetRecord.header.id),
		}]);
	}
	const seenTargetGroups = new Set<string>();
	for (const [key, members] of sourceGroupMembers) {
		const targetGroupId = members[0].targetGroupId;
		const targetKey = groupIdKey(targetGroupId)!;
		let membershipValid = !seenTargetGroups.has(targetKey);
		if (!membershipValid) errors.push(`${instance.placementOperationId}: 不同来源组映射到同一目标组：${String(targetGroupId)}`);
		seenTargetGroups.add(targetKey);
		const groupRecord = after.effective.get(`GROUP\u0000${String(targetGroupId)}`);
		const priorGroupRecord = before.effective.get(`GROUP\u0000${String(targetGroupId)}`);
		const beforeReferences = groupReferences(before.effective.values(), targetGroupId);
		const afterMembers = [...after.effective.values()].filter(record => record.header.type === 'COMPONENT' && dataOf(record)?.groupId === targetGroupId);
		const expectedIds = members.map(member => member.targetComponentId).sort();
		const actualIds = afterMembers.map(record => String(record.header.id)).sort();
		if (stable(expectedIds) !== stable(actualIds)) {
			errors.push(`${instance.placementOperationId}: 目标组含旧组件或其他实例成员：${String(targetGroupId)}`);
			membershipValid = false;
		}
		const sourceGroupRecord = source.effective.get(`GROUP\u0000${String(members[0].sourceGroupId)}`);
		const groupDataMatches = Boolean(groupRecord && priorGroupRecord && sourceGroupRecord
			&& String(groupRecord.header.id) === String(targetGroupId)
			&& String(priorGroupRecord.header.id) === String(targetGroupId)
			&& String(sourceGroupRecord.header.id) === String(members[0].sourceGroupId)
			&& stable(groupRecord.data) === stable(priorGroupRecord.data)
			&& stable(groupRecord.data) === stable(sourceGroupRecord.data));
		const baselineEmpty = beforeReferences.matching.length === 0 && beforeReferences.unknown.length === 0;
		const hasNewGroupEvidence = Boolean(groupRecord && !priorGroupRecord && baselineEmpty && dataOf(groupRecord) && nonzeroGroupId(targetGroupId));
		const hasReusableEmptyGroupEvidence = Boolean(members[0].sourceGroupId === targetGroupId && nonzeroGroupId(targetGroupId)
			&& groupDataMatches && baselineEmpty);
		if (beforeReferences.unknown.length) {
			errors.push(`${instance.placementOperationId}: 无法判定既有记录是否引用组 ${String(targetGroupId)}`);
			membershipValid = false;
		}
		if (hasNewGroupEvidence || hasReusableEmptyGroupEvidence) {
			if (hasReusableEmptyGroupEvidence && groupReferences(source.effective.values(), members[0].sourceGroupId).unknown.length) {
				errors.push(`${instance.placementOperationId}: 模板含无法确认归属的组 ${String(members[0].sourceGroupId)} 记录`);
				membershipValid = false;
			}
			if (instances.some((other, otherIndex) => other !== instance && sources[otherIndex].effective.size > 0
				&& other.sourceUidMappings.some(mapping => {
					const matched = targetByUid.get(mapping.actualTargetUid) ?? [];
					return matched.some(record => dataOf(record)?.groupId === targetGroupId);
			}))) {
				errors.push(`${instance.placementOperationId}: 目标组成员与另一模板实例重叠`);
				membershipValid = false;
			}
			if (membershipValid) {
				verifiedGroups.push({ placementOperationId: instance.placementOperationId,
					sourceNativeGroupId: members[0].sourceGroupId, targetNativeGroupId: targetGroupId,
					proofKind: hasReusableEmptyGroupEvidence ? 'reused_empty_group' : 'new_group',
					groupRecord: { type: 'GROUP', id: String(groupRecord!.header.id), data: groupRecord!.data }, memberComponentIds: expectedIds });
				componentGroups.push(...members.map(member => ({ placementOperationId: instance.placementOperationId,
					sourceUid: member.sourceUid, targetUid: member.targetUid, targetComponentId: member.targetComponentId,
					sourceNativeGroupId: member.sourceGroupId, targetNativeGroupId: member.targetGroupId })));
			}
		}
		else if (!hasNewGroupEvidence && !hasReusableEmptyGroupEvidence && (groupRecord || priorGroupRecord || beforeReferences.matching.length || targetGroupId !== members[0].sourceGroupId))
			errors.push(`${instance.placementOperationId}: 目标组缺少本次新增 GROUP 证据：${String(targetGroupId)}`);
	}
	return { groupIds, componentGroups, verifiedGroups, errors };
}

function coordinateNear(expected: number, actual: number, transform: Transform): boolean {
	const scale = Math.max(1, Math.abs(expected), Math.abs(actual), Math.abs(transform.dx), Math.abs(transform.dy), transform.coordinateScale ?? 0);
	return Math.abs(expected - actual) <= Number.EPSILON * 16 * scale;
}
function polygonCoordinateScale(path: unknown[]): number {
	const scalePair = (index: number) => typeof path[index] === 'number' && Number.isFinite(path[index])
		&& typeof path[index + 1] === 'number' && Number.isFinite(path[index + 1])
		? Math.max(Math.abs(path[index] as number), Math.abs(path[index + 1] as number)) : 0;
	if (path[0] === 'R' || path[0] === 'CIRCLE') return scalePair(1);
	if (typeof path[0] !== 'number' || typeof path[1] !== 'number') return 0;
	let scale = scalePair(0);
	let index = 2;
	while (index < path.length) {
		const command = path[index++];
		if (command === 'L') {
			while (index < path.length && typeof path[index] === 'number') {
				scale = Math.max(scale, scalePair(index));
				index += 2;
			}
		}
		else if (command === 'ARC' || command === 'CARC') {
			index++;
			scale = Math.max(scale, scalePair(index));
			index += 2;
		}
		else if (command === 'C') {
			for (let point = 0; point < 3; point++) scale = Math.max(scale, scalePair(index + point * 2));
			index += 6;
		}
		else break;
	}
	return scale;
}
function polygonPathCoordinateScale(value: unknown): number {
	if (!Array.isArray(value)) return 0;
	if (typeof value[0] === 'string' || typeof value[0] === 'number') return polygonCoordinateScale(value);
	return value.reduce((scale, path) => Array.isArray(path) ? Math.max(scale, polygonCoordinateScale(path)) : scale, 0);
}
function geometryCoordinateScale(value: unknown, key = ''): number {
	if (key === 'path') return polygonPathCoordinateScale(value);
	if (typeof value === 'number' && Number.isFinite(value) && ['x', 'y', 'startX', 'startY', 'endX', 'endY', 'centerX', 'centerY'].includes(key)) return Math.abs(value);
	if (Array.isArray(value)) return value.reduce((scale, item) => Math.max(scale, geometryCoordinateScale(item, key)), 0);
	if (isObject(value)) return Object.entries(value).reduce((scale, [property, item]) => Math.max(scale, geometryCoordinateScale(item, property)), 0);
	return 0;
}
function polygonPathMatches(expected: unknown[], actual: unknown[], transform: Transform): boolean {
	if (expected.length !== actual.length || expected[0] !== actual[0]) return false;
	const point = (index: number) => typeof expected[index] === 'number' && typeof actual[index] === 'number'
		&& coordinateNear(expected[index] as number, actual[index] as number, transform);
	if (expected[0] === 'R') return expected.length === 7 && point(1) && point(2)
		&& expected.slice(3).every((value, index) => Object.is(value, actual[index + 3]));
	if (expected[0] === 'CIRCLE') return expected.length === 4 && point(1) && point(2) && Object.is(expected[3], actual[3]);
	if (!point(0) || !point(1)) return false;
	let index = 2;
	while (index < expected.length) {
		const command = expected[index];
		if (command !== actual[index]) return false;
		index++;
		if (command === 'L') {
			let points = 0;
			while (index < expected.length && typeof expected[index] === 'number') {
				if (!point(index) || !point(index + 1)) return false;
				index += 2; points++;
			}
			if (!points) return false;
		}
		else if (command === 'ARC' || command === 'CARC') {
			if (!Object.is(expected[index], actual[index]) || !point(index + 1) || !point(index + 2)) return false;
			index += 3;
		}
		else if (command === 'C') {
			for (let pointIndex = 0; pointIndex < 3; pointIndex++) if (!point(index + pointIndex * 2) || !point(index + pointIndex * 2 + 1)) return false;
			index += 6;
		}
		else return false;
	}
	return true;
}
function dataMatches(expected: unknown, actual: unknown, transform: Transform, key = '', ignorePourOrder = false, ignorePourName = false): boolean {
	if (key === 'path') {
		if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
		if (expected.some(item => typeof item === 'string' || typeof item === 'number')) return polygonPathMatches(expected, actual, transform);
		return expected.every((path, index) => Array.isArray(path) && Array.isArray(actual[index]) && polygonPathMatches(path, actual[index], transform));
	}
	if (typeof expected === 'number' && typeof actual === 'number' && ['startX', 'startY', 'endX', 'endY', 'centerX', 'centerY', 'x', 'y'].includes(key))
		return coordinateNear(expected, actual, transform);
	if (Array.isArray(expected) || Array.isArray(actual))
		return Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => dataMatches(value, actual[index], transform, key, ignorePourOrder, ignorePourName));
	if (isObject(expected) || isObject(actual)) {
		if (!isObject(expected) || !isObject(actual)) return false;
		const ignored = (property: string) => ignorePourOrder && property === 'order' || ignorePourName && key === '' && property === 'name';
		const expectedKeys = Object.keys(expected).filter(property => !ignored(property)).sort();
		const actualKeys = Object.keys(actual).filter(property => !ignored(property)).sort();
		return stable(expectedKeys) === stable(actualKeys) && expectedKeys.every(property => dataMatches(expected[property], actual[property], transform, property, ignorePourOrder, ignorePourName));
	}
	return Object.is(expected, actual);
}
function transformedPhysicalData(record: SourceRecord, transform: Transform, nets: Map<string, string>, groupId?: NativeGroupId): JsonObject {
	const type = String(record.header.type);
	const data = cloneJsonData(dataOf(record)!);
	if (type === 'POUR' || type === 'POLY') data.path = transformComplexPath(data.path, transform, `${type} ${record.header.id}`);
	else if (type === 'LINE') {
		transformPoint(data, 'startX', 'startY', transform);
		transformPoint(data, 'endX', 'endY', transform);
		if (Number(data.startX) > Number(data.endX) || Number(data.startX) === Number(data.endX) && Number(data.startY) > Number(data.endY)) {
			const x = data.startX, y = data.startY;
			data.startX = data.endX; data.startY = data.endY; data.endX = x; data.endY = y;
		}
	}
	else if (type === 'VIA') transformPoint(data, 'centerX', 'centerY', transform);
	else if (type === 'STRING') {
		transformPoint(data, 'x', 'y', transform);
		data.angle = ((Number(data.angle ?? 0) + transform.rotationDegrees) % 360 + 360) % 360;
	}
	if (type === 'STRING') data.angle = ((Number(data.angle ?? 0) % 360) + 360) % 360;
	if (Object.hasOwn(data, 'netName')) data.netName = mappedNet(data.netName, nets, `${type}/${record.header.id}`);
	if (groupId !== undefined && Object.hasOwn(data, 'groupId')) data.groupId = groupId;
	delete data.zIndex;
	return data;
}
function targetPhysicalData(record: SourceRecord): JsonObject {
	const data = cloneJsonData(dataOf(record)!);
	if (record.header.type === 'LINE' && (Number(data.startX) > Number(data.endX) || Number(data.startX) === Number(data.endX) && Number(data.startY) > Number(data.endY))) {
		const x = data.startX, y = data.startY;
		data.startX = data.endX; data.startY = data.endY; data.endX = x; data.endY = y;
	}
	if (record.header.type === 'STRING') data.angle = ((Number(data.angle ?? 0) % 360) + 360) % 360;
	delete data.zIndex;
	return data;
}

type LinePoint = { x: number; y: number };
function lineEndpoints(data: JsonObject): [LinePoint, LinePoint] | undefined {
	const values = [data.startX, data.startY, data.endX, data.endY];
	if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return undefined;
	const first = { x: Number(data.startX), y: Number(data.startY) };
	const second = { x: Number(data.endX), y: Number(data.endY) };
	return Math.hypot(second.x - first.x, second.y - first.y) > 0 ? [first, second] : undefined;
}
function lineNonCoordinateSignature(data: JsonObject): string {
	const other = Object.fromEntries(Object.entries(data).filter(([key]) => !['startX', 'startY', 'endX', 'endY'].includes(key)));
	return stable(other);
}
function lineCoordinateTolerance(points: LinePoint[], transform: Transform): number {
	const scale = Math.max(1, Math.abs(transform.dx), Math.abs(transform.dy), transform.coordinateScale ?? 0,
		...points.flatMap(point => [Math.abs(point.x), Math.abs(point.y)]));
	return Number.EPSILON * 16 * scale;
}
function sourceLineChainForTarget(
	target: JsonObject,
	transform: Transform,
	sources: Array<{ index: number; data: JsonObject; rawData: JsonObject; transform: Transform }>,
): number[] | undefined {
	const targetLine = lineEndpoints(target);
	if (!targetLine) return undefined;
	const [origin, finish] = targetLine;
	const dx = finish.x - origin.x, dy = finish.y - origin.y;
	const length = Math.hypot(dx, dy);
	const tolerance = lineCoordinateTolerance([origin, finish], transform);
	const targetSignature = lineNonCoordinateSignature(target);
	const intervals: Array<{ index: number; start: number; end: number }> = [];
	for (const source of sources) {
		if (lineNonCoordinateSignature(source.data) !== targetSignature) continue;
		const endpoints = lineEndpoints(source.data);
		if (!endpoints) continue;
		const projected = endpoints.map(point => {
			const px = point.x - origin.x, py = point.y - origin.y;
			return { along: (px * dx + py * dy) / length, away: Math.abs(px * dy - py * dx) / length };
		});
		if (projected.some(point => point.away > tolerance)) continue;
		const start = Math.min(projected[0].along, projected[1].along);
		const end = Math.max(projected[0].along, projected[1].along);
		if (start < -tolerance || end > length + tolerance || end - start <= tolerance) continue;
		intervals.push({ index: source.index, start, end });
	}
	if (intervals.length < 2) return undefined;
	intervals.sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
	if (Math.abs(intervals[0].start) > tolerance) return undefined;
	let covered = intervals[0].end;
	for (let index = 1; index < intervals.length; index++) {
		const item = intervals[index];
		const gap = item.start - covered;
		const priorSource = sources.find(source => source.index === intervals[index - 1].index);
		const nextSource = sources.find(source => source.index === item.index);
		const priorEndpoints = priorSource && lineEndpoints(priorSource.rawData);
		const nextEndpoints = nextSource && lineEndpoints(nextSource.rawData);
		const sharedSourceEndpoint = Boolean(priorEndpoints && nextEndpoints && priorEndpoints.some(left =>
			nextEndpoints.some(right => left.x === right.x && left.y === right.y)));
		// Projection tolerance is only for matching transformed source ends to the target LINE.
		// Source topology itself requires the original segments to share the exact same endpoint.
		if (!sharedSourceEndpoint || Math.abs(gap) > tolerance || item.end <= covered + tolerance) return undefined;
		covered = item.end;
	}
	if (Math.abs(covered - length) > tolerance) return undefined;
	return intervals.map(item => item.index);
}

function normalizeAngle(angle: number): number { return ((angle % 360) + 360) % 360; }
function supportedRectPad(pad: PadCopperState): { width: number; height: number } | undefined {
	if (pad.geometryComplete !== true || pad.primitiveId === undefined || pad.parentComponentPrimitiveId === undefined
		|| typeof pad.layer !== 'number' && typeof pad.layer !== 'string'
		|| ![pad.x, pad.y, pad.rotation].every(value => typeof value === 'number' && Number.isFinite(value))
		|| pad.hole !== null || pad.specialPad !== null
		|| typeof pad.holeOffsetX !== 'number' || pad.holeOffsetX !== 0 || typeof pad.holeOffsetY !== 'number' || pad.holeOffsetY !== 0
		|| typeof pad.holeRotation !== 'number' || pad.holeRotation !== 0
		|| !Array.isArray(pad.shape) || pad.shape.length !== 4 || pad.shape[0] !== 'RECT'
		|| !Number.isFinite(pad.shape[1]) || !Number.isFinite(pad.shape[2]) || pad.shape[1] <= 0 || pad.shape[2] <= 0 || pad.shape[3] !== 0) return undefined;
	return { width: pad.shape[1] as number, height: pad.shape[2] as number };
}
function padCoordinateTolerance(...values: number[]): number {
	return Number.EPSILON * 16 * Math.max(1, ...values.map(Math.abs));
}
function capsuleMargin(line: JsonObject, pad: PadCopperState, transform?: Transform): number | undefined {
	const geometry = supportedRectPad(pad);
	const endpoints = lineEndpoints(line);
	const width = line.width;
	if (!geometry || !endpoints || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
		|| typeof pad.x !== 'number' || typeof pad.y !== 'number' || typeof pad.rotation !== 'number') return undefined;
	const radius = width / 2;
	const theta = pad.rotation * Math.PI / 180;
	const points = endpoints.map(point => {
		const x = transform ? point.x * Math.cos(transform.rotationDegrees * Math.PI / 180) - point.y * Math.sin(transform.rotationDegrees * Math.PI / 180) + transform.dx : point.x;
		const y = transform ? point.x * Math.sin(transform.rotationDegrees * Math.PI / 180) + point.y * Math.cos(transform.rotationDegrees * Math.PI / 180) + transform.dy : point.y;
		const dx = x - pad.x!, dy = y - pad.y!;
		return { x: dx * Math.cos(theta) + dy * Math.sin(theta), y: -dx * Math.sin(theta) + dy * Math.cos(theta) };
	});
	return Math.min(...points.flatMap(point => [geometry.width / 2 - Math.abs(point.x) - radius, geometry.height / 2 - Math.abs(point.y) - radius]));
}

function expectedPadNets(instance: NativePcbTemplateInstance, source: ParsedPcb, target: ParsedPcb, errors: string[]): void {
	const sourceNet = new Map(instance.netMappings.map(item => [item.sourceNet, item.targetNet]));
	if (sourceNet.size !== instance.netMappings.length) errors.push(`网络映射存在重复来源网：${instance.placementOperationId}`);
	const uidByComponentId = new Map(instance.templateCapture.components.map(item => [item.sourceComponentId, item.sourceUid]));
	const targetUidBySourceUid = new Map(instance.sourceUidMappings.map(item => [item.sourceUid, item.actualTargetUid]));
	const targetComponentByUid = new Map<string, string[]>();
	for (const record of target.effective.values()) {
		const data = dataOf(record);
		const attrs = data && isObject(data.attrs) ? data.attrs : undefined;
		const uid = attrs?.['Unique ID'];
		if (record.header.type === 'COMPONENT' && typeof uid === 'string')
			targetComponentByUid.set(uid, [...(targetComponentByUid.get(uid) ?? []), String(record.header.id)]);
	}
	for (const record of source.effective.values()) {
		if (record.header.type !== 'PAD_NET') continue;
		let id: unknown;
		try { id = JSON.parse(String(record.header.id)); } catch { errors.push(`PAD_NET id 无法解析：${record.header.id}`); continue; }
		if (!Array.isArray(id) || id[0] !== 'PAD_NET' || typeof id[1] !== 'string' || typeof id[2] !== 'string') { errors.push(`PAD_NET id 结构不支持：${record.header.id}`); continue; }
		const sourceUidValue = uidByComponentId.get(id[1]);
		if (!sourceUidValue) continue;
		const targetUid = targetUidBySourceUid.get(sourceUidValue);
		const targetIds = targetUid ? targetComponentByUid.get(targetUid) ?? [] : [];
		const data = dataOf(record);
		if (!targetUid || targetIds.length !== 1 || !data || typeof data.padNet !== 'string') { errors.push(`PAD_NET 无唯一目标器件：${sourceUidValue}/${id[2]}`); continue; }
		const expectedNet = data.padNet ? sourceNet.get(data.padNet) : data.padNet;
		if (data.padNet && expectedNet === undefined) { errors.push(`PAD_NET 来源网缺少显式映射：${data.padNet}`); continue; }
		const actualId = JSON.stringify(['PAD_NET', targetIds[0], id[2]]);
		const actual = [...target.effective.values()].find(candidate => candidate.header.type === 'PAD_NET' && (() => {
			try { const parsed = JSON.parse(String(candidate.header.id)); return Array.isArray(parsed) && parsed[0] === 'PAD_NET' && parsed[1] === targetIds[0] && parsed[2] === id[2]; }
			catch { return false; }
		})());
		if (!actual || dataOf(actual)?.padNet !== expectedNet) errors.push(`PAD_NET 网络/归属与模板不符：${actualId} 期望 ${String(expectedNet)}`);
	}
}

function padNetAssociationKey(record: SourceRecord): string | undefined {
	let id: unknown;
	try { id = JSON.parse(String(record.header.id)); } catch { return undefined; }
	const net = dataOf(record)?.padNet;
	if (!Array.isArray(id) || id[0] !== 'PAD_NET' || typeof id[1] !== 'string' || typeof id[2] !== 'string' || typeof net !== 'string') return undefined;
	return `${id[1]}\u0000${id[2]}\u0000${net}`;
}

export function verifyTemplatePhysical(beforeSource: string, afterSource: string, instances: NativePcbTemplateInstance[], options: TemplatePhysicalVerificationOptions = {}): TemplatePhysicalVerification {
	const { preflight, sources } = inspectTemplates(instances);
	const before = parsePcbSource(beforeSource, '目标导入前');
	const after = parsePcbSource(afterSource, '目标导入后');
	const changedExisting: TemplatePhysicalVerification['changedExisting'] = [];
	const removedExisting: TemplatePhysicalVerification['removedExisting'] = [];
	const added: SourceRecord[] = [];
	for (const [key, prior] of before.effective) {
		const current = after.effective.get(key);
		if (prior.header.type === 'POURED') continue;
		if (!current) removedExisting.push({ type: String(prior.header.type), id: String(prior.header.id), data: prior.data });
		else if (stable(prior.data) !== stable(current.data)) changedExisting.push({ type: String(prior.header.type), id: String(prior.header.id), before: prior.data, after: current.data });
	}
	for (const [key, current] of after.effective) if (!before.effective.has(key)) added.push(current);
	const unexplainedAdded: TemplatePhysicalVerification['unexplainedAdded'] = [];
	const changedAll = changedExisting.length > 0 || removedExisting.length > 0;
	const matched: TemplatePhysicalVerification['matched'] = [];
	const missingExpected: TemplatePhysicalVerification['missingExpected'] = [];
	const stableTransform: TemplatePhysicalVerification['stableTransform'] = [];
	const componentAssociationErrors: string[] = [];
	const padNetAssociationErrors: string[] = [];
	const pouredAssociationErrors: string[] = [];
	const physicalAssociationErrors: string[] = [];
	const hostGeneratedPoured: TemplatePhysicalVerification['hostGeneratedPoured'] = [];
	const explainedAdded = new Map<string, { type: string; id: string }>();
	const pourNameAllocations: TemplatePhysicalVerification['pourNameAllocations'] = [];
	const lineMergeAssociations: TemplatePhysicalVerification['lineMergeAssociations'] = [];
	const padCoveredLineAssociations: TemplatePhysicalVerification['padCoveredLineAssociations'] = [];
	const componentGroups: TemplatePhysicalVerification['componentGroups'] = [];
	const verifiedGroups: TemplatePhysicalVerification['verifiedGroups'] = [];
	type ExpectedPhysical = { operationId: string; type: string; data: JsonObject; transform: Transform; ignorePourOrder: boolean; ignorePourName: boolean; expectedTargetId?: string; pourName?: { sourceName: string; targetName: string; collisionChain: string[]; order: number }; sourceRecord: SourceRecord };
	const expectedPhysical: ExpectedPhysical[] = [];
	const targetPhysical = added.filter(record => SUPPORTED_PHYSICAL_TYPES.has(String(record.header.type)) || record.header.type === 'POLY');
	const expectedPourOwnership = new Map<string, { netName: string; layerId: number }>();
	const occupiedPourNames = new Set<string>();
	for (const record of before.effective.values()) if (record.header.type === 'POUR') {
		const name = dataOf(record)?.name;
		if (typeof name === 'string' && name.length) occupiedPourNames.add(name.toUpperCase());
	}
	for (let index = 0; index < instances.length; index++) {
		const instance = instances[index];
		const source = sources[index];
		const ownedPolys = footprintOwnedPolys(instance, source);
		const transformResult = deriveTransform(instance, source, after);
		if (!transformResult.transform) { componentAssociationErrors.push(...transformResult.errors.map(error => `${instance.placementOperationId}: ${error}`)); continue; }
		const transform = transformResult.transform;
		stableTransform.push({ placementOperationId: instance.placementOperationId, ...transform });
		const nets = new Map(instance.netMappings.map(item => [item.sourceNet, item.targetNet]));
		const targetComponentIdsByUid = new Map<string, string[]>();
		for (const candidate of after.effective.values()) {
			if (candidate.header.type !== 'COMPONENT') continue;
			const uid = sourceUid(dataOf(candidate));
			if (uid) targetComponentIdsByUid.set(uid, [...(targetComponentIdsByUid.get(uid) ?? []), String(candidate.header.id)]);
		}
		const groups = deriveGroupBindings(instance, source, before, after, instances, sources);
		componentGroups.push(...groups.componentGroups);
		verifiedGroups.push(...groups.verifiedGroups);
		componentAssociationErrors.push(...groups.errors);
		const sourceRecords = [...source.effective.values()];
		const orderedPours = sourceRecords.map((record, orderIndex) => ({ record, orderIndex }))
			.filter(item => item.record.header.type === 'POUR')
			.sort((left, right) => Number(dataOf(left.record)?.order) - Number(dataOf(right.record)?.order) || left.orderIndex - right.orderIndex);
		for (const { record } of orderedPours) {
			const data = dataOf(record)!;
			if (!Object.hasOwn(data, 'name')) continue;
			if (typeof data.name !== 'string' || !data.name.length) {
				physicalAssociationErrors.push(`${instance.placementOperationId}: POUR/${record.header.id} 名称无效`);
			}
		}
		for (const record of sourceRecords) {
			const type = String(record.header.type);
			const ownedPoly = type === 'POLY' ? ownedPolys.get(recordKey(record)) : undefined;
			if (type === 'POURED' || !(SUPPORTED_PHYSICAL_TYPES.has(type) || type === 'POLY' && (excludedBoardOutline(record) || ownedPoly))) continue;
			const sourceData = dataOf(record)!;
			const groupKey = groupIdKey(sourceData.groupId);
			const mappedGroupId = groupKey ? groups.groupIds.get(groupKey) : undefined;
			const data = transformedPhysicalData(record, transform, nets, mappedGroupId);
			const matchTransform = { ...transform, coordinateScale: geometryCoordinateScale(sourceData) };
			const sourcePourName = type === 'POUR' && typeof sourceData.name === 'string' && sourceData.name.length > 0;
			let expectedTargetId: string | undefined;
			if (ownedPoly) {
				const mappedUid = instance.sourceUidMappings.find(mapping => mapping.sourceUid === ownedPoly.sourceUid)?.actualTargetUid;
				const targetIds = mappedUid ? targetComponentIdsByUid.get(mappedUid) ?? [] : [];
				if (targetIds.length === 1) expectedTargetId = `${targetIds[0]}${ownedPoly.localId}`;
				else physicalAssociationErrors.push(`${instance.placementOperationId}: POLY owner ${ownedPoly.sourceUid} 没有唯一目标 COMPONENT`);
			}
			expectedPhysical.push({ operationId: instance.placementOperationId, type, data, transform: matchTransform,
				ignorePourOrder: type === 'POUR', ignorePourName: sourcePourName, ...(ownedPoly ? { expectedTargetId: expectedTargetId ?? '' } : {}), sourceRecord: record });
		}
		expectedPadNets(instance, source, after, padNetAssociationErrors);
	}
	const adjacency = expectedPhysical.map(expected => targetPhysical.flatMap((candidate, index) => candidate.header.type === expected.type
		&& (expected.expectedTargetId === undefined || String(candidate.header.id) === expected.expectedTargetId)
		&& dataMatches(expected.data, targetPhysicalData(candidate), expected.transform, '', expected.ignorePourOrder, expected.ignorePourName) ? [index] : []));
	const candidateClasses = new Map<string, number[]>();
	for (let index = 0; index < adjacency.length; index++) {
		const key = adjacency[index].join(',');
		candidateClasses.set(key, [...(candidateClasses.get(key) ?? []), index]);
	}
	const classEntries = [...candidateClasses.entries()].filter(([key]) => key !== '');
	const ambiguousExpected = new Set<number>();
	for (let i = 0; i < classEntries.length; i++) for (let j = i + 1; j < classEntries.length; j++) {
		const left = classEntries[i][0].split(',').filter(Boolean).map(Number);
		const right = classEntries[j][0].split(',').filter(Boolean).map(Number);
		if (left.some(index => right.includes(index))) {
			physicalAssociationErrors.push('模板物理对象存在交叠候选，拒绝贪心归属');
			classEntries[i][1].forEach(index => ambiguousExpected.add(index));
			classEntries[j][1].forEach(index => ambiguousExpected.add(index));
		}
	}
	const expectedToCandidate = new Map<number, number>();
	for (const [candidateKey, expectedIndexes] of classEntries) {
		const candidateIndexes = candidateKey.split(',').map(Number);
		const equalOrderWithinPlacement = expectedIndexes.some((left, index) => expectedIndexes.slice(index + 1).some(right => {
			const a = expectedPhysical[left], b = expectedPhysical[right];
			return a.operationId === b.operationId && a.type === 'POUR' && b.type === 'POUR'
				&& Number(dataOf(a.sourceRecord)?.order) === Number(dataOf(b.sourceRecord)?.order);
		}));
		if (equalOrderWithinPlacement) {
			physicalAssociationErrors.push('等序 POUR 几何存在重叠候选，拒绝使用名称或记录顺序推断对应关系');
			expectedIndexes.forEach(index => ambiguousExpected.add(index));
			continue;
		}
		if (candidateIndexes.length !== expectedIndexes.length) {
			physicalAssociationErrors.push(`模板物理候选数量不唯一：期望 ${expectedIndexes.length}，候选 ${candidateIndexes.length}`);
			expectedIndexes.forEach(index => ambiguousExpected.add(index));
			continue;
		}
		const expectedSort = [...expectedIndexes].sort((a, b) => {
			const left = expectedPhysical[a], right = expectedPhysical[b];
			if (left.operationId !== right.operationId) return left.operationId.localeCompare(right.operationId);
			if (left.type === 'POUR' && right.type === 'POUR') return Number(dataOf(left.sourceRecord)?.order) - Number(dataOf(right.sourceRecord)?.order);
			return a - b;
		});
		const candidateSort = [...candidateIndexes].sort((a, b) => {
			const left = targetPhysical[a], right = targetPhysical[b];
			if (left.header.type !== right.header.type) return String(left.header.type).localeCompare(String(right.header.type));
			if (left.header.type === 'POUR' && right.header.type === 'POUR') return Number(dataOf(left)?.order) - Number(dataOf(right)?.order);
			return String(left.header.id).localeCompare(String(right.header.id));
		});
		for (let index = 0; index < expectedSort.length; index++) expectedToCandidate.set(expectedSort[index], candidateSort[index]);
	}
	for (const index of ambiguousExpected) expectedToCandidate.delete(index);
	const alreadyUsedTargets = new Set(expectedToCandidate.values());
	const remainingLineSources = expectedPhysical.map((item, index) => ({ item, index }))
		.filter(entry => entry.item.type === 'LINE' && !expectedToCandidate.has(entry.index));
	const remainingLineTargetIndexes = targetPhysical.map((item, index) => ({ item, index }))
		.filter(entry => entry.item.header.type === 'LINE' && !alreadyUsedTargets.has(entry.index));
	const lineMergeOptions: Array<{ operationId: string; targetIndex: number; sourceIndexes: number[] }> = [];
	for (const target of remainingLineTargetIndexes) {
		const targetData = targetPhysicalData(target.item);
		const operationOptions: Array<{ operationId: string; sourceIndexes: number[] }> = [];
		for (const operationId of new Set(remainingLineSources.map(entry => entry.item.operationId))) {
			const operationSources = remainingLineSources.filter(entry => entry.item.operationId === operationId)
				.map(entry => ({ index: entry.index, data: entry.item.data, rawData: dataOf(entry.item.sourceRecord)!, transform: entry.item.transform }));
			if (!operationSources.length) continue;
			const chain = sourceLineChainForTarget(targetData, operationSources[0].transform, operationSources);
			if (chain) operationOptions.push({ operationId, sourceIndexes: chain });
		}
		if (operationOptions.length > 1) {
			physicalAssociationErrors.push(`LINE/${target.item.header.id}: 多个实例都能构成连续源链，拒绝跨实例归属`);
			continue;
		}
		if (operationOptions.length === 1) lineMergeOptions.push({ operationId: operationOptions[0].operationId, targetIndex: target.index, sourceIndexes: operationOptions[0].sourceIndexes });
	}
	const sourceMergeUseCounts = new Map<number, number>();
	for (const option of lineMergeOptions) for (const sourceIndex of option.sourceIndexes)
		sourceMergeUseCounts.set(sourceIndex, (sourceMergeUseCounts.get(sourceIndex) ?? 0) + 1);
	for (const option of lineMergeOptions) {
		if (option.sourceIndexes.some(index => sourceMergeUseCounts.get(index) !== 1)) {
			physicalAssociationErrors.push(`LINE/${targetPhysical[option.targetIndex].header.id}: 源线段可进入多个合并链，拒绝多重覆盖`);
			continue;
		}
		for (const sourceIndex of option.sourceIndexes) expectedToCandidate.set(sourceIndex, option.targetIndex);
		lineMergeAssociations.push({
			placementOperationId: option.operationId,
			sourceIds: option.sourceIndexes.map(index => String(expectedPhysical[index].sourceRecord.header.id)),
			targetIds: [String(targetPhysical[option.targetIndex].header.id)],
		});
	}
	const padCoveredExpected = new Set<number>();
	if (Array.isArray(options.actualTargetPads)) for (let expectedIndex = 0; expectedIndex < expectedPhysical.length; expectedIndex++) {
		const expected = expectedPhysical[expectedIndex];
		if (expected.type !== 'LINE' || expectedToCandidate.has(expectedIndex)) continue;
		const instanceIndex = instances.findIndex(item => item.placementOperationId === expected.operationId);
		const instance = instances[instanceIndex];
		if (!instance || !Array.isArray(instance.templateCapture.sourcePads)) continue;
		const sourceLine = dataOf(expected.sourceRecord);
		if (!sourceLine || sourceLine.partitionId !== '' || sourceLine.groupId !== 0 || sourceLine.locked !== false
			|| Object.keys(sourceLine).some(key => !['partitionId', 'groupId', 'netName', 'layerId', 'startX', 'startY', 'endX', 'endY', 'width', 'locked', 'zIndex'].includes(key))) continue;
		const sourceNet = sourceLine.netName;
		const targetNet = typeof sourceNet === 'string' ? new Map(instance.netMappings.map(item => [item.sourceNet, item.targetNet])).get(sourceNet) : undefined;
		if (typeof targetNet !== 'string' || typeof sourceLine.layerId !== 'number' || typeof sourceLine.width !== 'number') continue;
		const targetUidBySourceUid = new Map(instance.sourceUidMappings.map(item => [item.sourceUid, item.actualTargetUid]));
		const matchingProofs: TemplatePhysicalVerification['padCoveredLineAssociations'] = [];
		for (const sourcePadGroup of instance.templateCapture.sourcePads) {
			const targetUid = targetUidBySourceUid.get(sourcePadGroup.sourceUid);
			if (!targetUid || !instance.templateCapture.components.some(component => component.sourceUid === sourcePadGroup.sourceUid && component.sourceComponentId === sourcePadGroup.sourceComponentId)) continue;
			const sourcePads = sourcePadGroup.pads.filter(pad => pad.parentComponentPrimitiveId === sourcePadGroup.sourceComponentId
				&& pad.net === sourceNet && String(pad.layer) === String(sourceLine.layerId) && supportedRectPad(pad));
			const targetGroups = options.actualTargetPads.filter(group => group.targetUid === targetUid);
			if (targetGroups.length !== 1) continue;
			const targetGroup = targetGroups[0];
			const sourceComponent = sourceComponentById(sources[instanceIndex], sourcePadGroup.sourceComponentId);
			const targetComponents = [...after.effective.values()].filter(record => record.header.type === 'COMPONENT' && sourceUid(dataOf(record)) === targetUid);
			if (!sourceComponent || sourceUid(sourceComponent) !== sourcePadGroup.sourceUid || targetComponents.length !== 1) continue;
			if (String(targetComponents[0].header.id) !== targetGroup.componentId) continue;
			for (const sourcePad of sourcePads) for (const targetPad of targetGroup.pads) {
				if (!supportedRectPad(targetPad) || targetPad.parentComponentPrimitiveId !== targetGroup.componentId
					|| targetPad.padNumber !== sourcePad.padNumber || targetPad.net !== targetNet || String(targetPad.layer) !== String(sourcePad.layer)) continue;
				if (stable(sourcePad.shape) !== stable(targetPad.shape)) continue;
				const radians = expected.transform.rotationDegrees * Math.PI / 180;
				const expectedX = Number(sourcePad.x) * Math.cos(radians) - Number(sourcePad.y) * Math.sin(radians) + expected.transform.dx;
				const expectedY = Number(sourcePad.x) * Math.sin(radians) + Number(sourcePad.y) * Math.cos(radians) + expected.transform.dy;
				const coordinateTolerance = padCoordinateTolerance(expectedX, expectedY, Number(targetPad.x), Number(targetPad.y));
				const expectedAngle = normalizeAngle(Number(sourcePad.rotation) + expected.transform.rotationDegrees);
				if (Math.abs(expectedX - Number(targetPad.x)) > coordinateTolerance || Math.abs(expectedY - Number(targetPad.y)) > coordinateTolerance
					|| Math.abs(expectedAngle - normalizeAngle(Number(targetPad.rotation))) > padCoordinateTolerance(expectedAngle, Number(targetPad.rotation))) continue;
				const sourceMargin = capsuleMargin(sourceLine, sourcePad);
				const targetMargin = capsuleMargin(expected.data, targetPad);
				if (sourceMargin === undefined || targetMargin === undefined || sourceMargin < 0 || targetMargin < 0) continue;
				const sourceIds = [String(expected.sourceRecord.header.id)];
				const associationId = stable([expected.operationId, sourceIds, targetUid, targetPad.primitiveId]);
				matchingProofs.push({ associationId, placementOperationId: expected.operationId, sourceIds, targetIds: [],
					sourceUid: sourcePadGroup.sourceUid, sourcePadPrimitiveId: sourcePad.primitiveId!, targetUid, targetPadPrimitiveId: targetPad.primitiveId!,
					sourceComponentId: sourcePadGroup.sourceComponentId, targetComponentId: targetGroup.componentId,
					padNumber: sourcePad.padNumber,
					sourceSnapshot: stable(sourcePad), targetSnapshot: stable(targetPad), minimumMargin: Math.min(sourceMargin, targetMargin) });
			}
		}
		if (matchingProofs.length === 1) {
			padCoveredExpected.add(expectedIndex);
			padCoveredLineAssociations.push(matchingProofs[0]);
		}
		else if (matchingProofs.length > 1) physicalAssociationErrors.push(`${expected.operationId}: LINE/${expected.sourceRecord.header.id} 落入多个候选 PAD 覆盖区，拒绝归属`);
	}
	const invalidPourNameExpected = new Set<number>();
	for (let index = 0; index < expectedPhysical.length; index++) {
		const expected = expectedPhysical[index];
		const sourceData = dataOf(expected.sourceRecord);
		if (expected.type === 'POUR' && sourceData && Object.hasOwn(sourceData, 'name')
			&& (typeof sourceData.name !== 'string' || !sourceData.name.length)) invalidPourNameExpected.add(index);
	}
	const matchedByOperation = new Map<string, Map<string, number>>();
	for (const index of expectedToCandidate.keys()) {
		const expected = expectedPhysical[index];
		const byType = matchedByOperation.get(expected.operationId) ?? new Map<string, number>();
		byType.set(expected.type, (byType.get(expected.type) ?? 0) + 1);
		matchedByOperation.set(expected.operationId, byType);
	}
	for (const [operationId, byType] of matchedByOperation) for (const [type, count] of byType) matched.push({ placementOperationId: operationId, type, count });
	for (const association of lineMergeAssociations) {
		const lineMatch = matched.find(item => item.placementOperationId === association.placementOperationId && item.type === 'LINE');
		if (lineMatch) lineMatch.count -= association.sourceIds.length - association.targetIds.length;
	}
	const allocatedPourNames = new Map<number, NonNullable<ExpectedPhysical['pourName']> & { orderBasis: 'source_order' | 'compatible_equal_order'; compatibleSourceOrder: string[] }>();
	for (const instance of instances) {
		const pourIndexes = expectedPhysical.map((item, index) => ({ item, index }))
			.filter(entry => entry.item.operationId === instance.placementOperationId && entry.item.type === 'POUR' && entry.item.ignorePourName)
			.sort((left, right) => Number(dataOf(left.item.sourceRecord)?.order) - Number(dataOf(right.item.sourceRecord)?.order) || left.index - right.index);
		for (let start = 0; start < pourIndexes.length;) {
			let end = start + 1;
			const order = Number(dataOf(pourIndexes[start].item.sourceRecord)?.order);
			while (end < pourIndexes.length && Number(dataOf(pourIndexes[end].item.sourceRecord)?.order) === order) end++;
			const group = pourIndexes.slice(start, end);
			const canSearchTies = group.length > 1 && group.every(entry => expectedToCandidate.has(entry.index));
			let selected: Array<{ index: number; sourceName: string; targetName: string; collisionChain: string[] }> | undefined;
			if (canSearchTies) {
				const search = (remaining: typeof group, pool: Set<string>, sequence: NonNullable<typeof selected>): typeof selected => {
					if (!remaining.length) return sequence;
					for (let candidateIndex = 0; candidateIndex < remaining.length; candidateIndex++) {
						const entry = remaining[candidateIndex];
						const sourceName = String(dataOf(entry.item.sourceRecord)?.name);
						const nextPool = new Set(pool);
						const allocation = allocatePourName(sourceName, nextPool);
						const target = targetPhysical[expectedToCandidate.get(entry.index)!];
						if (dataOf(target)?.name !== allocation.targetName) continue;
						const found = search(remaining.filter((_, index) => index !== candidateIndex), nextPool,
							[...sequence, { index: entry.index, sourceName, targetName: allocation.targetName, collisionChain: allocation.collisionChain }]);
						if (found) return found;
					}
					return undefined;
				};
				selected = search(group, new Set(occupiedPourNames), []);
			}
			const orderBasis = canSearchTies ? 'compatible_equal_order' as const : 'source_order' as const;
			const sequence = selected?.map(item => String(expectedPhysical[item.index].sourceRecord.header.id)) ?? group.map(entry => String(entry.item.sourceRecord.header.id));
			if (selected) {
				for (const item of selected) {
					occupiedPourNames.add(item.targetName);
					allocatedPourNames.set(item.index, { sourceName: item.sourceName, targetName: item.targetName, collisionChain: item.collisionChain, order, orderBasis, compatibleSourceOrder: sequence });
				}
			}
			else {
				for (const entry of group) {
					const sourceName = String(dataOf(entry.item.sourceRecord)?.name);
					const allocation = allocatePourName(sourceName, occupiedPourNames);
					allocatedPourNames.set(entry.index, { sourceName, ...allocation, order, orderBasis, compatibleSourceOrder: sequence });
				}
			}
			start = end;
		}
	}
	for (const [expectedIndex, candidateIndex] of expectedToCandidate) {
		const expected = expectedPhysical[expectedIndex];
		const candidate = targetPhysical[candidateIndex];
		if (invalidPourNameExpected.has(expectedIndex)) continue;
		const pourName = allocatedPourNames.get(expectedIndex);
		if (pourName) {
			const actualName = dataOf(candidate)?.name;
			if (actualName !== pourName.targetName) {
				physicalAssociationErrors.push(`${expected.operationId}: POUR/${expected.sourceRecord.header.id} 名称分配不符，期望 ${pourName.targetName}，实际 ${String(actualName)}`);
				invalidPourNameExpected.add(expectedIndex);
				continue;
			}
			pourNameAllocations.push({ placementOperationId: expected.operationId, sourceId: String(expected.sourceRecord.header.id), targetId: String(candidate.header.id), sourceName: pourName.sourceName, targetName: pourName.targetName, collisionChain: pourName.collisionChain, order: pourName.order, orderBasis: pourName.orderBasis, compatibleSourceOrder: pourName.compatibleSourceOrder });
		}
		if (expected.type === 'POUR') {
			const sourceData = dataOf(expected.sourceRecord)!;
			const instance = instances.find(item => item.placementOperationId === expected.operationId)!;
			const expectedNet = mappedNet(sourceData.netName, new Map(instance.netMappings.map(item => [item.sourceNet, item.targetNet])), `POUR/${expected.sourceRecord.header.id}`);
			if (typeof expectedNet === 'string') expectedPourOwnership.set(String(candidate.header.id), { netName: expectedNet, layerId: Number(sourceData.layerId) });
		}
		explainedAdded.set(recordKey(candidate), { type: String(candidate.header.type), id: String(candidate.header.id) });
	}
	for (let index = 0; index < expectedPhysical.length; index++) if (!expectedToCandidate.has(index) && !padCoveredExpected.has(index)) {
		const item = expectedPhysical[index];
		missingExpected.push({ placementOperationId: item.operationId, type: item.type, signature: stable({ type: item.type, data: item.data }), count: 1 });
	}
	for (let groupIndex = verifiedGroups.length - 1; groupIndex >= 0; groupIndex--) {
		const proof = verifiedGroups[groupIndex];
		const expectedReferences = new Set(proof.memberComponentIds.map(id => `COMPONENT\u0000${id}`));
		let everyExpectedPhysicalMatched = true;
		for (let index = 0; index < expectedPhysical.length; index++) {
			const expected = expectedPhysical[index];
			if (expected.operationId !== proof.placementOperationId
				|| groupIdKey(dataOf(expected.sourceRecord)?.groupId) !== groupIdKey(proof.sourceNativeGroupId)) continue;
			const candidateIndex = expectedToCandidate.get(index);
			if (candidateIndex === undefined) {
				if (!padCoveredExpected.has(index)) everyExpectedPhysicalMatched = false;
				continue;
			}
			if (invalidPourNameExpected.has(index)) { everyExpectedPhysicalMatched = false; continue; }
			expectedReferences.add(recordKey(targetPhysical[candidateIndex]));
		}
		const afterReferences = groupReferences(after.effective.values(), proof.targetNativeGroupId);
		const actualReferences = new Set(afterReferences.matching.map(recordKey));
		const exactReferences = everyExpectedPhysicalMatched && afterReferences.unknown.length === 0
			&& expectedReferences.size === actualReferences.size
			&& [...expectedReferences].every(key => actualReferences.has(key));
		if (exactReferences) continue;
		componentAssociationErrors.push(`${proof.placementOperationId}: 目标组成员不是本次完整且精确匹配的新增对象：${String(proof.targetNativeGroupId)}`);
		verifiedGroups.splice(groupIndex, 1);
		for (let index = componentGroups.length - 1; index >= 0; index--) {
			const item = componentGroups[index];
			if (item.placementOperationId === proof.placementOperationId
				&& item.sourceNativeGroupId === proof.sourceNativeGroupId && item.targetNativeGroupId === proof.targetNativeGroupId)
				componentGroups.splice(index, 1);
		}
	}
	for (const expected of expectedPhysical.filter(item => item.type === 'POUR')) {
		const expectedIndex = expectedPhysical.indexOf(expected);
		const targetIndex = expectedToCandidate.get(expectedIndex);
		if (targetIndex === undefined) continue;
		for (const other of expectedPhysical.filter(item => item.operationId === expected.operationId && item.type === 'POUR')) {
			const otherIndex = expectedPhysical.indexOf(other);
			const otherTargetIndex = expectedToCandidate.get(otherIndex);
			if (otherTargetIndex === undefined || otherIndex <= expectedIndex) continue;
			const sourceRelation = Math.sign(Number(dataOf(expected.sourceRecord)?.order) - Number(dataOf(other.sourceRecord)?.order));
			const targetRelation = Math.sign(Number(dataOf(targetPhysical[targetIndex])?.order) - Number(dataOf(targetPhysical[otherTargetIndex])?.order));
			if (sourceRelation !== 0 && sourceRelation !== targetRelation) physicalAssociationErrors.push(`${expected.operationId}: POUR order 相对顺序变化`);
		}
	}
	const expectedComponentIds = new Set<string>();
	const expectedPadNetCounts = new Map<string, number>();
	for (let index = 0; index < instances.length; index++) {
		const instance = instances[index];
		const source = sources[index];
		const targetUidBySourceUid = new Map(instance.sourceUidMappings.map(mapping => [mapping.sourceUid, mapping.actualTargetUid]));
		const targetIdByUid = new Map<string, string>();
		for (const record of after.effective.values()) {
			if (record.header.type !== 'COMPONENT') continue;
			const uid = sourceUid(dataOf(record));
			if (uid) targetIdByUid.set(uid, String(record.header.id));
		}
		const sourceUidByComponentId = new Map(instance.templateCapture.components.map(item => [item.sourceComponentId, item.sourceUid]));
		const nets = new Map(instance.netMappings.map(item => [item.sourceNet, item.targetNet]));
		for (const targetUid of targetUidBySourceUid.values()) {
			const targetId = targetIdByUid.get(targetUid);
			if (targetId) expectedComponentIds.add(targetId);
		}
		for (const record of source.effective.values()) {
			if (record.header.type !== 'PAD_NET') continue;
			let id: unknown;
			try { id = JSON.parse(String(record.header.id)); } catch { continue; }
			if (!Array.isArray(id) || id[0] !== 'PAD_NET' || typeof id[1] !== 'string' || typeof id[2] !== 'string') continue;
			const sourceUidValue = sourceUidByComponentId.get(id[1]);
			const targetUid = sourceUidValue ? targetUidBySourceUid.get(sourceUidValue) : undefined;
			const targetId = targetUid ? targetIdByUid.get(targetUid) : undefined;
			const net = dataOf(record)?.padNet;
			if (!targetId || typeof net !== 'string') continue;
			const targetNet = net ? nets.get(net) : net;
			if (targetNet === undefined) continue;
			const key = `${targetId}\u0000${id[2]}\u0000${targetNet}`;
			expectedPadNetCounts.set(key, (expectedPadNetCounts.get(key) ?? 0) + 1);
		}
	}
	for (const record of after.effective.values()) {
		if (record.header.type !== 'POURED') continue;
		let parentAssociationValid = true;
		const parentId = pouredParentId(record);
		const parentRecord = parentId ? after.effective.get(`POUR\u0000${parentId}`) : undefined;
		const parentData = parentRecord ? dataOf(parentRecord) : undefined;
		if (!parentId || !parentData || typeof parentData.netName !== 'string' || typeof parentData.layerId !== 'number') {
			pouredAssociationErrors.push(`POURED/${record.header.id}: 缺少有效父 POUR、网或层`);
			continue;
		}
		const expectedOwner = expectedPourOwnership.get(parentId);
		if (expectedOwner) {
			if (parentData.netName !== expectedOwner.netName || parentData.layerId !== expectedOwner.layerId) {
				pouredAssociationErrors.push(`POURED/${record.header.id}: 父 POUR 的网层与模板映射不符`);
				parentAssociationValid = false;
			}
		}
		else {
			const beforeParent = before.effective.get(`POUR\u0000${parentId}`);
			if (!beforeParent || stable(beforeParent.data) !== stable(parentData)) {
				pouredAssociationErrors.push(`POURED/${record.header.id}: 父 POUR 既非本次模板映射，也非未变更的既有边框`);
				parentAssociationValid = false;
			}
		}
		let fillEvidence: { fillCount: number; filledCount: number } | undefined;
		try { fillEvidence = validatePouredPayload(record, parentId); }
		catch (error) { pouredAssociationErrors.push(error instanceof Error ? error.message : String(error)); }
		const prior = before.effective.get(recordKey(record));
		if (fillEvidence && (!prior || stable(prior.data) !== stable(record.data))) {
			hostGeneratedPoured.push({ id: String(record.header.id), parentPourId: parentId, netName: parentData.netName, layerId: parentData.layerId, ...fillEvidence });
			if (parentAssociationValid && !prior)
				explainedAdded.set(recordKey(record), { type: 'POURED', id: String(record.header.id) });
		}
	}
	for (const record of added) {
		const type = String(record.header.type);
		if (targetPhysical.includes(record)) {
			if (!explainedAdded.has(recordKey(record))) unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
		}
		else if (type === 'GROUP') {
			const verified = verifiedGroups.find(item => item.groupRecord.id === String(record.header.id));
			if (verified) explainedAdded.set(recordKey(record), { type, id: String(record.header.id) });
			else unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
		}
		else if (type === 'COMPONENT') {
			const attrs = dataOf(record)?.attrs;
			const uid = isObject(attrs) ? attrs['Unique ID'] : undefined;
			const mappedTargetUids = new Set(instances.flatMap(instance => instance.sourceUidMappings.map(mapping => mapping.actualTargetUid)));
			if (typeof uid !== 'string' || !mappedTargetUids.has(uid)) unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
		}
		else if (type === 'PAD_NET') {
			const key = padNetAssociationKey(record);
			if (key === undefined) unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
			else {
				const expected = expectedPadNetCounts.get(key) ?? 0;
				if (expected > 0) expectedPadNetCounts.set(key, expected - 1);
				else unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
			}
		}
		else if (type === 'ATTR') {
			const parentId = dataOf(record)?.parentId;
			if (typeof parentId !== 'string' || !expectedComponentIds.has(parentId)) unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
		}
		else if (!SUPPORTED_ASSOCIATION_TYPES.has(type) && !KNOWN_NON_PHYSICAL_TYPES.has(type)) {
			unexplainedAdded.push({ type, id: String(record.header.id), data: record.data });
		}
	}
	const allPhysical = targetPhysical.length;
	const matchedCount = matched.reduce((sum, item) => sum + item.count, 0);
	const verified = preflight.ready && !changedAll && !componentAssociationErrors.length && !padNetAssociationErrors.length && !pouredAssociationErrors.length
		&& !physicalAssociationErrors.length && !missingExpected.length && !unexplainedAdded.length && matchedCount === allPhysical;
	const lineGroupNormalizations: TemplatePhysicalVerification['lineGroupNormalizations'] = [];
	if (verified) for (const proof of verifiedGroups) {
		const instanceIndex = instances.findIndex(item => item.placementOperationId === proof.placementOperationId);
		if (instanceIndex < 0) continue;
		const sourceLines = groupReferences(sources[instanceIndex].effective.values(), proof.sourceNativeGroupId).matching
			.filter(record => record.header.type === 'LINE');
		const targetLines = groupReferences(after.effective.values(), proof.targetNativeGroupId).matching
			.filter(record => record.header.type === 'LINE');
		const sourceIds = sourceLines.map(record => String(record.header.id)).sort();
		const targetIds = targetLines.map(record => String(record.header.id)).sort();
		if (!sourceIds.length || !targetIds.length) continue;
		const sourceIdSet = new Set(sourceIds), targetIdSet = new Set(targetIds);
		const consumedSources = new Set<string>(), projectedTargets = new Set<string>();
		const merges: TemplatePhysicalVerification['lineGroupNormalizations'][number]['merges'] = [];
		const padCovered: TemplatePhysicalVerification['lineGroupNormalizations'][number]['padCovered'] = [];
		let valid = true;
		for (const association of lineMergeAssociations.filter(item => item.placementOperationId === proof.placementOperationId)) {
			if (association.targetIds.length !== 1 || association.sourceIds.length < 2
				|| !association.sourceIds.every(id => sourceIdSet.has(id)) || !association.targetIds.every(id => targetIdSet.has(id))) { valid = false; break; }
			const [targetLineId] = association.targetIds;
			if (association.sourceIds.some(id => consumedSources.has(id)) || projectedTargets.has(targetLineId)) { valid = false; break; }
			association.sourceIds.forEach(id => consumedSources.add(id));
			projectedTargets.add(targetLineId);
			merges.push({ sourceLineIds: [...association.sourceIds], targetLineId });
		}
		if (!valid) continue;
		for (const association of padCoveredLineAssociations.filter(item => item.placementOperationId === proof.placementOperationId)) {
			if (association.sourceIds.length !== 1 || association.targetIds.length !== 0 || !sourceIdSet.has(association.sourceIds[0])) { valid = false; break; }
			const [sourceLineId] = association.sourceIds;
			if (consumedSources.has(sourceLineId)) { valid = false; break; }
			consumedSources.add(sourceLineId);
			padCovered.push({ sourceLineId, padCoverageAssociationId: association.associationId });
		}
		if (!valid) continue;
		for (const sourceLineId of sourceIds) {
			if (consumedSources.has(sourceLineId)) continue;
			const expected = expectedPhysical.filter(item => item.operationId === proof.placementOperationId && item.type === 'LINE'
				&& String(item.sourceRecord.header.id) === sourceLineId);
			if (expected.length !== 1) { valid = false; break; }
			const targetIndex = expectedToCandidate.get(expectedPhysical.indexOf(expected[0]));
			if (targetIndex === undefined) { valid = false; break; }
			const targetLineId = String(targetPhysical[targetIndex].header.id);
			if (!targetIdSet.has(targetLineId) || projectedTargets.has(targetLineId)) { valid = false; break; }
			consumedSources.add(sourceLineId);
			projectedTargets.add(targetLineId);
		}
		if (!valid || consumedSources.size !== sourceIdSet.size || projectedTargets.size !== targetIdSet.size
			|| [...targetIdSet].some(id => !projectedTargets.has(id))) continue;
		const reduction = merges.reduce((sum, item) => sum + item.sourceLineIds.length - 1, 0) + padCovered.length;
		if (targetIds.length !== sourceIds.length - reduction) continue;
		lineGroupNormalizations.push({ status: 'conditional_on_final_footprint_verification', placementOperationId: proof.placementOperationId,
			sourceNativeGroupId: proof.sourceNativeGroupId, targetNativeGroupId: proof.targetNativeGroupId,
			sourceLineCount: sourceIds.length, targetLineCount: targetIds.length, sourceLineIds: sourceIds, targetLineIds: targetIds, merges, padCovered });
	}
	return { matched, missingExpected, unexplainedAdded, changedExisting, removedExisting, stableTransform,
		componentAssociationErrors, padNetAssociationErrors, pouredAssociationErrors, physicalAssociationErrors, hostGeneratedPoured,
		explainedAdded: [...explainedAdded.values()], componentGroups, verifiedGroups, lineGroupNormalizations, pourNameAllocations, lineMergeAssociations, padCoveredLineAssociations, preflight, verified };
}
