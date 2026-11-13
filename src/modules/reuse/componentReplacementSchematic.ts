import { parseReplacementNativeSource, patchReplacementNativeSource } from './componentReplacementNative';
import { activateOrOpenReplacementDocument } from './componentReplacementNavigation';

type Json = Record<string, any>;
type Context = { operationId: string; partIndex?: number; partCount?: number; previousResults: unknown[]; assertActive?: () => void };
type Part = Json & { pageUuid: string; componentId: string; subPartName: string; newSubPartName: string; native: ReturnType<typeof parseReplacementNativeSource>; source: string; oldTyped: Json; oldDeviceReference: { libraryUuid: string; uuid: string }; oldDeviceDefaults: Json };
type Prepared = { projectUuid: string; archiveDocuments: Array<{ docType: string; uuid: string }>; replacements: Array<{ input: Json; newDevice: { reference: { libraryUuid: string; uuid: string }; defaults: Json; parts: Array<{ name: string }> }; schematicParts: Part[] }> };

function object(value: unknown, label: string): Json {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
	return value as Json;
}
function state(value: any, getter: string): any {
	if (!value || typeof value[getter] !== 'function') throw new Error(`SCH SDK对象缺少 ${getter}`);
	return value[getter]();
}
function id(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 无效`);
	return value;
}
function stageResult(previous: unknown[], stage: string, replacementIndex: number, partIndex: number): Json {
	const found = previous.filter((row: any) => row?.stage === stage && row?.replacementIndex === replacementIndex && row?.partIndex === partIndex);
	if (found.length !== 1) throw new Error(`缺少唯一阶段结果 ${stage}/replacement=${replacementIndex}/part=${partIndex}`);
	return object(found[0], `${stage} result`);
}
function replacementResult(previous: unknown[], stage: string, replacementIndex: number): Json {
	const found = previous.filter((row: any) => row?.stage === stage && row?.replacementIndex === replacementIndex);
	if (found.length !== 1) throw new Error(`缺少唯一阶段结果 ${stage}/replacement=${replacementIndex}`);
	return object(found[0], `${stage} result`);
}
function readProps(component: any): Json {
	const getters = ['X','Y','Rotation','Mirror','AddIntoBom','AddIntoPcb','Designator','UniqueId','Name','Manufacturer','ManufacturerId','Supplier','SupplierId','OtherProperty','SubPartName'];
	return Object.fromEntries(getters.map(name => [`getState_${name}`, state(component, `getState_${name}`)]));
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function stable(value: any): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function dataDiffPaths(expected: unknown, actual: unknown, path = '$'): Array<{ path: string; kind: 'missing' | 'extra' | 'value' }> {
	if (stable(expected) === stable(actual)) return [];
	if (Array.isArray(expected) !== Array.isArray(actual)) return [{ path, kind: 'value' }];
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const out: Array<{ path: string; kind: 'missing' | 'extra' | 'value' }> = [];
		const count = Math.max(expected.length, actual.length);
		for (let i = 0; i < count; i++) {
			if (i >= actual.length) out.push({ path: `${path}[${i}]`, kind: 'missing' });
			else if (i >= expected.length) out.push({ path: `${path}[${i}]`, kind: 'extra' });
			else out.push(...dataDiffPaths(expected[i], actual[i], `${path}[${i}]`));
		}
		return out;
	}
	if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
		const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
		const out: Array<{ path: string; kind: 'missing' | 'extra' | 'value' }> = [];
		for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
			const child = `${path}.${key}`;
			if (!Object.hasOwn(right, key)) out.push({ path: child, kind: 'missing' });
			else if (!Object.hasOwn(left, key)) out.push({ path: child, kind: 'extra' });
			else out.push(...dataDiffPaths(left[key], right[key], child));
		}
		return out;
	}
	return [{ path, kind: 'value' }];
}
function attachFailureEvidence(error: unknown, evidence: Json): never {
	if (error && (typeof error === 'object' || typeof error === 'function')) {
		(error as any).failureEvidence = JSON.parse(JSON.stringify(evidence));
		throw error;
	}
	const wrapped = new Error(String(error));
	(wrapped as any).cause = error;
	(wrapped as any).failureEvidence = JSON.parse(JSON.stringify(evidence));
	throw wrapped;
}

function multipartRelevanceLifecycleIds(symbolEffectiveRecords: Array<{ header?: { type?: string; id?: string }; type?: string; id?: string; data: Json }>, selectedPartId: string,
	componentId: string, candidateAttributes: Array<{ id: string; data: Json }>): Set<string> {
	const partIds = symbolEffectiveRecords.filter(row => (row?.header?.type ?? row?.type) === 'PART')
		.map(row => row.header?.id ?? row.id).filter((value): value is string => typeof value === 'string' && value.length > 0);
	const selectedCount = partIds.filter(value => value === selectedPartId).length;
	if (partIds.length < 2 || selectedCount !== 1) return new Set();
	const direct = candidateAttributes.filter(row => row?.data?.parentId === componentId && row?.data?.key === 'Relevance');
	return direct.length === 1 && typeof direct[0].id === 'string' && direct[0].id ? new Set([direct[0].id]) : new Set();
}

type CleanupEndpointPair = { oldPoint: [number, number]; actualNewPoint: [number, number]; oldNumber?: string; newNumber?: string };
type CreateSideEffectGroup = { wireId: string; lineId: string; netAttrId: string; relevanceAttrId: string; point: [number, number]; matchedPinPairs: Array<{ oldNumber?: string; newNumber?: string }> };
/** Classifies the complete native delta caused by SCH create; no partial cleanup set is returned. */
export function classifySchematicCreateSideEffects(input: { beforeSource: string; afterSource: string; pageUuid: string; oldComponentId: string; candidateId: string;
	endpointPairs: CleanupEndpointPair[]; tolerance?: number }): { candidateAdded: Array<{ type: string; id: string }>; groups: CreateSideEffectGroup[]; addedRecords: Array<{ type: string; id: string }>;
	retainedRecordCount: number; retainedRecordsUnchanged: true } {
	const before = parseReplacementNativeSource(input.beforeSource, input.pageUuid, 'SCH_PAGE').records;
	const after = parseReplacementNativeSource(input.afterSource, input.pageUuid, 'SCH_PAGE').records;
	const recordKey = (row: { type: string; id: string }) => `${row.type}\0${row.id}`;
	const beforeByKey = new Map(before.map(row => [recordKey(row), row]));
	if (beforeByKey.size !== before.length) throw new Error('SCH create前存在重复原生记录ID');
	const beforeIds = new Set<string>();
	for (const row of before) {
		if (typeof row.id !== 'string' || !row.id || beforeIds.has(row.id)) throw new Error(`SCH create前存在跨类型重复或无效原生记录ID：${row.id}`);
		beforeIds.add(row.id);
	}
	const afterByKey = new Map(after.map(row => [recordKey(row), row]));
	if (afterByKey.size !== after.length) throw new Error('SCH create后存在重复原生记录ID');
	const afterIds = new Set<string>();
	for (const row of after) {
		if (typeof row.id !== 'string' || !row.id || afterIds.has(row.id)) throw new Error(`SCH create后存在跨类型重复或无效原生记录ID：${row.id}`);
		afterIds.add(row.id);
	}
	for (const [key, prior] of beforeByKey) {
		const current = afterByKey.get(key);
		if (!current || stable(current.header) !== stable(prior.header) || stable(current.data) !== stable(prior.data)) throw new Error(`SCH create改变或删除了保留原生记录：${key.replace('\0','/')}`);
	}
	const added = after.filter(row => !beforeByKey.has(recordKey(row)));
	const priorCandidate = before.filter(row => row.type === 'COMPONENT' && row.id === input.candidateId);
	if (priorCandidate.length || input.candidateId === input.oldComponentId) throw new Error('SCH create候选ID已存在或复用了旧件ID');
	const candidateComponents = added.filter(row => row.type === 'COMPONENT' && row.id === input.candidateId);
	if (candidateComponents.length !== 1 || after.filter(row => row.type === 'COMPONENT' && row.id === input.oldComponentId).length !== 1) throw new Error('SCH create必须只新增一个候选COMPONENT并保留唯一旧件');
	const candidateAttrs = added.filter(row => row.type === 'ATTR' && (row.data as Json)?.parentId === input.candidateId);
	const allowedCandidateKeys = new Set(candidateAttrs.map(row => recordKey(row)));
	const addedByKey = new Map(added.map(row => [recordKey(row), row]));
	const extra = added.filter(row => !candidateComponents.includes(row) && !allowedCandidateKeys.has(recordKey(row)));
	const wires = extra.filter(row => row.type === 'WIRE');
	if (!wires.length && extra.length) throw new Error(`SCH create新增了无法归类的记录：${extra.slice(0,8).map(row => `${row.type}/${row.id}`).join(',')}`);
	const tolerance = input.tolerance ?? 0.00254;
	if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('SCH create端点容差无效');
	const groups: CreateSideEffectGroup[] = [];
	for (const wire of wires) {
		if (typeof wire.id !== 'string' || !wire.id || !wire.data || typeof wire.data !== 'object' || Array.isArray(wire.data)
			|| Object.keys(wire.data as Json).some(key => key !== 'zIndex') || typeof (wire.data as Json).zIndex !== 'number' || !Number.isFinite((wire.data as Json).zIndex))
			throw new Error(`SCH create临时WIRE字段不符合已验证形态：${wire.id}`);
		const lines = extra.filter(row => row.type === 'LINE' && (row.data as Json)?.lineGroup === wire.id);
		const attrs = extra.filter(row => row.type === 'ATTR' && (row.data as Json)?.parentId === wire.id);
		if (lines.length !== 1 || attrs.length !== 2) throw new Error(`SCH create临时WIRE闭包不完整：${wire.id}`);
		const line = lines[0], data = object(line.data, `临时LINE/${line.id}`);
		const allowedLineFields = new Set(['fillColor','fillStyle','strokeColor','strokeStyle','strokeWidth','startX','startY','endX','endY','lineGroup']);
		if (Object.keys(data).some(key => !allowedLineFields.has(key)) || data.lineGroup !== wire.id
			|| ![data.startX,data.startY,data.endX,data.endY].every(value => typeof value === 'number' && Number.isFinite(value))
			|| data.startX !== data.endX || data.startY !== data.endY) throw new Error(`SCH create临时LINE不是有限零长度线：${line.id}`);
		const netAttrs = attrs.filter(row => (row.data as Json)?.key === 'NET'), relevanceAttrs = attrs.filter(row => (row.data as Json)?.key === 'Relevance');
		if (netAttrs.length !== 1 || relevanceAttrs.length !== 1 || (netAttrs[0].data as Json).value !== '' || (relevanceAttrs[0].data as Json).value !== '[]'
			|| attrs.some(row => Object.keys(object(row.data, `WIRE ATTR/${row.id}`)).some(key => !new Set(['x','y','rotation','color','fontFamily','fontSize','fontWeight','italic','underline','align','value','keyVisible','valueVisible','key','fillColor','parentId','zIndex']).has(key))))
			throw new Error(`SCH create临时WIRE的NET/Relevance属性不符合已验证形态：${wire.id}`);
		if (added.filter(row => row.type === 'LINE' && (row.data as Json)?.lineGroup === wire.id).length !== lines.length
			|| added.filter(row => row.type === 'ATTR' && (row.data as Json)?.parentId === wire.id).length !== attrs.length) throw new Error(`SCH create存在对临时WIRE闭包的额外成员：${wire.id}`);
		const point: [number,number] = [data.startX as number, -(data.startY as number)];
		const matchedPinPairs = input.endpointPairs.filter(pair => {
			const near = (value: [number,number] | undefined) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
				&& Math.hypot(value[0] - point[0], value[1] - point[1]) <= tolerance;
			return near(pair.oldPoint) && near(pair.actualNewPoint);
		});
		if (!matchedPinPairs.length) throw new Error(`SCH create临时WIRE端点未绑定到已验证的新旧pinMap端点：${wire.id}`);
		groups.push({ wireId: wire.id, lineId: line.id, netAttrId: netAttrs[0].id, relevanceAttrId: relevanceAttrs[0].id, point,
			matchedPinPairs: matchedPinPairs.map(pair => ({ oldNumber: pair.oldNumber, newNumber: pair.newNumber })) });
	}
	const closureKeys = new Set(groups.flatMap(group => [`WIRE\0${group.wireId}`,`LINE\0${group.lineId}`,`ATTR\0${group.netAttrId}`,`ATTR\0${group.relevanceAttrId}`]));
	if (extra.some(row => !closureKeys.has(recordKey(row))) || added.length !== candidateComponents.length + candidateAttrs.length + closureKeys.size)
		throw new Error('SCH create新增记录包含未绑定或额外副产物');
	const allowedIds = new Set([...candidateComponents, ...candidateAttrs].map(row => row.id));
	if (candidateAttrs.some(row => !row.id || !allowedIds.has(row.id)) || addedByKey.size !== added.length) throw new Error('SCH create候选ATTR ID不唯一或无效');
	const cleanupIds = new Set([...closureKeys].map(key => key.slice(key.indexOf('\0') + 1)));
	if (cleanupIds.size !== closureKeys.size) throw new Error('SCH create临时WIRE闭包内部存在跨类型重复ID');
	if ([...cleanupIds].some(cleanupId => beforeIds.has(cleanupId))) throw new Error('SCH create临时WIRE闭包复用了创建前已有的原生记录ID');
	const candidateIds = new Set([...candidateComponents, ...candidateAttrs].map(row => row.id));
	if (candidateIds.size !== candidateComponents.length + candidateAttrs.length || [...cleanupIds].some(cleanupId => candidateIds.has(cleanupId)))
		throw new Error('SCH create临时WIRE闭包ID与候选COMPONENT/ATTR冲突');
	const referencesCleanupId = (value: unknown): boolean => Array.isArray(value) ? value.some(referencesCleanupId)
		: !!value && typeof value === 'object' ? Object.values(value as Json).some(referencesCleanupId)
		: typeof value === 'string' && cleanupIds.has(value);
	if (after.some(row => !closureKeys.has(recordKey(row)) && (referencesCleanupId(row.header) || referencesCleanupId(row.data))))
		throw new Error('SCH create保留记录包含对临时WIRE闭包的外部引用');
	return { candidateAdded: [...candidateComponents, ...candidateAttrs].map(row => ({ type: row.type, id: row.id })), groups, addedRecords: added.map(row => ({ type: row.type, id: row.id })),
		retainedRecordCount: before.length, retainedRecordsUnchanged: true };
}

/**
 * Predict the native child order/zIndex normalization performed by the SCH editor
 * for one newly created candidate. This is deliberately pure: the caller must
 * supply the selected PART, effective DEVICE META attributes and current native
 * candidate ATTR rows captured before writing anything.
 */
export function normalizeCandidateSchNative(input: {
	candidateComponent: { id: string; data: Json };
	candidateAttributes: Array<{ id: string; data: Json }>;
	symbolEffectiveRecords: Array<{ header?: { type?: string; id?: string }; type?: string; id?: string; data: Json }>;
	selectedPartId: string;
	deviceMetaAttributes: Record<string, unknown>;
	deviceDisplay: { uuid: string; title: string };
}): { componentPatch: { id: string; patch: Json } | null; attributePatches: Array<{ id: string; patch: Json }>;
	immediateWireExpected: { component: { id: string; data: Json }; attributes: Array<{ id: string; data: Json }> };
	persistedExpected: { component: { id: string; data: Json }; attributes: Array<{ id: string; data: Json }> };
	defaultTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: 'missing'; to: false }>;
	inputWireTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: false; to: 'missing' }>;
	deviceNameProof: { deviceUuid: string; title: string; source: ''; serialized: string };
	orderedChildrenProof: Array<{ type: string; id?: string; key?: string }> } {
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const component = object(input.candidateComponent, '候选SCH COMPONENT');
	const componentData = object(component.data, '候选SCH COMPONENT DATA');
	const attrs = object(componentData.attrs, '候选SCH COMPONENT attrs');
	const selectedPartId = id(input.selectedPartId, '选中SYMBOL PART');
	if (!Array.isArray(input.symbolEffectiveRecords) || !Array.isArray(input.candidateAttributes)) throw new Error('SCH原生候选/模板记录必须是数组');
	const directShapes = new Set(['PIN','RECT','LINE','POLY','ARC','CIRCLE','ELLIPSE','TEXT','BEZIER']);
	const records = input.symbolEffectiveRecords.filter(row => {
		const type = row?.header?.type ?? row?.type;
		const data = row?.data;
		return type && data && data.partId === selectedPartId && !data.parentId;
	});
	const shapes = records.filter(row => directShapes.has(String(row.header?.type ?? row.type)));
	const templateAttrs = records.filter(row => (row.header?.type ?? row.type) === 'ATTR');
	const orderedKeys = ['Add into BOM','Convert to PCB','Designator','Device','Footprint','PCB Layer'];
	for (const row of templateAttrs) {
		const key = id(row.data.key, 'SYMBOL直属ATTR键');
		const prior = orderedKeys.indexOf(key);
		if (prior >= 0) orderedKeys.splice(prior, 1);
		orderedKeys.push(key);
	}
	const deviceAttributes = object(input.deviceMetaAttributes, 'DEVICE META.attributes');
	const excluded = new Set(['Device','FootprintName','Footprints','SymbolName','Symbols']);
	const deviceKeys = Object.keys(deviceAttributes).filter(key => !excluded.has(key));
	for (const key of deviceKeys) if (!orderedKeys.includes(key)) orderedKeys.push(key);
	for (const row of input.candidateAttributes) {
		const key = id(row?.data?.key, '候选SCH ATTR键');
		if (!orderedKeys.includes(key)) orderedKeys.push(key);
	}
	const cloneKeys = new Set(['Add into BOM','Convert to PCB','Designator','Device','Footprint','PCB Layer','Unique ID', ...templateAttrs.map(row => String(row.data.key)), ...deviceKeys]);
	const componentId = id(component.id, '候选SCH COMPONENT ID');
	const multipartRelevanceIds = multipartRelevanceLifecycleIds(input.symbolEffectiveRecords, selectedPartId, componentId, input.candidateAttributes);
	const componentNext = clone(componentData), componentAttrs = object(componentNext.attrs, '克隆候选SCH COMPONENT attrs');
	const deviceUuid = id(input.deviceDisplay?.uuid, '实际DEVICE UUID'), deviceTitle = id(input.deviceDisplay?.title, '实际DEVICE META.title');
	const deviceNameProof = { deviceUuid, title: deviceTitle, source: '' as const,
		serialized: JSON.stringify({ name: deviceTitle, source: '', uuid: deviceUuid }) };
	componentAttrs.DeviceName = deviceNameProof.serialized;
	const defaultTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: 'missing'; to: false }> = [];
	const inputWireTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: false; to: 'missing' }> = [];
	if (componentAttrs.isSwitchClose === undefined || componentAttrs.isSwitchClose === false) {
		if (componentAttrs.isSwitchClose === false) inputWireTransitions.push({ type: 'COMPONENT', id: componentId, path: ['attrs','isSwitchClose'], from: false, to: 'missing' });
		componentAttrs.isSwitchClose = false;
		defaultTransitions.push({ type: 'COMPONENT', id: componentId, path: ['attrs','isSwitchClose'], from: 'missing', to: false });
	}
	const persistedAttributes: Array<{ id: string; data: Json }> = [];
	for (const row of input.candidateAttributes) {
		const rowId = id(row.id, '候选SCH ATTR ID'), original = object(row.data, `候选SCH ATTR ${rowId}`), key = id(original.key, `候选SCH ATTR ${rowId} key`);
		const next = clone(original);
		const zIndex = shapes.length + orderedKeys.indexOf(key);
		if (next.zIndex !== zIndex) next.zIndex = zIndex;
		if ((cloneKeys.has(key) || (key === 'Relevance' && multipartRelevanceIds.has(rowId))) && (next.strikeout === undefined || next.strikeout === false)) {
			if (next.strikeout === false) inputWireTransitions.push({ type: 'ATTR', id: rowId, path: ['strikeout'], from: false, to: 'missing' });
			next.strikeout = false;
			defaultTransitions.push({ type: 'ATTR', id: rowId, path: ['strikeout'], from: 'missing', to: false });
		}
		persistedAttributes.push({ id: rowId, data: next });
	}
	const immediateComponentData = clone(componentNext);
	for (const transition of defaultTransitions) if (transition.type === 'COMPONENT' && transition.path[0] === 'attrs' && transition.path[1] === 'isSwitchClose') delete immediateComponentData.attrs.isSwitchClose;
	const immediateAttributes = persistedAttributes.map(row => ({ id: row.id, data: clone(row.data) }));
	for (const transition of defaultTransitions) if (transition.type === 'ATTR' && transition.path[0] === 'strikeout') delete immediateAttributes.find(row => row.id === transition.id)!.data.strikeout;
	const immediateWireExpected = { component: { id: componentId, data: immediateComponentData }, attributes: immediateAttributes };
	const persistedExpected = { component: { id: componentId, data: componentNext }, attributes: persistedAttributes };
	const componentPatch = stable(immediateComponentData) === stable(componentData) ? null : { id: componentId, patch: { attrs: immediateComponentData.attrs } };
	const attributePatches = immediateAttributes.flatMap(row => {
		const original = input.candidateAttributes.find(candidate => candidate.id === row.id)!.data;
		return stable(row.data) === stable(original) ? [] : [{ id: row.id, patch: row.data }];
	});
	const orderedChildrenProof = [
		...shapes.map(row => ({ type: String(row.header?.type ?? row.type), id: row.header?.id ?? row.id })),
		...orderedKeys.map(key => ({ type: 'ATTR', key })),
	];
	return { componentPatch, attributePatches, immediateWireExpected, persistedExpected, defaultTransitions, inputWireTransitions, deviceNameProof, orderedChildrenProof };
}

/** Predict both fully supported native persistence outcomes from one complete wire candidate. */
export function predictCandidateSchPersistenceModels(input: {
	wireCandidate: { component: { id: string; data: Json }; attributes: Array<{ id: string; data: Json }> };
	resources: { symbolEffectiveRecords: Array<{ header?: { type?: string; id?: string }; type?: string; id?: string; data: Json }>;
		selectedPartId: string; deviceMetaAttributes: Record<string, unknown>; deviceDisplay: { uuid: string; title: string } };
}): Array<{ model: 'associated-template' | 'plain-template'; persistedExpected: { component: { id: string; data: Json }; attributes: Array<{ id: string; data: Json }> };
	defaultTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: 'missing'; to: false }>;
	orderedChildrenProof: Array<{ type: string; id?: string; key?: string }> }> {
	const { wireCandidate, resources } = input;
	const associated = normalizeCandidateSchNative({ candidateComponent: wireCandidate.component, candidateAttributes: wireCandidate.attributes,
		symbolEffectiveRecords: resources.symbolEffectiveRecords, selectedPartId: resources.selectedPartId,
		deviceMetaAttributes: resources.deviceMetaAttributes, deviceDisplay: resources.deviceDisplay });
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const component = clone(wireCandidate.component), attrs = object(component.data.attrs, 'plain-template候选COMPONENT attrs');
	const directShapes = new Set(['PIN','RECT','LINE','POLY','ARC','CIRCLE','ELLIPSE','TEXT','BEZIER']);
	const templateRows = resources.symbolEffectiveRecords.filter(row => {
		const type = row?.header?.type ?? row?.type;
		return type && row?.data && row.data.partId === resources.selectedPartId && !row.data.parentId;
	});
	const shapes = templateRows.filter(row => directShapes.has(String(row.header?.type ?? row.type)));
	const templateAttrs = templateRows.filter(row => (row.header?.type ?? row.type) === 'ATTR');
	const multipartRelevanceIds = multipartRelevanceLifecycleIds(resources.symbolEffectiveRecords, resources.selectedPartId,
		wireCandidate.component.id, wireCandidate.attributes);
	const orderedKeys = ['Add into BOM','Convert to PCB','Designator','Device','Footprint','PCB Layer'];
	for (const row of templateAttrs) {
		const key = id(row.data.key, 'plain-template SYMBOL直属ATTR键');
		const prior = orderedKeys.indexOf(key);
		if (prior >= 0) orderedKeys.splice(prior, 1);
		orderedKeys.push(key);
	}
	for (const row of wireCandidate.attributes) {
		const key = id(row.data?.key, `plain-template候选ATTR/${row.id}键`);
		if (!orderedKeys.includes(key)) orderedKeys.push(key);
	}
	const cloneKeys = new Set(['Add into BOM','Convert to PCB','Designator','Device','Footprint','PCB Layer','Symbol','Unique ID', ...templateAttrs.map(row => String(row.data.key))]);
	const defaultTransitions: Array<{ type: 'COMPONENT' | 'ATTR'; id: string; path: string[]; from: 'missing'; to: false }> = [];
	if (attrs.isSwitchClose === undefined) {
		attrs.isSwitchClose = false;
		defaultTransitions.push({ type: 'COMPONENT', id: wireCandidate.component.id, path: ['attrs','isSwitchClose'], from: 'missing', to: false });
	}
	const persistedAttributes = wireCandidate.attributes.map(row => {
		const data = clone(object(row.data, `plain-template候选ATTR/${row.id}`)), key = id(data.key, `plain-template候选ATTR/${row.id}键`);
		const zIndex = shapes.length + orderedKeys.indexOf(key);
		if (data.zIndex !== zIndex) data.zIndex = zIndex;
		if ((cloneKeys.has(key) || (key === 'Relevance' && multipartRelevanceIds.has(row.id))) && data.strikeout === undefined) {
			data.strikeout = false;
			defaultTransitions.push({ type: 'ATTR', id: row.id, path: ['strikeout'], from: 'missing', to: false });
		}
		return { id: row.id, data };
	});
	const orderedChildrenProof = [...shapes.map(row => ({ type: String(row.header?.type ?? row.type), id: row.header?.id ?? row.id })), ...orderedKeys.map(key => ({ type: 'ATTR', key }))];
	return [
		{ model: 'associated-template', persistedExpected: associated.persistedExpected, defaultTransitions: associated.defaultTransitions, orderedChildrenProof: associated.orderedChildrenProof },
		{ model: 'plain-template', persistedExpected: { component, attributes: persistedAttributes }, defaultTransitions, orderedChildrenProof },
	];
}
function defaultsOf(raw: unknown): Json { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Json : {}; }
function poseFor(replacement: Json, partIndex: number, part: Part, old?: any): { x: number; y: number; rotation: number; mirror: boolean } {
	const pose = replacement.input.schematicPoses?.[partIndex];
	const get = (key: string) => old ? state(old, key) : part.oldTyped[key];
	return pose ? { x: pose.x, y: pose.y, rotation: pose.rotation, mirror: pose.mirror ?? Boolean(get('getState_Mirror')) }
		: { x: Number(get('getState_X')), y: Number(get('getState_Y')), rotation: Number(get('getState_Rotation')), mirror: Boolean(get('getState_Mirror')) };
}
function originalPose(part: Part): { x: number; y: number; rotation: number; mirror: boolean } {
	return { x: Number(part.oldTyped.getState_X), y: Number(part.oldTyped.getState_Y), rotation: Number(part.oldTyped.getState_Rotation), mirror: Boolean(part.oldTyped.getState_Mirror) };
}
function mergedProperties(candidate: any, part: Part, pose: { x: number; y: number; rotation: number; mirror: boolean }): Json {
	const old = part.oldTyped, oldDefaults = defaultsOf(part.oldDeviceDefaults);
	const current = readProps(candidate);
	const result: Json = {
		x: pose.x, y: pose.y, rotation: pose.rotation, mirror: pose.mirror,
		addIntoBom: old.getState_AddIntoBom, addIntoPcb: old.getState_AddIntoPcb,
		designator: old.getState_Designator, uniqueId: old.getState_UniqueId, name: old.getState_Name,
		// Manufacturer/supplier fields and the base custom fields come from the newly-created DEVICE.
		manufacturer: current.getState_Manufacturer, manufacturerId: current.getState_ManufacturerId,
		supplier: current.getState_Supplier, supplierId: current.getState_SupplierId,
	};
	const nextOther = { ...defaultsOf(current.getState_OtherProperty) };
	const oldOther = defaultsOf(old.getState_OtherProperty);
	const resourceKeys = new Set(['device','devicename','devices','symbol','symbols','symbolname','footprint','footprints','footprintname','3dmodel','3dmodelname','model3d','model3dname','manufacturer','manufacturerid','manufacturerpart','supplier','supplierid','supplierpart','supplierfootprint','supplierfootprintname','lcscpartname','jlcpcbpartclass','datasheet','partnumber']);
	for (const [key, value] of Object.entries(oldOther)) {
		const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (resourceKeys.has(normalizedKey)) continue;
		const compactKey = key.replace(/\s+/g, '');
		const defaultKey = Object.hasOwn(oldDefaults, key) ? key : Object.hasOwn(oldDefaults, compactKey) ? compactKey : undefined;
		if (defaultKey === undefined || value === '' || !equal(value, oldDefaults[defaultKey])) nextOther[key] = value as string | number | boolean;
	}
	result.otherProperty = nextOther;
	return result;
}
const visualKeys = ['x','y','rotation','color','fontFamily','fontSize','fontWeight','italic','underline','strikeout','align','keyVisible','valueVisible','fillColor','locked'];
function transformPoint(x: number, y: number, from: { x: number; y: number; rotation: number; mirror: boolean }, to: { x: number; y: number; rotation: number; mirror: boolean }): [number, number] {
	const a = from.rotation * Math.PI / 180, b = to.rotation * Math.PI / 180;
	const dx = x - from.x, dy = y - from.y;
	let lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a);
	if (from.mirror) lx = -lx;
	if (to.mirror) lx = -lx;
	return [to.x + lx * Math.cos(b) - ly * Math.sin(b), to.y + lx * Math.sin(b) + ly * Math.cos(b)];
}
function snapshotPins(part: Part): Array<{ number: string; x: number; y: number; rotation: number; length: number; net?: unknown }> {
	if (!Array.isArray(part.oldPins)) throw new Error(`预备SCH part缺少冻结引脚快照：${part.componentId}`);
	const pins = part.oldPins.map((pin: any) => ({ number: String(pin.number), x: Number(pin.x), y: Number(pin.y), rotation: Number(pin.rotation), length: Number(pin.length), ...(Object.hasOwn(pin, 'net') ? { net: pin.net } : {}) }));
	if (pins.some(pin => !pin.number || ![pin.x, pin.y, pin.rotation, pin.length].every(Number.isFinite)) || new Set(pins.map(pin => pin.number)).size !== pins.length)
		throw new Error(`预备SCH part冻结引脚快照无效：${part.componentId}`);
	return pins;
}
function assertOldPinsMatchSnapshot(part: Part, actual: any[]): Array<{ number: string; x: number; y: number; rotation: number; length: number; net?: unknown }> {
	const frozen = snapshotPins(part);
	if (!Array.isArray(actual)) throw new Error(`旧SCH part引脚列表读取失败：${part.componentId}`);
	const finiteState = (pin: any, getter: string): number => {
		const value = state(pin, getter);
		if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`旧SCH引脚读回不是有限数值：${part.componentId}/${getter}`);
		return value;
	};
	const current = actual.map(pin => ({ number: String(state(pin, 'getState_PinNumber')), x: finiteState(pin, 'getState_X'), y: finiteState(pin, 'getState_Y'),
		rotation: finiteState(pin, 'getState_Rotation'), length: finiteState(pin, 'getState_PinLength'),
		...(typeof pin?.getState_Net === 'function' ? { net: state(pin, 'getState_Net') } : {}) }));
	if (current.length !== frozen.length || new Set(current.map(pin => pin.number)).size !== current.length) throw new Error(`旧SCH part引脚集合与冻结快照不符：${part.componentId}`);
	const byNumber = new Map(current.map(pin => [pin.number, pin]));
	for (const expected of frozen) {
		const value = byNumber.get(expected.number);
		if (!value || Math.hypot(value.x - expected.x, value.y - expected.y) > 0.00254
			|| Math.abs(value.rotation - expected.rotation) > 0.00254 || Math.abs(value.length - expected.length) > 0.00254
			|| (Object.hasOwn(expected, 'net') && (!Object.hasOwn(value, 'net') || stable(value.net) !== stable(expected.net))))
			throw new Error(`旧SCH引脚已偏离冻结快照：${part.componentId}/${expected.number}`);
	}
	return frozen;
}
function candidateResourceClosure(projectUuid: string, candidateResult: Json, expectedSubPart: string): Json {
	const effective = object(candidateResult.candidateDevice, 'PCB候选实际DEVICE引用');
	if (effective.libraryUuid !== projectUuid) throw new Error('PCB候选实际DEVICE未绑定当前工程库');
	const deviceUuid = id(effective.uuid, 'PCB候选实际DEVICE UUID'), docs = candidateResult.resourceDocuments;
	if (!Array.isArray(docs)) throw new Error('PCB候选缺少已验证DEVICE/SYMBOL资源闭包');
	const deviceDocs = docs.filter((doc: any) => doc?.docType === 'DEVICE' && doc.uuid === deviceUuid);
	if (deviceDocs.length !== 1 || !Array.isArray(deviceDocs[0].effectiveRecords)) throw new Error('实际DEVICE资源闭包不存在或不唯一');
	const metaRows = deviceDocs[0].effectiveRecords.filter((row: any) => row?.header?.type === 'META');
	if (metaRows.length !== 1) throw new Error('实际DEVICE资源META不存在或不唯一');
	const meta = object(metaRows[0].data, '实际DEVICE META'), metaTitle = id(meta.title, '实际DEVICE META.title'), metaAttrs = object(meta.attributes ?? meta.attrs, '实际DEVICE META attributes');
	const symbolUuid = id(metaAttrs.Symbol, '实际DEVICE META.Symbol'), symbolDocs = docs.filter((doc: any) => doc?.docType === 'SYMBOL' && doc.uuid === symbolUuid);
	if (symbolDocs.length !== 1 || !Array.isArray(symbolDocs[0].effectiveRecords)
		|| !symbolDocs[0].effectiveRecords.some((row: any) => row?.header?.type === 'PART' && row.header.id === expectedSubPart)) throw new Error('实际SYMBOL资源闭包不存在、不唯一或缺少期望PART');
	const sourceParts = (typeof meta.source === 'string' ? meta.source : '').split('|');
	const sourceLibraryUuid = sourceParts.length > 1 && sourceParts[sourceParts.length - 1] ? sourceParts[sourceParts.length - 1] : undefined;
	return { effectiveReference: { libraryUuid: projectUuid, uuid: deviceUuid }, sourceLibraryUuid, symbolUuid, deviceTitle: metaTitle,
		deviceMetaAttributes: metaAttrs, symbolEffectiveRecords: symbolDocs[0].effectiveRecords };
}
function validateCandidateResourceBinding(projectUuid: string, candidateResult: Json, candidateTyped: unknown,
	candidateNative: unknown, candidateAttrs: Array<{ id: string; data: Json }>, candidateId: string, expectedSubPart: string): Json {
	const closure = candidateResourceClosure(projectUuid, candidateResult, expectedSubPart);
	const { effectiveReference, sourceLibraryUuid, symbolUuid } = closure;
	const deviceUuid = effectiveReference.uuid;
	const typed = object(candidateTyped, 'SCH候选typed DEVICE引用');
	if (typed.uuid !== deviceUuid) throw new Error('SCH候选typed DEVICE UUID与实际DEVICE资源不符');
	const typedLibrary = typed.libraryUuid;
	if (typedLibrary !== undefined && typedLibrary !== null && typedLibrary !== ''
		&& typedLibrary !== projectUuid && (!sourceLibraryUuid || typedLibrary !== sourceLibraryUuid)) throw new Error('SCH候选typed libraryUuid既非当前工程也非DEVICE META来源库');
	const component = object(candidateNative, `SCH候选COMPONENT/${candidateId}`);
	if (component.partId !== expectedSubPart) throw new Error('SCH候选原生partId与期望PART不符');
	const nativeAttrs = object(component.attrs, `SCH候选COMPONENT/${candidateId}.attrs`), displayDeviceName = nativeAttrs.DeviceName;
	if (displayDeviceName !== undefined && displayDeviceName !== null && displayDeviceName !== '') {
		let display: Json;
		try { display = object(typeof displayDeviceName === 'string' ? JSON.parse(displayDeviceName) : displayDeviceName, 'SCH候选DeviceName'); }
		catch { throw new Error('SCH候选非空DeviceName不是有效JSON对象'); }
		if (display.uuid !== deviceUuid) throw new Error('SCH候选非空DeviceName UUID与实际DEVICE不符');
		const displayLibrary = display.libraryUuid;
		if (displayLibrary !== undefined && displayLibrary !== null && displayLibrary !== ''
			&& displayLibrary !== projectUuid && (!sourceLibraryUuid || displayLibrary !== sourceLibraryUuid)) throw new Error('SCH候选DeviceName libraryUuid既非当前工程也非DEVICE META来源库');
	}
	const deviceAttrs = candidateAttrs.filter(row => row.data.key === 'Device'), symbolAttrs = candidateAttrs.filter(row => row.data.key === 'Symbol');
	if (deviceAttrs.length !== 1 || deviceAttrs[0].data.value !== deviceUuid) throw new Error('SCH候选直属Device ATTR缺失、重复或与实际DEVICE不符');
	if (symbolAttrs.length !== 1 || symbolAttrs[0].data.value !== symbolUuid) throw new Error('SCH候选直属Symbol ATTR缺失、重复或与实际SYMBOL不符');
	return { effectiveReference, typedReference: { libraryUuid: typedLibrary, uuid: deviceUuid }, sourceLibraryUuid, symbolUuid };
}
/** The only accepted raw/typed mismatch is a raw Device ATTR value projected to empty by SCH native serialization. */
export function projectEffectiveDeviceRawExpected(expected: Json, proof: Json): Json {
	if (!proof || typeof proof !== 'object' || proof.projection !== 'device-attr-uuid-to-empty'
		|| typeof proof.candidateId !== 'string' || typeof proof.attrId !== 'string' || typeof proof.pageUuid !== 'string'
		|| typeof proof.projectUuid !== 'string' || proof.rawUuid !== proof.deviceUuid || proof.actualRawUuid !== '') throw new Error('有效Device关联投影证明无效');
	const output = JSON.parse(JSON.stringify(expected)) as Json;
	if (output?.component?.id !== proof.candidateId || !Array.isArray(output.attributes)) throw new Error('有效Device关联投影候选目标不符');
	const matches = output.attributes.filter((row: any) => row?.id === proof.attrId);
	const deviceRows = output.attributes.filter((row: any) => row?.data?.key === 'Device' && row?.data?.parentId === proof.candidateId);
	if (matches.length !== 1 || deviceRows.length !== 1 || deviceRows[0] !== matches[0]
		|| matches[0].data?.parentId !== proof.candidateId || matches[0].data?.key !== 'Device' || matches[0].data?.value !== proof.deviceUuid)
		throw new Error('有效Device关联投影未绑定唯一指定的直属Device ATTR');
	matches[0].data.value = '';
	return output;
}
export function assertEffectiveDeviceRawProjection(input: { expected: Json; actual: Json; submitted: Json; proof: Json; resourceDocuments: any[];
	projectUuid: string; pageUuid: string; candidateId: string; deviceUuid: string; symbolUuid: string; partId: string }): Json {
	const proof = input.proof;
	if (!Array.isArray(input.resourceDocuments) || proof.projection !== 'device-attr-uuid-to-empty' || proof.projectUuid !== input.projectUuid
		|| proof.pageUuid !== input.pageUuid || proof.candidateId !== input.candidateId || proof.deviceUuid !== input.deviceUuid
		|| proof.symbolUuid !== input.symbolUuid || proof.rawUuid !== input.deviceUuid || proof.actualRawUuid !== '') throw new Error('有效Device关联证明与当前候选或上下文不符');
	const submittedRow = input.submitted.attributes?.filter((row: any) => row?.id === proof.attrId) ?? [];
	if (submittedRow.length !== 1 || submittedRow[0].data?.parentId !== input.candidateId || submittedRow[0].data?.key !== 'Device'
		|| submittedRow[0].data?.value !== input.deviceUuid) throw new Error('有效Device关联提交目标未包含唯一正确原始UUID');
	const projected = projectEffectiveDeviceRawExpected(input.expected, proof);
	if (stable(projected) !== stable(input.actual)) throw new Error('raw Device投影以外的COMPONENT/ATTR变化');
	const oneDoc = (type: string, uuid: string) => {
		const docs = input.resourceDocuments.filter(row => row?.docType === type && row.uuid === uuid);
		if (docs.length !== 1 || !Array.isArray(docs[0].effectiveRecords)) throw new Error(`有效Device关联资源闭包缺失或不唯一：${type}/${uuid}`);
		return docs[0];
	};
	const device = oneDoc('DEVICE', input.deviceUuid), symbol = oneDoc('SYMBOL', input.symbolUuid), footprint = oneDoc('FOOTPRINT', proof.footprintUuid);
	const metas = device.effectiveRecords.filter((row: any) => row?.header?.type === 'META');
	if (metas.length !== 1) throw new Error('有效Device关联DEVICE META缺失或不唯一');
	const attrs = metas[0].data?.attributes ?? metas[0].data?.attrs ?? {};
	const symbolRef = attrs.Symbol, footprintRef = attrs.Footprint;
	const uuidOf = (raw: any) => { if (typeof raw !== 'string') return raw?.uuid; try { return JSON.parse(raw)?.uuid ?? raw; } catch { return raw; } };
	if (uuidOf(symbolRef) !== input.symbolUuid || uuidOf(footprintRef) !== proof.footprintUuid
		|| !symbol.effectiveRecords.some((row: any) => row?.header?.type === 'PART' && row.header.id === input.partId)) throw new Error('有效Device关联DEVICE/SYMBOL/PART/FOOTPRINT闭包不符');
	return { projectedExpected: projected, deviceTitle: metas[0].data?.title };
}
/** Reads fresh SDK objects; callers must pass the frozen resource closure identities for this candidate. */
export async function assertFreshEffectiveDeviceAssociation(api: any, proof: Json, resourceDocuments: any[]): Promise<Json> {
	if (!proof || proof.projection !== 'device-attr-uuid-to-empty' || typeof proof.candidateId !== 'string'
		|| typeof proof.attrId !== 'string' || typeof proof.deviceUuid !== 'string' || typeof proof.projectUuid !== 'string'
		|| typeof proof.pageUuid !== 'string' || typeof proof.symbolUuid !== 'string' || typeof proof.footprintUuid !== 'string'
		|| proof.rawUuid !== proof.deviceUuid || proof.actualRawUuid !== '') throw new Error('fresh typed Device关联证明结构无效');
	const assertContext = async () => {
		const project = await api.dmt_Project.getCurrentProjectInfo(), info = await api.dmt_SelectControl.getCurrentDocumentInfo();
		if (project?.uuid !== proof.projectUuid || info?.uuid !== proof.pageUuid || info?.parentProjectUuid !== proof.projectUuid || info?.documentType !== 1)
			throw new Error('fresh typed Device关联当前工程/原理图页上下文不符');
	};
	await assertContext();
	if (!Array.isArray(resourceDocuments)) throw new Error('fresh typed Device关联缺少当前资源闭包');
	const deviceDocs = resourceDocuments.filter((doc: any) => doc?.docType === 'DEVICE' && doc.uuid === proof.deviceUuid);
	if (deviceDocs.length !== 1 || !Array.isArray(deviceDocs[0].effectiveRecords)) throw new Error('fresh typed Device关联DEVICE资源缺失或不唯一');
	const metas = deviceDocs[0].effectiveRecords.filter((row: any) => row?.header?.type === 'META');
	if (metas.length !== 1) throw new Error('fresh typed Device关联DEVICE META缺失或不唯一');
	const metaData = metas[0].data, metaAttrs = object(metaData?.attributes ?? metaData?.attrs, 'fresh DEVICE META attributes');
	const sourceParts = (typeof metaData?.source === 'string' ? metaData.source : '').split('|');
	const sourceOwner = sourceParts.length > 1 && sourceParts.at(-1) ? sourceParts.at(-1) : undefined;
	const symbolDocs = resourceDocuments.filter((doc: any) => doc?.docType === 'SYMBOL' && doc.uuid === proof.symbolUuid);
	const footprintDocs = resourceDocuments.filter((doc: any) => doc?.docType === 'FOOTPRINT' && doc.uuid === proof.footprintUuid);
	const uuidOf = (raw: any) => { if (typeof raw !== 'string') return raw?.uuid; try { return JSON.parse(raw)?.uuid ?? raw; } catch { return raw; } };
	if (proof.sourceLibraryUuid !== sourceOwner || uuidOf(metaAttrs.Symbol) !== proof.symbolUuid || uuidOf(metaAttrs.Footprint) !== proof.footprintUuid
		|| symbolDocs.length !== 1 || footprintDocs.length !== 1 || !symbolDocs[0].effectiveRecords?.some((row: any) => row?.header?.type === 'PART' && row.header.id === proof.partId))
		throw new Error('fresh typed Device关联资源来源库/SYMBOL/PART/FOOTPRINT不符');
	const attr = await api.sch_PrimitiveAttribute.get(proof.attrId);
	if (!attr) throw new Error('fresh typed Device ATTR不存在');
	const typedAttr = { primitiveId: state(attr, 'getState_PrimitiveId'), parentPrimitiveId: state(attr, 'getState_ParentPrimitiveId'), key: state(attr, 'getState_Key'), value: state(attr, 'getState_Value') };
	if (typedAttr.primitiveId !== proof.attrId || typedAttr.parentPrimitiveId !== proof.candidateId || typedAttr.key !== 'Device' || typedAttr.value !== proof.deviceUuid)
		throw new Error('fresh typed Device ATTR身份、父级、键或值不符');
	const component = await api.sch_PrimitiveComponent.get(proof.candidateId);
	if (!component || state(component, 'getState_PrimitiveId') !== proof.candidateId) throw new Error('fresh SCH候选COMPONENT不存在或ID不符');
	const reference = object(state(component, 'getState_Component'), 'fresh SCH候选DEVICE引用');
	if (reference.uuid !== proof.deviceUuid || (reference.libraryUuid !== proof.projectUuid && (!sourceOwner || reference.libraryUuid !== sourceOwner))) throw new Error('fresh SCH候选DEVICE引用与当前资源绑定不符');
	await assertContext();
	return { typedAttr, typedReference: { libraryUuid: reference.libraryUuid, uuid: reference.uuid } };
}
async function checkPartPins(api: any, projectUuid: string, replacement: Prepared['replacements'][number], part: Part, candidateId: string, candidate: any, candidateResult: Json): Promise<Json> {
	if (id(state(candidate, 'getState_PrimitiveId'), 'SCH候选PrimitiveId') !== candidateId) throw new Error('SCH候选ID/实际对象绑定不符');
	const candidateTyped = state(candidate, 'getState_Component');
	if (state(candidate, 'getState_SubPartName') !== part.newSubPartName) throw new Error('SCH候选typed SubPartName与期望PART不符');
	const source = await api.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string') throw new Error('SCH候选资源绑定源码读回失败');
	const parsed = parseReplacementNativeSource(source, part.pageUuid, 'SCH_PAGE');
	const nativeMatches = parsed.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
	if (nativeMatches.length !== 1) throw new Error('SCH候选原生COMPONENT不存在或不唯一');
	const binding = validateCandidateResourceBinding(projectUuid, candidateResult, candidateTyped, nativeMatches[0].data,
		attrRecords(parsed.records, candidateId), candidateId, part.newSubPartName);
	const pins = await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(candidateId);
	if (!Array.isArray(pins)) throw new Error('SCH候选引脚列表读取失败');
	const readNumber = (pin: any, getter: string): number => {
		const value = state(pin, getter);
		if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`SCH候选引脚读回不是有限数值：${candidateId}/${getter}`);
		return value;
	};
	const candidatePins = pins.map((pin: any) => ({ number: String(state(pin, 'getState_PinNumber')), x: readNumber(pin, 'getState_X'), y: readNumber(pin, 'getState_Y'),
		rotation: readNumber(pin, 'getState_Rotation'), length: readNumber(pin, 'getState_PinLength') }));
	if (candidatePins.some(pin => !pin.number) || new Set(candidatePins.map(pin => pin.number)).size !== candidatePins.length) throw new Error('SCH候选引脚编号重复或无效');
	candidatePins.sort((a, b) => a.number.localeCompare(b.number));
	const oldPins = assertOldPinsMatchSnapshot(part, await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(part.componentId));
	const oldByNumber = new Map(oldPins.map(pin => [pin.number, pin])), newByNumber = new Map(candidatePins.map(pin => [pin.number, pin]));
	const mappedPairs: Array<{ oldNumber: string; newNumber: string; oldPoint: [number, number]; actualNewPoint: [number, number] }> = [];
	for (const mapping of replacement.input.pinMap) {
		const newPin = newByNumber.get(String(mapping.newNumber)); if (!newPin) continue;
		const oldPin = oldByNumber.get(String(mapping.oldNumber));
		if (!oldPin) throw new Error(`新part含有pinMap目标 ${mapping.newNumber}，但旧part缺少对应pin ${mapping.oldNumber}`);
		const oldPoint: [number, number] = [oldPin.x, oldPin.y], actualNewPoint: [number, number] = [newPin.x, newPin.y];
		if (Math.hypot(actualNewPoint[0] - oldPoint[0], actualNewPoint[1] - oldPoint[1]) > 0.00254)
			throw new Error(`SCH pinMap ${mapping.oldNumber}->${mapping.newNumber} 实际世界端点偏离旧连接点：old=${oldPoint}, actual=${actualNewPoint}`);
		mappedPairs.push({ oldNumber: String(mapping.oldNumber), newNumber: String(mapping.newNumber), oldPoint, actualNewPoint });
	}
	return { candidateDeviceReference: binding.effectiveReference, candidateTypedReference: binding.typedReference, sourceLibraryUuid: binding.sourceLibraryUuid, symbolUuid: binding.symbolUuid,
		subPartName: part.newSubPartName, mappedPairs,
		pins: candidatePins.map(pin => ({ ...pin })) };
}
function attrRecords(records: Array<{ type: string; id: string; data: unknown }>, parentId: string): Array<{ id: string; data: Json }> {
	return records.filter(record => record.type === 'ATTR').map(record => ({ id: record.id, data: object(record.data, `ATTR/${record.id}`) })).filter(record => record.data.parentId === parentId);
}
function ensureCandidateBusinessAttrs(source: string, pageUuid: string, oldId: string, candidateId: string): { source: string; added: string[] } {
	const parsed = parseReplacementNativeSource(source, pageUuid, 'SCH_PAGE'), oldRows = attrRecords(parsed.records, oldId), candidateRows = attrRecords(parsed.records, candidateId);
	const keys = ['Reuse Block', 'Group ID', 'Channel ID', 'Multi-Part Group'];
	const recordsToAdd: Array<{ id: string; data: Json }> = [];
	const usedIds = new Set(parsed.records.map(record => record.id));
	let highestTicket = 0;
	for (const line of source.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const separator = line.indexOf('||'); if (separator < 0) throw new Error('SCH源码新增ATTR前发现无效source log');
		const header = object(JSON.parse(line.slice(0, separator)), 'SCH source log header');
		if (header.ticket !== undefined && (!Number.isFinite(Number(header.ticket)) || Number(header.ticket) < 0)) throw new Error('SCH源码ticket无效');
		highestTicket = Math.max(highestTicket, Number(header.ticket ?? 0));
	}
	const cryptoApi = globalThis.crypto;
	for (const key of keys) {
		const oldForKey = oldRows.filter(row => row.data.key === key), candidateForKey = candidateRows.filter(row => row.data.key === key);
		if (candidateForKey.length > oldForKey.length) throw new Error(`候选 SCH ATTR 多于旧件，无法安全迁移：${key}`);
		for (let occurrence = candidateForKey.length; occurrence < oldForKey.length; occurrence++) {
			if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') throw new Error('当前环境缺少安全随机源，不能分配新SCH ATTR ID');
			let newId = '';
			for (let attempt = 0; attempt < 8 && !newId; attempt++) {
				const bytes = cryptoApi.getRandomValues(new Uint8Array(8));
				const proposed = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
				if (!usedIds.has(proposed)) { newId = proposed; usedIds.add(proposed); }
			}
			if (!newId) throw new Error(`无法生成唯一SCH ATTR ID：${key}`);
			const data = JSON.parse(JSON.stringify(oldForKey[occurrence].data)) as Json;
			if (Object.hasOwn(data, 'id')) data.id = newId;
			data.parentId = candidateId;
			recordsToAdd.push({ id: newId, data });
		}
	}
	if (!recordsToAdd.length) return { source, added: [] };
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	let next = source.endsWith('\n') ? source : source + eol;
	for (const row of recordsToAdd) next += `${JSON.stringify({ type: 'ATTR', ticket: ++highestTicket, id: row.id })}||${JSON.stringify(row.data)}|${eol}`;
	return { source: next, added: recordsToAdd.map(row => row.id) };
}
function attributeUpdates(part: Part, candidateRecords: Array<{ type: string; id: string; data: unknown }>, candidateId: string,
	from: { x: number; y: number; rotation: number; mirror: boolean }, to: { x: number; y: number; rotation: number; mirror: boolean }): Array<{ type: string; id: string; patch: Json }> {
	const oldAttrs = attrRecords(part.native.records, part.componentId), newAttrs = attrRecords(candidateRecords, candidateId);
	const oldByKey = new Map<string, Json[]>(), newByKey = new Map<string, Array<{ id: string; data: Json }>>();
	for (const row of oldAttrs) oldByKey.set(String(row.data.key), [...(oldByKey.get(String(row.data.key)) ?? []), row.data]);
	for (const row of newAttrs) newByKey.set(String(row.data.key), [...(newByKey.get(String(row.data.key)) ?? []), row]);
	const transferKeys = new Set(['Reuse Block','Group ID','Channel ID','Multi-Part Group']);
	const updates: Array<{ type: string; id: string; patch: Json }> = [];
	for (const key of new Set([...oldByKey.keys()].filter(value => newByKey.has(value)))) {
		const oldRows = oldByKey.get(key) ?? [], newRows = newByKey.get(key) ?? [];
		if (transferKeys.has(key) && newRows.length < oldRows.length) throw new Error(`候选 SCH ATTR 关联出现次数不足：${key}`);
		for (let occurrence = 0; occurrence < oldRows.length; occurrence++) {
			if (!newRows[occurrence]) continue;
			const old = oldRows[occurrence], patch: Json = {};
			for (const field of visualKeys) if (Object.hasOwn(old, field)) patch[field] = old[field];
			if (typeof old.x === 'number' && typeof old.y === 'number') {
				const [x, sdkY] = transformPoint(old.x, -old.y, from, to); patch.x = x; patch.y = -sdkY;
			}
			if (typeof old.rotation === 'number') {
				// Native SCH ATTR coordinates/angles use the opposite Y direction from typed SDK poses.
				const radians = -old.rotation * Math.PI / 180;
				const [ox, oy] = transformPoint(0, 0, from, to), [dx, dy] = transformPoint(Math.cos(radians), Math.sin(radians), from, to);
				const angle = -Math.atan2(dy - oy, dx - ox) * 180 / Math.PI;
				patch.rotation = ((angle % 360) + 360) % 360;
			}
			if (transferKeys.has(key)) patch.value = old.value;
			// Each update targets a new ATTR id; candidate identity and non-association value remain intact.
			updates.push({ type: 'ATTR', id: newRows[occurrence].id, patch });
		}
	}
	return updates;
}

/** Executes one readback-verified SCH replacement stage. Each mutating stage is single-shot. */
export async function performSchematicReplacementStage(api: any, prepared: Prepared, replacementIndex: number, stage: string, context: Context): Promise<Json> {
	context.assertActive?.();
	const replacement = prepared.replacements[replacementIndex];
	if (!replacement) throw new Error(`replacement索引无效：${replacementIndex}`);
	const partIndex = context.partIndex;
	if (!Number.isInteger(partIndex) || partIndex! < 0) throw new Error('SCH阶段缺少有效 partIndex');
	const part = replacement.schematicParts[partIndex!];
	if (!part) throw new Error(`SCH part索引无效：${partIndex}`);
	const project = await api.dmt_Project.getCurrentProjectInfo();
	if (!project || project.uuid !== prepared.projectUuid) throw new Error('当前工程与预备SCH替换工程不符');
	await activateOrOpenReplacementDocument(api, prepared.projectUuid, part.pageUuid);
	const info = await api.dmt_SelectControl.getCurrentDocumentInfo();
	if (!info || info.uuid !== part.pageUuid || info.parentProjectUuid !== prepared.projectUuid || info.documentType !== 1) throw new Error('当前文档不是目标SCH页面');
	const source = await api.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim()) throw new Error('读取SCH页面源码失败');
	const parsed = parseReplacementNativeSource(source, part.pageUuid, 'SCH_PAGE');
	const nativeComponent = (componentId: string) => {
		const matches = parsed.records.filter(row => row.type === 'COMPONENT' && row.id === componentId);
		if (matches.length !== 1) throw new Error(`SCH COMPONENT不存在或不唯一：${componentId}`);
		return object(matches[0].data, `COMPONENT/${componentId}`);
	};
	const oldNativeMatches = part.native.records.filter(row => row.type === 'COMPONENT' && row.id === part.componentId);
	if (oldNativeMatches.length !== 1) throw new Error(`预备SCH COMPONENT不存在或不唯一：${part.componentId}`);
	const oldData = object(oldNativeMatches[0].data, `预备COMPONENT/${part.componentId}`);
	const old = await api.sch_PrimitiveComponent.get(part.componentId);
	if (stage !== 'schematic_restore_properties' && stage !== 'schematic_restore_association'
		&& (!old || state(old, 'getState_UniqueId') !== replacement.input.oldUid)) throw new Error('SCH旧件ID/UID不符');
	if (stage !== 'schematic_restore_properties' && stage !== 'schematic_restore_association'
		&& stable(nativeComponent(part.componentId)) !== stable(oldData)) throw new Error('SCH旧件原生数据已偏离预备快照');
	const createResult = (): Json => stageResult(context.previousResults, 'schematic_create_part', replacementIndex, partIndex!);
	const verifyResult = (): Json => stageResult(context.previousResults, 'schematic_verify_part', replacementIndex, partIndex!);
	if (stage === 'schematic_create_part') {
		const candidateResult = replacementResult(context.previousResults, 'pcb_verify_candidate', replacementIndex);
		const closure = candidateResourceClosure(prepared.projectUuid, candidateResult, part.newSubPartName);
		const ref = closure.effectiveReference;
		const pose = poseFor(replacement, partIndex!, part, old);
		const createEvidence: Json = { stage, replacementIndex, partIndex, oldComponentId: part.componentId, candidateId: null, deviceReference: ref,
			beforeSource: source, afterCreateSource: null, cleanupClassification: null, cleanupAttempt: null, afterCleanupSource: null, reason: null };
		try {
			context.assertActive?.();
			createEvidence.createAttempted = true;
			const created = await api.sch_PrimitiveComponent.create(ref, pose.x, pose.y,
				part.newSubPartName, pose.rotation, pose.mirror,
				Boolean(state(old, 'getState_AddIntoBom')), Boolean(state(old, 'getState_AddIntoPcb')));
			context.assertActive?.();
			if (!created) throw new Error('SCH候选create未返回对象');
			const candidateId = id(state(created, 'getState_PrimitiveId'), 'SCH候选ID');
			createEvidence.candidateId = candidateId;
			if (candidateId === part.componentId || state(created, 'getState_UniqueId') === replacement.input.oldUid) throw new Error('SCH候选create复用了旧件ID或UID');
			const readback = await api.sch_PrimitiveComponent.get(candidateId);
			if (!readback || state(readback, 'getState_Component')?.uuid !== ref.uuid || state(readback, 'getState_SubPartName') !== part.newSubPartName) throw new Error('SCH候选实际Device/part读回不符');
			let afterCreateSource = await api.sys_FileManager.getDocumentSource();
			if (typeof afterCreateSource !== 'string') throw new Error('SCH候选创建后原生源码读取失败');
			createEvidence.afterCreateSource = afterCreateSource;
			let afterCreate = parseReplacementNativeSource(afterCreateSource, part.pageUuid, 'SCH_PAGE');
			let createdNative = afterCreate.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
			if (createdNative.length !== 1 || !afterCreate.records.some(row => row.type === 'COMPONENT' && row.id === part.componentId)) throw new Error('SCH候选创建后原生候选/旧件记录不完整');
			// Avoid moving the existing endpoint verification earlier for ordinary creates;
			// only a create that emitted temporary wires needs pin proof before cleanup.
			const beforeWireIds = new Set(parseReplacementNativeSource(source, part.pageUuid, 'SCH_PAGE').records.filter(row => row.type === 'WIRE').map(row => row.id));
			const createdWireIds = afterCreate.records.filter(row => row.type === 'WIRE' && !beforeWireIds.has(row.id)).map(row => row.id);
			const pinProof = createdWireIds.length
				? await checkPartPins(api, prepared.projectUuid, replacement, part, candidateId, readback, candidateResult)
				: null;
			const classification = classifySchematicCreateSideEffects({ beforeSource: source, afterSource: afterCreateSource, pageUuid: part.pageUuid,
				oldComponentId: part.componentId, candidateId, endpointPairs: (pinProof?.mappedPairs ?? []).map((pair: any) => ({ oldPoint: pair.oldPoint, actualNewPoint: pair.actualNewPoint,
					oldNumber: pair.oldNumber, newNumber: pair.newNumber })) });
			createEvidence.cleanupClassification = classification;
			let cleanup = { status: 'none', groups: classification.groups, deletedWireIds: [] as string[], deleteAck: null as unknown, removedKeys: [] as string[], retainedRecordCount: classification.retainedRecordCount, retainedRecordsUnchanged: true };
			if (classification.groups.length) {
				const wireIds = classification.groups.map(group => group.wireId);
				createEvidence.cleanupAttempt = { wireIds, acknowledged: null, error: null };
				let deleteError: unknown;
				try { context.assertActive?.(); createEvidence.cleanupAttempt.acknowledged = await api.sch_PrimitiveWire.delete(wireIds); context.assertActive?.(); }
				catch (error) { deleteError = error; createEvidence.cleanupAttempt.error = error instanceof Error ? error.message : String(error); }
				const afterCleanupSource = await api.sys_FileManager.getDocumentSource();
				createEvidence.afterCleanupSource = typeof afterCleanupSource === 'string' ? afterCleanupSource : null;
				if (typeof afterCleanupSource !== 'string') throw new Error('SCH临时WIRE清理后源码读回失败');
				const afterCleanup = parseReplacementNativeSource(afterCleanupSource, part.pageUuid, 'SCH_PAGE');
				const removedKeys = classification.groups.flatMap(group => [`WIRE\0${group.wireId}`,`LINE\0${group.lineId}`,`ATTR\0${group.netAttrId}`,`ATTR\0${group.relevanceAttrId}`]).sort();
				const removedSet = new Set(removedKeys), expectedRows = afterCreate.records.filter(row => !removedSet.has(`${row.type}\0${row.id}`));
				if (stable(expectedRows.map(row => ({ header: row.header, data: row.data }))) !== stable(afterCleanup.records.map(row => ({ header: row.header, data: row.data }))))
					throw new Error('SCH临时WIRE清理读回未精确移除闭包或改变了候选/旧件/保留记录');
				if (!afterCleanup.records.some(row => row.type === 'COMPONENT' && row.id === candidateId)
					|| !afterCleanup.records.some(row => row.type === 'COMPONENT' && row.id === part.componentId)) throw new Error('SCH临时WIRE清理后候选或旧件缺失');
				if (deleteError) throw deleteError;
				if (createEvidence.cleanupAttempt.acknowledged !== true) throw new Error('SCH临时WIRE清理未收到true确认');
				const pinsAfterCleanup = await checkPartPins(api, prepared.projectUuid, replacement, part, candidateId, readback, candidateResult);
				if (!pinProof || stable(pinsAfterCleanup.pins) !== stable(pinProof.pins) || stable(pinsAfterCleanup.mappedPairs) !== stable(pinProof.mappedPairs)) throw new Error('SCH临时WIRE清理改变了新旧pinMap端点');
				afterCreateSource = afterCleanupSource;
				afterCreate = afterCleanup;
				createdNative = afterCreate.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
				cleanup = { status: 'deleted', groups: classification.groups, deletedWireIds: wireIds, deleteAck: true,
					removedKeys, retainedRecordCount: expectedRows.length, retainedRecordsUnchanged: true };
			}
			const businessAttrs = ensureCandidateBusinessAttrs(afterCreateSource, part.pageUuid, part.componentId, candidateId);
			if (businessAttrs.added.length) {
				context.assertActive?.(); const attrsAck = await api.sys_FileManager.setDocumentSource(businessAttrs.source); context.assertActive?.(); if (attrsAck !== true) throw new Error('SCH候选业务关联ATTR新增未确认');
				afterCreateSource = await api.sys_FileManager.getDocumentSource();
				if (typeof afterCreateSource !== 'string') throw new Error('SCH候选业务关联ATTR新增后读回失败');
				afterCreate = parseReplacementNativeSource(afterCreateSource, part.pageUuid, 'SCH_PAGE');
				createdNative = afterCreate.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
				if (createdNative.length !== 1 || !afterCreate.records.some(row => row.type === 'COMPONENT' && row.id === part.componentId)) throw new Error('新增业务ATTR后候选/旧件记录不完整');
			}
			const oldBusinessAttrs = attrRecords(part.native.records, part.componentId).filter(row => ['Reuse Block','Group ID','Channel ID','Multi-Part Group'].includes(String(row.data.key)));
			const actualBusinessAttrs = attrRecords(afterCreate.records, candidateId).filter(row => ['Reuse Block','Group ID','Channel ID','Multi-Part Group'].includes(String(row.data.key)));
			if (oldBusinessAttrs.length !== actualBusinessAttrs.length || oldBusinessAttrs.some(row => actualBusinessAttrs.filter(target => target.data.key === row.data.key).length < oldBusinessAttrs.filter(oldRow => oldRow.data.key === row.data.key).length))
				throw new Error('SCH候选未能在删旧前完整建立业务关联ATTR');
			const finalCandidate = await api.sch_PrimitiveComponent.get(candidateId);
			if (!finalCandidate) throw new Error('SCH候选清理后对象缺失');
			const binding = validateCandidateResourceBinding(prepared.projectUuid, candidateResult, state(finalCandidate, 'getState_Component'), createdNative[0].data,
				attrRecords(afterCreate.records, candidateId), candidateId, part.newSubPartName);
			return { stage, replacementIndex, partIndex, candidateId, deviceReference: binding.effectiveReference, typedDeviceReference: binding.typedReference,
				subPartName: part.newSubPartName, addedBusinessAttrIds: businessAttrs.added, createSideEffectCleanup: cleanup };
		} catch (error) {
			createEvidence.reason = error instanceof Error ? error.message : String(error);
			attachFailureEvidence(error, createEvidence);
		}
	}
	const candidateId = id(createResult().candidateId, 'SCH候选ID');
	const candidate = await api.sch_PrimitiveComponent.get(candidateId);
	if (!candidate) throw new Error(`SCH候选不存在：${candidateId}`);
	if (stage === 'schematic_verify_part') {
		const candidateProof = await checkPartPins(api, prepared.projectUuid, replacement, part, candidateId, candidate, replacementResult(context.previousResults, 'pcb_verify_candidate', replacementIndex));
		const mappedPairs = candidateProof.mappedPairs;
		if (partIndex === (context.partCount ?? replacement.schematicParts.length) - 1) {
			const priorPairs = context.previousResults.filter((row: any) => row?.stage === 'schematic_verify_part' && row?.replacementIndex === replacementIndex).flatMap((row: any) => row.mappedPairs ?? []);
			const all = [...priorPairs, ...mappedPairs], seenOld = new Set(all.map((row: any) => row.oldNumber)), seenNew = new Set(all.map((row: any) => row.newNumber));
			const actualPairs = all.map((row: any) => `${row.oldNumber}\0${row.newNumber}`).sort();
			const expectedPairs = replacement.input.pinMap.map((row: any) => `${row.oldNumber}\0${row.newNumber}`).sort();
			if (all.length !== replacement.input.pinMap.length || seenOld.size !== all.length || seenNew.size !== all.length || stable(actualPairs) !== stable(expectedPairs)) throw new Error('SCH multipart pinMap 未由各新PART联合完整覆盖');
		}
		return { stage, replacementIndex, partIndex, candidateId, candidateDeviceUuid: candidateProof.candidateDeviceReference.uuid,
			candidateLibraryUuid: candidateProof.candidateDeviceReference.libraryUuid, candidateTypedLibraryUuid: candidateProof.candidateTypedReference.libraryUuid,
			candidateSourceLibraryUuid: candidateProof.sourceLibraryUuid, subPartName: candidateProof.subPartName, mappedPairs, pins: candidateProof.pins };
	}
	if (stage === 'schematic_delete_old_part') {
		const verified = verifyResult();
		const refreshedProof = await checkPartPins(api, prepared.projectUuid, replacement, part, candidateId, candidate, replacementResult(context.previousResults, 'pcb_verify_candidate', replacementIndex));
		if (verified.candidateId !== candidateId || verified.candidateDeviceUuid !== refreshedProof.candidateDeviceReference.uuid
			|| verified.candidateLibraryUuid !== refreshedProof.candidateDeviceReference.libraryUuid || verified.subPartName !== refreshedProof.subPartName
			|| stable(verified.mappedPairs) !== stable(refreshedProof.mappedPairs) || stable(verified.pins) !== stable(refreshedProof.pins)) throw new Error('SCH候选在删除前与冻结验证不一致');
		context.assertActive?.(); const deleteAck = await api.sch_PrimitiveComponent.delete([part.componentId]); context.assertActive?.(); if (deleteAck !== true) throw new Error('删除旧SCH part未确认');
		const afterSource = await api.sys_FileManager.getDocumentSource();
		if (typeof afterSource !== 'string') throw new Error('删除旧SCH part后源码读回失败');
		const after = parseReplacementNativeSource(afterSource, part.pageUuid, 'SCH_PAGE');
		if (after.records.some(row => row.type === 'COMPONENT' && row.id === part.componentId) || !after.records.some(row => row.type === 'COMPONENT' && row.id === candidateId)) throw new Error('SCH旧件删除后候选/旧件状态不符');
		return { stage, replacementIndex, partIndex, candidateId, deletedOldId: part.componentId };
	}
	if (stage === 'schematic_restore_properties') {
		stageResult(context.previousResults, 'schematic_delete_old_part', replacementIndex, partIndex!);
		const expected = mergedProperties(candidate, part, poseFor(replacement, partIndex!, part));
		context.assertActive?.(); const modifyAck = await api.sch_PrimitiveComponent.modify(candidateId, expected); context.assertActive?.(); if (!modifyAck) throw new Error('SCH候选完整属性恢复未返回对象');
		const restored = await api.sch_PrimitiveComponent.get(candidateId);
		if (!restored) throw new Error('SCH候选完整属性恢复后对象缺失');
		for (const [key, value] of Object.entries(expected)) if (!equal(state(restored, `getState_${key[0].toUpperCase()}${key.slice(1)}`), value)) throw new Error(`SCH候选属性读回不符：${key}`);
		return { stage, replacementIndex, partIndex, candidateId, expectedTyped: readProps(restored) };
	}
	if (stage === 'schematic_restore_association') {
		const properties = stageResult(context.previousResults, 'schematic_restore_properties', replacementIndex, partIndex!);
		const from = originalPose(part), to = poseFor(replacement, partIndex!, part);
		const componentAssociationPatch: Json = {};
		if (Object.hasOwn(oldData, 'groupId')) componentAssociationPatch.groupId = oldData.groupId;
		const associationUpdates = [{ type: 'COMPONENT', id: candidateId, patch: componentAssociationPatch }, ...attributeUpdates(part, parsed.records, candidateId, from, to)];
		const associationSource = patchReplacementNativeSource(source, part.pageUuid, 'SCH_PAGE', associationUpdates);
		const associationParsed = parseReplacementNativeSource(associationSource, part.pageUuid, 'SCH_PAGE');
		const candidateComponentRows = associationParsed.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
		if (candidateComponentRows.length !== 1) throw new Error('SCH归一化前候选COMPONENT不存在或不唯一');
		const candidateAttributes = attrRecords(associationParsed.records, candidateId);
		const candidateResult = replacementResult(context.previousResults, 'pcb_verify_candidate', replacementIndex);
		const closure = candidateResourceClosure(prepared.projectUuid, candidateResult, part.newSubPartName);
		const candidateComponentData = object(candidateComponentRows[0].data, '归一化前候选COMPONENT DATA');
		const failureEvidence: Json = {
			projectUuid: prepared.projectUuid, pageUuid: part.pageUuid, candidateId, partId: part.newSubPartName,
			deviceIdentity: { libraryUuid: closure.effectiveReference.libraryUuid, uuid: closure.effectiveReference.uuid },
			symbolIdentity: { uuid: closure.symbolUuid }, beforeSource: source,
			associationMergedSource: associationSource,
			preNormalizationCandidate: { component: { id: candidateId, data: candidateComponentData }, attributes: candidateAttributes },
			preNormalizationHeaders: { component: candidateComponentRows[0].header,
				attributes: associationParsed.records.filter(row => row.type === 'ATTR' && candidateAttributes.some(attr => attr.id === row.id)).map(row => ({ id: row.id, header: row.header })) },
			attemptedSource: null, writeAck: null, writeAttempted: false, failurePosition: 'normalize',
			wireExpected: null, persistedExpected: null, persistenceModels: null, defaultTransitions: [],
			readbackSource: null, actualComponent: null, actualAttributes: null, actualTyped: null,
			readbackHeaders: null, componentDiff: [], attributeDiff: [], headerDiff: [], submittedTarget: null,
			inputWireTransitions: [], deviceNameProof: null, reason: null,
		};
		try {
			failureEvidence.failurePosition = 'prewrite-resource-validation';
			const candidateBinding = validateCandidateResourceBinding(prepared.projectUuid, candidateResult, state(candidate, 'getState_Component'),
				candidateComponentData, candidateAttributes, candidateId, part.newSubPartName);
			const normalized = normalizeCandidateSchNative({ candidateComponent: { id: candidateId, data: candidateComponentData },
				candidateAttributes, symbolEffectiveRecords: closure.symbolEffectiveRecords, selectedPartId: part.newSubPartName,
				deviceMetaAttributes: closure.deviceMetaAttributes,
				deviceDisplay: { uuid: closure.effectiveReference.uuid, title: closure.deviceTitle } });
			const wireExpected = normalized.immediateWireExpected, persistedExpected = normalized.persistedExpected;
			let effectiveWireExpected = wireExpected;
			let persistenceModels = predictCandidateSchPersistenceModels({ wireCandidate: wireExpected, resources: {
				symbolEffectiveRecords: closure.symbolEffectiveRecords, selectedPartId: part.newSubPartName,
				deviceMetaAttributes: closure.deviceMetaAttributes,
				deviceDisplay: { uuid: closure.effectiveReference.uuid, title: closure.deviceTitle },
			} });
				failureEvidence.wireExpected = wireExpected;
			failureEvidence.persistedExpected = persistedExpected;
			failureEvidence.persistenceModels = persistenceModels;
			failureEvidence.defaultTransitions = normalized.defaultTransitions;
			failureEvidence.inputWireTransitions = normalized.inputWireTransitions;
			failureEvidence.deviceNameProof = normalized.deviceNameProof;
			const submittedComponentData = JSON.parse(JSON.stringify(wireExpected.component.data)) as Json;
			if (candidateComponentData.attrs.isSwitchClose === false) submittedComponentData.attrs.isSwitchClose = false;
			const finalUpdates = [
				{ type: 'COMPONENT', id: candidateId, patch: submittedComponentData },
				...wireExpected.attributes.map(row => ({ type: 'ATTR', id: row.id, patch: row.data })),
			];
			const patched = patchReplacementNativeSource(associationSource, part.pageUuid, 'SCH_PAGE', finalUpdates);
			failureEvidence.attemptedSource = patched;
			const submittedParsed = parseReplacementNativeSource(patched, part.pageUuid, 'SCH_PAGE');
			const submittedComponents = submittedParsed.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
			if (submittedComponents.length !== 1) throw new Error('SCH提交源码中的候选COMPONENT不唯一');
			failureEvidence.submittedTarget = { component: { id: candidateId, data: object(submittedComponents[0].data, 'SCH提交候选COMPONENT') },
				attributes: attrRecords(submittedParsed.records, candidateId) };
			failureEvidence.failurePosition = 'setDocumentSource';
			if (patched !== source) {
				failureEvidence.writeAttempted = true;
				context.assertActive?.(); failureEvidence.writeAck = await api.sys_FileManager.setDocumentSource(patched); context.assertActive?.();
				if (failureEvidence.writeAck !== true) throw new Error('SCH原生关联属性写入未确认');
			} else failureEvidence.writeAck = 'not-needed-source-unchanged';
			failureEvidence.failurePosition = 'getDocumentSource';
			const readbackSource = await api.sys_FileManager.getDocumentSource();
			failureEvidence.readbackSource = typeof readbackSource === 'string' ? readbackSource : null;
			if (typeof readbackSource !== 'string') throw new Error('SCH原生关联属性读回失败');
			const readback = parseReplacementNativeSource(readbackSource, part.pageUuid, 'SCH_PAGE');
			const targetIds = new Set([candidateId, ...attrRecords(submittedParsed.records, candidateId).map(row => row.id)]);
			const strictTypedRecords = (rows: typeof submittedParsed.records) => rows.filter(row => row.type === 'COMPONENT' || row.type === 'ATTR')
				.filter(row => !targetIds.has(row.id)).map(row => ({ type: row.type, id: row.id, header: row.header, data: row.data })).sort((a,b) => `${a.type}\0${a.id}`.localeCompare(`${b.type}\0${b.id}`));
			if (stable(strictTypedRecords(submittedParsed.records)) !== stable(strictTypedRecords(readback.records))) throw new Error('SCH写入改变候选以外COMPONENT/ATTR数据或headers');
			failureEvidence.failurePosition = 'readback-COMPONENT';
			const target = readback.records.filter(row => row.type === 'COMPONENT' && row.id === candidateId);
			if (target.length !== 1) throw new Error('SCH目标原生COMPONENT读回不唯一');
			const data = object(target[0].data, 'SCH目标原生COMPONENT');
			failureEvidence.actualComponent = { id: candidateId, data };
			failureEvidence.componentDiff = dataDiffPaths(wireExpected.component, { id: candidateId, data });
			const actualTargetAttributes = attrRecords(readback.records, candidateId);
			let effectiveDeviceAssociation: Json | undefined;
			const rawDeviceRows = candidateAttributes.filter(row => row.data.key === 'Device' && row.data.parentId === candidateId);
			const readbackDeviceRows = attrRecords(readback.records, candidateId).filter(row => row.data.key === 'Device' && row.data.parentId === candidateId);
			if (rawDeviceRows.length === 1 && readbackDeviceRows.length === 1 && rawDeviceRows[0].data.value === closure.effectiveReference.uuid
				&& readbackDeviceRows[0].id === rawDeviceRows[0].id && readbackDeviceRows[0].data.value === '') {
				const deviceMetaAttrs = closure.deviceMetaAttributes;
				const footprintRaw = deviceMetaAttrs.Footprint;
				let footprintRef: any = footprintRaw;
				if (typeof footprintRef === 'string') { try { footprintRef = JSON.parse(footprintRef); } catch { footprintRef = { uuid: footprintRef }; } }
				const footprintUuid = typeof footprintRef?.uuid === 'string' ? footprintRef.uuid : typeof footprintRef === 'string' ? footprintRef : '';
				if (!footprintUuid || !candidateResult.resourceDocuments.some((doc: any) => doc?.docType === 'FOOTPRINT' && doc.uuid === footprintUuid)) throw new Error('effective Device关联证明缺少确切FOOTPRINT资源闭包');
				const candidateProof: Json = { projection: 'device-attr-uuid-to-empty', candidateId, attrId: rawDeviceRows[0].id, pageUuid: part.pageUuid, partId: part.newSubPartName,
					projectUuid: prepared.projectUuid, sourceLibraryUuid: candidateBinding.sourceLibraryUuid, deviceUuid: closure.effectiveReference.uuid,
					symbolUuid: closure.symbolUuid, footprintUuid, rawUuid: rawDeviceRows[0].data.value, actualRawUuid: '',
					submittedRawUuid: ((failureEvidence.submittedTarget as Json)?.attributes ?? []).find((row: any) => row.id === rawDeviceRows[0].id)?.data?.value };
				if (candidateProof.submittedRawUuid !== closure.effectiveReference.uuid) throw new Error('有效Device关联提交前原始UUID不符');
				const actualProjectionTarget = { component: { id: candidateId, data }, attributes: actualTargetAttributes };
				const projectionValidation = assertEffectiveDeviceRawProjection({ expected: wireExpected, actual: actualProjectionTarget,
					submitted: failureEvidence.submittedTarget as Json, proof: candidateProof, resourceDocuments: candidateResult.resourceDocuments,
					projectUuid: prepared.projectUuid, pageUuid: part.pageUuid, candidateId, deviceUuid: closure.effectiveReference.uuid,
					symbolUuid: closure.symbolUuid, partId: part.newSubPartName });
				const projectedExpected = projectionValidation.projectedExpected;
				const fresh = await assertFreshEffectiveDeviceAssociation(api, candidateProof, candidateResult.resourceDocuments);
			Object.assign(candidateProof, fresh);
			effectiveDeviceAssociation = candidateProof;
			effectiveWireExpected = projectedExpected;
			persistenceModels = predictCandidateSchPersistenceModels({ wireCandidate: effectiveWireExpected, resources: {
				symbolEffectiveRecords: closure.symbolEffectiveRecords, selectedPartId: part.newSubPartName,
				deviceMetaAttributes: closure.deviceMetaAttributes,
				deviceDisplay: { uuid: closure.effectiveReference.uuid, title: closure.deviceTitle },
			} });
			} else if (stable({ id: candidateId, data }) !== stable(wireExpected.component)) throw new Error('SCH目标COMPONENT完整DATA即时读回不符');
			failureEvidence.failurePosition = 'readback-ATTR';
			failureEvidence.actualAttributes = actualTargetAttributes;
			failureEvidence.attributeDiff = dataDiffPaths(wireExpected.attributes, actualTargetAttributes);
			const expectedHeaders = failureEvidence.preNormalizationHeaders;
			const actualHeaders = {
				component: target[0].header,
				attributes: readback.records.filter(row => row.type === 'ATTR' && actualTargetAttributes.some(attr => attr.id === row.id)).map(row => ({ id: row.id, header: row.header })),
			};
			failureEvidence.readbackHeaders = actualHeaders;
			failureEvidence.headerDiff = dataDiffPaths(expectedHeaders, actualHeaders);
			if (effectiveDeviceAssociation) {
				const submittedHeaders = { component: submittedComponents[0].header,
					attributes: submittedParsed.records.filter(row => row.type === 'ATTR' && (row.data as Json)?.parentId === candidateId).map(row => ({ id: row.id, header: row.header })) };
				if (stable(submittedHeaders) !== stable(actualHeaders)) throw new Error('raw Device投影路径的目标COMPONENT/ATTR headers与提交不符');
			}
			if (stable(actualTargetAttributes) !== stable(effectiveWireExpected.attributes)) throw new Error('SCH目标全部直属ATTR DATA即时读回不符');
			const oldAssociations = attrRecords(part.native.records, part.componentId).filter(row => ['Reuse Block','Group ID','Channel ID','Multi-Part Group'].includes(String(row.data.key)));
			const newAssociations = actualTargetAttributes.filter(row => ['Reuse Block','Group ID','Channel ID','Multi-Part Group'].includes(String(row.data.key)));
			for (const key of ['Reuse Block','Group ID','Channel ID','Multi-Part Group']) {
				const oldRows = oldAssociations.filter(row => row.data.key === key), newRows = newAssociations.filter(row => row.data.key === key);
				if (oldRows.length !== newRows.length) throw new Error(`SCH原生关联ATTR数量读回不符：${key}`);
				for (let occurrence = 0; occurrence < oldRows.length; occurrence++) if (!equal(newRows[occurrence].data.value, oldRows[occurrence].data.value)) throw new Error(`SCH原生关联ATTR读回不符：${key}#${occurrence}`);
			}
			failureEvidence.failurePosition = 'typed-readback';
			const actualTypedObject = await api.sch_PrimitiveComponent.get(candidateId);
			failureEvidence.actualTyped = actualTypedObject ? readProps(actualTypedObject) : null;
			if (!equal(properties.expectedTyped, failureEvidence.actualTyped)) throw new Error('SCH typed属性在原生关联恢复后变化');
			return { stage, replacementIndex, partIndex, candidateId, expectedTyped: properties.expectedTyped,
				targetNative: { id: candidateId, data }, targetAttributes: actualTargetAttributes,
				normalizationProof: { pageUuid: part.pageUuid, candidateId, partId: part.newSubPartName,
					deviceUuid: closure.effectiveReference.uuid, symbolUuid: closure.symbolUuid,
					orderedChildrenProof: normalized.orderedChildrenProof, componentPatch: normalized.componentPatch,
					attributePatches: normalized.attributePatches, defaultTransitions: normalized.defaultTransitions,
					inputWireTransitions: normalized.inputWireTransitions, deviceNameProof: normalized.deviceNameProof,
					submittedTarget: failureEvidence.submittedTarget, immediateWireExpected: wireExpected,
					...(effectiveDeviceAssociation ? { effectiveDeviceAssociation, effectiveWireExpected } : {}), persistedExpected, persistenceModels },
				preservedOldAssociation: oldAssociations.map((row, occurrence) => ({ key: row.data.key, occurrence, value: row.data.value })) };
		} catch (error) {
			failureEvidence.reason = error instanceof Error ? error.message : String(error);
			attachFailureEvidence(error, failureEvidence);
		}
	}
	throw new Error(`未实现SCH阶段 ${stage}`);
}
