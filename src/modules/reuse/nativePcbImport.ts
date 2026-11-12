import { preflightTemplatePhysical, verifyTemplatePhysical, type NativePcbTemplateInstance, type PadCopperState, type TemplatePhysicalPreflight, type TemplatePhysicalVerification } from './pcbTemplatePhysical';

type JsonObject = Record<string, unknown>;
type SourceRecord = { header: JsonObject; data: unknown };
type ParsedPcb = { uuid: string; effective: Map<string, SourceRecord> };
type PadExpectation = { padNumber: string; net: string };
type TypedPad = PadCopperState;
type ZeroNumberedPadsSource = { footprintUuid: string; documentSource: string };
type ComponentExpectation = { targetUid: string; pads: PadExpectation[]; zeroNumberedPadsSource?: ZeroNumberedPadsSource };
type RecordDifference = {
	type: string;
	id: string;
	kind: 'added' | 'removed' | 'changed';
	before?: unknown;
	after?: unknown;
};
type SnapshotComparison = {
	differences: RecordDifference[];
	defaultMetadataDifferences: RecordDifference[];
	importDifferences: RecordDifference[];
	unexpectedDifferences: RecordDifference[];
};
type TypedReadback = { actualPads: Array<{ targetUid: string; componentId: string; pads: TypedPad[] }>; matches: boolean };

/** 4.1.71 public runtime supports the force flag even though the shipped SDK d.ts only declares uuid. */
interface RuntimePcbImportChanges {
	importChanges(uuid?: string, force?: boolean): Promise<boolean>;
}

export type NativePcbImportResult = {
	status: 'not_started' | 'unknown' | 'confirmed';
	stage: 'pcb_component_import_only';
	writeAttempted: boolean;
	projectUuid: string;
	targetPcbUuid: string;
	schematicUuid: string;
	baselineComponentIds: string[];
	newComponentIds: string[];
	actualPads: Array<{ targetUid: string; componentId: string; pads: TypedPad[] }>;
	differences: RecordDifference[];
	defaultMetadataDifferences: RecordDifference[];
	importDifferences: RecordDifference[];
	unexpectedDifferences: RecordDifference[];
	templatePhysicalPreflight?: TemplatePhysicalPreflight;
	templatePhysicalVerification?: TemplatePhysicalVerification;
	layoutRoutingVerified: false;
	saveReloadVerified: false;
	reason?: string;
};

const READBACK_BUDGET_MS = 5_000;
const READBACK_POLL_INTERVAL_MS = 250;
const BLANK_BOARD_METADATA_TYPES = new Set([
	'CANVAS', 'LAYER', 'LAYER_PHYS', 'ACTIVE_LAYER', 'PRIMITIVE', 'SILK_OPTS',
	'D3_ATTRIBUTE', 'PREFERENCE', 'PANELIZE',
]);
const NON_PHYSICAL_DEFAULT_TYPES = new Set([
	...BLANK_BOARD_METADATA_TYPES, 'RULE_TEMPLATE', 'RULE', 'RULE_SELECTOR', 'NET',
]);

function fail(message: string): never {
	throw new Error(message);
}

function object(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${name} 必须是非空字符串`);
	return value;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

function recordKey(record: SourceRecord): string {
	return `${String(record.header.type)}\u0000${String(record.header.id)}`;
}

function compareRecord(record: SourceRecord): unknown {
	const header = { ...record.header };
	delete header.ticket;
	return { header, data: record.data };
}

function effectiveSignature(parsed: ParsedPcb): string {
	const entries = [...parsed.effective.entries()]
		.map(([key, record]) => [key, compareRecord(record)] as const)
		.sort((left, right) => left[0].localeCompare(right[0]));
	return stable(entries);
}

function isBlankMetadataNormalization(difference: RecordDifference): boolean {
	if (!BLANK_BOARD_METADATA_TYPES.has(difference.type)) return false;
	if (difference.type === 'LAYER_PHYS') {
		if (difference.kind !== 'changed' || !object(difference.before) || !object(difference.after)) return false;
		if (stable(difference.before.header) !== stable(difference.after.header)
			|| !object(difference.before.data) || !object(difference.after.data)) return false;
		const beforeData = { ...difference.before.data };
		const afterData = { ...difference.after.data };
		const normalizedKeys = ['permittivity', 'lossTangent'];
		let normalizedCount = 0;
		for (const key of normalizedKeys) {
			if (stable(beforeData[key]) === stable(afterData[key])) continue;
			if (beforeData[key] !== null || afterData[key] !== 0) return false;
			normalizedCount++;
		}
		for (const key of normalizedKeys) {
			delete beforeData[key];
			delete afterData[key];
		}
		return normalizedCount > 0 && stable(beforeData) === stable(afterData);
	}
	if (difference.type === 'PRIMITIVE') {
		if (difference.kind !== 'changed' || !object(difference.before) || !object(difference.after)) return false;
		if (stable(difference.before.header) !== stable(difference.after.header)
			|| !object(difference.before.data) || !object(difference.after.data)
			|| difference.before.data.display !== true || Object.hasOwn(difference.after.data, 'display')) return false;
		const beforeData = { ...difference.before.data };
		const afterData = { ...difference.after.data };
		delete beforeData.display;
		delete afterData.display;
		return stable(beforeData) === stable(afterData);
	}
	if (difference.type === 'LAYER') {
		if (difference.kind !== 'changed' || !object(difference.before) || !object(difference.after)) return false;
		const before = object(difference.before.data) ? difference.before.data : undefined;
		const after = object(difference.after.data) ? difference.after.data : undefined;
		if (!before || !after) return false;
		const physicalKeys = ['layerId', 'layerType', 'layerName', 'use', 'locked'];
		return physicalKeys.every(key => stable(before[key]) === stable(after[key]));
	}
	if (difference.type === 'CANVAS') {
		if (difference.kind !== 'changed' || !object(difference.before) || !object(difference.after)) return false;
		const before = object(difference.before.data) ? difference.before.data : undefined;
		const after = object(difference.after.data) ? difference.after.data : undefined;
		if (!before || !after) return false;
		return ['originX', 'originY', 'unit'].every(key => stable(before[key]) === stable(after[key]));
	}
	return true;
}

function parsePcbSource(source: unknown, expectedUuid: string): ParsedPcb {
	if (typeof source !== 'string' || !source.trim()) fail('PCB 源码为空');
	const records: SourceRecord[] = [];
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex].replace(/[\r\n]+$/, '');
		if (!line.trim()) continue;
		const separator = line.indexOf('||');
		if (separator < 0) fail(`PCB 源码第 ${lineIndex + 1} 行缺少 ||`);
		let header: unknown;
		let data: unknown;
		try {
			header = JSON.parse(line.slice(0, separator));
			let payload = line.slice(separator + 2);
			if (payload.endsWith('|')) payload = payload.slice(0, -1);
			data = payload === '' ? '' : JSON.parse(payload);
		}
		catch { fail(`PCB 源码第 ${lineIndex + 1} 行 JSON 无效`); }
		if (!object(header) || typeof header.type !== 'string' || !header.type.trim()) fail(`PCB 源码第 ${lineIndex + 1} 行 header 无效`);
		if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim())) fail(`PCB 源码第 ${lineIndex + 1} 行缺少记录 id`);
		if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket))) fail(`PCB 源码第 ${lineIndex + 1} 行 ticket 无效`);
		records.push({ header, data });
	}
	const heads = records.filter(record => record.header.type === 'DOCHEAD');
	if (!heads.length || heads.some(record => !object(record.data) || record.data.uuid !== expectedUuid || record.data.docType !== 'PCB'))
		fail(`PCB DOCHEAD 与当前目标不符：${expectedUuid}`);
	const highestByKey = new Map<string, SourceRecord>();
	for (const record of records) {
		if (record.header.type === 'DOCHEAD') continue;
		const key = recordKey(record);
		const previous = highestByKey.get(key);
		if (!previous || Number(record.header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) highestByKey.set(key, record);
	}
	const effective = new Map<string, SourceRecord>();
	for (const [key, record] of highestByKey) if (record.data !== '') effective.set(key, record);
	return { uuid: expectedUuid, effective };
}

function assertZeroNumberedFootprintSource(source: ZeroNumberedPadsSource, targetUid: string): void {
	const resourceKey = requiredString(source?.footprintUuid, `${targetUid}.zeroNumberedPadsSource.footprintUuid`);
	if (typeof source?.documentSource !== 'string' || !source.documentSource.trim())
		fail(`${targetUid} 缺少完整封装资源源码，不能确认空焊盘期望`);
	const records: Array<{ record: SourceRecord; documentUuid?: string }> = [];
	let activeDocumentUuid: string | undefined;
	const lines = source.documentSource.match(/[^\n]*(?:\n|$)/g) ?? [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex].replace(/[\r\n]+$/, '');
		if (!line.trim()) continue;
		const separator = line.indexOf('||');
		if (separator < 0) fail(`封装资源 ${resourceKey} 第 ${lineIndex + 1} 行缺少 ||`);
		try {
			const header: unknown = JSON.parse(line.slice(0, separator));
			let payload = line.slice(separator + 2);
			if (payload.endsWith('|')) payload = payload.slice(0, -1);
			const data: unknown = payload === '' ? '' : JSON.parse(payload);
			if (!object(header) || typeof header.type !== 'string' || !header.type.trim()) fail(`封装资源 ${resourceKey} 第 ${lineIndex + 1} 行 header 无效`);
			if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim())) fail(`封装资源 ${resourceKey} 第 ${lineIndex + 1} 行缺少记录 id`);
			if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket))) fail(`封装资源 ${resourceKey} 第 ${lineIndex + 1} 行 ticket 无效`);
			const record = { header, data };
			if (header.type === 'DOCHEAD' && object(data) && typeof data.uuid === 'string') activeDocumentUuid = data.uuid;
			records.push({ record, documentUuid: activeDocumentUuid });
		}
		catch (error) {
			if (error instanceof Error && error.message.startsWith('封装资源')) throw error;
			fail(`封装资源 ${resourceKey} 第 ${lineIndex + 1} 行 JSON 无效`);
		}
	}
	const heads = records.filter(entry => entry.record.header.type === 'DOCHEAD');
	const identities = new Map<string, { uuid: string; docType: string }>();
	for (const head of heads) {
		if (!object(head.record.data) || typeof head.record.data.uuid !== 'string' || !head.record.data.uuid.trim()
			|| head.record.data.docType !== 'FOOTPRINT') fail(`封装资源 ${resourceKey} DOCHEAD 身份无效`);
		identities.set(String(head.record.data.uuid), { uuid: String(head.record.data.uuid), docType: 'FOOTPRINT' });
	}
	if (!heads.length) fail(`封装资源 ${resourceKey} 缺少 FOOTPRINT DOCHEAD`);
	const matching = identities.get(resourceKey);
	if (!matching && identities.size !== 1) fail(`封装资源 ${resourceKey} 含多个身份且无法唯一核实`);
	const identity = matching ?? [...identities.values()][0];
	const highestByKey = new Map<string, SourceRecord>();
	for (const entry of records) {
		if (entry.documentUuid !== identity.uuid) continue;
		const record = entry.record;
		if (record.header.type === 'DOCHEAD') continue;
		const key = recordKey(record);
		const previous = highestByKey.get(key);
		if (!previous || Number(record.header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) highestByKey.set(key, record);
	}
	const effective = [...highestByKey.values()].filter(record => record.data !== '');
	if (!effective.length) fail(`封装资源 ${identity.uuid} 没有有效内容`);
	for (const record of effective) {
		if (record.header.type !== 'PAD') continue;
		if (!object(record.data) || typeof record.data.num !== 'string') fail(`封装资源 ${identity.uuid} 的 PAD 编号字段无效`);
		if (record.data.num.trim()) fail(`${targetUid} 的封装资源 ${resourceKey} 含有编号焊盘 ${record.data.num}`);
	}
}

function activeComponentRecords(parsed: ParsedPcb): Array<{ id: string; uid: string; record: SourceRecord }> {
	const components: Array<{ id: string; uid: string; record: SourceRecord }> = [];
	for (const record of parsed.effective.values()) {
		if (record.header.type !== 'COMPONENT' || !object(record.data) || !object(record.data.attrs)) continue;
		const uid = record.data.attrs['Unique ID'];
		if (typeof uid !== 'string' || !uid.trim()) continue;
		components.push({ id: String(record.header.id), uid, record });
	}
	return components;
}

function allComponentIds(parsed: ParsedPcb): string[] {
	return [...parsed.effective.values()]
		.filter(record => record.header.type === 'COMPONENT')
		.map(record => String(record.header.id))
		.sort();
}

function hasPhysicalDesign(parsed: ParsedPcb): boolean {
	return [...parsed.effective.values()].some(record => !NON_PHYSICAL_DEFAULT_TYPES.has(String(record.header.type)));
}

function encodedRelatedNet(recordId: string): string | undefined {
	try {
		const value: unknown = JSON.parse(recordId);
		if (Array.isArray(value) && value[0] === 'RULE_SELECTOR' && Array.isArray(value[1]) && value[1][0] === 'NET' && typeof value[1][1] === 'string')
			return value[1][1];
	}
	catch { /* Non-JSON identifiers are not supported for selector scoping. */ }
	return undefined;
}

function padNetComponentId(record: SourceRecord): string | undefined {
	try {
		const value: unknown = JSON.parse(String(record.header.id));
		return Array.isArray(value) && value[0] === 'PAD_NET' && typeof value[1] === 'string' ? value[1] : undefined;
	}
	catch { return undefined; }
}

function compareSnapshots(
	baseline: ParsedPcb,
	after: ParsedPcb,
	expectedUids: Set<string>,
	expectedNets: Set<string>,
): SnapshotComparison {
	const allKeys = new Set([...baseline.effective.keys(), ...after.effective.keys()]);
	const differences: RecordDifference[] = [];
	const defaultMetadataDifferences: RecordDifference[] = [];
	const importDifferences: RecordDifference[] = [];
	const unexpectedDifferences: RecordDifference[] = [];
	const blankBefore = !hasPhysicalDesign(baseline);
	const beforeComponents = new Set(allComponentIds(baseline));
	const afterComponents = activeComponentRecords(after);
	const componentById = new Map(afterComponents.map(item => [item.id, item]));
	const newComponentIds = new Set(afterComponents.filter(item => !beforeComponents.has(item.id)).map(item => item.id));

	for (const key of allKeys) {
		const before = baseline.effective.get(key);
		const current = after.effective.get(key);
		if (before && current && stable(compareRecord(before)) === stable(compareRecord(current))) continue;
		const record = current ?? before!;
		const type = String(record.header.type);
		const id = String(record.header.id);
		const kind = !before ? 'added' : !current ? 'removed' : 'changed';
		const difference: RecordDifference = {
			type, id, kind,
			...(before ? { before: compareRecord(before) } : {}),
			...(current ? { after: compareRecord(current) } : {}),
		};
		differences.push(difference);

		if (before && (!current || kind === 'changed')) {
			if (blankBefore && isBlankMetadataNormalization(difference)) defaultMetadataDifferences.push(difference);
			else unexpectedDifferences.push(difference);
			continue;
		}
		if (blankBefore && isBlankMetadataNormalization(difference)) {
			defaultMetadataDifferences.push(difference);
			continue;
		}
		if (type === 'COMPONENT' && current && object(current.data) && object(current.data.attrs)
			&& typeof current.data.attrs['Unique ID'] === 'string' && expectedUids.has(current.data.attrs['Unique ID'] as string)) {
			importDifferences.push(difference);
			continue;
		}
		if (type === 'ATTR' && current && object(current.data) && typeof current.data.parentId === 'string'
			&& newComponentIds.has(current.data.parentId)) {
			importDifferences.push(difference);
			continue;
		}
		if (type === 'PAD_NET' && current && padNetComponentId(current) && newComponentIds.has(padNetComponentId(current)!)) {
			importDifferences.push(difference);
			continue;
		}
		if (type === 'NET' && current && object(current.data)) {
			let netName: string | undefined;
			try {
				const parsedId: unknown = JSON.parse(id);
				if (Array.isArray(parsedId) && parsedId[0] === 'NET' && typeof parsedId[1] === 'string') netName = parsedId[1];
			}
			catch { /* Keep an unrecognized NET as unexpected. */ }
			if (netName !== undefined && expectedNets.has(netName)) importDifferences.push(difference);
			else unexpectedDifferences.push(difference);
			continue;
		}
		if (type === 'RULE_SELECTOR' && current && encodedRelatedNet(id) !== undefined && expectedNets.has(encodedRelatedNet(id)!)) {
			importDifferences.push(difference);
			continue;
		}
		unexpectedDifferences.push(difference);
	}
	return { differences, defaultMetadataDifferences, importDifferences, unexpectedDifferences };
}

function normalizePads(pins: unknown, componentId: string): TypedPad[] {
	if (!Array.isArray(pins)) fail(`组件焊盘读回不是数组：${componentId}`);
	return pins.map((pin: unknown) => {
		if (!pin || typeof pin !== 'object') fail(`组件焊盘对象无效：${componentId}`);
		const pad = pin as IPCB_PrimitiveComponentPad;
		const parentId = pad.getState_ParentComponentPrimitiveId();
		const padNumber = pad.getState_PadNumber();
		const net = pad.getState_Net();
		if (parentId !== componentId || typeof padNumber !== 'string' || typeof net !== 'string')
			fail(`组件焊盘归属、编号或网络读回无效：${componentId}`);
		const raw = pad as unknown as Record<string, unknown>;
		const failedGetters = new Set<string>();
		const read = (name: string): unknown => {
			const method = raw[name];
			if (typeof method !== 'function') { failedGetters.add(name); return undefined; }
			try { return (method as () => unknown).call(pad); }
			catch { failedGetters.add(name); return undefined; }
		};
		const primitiveId = read('getState_PrimitiveId');
		const layer = read('getState_Layer');
		const x = read('getState_X');
		const y = read('getState_Y');
		const rotation = read('getState_Rotation');
		const shape = read('getState_Pad');
		const hole = read('getState_Hole');
		const specialPadValue = read('getState_SpecialPad');
		const specialPad = failedGetters.has('getState_SpecialPad') ? undefined : specialPadValue ?? null;
		const holeOffsetX = read('getState_HoleOffsetX');
		const holeOffsetY = read('getState_HoleOffsetY');
		const holeRotation = read('getState_HoleRotation');
		const geometryComplete = (typeof primitiveId === 'string' || typeof primitiveId === 'number')
			&& (typeof layer === 'string' || typeof layer === 'number')
			&& typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
			&& typeof rotation === 'number' && Number.isFinite(rotation) && Array.isArray(shape)
			&& hole !== undefined && specialPad !== undefined && holeOffsetX !== undefined && holeOffsetY !== undefined && holeRotation !== undefined
			&& failedGetters.size === 0;
		return {
			primitiveId: typeof primitiveId === 'string' || typeof primitiveId === 'number' ? primitiveId : undefined,
			parentComponentPrimitiveId: parentId,
			padNumber, net,
			layer: typeof layer === 'string' || typeof layer === 'number' ? layer : undefined,
			x: typeof x === 'number' ? x : undefined,
			y: typeof y === 'number' ? y : undefined,
			rotation: typeof rotation === 'number' ? rotation : undefined,
			shape, hole, specialPad,
			holeOffsetX: typeof holeOffsetX === 'number' || holeOffsetX === null ? holeOffsetX : undefined,
			holeOffsetY: typeof holeOffsetY === 'number' || holeOffsetY === null ? holeOffsetY : undefined,
			holeRotation: typeof holeRotation === 'number' || holeRotation === null ? holeRotation : undefined,
			geometryComplete,
		};
	});
}

function expectedPadsMatch(expected: PadExpectation[], actual: TypedPad[]): boolean {
	const normalize = (pads: PadExpectation[] | TypedPad[]) => [...new Set(pads
		.filter(pad => pad.padNumber.trim())
		.map(pad => `${pad.padNumber}\u0000${pad.net}`))].sort();
	if (expected.length === 0) return actual.every(pad => !pad.padNumber.trim());
	return stable(normalize(expected)) === stable(normalize(actual));
}

async function assertCurrentTarget(projectUuid: string, targetPcbUuid: string, schematicUuid: string): Promise<void> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project || project.uuid !== projectUuid || !Array.isArray(project.data)) fail('当前工程与指定工程不一致或工程树不可用');
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!document || document.uuid !== targetPcbUuid || document.parentProjectUuid !== projectUuid || document.documentType !== 3)
		fail(`当前活动文档不是指定目标 PCB：${targetPcbUuid}`);
	const boards = project.data.filter((item): item is IDMT_BoardItem => item.itemType === 'Board' && item.pcb.uuid === targetPcbUuid);
	if (boards.length !== 1) fail(`目标 PCB 在当前工程树中未关联到唯一 Board：${targetPcbUuid}`);
	const board = boards[0];
	if (board.parentProjectUuid !== projectUuid || !object(board.schematic) || board.schematic.uuid !== schematicUuid
		|| board.schematic.parentProjectUuid !== projectUuid || board.pcb.parentProjectUuid !== projectUuid)
		fail(`目标 PCB 与原理图未在当前工程的同一 Board 下关联：${schematicUuid}/${targetPcbUuid}`);
}

async function currentPcbSource(projectUuid: string, targetPcbUuid: string, schematicUuid: string): Promise<string> {
	await assertCurrentTarget(projectUuid, targetPcbUuid, schematicUuid);
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim()) fail('目标 PCB 源码读取为空');
	parsePcbSource(source, targetPcbUuid);
	await assertCurrentTarget(projectUuid, targetPcbUuid, schematicUuid);
	return source;
}

async function readTargetPads(
	expectations: ComponentExpectation[],
	componentIdByUid: Map<string, string>,
	parsed: ParsedPcb,
): Promise<TypedReadback | undefined> {
	const actualPads: Array<{ targetUid: string; componentId: string; pads: TypedPad[] }> = [];
	let matches = true;
	for (const expected of expectations) {
		const componentId = componentIdByUid.get(expected.targetUid);
		if (!componentId) return undefined;
		const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
		if (pins === undefined) return undefined;
		const pads = normalizePads(pins, componentId);
		if (!expectedPadsMatch(expected.pads, pads)) matches = false;
		const sourcePadNets = [...parsed.effective.values()].filter(record => record.header.type === 'PAD_NET'
			&& padNetComponentId(record) === componentId).flatMap(record => {
			try {
				const identity: unknown = JSON.parse(String(record.header.id));
				return Array.isArray(identity) && typeof identity[2] === 'string' && object(record.data)
					? [{ padNumber: identity[2], net: typeof record.data.padNet === 'string' ? record.data.padNet : '' }]
					: [];
			}
			catch { return []; }
		});
		if (!expectedPadsMatch(expected.pads, sourcePadNets)) matches = false;
		actualPads.push({ targetUid: expected.targetUid, componentId, pads });
	}
	return { actualPads, matches };
}

function classifyTarget(
	parsed: ParsedPcb,
	baseline: ParsedPcb,
	expectations: ComponentExpectation[],
	expectedNets: Set<string>,
): { complete: boolean; componentIdsByUid: Map<string, string[]>; comparison: SnapshotComparison; reason: string } {
	const afterComponents = activeComponentRecords(parsed);
	const baselineComponentIds = new Set(allComponentIds(baseline));
	const idsByUid = new Map<string, string[]>();
	for (const item of afterComponents) idsByUid.set(item.uid, [...(idsByUid.get(item.uid) ?? []), item.id]);
	let complete = true;
	let incompleteReason = '';
	const componentIdsByUid = new Map<string, string[]>();
	for (const expected of expectations) {
		const ids = idsByUid.get(expected.targetUid) ?? [];
		componentIdsByUid.set(expected.targetUid, ids);
		if (ids.length !== 1) {
			complete = false;
			incompleteReason ||= ids.length === 0 ? `等待预期 target UID 出现：${expected.targetUid}` : `目标 Unique ID 不唯一：${expected.targetUid}`;
			continue;
		}
	}
	const expectedUids = new Set(expectations.map(item => item.targetUid));
	const beforeIds = baselineComponentIds;
	const unexpectedNewComponents = afterComponents.filter(item => !beforeIds.has(item.id) && !expectedUids.has(item.uid));
	const comparison = compareSnapshots(baseline, parsed, expectedUids, expectedNets);
	const missingExisting = [...baselineComponentIds].filter(id => !parsed.effective.has(`COMPONENT\u0000${id}`));
	const reason = missingExisting.length
		? `基线器件被删除：${missingExisting.join(', ')}`
		: unexpectedNewComponents.length ? `出现未预期新增器件：${unexpectedNewComponents.map(item => item.uid).join(', ')}`
			: comparison.unexpectedDifferences.length ? `读回中发现基线或非预期 PCB 变化：${comparison.unexpectedDifferences.map(item => `${item.type}/${item.id}`).join(', ')}`
				: incompleteReason || '等待所有预期器件与焊盘网络读回';
	return {
		complete,
		componentIdsByUid,
		comparison,
		reason,
	};
}

function makeResult(
	status: NativePcbImportResult['status'],
	writeAttempted: boolean,
	ids: { projectUuid: string; targetPcbUuid: string; schematicUuid: string },
	baselineComponentIds: string[],
	data?: Partial<NativePcbImportResult>,
): NativePcbImportResult {
	return {
		status,
		stage: 'pcb_component_import_only',
		writeAttempted,
		...ids,
		baselineComponentIds,
		newComponentIds: [],
		actualPads: [],
		differences: [],
		defaultMetadataDifferences: [],
		importDifferences: [],
		unexpectedDifferences: [],
		layoutRoutingVerified: false,
		saveReloadVerified: false,
		...data,
	};
}

export async function forceImportPcbComponents(input: {
	projectUuid: string;
	targetPcbUuid: string;
	schematicUuid: string;
	expectedComponents: ComponentExpectation[];
	templateInstances?: NativePcbTemplateInstance[];
}): Promise<NativePcbImportResult> {
	let writeAttempted = false;
	let ids = { projectUuid: '', targetPcbUuid: '', schematicUuid: '' };
	let baselineComponentIds: string[] = [];
	let lastResultData: Partial<NativePcbImportResult> = {};
	try {
		ids = {
			projectUuid: requiredString(input?.projectUuid, 'projectUuid'),
			targetPcbUuid: requiredString(input?.targetPcbUuid, 'targetPcbUuid'),
			schematicUuid: requiredString(input?.schematicUuid, 'schematicUuid'),
		};
		if (!Array.isArray(input.expectedComponents) || input.expectedComponents.length === 0) fail('expectedComponents 必须包含至少一个预期器件');
		const expectations = input.expectedComponents.map((raw, index) => {
			if (!object(raw)) fail(`expectedComponents[${index}] 无效`);
			const targetUid = requiredString(raw.targetUid, `expectedComponents[${index}].targetUid`);
			if (!Array.isArray(raw.pads)) fail(`expectedComponents[${index}].pads 必须是数组`);
			const suppliedPads = raw.pads.map((pad, padIndex) => {
				if (!object(pad)) fail(`expectedComponents[${index}].pads[${padIndex}] 无效`);
				return {
					padNumber: requiredString(pad.padNumber, `expectedComponents[${index}].pads[${padIndex}].padNumber`),
					net: typeof pad.net === 'string' ? pad.net : fail(`expectedComponents[${index}].pads[${padIndex}].net 必须是字符串`),
				};
			});
			const padByNumber = new Map<string, PadExpectation>();
			for (const pad of suppliedPads) {
				const existing = padByNumber.get(pad.padNumber);
				if (existing && existing.net !== pad.net) fail(`${targetUid} 焊盘 ${pad.padNumber} 有冲突网络期望`);
				padByNumber.set(pad.padNumber, pad);
			}
			const pads = [...padByNumber.values()];
			if (pads.length === 0) assertZeroNumberedFootprintSource(raw.zeroNumberedPadsSource as ZeroNumberedPadsSource, targetUid);
			return { targetUid, pads };
		});
		const expectedUids = expectations.map(item => item.targetUid);
		if (new Set(expectedUids).size !== expectedUids.length) fail('expectedComponents 中 targetUid 重复');
		const expectedNets = new Set(expectations.flatMap(item => item.pads.map(pad => pad.net)));
		let templatePhysicalPreflight: TemplatePhysicalPreflight | undefined;
		if (input.templateInstances !== undefined) {
			templatePhysicalPreflight = preflightTemplatePhysical(input.templateInstances);
			if (!templatePhysicalPreflight.ready)
				return makeResult('not_started', false, ids, [], {
					templatePhysicalPreflight,
					reason: templatePhysicalPreflight.reason ?? `模板物理内容不支持：${[...templatePhysicalPreflight.unsupportedTypes, ...templatePhysicalPreflight.unsupportedFields].join(', ')}`,
				});
		}

		const baselineSource = await currentPcbSource(ids.projectUuid, ids.targetPcbUuid, ids.schematicUuid);
		const baseline = parsePcbSource(baselineSource, ids.targetPcbUuid);
		baselineComponentIds = allComponentIds(baseline);
		const preImportSource = await currentPcbSource(ids.projectUuid, ids.targetPcbUuid, ids.schematicUuid);
		if (effectiveSignature(parsePcbSource(preImportSource, ids.targetPcbUuid)) !== effectiveSignature(baseline))
			fail('force import 前目标 PCB 有效内容已变化');
		await assertCurrentTarget(ids.projectUuid, ids.targetPcbUuid, ids.schematicUuid);

		const runtimePcbDocument = eda.pcb_Document as unknown as RuntimePcbImportChanges;
		writeAttempted = true;
		const importResult = await runtimePcbDocument.importChanges(ids.schematicUuid, true);
		if (importResult !== true)
			return makeResult('unknown', writeAttempted, ids, baselineComponentIds, { reason: 'force importChanges 未返回 true；不重试或回退' });

		const deadline = Date.now() + READBACK_BUDGET_MS;
		let previousStable: { sourceSignature: string; padsSignature: string } | undefined;
		let latestReason = '等待 force import 的完整目标读回';
		while (true) {
			const source = await currentPcbSource(ids.projectUuid, ids.targetPcbUuid, ids.schematicUuid);
			const parsed = parsePcbSource(source, ids.targetPcbUuid);
			const classified = classifyTarget(parsed, baseline, expectations, expectedNets);
			const componentIdByUid = new Map<string, string>();
			for (const expected of expectations) {
				const matches = classified.componentIdsByUid.get(expected.targetUid) ?? [];
				if (matches.length === 1) componentIdByUid.set(expected.targetUid, matches[0]);
			}
			const typedReadback = classified.complete ? await readTargetPads(expectations, componentIdByUid, parsed) : undefined;
			const templatePhysicalVerification = input.templateInstances
				? verifyTemplatePhysical(baselineSource, source, input.templateInstances, typedReadback ? { actualTargetPads: typedReadback.actualPads } : {})
				: undefined;
			const explainedPhysicalAdditions = new Set((templatePhysicalVerification?.explainedAdded ?? []).map(item => `${item.type}\u0000${item.id}`));
			const nonPhysicalUnexpected = classified.comparison.unexpectedDifferences.filter(diff =>
				!(templatePhysicalVerification && diff.kind === 'added' && explainedPhysicalAdditions.has(`${diff.type}\u0000${diff.id}`)));
			const componentIds = allComponentIds(parsed);
			const beforeIds = new Set(baselineComponentIds);
			const newComponentIds = componentIds.filter(id => !beforeIds.has(id)).sort();
			const resultData: Partial<NativePcbImportResult> = {
				newComponentIds,
				differences: classified.comparison.differences,
				defaultMetadataDifferences: classified.comparison.defaultMetadataDifferences,
				importDifferences: classified.comparison.importDifferences,
				unexpectedDifferences: nonPhysicalUnexpected,
				...(templatePhysicalPreflight ? { templatePhysicalPreflight } : {}),
				...(templatePhysicalVerification ? { templatePhysicalVerification } : {}),
			};
			lastResultData = resultData;
			latestReason = classified.reason;
			const actualPads = typedReadback?.actualPads;
			if (actualPads) {
				resultData.actualPads = actualPads;
				lastResultData = resultData;
			}
			if (typedReadback) await assertCurrentTarget(ids.projectUuid, ids.targetPcbUuid, ids.schematicUuid);
			if (nonPhysicalUnexpected.length) {
				return makeResult('unknown', writeAttempted, ids, baselineComponentIds, { ...resultData,
					reason: `读回中发现非预期 PCB 变化：${nonPhysicalUnexpected.map(item => `${item.type}/${item.id}`).join(', ')}` });
			}
			if (templatePhysicalVerification && (templatePhysicalVerification.changedExisting.length
				|| templatePhysicalVerification.removedExisting.length || templatePhysicalVerification.unexplainedAdded.length)) {
				return makeResult('unknown', writeAttempted, ids, baselineComponentIds, {
					...resultData,
					reason: `模板物理核验发现目标 PCB 的既有内容变化或未解释对象：${JSON.stringify({
						changedExisting: templatePhysicalVerification.changedExisting,
						removedExisting: templatePhysicalVerification.removedExisting,
						unexplainedAdded: templatePhysicalVerification.unexplainedAdded,
						physicalAssociationErrors: templatePhysicalVerification.physicalAssociationErrors,
						componentAssociationErrors: templatePhysicalVerification.componentAssociationErrors,
						padNetAssociationErrors: templatePhysicalVerification.padNetAssociationErrors,
						pouredAssociationErrors: templatePhysicalVerification.pouredAssociationErrors,
					})}`,
				});
			}
			if (classified.complete && typedReadback && !typedReadback.matches) {
				previousStable = undefined;
				latestReason = 'typed 或源码 PAD_NET 焊盘编号/网络与预期不一致';
			}
			else if (classified.complete && typedReadback?.matches
				&& (!templatePhysicalVerification || templatePhysicalVerification.verified)) {
				const sourceSignature = effectiveSignature(parsed);
				const padsSignature = stable(actualPads);
				if (previousStable?.sourceSignature === sourceSignature && previousStable.padsSignature === padsSignature) {
					return makeResult('confirmed', writeAttempted, ids, baselineComponentIds, { ...resultData, reason: '预期器件与 typed 焊盘读回连续稳定；只确认器件导入阶段' });
				}
				previousStable = { sourceSignature, padsSignature };
				latestReason = '目标内容已到齐，继续复读确认有效源码与 typed 焊盘稳定';
			}
			else if (classified.complete && typedReadback?.matches && templatePhysicalVerification) {
				previousStable = undefined;
				latestReason = `等待模板物理对象完整对应：${JSON.stringify({
					missingExpected: templatePhysicalVerification.missingExpected.length,
					unexplainedAdded: templatePhysicalVerification.unexplainedAdded.length,
					changedExisting: templatePhysicalVerification.changedExisting.length,
					removedExisting: templatePhysicalVerification.removedExisting.length,
					componentAssociationErrors: templatePhysicalVerification.componentAssociationErrors,
					padNetAssociationErrors: templatePhysicalVerification.padNetAssociationErrors,
					pouredAssociationErrors: templatePhysicalVerification.pouredAssociationErrors,
					hostGeneratedPoured: templatePhysicalVerification.hostGeneratedPoured,
				})}`;
			}
			else previousStable = undefined;

			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(READBACK_POLL_INTERVAL_MS, remaining)));
		}
		return makeResult('unknown', writeAttempted, ids, baselineComponentIds, { ...lastResultData, reason: `force import 读回超时：${latestReason}` });
	}
	catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return makeResult(writeAttempted ? 'unknown' : 'not_started', writeAttempted, ids, baselineComponentIds, {
			...lastResultData,
			reason: writeAttempted ? `${reason}；导入已尝试，不重发、不回退` : reason,
		});
	}
}
