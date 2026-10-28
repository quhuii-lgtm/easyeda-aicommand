import type { ICommandDef } from '../engine/types';
import type { GeometryHost } from '../pcb/geometryHost';
import {
	circlePolygonSource,
	numbersEqual,
	padShapeForSdk,
	stableJson,
	validatePlaceHole,
	validatePlacePad,
} from '../engine/padHole';
import { createGeometryHost } from '../pcb/geometryHost';
import { parseSourceLog, recordKey, resolveRecords } from '../pcb/sourcelog';

const TOP = 1;
const BOTTOM = 2;
const MULTI = 12;
const FILL_SOLID = 0;

type SourceSnapshot = ReturnType<typeof parseSourceLog>;

interface SourceVerificationReport {
	reticketedExistingRecordCount: number;
	allowedAuxiliaryRecords: Array<{ type: string; id: string }>;
}

function state<T = unknown>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`];
	return typeof getter === 'function' ? getter.call(object) as T : undefined;
}

function sourceWithoutDocHead(document: SourceSnapshot): string {
	return document.records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n');
}

async function readSource(host: GeometryHost, label: string): Promise<SourceSnapshot> {
	return host.read(label, async () => {
		const source = await host.sdk.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string')
			throw new Error(`${label} 未返回字符串源码`);
		const document = parseSourceLog(source);
		if (document.uuid !== host.documentUuid || document.docType.toUpperCase() !== 'PCB')
			throw new Error(`${label} 的 DOCHEAD 与当前 PCB 不符`);
		return document;
	});
}

const EMPTY_NET_DATA = { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null };
const EMPTY_NET_SELECTOR_DATA = { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null };

function sourceRowsByKey(document: SourceSnapshot): Map<string, Array<SourceSnapshot['records'][number]>> {
	const rows = new Map<string, Array<SourceSnapshot['records'][number]>>();
	for (const record of document.records) {
		if (record.header.type === 'DOCHEAD')
			continue;
		const key = recordKey(record);
		const current = rows.get(key) ?? [];
		current.push(record);
		rows.set(key, current);
	}
	return rows;
}

function assertDocHeadStable(before: SourceSnapshot, after: SourceSnapshot): void {
	const beforeHeads = before.records.filter(record => record.header.type === 'DOCHEAD');
	const afterHeads = after.records.filter(record => record.header.type === 'DOCHEAD');
	if (beforeHeads.length !== 1 || afterHeads.length !== 1)
		throw new Error('创建前后必须各有且仅有一条 DOCHEAD');
	const oldHead = beforeHeads[0];
	const newHead = afterHeads[0];
	const oldHeader = { ...oldHead.header };
	const newHeader = { ...newHead.header };
	if (stableJson(oldHeader) !== stableJson(newHeader))
		throw new Error('创建操作改动了 DOCHEAD header');
	const oldData = { ...(oldHead.data as Record<string, unknown>) };
	const newData = { ...(newHead.data as Record<string, unknown>) };
	for (const key of ['client', 'updateTime', 'version']) {
		delete oldData[key];
		delete newData[key];
	}
	if (stableJson(oldData) !== stableJson(newData))
		throw new Error('创建操作改动了 DOCHEAD 的身份或非挥发字段');
}

function assertOldSourceUnchanged(before: SourceSnapshot, after: SourceSnapshot): { beforeRows: Map<string, Array<SourceSnapshot['records'][number]>>; afterRows: Map<string, Array<SourceSnapshot['records'][number]>>; reticketedExistingRecordCount: number } {
	assertDocHeadStable(before, after);
	const beforeRows = sourceRowsByKey(before);
	const afterRows = sourceRowsByKey(after);
	let reticketedExistingRecordCount = 0;
	for (const [key, oldRecords] of beforeRows) {
		const newRecords = afterRows.get(key) ?? [];
		if (newRecords.length < oldRecords.length)
			throw new Error(`创建后缺少原源码记录 ${key}`);
		for (let index = 0; index < oldRecords.length; index++) {
			const oldRecord = oldRecords[index];
			const newRecord = newRecords[index];
			const oldHeader = { ...oldRecord.header };
			const newHeader = { ...newRecord.header };
			delete oldHeader.ticket;
			delete newHeader.ticket;
			if (stableJson(oldHeader) !== stableJson(newHeader) || stableJson(oldRecord.data) !== stableJson(newRecord.data))
				throw new Error(`创建操作改动了非目标源码记录 ${key}`);
			if (oldRecord.header.ticket !== newRecord.header.ticket)
				reticketedExistingRecordCount++;
		}
	}
	return { beforeRows, afterRows, reticketedExistingRecordCount };
}

function netAuxiliaryIds(netName: string): { netId: string; selectorId: string; netKey: string; selectorKey: string } {
	const netId = JSON.stringify(['NET', netName]);
	const selectorId = JSON.stringify(['RULE_SELECTOR', ['NET', netName]]);
	return { netId, selectorId, netKey: `NET\u0000${netId}`, selectorKey: `RULE_SELECTOR\u0000${selectorId}` };
}

function isExactNetAuxiliary(record: SourceSnapshot['records'][number], netName: string): boolean {
	const { netId, selectorId } = netAuxiliaryIds(netName);
	if (record.header.type === 'NET' && record.header.id === netId)
		return stableJson(record.data) === stableJson(EMPTY_NET_DATA);
	if (record.header.type === 'RULE_SELECTOR' && record.header.id === selectorId)
		return stableJson(record.data) === stableJson(EMPTY_NET_SELECTOR_DATA);
	return false;
}

function assertOneNewSourceRecord(before: SourceSnapshot, after: SourceSnapshot, type: 'PAD' | 'FILL', id: string, allowedAuxiliaryNet?: string): { data: Record<string, any>; report: SourceVerificationReport } {
	const { beforeRows, afterRows, reticketedExistingRecordCount } = assertOldSourceUnchanged(before, after);
	const additions = [...afterRows].flatMap(([key, records]) => records.slice(beforeRows.get(key)?.length ?? 0));
	const target = additions.filter(record => record.header.type === type && record.header.id === id && record.data !== '');
	if (target.length !== 1)
		throw new Error(`源码新增记录必须唯一对应 ${type} ${id}，实际=${stableJson(additions.map(record => ({ type: record.header.type, id: record.header.id })))}`);
	const auxiliary = additions.filter(record => record !== target[0]);
	if (auxiliary.length > 0) {
		const allowedIds = allowedAuxiliaryNet === undefined ? undefined : netAuxiliaryIds(allowedAuxiliaryNet);
		if (allowedAuxiliaryNet === undefined || !allowedIds || beforeRows.has(allowedIds.netKey) || beforeRows.has(allowedIds.selectorKey)
			|| auxiliary.length !== 2 || !auxiliary.every(record => isExactNetAuxiliary(record, allowedAuxiliaryNet))
			|| !auxiliary.some(record => record.header.type === 'NET') || !auxiliary.some(record => record.header.type === 'RULE_SELECTOR')) {
			throw new Error(`源码包含未批准的新增记录：${stableJson(auxiliary.map(record => ({ type: record.header.type, id: record.header.id, data: record.data })))}`);
		}
	}
	const data = target[0].data;
	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw new Error(`完整源码未读到新建 ${type} ${id} 的有效记录`);
	return {
		data: data as Record<string, any>,
		report: {
			reticketedExistingRecordCount,
			allowedAuxiliaryRecords: auxiliary.map(record => ({ type: record.header.type, id: String(record.header.id ?? '') })),
		},
	};
}

function sourcePadShape(shape: unknown[]): Record<string, unknown> | undefined {
	const [type, width, height, round] = shape;
	if ((type !== 'ELLIPSE' && type !== 'RECT') || typeof width !== 'number' || typeof height !== 'number')
		return undefined;
	if (type === 'RECT' && (typeof round !== 'number' || !Number.isFinite(round)))
		return undefined;
	return type === 'RECT'
		? { padType: type, width, height, radius: round }
		: { padType: type, width, height };
}

function holeSourceMatches(actual: unknown, expected: unknown): boolean {
	if (expected == null)
		return actual == null;
	if (!Array.isArray(expected) || expected.length !== 2 || expected[0] !== 'ROUND' || typeof expected[1] !== 'number'
		|| !actual || typeof actual !== 'object' || Array.isArray(actual)) {
		return false;
	}
	const hole = actual as Record<string, unknown>;
	return hole.holeType === 'ROUND' && numbersEqual(hole.width, expected[1]) && numbersEqual(hole.height, expected[1])
		&& typeof hole.cornerRadius === 'number' && Number.isFinite(hole.cornerRadius)
		&& Object.keys(hole).every(key => ['holeType', 'width', 'height', 'cornerRadius'].includes(key));
}

function sourcePolygonPath(sdkSource: unknown): unknown {
	if (Array.isArray(sdkSource) && typeof sdkSource[0] === 'string')
		return [sdkSource];
	return sdkSource;
}

const MASK_FIELDS = ['topSolderMask', 'bottomSolderMask', 'topPasteMask', 'bottomPasteMask'] as const;

function maskGetterMatches(value: unknown, requested: unknown): value is Record<string, number | null> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	if (!MASK_FIELDS.every(field => Object.hasOwn(record, field)))
		return false;
	const requestedRecord = requested && typeof requested === 'object' && !Array.isArray(requested)
		? requested as Record<string, unknown>
		: undefined;
	return MASK_FIELDS.every((field) => {
		const actual = record[field];
		const explicit = requestedRecord != null && Object.hasOwn(requestedRecord, field);
		if (explicit)
			return typeof actual === 'number' && Number.isFinite(actual) && numbersEqual(actual, requestedRecord![field] as number);
		if (requested == null)
			return typeof actual === 'number' && Number.isFinite(actual);
		return actual === null || (typeof actual === 'number' && Number.isFinite(actual));
	});
}

function maskSourceMatches(source: Record<string, any>, requested: unknown): boolean {
	const requestedRecord = requested && typeof requested === 'object' && !Array.isArray(requested)
		? requested as Record<string, number>
		: undefined;
	return MASK_FIELDS.every((field) => {
		const sourceField = field === 'topSolderMask'
			? 'topSolderExpansion'
			: field === 'bottomSolderMask'
				? 'bottomSolderExpansion'
				: field === 'topPasteMask'
					? 'topPasteExpansion'
					: 'bottomPasteExpansion';
		const actual = source[sourceField];
		if (requestedRecord != null && Object.hasOwn(requestedRecord, field))
			return typeof actual === 'number' && Number.isFinite(actual) && numbersEqual(actual, requestedRecord[field]);
		return actual === null;
	});
}

function maskReadbackReport(requested: unknown, effective: unknown): Record<string, unknown> {
	const requestedRecord = requested && typeof requested === 'object' && !Array.isArray(requested)
		? requested as Record<string, unknown>
		: undefined;
	const getterRecord = effective && typeof effective === 'object' && !Array.isArray(effective)
		? effective as Record<string, unknown>
		: {};
	const fields = Object.fromEntries(MASK_FIELDS.map((field) => {
		const explicit = requestedRecord != null && Object.hasOwn(requestedRecord, field);
		const getterValue = getterRecord[field];
		return [field, {
			mode: explicit ? 'explicit' : 'inherited',
			requested: explicit ? requestedRecord![field] : null,
			getter: getterValue,
			effectiveResolved: typeof getterValue === 'number' && Number.isFinite(getterValue),
		}];
	}));
	const hasExplicitFields = requestedRecord != null && MASK_FIELDS.some(field => Object.hasOwn(requestedRecord, field));
	return {
		requested: requested ?? null,
		mode: !hasExplicitFields ? 'inherited' : MASK_FIELDS.every(field => Object.hasOwn(requestedRecord!, field)) ? 'explicit' : 'partial',
		effective,
		effectiveResolved: MASK_FIELDS.every(field => typeof getterRecord[field] === 'number' && Number.isFinite(getterRecord[field])),
		fields,
	};
}

function normalizeMaskRequest(requested: unknown): Record<string, number> | null {
	if (!requested || typeof requested !== 'object' || Array.isArray(requested))
		return null;
	const record = requested as Record<string, number>;
	return MASK_FIELDS.some(field => Object.hasOwn(record, field)) ? record : null;
}

function isPartialMaskRequest(requested: Record<string, number> | null): requested is Record<string, number> {
	return requested !== null && MASK_FIELDS.some(field => Object.hasOwn(requested, field))
		&& !MASK_FIELDS.every(field => Object.hasOwn(requested, field));
}

function sourceDataWithoutMask(data: Record<string, any>): Record<string, any> {
	const copy = { ...data };
	for (const key of ['topSolderExpansion', 'bottomSolderExpansion', 'topPasteExpansion', 'bottomPasteExpansion'])
		delete copy[key];
	return copy;
}

function assertSourceSnapshotUnchanged(before: SourceSnapshot, after: SourceSnapshot, label: string): void {
	assertDocHeadStable(before, after);
	const beforeRows = sourceRowsByKey(before);
	const afterRows = sourceRowsByKey(after);
	if (beforeRows.size !== afterRows.size)
		throw new Error(`${label} 增删了源码记录身份`);
	for (const [key, oldRecords] of beforeRows) {
		const newRecords = afterRows.get(key) ?? [];
		if (newRecords.length !== oldRecords.length)
			throw new Error(`${label} 改变了源码记录数量 ${key}`);
		for (let index = 0; index < oldRecords.length; index++) {
			const oldHeader = { ...oldRecords[index].header };
			const newHeader = { ...newRecords[index].header };
			delete oldHeader.ticket;
			delete newHeader.ticket;
			if (stableJson(oldHeader) !== stableJson(newHeader) || stableJson(oldRecords[index].data) !== stableJson(newRecords[index].data))
				throw new Error(`${label} 改动了既有源码记录 ${key}`);
		}
	}
}

function assertOnlyPadMaskChanged(before: SourceSnapshot, after: SourceSnapshot, id: string, expectedMask: Record<string, number>): Record<string, any> {
	assertDocHeadStable(before, after);
	const beforeRows = sourceRowsByKey(before);
	const afterRows = sourceRowsByKey(after);
	const targetKey = `PAD\u0000${id}`;
	if (!beforeRows.has(targetKey))
		throw new Error(`阻焊修改前缺少新建 PAD 源码 ${id}`);
	let finalData: Record<string, any> | undefined;
	for (const key of new Set([...beforeRows.keys(), ...afterRows.keys()])) {
		const oldRecords = beforeRows.get(key) ?? [];
		const newRecords = afterRows.get(key) ?? [];
		if (key !== targetKey) {
			if (oldRecords.length !== newRecords.length)
				throw new Error(`阻焊修改新增或删除非目标源码记录 ${key}`);
			for (let index = 0; index < oldRecords.length; index++) {
				const oldHeader = { ...oldRecords[index].header };
				const newHeader = { ...newRecords[index].header };
				delete oldHeader.ticket;
				delete newHeader.ticket;
				if (stableJson(oldHeader) !== stableJson(newHeader) || stableJson(oldRecords[index].data) !== stableJson(newRecords[index].data))
					throw new Error(`阻焊修改改动了非目标源码记录 ${key}`);
			}
			continue;
		}
		if (oldRecords.length !== 1 || newRecords.length < 1 || newRecords.length > 2)
			throw new Error(`阻焊修改对目标 PAD ${id} 产生了意外源码记录数量`);
		const oldTarget = oldRecords[0];
		const newTarget = newRecords[newRecords.length - 1];
		const oldHeader = { ...oldTarget.header };
		const newHeader = { ...newTarget.header };
		delete oldHeader.ticket;
		delete newHeader.ticket;
		if (stableJson(oldHeader) !== stableJson(newHeader)
			|| stableJson(sourceDataWithoutMask(oldTarget.data as Record<string, any>)) !== stableJson(sourceDataWithoutMask(newTarget.data as Record<string, any>))) {
			throw new Error(`阻焊修改改变了目标 PAD ${id} 的非阻焊字段`);
		}
		if (newRecords.length === 2) {
			const oldVersionHeader = { ...newRecords[0].header };
			const originalHeader = { ...oldTarget.header };
			delete oldVersionHeader.ticket;
			delete originalHeader.ticket;
			if (stableJson(oldVersionHeader) !== stableJson(originalHeader)
				|| stableJson(newRecords[0].data) !== stableJson(oldTarget.data)) {
				throw new Error(`阻焊修改未保留目标 PAD ${id} 原始源码版本`);
			}
		}
		finalData = newTarget.data as Record<string, any>;
		const sourceFields: Record<string, string> = {
			topSolderMask: 'topSolderExpansion',
			bottomSolderMask: 'bottomSolderExpansion',
			topPasteMask: 'topPasteExpansion',
			bottomPasteMask: 'bottomPasteExpansion',
		};
		for (const field of MASK_FIELDS) {
			const value = finalData[sourceFields[field]];
			if (typeof value !== 'number' || !Number.isFinite(value) || !numbersEqual(value, expectedMask[field]))
				throw new Error(`阻焊修改后的目标 PAD ${id} 源码字段 ${field} 与应用值不符`);
		}
	}
	const targetRecords = afterRows.get(targetKey) ?? [];
	if (targetRecords.length < 1)
		throw new Error(`阻焊修改后的源码缺少目标 PAD ${id}`);
	const oldTarget = (beforeRows.get(targetKey) ?? [])[0];
	const winningTarget = resolveRecords(after, 'PAD').get(targetKey);
	const lastTarget = targetRecords[targetRecords.length - 1];
	if (!oldTarget || winningTarget?.raw !== lastTarget.raw)
		throw new Error(`阻焊修改后的目标 PAD ${id} 不是有效 ticket 版本`);
	const oldTicket = oldTarget.header.ticket;
	const newTicket = lastTarget.header.ticket;
	if (typeof newTicket !== 'number' || !Number.isFinite(newTicket)
		|| (targetRecords.length === 2 && typeof oldTicket === 'number' && Number.isFinite(oldTicket) && newTicket <= oldTicket)) {
		throw new Error(`阻焊修改后的目标 PAD ${id} ticket 未有效递增`);
	}
	if (!finalData)
		throw new Error(`阻焊修改后的源码缺少目标 PAD ${id}`);
	return finalData;
}

function maskSnapshotReport(requested: Record<string, number>, defaultsReadback: Record<string, number>, applied: Record<string, number>): Record<string, unknown> {
	const defaultedFields = MASK_FIELDS.filter(field => !Object.hasOwn(requested, field));
	return {
		mode: 'explicit-with-default-snapshot',
		requested,
		defaultsReadback,
		applied,
		defaultedFields,
		semantics: '未提供字段已按创建时 getter 读回值显式固定，不是未来动态继承',
	};
}

async function applyPartialMaskSnapshot(host: GeometryHost, originalSource: SourceSnapshot, originalRules: unknown, id: string, layer: number, x: number, y: number, shape: unknown[], net: string, hole: unknown, plated: boolean, requested: Record<string, number>, setStage: (stage: string) => void, progress: Record<string, unknown>): Promise<{ defaultsReadback: Record<string, number>; applied: Record<string, number>; data: Record<string, any>; geometryReadback: Record<string, unknown>; sourceVerification: Record<string, unknown> }> {
	setStage('readback-created-pad-before-mask-snapshot');
	const createdObject = await host.read(`部分阻焊写入前按 ID 读回 PAD ${id}`, async () => await host.sdk.pcb_PrimitivePad.get(id));
	if (!createdObject)
		throw new Error(`部分阻焊创建后的 PAD ${id} 按 ID 读回为空`);
	const createReadback = assertPadReadback(createdObject, id, layer, x, y, shape, net, hole, plated, null);
	const defaultsReadback = createReadback.mask as Record<string, number>;
	progress.defaultsReadback = { ...defaultsReadback };
	const allAfterCreate = await readExistingIds(host, 'pad');
	if (!allAfterCreate.has(id))
		throw new Error(`部分阻焊创建的 PAD ${id} 不在 pcb_PrimitivePad.getAll() 中`);
	setStage('verify-created-pad-source-before-mask-snapshot');
	const afterCreate = await readSource(host, `部分阻焊修改前读取 PAD 完整源码 ${id}`);
	const { data: createdData, report: createSourceVerification } = assertOneNewSourceRecord(originalSource, afterCreate, 'PAD', id, net);
	assertPadSource(createdData, id, layer, x, y, shape, net, hole, plated, null);
	const applied = { ...defaultsReadback, ...requested };
	progress.applied = { ...applied };
	const pendingBaseline = await readSource(host, `部分阻焊写入前重核 PAD 源码基线 ${id}`);
	assertSourceSnapshotUnchanged(afterCreate, pendingBaseline, `部分阻焊写入前基线 ${id}`);
	setStage('refresh-pad-and-rule-baseline-before-mask-modify');
	const freshObject = await host.read(`部分阻焊修改前刷新 PAD ${id} 的几何与默认值`, async () => await host.sdk.pcb_PrimitivePad.get(id));
	if (!freshObject)
		throw new Error(`部分阻焊修改前 PAD ${id} 刷新读回为空`);
	const freshReadback = assertPadReadback(freshObject, id, layer, x, y, shape, net, hole, plated, null);
	if (stableJson(freshReadback) !== stableJson(createReadback))
		throw new Error(`部分阻焊修改前 PAD ${id} 的几何或默认值已变化`);
	const freshSource = await readSource(host, `部分阻焊修改前最终读取 PAD 源码 ${id}`);
	assertSourceSnapshotUnchanged(afterCreate, freshSource, `部分阻焊修改前最终基线 ${id}`);
	const freshRules = await host.read('部分阻焊修改前刷新 PCB DRC 规则', async () => {
		const value = await host.sdk.pcb_Drc.getCurrentRuleConfiguration();
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0)
			throw new Error('阻焊修改前未取得有效 PCB DRC 规则');
		return value;
	});
	if (stableJson(freshRules) !== stableJson(originalRules))
		throw new Error('部分阻焊修改前 PCB DRC 规则已变化');
	if (typeof host.sdk.pcb_PrimitivePad?.modify !== 'function')
		throw new Error('pcb_PrimitivePad.modify() 不存在，已创建 PAD 但未应用部分阻焊请求');
	setStage('modify-mask-from-default-snapshot');
	await host.write(`按 ID 应用部分阻焊快照 ${id}`, async () => await host.sdk.pcb_PrimitivePad.modify(id, { solderMaskAndPasteMaskExpansion: applied } as any));
	setStage('readback-mask-modified-pad');
	const modifiedObject = await host.read(`部分阻焊修改后按 ID 读回 PAD ${id}`, async () => await host.sdk.pcb_PrimitivePad.get(id));
	if (!modifiedObject)
		throw new Error(`部分阻焊修改后的 PAD ${id} 按 ID 读回为空`);
	const finalReadback = assertPadReadback(modifiedObject, id, layer, x, y, shape, net, hole, plated, applied);
	const allAfterModify = await readExistingIds(host, 'pad');
	if (!allAfterModify.has(id))
		throw new Error(`部分阻焊修改后的 PAD ${id} 不在 pcb_PrimitivePad.getAll() 中`);
	setStage('verify-mask-modified-pad-source');
	const afterModify = await readSource(host, `部分阻焊修改后读取 PAD 完整源码 ${id}`);
	const data = assertOnlyPadMaskChanged(afterCreate, afterModify, id, applied);
	assertPadSource(data, id, layer, x, y, shape, net, hole, plated, applied);
	host.recordVerified(id);
	return {
		defaultsReadback,
		applied,
		data,
		geometryReadback: padGeometryReadbackReport({ x, y, shape }, finalReadback, data),
		sourceVerification: {
			create: createSourceVerification,
			maskModify: { targetId: id, appliedFields: MASK_FIELDS, sourceRecordCount: afterModify.records.filter(record => record.header.type === 'PAD' && record.header.id === id).length },
		},
	};
}

interface PadGetterReadback {
	mask: unknown;
	x: number;
	y: number;
	shape: unknown[];
}

function quantizedTenth(value: number): number {
	return Math.round(value * 10) / 10;
}

function matchesExactOrTenthQuantization(actual: unknown, requested: number): boolean {
	return typeof actual === 'number' && Number.isFinite(actual)
		&& (actual === requested || actual === quantizedTenth(requested));
}

function padShapeGetterMatches(actual: unknown, requested: unknown[]): boolean {
	if (!Array.isArray(actual) || actual.length !== requested.length || actual[0] !== requested[0])
		return false;
	if (requested[0] !== 'ELLIPSE')
		return stableJson(actual) === stableJson(requested);
	return matchesExactOrTenthQuantization(actual[1], requested[1] as number)
		&& matchesExactOrTenthQuantization(actual[2], requested[2] as number);
}

function padGeometryReadbackReport(requested: { x: number; y: number; shape: unknown[] }, getter: PadGetterReadback, source: Record<string, any>): Record<string, unknown> {
	const quantizedFields: string[] = [];
	if (getter.x !== requested.x)
		quantizedFields.push('x');
	if (getter.y !== requested.y)
		quantizedFields.push('y');
	if (requested.shape[0] === 'ELLIPSE') {
		if (getter.shape[1] !== requested.shape[1])
			quantizedFields.push('shape.width');
		if (getter.shape[2] !== requested.shape[2])
			quantizedFields.push('shape.height');
	}
	return {
		requested: { x: requested.x, y: requested.y, shape: requested.shape },
		actualGetter: { x: getter.x, y: getter.y, shape: getter.shape },
		source: { x: source.centerX, y: source.centerY, shape: source.defaultPad },
		quantizedFields,
	};
}

function assertPadReadback(object: any, id: string, layer: number, x: number, y: number, shape: unknown[], net: string, hole: unknown, plated: boolean, mask: unknown): PadGetterReadback {
	const actualId = state<string>(object, 'PrimitiveId');
	const actualType = state<string>(object, 'PrimitiveType');
	const actualLayer = state<number>(object, 'Layer');
	const actualPadNumber = state<string>(object, 'PadNumber');
	const actualX = state<number>(object, 'X');
	const actualY = state<number>(object, 'Y');
	const actualRotation = state<number>(object, 'Rotation');
	const actualShape = state<unknown[]>(object, 'Pad');
	const actualNet = state<string | null>(object, 'Net');
	const actualHole = state(object, 'Hole');
	const actualHoleOffsetX = state<number>(object, 'HoleOffsetX');
	const actualHoleOffsetY = state<number>(object, 'HoleOffsetY');
	const actualPlated = state<boolean>(object, 'Metallization');
	const actualPadType = state<number>(object, 'PadType');
	const actualMask = state(object, 'SolderMaskAndPasteMaskExpansion');
	const actualLock = state<boolean>(object, 'PrimitiveLock');
	const netMatches = net ? actualNet === net : [undefined, null, ''].includes(actualNet as any);
	const maskMatches = maskGetterMatches(actualMask, mask);
	const holeOffsetsMatch = hole == null || (numbersEqual(actualHoleOffsetX, 0) && numbersEqual(actualHoleOffsetY, 0));
	if (actualId !== id || actualType !== 'Pad' || actualLayer !== layer || actualPadNumber !== ''
		|| !matchesExactOrTenthQuantization(actualX, x) || !matchesExactOrTenthQuantization(actualY, y) || !numbersEqual(actualRotation, 0)
		|| !padShapeGetterMatches(actualShape, shape) || !netMatches
		|| stableJson(actualHole ?? null) !== stableJson(hole) || !holeOffsetsMatch || actualPlated !== plated || actualPadType !== 0 || actualLock !== false
		|| !maskMatches) {
		throw new Error(`新焊盘 ${id} 的独立 SDK 读回属性与请求不符：${stableJson({ actualId, actualType, actualLayer, actualPadNumber, actualX, actualY, actualRotation, actualShape, actualNet, actualHole, actualHoleOffsetX, actualHoleOffsetY, actualPlated, actualPadType, actualMask, actualLock })}`);
	}
	return { mask: actualMask, x: actualX as number, y: actualY as number, shape: actualShape as unknown[] };
}

function assertPadSource(data: Record<string, any>, id: string, layer: number, x: number, y: number, shape: unknown[], net: string, hole: unknown, plated: boolean, mask: any): void {
	const expectedShape = sourcePadShape(shape);
	const shapeMatches = expectedShape !== undefined && stableJson(data.defaultPad) === stableJson(expectedShape);
	const holeMatches = holeSourceMatches(data.hole ?? null, hole);
	const netMatches = data.netName === net;
	const holeOffsetsMatch = hole == null || (numbersEqual(data.padOffsetX, 0) && numbersEqual(data.padOffsetY, 0));
	const maskMatches = maskSourceMatches(data, mask);
	if (!shapeMatches || !holeMatches || data.layerId !== layer || data.centerX !== x || data.centerY !== y
		|| data.padAngle !== 0 || data.plated !== plated || data.padType !== 'NORMAL' || data.num !== '' || !netMatches || !holeOffsetsMatch || !maskMatches) {
		throw new Error(`新焊盘 ${id} 的源码几何/孔/层/网络/阻焊读回与请求不符：${stableJson({ id, data, expected: { layer, x, y, shape, net, hole, plated, mask } })}`);
	}
}

async function readExistingIds(host: GeometryHost, type: 'pad' | 'fill'): Promise<Set<string>> {
	const api = type === 'pad' ? host.sdk.pcb_PrimitivePad : host.sdk.pcb_PrimitiveFill;
	return host.read(`读取现有${type === 'pad' ? '焊盘' : '填充'} ID`, async () => {
		if (typeof api?.getAll !== 'function')
			throw new Error(`pcb_Primitive${type === 'pad' ? 'Pad' : 'Fill'}.getAll() 不存在`);
		const values = await api.getAll();
		if (!Array.isArray(values))
			throw new Error('公开 getAll() 未返回完整数组');
		const ids = values.map((item: any) => state<string>(item, 'PrimitiveId'));
		if (ids.some((id: unknown) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
			throw new Error('getAll() 中含无效或重复图元 ID');
		return new Set(ids as string[]);
	});
}

async function placeHole(params: Record<string, any>) {
	const input = validatePlaceHole(params);
	const host = await createGeometryHost(eda, params);
	const created: Record<string, unknown>[] = [];
	let stage = 'preflight';
	try {
		const baseline = await host.getBaseline();
		const before = await readSource(host, '读取安装孔写入前完整源码');
		if (sourceWithoutDocHead(before) !== baseline.source)
			throw new Error('安装孔写入前完整源码与 GeometryHost 基线不一致');
		const isBareMechanical = input.padDiameter === undefined;
		const apiType = isBareMechanical ? 'fill' : 'pad';
		const existingIds = await readExistingIds(host, apiType);
		await host.assertBaseline(baseline);
		const requestedHole = ['ROUND', input.holeDiameter];
		const mask = normalizeMaskRequest(input.solderMaskAndPasteMaskExpansion);
		const partialMask = isPartialMaskRequest(mask);
		if (partialMask && typeof host.sdk.pcb_PrimitivePad?.modify !== 'function')
			throw new Error('部分阻焊请求需要 pcb_PrimitivePad.modify()；未执行创建');
		let object: any;
		if (isBareMechanical) {
			stage = 'create-multi-layer-npth-cutout';
			const source = circlePolygonSource(input.x, input.y, input.holeDiameter);
			const polygon = await host.read('构造正式 CIRCLE 多边形', async () => {
				if (typeof host.sdk.pcb_MathPolygon?.createPolygon !== 'function')
					throw new Error('pcb_MathPolygon.createPolygon() 不存在，无法安全表达圆形孔');
				const value = host.sdk.pcb_MathPolygon.createPolygon(source);
				if (!value || typeof value.getSource !== 'function' || stableJson(value.getSource()) !== stableJson(source))
					throw new Error('SDK 未按正式 CIRCLE 源格式返回圆形多边形');
				return value;
			});
			const existing = new Set([...existingIds]);
			object = await host.write('创建无铜多层 NPTH 挖孔区域', async () => await host.sdk.pcb_PrimitiveFill.create(MULTI, polygon, '', FILL_SOLID, 0, false));
			if (!object)
				throw new Error('pcb_PrimitiveFill.create() 返回空值，结果未知');
			const id = String(state<string>(object, 'PrimitiveId') ?? '');
			if (!id || existing.has(id))
				throw new Error('填充创建返回的图元 ID 缺失或执行前已存在，结果未知');
			host.recordCreated(id);
			stage = 'readback-hole-fill';
			const readback = await host.read(`按 ID 读回机械孔填充 ${id}`, async () => await host.sdk.pcb_PrimitiveFill.get(id));
			if (!readback)
				throw new Error(`机械孔填充 ${id} 按 ID 读回为空`);
			const all = await readExistingIds(host, 'fill');
			const actualPolygon = state<any>(readback, 'ComplexPolygon');
			const actualSource = actualPolygon?.getSource?.();
			const actualLineWidth = state<number>(readback, 'LineWidth');
			const matches = state(readback, 'PrimitiveId') === id && state(readback, 'PrimitiveType') === 'Fill'
				&& state(readback, 'Layer') === MULTI && state(readback, 'FillMode') === FILL_SOLID
				&& (actualLineWidth === 0 || actualLineWidth === 1) && state(readback, 'PrimitiveLock') === false
				&& [undefined, null, ''].includes(state(readback, 'Net') as any)
				&& stableJson(actualSource) === stableJson(polygon.getSource()) && all.has(id);
			if (!matches)
				throw new Error(`机械孔 ${id} 的独立填充读回类型/层/模式/网/精确 CIRCLE 几何与计划不符`);
			stage = 'verify-hole-source';
			const after = await readSource(host, `读回机械孔完整源码 ${id}`);
			const { data, report: sourceVerification } = assertOneNewSourceRecord(before, after, 'FILL', id);
			if (data.layerId !== MULTI || !numbersEqual(data.width, actualLineWidth as number) || data.fillStyle !== 'SOLID'
				|| data.netName !== '' || data.locked !== false || stableJson(data.path) !== stableJson(sourcePolygonPath(polygon.getSource()))) {
				throw new Error(`机械孔 ${id} 的 FILL 源码属性或正式 CIRCLE 路径与请求不符：${stableJson(data)}`);
			}
			host.recordVerified(id);
			created.push({ id, primitiveType: 'Fill', holeKind: 'mechanical-npth', x: input.x, y: input.y, holeDiameter: input.holeDiameter, plated: false, layer: 'multi', polygonSource: actualSource, lineWidth: actualLineWidth, lineWidthNormalization: { submitted: 0, sdkReadback: actualLineWidth, sourceReadback: data.width, normalized: actualLineWidth === 1 }, sourceReadback: { type: 'FILL', layerId: data.layerId, path: data.path, fillStyle: data.fillStyle, netName: data.netName, width: data.width, sourceVerification } });
		}
		else {
			stage = 'create-pad-hole';
			const idSet = new Set([...existingIds]);
			const padShape: unknown[] = ['ELLIPSE', input.padDiameter, input.padDiameter];
			object = await host.write('创建多层安装孔焊盘', async () => await host.sdk.pcb_PrimitivePad.create(
				MULTI,
				'',
				input.x,
				input.y,
				0,
				padShape,
				input.net ?? '',
				requestedHole,
				0,
				0,
				0,
				input.plated,
				0,
				undefined,
				partialMask ? null : mask,
				undefined,
				false,
			));
			if (!object)
				throw new Error('pcb_PrimitivePad.create() 返回空值，结果未知');
			const id = String(state<string>(object, 'PrimitiveId') ?? '');
			if (!id || idSet.has(id))
				throw new Error('焊盘创建返回的图元 ID 缺失或执行前已存在，结果未知');
			host.recordCreated(id);
			if (partialMask) {
				const partialResult: Record<string, unknown> = { id, primitiveType: 'Pad', holeKind: input.plated ? 'pth-pad-hole' : 'npth-pad-hole', status: 'created-unverified', requestedMask: mask };
				created.push(partialResult);
				const verified = await applyPartialMaskSnapshot(host, before, baseline.rules, id, MULTI, input.x, input.y, padShape, input.net ?? '', requestedHole, input.plated, mask, nextStage => stage = nextStage, partialResult);
				Object.assign(partialResult, {
					status: 'verified',
					holeKind: input.plated ? 'pth-pad-hole' : 'npth-pad-hole',
					x: input.x,
					y: input.y,
					holeDiameter: input.holeDiameter,
					padDiameter: input.padDiameter,
					plated: input.plated,
					net: input.net ?? '',
					layer: 'multi',
					padShape,
					geometryReadback: verified.geometryReadback,
					solderMaskSource: 'explicit-with-default-snapshot',
					solderMaskAndPasteMaskExpansion: maskSnapshotReport(mask, verified.defaultsReadback, verified.applied),
					sourceReadback: { type: 'PAD', layerId: verified.data.layerId, centerX: verified.data.centerX, centerY: verified.data.centerY, defaultPad: verified.data.defaultPad, hole: verified.data.hole, plated: verified.data.plated, padType: verified.data.padType, sourceVerification: verified.sourceVerification },
				});
			}
			else {
				stage = 'readback-pad-hole';
				const readback = await host.read(`按 ID 读回安装孔焊盘 ${id}`, async () => await host.sdk.pcb_PrimitivePad.get(id));
				if (!readback)
					throw new Error(`安装孔焊盘 ${id} 按 ID 读回为空`);
				const all = await readExistingIds(host, 'pad');
				const getterReadback = assertPadReadback(readback, id, MULTI, input.x, input.y, padShape, input.net ?? '', requestedHole, input.plated, mask);
				const actualMask = getterReadback.mask;
				if (!all.has(id))
					throw new Error(`安装孔焊盘 ${id} 不在 pcb_PrimitivePad.getAll() 中`);
				stage = 'verify-pad-hole-source';
				const after = await readSource(host, `读回安装孔 PAD 完整源码 ${id}`);
				const { data, report: sourceVerification } = assertOneNewSourceRecord(before, after, 'PAD', id, input.net ?? '');
				assertPadSource(data, id, MULTI, input.x, input.y, padShape, input.net ?? '', requestedHole, input.plated, mask);
				const geometryReadback = padGeometryReadbackReport({ x: input.x, y: input.y, shape: padShape }, getterReadback, data);
				host.recordVerified(id);
				created.push({ id, primitiveType: 'Pad', holeKind: input.plated ? 'pth-pad-hole' : 'npth-pad-hole', x: input.x, y: input.y, holeDiameter: input.holeDiameter, padDiameter: input.padDiameter, plated: input.plated, net: input.net ?? '', layer: 'multi', padShape, geometryReadback, solderMaskSource: mask ? 'explicit-expansion' : 'host-rule', solderMaskAndPasteMaskExpansion: maskReadbackReport(mask, actualMask), sourceReadback: { type: 'PAD', layerId: data.layerId, centerX: data.centerX, centerY: data.centerY, defaultPad: data.defaultPad, hole: data.hole, plated: data.plated, padType: data.padType, sourceVerification } });
			}
		}
		await host.finish();
		return { documentUuid: host.documentUuid, operation: 'placeHole', created, verifiedIds: created.map(item => item.id), saved: false, manufacturingExportVerified: false };
	}
	catch (error) {
		return host.fail(error, { operation: 'placeHole', stage, created });
	}
}

async function placePad(params: Record<string, any>) {
	const input = validatePlacePad(params);
	const host = await createGeometryHost(eda, params);
	const created: Record<string, unknown>[] = [];
	let stage = 'preflight';
	try {
		const baseline = await host.getBaseline();
		const before = await readSource(host, '读取焊盘写入前完整源码');
		if (sourceWithoutDocHead(before) !== baseline.source)
			throw new Error('焊盘写入前完整源码与 GeometryHost 基线不一致');
		const existing = await readExistingIds(host, 'pad');
		await host.assertBaseline(baseline);
		stage = 'create-smd-pad';
		const layer = input.layer === 'top' ? TOP : BOTTOM;
		const shape = input.shape === 'circle'
			? { shape: 'circle' as const, diameter: input.diameter! }
			: { shape: 'rectangle' as const, width: input.width!, height: input.height!, cornerRadius: input.cornerRadius! };
		const pad = padShapeForSdk(shape);
		const mask = normalizeMaskRequest(input.solderMaskAndPasteMaskExpansion);
		const partialMask = isPartialMaskRequest(mask);
		if (partialMask && typeof host.sdk.pcb_PrimitivePad?.modify !== 'function')
			throw new Error('部分阻焊请求需要 pcb_PrimitivePad.modify()；未执行创建');
		const object = await host.write('创建独立 SMT 焊盘', async () => await host.sdk.pcb_PrimitivePad.create(
			layer,
			'',
			input.x,
			input.y,
			0,
			pad,
			input.net ?? '',
			null,
			0,
			0,
			0,
			false,
			0,
			undefined,
			partialMask ? null : mask,
			undefined,
			false,
		));
		if (!object)
			throw new Error('pcb_PrimitivePad.create() 返回空值，结果未知');
		const id = String(state<string>(object, 'PrimitiveId') ?? '');
		if (!id || existing.has(id))
			throw new Error('焊盘创建返回的图元 ID 缺失或执行前已存在，结果未知');
		host.recordCreated(id);
		if (partialMask) {
			const partialResult: Record<string, unknown> = { id, primitiveType: 'Pad', purpose: 'standalone-smd-pad', status: 'created-unverified', requestedMask: mask };
			created.push(partialResult);
			const verified = await applyPartialMaskSnapshot(host, before, baseline.rules, id, layer, input.x, input.y, pad, input.net ?? '', null, false, mask, nextStage => stage = nextStage, partialResult);
			Object.assign(partialResult, {
				status: 'verified',
				purpose: 'standalone-smd-pad',
				x: input.x,
				y: input.y,
				layer: input.layer,
				padShape: pad,
				geometryReadback: verified.geometryReadback,
				solderMaskSource: 'explicit-with-default-snapshot',
				solderMaskAndPasteMaskExpansion: maskSnapshotReport(mask, verified.defaultsReadback, verified.applied),
				sourceReadback: { type: 'PAD', layerId: verified.data.layerId, centerX: verified.data.centerX, centerY: verified.data.centerY, defaultPad: verified.data.defaultPad, hole: verified.data.hole, plated: verified.data.plated, padType: verified.data.padType, sourceVerification: verified.sourceVerification },
				...(shape.shape === 'rectangle' ? { requestedCornerRadiusMil: shape.cornerRadius, sdkRadiusValue: pad[3], sdkRadiusRepresentation: 'percent-of-half-minimum-side' } : {}),
			});
			await host.finish();
			return { documentUuid: host.documentUuid, operation: 'placePad', created, verifiedIds: created.map(item => item.id), saved: false, drc: 'not run', manufacturingExportVerified: false };
		}
		stage = 'readback-smd-pad';
		const readback = await host.read(`按 ID 读回独立 SMT 焊盘 ${id}`, async () => await host.sdk.pcb_PrimitivePad.get(id));
		if (!readback)
			throw new Error(`SMT 焊盘 ${id} 按 ID 读回为空`);
		const all = await readExistingIds(host, 'pad');
		const getterReadback = assertPadReadback(readback, id, layer, input.x, input.y, pad, input.net ?? '', null, false, mask);
		const actualMask = getterReadback.mask;
		if (!all.has(id))
			throw new Error(`SMT 焊盘 ${id} 不在 pcb_PrimitivePad.getAll() 中`);
		stage = 'verify-smd-pad-source';
		const after = await readSource(host, `读回独立 SMT PAD 源码 ${id}`);
		const { data, report: sourceVerification } = assertOneNewSourceRecord(before, after, 'PAD', id, input.net ?? '');
		assertPadSource(data, id, layer, input.x, input.y, pad, input.net ?? '', null, false, mask);
		const geometryReadback = padGeometryReadbackReport({ x: input.x, y: input.y, shape: pad }, getterReadback, data);
		host.recordVerified(id);
		created.push({ id, primitiveType: 'Pad', purpose: 'standalone-smd-pad', x: input.x, y: input.y, layer: input.layer, padShape: pad, geometryReadback, ...(shape.shape === 'rectangle' ? { requestedCornerRadiusMil: shape.cornerRadius, sdkRadiusValue: pad[3], sdkRadiusRepresentation: 'percent-of-half-minimum-side' } : {}), net: input.net ?? '', solderMaskSource: mask ? 'explicit-expansion' : 'host-rule', solderMaskAndPasteMaskExpansion: maskReadbackReport(mask, actualMask), sourceReadback: { type: 'PAD', layerId: data.layerId, centerX: data.centerX, centerY: data.centerY, defaultPad: data.defaultPad, hole: data.hole, plated: data.plated, padType: data.padType, sourceVerification } });
		await host.finish();
		return { documentUuid: host.documentUuid, operation: 'placePad', created, verifiedIds: created.map(item => item.id), saved: false, drc: 'not run', manufacturingExportVerified: false };
	}
	catch (error) {
		return host.fail(error, { operation: 'placePad', stage, created });
	}
}

export const padHoleCommands: ICommandDef[] = [
	{
		name: 'pcb.placeHole',
		summary: '在当前 PCB 放置圆形安装孔；区分无铜机械 NPTH 孔、带铜环 NPTH 焊盘和 PTH 焊盘孔，尺寸由调用方明确提供。',
		params: [
			{ name: 'x', type: 'number', required: true, description: '孔中心 X，单位 mil。' },
			{ name: 'y', type: 'number', required: true, description: '孔中心 Y，单位 mil。' },
			{ name: 'holeDiameter', type: 'number', required: true, description: '圆孔直径，单位 mil；不自动换算螺钉规格或制造尺寸。' },
			{ name: 'plated', type: 'boolean', required: true, description: '是否电镀孔壁，必须明确。' },
			{ name: 'padDiameter', type: 'number', description: '可选铜盘直径，单位 mil；提供时必须大于孔径，生成多层 PAD；plated=true 时必填。不提供且 plated=false 时创建多层无铜挖孔 Fill。' },
			{ name: 'net', type: 'string', description: '可选焊盘网络。纯机械孔不能绑定网络。无需预先创建网络；创建新网时宿主可能生成该网默认 NET/规则记录，插件仅接受读回确认的默认记录，已有规则和非目标数据仍保持。' },
			{ name: 'solderMaskAndPasteMaskExpansion', type: 'object', description: '可选 SDK 扩展数值对象：topSolderMask、bottomSolderMask、topPasteMask、bottomPasteMask，单位 mil。省略或传空对象时按宿主默认创建；提供1–3个字段时先按宿主默认创建并读回四项，再将未提供字段按该次读回值显式固定后按同一ID修改，属于 explicit-with-default-snapshot，不是未来动态继承；四字段完整时直接创建。实际 getter/source 与请求均需匹配。solderMaskOpen 不支持。' },
		],
		returns: '返回新建图元类型、ID、几何和独立 SDK/源码读回。PAD 的 X/Y 和椭圆宽高 getter 若按 0.1 mil 规则量化，会报告请求值、getter 值、源码值及量化字段；源码仍须精确等于请求值。无铜机械圆孔提交 Fill 线宽 0；若宿主读回为 1，会单独报告请求值、getter 值和源码值。1–3个阻焊字段时报告 explicit-with-default-snapshot、requested、defaultsReadback、applied 和 defaultedFields；未提供字段被显式设置为创建时的 getter 值，不是未来动态继承。阻焊 effective 只表示 getter 实际值，不证明规则求值结果。读回验证不代表已保存或已验证制造导出；本指令不会保存，保存重开和制造数据导出需另行验收。写入结果未知时停止，不自动重试或删除。',
		example: { cmd: 'pcb.placeHole', params: { x: 500, y: 500, holeDiameter: 30, plated: false } },
		handler: placeHole,
	},
	{
		name: 'pcb.placePad',
		summary: '在明确指定的顶层或底层放置独立圆形或矩形 SMT 焊盘；不创建孔或器件。',
		params: [
			{ name: 'x', type: 'number', required: true, description: '焊盘中心 X，单位 mil。' },
			{ name: 'y', type: 'number', required: true, description: '焊盘中心 Y，单位 mil。' },
			{ name: 'layer', type: 'top|bottom', required: true, description: '独立焊盘所在外层。' },
			{ name: 'shape', type: 'circle|rectangle', required: true, description: '圆形或矩形；圆形传 diameter，矩形传 width 和 height。' },
			{ name: 'diameter', type: 'number', description: '圆形直径，单位 mil。' },
			{ name: 'width', type: 'number', description: '矩形宽，单位 mil。' },
			{ name: 'height', type: 'number', description: '矩形高，单位 mil。' },
			{ name: 'cornerRadius', type: 'number', description: '矩形圆角半径，公开输入单位 mil；省略时为 0。插件按 SDK 形式转换为 200×圆角半径/min(width,height)，即短边半尺寸的百分比；要求 0 到 min(width,height)/2。' },
			{ name: 'net', type: 'string', description: '可选网络名；省略时不绑定网络。无需预先创建网络；创建新网时宿主可能生成该网默认 NET/规则记录，插件仅接受读回确认的默认记录，已有规则和非目标数据仍保持。' },
			{ name: 'solderMaskAndPasteMaskExpansion', type: 'object', description: '可选 SDK 扩展数值对象：topSolderMask、bottomSolderMask、topPasteMask、bottomPasteMask，单位 mil。省略或传空对象时按宿主默认创建；提供1–3个字段时先按宿主默认创建并读回四项，再将未提供字段按该次读回值显式固定后按同一ID修改，属于 explicit-with-default-snapshot，不是未来动态继承；四字段完整时直接创建。实际 getter/source 与请求均需匹配。solderMaskOpen 不支持。' },
		],
		returns: '返回新建 PAD 的 ID、请求几何和独立 SDK/源码读回。矩形圆角另返回公开 requestedCornerRadiusMil、SDK sdkRadiusValue 和表示形式；SDK 值按短边半尺寸百分比映射。已有宿主制造对照只验证了指定样本，不保证其它圆角输入的制造形状。X/Y 与椭圆宽高 getter 若按 0.1 mil 规则量化，会报告请求值、getter 值、源码值及量化字段；源码仍须精确等于请求值。1–3个阻焊字段时报告 explicit-with-default-snapshot、requested、defaultsReadback、applied 和 defaultedFields；未提供字段被显式设置为创建时的 getter 值，不是未来动态继承。阻焊 effective 只表示 getter 实际值，不证明规则求值结果。读回验证不代表已保存或已验证制造导出；不会保存，不执行 DRC 或制造导出。写入结果未知时停止，不自动重试或删除。',
		example: { cmd: 'pcb.placePad', params: { x: 500, y: 500, layer: 'top', shape: 'circle', diameter: 60 } },
		handler: placePad,
	},
];
