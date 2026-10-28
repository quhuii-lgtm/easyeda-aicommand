import { parseSourceLog, resolveRecords, type ISourceRecord } from '../pcb/sourcelog';
import type { GeometryHost } from '../pcb/geometryHost';
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';

export interface ModifyDesignatorInput {
	componentId?: string;
	designator?: string;
	key?: 'Designator';
	x?: number;
	y?: number;
	rotation?: number;
	fontSize?: number;
	visible?: boolean;
}

interface SourceView {
	documentUuid: string;
	docType: string;
	docHead: Record<string, unknown>;
	records: Map<string, ISourceRecord>;
	unkeyed: Array<{ header: Record<string, unknown>; data: unknown }>;
}

interface Target {
	componentId: string;
	component: ISourceRecord;
	attribute: ISourceRecord;
	attributeId: string;
	data: Record<string, any>;
	state: Record<string, unknown>;
	componentState: any;
	attributeState: any;
}

const SOURCE_TOLERANCE = 0.0001;

function stable(value: any): any {
	if (Array.isArray(value))
		return value.map(stable);
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort())
			result[key] = stable(value[key]);
		return result;
	}
	return value;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function state(object: any, name: string): any {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		throw new Error(`EDA 对象缺少 getState_${name}()`);
	return getter.call(object);
}

function optionalState(object: any, name: string): unknown {
	const getter = object?.[`getState_${name}`];
	return typeof getter === 'function' ? getter.call(object) : undefined;
}

function finite(value: unknown, label: string): asserts value is number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`${label} 必须是有限数值`);
}

function readSource(source: unknown, expectedUuid: string): SourceView {
	if (typeof source !== 'string' || !source.trim())
		throw new Error('PCB 源码为空或不是字符串');
	const document = parseSourceLog(source);
	if (document.docType.toUpperCase() !== 'PCB' || document.uuid !== expectedUuid)
		throw new Error(`PCB 源码身份不符（期望 ${expectedUuid}，实际 ${document.docType}/${document.uuid}）`);
	const docHeadRecord = document.records.find(record => record.header.type === 'DOCHEAD');
	if (!docHeadRecord || !docHeadRecord.data || typeof docHeadRecord.data !== 'object' || Array.isArray(docHeadRecord.data))
		throw new Error('PCB 源码 DOCHEAD 无效');
	const records = resolveRecords(document);
	const unkeyed = document.records
		.filter(record => record.header.type !== 'DOCHEAD' && record.header.id == null)
		.map(record => ({ header: record.header as Record<string, unknown>, data: record.data }));
	return {
		documentUuid: document.uuid,
		docType: document.docType,
		docHead: docHeadRecord.data as Record<string, unknown>,
		records,
		unkeyed,
	};
}

function stripDocHead(source: string): string {
	const document = parseSourceLog(source);
	return document.records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n');
}

function sourceData(record: ISourceRecord, label: string): Record<string, any> {
	if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))
		throw new Error(`${label} 源码不是有效对象`);
	return record.data as Record<string, any>;
}

function recordId(record: ISourceRecord): string {
	const id = record.header.id;
	if (typeof id !== 'string' || !id.trim())
		throw new Error(`${record.header.type} 源码记录缺少有效 id`);
	return id;
}

function requireGetterMatch(sourceValue: unknown, getterValue: unknown, label: string): void {
	if (typeof sourceValue === 'number' && typeof getterValue === 'number') {
		if (!Number.isFinite(getterValue) || Math.abs(sourceValue - getterValue) > SOURCE_TOLERANCE)
			throw new Error(`${label} 源码与 EDA 读回不一致（source=${sourceValue}, getter=${getterValue}）`);
		return;
	}
	if (!Object.is(sourceValue, getterValue))
		throw new Error(`${label} 源码与 EDA 读回不一致（source=${String(sourceValue)}, getter=${String(getterValue)}）`);
}

function resolveSourceTarget(view: SourceView, input: ModifyDesignatorInput): { componentId: string; component: ISourceRecord; attribute: ISourceRecord; data: Record<string, any> } {
	const components = [...view.records.values()].filter(record => record.header.type === 'COMPONENT');
	const attributes = [...view.records.values()].filter(record => record.header.type === 'ATTR');
	const componentById = new Map(components.map(record => [recordId(record), record]));
	const candidates = attributes.filter((record) => {
		const data = sourceData(record, 'ATTR');
		if (data.key !== 'Designator')
			return false;
		const parent = typeof data.parentId === 'string' ? data.parentId : '';
		return parent
			&& componentById.has(parent)
			&& (input.componentId === undefined || input.componentId === parent)
			&& (input.designator === undefined || data.value === input.designator);
	});
	if (candidates.length !== 1)
		throw new Error(`Designator 属性无法唯一定位（匹配数 ${candidates.length}），写入前拒绝`);
	const attribute = candidates[0];
	const data = sourceData(attribute, 'Designator ATTR');
	const componentId = String(data.parentId);
	const component = componentById.get(componentId);
	if (!component)
		throw new Error(`Designator 属性的父器件 ${componentId} 不存在`);
	const allForComponent = attributes.filter((record) => {
		const recordData = sourceData(record, 'ATTR');
		return recordData.parentId === componentId && recordData.key === 'Designator';
	});
	if (allForComponent.length !== 1)
		throw new Error(`器件 ${componentId} 的 Designator 属性不是唯一项，写入前拒绝`);
	return { componentId, component, attribute, data };
}

async function readSdkTarget(host: GeometryHost, componentId: string, attributeId: string): Promise<{ component: any; attribute: any; state: Record<string, unknown> }> {
	const component = await host.read(`按 ID 读取 PCB 器件 ${componentId}`, async () => {
		const api = host.sdk.pcb_PrimitiveComponent;
		if (typeof api?.get !== 'function')
			throw new Error('pcb_PrimitiveComponent.get() 不可用');
		return api.get(componentId);
	});
	if (!component)
		throw new Error(`SDK 找不到 PCB 器件 ${componentId}`);
	if (state(component, 'PrimitiveId') !== componentId)
		throw new Error(`SDK 器件 ID 与源码不一致（期望 ${componentId}）`);
	const locked = optionalState(component, 'PrimitiveLock');
	if (locked !== undefined && typeof locked !== 'boolean')
		throw new Error(`器件 ${componentId} 的锁定状态无效`);
	if (locked === true)
		throw new Error(`器件 ${componentId} 已锁定，拒绝修改`);

	const attributes = await host.read(`按父器件读取属性 ${componentId}`, async () => {
		const api = host.sdk.pcb_PrimitiveAttribute;
		if (typeof api?.getAll !== 'function')
			throw new Error('pcb_PrimitiveAttribute.getAll() 不可用');
		return api.getAll(componentId);
	});
	if (!Array.isArray(attributes))
		throw new Error(`器件 ${componentId} 的属性列表未返回数组`);
	const actual = attributes.map((item: any) => ({
		object: item,
		id: state(item, 'PrimitiveId'),
		parentId: state(item, 'ParentPrimitiveId'),
		key: state(item, 'Key'),
		value: state(item, 'Value'),
	}));
	if (actual.some(item => typeof item.id !== 'string' || !item.id || item.parentId !== componentId || typeof item.key !== 'string' || typeof item.value !== 'string'))
		throw new Error(`SDK 属性列表 ${componentId} 包含无效 ID、归属或键值`);
	if (new Set(actual.map(item => item.id)).size !== actual.length)
		throw new Error(`SDK 属性列表 ${componentId} 包含重复属性 ID`);
	const targetMatches = actual.filter(item => item.id === attributeId && item.key === 'Designator');
	if (targetMatches.length !== 1)
		throw new Error(`SDK 属性列表无法唯一确认 Designator ${attributeId}`);
	const attribute = targetMatches[0].object;
	const read = {
		id: targetMatches[0].id,
		parentId: targetMatches[0].parentId,
		key: targetMatches[0].key,
		value: targetMatches[0].value,
		layer: state(attribute, 'Layer'),
		x: state(attribute, 'X'),
		y: state(attribute, 'Y'),
		rotation: state(attribute, 'Rotation'),
		fontSize: state(attribute, 'FontSize'),
		valueVisible: state(attribute, 'ValueVisible'),
		locked: state(attribute, 'PrimitiveLock'),
	};
	if (typeof read.layer !== 'number' || !Number.isFinite(read.layer))
		throw new Error(`Designator ${attributeId} 的图层读回无效`);
	for (const key of ['x', 'y'] as const) {
		if (read[key] !== null)
			finite(read[key], `Designator ${key}`);
	}
	finite(read.rotation, 'Designator rotation');
	finite(read.fontSize, 'Designator fontSize');
	if (typeof read.valueVisible !== 'boolean' || typeof read.locked !== 'boolean')
		throw new Error(`Designator ${attributeId} 的可见或锁定状态读回无效`);
	if (read.locked)
		throw new Error(`Designator ${attributeId} 已锁定，拒绝修改`);
	return { component, attribute, state: read };
}

function assertTargetMatchesSource(target: ReturnType<typeof resolveSourceTarget>, sdkState: Record<string, unknown>): void {
	const source = target.data;
	const expectedFields: Array<[string, unknown, unknown]> = [
		['id', recordId(target.attribute), sdkState.id],
		['parentId', target.componentId, sdkState.parentId],
		['key', source.key, sdkState.key],
		['value', source.value, sdkState.value],
		['layerId', source.layerId, sdkState.layer],
		['x', source.x, sdkState.x],
		['y', source.y, sdkState.y],
		['angle', source.angle, sdkState.rotation],
		['fontSize', source.fontSize, sdkState.fontSize],
		['valueVisible', source.valueVisible, sdkState.valueVisible],
		['locked', source.locked, sdkState.locked],
	];
	for (const [label, sourceValue, getterValue] of expectedFields)
		requireGetterMatch(sourceValue, getterValue, `Designator ${label}`);
	if (typeof source.locked !== 'boolean')
		throw new Error('Designator 源码锁定状态无效');
	const componentData = sourceData(target.component, 'COMPONENT');
	if (typeof componentData.locked !== 'boolean')
		throw new Error(`器件 ${target.componentId} 源码锁定状态无效`);
	if (componentData.locked)
		throw new Error(`器件 ${target.componentId} 已锁定，拒绝修改`);
}

function assertInput(input: unknown): asserts input is ModifyDesignatorInput {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('参数必须是对象');
	const value = input as Record<string, unknown>;
	const allowed = new Set(['componentId', 'designator', 'key', 'x', 'y', 'rotation', 'fontSize', 'visible', '__docUuid', '_timeoutMs']);
	const unknown = Object.keys(value).filter(key => !allowed.has(key));
	if (unknown.length)
		throw new Error(`不支持的参数：${unknown.join(', ')}`);
	if (value.componentId !== undefined && (typeof value.componentId !== 'string' || !value.componentId.trim()))
		throw new Error('componentId 必须是非空字符串');
	if (value.designator !== undefined && (typeof value.designator !== 'string' || !value.designator.trim()))
		throw new Error('designator 必须是非空字符串');
	if (value.componentId === undefined && value.designator === undefined)
		throw new Error('componentId 与 designator 至少提供一个');
	if (value.key !== undefined && value.key !== 'Designator')
		throw new Error("key 仅支持 'Designator'");
	const fields = ['x', 'y', 'rotation', 'fontSize', 'visible'] as const;
	if (!fields.some(field => Object.hasOwn(value, field)))
		throw new Error('至少提供一个要修改的字段：x、y、rotation、fontSize、visible');
	for (const field of ['x', 'y', 'rotation', 'fontSize'] as const) {
		if (Object.hasOwn(value, field)) {
			finite(value[field], field);
			if (field === 'fontSize' && (value[field] as number) <= 0)
				throw new Error('fontSize 必须大于 0');
		}
	}
	if (Object.hasOwn(value, 'visible') && typeof value.visible !== 'boolean')
		throw new Error('visible 必须是布尔值');
}

function compareHeader(a: Record<string, unknown>, b: Record<string, unknown>, label: string, ticketChanges: Array<Record<string, unknown>>): void {
	const aWithoutTicket = { ...a };
	const bWithoutTicket = { ...b };
	delete aWithoutTicket.ticket;
	delete bWithoutTicket.ticket;
	if (!same(aWithoutTicket, bWithoutTicket))
		throw new Error(`${label} 非 ticket 源码头字段发生变化`);
	if (!Object.is(a.ticket, b.ticket))
		ticketChanges.push({ label, before: a.ticket ?? null, after: b.ticket ?? null });
}

function compareDocumentHeader(before: SourceView, after: SourceView): Array<Record<string, unknown>> {
	if (before.documentUuid !== after.documentUuid || before.docType !== after.docType)
		throw new Error('写入前后 PCB DOCHEAD 身份发生变化');
	const changed: Array<Record<string, unknown>> = [];
	const volatile = new Set(['client', 'updateTime', 'version']);
	const keys = new Set([...Object.keys(before.docHead), ...Object.keys(after.docHead)]);
	for (const key of keys) {
		if (Object.is(before.docHead[key], after.docHead[key]))
			continue;
		if (!volatile.has(key))
			throw new Error(`写入前后 DOCHEAD.${key} 发生非预期变化`);
		changed.push({ field: key, before: before.docHead[key] ?? null, after: after.docHead[key] ?? null });
	}
	return changed;
}

function expectedTargetData(before: Record<string, any>, input: ModifyDesignatorInput): Record<string, unknown> {
	const expected = { ...before };
	if (Object.hasOwn(input, 'x')) expected.x = input.x;
	if (Object.hasOwn(input, 'y')) expected.y = input.y;
	if (Object.hasOwn(input, 'rotation')) expected.angle = input.rotation;
	if (Object.hasOwn(input, 'fontSize')) expected.fontSize = input.fontSize;
	if (Object.hasOwn(input, 'visible')) expected.valueVisible = input.visible;
	return expected;
}

function compareTargetData(actual: unknown, expected: Record<string, unknown>): void {
	if (!actual || typeof actual !== 'object' || Array.isArray(actual))
		throw new Error('写入后 Designator 源码不是对象');
	const record = actual as Record<string, unknown>;
	if (!same(Object.keys(record).sort(), Object.keys(expected).sort()))
		throw new Error('写入后 Designator 源码字段集合发生变化');
	for (const key of Object.keys(expected)) {
		const wanted = expected[key];
		const got = record[key];
		const numeric = ['x', 'y', 'angle', 'fontSize'].includes(key);
		if (numeric && typeof wanted === 'number' && typeof got === 'number') {
			if (!Number.isFinite(got) || Math.abs(got - wanted) > SOURCE_TOLERANCE)
				throw new Error(`写入后 Designator.${key} 与请求不符（期望 ${wanted}，实际 ${got}）`);
		}
		else if (!same(got, wanted)) {
			const label = key === 'value' ? '位号文本值被意外修改' : `写入后 Designator.${key} 与请求不符`;
			throw new Error(`${label}（期望 ${String(wanted)}，实际 ${String(got)}）`);
		}
	}
}

function verifySourceChange(before: SourceView, after: SourceView, targetKey: string, expectedData: Record<string, unknown>) {
	const documentHeaderChanges = compareDocumentHeader(before, after);
	if (!same(before.unkeyed, after.unkeyed))
		throw new Error('写入前后无 ID 源码记录发生变化');
	if (before.records.size !== after.records.size)
		throw new Error(`写入前后 PCB 源码图元记录数变化（${before.records.size} → ${after.records.size}）`);
	const ticketChanges: Array<Record<string, unknown>> = [];
	for (const [key, oldRecord] of before.records) {
		const newRecord = after.records.get(key);
		if (!newRecord)
			throw new Error(`写入后缺少原有源码记录 ${key.replace('\u0000', '/')}`);
		compareHeader(oldRecord.header as Record<string, unknown>, newRecord.header as Record<string, unknown>, key, ticketChanges);
		if (key === targetKey)
			compareTargetData(newRecord.data, expectedData);
		else if (!same(oldRecord.data, newRecord.data))
			throw new Error(`写入期间非目标 PCB 源码记录发生变化：${key.replace('\u0000', '/')}`);
	}
	const targetRecord = after.records.get(targetKey);
	if (!targetRecord)
		throw new Error('写入后找不到目标 Designator 源码');
	return { documentHeaderChanges, ticketChanges };
}

async function readFullSource(host: GeometryHost, label: string): Promise<string> {
	return host.read(label, async () => {
		const source = await host.sdk.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || !source.trim())
			throw new Error('getDocumentSource() 未返回完整字符串');
		return source;
	});
}

export async function modifyComponentDesignatorAttribute(host: GeometryHost, rawInput: unknown) {
	assertInput(rawInput);
	const input = rawInput;
	const baseline = await host.getBaseline();
	const beforeSource = await readFullSource(host, '完整读取 PCB 写入前源码');
	if (stripDocHead(beforeSource) !== baseline.source)
		throw new Error('完整源码与几何基线源码不一致，写入前拒绝');
	const before = readSource(beforeSource, host.documentUuid);
	const located = resolveSourceTarget(before, input);
	const componentId = located.componentId;
	const attributeId = recordId(located.attribute);
	const readBefore = await readSdkTarget(host, componentId, attributeId);
	assertTargetMatchesSource(located, readBefore.state);
	const componentData = sourceData(located.component, 'COMPONENT');
	if (componentData.locked === true)
		throw new Error(`器件 ${componentId} 已锁定，拒绝修改`);

	await host.assertBaseline(baseline);
	const latestSource = await readFullSource(host, 'Designator 写入前再次检查完整源码');
		const latestComparison = comparePcbSourceSnapshots(beforeSource, latestSource);
		if (!latestComparison.matches)
			throw new Error(`写入前 PCB 完整源码已变化，拒绝写入：${latestComparison.reason}`);
	const latestView = readSource(latestSource, host.documentUuid);
	const latestTarget = resolveSourceTarget(latestView, input);
	if (recordId(latestTarget.attribute) !== attributeId || latestTarget.componentId !== componentId)
		throw new Error('写入前目标 Designator 身份已变化，拒绝写入');
	const latestSdk = await readSdkTarget(host, componentId, attributeId);
	assertTargetMatchesSource(latestTarget, latestSdk.state);
	if (!same(readBefore.state, latestSdk.state))
		throw new Error('写入前 Designator getter 状态已变化，拒绝写入');

	const property: Record<string, unknown> = {};
	if (Object.hasOwn(input, 'x')) property.x = input.x;
	if (Object.hasOwn(input, 'y')) property.y = input.y;
	if (Object.hasOwn(input, 'rotation')) property.rotation = input.rotation;
	if (Object.hasOwn(input, 'fontSize')) property.fontSize = input.fontSize;
	if (Object.hasOwn(input, 'visible')) property.valueVisible = input.visible;
	const sdkResult = await host.write(`修改器件 ${componentId} 的 Designator 属性`, async () => {
		const api = host.sdk.pcb_PrimitiveAttribute;
		if (typeof api?.modify !== 'function')
			throw new Error('pcb_PrimitiveAttribute.modify() 不可用');
		return api.modify(attributeId, property);
	});

	const fresh = await host.read(`独立读回 Designator ${attributeId}`, async () => {
		const api = host.sdk.pcb_PrimitiveAttribute;
		if (typeof api?.get !== 'function')
			throw new Error('pcb_PrimitiveAttribute.get() 不可用');
		return api.get(attributeId);
	});
	if (!fresh)
		throw new Error(`写入后无法按 ID 读回 Designator ${attributeId}`);
	const afterSdk = {
		id: state(fresh, 'PrimitiveId'),
		parentId: state(fresh, 'ParentPrimitiveId'),
		key: state(fresh, 'Key'),
		value: state(fresh, 'Value'),
		layer: state(fresh, 'Layer'),
		x: state(fresh, 'X'),
		y: state(fresh, 'Y'),
		rotation: state(fresh, 'Rotation'),
		fontSize: state(fresh, 'FontSize'),
		valueVisible: state(fresh, 'ValueVisible'),
		locked: state(fresh, 'PrimitiveLock'),
	};
	const beforeState = latestSdk.state;
	const wantedState: Record<string, unknown> = { ...beforeState };
	if (Object.hasOwn(input, 'x')) wantedState.x = input.x;
	if (Object.hasOwn(input, 'y')) wantedState.y = input.y;
	if (Object.hasOwn(input, 'rotation')) wantedState.rotation = input.rotation;
	if (Object.hasOwn(input, 'fontSize')) wantedState.fontSize = input.fontSize;
	if (Object.hasOwn(input, 'visible')) wantedState.valueVisible = input.visible;
	for (const field of ['id', 'parentId', 'key', 'value', 'layer', 'x', 'y', 'rotation', 'fontSize', 'valueVisible', 'locked'] as const)
		requireGetterMatch(wantedState[field], afterSdk[field], `写入后 Designator ${field}`);
	if (afterSdk.value !== beforeState.value || afterSdk.key !== 'Designator' || afterSdk.parentId !== componentId || afterSdk.id !== attributeId)
		throw new Error('写入后 Designator 身份或位号文本值发生变化');

	const afterSourceText = await readFullSource(host, `读取 Designator ${attributeId} 写入后完整源码`);
	const after = readSource(afterSourceText, host.documentUuid);
	const targetKey = `ATTR\u0000${attributeId}`;
	const sourceVerification = verifySourceChange(before, after, targetKey, expectedTargetData(located.data, input));
	const afterTarget = after.records.get(targetKey)!;
	const afterTargetData = sourceData(afterTarget, '写入后 Designator ATTR');
	for (const [label, sourceValue, getterValue] of [
		['x', afterTargetData.x, afterSdk.x], ['y', afterTargetData.y, afterSdk.y],
		['rotation', afterTargetData.angle, afterSdk.rotation], ['fontSize', afterTargetData.fontSize, afterSdk.fontSize],
		['visible', afterTargetData.valueVisible, afterSdk.valueVisible],
	] as Array<[string, unknown, unknown]>)
		requireGetterMatch(sourceValue, getterValue, `写入后源码/getter ${label}`);
	await host.finish();
	return {
		documentUuid: host.documentUuid,
		componentId,
		designator: String(before.records.get(targetKey)?.data && sourceData(before.records.get(targetKey)!, '写入前 Designator').value),
		key: 'Designator',
		attributeId,
		requested: property,
		verified: true,
		sdkReturnedObject: Boolean(sdkResult),
		before: { ...beforeState },
		after: afterSdk,
		sourceVerification,
		componentAndOtherRecordsUnchanged: true,
	};
}
