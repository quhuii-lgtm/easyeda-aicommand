import {
	replacementStorageKeys,
	type ReplacementHost,
	type ReplacementOperation,
	type ReplacementPlan,
	type ReplacementStage,
	type ReplacementStageContext,
	type ReplacementInput,
} from './componentReplacement';
import JSZip from 'jszip';
import { createNativeInspector } from './native-analysis/inspector-core.mjs';
import { performSchematicReplacementStage } from './componentReplacementSchematic';
import { createReplacementVerification } from './componentReplacementVerification';
import { assertReplacementComponentIdentity, extractReplacementNativeDocumentSource, parseReplacementNativeSource, patchReplacementNativeSource } from './componentReplacementNative';
import { activateOrOpenReplacementDocument } from './componentReplacementNavigation';


type JsonObject = Record<string, unknown>;
export type PreparedReplacement = {
	projectUuid: string;
	boardUuid: string;
	pcbUuid: string;
	pcbSource: string;
	pcbNative: ReturnType<typeof parseReplacementNativeSource>;
	archiveDocuments: Array<{ docType: string; uuid: string; source: string; effectiveRecords: Array<{ header: JsonObject; data: unknown }> }>;
	replacements: Array<{
		input: ReplacementInput['replacements'][number];
		oldPcb: { native: JsonObject; pads: JsonObject[]; typed: JsonObject };
		oldDevice: { reference: { libraryUuid: string; uuid: string }; defaults: JsonObject; document: JsonObject; source: string };
		newDevice: { reference: { libraryUuid: string; uuid: string }; defaults: JsonObject; document: JsonObject; source?: string; symbol: JsonObject; symbolSource: string; symbolRecords: Array<{ header: JsonObject; data: unknown }>; footprint: JsonObject; footprintSource: string; footprintRecords: Array<{ header: JsonObject; data: unknown }>; sourceCandidates: Array<{ docType: 'DEVICE' | 'SYMBOL' | 'FOOTPRINT'; requestedReference: { libraryUuid: string; uuid: string }; source: string; external: boolean; candidates: Array<{ uuid: string; source: string; effectiveRecords: Array<{ header: JsonObject; data: unknown }>; differences: Array<{ key: string; kind: 'missing' | 'extra' | 'changed' }> }> }>; parts: Array<{ id: string; name: string; data: JsonObject }> };
		schematicParts: Array<JsonObject & { pageUuid: string; componentId: string; subPartName: string; newSubPartName: string; native: ReturnType<typeof parseReplacementNativeSource>; source: string; oldTyped: JsonObject; oldPins: Array<{ number: string; x: number; y: number; rotation: number; length: number; net?: unknown }>; oldDeviceReference: { libraryUuid: string; uuid: string }; oldDeviceDefaults: JsonObject }>;
		localRoutes: NonNullable<ReplacementInput['replacements'][number]['localRoutes']>;
	}>;
};

const replacementInspector = createNativeInspector();
function obj(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 不是对象`);
	return value as JsonObject;
}
function getState(value: unknown, getter: string): unknown {
	const method = (value as Record<string, unknown> | undefined)?.[getter];
	if (typeof method !== 'function') throw new Error(`SDK 读回对象缺少 ${getter}`);
	return (method as () => unknown).call(value);
}
function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺失或无效`);
	return value;
}
function recordsOf(doc: any): Array<{ header: JsonObject; data: unknown }> {
	if (!Array.isArray(doc?.effectiveRecords)) throw new Error(`原生 ${String(doc?.docType)}/${String(doc?.uuid)} 缺少 effectiveRecords`);
	return doc.effectiveRecords as Array<{ header: JsonObject; data: unknown }>;
}
function oneRecord(records: Array<{ header: JsonObject; data: unknown }>, type: string, id?: string): JsonObject {
	const matches = records.filter(record => record.header.type === type && (id === undefined || record.header.id === id));
	if (matches.length !== 1) throw new Error(`原生 ${type}${id ? `/${id}` : ''} 应唯一，实际 ${matches.length}`);
	return obj(matches[0].data, `${type}${id ? `/${id}` : ''} data`);
}
function nativeReference(value: unknown, label: string): { libraryUuid: string; uuid: string } {
	let parsed = value;
	if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { throw new Error(`${label} JSON 无效`); } }
	const ref = obj(parsed, label), rawUuid = ref.uuid;
	const uuid = typeof rawUuid === 'string' ? rawUuid : obj(rawUuid, `${label}.uuid`).uuid;
	if (typeof uuid !== 'string' || !uuid.trim()) throw new Error(`${label}.uuid 无效`);
	const rawLibrary = ref.libraryUuid;
	const libraryUuid = typeof rawLibrary === 'string' ? rawLibrary : obj(rawLibrary, `${label}.libraryUuid`).uuid;
	return { libraryUuid: requiredString(libraryUuid, `${label}.libraryUuid`), uuid };
}
function resourceUuid(value: unknown, label: string): string {
	if (typeof value === 'string') {
		try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') return requiredString(obj(parsed, label).uuid, `${label}.uuid`); }
		catch { /* a bare UUID is the native attribute form */ }
		return requiredString(value, label);
	}
	return nativeReference(value, label).uuid;
}
function typedDeviceReference(value: unknown, label: string): { libraryUuid: string; uuid: string } {
	let parsed = value;
	if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { throw new Error(`${label} JSON 无效`); } }
	const ref = obj(parsed, label), rawUuid = ref.uuid, uuid = typeof rawUuid === 'string' ? rawUuid : obj(rawUuid, `${label}.uuid`).uuid;
	const rawLibrary = ref.libraryUuid;
	const libraryUuid = typeof rawLibrary === 'string' ? rawLibrary : rawLibrary && typeof rawLibrary === 'object' ? obj(rawLibrary, `${label}.libraryUuid`).uuid : '';
	return { uuid: requiredString(uuid, `${label}.uuid`), libraryUuid: typeof libraryUuid === 'string' ? libraryUuid : '' };
}
function nativeAttrs(data: JsonObject): JsonObject {
	const attrs = data.attributes ?? data.attrs;
	return attrs === undefined ? {} : obj(attrs, 'DEVICE META.attributes');
}
function archivedDeviceReference(componentData: JsonObject, projectUuid: string, label: string): { libraryUuid: string; uuid: string } {
	const attrs = obj(componentData.attrs, `${label} attrs`), raw = attrs.DeviceName;
	if (typeof raw !== 'string') throw new Error(`${label} 原生 DeviceName 缺失`);
	let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error(`${label} 原生 DeviceName JSON 无效`); }
	const uuid = requiredString(obj(value, `${label} DeviceName`).uuid, `${label} DeviceName.uuid`);
	return { libraryUuid: projectUuid, uuid };
}
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value as JsonObject).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

export type ReplacementStorage = {
	getExtensionUserConfig: (key: string) => unknown;
	setExtensionUserConfig: (key: string, value: string) => boolean | Promise<boolean>;
};

/** SDK-facing, typed boundary. Each callback must perform one readback-verified stage. */
export type ComponentReplacementRuntime<Prepared> = {
	readAndPrepare: (input: ReplacementInput) => Promise<Prepared>;
	assertPlanStillCurrent: (plan: ReplacementPlan) => Promise<void>;
	performStage: (prepared: Prepared, replacementIndex: number, stage: ReplacementStage, context: ReplacementStageContext) => Promise<unknown>;
	saveCloseReopen: (prepared: Prepared, priorResults: unknown[]) => Promise<unknown>;
	verifyFinal: (prepared: Prepared, priorResults: unknown[]) => Promise<unknown>;
};

function decode<T>(value: unknown): T | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
	return parsed as T;
}

/** Binds the replacement core to extension storage and typed SDK operations. */
export function createComponentReplacementHost<Prepared>(runtime: ComponentReplacementRuntime<Prepared>, storage: ReplacementStorage): ReplacementHost<Prepared> {
	return {
		readAndPrepare: runtime.readAndPrepare,
		assertPlanStillCurrent: runtime.assertPlanStillCurrent,
		performStage: runtime.performStage,
		saveCloseReopen: runtime.saveCloseReopen,
		verifyFinal: runtime.verifyFinal,
		readPlan: async planId => decode<ReplacementPlan>(storage.getExtensionUserConfig(replacementStorageKeys.plan(planId))),
		writePlan: async plan => {
			const key = replacementStorageKeys.plan(plan.planId), encoded = JSON.stringify(plan);
			if (await storage.setExtensionUserConfig(key, encoded) !== true) throw new Error('换件计划存储未确认');
			const readback = decode<ReplacementPlan>(storage.getExtensionUserConfig(key));
			if (!readback || JSON.stringify(readback) !== encoded) throw new Error('换件计划存储读回不一致');
		},
		readOperation: async operationId => decode<ReplacementOperation>(storage.getExtensionUserConfig(replacementStorageKeys.operation(operationId))),
		writeOperation: async operation => {
			const key = replacementStorageKeys.operation(operation.operationId), encoded = JSON.stringify(operation);
			if (await storage.setExtensionUserConfig(key, encoded) !== true) throw new Error('换件操作状态存储未确认');
			const readback = decode<ReplacementOperation>(storage.getExtensionUserConfig(key));
			if (!readback || JSON.stringify(readback) !== encoded) throw new Error('换件操作状态存储读回不一致');
		},
	};
}

/** Collect and freeze the read-only evidence needed by later replacement stages. */
export async function readReplacementPlan(api: typeof eda, rawInput: ReplacementInput): Promise<PreparedReplacement> {
	const input = JSON.parse(JSON.stringify(rawInput)) as ReplacementInput;
	const project = obj(await api.dmt_Project.getCurrentProjectInfo(), '当前工程');
	if (project.uuid !== input.projectUuid) throw new Error('当前工程 UUID 与请求不符');
	const tree = project.data;
	if (!Array.isArray(tree)) throw new Error('当前工程 data 树缺失或格式错误');
	const projectFile = await api.sys_FileManager.getProjectFile(String(project.name ?? project.title ?? 'component-replacement'), undefined, 'epro2');
	if (!(projectFile instanceof File)) throw new Error('导出 epro2 未返回 File');
	const zip = await JSZip.loadAsync(await projectFile.arrayBuffer());
	const projectMetadataFile = zip.file('project2.json');
	if (!projectMetadataFile) throw new Error('epro2 缺少 project2.json');
	const projectMetadata = obj(JSON.parse(await projectMetadataFile.async('string')), 'project2.json');
	const epruPaths = Object.keys(zip.files).filter(path => path.toLowerCase().endsWith('.epru') && !zip.files[path].dir).sort();
	if (!epruPaths.length) throw new Error('epro2 不含原生 epru 文档');
	const archiveDocuments: PreparedReplacement['archiveDocuments'] = [];
	for (const path of epruPaths) {
		const source = await zip.file(path)!.async('string');
		const inspection = replacementInspector.inspectNativeProject({ projectMetadata, source });
		if (!Array.isArray(inspection.documents)) throw new Error(`归档文档解析失败：${path}`);
		for (const doc of inspection.documents) {
			const records = recordsOf(doc);
			const docType = requiredString(doc.docType, `${path} docType`), uuid = requiredString(doc.uuid, `${path} uuid`);
			archiveDocuments.push({ docType, uuid, source: extractReplacementNativeDocumentSource(source, uuid, docType), effectiveRecords: records });
		}
	}
	const boards = tree.filter((item: unknown) => {
		if (!item || typeof item !== 'object') return false;
		const row = item as Record<string, any>;
		return row.itemType === 'Board' && (row.uuid === input.boardUuid || row.board?.uuid === input.boardUuid || row.schematic?.boardUuid === input.boardUuid || row.pcb?.boardUuid === input.boardUuid);
	});
	const nativeBoard = archiveDocuments.filter(doc => doc.docType === 'BOARD' && doc.uuid === input.boardUuid);
	if (nativeBoard.length !== 1) throw new Error(`请求 boardUuid 在 epro2 中没有唯一 BOARD：${input.boardUuid}`);
	oneRecord(nativeBoard[0].effectiveRecords, 'META');
	const targetPcbDocs = archiveDocuments.filter(doc => {
		if (doc.docType !== 'PCB') return false;
		const meta = doc.effectiveRecords.find(record => record.header.type === 'META')?.data;
		return obj(meta, 'PCB META').board === input.boardUuid;
	});
	if (targetPcbDocs.length !== 1) throw new Error(`BOARD META 未唯一关联 PCB：${input.boardUuid}`);
	const targetPcb = targetPcbDocs[0];
	const matchingTree = tree.filter((item: any) => item?.itemType === 'Board' && item?.pcb?.uuid === targetPcb.uuid
		&& (item?.uuid === input.boardUuid || item?.board?.uuid === input.boardUuid || item?.schematic?.page?.some((page: any) => input.replacements.some(repl => repl.schematicParts.some(part => part.pageUuid === page.uuid)))));
	if (matchingTree.length !== 1) throw new Error(`工程树未唯一关联 board/PCB/SCH 页面：${input.boardUuid}`);
	if (boards.length && !boards.some((item: any) => item.pcb?.uuid === targetPcb.uuid)) throw new Error('请求 BOARD 在工程树中与归档 PCB 关联不一致');
	const linkedPages = (matchingTree[0] as any)?.schematic?.page;
	if (!Array.isArray(linkedPages)) throw new Error('工程树 Board 缺少 SCH page 关联');
	for (const replacement of input.replacements) for (const part of replacement.schematicParts)
		if (!linkedPages.some((page: any) => page?.uuid === part.pageUuid)) throw new Error(`SCH 页面不属于请求 Board：${part.pageUuid}`);
	const pcbNative = parseReplacementNativeSource(targetPcb.source, targetPcb.uuid, 'PCB');
	const openAndRead = async (uuid: string, type: 1 | 3, expected: string): Promise<string> => {
		await activateOrOpenReplacementDocument(api, input.projectUuid, uuid);
		const current = await api.dmt_SelectControl.getCurrentDocumentInfo();
		if (!current || current.uuid !== uuid || current.parentProjectUuid !== input.projectUuid || current.documentType !== type) throw new Error(`当前SDK文档与目标不符：${expected}/${uuid}`);
		const source = await api.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || !source.trim()) throw new Error(`${expected}/${uuid} 源码为空`);
		return source;
	};
	const currentPcbSource = await openAndRead(targetPcb.uuid, 3, 'PCB');
	const pcbReadback = parseReplacementNativeSource(currentPcbSource, targetPcb.uuid, 'PCB');
	const semanticRecords = (records: Array<{ type: string; id: string; data: unknown }>) => stableJson(records.map(record => ({ key: `${record.type}\0${record.id}`, data: record.data })).sort((a, b) => a.key.localeCompare(b.key)));
	const docIndex = new Map(archiveDocuments.map(doc => [`${doc.docType}:${doc.uuid}`, doc]));
	const findDevice = (ref: { libraryUuid: string; uuid: string }, label: string): { document: JsonObject; source: string; defaults: JsonObject } => {
		const matches = archiveDocuments.filter(doc => doc.docType === 'DEVICE' && doc.uuid === ref.uuid);
		if (matches.length !== 1) throw new Error(`${label} DEVICE 不在当前epro2的唯一资源索引中：${ref.uuid}`);
		const meta = oneRecord(matches[0].effectiveRecords, 'META');
		return { document: meta, source: matches[0].source, defaults: nativeAttrs(meta) };
	};
	const loadResource = async (ref: { libraryUuid: string; uuid: string }, type: 'SYMBOL' | 'FOOTPRINT', label: string) => {
		const internal = ref.libraryUuid === input.projectUuid ? docIndex.get(`${type}:${ref.uuid}`) : undefined;
		if (internal) return { source: internal.source, document: oneRecord(internal.effectiveRecords, 'META'), records: internal.effectiveRecords };
		const source = type === 'SYMBOL' ? await api.lib_Symbol.getDocumentSource(ref.uuid, ref.libraryUuid) : await api.lib_Footprint.getDocumentSource(ref.uuid, ref.libraryUuid);
		if (typeof source !== 'string' || !source.trim()) throw new Error(`${label} ${type} 源码读取失败`);
		const inspection = replacementInspector.inspectNativeProject({ projectMetadata, source });
		const docs = inspection.documents.filter((doc: any) => doc.docType === type && doc.uuid === ref.uuid);
		if (docs.length !== 1) throw new Error(`${label} ${type} 源码不唯一或身份不符`);
		const records = recordsOf(docs[0]);
		const metaRecord = records.filter(record => record.header.type === 'META');
		if (metaRecord.length > 1) throw new Error(`${label} ${type} META 不唯一`);
		return { source, document: metaRecord.length ? obj(metaRecord[0].data, `${type} META`) : { docType: type, uuid: ref.uuid }, records };
	};
	const output: PreparedReplacement['replacements'] = [];
	for (const replacement of input.replacements) {
		const pcbRecord = pcbReadback.records.filter(record => record.type === 'COMPONENT' && record.id === replacement.pcbComponentId);
		if (pcbRecord.length !== 1 || !obj(pcbRecord[0].data, '旧PCB COMPONENT').attrs) throw new Error(`旧 PCB COMPONENT 不存在或缺少 attrs：${replacement.pcbComponentId}`);
		const oldPcbTyped = await api.pcb_PrimitiveComponent.get(replacement.pcbComponentId);
		if (!oldPcbTyped) throw new Error(`SDK 未读到旧 PCB 器件：${replacement.pcbComponentId}`);
		if (getState(oldPcbTyped, 'getState_UniqueId') !== replacement.oldUid) throw new Error(`旧 PCB UID 与请求不符：${replacement.oldUid}`);
		const oldDesignator = requiredString(getState(oldPcbTyped, 'getState_Designator'), '旧 PCB typed位号');
		assertReplacementComponentIdentity(pcbReadback.records, replacement.pcbComponentId, replacement.oldUid, oldDesignator, 'PCB');
		const typedOldDeviceRef = typedDeviceReference(getState(oldPcbTyped, 'getState_Component'), '旧 PCB device reference');
		const oldDeviceRef = archivedDeviceReference(obj(pcbRecord[0].data, '旧PCB COMPONENT'), input.projectUuid, '旧PCB COMPONENT');
		if (typedOldDeviceRef.uuid !== oldDeviceRef.uuid) throw new Error('旧 PCB typed Device UUID 与原生 DeviceName 不一致');
		const oldDevice = findDevice(oldDeviceRef, '旧');
		const rawOldPads = await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(replacement.pcbComponentId);
		if (!Array.isArray(rawOldPads)) throw new Error(`旧 PCB PAD 列表读取失败：${replacement.pcbComponentId}`);
		const oldPads = rawOldPads.map((pad: unknown) => {
			const padId = requiredString(getState(pad, 'getState_PrimitiveId'), '旧 PCB PAD id');
			if (String(getState(pad, 'getState_ParentComponentPrimitiveId')) !== replacement.pcbComponentId) throw new Error(`旧 PAD ${padId} 父组件不符`);
			return { id: padId, number: requiredString(getState(pad, 'getState_PadNumber'), `PAD ${padId} number`), net: String(getState(pad, 'getState_Net') ?? ''),
				layer: getState(pad, 'getState_Layer'), x: getState(pad, 'getState_X'), y: getState(pad, 'getState_Y'), rotation: getState(pad, 'getState_Rotation'),
				shape: getState(pad, 'getState_Pad'), hole: getState(pad, 'getState_Hole'), specialPad: getState(pad, 'getState_SpecialPad') ?? null,
				holeOffsetX: getState(pad, 'getState_HoleOffsetX'), holeOffsetY: getState(pad, 'getState_HoleOffsetY'), holeRotation: getState(pad, 'getState_HoleRotation') };
		});
		for (const pair of replacement.pinMap) if (!oldPads.some(pad => pad.number === pair.oldNumber)) throw new Error(`pinMap旧焊盘号不存在：${pair.oldNumber}`);
		let newDeviceDoc: JsonObject, newDeviceSource: string | undefined, newDefaults: JsonObject;
		const internalNew = replacement.newDevice.libraryUuid === input.projectUuid ? docIndex.get(`DEVICE:${replacement.newDevice.uuid}`) : undefined;
		if (internalNew) {
			newDeviceSource = internalNew.source; newDeviceDoc = oneRecord(internalNew.effectiveRecords, 'META'); newDefaults = nativeAttrs(newDeviceDoc);
		} else {
			const device = await api.lib_Device.get(replacement.newDevice.uuid, replacement.newDevice.libraryUuid);
			if (!device || device.uuid !== replacement.newDevice.uuid || device.libraryUuid !== replacement.newDevice.libraryUuid) throw new Error('外部 newDevice.get 未返回请求的完整库引用');
			newDeviceDoc = device as unknown as JsonObject; newDefaults = obj(device.property, '新 DEVICE defaults');
			newDeviceSource = undefined;
		}
		const internalResourceRef = (value: unknown, label: string) => {
			if (typeof value === 'string' && value.trim()) {
				try { return nativeReference(JSON.parse(value), label); }
				catch { return { libraryUuid: input.projectUuid, uuid: value }; }
			}
			const ref = nativeReference(value, label);
			return { libraryUuid: input.projectUuid, uuid: ref.uuid };
		};
		const symbolRef = internalNew ? internalResourceRef(newDefaults.Symbol, 'newDevice Symbol') : nativeReference((newDeviceDoc.association as any)?.symbol, 'newDevice symbol association');
		const footprintRef = internalNew ? internalResourceRef(newDefaults.Footprint, 'newDevice Footprint') : nativeReference((newDeviceDoc.association as any)?.footprint, 'newDevice footprint association');
		const symbol = await loadResource(symbolRef, 'SYMBOL', '新器件'), footprint = await loadResource(footprintRef, 'FOOTPRINT', '新器件');
		const resourceSource = (reference: { libraryUuid: string; uuid: string }) => `${reference.uuid}|${reference.libraryUuid}`;
		const selectedResourceRecords = (docType: string) => docType === 'DEVICE' ? (internalNew?.effectiveRecords ?? []) : docType === 'SYMBOL' ? symbol.records : footprint.records;
		const sourceCandidates: PreparedReplacement['replacements'][number]['newDevice']['sourceCandidates'] = ([
			{ docType: 'DEVICE' as const, requestedReference: replacement.newDevice },
			{ docType: 'SYMBOL' as const, requestedReference: symbolRef },
			{ docType: 'FOOTPRINT' as const, requestedReference: footprintRef },
		]).map(binding => {
			const source = resourceSource(binding.requestedReference);
			const external = binding.requestedReference.libraryUuid !== input.projectUuid;
			const candidates = archiveDocuments.filter(doc => doc.docType === binding.docType && (external
				? oneRecord(doc.effectiveRecords, 'META').source === source
				: doc.uuid === binding.requestedReference.uuid))
				.map(doc => {
					const selected = new Map(selectedResourceRecords(binding.docType).map(record => [`${String(record.header.type)}\0${String(record.header.id)}`, record.data]));
					const actual = new Map(doc.effectiveRecords.map(record => [`${String(record.header.type)}\0${String(record.header.id)}`, record.data]));
					const differences: Array<{ key: string; kind: 'missing' | 'extra' | 'changed' }> = [];
					for (const key of selected.keys()) if (!actual.has(key)) differences.push({ key, kind: 'missing' });
					for (const key of actual.keys()) if (!selected.has(key)) differences.push({ key, kind: 'extra' });
					for (const [key, value] of selected) if (actual.has(key) && stableJson(value) !== stableJson(actual.get(key))) differences.push({ key, kind: 'changed' });
					return { uuid: doc.uuid, source: doc.source, effectiveRecords: doc.effectiveRecords, differences };
				});
			return { ...binding, source, external, candidates };
		});
		const newParts = symbol.records.filter((record: any) => record.header.type === 'PART').map((record: any) => ({
			id: String(record.header.id), name: String((record.data as any)?.title ?? (record.data as any)?.name ?? record.header.id), data: obj(record.data, `PART/${record.header.id}`),
		}));
		if (!newParts.length) throw new Error(`新 DEVICE 缺少可确认 PART：${replacement.newDevice.uuid}`);
		const newFootprintPads = footprint.records.filter((record: any) => record.header.type === 'PAD').map((record: any) => obj(record.data, `新FP PAD/${record.header.id}`));
		for (const pair of replacement.pinMap) if (!newFootprintPads.some((pad: JsonObject) => String(pad.num) === pair.newNumber)) throw new Error(`pinMap新焊盘号不存在：${pair.newNumber}`);
		const schParts: PreparedReplacement['replacements'][number]['schematicParts'] = [];
		for (const part of replacement.schematicParts) {
			const schSource = await openAndRead(part.pageUuid, 1, 'SCH_PAGE');
			const native = parseReplacementNativeSource(schSource, part.pageUuid, 'SCH_PAGE');
			const archivePage = docIndex.get(`SCH_PAGE:${part.pageUuid}`);
			if (!archivePage) throw new Error(`当前epro2缺少参与页面：${part.pageUuid}`);
			const oldNative = native.records.filter(record => record.type === 'COMPONENT' && record.id === part.componentId);
			if (oldNative.length !== 1) throw new Error(`旧 SCH COMPONENT 不存在或不唯一：${part.componentId}`);
			const oldTyped = await api.sch_PrimitiveComponent.get(part.componentId);
			if (!oldTyped) throw new Error(`SDK 未读到旧 SCH 器件：${part.componentId}`);
			const oldPinObjects = await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(part.componentId);
			if (!Array.isArray(oldPinObjects)) throw new Error(`旧SCH引脚列表读取失败：${part.componentId}`);
			const oldPins = oldPinObjects.map((pin: unknown) => {
				const number = requiredString(getState(pin, 'getState_PinNumber'), `旧SCH引脚号/${part.componentId}`);
				const numeric = (getter: string) => {
					const value = getState(pin, getter);
					if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`旧SCH引脚 ${number} 的 ${getter} 非有效数字`);
					return value;
				};
				const snapshot: { number: string; x: number; y: number; rotation: number; length: number; net?: unknown } = {
					number, x: numeric('getState_X'), y: numeric('getState_Y'), rotation: numeric('getState_Rotation'), length: numeric('getState_PinLength'),
				};
				if (typeof (pin as Record<string, unknown> | null)?.getState_Net === 'function') snapshot.net = getState(pin, 'getState_Net');
				return snapshot;
			});
			if (new Set(oldPins.map(pin => pin.number)).size !== oldPins.length) throw new Error(`旧SCH引脚编号重复：${part.componentId}`);
			if (getState(oldTyped, 'getState_UniqueId') !== replacement.oldUid) throw new Error(`旧 SCH UID 与请求不符：${replacement.oldUid}`);
			const typedRef = typedDeviceReference(getState(oldTyped, 'getState_Component'), '旧 SCH device reference');
			const nativeRef = archivedDeviceReference(obj(oldNative[0].data, '旧SCH COMPONENT'), input.projectUuid, '旧SCH COMPONENT');
			if (typedRef.uuid !== nativeRef.uuid || nativeRef.uuid !== oldDeviceRef.uuid) throw new Error(`SCH/PCB旧器件原生/typed引用不一致：${replacement.oldUid}`);
			const schOldDevice = findDevice(nativeRef, '旧SCH');
			const oldSubPartName = String(getState(oldTyped, 'getState_SubPartName') ?? '');
			if (part.subPartName !== undefined && part.subPartName !== oldSubPartName) throw new Error(`旧 SCH part 与请求不符：${part.componentId}`);
			const matchingPart = part.newSubPartName ? newParts.filter(candidate => candidate.name === part.newSubPartName) : newParts.length === 1 ? newParts : [];
			if (matchingPart.length !== 1) throw new Error(`新 DEVICE PART 无唯一映射；请指定 newSubPartName：${part.componentId}`);
			schParts.push({ pageUuid: part.pageUuid, componentId: part.componentId, subPartName: oldSubPartName,
				newSubPartName: matchingPart[0].name, native, source: schSource, oldPins,
				oldTyped: Object.fromEntries(['getState_X','getState_Y','getState_Rotation','getState_Mirror','getState_AddIntoBom','getState_AddIntoPcb','getState_Designator','getState_UniqueId','getState_Name','getState_Manufacturer','getState_ManufacturerId','getState_Supplier','getState_SupplierId','getState_OtherProperty','getState_SubPartName'].map(key => [key, getState(oldTyped, key)])),
				oldDeviceReference: nativeRef, oldDeviceDefaults: schOldDevice.defaults });
		}
		output.push({ input: replacement, oldPcb: { native: obj(pcbRecord[0].data, '旧PCB COMPONENT'), pads: oldPads, typed: Object.fromEntries(['getState_Layer','getState_X','getState_Y','getState_Rotation','getState_PrimitiveLock','getState_Designator','getState_UniqueId','getState_OtherProperty'].map(key => [key, getState(oldPcbTyped, key)])) },
			oldDevice: { reference: oldDeviceRef, defaults: oldDevice.defaults, document: oldDevice.document, source: oldDevice.source },
			newDevice: { reference: replacement.newDevice, defaults: newDefaults, document: newDeviceDoc, source: newDeviceSource, symbol: symbol.document, symbolSource: symbol.source,
				symbolRecords: symbol.records, footprint: footprint.document, footprintSource: footprint.source, footprintRecords: footprint.records, sourceCandidates, parts: newParts }, schematicParts: schParts, localRoutes: replacement.localRoutes ?? [] });
	}
	const prepared: PreparedReplacement = { projectUuid: input.projectUuid, boardUuid: input.boardUuid, pcbUuid: targetPcb.uuid, pcbSource: currentPcbSource, pcbNative: pcbReadback,
		archiveDocuments, replacements: output };
	return JSON.parse(JSON.stringify(prepared)) as PreparedReplacement;
}

type PcbCandidateResult = { stage: ReplacementStage; replacementIndex: number; candidateId?: string; candidateUid?: string;
	candidateDevice?: { libraryUuid: string; uuid: string }; padIds?: string[]; segmentIds?: string[] };
function priorStage<T extends PcbCandidateResult>(previous: unknown[], stage: ReplacementStage, replacementIndex: number): T {
	const matches = previous.filter((value): value is T => Boolean(value && typeof value === 'object' && (value as PcbCandidateResult).stage === stage && (value as PcbCandidateResult).replacementIndex === replacementIndex));
	if (matches.length !== 1) throw new Error(`阶段结果缺少唯一 ${stage} replacement=${replacementIndex}`);
	return matches[0];
}
export function assertCandidateStageBindings(previous: unknown[], replacementIndex: number, candidateId: string, stages: Array<'pcb_verify_candidate' | 'pcb_verify_contact'>): void {
	for (const stage of stages) if (priorStage<PcbCandidateResult>(previous, stage, replacementIndex).candidateId !== candidateId)
		throw new Error(`${stage} 与当前candidateId不一致`);
}
function pcbIdentity(component: unknown): { id: string; uid: string; designator: string; reference: { libraryUuid: string; uuid: string } } {
	const uid = getState(component, 'getState_UniqueId');
	if (typeof uid !== 'string') throw new Error('PCB组件UID getter不是字符串');
	return { id: requiredString(getState(component, 'getState_PrimitiveId'), 'PCB组件ID'),
		uid,
		designator: requiredString(getState(component, 'getState_Designator'), 'PCB位号'),
		reference: typedDeviceReference(getState(component, 'getState_Component'), 'PCB Device引用') };
}
function readTypedPads(api: typeof eda, componentId: string): Promise<Array<JsonObject>> {
	return api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId).then((maybePads: any[] | undefined) => {
		const pads = maybePads;
		if (!Array.isArray(pads)) throw new Error(`读取PCB焊盘失败：${componentId}`);
		return pads.map(pad => {
			const id = requiredString(getState(pad, 'getState_PrimitiveId'), 'PCB PAD ID');
			if (String(getState(pad, 'getState_ParentComponentPrimitiveId')) !== componentId) throw new Error(`PCB PAD ${id} 父组件不匹配`);
			return { id, parentId: componentId, number: requiredString(getState(pad, 'getState_PadNumber'), `PCB PAD ${id}号`), net: String(getState(pad, 'getState_Net') ?? ''),
				layer: getState(pad, 'getState_Layer'), x: getState(pad, 'getState_X'), y: getState(pad, 'getState_Y'), rotation: getState(pad, 'getState_Rotation'),
				shape: getState(pad, 'getState_Pad'), hole: getState(pad, 'getState_Hole'), specialPad: getState(pad, 'getState_SpecialPad'), holeOffsetX: getState(pad, 'getState_HoleOffsetX'),
				holeOffsetY: getState(pad, 'getState_HoleOffsetY'), holeRotation: getState(pad, 'getState_HoleRotation') };
		});
	});
}
function equalNumberMultiset(left: string[], right: string[]): boolean {
	return stableJson([...left].sort()) === stableJson([...right].sort());
}
function pointInRing(point: [number, number], polygon: Array<[number, number]>): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
		if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
export function verifyPadCopperContact(pad: JsonObject, point: [number, number]): void {
	if (!Array.isArray(pad.shape) || pad.shape.length < 3) throw new Error(`PAD ${pad.number} shape 缺失`);
	const [kind, rawW, rawH, rawR] = pad.shape;
	const width = Number(rawW), height = Number(rawH), angle = Number(pad.rotation) * Math.PI / 180;
	if (![pad.x, pad.y, width, height, angle].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error(`PAD ${pad.number} 几何无效`);
	const dx = point[0] - Number(pad.x), dy = point[1] - Number(pad.y);
	const localX = dx * Math.cos(angle) + dy * Math.sin(angle), localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
	if (kind === 'ELLIPSE') {
		const normalizedRadius = (localX / (width / 2)) ** 2 + (localY / (height / 2)) ** 2;
		if (normalizedRadius > 1 + 0.00254 / Math.min(width, height)) throw new Error(`路线端点未接触 PAD ${pad.number}`);
		return;
	}
	if (kind === 'OVAL') {
		const radius = Math.min(width, height) / 2, halfSegment = (Math.max(width, height) - Math.min(width, height)) / 2;
		const axial = Math.max((width >= height ? Math.abs(localX) : Math.abs(localY)) - halfSegment, 0);
		const transverse = width >= height ? Math.abs(localY) : Math.abs(localX);
		if (Math.hypot(axial, transverse) > radius + 0.00254) throw new Error(`路线端点未接触 PAD ${pad.number}`);
		return;
	}
	if (kind === 'RECT') {
		if (typeof rawR !== 'number' || !Number.isFinite(rawR) || rawR < 0 || rawR > 100) throw new Error(`PAD ${pad.number} RECT圆角百分比无效`);
		const cornerRadius = Math.min(width, height) * rawR / 200;
		const cornerX = Math.max(Math.abs(localX) - (width / 2 - cornerRadius), 0);
		const cornerY = Math.max(Math.abs(localY) - (height / 2 - cornerRadius), 0);
		if (Math.hypot(cornerX, cornerY) > cornerRadius + 0.00254) throw new Error(`路线端点未接触 PAD ${pad.number}`);
		return;
	}
	throw new Error(`PAD ${pad.number} 使用未核验的铜形 ${String(kind)}`);
}
function rotateXY(x: number, y: number, degrees: number): [number, number] {
	const radians = degrees * Math.PI / 180; return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
}
function typedHoleMatchesNative(componentLayer: number, pad: JsonObject, typed: JsonObject, noDrillSentinel: boolean): boolean {
	const hole = pad.hole && typeof pad.hole === 'object' ? obj(pad.hole, 'PAD.hole') : null;
	if (!hole || noDrillSentinel) return typed.hole === null || typed.hole === undefined;
	if ((componentLayer !== 1 && componentLayer !== 2) || pad.layerId !== 12) return false;
	const kind = hole.holeType, width = hole.width, height = hole.height;
	const offsetX = pad.padOffsetX ?? 0, offsetY = pad.padOffsetY ?? 0, angle = pad.relativeAngle ?? 0;
	if ((kind !== 'ROUND' && kind !== 'SLOT') || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
		|| typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || (kind === 'ROUND' && width !== height)
		|| typeof offsetX !== 'number' || !Number.isFinite(offsetX) || typeof offsetY !== 'number' || !Number.isFinite(offsetY)
		|| typeof angle !== 'number' || !Number.isFinite(angle)) return false;
	// Component getters report dimensions and offsets in tenths of native units.
	// SLOT reads [diameter,length]: native width=40 (length), height=16 (diameter) reads [1.6,4].
	const expectedHoleWidth = kind === 'SLOT' ? height / 10 : width / 10, expectedHoleHeight = kind === 'SLOT' ? width / 10 : height / 10;
	const actualHole = typed.hole;
	if (!Array.isArray(actualHole) || actualHole.length !== 3 || actualHole[0] !== kind
		|| typeof actualHole[1] !== 'number' || !Number.isFinite(actualHole[1])
		|| typeof actualHole[2] !== 'number' || !Number.isFinite(actualHole[2])
		|| Math.abs(actualHole[1] - expectedHoleWidth) > 1e-9 || Math.abs(actualHole[2] - expectedHoleHeight) > 1e-9) return false;
	const expectedX = offsetX / 10, expectedY = (componentLayer === 2 ? -offsetY : offsetY) / 10;
	const expectedRotation = (componentLayer === 2 ? 180 - angle : angle) * Math.PI / 180;
	const actualX = typed.holeOffsetX, actualY = typed.holeOffsetY, actualRotation = typed.holeRotation;
	if (typeof actualX !== 'number' || !Number.isFinite(actualX) || typeof actualY !== 'number' || !Number.isFinite(actualY)
		|| typeof actualRotation !== 'number' || !Number.isFinite(actualRotation)) return false;
	const deltaRotation = Math.abs((((actualRotation - expectedRotation) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
	return Math.abs(actualX - expectedX) <= 1e-9 && Math.abs(actualY - expectedY) <= 1e-9 && deltaRotation <= 1e-9;
}
function effectiveRecordsEqual(left: Array<{ header: JsonObject; data: unknown }>, right: Array<{ header: JsonObject; data: unknown }>, label: string): void {
	const key = (row: { header: JsonObject }) => `${String(row.header.type)}\0${String(row.header.id)}`;
	const a = new Map(left.map(row => [key(row), row.data])), b = new Map(right.map(row => [key(row), row.data]));
	if (a.size !== left.length || b.size !== right.length) throw new Error(`${label} 存在重复有效记录身份`);
	const missing = [...a.keys()].filter(k => !b.has(k)), extra = [...b.keys()].filter(k => !a.has(k));
	const changed = [...a.keys()].filter(k => b.has(k) && stableJson(a.get(k)) !== stableJson(b.get(k)));
	if (missing.length || extra.length || changed.length) throw new Error(`${label}有效记录与已选资源不同：missing=${missing.slice(0,3).join(',')} extra=${extra.slice(0,3).join(',')} changed=${changed.slice(0,3).join(',')}`);
}
function sourceBinding(replacement: PreparedReplacement['replacements'][number], docType: 'DEVICE' | 'SYMBOL' | 'FOOTPRINT') {
	const matches = replacement.newDevice.sourceCandidates.filter(binding => binding.docType === docType);
	if (matches.length !== 1) throw new Error(`${docType}请求来源映射不唯一`);
	return matches[0];
}
export function assertMappedResource(binding: ReturnType<typeof sourceBinding>, actualUuid: string,
	actualRecords: Array<{ header: JsonObject; data: unknown }>, label: string): void {
	const meta = oneRecord(actualRecords, 'META');
	if (binding.external && meta.source !== binding.source) throw new Error(`${label} META.source与请求来源不符：${String(meta.source)} != ${binding.source}`);
	if (!binding.external && actualUuid !== binding.requestedReference.uuid) throw new Error(`${label} 工程内资源UUID与请求引用不一致`);
	if (binding.candidates.length) {
		const matches = binding.candidates.filter(candidate => candidate.uuid === actualUuid);
		if (matches.length !== 1) throw new Error(`${label} 实际UUID未唯一命中prepare冻结的同source工程资源候选`);
		effectiveRecordsEqual(matches[0].effectiveRecords, actualRecords, `${label}冻结工程资源`);
	}
}
function normalizeNativeAttr(value: unknown): string {
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	return value === undefined || value === null ? '' : String(value);
}
export function assertExternalDeviceDefaults(selected: JsonObject, actualMeta: JsonObject, actualSymbolUuid: string, actualFootprintUuid: string, libraryUuid: string): void {
	const property = obj(selected.property, '请求外部DEVICE property'), expectedOther = obj(property.otherProperty, '请求外部DEVICE otherProperty'), actualAttrs = nativeAttrs(actualMeta);
	if (actualMeta.title !== property.name) throw new Error('候选DEVICE标题与请求外部DEVICE名称不符');
	const identityAttrs = new Set(['Symbol', 'Footprint', '3D Model', 'SymbolName', 'FootprintName']);
	for (const [key, value] of Object.entries(expectedOther)) {
		if (identityAttrs.has(key)) continue;
		if (normalizeNativeAttr(actualAttrs[key]) !== normalizeNativeAttr(value)) throw new Error(`候选DEVICE业务属性与请求otherProperty不符：${key}`);
	}
	const requiredAttrs: Array<[string, unknown]> = [
		['Designator', property.designator], ['Add into BOM', property.addIntoBom], ['Convert to PCB', property.addIntoPcb],
		['Manufacturer', property.manufacturer], ['Manufacturer Part', property.manufacturerId], ['Supplier', property.supplier], ['Supplier Part', property.supplierId],
	];
	for (const [key, value] of requiredAttrs) if (value !== undefined && normalizeNativeAttr(actualAttrs[key]) !== normalizeNativeAttr(value))
		throw new Error(`候选DEVICE defaults与请求外部property不符：${key}`);
	if (resourceUuid(actualAttrs.Symbol, '候选DEVICE.Symbol') !== actualSymbolUuid || resourceUuid(actualAttrs.Footprint, '候选DEVICE.Footprint') !== actualFootprintUuid)
		throw new Error('候选DEVICE META资源UUID与候选SYMBOL/FOOTPRINT不闭合');
	for (const [key, uuid, label] of [['SymbolName', actualSymbolUuid, 'SymbolName'], ['FootprintName', actualFootprintUuid, 'FootprintName']] as const) {
		const raw = actualAttrs[key]; if (typeof raw !== 'string') throw new Error(`候选DEVICE ${key} JSON引用缺失`);
		let ref: JsonObject; try { ref = obj(JSON.parse(raw), `候选DEVICE ${key}`); } catch { throw new Error(`候选DEVICE ${key} JSON无效`); }
		if (ref.uuid !== uuid) throw new Error(`候选DEVICE ${key} uuid与资源闭包不符`);
	}
	const requested3d = expectedOther['3D Model'];
	if (requested3d !== undefined) {
		const expected3dRef = String(requested3d).includes('|') ? String(requested3d) : `${String(requested3d)}|${libraryUuid}`;
		if (normalizeNativeAttr(actualAttrs['3D Model']) !== expected3dRef) throw new Error('候选DEVICE 3D Model来源引用与请求不符');
	}
}
export function assertFootprintGeometryEqual(sourceRecords: Array<{ header: JsonObject; data: unknown }>, actualRecords: Array<{ header: JsonObject; data: unknown }>): void {
	const getPads = (rows: Array<{ header: JsonObject; data: unknown }>) => rows.filter(row => row.header.type === 'PAD').map(row => obj(row.data, `FP PAD/${row.header.id}`));
	const expected = getPads(sourceRecords), actual = getPads(actualRecords);
	if (!expected.length || expected.length !== actual.length) throw new Error('public source与实际FOOTPRINT的PAD集合不一致');
	const canonical = (value: JsonObject) => ({
			num: value.num, layerId: value.layerId, centerX: value.centerX, centerY: value.centerY, padAngle: value.padAngle,
			defaultPad: value.defaultPad, specialPad: value.specialPad ?? [],
			hole: value.hole ?? null, padOffsetX: value.padOffsetX ?? 0, padOffsetY: value.padOffsetY ?? 0,
			holeOffsetX: value.holeOffsetX ?? 0, holeOffsetY: value.holeOffsetY ?? 0, relativeAngle: value.relativeAngle ?? 0,
	});
	const multiset = (pads: JsonObject[]) => {
		const values = new Map<string, number>();
		for (const pad of pads) { const key = stableJson(canonical(pad)); values.set(key, (values.get(key) ?? 0) + 1); }
		return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
	};
	if (stableJson(multiset(expected)) !== stableJson(multiset(actual))) throw new Error('public source与实际FOOTPRINT PAD几何/钻孔多重集合不同');
}
export function assertImportedResourceBodyEqual(docType: 'SYMBOL' | 'FOOTPRINT', selectedRecords: Array<{ header: JsonObject; data: unknown }>, actualRecords: Array<{ header: JsonObject; data: unknown }>): void {
	const systemTypes = docType === 'FOOTPRINT' ? new Set(['META', 'LAYER', 'ACTIVE_LAYER', 'LAYER_PHYS', 'PREFERENCE', 'ELE_PLACEHOLDER']) : new Set(['META']);
	const stable = (value: unknown): string => {
		if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
		if (value && typeof value === 'object') return `{${Object.keys(value as JsonObject).sort().map(key => `${JSON.stringify(key)}:${stable((value as JsonObject)[key])}`).join(',')}}`;
		return JSON.stringify(value);
	};
	const normalizeData = (type: string, raw: unknown): unknown => {
		// Only top-level fields are changed below; a shallow copy keeps normalization from mutating the input.
		const data = obj(raw, `${docType} imported body record`), copy = { ...data };
		if (type === 'CANVAS' && docType === 'FOOTPRINT') for (const key of ['altSnapXSize', 'altSnapYSize', 'multiGridRatio']) delete copy[key];
		if (type === 'LAYER' && docType === 'FOOTPRINT') for (const key of ['activeColor', 'inactiveColor'])
			if (typeof copy[key] === 'string') copy[key] = (copy[key] as string).toLowerCase();
		return copy;
	};
	const rows = (records: Array<{ header: JsonObject; data: unknown }>) => records.filter(row => !systemTypes.has(String(row.header.type)))
		.map(row => ({ type: String(row.header.type), key: stable(normalizeData(String(row.header.type), row.data)) }));
	const selected = rows(selectedRecords), actual = rows(actualRecords);
	if (docType === 'FOOTPRINT') {
		const sourceLayers = selectedRecords.filter(row => row.header.type === 'LAYER');
		const actualLayers = actualRecords.filter(row => row.header.type === 'LAYER');
		const layerMultiset = (items: Array<{ header: JsonObject; data: unknown }>) => items.map(row => stable(normalizeData('LAYER', row.data))).sort();
		const expectedLayers = layerMultiset(sourceLayers), existingLayers = layerMultiset(actualLayers);
		for (const value of expectedLayers) { const index = existingLayers.indexOf(value); if (index < 0) throw new Error('导入FOOTPRINT图层定义缺少已选资源内容'); existingLayers.splice(index, 1); }
	}
	const counts = (items: typeof selected) => { const result = new Map<string, number>(); for (const item of items) { const key = `${item.type}\0${item.key}`; result.set(key, (result.get(key) ?? 0) + 1); } return result; };
	const wanted = counts(selected), found = counts(actual), differences = [...new Set([...wanted.keys(), ...found.keys()])].filter(key => wanted.get(key) !== found.get(key));
	if (differences.length) throw new Error(`导入${docType}的完整资源实体与已选源码不一致：${differences.slice(0, 8).map(key => key.replace('\0', '/')).join(',')}`);
}
export function assertTypedPadsMatchFootprint(component: unknown, componentId: string, footprintPads: Array<{ header: JsonObject; data: unknown }>, typedPads: JsonObject[]): void {
	const layer = getState(component, 'getState_Layer'), x = Number(getState(component, 'getState_X')), y = Number(getState(component, 'getState_Y')), rotation = Number(getState(component, 'getState_Rotation'));
	if (layer !== 1 && layer !== 2) throw new Error(`候选组件层 ${String(layer)} 没有已验证的顶/底映射`);
	if (![x, y, rotation].every(Number.isFinite)) throw new Error('候选组件位姿不是有限数');
	const byNumber = new Map<string, JsonObject[]>();
	for (const typed of typedPads) {
		const number = String(typed.number), group = byNumber.get(number) ?? []; group.push(typed); byNumber.set(number, group);
	}
	for (const row of footprintPads) {
		const pad = obj(row.data, `实际FP PAD/${row.header.id}`), number = requiredString(pad.num, `实际FP PAD/${row.header.id}号`), group = byNumber.get(number);
		if (!group?.length) throw new Error(`候选PAD getter缺少实际FP编号：${number}`);
		const cx = Number(pad.centerX), cy = Number(pad.centerY), [ox, oy] = rotateXY(cx, layer === 2 ? -cy : cy, rotation);
		const expectedX = x + ox, expectedY = y + oy, padAngle = Number(pad.padAngle ?? 0), expectedRotation = layer === 2 ? rotation - padAngle : rotation + padAngle;
		if (![cx, cy, expectedX, expectedY, padAngle].every(Number.isFinite)) throw new Error(`实际FP PAD${number}几何字段无效`);
		const shape = pad.defaultPad && typeof pad.defaultPad === 'object' ? obj(pad.defaultPad, `PAD${number}.defaultPad`) : undefined;
		if (!shape) throw new Error(`候选 PAD${number} 缺少实际铜形`);
		const width = shape.width, height = shape.height, radius = shape.radius;
		if (typeof shape.padType !== 'string' || !shape.padType.trim() || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
			|| typeof height !== 'number' || !Number.isFinite(height) || height <= 0) throw new Error(`实际PAD${number}铜形尺寸字段无效`);
		if (shape.padType === 'RECT' && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > 100))
			throw new Error(`实际RECT PAD${number}圆角字段无效`);
		if (shape.padType !== 'RECT' && shape.padType !== 'OVAL' && shape.padType !== 'ELLIPSE') throw new Error(`实际PAD${number}铜形暂未完成SDK映射：${shape.padType}`);
		const nativeHole = pad.hole && typeof pad.hole === 'object' ? obj(pad.hole, `PAD${number}.hole`) : null;
		const noDrillSentinel = nativeHole?.holeType === 'ROUND' && Math.abs(Number(nativeHole.width) - 0.03937) <= 1e-9 && Math.abs(Number(nativeHole.height) - 0.03937) <= 1e-9;
		const typedIndex = group.findIndex(typed => {
			const getterShape = typed.shape;
			const getterWidth = Array.isArray(getterShape) ? getterShape[1] : undefined, getterHeight = Array.isArray(getterShape) ? getterShape[2] : undefined;
			const getterRadius = Array.isArray(getterShape) && getterShape.length === 4 ? getterShape[3] : undefined;
			const shapeFieldsValid = Array.isArray(getterShape) && (shape.padType === 'RECT' ? getterShape.length === 4
				&& typeof getterRadius === 'number' && Number.isFinite(getterRadius) && getterRadius >= 0 && getterRadius <= 100 : getterShape.length === 3);
			const expectedLayer = layer === 2 ? pad.layerId === 1 ? 2 : pad.layerId === 2 ? 1 : pad.layerId : pad.layerId;
			if (![Number(typed.x), Number(typed.y), Number(typed.rotation)].every(Number.isFinite)
				|| Math.abs(Number(typed.x) - expectedX) > 0.05 || Math.abs(Number(typed.y) - expectedY) > 0.05
				|| typed.layer !== expectedLayer || !shapeFieldsValid
				|| typeof getterShape[0] !== 'string' || getterShape[0] !== shape.padType
				|| typeof getterWidth !== 'number' || !Number.isFinite(getterWidth) || getterWidth <= 0
				|| typeof getterHeight !== 'number' || !Number.isFinite(getterHeight) || getterHeight <= 0
				|| shape.padType === 'RECT' && Math.abs(Number(getterRadius) - Number(radius)) > 0.05
				|| Math.abs(getterWidth - width) > 0.05 || Math.abs(getterHeight - height) > 0.05) return false;
			const angleDelta = Math.abs((((Number(typed.rotation) - expectedRotation) % 360) + 540) % 360 - 180);
			return Number.isFinite(angleDelta) && angleDelta <= 0.1 && typedHoleMatchesNative(layer, pad, typed, noDrillSentinel)
				&& stableJson(typed.specialPad ?? []) === stableJson(pad.specialPad ?? []);
		});
		if (typedIndex < 0) throw new Error(`候选 PAD${number} 几何/钻孔/SpecialPad 与实际Footprint不匹配`);
		group.splice(typedIndex, 1);
	}
	if ([...byNumber.values()].some(group => group.length) || footprintPads.length !== typedPads.length) throw new Error('候选实例typed PAD与实际Footprint PAD多重集合不一致');
	void componentId;
}
export function assertSameCopperOccupancy(oldTypedPads: JsonObject[], candidateTypedPads: JsonObject[], oldFootprintRecords: Array<{ header: JsonObject; data: unknown }>, newFootprintRecords: Array<{ header: JsonObject; data: unknown }>, pinMap: Array<{ oldNumber: string; newNumber: string }>): void {
	const typedByNumber = (pads: JsonObject[], label: string) => {
		const output = new Map<string, JsonObject[]>();
		for (const pad of pads) { const number = requiredString(pad.number, `${label} PAD号`), group = output.get(number) ?? []; group.push(pad); output.set(number, group); }
		return output;
	};
	const oldTyped = typedByNumber(oldTypedPads, '旧'), candidateTyped = typedByNumber(candidateTypedPads, '候选');
	if (oldTyped.size !== candidateTyped.size || pinMap.length !== oldTyped.size || new Set(pinMap.map(pair => pair.oldNumber)).size !== oldTyped.size || new Set(pinMap.map(pair => pair.newNumber)).size !== candidateTyped.size)
		throw new Error('同封装铜占用证明要求完整的一对一pinMap');
	const padsByNumber = (rows: Array<{ header: JsonObject; data: unknown }>, label: string) => {
		const output = new Map<string, JsonObject[]>();
		for (const row of rows.filter(item => item.header.type === 'PAD')) {
			const pad = obj(row.data, `${label} PAD/${row.header.id}`), number = requiredString(pad.num, `${label} PAD号`);
			const group = output.get(number) ?? []; group.push(pad); output.set(number, group);
		}
		return output;
	};
	const oldNative = padsByNumber(oldFootprintRecords, '旧FOOTPRINT'), newNative = padsByNumber(newFootprintRecords, '候选FOOTPRINT');
	const nativeCopper = (pad: JsonObject) => {
		const rawHole = pad.hole && typeof pad.hole === 'object' ? obj(pad.hole, 'PAD.hole') : null;
		const sentinel = rawHole?.holeType === 'ROUND' && Math.abs(Number(rawHole.width) - 0.03937) <= 1e-9 && Math.abs(Number(rawHole.height) - 0.03937) <= 1e-9;
		return { layerId: pad.layerId, centerX: pad.centerX, centerY: pad.centerY, padAngle: pad.padAngle,
			defaultPad: pad.defaultPad, specialPad: pad.specialPad ?? [], hole: sentinel ? null : rawHole,
			...(rawHole && !sentinel ? { padOffsetX: pad.padOffsetX ?? 0, padOffsetY: pad.padOffsetY ?? 0, relativeAngle: pad.relativeAngle ?? 0 } : {}) };
	};
	for (const pair of pinMap) {
		const a = oldTyped.get(pair.oldNumber), b = candidateTyped.get(pair.newNumber), na = oldNative.get(pair.oldNumber), nb = newNative.get(pair.newNumber);
		if (!a?.length || !b?.length || !na?.length || !nb?.length) throw new Error(`同封装铜占用证明缺少焊盘 ${pair.oldNumber}->${pair.newNumber}`);
		const typedCopper = (pad: JsonObject) => ({ layer: pad.layer, x: pad.x, y: pad.y, rotation: pad.rotation, shape: pad.shape, hole: pad.hole ?? null, specialPad: pad.specialPad ?? [] });
		const multiset = (values: JsonObject[], getCopper: (pad: JsonObject) => unknown) => values.map(getCopper).map(stableJson).sort();
		if (a.length !== b.length || stableJson(multiset(a, typedCopper)) !== stableJson(multiset(b, typedCopper))) throw new Error(`同封装焊盘 ${pair.oldNumber}->${pair.newNumber} 的typed物理铜占用不同`);
		if (na.length !== nb.length || stableJson(multiset(na, nativeCopper)) !== stableJson(multiset(nb, nativeCopper))) throw new Error(`同封装焊盘 ${pair.oldNumber}->${pair.newNumber} 的native有效铜占用不同`);
		if (a.some(oldPad => !b.some(newPad => String(oldPad.net ?? '') === String(newPad.net ?? '')))) throw new Error(`同封装焊盘 ${pair.oldNumber}->${pair.newNumber} 网络不同`);
	}
}
export function assertComponentPosePreserved(component: unknown, oldTyped: JsonObject): void {
	for (const [getter, key] of [['getState_Layer', 'getState_Layer'], ['getState_X', 'getState_X'], ['getState_Y', 'getState_Y'], ['getState_Rotation', 'getState_Rotation']] as const) {
		const expected = oldTyped[key], actual = getState(component, getter);
		if (key !== 'getState_Layer' && (typeof expected !== 'number' || !Number.isFinite(expected) || typeof actual !== 'number' || !Number.isFinite(actual)))
			throw new Error(`PCB组件 ${key} 位姿字段不是有限数`);
		if (stableJson(actual) !== stableJson(expected)) throw new Error(`候选 PCB ${key} 与冻结旧件位姿不完全相同`);
	}
}

export function assertFinalCandidateDeviceIdentity(previousResults: unknown[], replacementIndex: number, candidateId: string,
	finalTypedReference: { libraryUuid: string; uuid: string }, projectUuid: string,
	nativeRecords: Array<{ type: string; id: string; data: unknown }>): { actualReference: { libraryUuid: string; uuid: string }; typedReference: { libraryUuid: string; uuid: string }; provenance: 'project' | 'source-library-alias' } {
	const matches = previousResults.filter((value): value is JsonObject => Boolean(value && typeof value === 'object'
		&& (value as JsonObject).stage === 'pcb_verify_candidate' && (value as JsonObject).replacementIndex === replacementIndex));
	if (matches.length !== 1 || matches[0].candidateId !== candidateId) throw new Error('最终身份验证缺少唯一且candidateId匹配的pcb_verify_candidate结果');
	const verified = matches[0], candidateDevice = obj(verified.candidateDevice, 'pcb_verify_candidate candidateDevice');
	if (obj(verified.deviceResolution, 'pcb_verify_candidate deviceResolution').verified !== true) throw new Error('pcb_verify_candidate未确认实际Device资源');
	const actualDevice = obj(verified.actualDevice, 'pcb_verify_candidate actualDevice'), actual = obj(actualDevice.reference, 'pcb_verify_candidate actualDevice.reference');
	const actualUuid = requiredString(actual.uuid, '实际DEVICE UUID'), actualLibraryUuid = requiredString(actual.libraryUuid, '实际DEVICE库UUID');
	if (candidateDevice.uuid !== actualUuid || candidateDevice.libraryUuid !== projectUuid || actualLibraryUuid !== projectUuid)
		throw new Error('pcb_verify_candidate实际DEVICE引用不一致或未规范化到当前工程');
	const documents = verified.resourceDocuments;
	if (!Array.isArray(documents)) throw new Error('pcb_verify_candidate 缺少resourceDocuments');
	const deviceDocuments = documents.filter((value: unknown) => value && typeof value === 'object' && (value as JsonObject).docType === 'DEVICE');
	if (deviceDocuments.length !== 1) throw new Error('pcb_verify_candidate DEVICE resourceDocument缺失或重复');
	const deviceDocument = obj(deviceDocuments[0], 'DEVICE resourceDocument');
	if (deviceDocument.uuid !== actualUuid || !Array.isArray(deviceDocument.effectiveRecords) || !Array.isArray(actualDevice.effectiveRecords)
		|| stableJson(deviceDocument.effectiveRecords) !== stableJson(actualDevice.effectiveRecords))
		throw new Error('pcb_verify_candidate DEVICE resourceDocument身份或记录无效');
	const metas = (records: unknown[]) => records.filter(row => row && typeof row === 'object' && (row as JsonObject).header
		&& typeof (row as JsonObject).header === 'object' && ((row as JsonObject).header as JsonObject).type === 'META');
	const documentMeta = metas(deviceDocument.effectiveRecords as unknown[]), actualMeta = metas(actualDevice.effectiveRecords as unknown[]);
	if (documentMeta.length !== 1 || actualMeta.length !== 1 || stableJson(obj((documentMeta[0] as JsonObject).data, 'DEVICE resourceDocument META'))
		!== stableJson(obj((actualMeta[0] as JsonObject).data, 'actual DEVICE META'))) throw new Error('pcb_verify_candidate DEVICE META证据缺失或不一致');
	const meta = obj((actualMeta[0] as JsonObject).data, 'actual DEVICE META'), source = meta.source;
	const sourceLibraryUuid = typeof source === 'string' && source.includes('|') ? source.slice(source.lastIndexOf('|') + 1) : '';
	if (typeof actualDevice.source !== 'string' || !actualDevice.source.trim()) throw new Error('pcb_verify_candidate actual DEVICE源码缺失');
	const componentRows = nativeRecords.filter(record => record.type === 'COMPONENT' && record.id === candidateId);
	if (componentRows.length !== 1) throw new Error('最终native候选COMPONENT缺失或重复');
	const componentData = obj(componentRows[0].data, '最终native候选COMPONENT'), attrs = obj(componentData.attrs, '最终native候选COMPONENT attrs');
	const deviceAttrs = nativeRecords.filter(record => record.type === 'ATTR' && record.data && typeof record.data === 'object'
		&& !Array.isArray(record.data) && (record.data as JsonObject).parentId === candidateId && (record.data as JsonObject).key === 'Device');
	if (deviceAttrs.length !== 1 || obj(deviceAttrs[0].data, '最终native Device ATTR').value !== actualUuid) throw new Error('最终native直属Device ATTR与已验证实际DEVICE UUID不符');
	if (Object.hasOwn(attrs, 'DeviceName')) {
		let deviceName: unknown = attrs.DeviceName;
		if (typeof deviceName === 'string') { try { deviceName = JSON.parse(deviceName); } catch { throw new Error('最终native DeviceName JSON无效'); } }
		if (!deviceName || typeof deviceName !== 'object' || Array.isArray(deviceName) || (deviceName as JsonObject).uuid !== actualUuid)
			throw new Error('最终native DeviceName.uuid与已验证实际DEVICE UUID不符');
	}
	if (finalTypedReference.uuid !== actualUuid) throw new Error('最终typed Device UUID与已验证实际DEVICE UUID不符');
	const provenance = finalTypedReference.libraryUuid === projectUuid ? 'project'
		: sourceLibraryUuid && finalTypedReference.libraryUuid === sourceLibraryUuid ? 'source-library-alias' : undefined;
	if (!provenance) throw new Error('最终typed Device libraryUuid既非当前工程也非实际DEVICE META.source来源库');
	return { actualReference: { libraryUuid: projectUuid, uuid: actualUuid }, typedReference: finalTypedReference, provenance };
}

/** Create the default SDK-backed replacement runtime. Mutating stages always read back before return. */
export function createEdaComponentReplacementRuntime(api: typeof eda = eda): ComponentReplacementRuntime<PreparedReplacement> {
	let currentPlan: PreparedReplacement | undefined;
	const verification = createReplacementVerification(api);
	const readFreshArchiveDocuments = async (projectName: string) => {
		const file = await api.sys_FileManager.getProjectFile(projectName, undefined, 'epro2');
		if (!(file instanceof File)) throw new Error('候选资源验证未读到 epro2 File');
		const zip = await JSZip.loadAsync(await file.arrayBuffer()), metadataFile = zip.file('project2.json');
		if (!metadataFile) throw new Error('候选资源验证 epro2 缺少 project2.json');
		const metadata = obj(JSON.parse(await metadataFile.async('string')), '候选验证 project2.json'), docs: Array<{ docType: string; uuid: string; source: string; effectiveRecords: Array<{ header: JsonObject; data: unknown }> }> = [];
		for (const path of Object.keys(zip.files).filter(path => path.toLowerCase().endsWith('.epru') && !zip.files[path].dir)) {
			const source = await zip.file(path)!.async('string'), inspection = replacementInspector.inspectNativeProject({ projectMetadata: metadata, source });
			for (const doc of inspection.documents ?? []) docs.push({ docType: requiredString(doc.docType, '候选归档docType'), uuid: requiredString(doc.uuid, '候选归档uuid'),
				source: extractReplacementNativeDocumentSource(source, doc.uuid, doc.docType), effectiveRecords: recordsOf(doc) });
		}
		return docs;
	};
	const openPcb = async (prepared: PreparedReplacement) => {
		const project = await api.dmt_Project.getCurrentProjectInfo();
		if (!project || project.uuid !== prepared.projectUuid) throw new Error('当前工程身份与换件计划不符');
		await activateOrOpenReplacementDocument(api, prepared.projectUuid, prepared.pcbUuid);
		const info = await api.dmt_SelectControl.getCurrentDocumentInfo();
		if (!info || info.uuid !== prepared.pcbUuid || info.parentProjectUuid !== prepared.projectUuid || info.documentType !== 3) throw new Error('当前文档不是计划 PCB');
		const source = await api.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || !source.trim()) throw new Error('读取目标 PCB 源码失败');
		return { source, native: parseReplacementNativeSource(source, prepared.pcbUuid, 'PCB') };
	};
	const candidateFrom = (previous: unknown[], index: number) => priorStage<PcbCandidateResult>(previous, 'pcb_create_candidate', index);
	const performStageCore = async (prepared: PreparedReplacement, replacementIndex: number, stage: ReplacementStage, context: ReplacementStageContext): Promise<unknown> => {
			if (stage.startsWith('schematic_')) return performSchematicReplacementStage(api, prepared, replacementIndex, stage, context);
			const replacement = prepared.replacements[replacementIndex];
			if (!replacement) throw new Error(`换件目标索引无效：${replacementIndex}`);
			const current = await openPcb(prepared), originalId = replacement.input.pcbComponentId;
			const oldRecord = current.native.records.find(record => record.type === 'COMPONENT' && record.id === originalId);
			if (stage === 'pcb_create_candidate') {
				if (!oldRecord) throw new Error('候选创建前旧件身份/原生快照不符');
				assertReplacementComponentIdentity(current.native.records, originalId, replacement.input.oldUid,
					requiredString(replacement.oldPcb.typed.getState_Designator, '冻结旧 PCB 位号'), 'PCB');
				const pose = replacement.input.pcbPose ?? { x: Number(replacement.oldPcb.typed.getState_X), y: Number(replacement.oldPcb.typed.getState_Y), rotation: Number(replacement.oldPcb.typed.getState_Rotation) };
				const created = await api.pcb_PrimitiveComponent.create(replacement.newDevice.reference, Number(replacement.oldPcb.typed.getState_Layer) as any,
					pose.x, pose.y, pose.rotation, false);
				if (!created) throw new Error('PCB 候选create未返回对象');
				const identity = pcbIdentity(created);
				if (identity.id === originalId || identity.uid === replacement.input.oldUid) throw new Error('PCB create候选抢占旧件身份或ID');
				const after = await openPcb(prepared);
				if (!after.native.records.some(record => record.type === 'COMPONENT' && record.id === identity.id)
					|| !after.native.records.some(record => record.type === 'COMPONENT' && record.id === originalId)) throw new Error('PCB候选创建读回失败或旧件不再存在');
				return { stage, replacementIndex, candidateId: identity.id, candidateUid: identity.uid, candidateDevice: identity.reference };
			}
			const candidate = candidateFrom(context.previousResults, replacementIndex);
			const candidateId = requiredString(candidate.candidateId, 'candidateId');
			const component = await api.pcb_PrimitiveComponent.get(candidateId);
			if (!component) throw new Error(`PCB候选不存在：${candidateId}`);
			if (stage === 'pcb_verify_candidate') {
				const identity = pcbIdentity(component), project = await api.dmt_Project.getCurrentProjectInfo();
				if (!project) throw new Error('候选验证无法读取当前工程');
				const freshDocs = await readFreshArchiveDocuments(String(project.name ?? 'component-replacement'));
				const pcbDocs = freshDocs.filter(doc => doc.docType === 'PCB' && doc.uuid === prepared.pcbUuid);
				if (pcbDocs.length !== 1) throw new Error('候选验证归档中目标 PCB 不唯一');
				const candidates = pcbDocs[0].effectiveRecords.filter(record => record.header.type === 'COMPONENT' && record.header.id === candidateId);
				if (candidates.length !== 1) throw new Error('候选验证归档中 COMPONENT 不唯一');
				const candidateData = obj(candidates[0].data, '候选 COMPONENT'), attrs = obj(candidateData.attrs, '候选 attrs');
				const deviceRef = archivedDeviceReference(candidateData, prepared.projectUuid, '候选 COMPONENT');
				if (deviceRef.uuid !== identity.reference.uuid) throw new Error('候选typed Device UUID与归档DeviceName不一致');
				const deviceDocs = freshDocs.filter(doc => doc.docType === 'DEVICE' && doc.uuid === deviceRef.uuid);
				if (deviceDocs.length !== 1) throw new Error('候选DEVICE资源在epro2中不唯一');
				const actualDeviceMeta = oneRecord(deviceDocs[0].effectiveRecords, 'META');
				const deviceBinding = sourceBinding(replacement, 'DEVICE');
				assertMappedResource(deviceBinding, deviceRef.uuid, deviceDocs[0].effectiveRecords, '候选DEVICE');
				if (!deviceBinding.external && stableJson(actualDeviceMeta) !== stableJson(replacement.newDevice.document)) throw new Error('候选工程DEVICE META与已选工程DEVICE不一致');
				const selectedSymbolInspection = replacementInspector.inspectNativeProject({ projectMetadata: { title: 'replacement-selected-symbol' }, source: replacement.newDevice.symbolSource });
				const selectedSymbolDocs = selectedSymbolInspection.documents.filter((doc: any) => doc.docType === 'SYMBOL');
				if (selectedSymbolDocs.length !== 1) throw new Error('已选 SYMBOL 来源不唯一');
				const selectedSymbolUuid = requiredString(selectedSymbolDocs[0].uuid, '已选SYMBOL UUID');
				const symbolBinding = sourceBinding(replacement, 'SYMBOL');
				if (selectedSymbolUuid !== symbolBinding.requestedReference.uuid) throw new Error('已选SYMBOL源码UUID与请求引用不符');
				const actualSymbolUuid = resourceUuid(nativeAttrs(actualDeviceMeta).Symbol, '候选DEVICE META.Symbol');
				const symbolDocs = freshDocs.filter(doc => doc.docType === 'SYMBOL' && doc.uuid === actualSymbolUuid);
				if (symbolDocs.length !== 1) throw new Error('候选实际SYMBOL资源在epro2中不唯一');
				assertMappedResource(symbolBinding, actualSymbolUuid, symbolDocs[0].effectiveRecords, '候选SYMBOL');
				if (symbolBinding.external && symbolBinding.candidates.length === 0) assertImportedResourceBodyEqual('SYMBOL', replacement.newDevice.symbolRecords, symbolDocs[0].effectiveRecords);
				const footprintAttrs = pcbDocs[0].effectiveRecords.filter(record => record.header.type === 'ATTR' && obj(record.data, '候选ATTR').parentId === candidateId && (record.data as JsonObject).key === 'Footprint');
				if (footprintAttrs.length !== 1) throw new Error('候选Footprint ATTR 不唯一');
				const footprintRef = { libraryUuid: prepared.projectUuid, uuid: resourceUuid((footprintAttrs[0].data as JsonObject).value, '候选ATTR.Footprint') };
				const fpDocs = freshDocs.filter(doc => doc.docType === 'FOOTPRINT' && doc.uuid === footprintRef.uuid);
				if (fpDocs.length !== 1) throw new Error('候选实际FOOTPRINT资源在epro2中不唯一');
				const nativePads = fpDocs[0].effectiveRecords.filter(record => record.header.type === 'PAD').map(record => obj(record.data, `候选FP PAD/${record.header.id}`));
				const typedPads = await readTypedPads(api, candidateId);
				const footprintBinding = sourceBinding(replacement, 'FOOTPRINT');
				assertMappedResource(footprintBinding, footprintRef.uuid, fpDocs[0].effectiveRecords, '候选FOOTPRINT');
				if (footprintBinding.external && footprintBinding.candidates.length === 0) {
					assertFootprintGeometryEqual(replacement.newDevice.footprintRecords, fpDocs[0].effectiveRecords);
					assertImportedResourceBodyEqual('FOOTPRINT', replacement.newDevice.footprintRecords, fpDocs[0].effectiveRecords);
				}
				if (deviceBinding.external) assertExternalDeviceDefaults(replacement.newDevice.document, actualDeviceMeta, actualSymbolUuid, footprintRef.uuid, replacement.newDevice.reference.libraryUuid);
				assertTypedPadsMatchFootprint(component, candidateId, fpDocs[0].effectiveRecords.filter(record => record.header.type === 'PAD'), typedPads);
				const selectedDeviceRef = replacement.newDevice.reference;
				const actualDeviceReference = { libraryUuid: prepared.projectUuid, uuid: deviceRef.uuid };
				const resultFootprint = { reference: footprintRef, source: fpDocs[0].source, effectiveRecords: fpDocs[0].effectiveRecords };
				const resourceDocuments = [
					{ docType: 'DEVICE', uuid: deviceRef.uuid, effectiveRecords: deviceDocs[0].effectiveRecords },
					{ docType: 'SYMBOL', uuid: actualSymbolUuid, effectiveRecords: symbolDocs[0].effectiveRecords },
					{ docType: 'FOOTPRINT', uuid: footprintRef.uuid, effectiveRecords: fpDocs[0].effectiveRecords },
				];
				const deviceResolution = {
					requestedReference: selectedDeviceRef,
					actualCandidateReference: actualDeviceReference,
					candidateTypedReference: identity.reference,
					provenance: replacement.newDevice.source ? 'project-device-source' : 'external-device-get-to-project-archive',
					selectedDocument: replacement.newDevice.document,
					actualArchiveSource: deviceDocs[0].source,
					verified: true,
					checks: ['candidate-typed-device-uuid-matches-native-DeviceName',
						...(deviceBinding.external ? ['device-META-source-matches-requested-library-reference', 'device-properties-map-to-native-META-attributes', 'symbol-footprint-and-3d-model-identity-links-checked'] : ['project-device-UUID-and-effective-records-match-frozen-source']),
						...(deviceBinding.candidates.length ? ['actual-device-UUID-uniquely-selects-prepare-frozen-same-source-project-candidate'] : ['actual-device-META-source-identifies-requested-library-resource'])],
				};
				return { stage, replacementIndex, candidateId, candidateUid: identity.uid, requestedDevice: replacement.newDevice.reference,
					candidateDevice: actualDeviceReference, candidateDeviceProvenance: identity.reference,
					actualDevice: { reference: actualDeviceReference, selectedReference: selectedDeviceRef, source: deviceDocs[0].source, effectiveRecords: deviceDocs[0].effectiveRecords },
					actualSymbol: { reference: { libraryUuid: prepared.projectUuid, uuid: actualSymbolUuid }, source: symbolDocs[0].source, effectiveRecords: symbolDocs[0].effectiveRecords },
					candidateFootprint: footprintRef, actualFootprint: resultFootprint, nativePads, typedPads, selectedFootprint: replacement.newDevice.footprint, candidateAttrs: attrs,
					resourceDocuments, deviceResolution };
			}
			if (stage === 'pcb_set_pad_nets') {
				const typedPads = await readTypedPads(api, candidateId), oldNets = new Map<string, string>();
				for (const pad of replacement.oldPcb.pads) {
					const number = String(pad.number), net = String(pad.net ?? ''), prior = oldNets.get(number);
					if (prior !== undefined && prior !== net) throw new Error(`旧焊盘重复编号 ${number} 网络冲突`);
					oldNets.set(number, net);
				}
				const mapping = new Map(replacement.input.pinMap.map(pair => [pair.newNumber, oldNets.get(pair.oldNumber)!]));
				const written: string[] = [];
				for (const pad of typedPads) {
					if (!mapping.has(String(pad.number))) throw new Error(`新候选焊盘没有pinMap：${String(pad.number)}`);
					const padId = String(pad.id), net = mapping.get(String(pad.number))!;
					const result = await api.pcb_PrimitivePad.modify(padId, { net }); if (!result) throw new Error(`候选PAD ${padId} 网络修改未返回对象`); written.push(padId);
				}
				const readback = await readTypedPads(api, candidateId);
				for (const pad of readback) if (pad.net !== mapping.get(String(pad.number))) throw new Error(`候选PAD ${pad.id} 网络读回不符`);
				return { stage, replacementIndex, candidateId, padIds: written, networks: readback.map(pad => ({ id: pad.id, number: pad.number, net: pad.net })) };
			}
			if (stage === 'pcb_restore_association') {
				const oldData = obj(replacement.oldPcb.native, '旧COMPONENT'), oldAttrs = obj(oldData.attrs, '旧COMPONENT attrs');
				const candidateRecord = current.native.records.find(record => record.type === 'COMPONENT' && record.id === candidateId);
				if (!candidateRecord) throw new Error('候选COMPONENT原生记录缺失');
				const data = obj(candidateRecord.data, '候选COMPONENT'), attrs = obj(data.attrs, '候选COMPONENT attrs');
				const props = { ...(getState(component, 'getState_OtherProperty') as JsonObject ?? {}) };
				for (const key of ['Reuse Block', 'Group ID', 'Channel ID']) if (Object.hasOwn(oldAttrs, key)) props[key] = oldAttrs[key];
				const changed = await api.pcb_PrimitiveComponent.modify(candidateId, { groupId: oldData.groupId, otherProperty: props } as any);
				if (!changed) throw new Error('PCB候选关联属性修改未返回对象');
				const freshSource = await openPcb(prepared);
				const patched = patchReplacementNativeSource(freshSource.source, prepared.pcbUuid, 'PCB', [{ type: 'COMPONENT', id: candidateId,
					patch: { groupId: oldData.groupId, attrs: { ...attrs, ...Object.fromEntries(['Reuse Block','Group ID','Channel ID'].filter(key => Object.hasOwn(oldAttrs, key)).map(key => [key, oldAttrs[key]])) } } }]);
				if (patched !== freshSource.source && await api.sys_FileManager.setDocumentSource(patched) !== true) throw new Error('候选关联native patch未确认');
				const after = await openPcb(prepared), readCandidate = after.native.records.find(record => record.type === 'COMPONENT' && record.id === candidateId);
				if (!readCandidate || stableJson(obj(readCandidate.data, '关联读回').groupId) !== stableJson(oldData.groupId)) throw new Error('PCB候选native groupId读回不符');
				for (const key of ['Reuse Block','Group ID','Channel ID']) if (Object.hasOwn(oldAttrs, key) && obj(readCandidate.data, '关联读回').attrs && (obj(readCandidate.data, '关联读回').attrs as JsonObject)[key] !== oldAttrs[key]) throw new Error(`候选${key}业务属性读回不符`);
				return { stage, replacementIndex, candidateId, groupId: oldData.groupId, moduleAttributes: Object.fromEntries(['Reuse Block','Group ID','Channel ID'].filter(key => Object.hasOwn(oldAttrs,key)).map(key => [key,oldAttrs[key]])) };
			}
			if (stage === 'pcb_local_routes') {
				const routes = replacement.localRoutes, segmentIds: string[] = [];
				for (const route of routes) for (let i = 1; i < route.points.length; i++) {
					const layer = typeof route.layer === 'number' ? route.layer : route.layer === 'top' ? 1 : 2;
					const line = await api.pcb_PrimitiveLine.create(route.net, layer as any, route.points[i - 1][0], route.points[i - 1][1], route.points[i][0], route.points[i][1], route.width, false);
					segmentIds.push(requiredString(getState(line, 'getState_PrimitiveId'), '新建铜线ID'));
				}
			const after = await openPcb(prepared), ids = new Set(after.native.records.filter(record => record.type === 'LINE').map(record => record.id));
			if (segmentIds.some(id => !ids.has(id))) throw new Error('本地走线未通过原生记录读回');
			return { stage, replacementIndex, candidateId, segmentIds };
			}
			if (stage === 'pcb_verify_contact') {
				assertCandidateStageBindings(context.previousResults, replacementIndex, candidateId, ['pcb_verify_candidate']);
				const pads = await readTypedPads(api, candidateId), byNumber = new Map(pads.map(pad => [String(pad.number), pad]));
				const native = (await openPcb(prepared)).native;
				if (replacement.localRoutes.length === 0) {
					assertComponentPosePreserved(component, replacement.oldPcb.typed);
					const oldFootprintUuid = resourceUuid(replacement.oldDevice.defaults.Footprint, '旧DEVICE Footprint');
					const oldFootprints = prepared.archiveDocuments.filter(doc => doc.docType === 'FOOTPRINT' && doc.uuid === oldFootprintUuid);
					if (oldFootprints.length !== 1) throw new Error('同封装铜占用证明缺少唯一冻结旧FOOTPRINT');
					const candidateProof = priorStage<PcbCandidateResult & { actualFootprint?: { effectiveRecords?: Array<{ header: JsonObject; data: unknown }> } }>(context.previousResults, 'pcb_verify_candidate', replacementIndex);
					const candidateFootprintRows = candidateProof.actualFootprint?.effectiveRecords;
					if (!Array.isArray(candidateFootprintRows)) throw new Error('同封装铜占用证明缺少候选FOOTPRINT冻结读回');
					assertSameCopperOccupancy(replacement.oldPcb.pads, pads, oldFootprints[0].effectiveRecords, candidateFootprintRows, replacement.input.pinMap);
					const copperRows = (rows: Array<{ type: string; id: string; data: unknown; header: JsonObject }>) => rows.filter(row => row.type === 'LINE' || row.type === 'ARC')
						.map(row => ({ type: row.type, id: row.id, header: row.header, data: row.data })).sort((a, b) => `${a.type}\0${a.id}`.localeCompare(`${b.type}\0${b.id}`));
					if (stableJson(copperRows(prepared.pcbNative.records)) !== stableJson(copperRows(native.records))) throw new Error('同封装无局部走线时，已有LINE/ARC铜对象发生变化');
					return { stage, replacementIndex, candidateId, contactVerified: true, method: 'identical-copper-occupancy-and-net-with-existing-copper-unchanged', verifiedPads: replacement.input.pinMap.length };
				}
				const routesResult = priorStage<PcbCandidateResult>(context.previousResults, 'pcb_local_routes', replacementIndex);
				const lines = routesResult.segmentIds ?? [];
				for (const route of replacement.localRoutes) {
					const target = byNumber.get(route.targetPadNumber); if (!target) throw new Error(`路线目标 PAD 不存在：${route.targetPadNumber}`);
					verifyPadCopperContact(target, route.points[route.points.length - 1]);
					if (target.net !== route.net) throw new Error(`路线目标 PAD ${route.targetPadNumber} 网络与路线不符`);
					const first = route.points[0], anchor = native.records.filter(record => record.type === 'LINE' && record.id === route.anchor.primitiveId);
					if (anchor.length !== 1) throw new Error(`路线锚点LINE不存在或不唯一：${route.anchor.primitiveId}`);
					const a = obj(anchor[0].data, '锚点LINE'), ax = Number(route.anchor.endpoint === 'start' ? a.startX : a.endX), ay = Number(route.anchor.endpoint === 'start' ? a.startY : a.endY);
					if (Math.hypot(first[0] - ax, first[1] - ay) > 0.00254 || a.netName !== route.net) throw new Error('路线首点未精确接触同网锚点');
				}
			return { stage, replacementIndex, candidateId, contactVerified: true, segmentIds: lines };
			}
			if (stage === 'pcb_delete_old') {
				assertCandidateStageBindings(context.previousResults, replacementIndex, candidateId, ['pcb_verify_candidate', 'pcb_verify_contact']);
				const before = current.native.records;
				if (await api.pcb_PrimitiveComponent.delete([originalId]) !== true) throw new Error('删除旧PCB器件未返回true');
				const after = await openPcb(prepared), allowed = (record: any) => {
					if (record.type === 'COMPONENT' && record.id === originalId) return true;
					if (record.type === 'ATTR') return obj(record.data, 'ATTR').parentId === originalId;
					if (record.type === 'PAD_NET') {
						let identity: unknown; try { identity = JSON.parse(record.id); } catch { throw new Error(`删除旧件时遇到无法解析的 PAD_NET id：${record.id}`); }
						if (!Array.isArray(identity) || identity[0] !== 'PAD_NET' || typeof identity[1] !== 'string' || typeof identity[2] !== 'string') throw new Error(`删除旧件时遇到未知 PAD_NET 身份：${record.id}`);
						return identity[1] === originalId;
					}
					return false;
				};
				const removed = before.filter(record => !after.native.records.some(next => next.type === record.type && next.id === record.id));
				if (removed.some(record => !allowed(record))) throw new Error(`删除旧件造成非允许记录消失：${removed.filter(record => !allowed(record)).map(record => `${record.type}/${record.id}`).join(',')}`);
				if (after.native.records.some(record => record.type === 'COMPONENT' && record.id === originalId)
					|| !after.native.records.some(record => record.type === 'COMPONENT' && record.id === candidateId)) throw new Error('旧件删除后候选/旧件状态读回不符');
				return { stage, replacementIndex, candidateId, deletedOldId: originalId, removed: removed.map(record => ({ type: record.type, id: record.id })) };
			}
			if (stage === 'pcb_assign_identity') {
				if (!priorStage(context.previousResults, 'pcb_delete_old', replacementIndex)) throw new Error('身份转移前缺少旧件删除确认');
				const designator = requiredString(replacement.oldPcb.typed.getState_Designator, '冻结旧 PCB 位号');
				const primitiveLock = replacement.oldPcb.typed.getState_PrimitiveLock;
				if (typeof primitiveLock !== 'boolean') throw new Error('旧件 PrimitiveLock 读回不是布尔值');
				const result = await api.pcb_PrimitiveComponent.modify(candidateId, { uniqueId: replacement.input.oldUid, designator, primitiveLock });
				if (!result) throw new Error('候选最终UID/位号修改未返回对象');
				const after = await openPcb(prepared), component = await api.pcb_PrimitiveComponent.get(candidateId);
				if (!component || getState(component, 'getState_UniqueId') !== replacement.input.oldUid || getState(component, 'getState_Designator') !== designator
					|| getState(component, 'getState_PrimitiveLock') !== primitiveLock) throw new Error('最终候选typed UID/位号/锁定状态读回不符');
				const finalDeviceRef = typedDeviceReference(getState(component, 'getState_Component'), '最终候选Device reference');
				const verifiedDeviceIdentity = assertFinalCandidateDeviceIdentity(context.previousResults, replacementIndex, candidateId,
					finalDeviceRef, prepared.projectUuid, after.native.records);
				assertReplacementComponentIdentity(after.native.records, candidateId, replacement.input.oldUid, designator, 'PCB');
				return { stage, replacementIndex, candidateId, uniqueId: replacement.input.oldUid, designator, primitiveLock,
					typedDeviceReference: verifiedDeviceIdentity.typedReference, deviceReferenceProvenance: verifiedDeviceIdentity.provenance,
					verifiedActualDeviceReference: verifiedDeviceIdentity.actualReference };
			}
		throw new Error(`该 runtime 尚未实现阶段 ${stage}`);
	};
	return {
		readAndPrepare: async input => { currentPlan = await readReplacementPlan(api, input); verification.reset(currentPlan); return currentPlan; },
		assertPlanStillCurrent: async plan => verification.assertPlanStillCurrent(plan.prepared as PreparedReplacement),
		performStage: async (prepared, replacementIndex, stage, context) => {
			const result = await performStageCore(prepared, replacementIndex, stage, context);
			await verification.acceptStageDelta(prepared, replacementIndex, stage, context, result);
			return result;
		},
		saveCloseReopen: (prepared, priorResults) => verification.saveCloseReopen(prepared, priorResults),
		verifyFinal: (prepared, priorResults) => verification.verifyFinal(prepared, priorResults),
	};
}

/** Default production binding; stages are implemented by the SDK runtime above. */
export function createEdaComponentReplacementHost(api: typeof eda = eda): ReplacementHost<PreparedReplacement> {
	return createComponentReplacementHost(createEdaComponentReplacementRuntime(api), {
		getExtensionUserConfig: key => api.sys_Storage.getExtensionUserConfig(key),
		setExtensionUserConfig: (key, value) => api.sys_Storage.setExtensionUserConfig(key, value),
	});
}
