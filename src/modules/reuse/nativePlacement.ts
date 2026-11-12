import { parseSourceLog, resolveRecords } from './sourcelog';
import { AllowedAttributeChange, parseJlcEdaNetlist, sha256Hex, stablePcbIdentityJson, verifyOnlyAllowedIdentityChanges } from './pcbIdentityExport';

const STORAGE_KEY = 'module-reuse:native-placement:v1';
const PLACEMENT_READBACK_BUDGET_MS = 5000;
const PLACEMENT_READBACK_MAX_POLLS = 20;
const PLACEMENT_READBACK_POLL_INTERVAL_MS = 250;
const IDENTITY_PROJECT_GETTER_RETRY_BUDGET_MS = 1000;
const IDENTITY_PROJECT_GETTER_MAX_RETRIES = 3;
const IDENTITY_PROJECT_GETTER_RETRY_INTERVAL_MS = 100;
const EMPTY_STATE = () => ({ schema: 1, operations: Object.create(null) as Record<string, any> });

export type PlacementCause = {
	partial: boolean;
	retryable: false;
	outcome: 'unknown' | 'not_started' | 'pending-verification';
	operationId: string;
	phase: string;
};

type NetMapKind = 'internal' | 'interface';
type NetMapRow = { sourceNet: string; targetNet: string; kind: NetMapKind };
type NetBinding = NetMapRow & {
	wireId: string;
	attributeId: string;
	beforeValue: string;
	afterValue: string;
};

export class NativePlacementError extends Error {
	readonly operationCause?: PlacementCause;

	constructor(message: string, operationCause?: PlacementCause) {
		super(message);
		this.name = 'NativePlacementError';
		this.operationCause = operationCause;
	}
}

function fail(message: string): never {
	throw new Error(message);
}

function plainObject(value: unknown): value is Record<string, any> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		fail(`${name} 必须是非空字符串`);
	return value;
}

function ownValue(map: Record<string, any>, key: string): any {
	return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function sorted(value: any): any {
	if (Array.isArray(value))
		return value.map(sorted);
	if (plainObject(value)) {
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value).sort())
			result[key] = sorted(value[key]);
		return result;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sorted(value));
}

function readStoredState(): any {
	const raw = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
	if (raw === undefined)
		return EMPTY_STATE();
	let parsed: any;
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	}
	catch {
		fail('原生放置持久状态不是有效 JSON，已停止后续操作');
	}
	if (!plainObject(parsed) || parsed.schema !== 1 || !plainObject(parsed.operations))
		fail('原生放置持久状态结构无效，已停止后续操作');
	return { ...parsed, operations: Object.assign(Object.create(null), parsed.operations) };
}

async function persistState(next: any): Promise<void> {
	const stored = await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY, JSON.stringify(next));
	if (stored !== true)
		fail('原生放置状态写入返回 false 或空结果');
	let readback: unknown;
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
		readback = typeof raw === 'string' ? JSON.parse(raw) : raw;
	}
	catch {
		fail('原生放置状态写后读回不是有效 JSON');
	}
	if (stableStringify(readback) !== stableStringify(next))
		fail('原生放置状态写后读回不一致');
}

async function persistRecord(record: any): Promise<void> {
	const next = readStoredState();
	next.operations[record.operationId] = record;
	await persistState(next);
}

function existingRecord(operationId: string, targetProjectUuid: string, args: Record<string, unknown>): any | undefined {
	const record = ownValue(readStoredState().operations, operationId);
	if (!record)
		return undefined;
	if (record.targetProjectUuid !== targetProjectUuid || stableStringify(record.args) !== stableStringify(args))
		fail('operationId 已用于不同参数或目标工程，拒绝重放');
	return record;
}

function operationData(record: any): Record<string, unknown> {
	return {
		operationId: record.operationId,
		targetProjectUuid: record.targetProjectUuid,
		args: record.args,
		outcome: record.outcome,
		phase: record.phase,
		...(record.sdkResult !== undefined ? { sdkResult: record.sdkResult } : {}),
		...(record.targetPageReadback ? { targetPageReadback: record.targetPageReadback } : {}),
		...(record.preState?.targetSnapshot ? { targetSnapshot: record.preState.targetSnapshot } : {}),
		...(record.introducedBoards ? { introducedBoards: record.introducedBoards } : {}),
		...(record.renamed !== undefined ? { renamed: record.renamed } : {}),
		...(record.noOp !== undefined ? { noOp: record.noOp } : {}),
		...(record.contentsVerified !== undefined ? { contentsVerified: record.contentsVerified } : {}),
		...(record.templateContentsUnchanged !== undefined ? { templateContentsUnchanged: record.templateContentsUnchanged } : {}),
		...(record.geometryUnchanged !== undefined ? { geometryUnchanged: record.geometryUnchanged } : {}),
		...(record.affectedIDs !== undefined ? { affectedIDs: record.affectedIDs } : {}),
		...(record.confirmedIDs !== undefined ? { confirmedIDs: record.confirmedIDs } : {}),
		...(record.pendingIDs !== undefined ? { pendingIDs: record.pendingIDs } : {}),
		...(record.referenceBeforeAfter !== undefined ? { referenceBeforeAfter: record.referenceBeforeAfter } : {}),
		...(record.channelBeforeAfter !== undefined ? { channelBeforeAfter: record.channelBeforeAfter } : {}),
		...(record.channelConfirmedIDs !== undefined ? { channelConfirmedIDs: record.channelConfirmedIDs } : {}),
		...(record.channelPendingIDs !== undefined ? { channelPendingIDs: record.channelPendingIDs } : {}),
		...(record.alignmentComponentPairing !== undefined ? { alignmentComponentPairing: record.alignmentComponentPairing } : {}),
		...(record.pairAssociationVerified !== undefined ? { pairAssociationVerified: record.pairAssociationVerified } : {}),
		...(record.placementVerified !== undefined ? { placementVerified: record.placementVerified } : {}),
		...(record.netMap !== undefined ? { netMap: record.netMap } : {}),
		...(record.mappedNetworks !== undefined ? { mappedNetworks: record.mappedNetworks } : {}),
		...(record.bindings !== undefined ? { bindings: record.bindings } : {}),
		...(record.namedSourcesMapped !== undefined ? { namedSourcesMapped: record.namedSourcesMapped } : {}),
		...(record.netlistVerified !== undefined ? { netlistVerified: record.netlistVerified } : {}),
		...(record.getterRetryDiagnostics !== undefined ? { getterRetryDiagnostics: record.getterRetryDiagnostics } : {}),
		...(record.error ? { error: record.error } : {}),
	};
}

function inputArgs(params: Record<string, any>, operation: 'placeSchematicPage' | 'alignTemplatePcb' | 'mapInstanceNets'): Record<string, any> {
	const keys = operation === 'placeSchematicPage'
		? ['operationId', 'cbbUuid', 'libraryUuid', 'sourceSchematicUuid', 'sourcePcbUuid', 'targetProjectUuid', 'targetSchematicUuid', 'targetSchematicPageUuid', 'targetPcbUuid', 'x', 'y', 'reimportWhenNameRepeated']
		: operation === 'alignTemplatePcb'
			? ['operationId', 'targetProjectUuid', 'targetSchematicPageUuid', 'templateSchematicUuid', 'templatePcbUuid', 'placementOperationId']
			: ['operationId', 'placementOperationId', 'targetProjectUuid', 'targetSchematicPageUuid', 'netMap'];
	if (!plainObject(params) || Object.keys(params).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(params, key)))
		fail(`${operation} 参数字段不符合严格白名单`);
	const result: Record<string, any> = {};
	for (const key of keys) {
		if (operation === 'mapInstanceNets' && key === 'netMap') {
			if (!Array.isArray(params.netMap) || params.netMap.length === 0)
				fail('netMap 必须是非空映射数组');
			const sources = new Set<string>();
			result.netMap = params.netMap.map((entry: unknown, index: number) => {
				if (!plainObject(entry) || Object.keys(entry).length !== 3
					|| !['sourceNet', 'targetNet', 'kind'].every(field => Object.prototype.hasOwnProperty.call(entry, field)))
					fail(`netMap[${index}] 仅接受 sourceNet、targetNet 和 kind`);
				const sourceNet = requireId(entry.sourceNet, `netMap[${index}].sourceNet`);
				const targetNet = requireId(entry.targetNet, `netMap[${index}].targetNet`);
				if (entry.kind !== 'internal' && entry.kind !== 'interface')
					fail(`netMap[${index}].kind 必须是 internal 或 interface`);
				if (sources.has(sourceNet))
					fail(`netMap 中 sourceNet 重复：${sourceNet}`);
				sources.add(sourceNet);
				return { sourceNet, targetNet, kind: entry.kind };
			});
		}
		else if (key === 'x' || key === 'y') {
			if (typeof params[key] !== 'number' || !Number.isFinite(params[key]))
				fail(`${key} 必须是有限数值`);
			result[key] = params[key];
		}
		else if (key === 'reimportWhenNameRepeated') {
			if (typeof params[key] !== 'boolean')
				fail('reimportWhenNameRepeated 必须是布尔值');
			result[key] = params[key];
		}
		else
			result[key] = requireId(params[key], key);
	}
	return result;
}

export function validatePlaceSchematicPageParams(params: Record<string, any>): Record<string, any> {
	return inputArgs(params, 'placeSchematicPage');
}

export function validateAlignTemplatePcbParams(params: Record<string, any>): Record<string, any> {
	return inputArgs(params, 'alignTemplatePcb');
}

export function validateMapInstanceNetsParams(params: Record<string, any>): Record<string, any> {
	return inputArgs(params, 'mapInstanceNets');
}

function projectByUuid(project: any, expectedUuid: string): any {
	if (!plainObject(project) || project.uuid !== expectedUuid)
		fail('当前工程与目标工程不一致');
	if (!Array.isArray(project.data))
		fail('当前工程树缺少有效 data 列表');
	return project;
}

type IdentityProjectGetterRetryScope = {
	retriesRemaining: number;
	remainingRetryWaitMs: number;
	record: any;
	expectedDocumentUuid?: string;
};

function exactTransientBoardsGetterError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	try {
		const candidate = error as { name?: unknown; message?: unknown };
		return candidate.name === 'TypeError'
			&& candidate.message === "Cannot destructure property 'boardsArr' of 'e' as it is undefined.";
	}
	catch { return false; }
}

async function readProject(expectedUuid: string, retryScope?: IdentityProjectGetterRetryScope, retryAttempt = 1): Promise<any> {
	let rawProject: any;
	try {
		rawProject = await eda.dmt_Project.getCurrentProjectInfo();
	}
	catch (error) {
		if (!retryScope || !exactTransientBoardsGetterError(error)) throw error;
		const diagnostic = retryScope.record.getterRetryDiagnostics ??= {
			phase: retryScope.record.phase,
			expectedProjectUuid: expectedUuid,
			expectedDocumentUuid: retryScope.expectedDocumentUuid,
			attempts: 0,
			lastError: undefined,
		};
		diagnostic.phase = retryScope.record.phase;
		diagnostic.expectedProjectUuid = expectedUuid;
		diagnostic.expectedDocumentUuid = retryScope.expectedDocumentUuid;
		diagnostic.attempts = retryAttempt;
		diagnostic.retriesUsed = IDENTITY_PROJECT_GETTER_MAX_RETRIES - retryScope.retriesRemaining;
		const getterError = error as Error;
		diagnostic.lastError = { name: getterError.name, message: getterError.message };
		if (retryScope.retriesRemaining <= 0 || retryScope.remainingRetryWaitMs <= 0) throw error;
		retryScope.retriesRemaining--;
		const retryWaitMs = Math.min(IDENTITY_PROJECT_GETTER_RETRY_INTERVAL_MS, retryScope.remainingRetryWaitMs);
		retryScope.remainingRetryWaitMs -= retryWaitMs;
		await new Promise<void>(resolve => setTimeout(resolve, retryWaitMs));
		return readProject(expectedUuid, retryScope, retryAttempt + 1);
	}
	if (retryScope && retryAttempt > 1) {
		const diagnostic = retryScope.record.getterRetryDiagnostics;
		if (diagnostic) {
			diagnostic.attempts = retryAttempt;
			diagnostic.retriesUsed = IDENTITY_PROJECT_GETTER_MAX_RETRIES - retryScope.retriesRemaining;
		}
	}
	return projectByUuid(rawProject, expectedUuid);
}

async function readOpenedProjectWhenEmpty(expectedUuid: string, phase: string): Promise<any> {
	const startedAt = Date.now();
	let lastProject: any;
	for (let attempt = 0; attempt <= PLACEMENT_READBACK_MAX_POLLS; attempt++) {
		if (attempt > 0 && Date.now() - startedAt >= PLACEMENT_READBACK_BUDGET_MS)
			fail(`工程树仍未加载：phase=${phase}, uuid=${lastProject?.uuid ?? expectedUuid}, dataCount=${lastProject?.data?.length ?? 0}`);
		const project = await readProject(expectedUuid);
		if (project.data.length > 0)
			return project;
		lastProject = project;
		const elapsedMs = Date.now() - startedAt;
		if (attempt >= PLACEMENT_READBACK_MAX_POLLS || elapsedMs >= PLACEMENT_READBACK_BUDGET_MS)
			fail(`工程树仍未加载：phase=${phase}, uuid=${expectedUuid}, dataCount=${project.data.length}`);
		await new Promise<void>(resolve => setTimeout(
			resolve,
			Math.min(PLACEMENT_READBACK_POLL_INTERVAL_MS, PLACEMENT_READBACK_BUDGET_MS - elapsedMs),
		));
	}
	fail(`工程树仍未加载：phase=${phase}, uuid=${expectedUuid}, dataCount=0`);
}

function boardItems(project: any): any[] {
	return project.data.filter((item: any) => plainObject(item) && item.itemType === 'Board');
}

function pageByUuid(board: any, uuid: string): any | undefined {
	if (!plainObject(board?.schematic) || !Array.isArray(board.schematic.page))
		return undefined;
	return board.schematic.page.find((page: any) => page?.uuid === uuid);
}

function boardByPair(project: any, schematicPageUuid: string, pcbUuid: string): any {
	const matches = boardItems(project).filter(board => pageByUuid(board, schematicPageUuid) && board.pcb?.uuid === pcbUuid);
	if (matches.length !== 1)
		fail(matches.length === 0 ? '指定原理图图页与 PCB 未在工程树中证明属于同一 Board' : '工程树中存在多个匹配 Board，无法唯一确认配对');
	const board = matches[0];
	if (board.parentProjectUuid !== project.uuid || board.schematic?.parentProjectUuid !== project.uuid || board.pcb?.parentProjectUuid !== project.uuid)
		fail('目标 Board、原理图或 PCB 的工程归属不一致');
	return board;
}

function boardDocumentUuid(value: any): string | undefined {
	return typeof value === 'string' ? value : plainObject(value) && typeof value.uuid === 'string' ? value.uuid : undefined;
}

function sourceBoard(cbb: any, schematicUuid: string, pcbUuid: string): any {
	if (!plainObject(cbb) || !Array.isArray(cbb.boards))
		fail('复用模块缺少有效 boards 列表');
	const matches = cbb.boards.filter((board: any) => {
		if (!plainObject(board) || board.itemType !== 'Board'
			|| boardDocumentUuid(board.schematic) !== schematicUuid
			|| boardDocumentUuid(board.pcb) !== pcbUuid
			|| typeof board.parentProjectUuid !== 'string' || !board.parentProjectUuid.trim())
			return false;
		const relatedParents = [
			cbb.parentProjectUuid,
			plainObject(board.schematic) ? board.schematic.parentProjectUuid : undefined,
			plainObject(board.pcb) ? board.pcb.parentProjectUuid : undefined,
		].filter((value: any) => value !== undefined && value !== null && value !== '');
		return relatedParents.every((value: any) => value === board.parentProjectUuid);
	});
	if (matches.length !== 1)
		fail('复用模块库中未找到唯一的来源原理图与 PCB 同板配对');
	return matches[0];
}

async function resolveCbbSourcePage(args: Record<string, any>): Promise<Record<string, any>> {
	const cbb = await readCbb(args.cbbUuid, args.libraryUuid);
	const selected = sourceBoard(cbb, args.sourceSchematicUuid, args.sourcePcbUuid);
	const sourceProjectUuid = selected.parentProjectUuid;
	if (typeof eda.lib_Cbb.openProjectInEditor !== 'function')
		fail('SDK 未提供 lib_Cbb.openProjectInEditor，无法读取复用模块来源图页');
	if (await eda.lib_Cbb.openProjectInEditor(args.cbbUuid, args.libraryUuid) !== true)
		fail('打开复用模块来源工程失败');
	const project = await readOpenedProjectWhenEmpty(sourceProjectUuid, 'source_project_tree');
	const matches = boardItems(project).filter((board: any) => board.parentProjectUuid === sourceProjectUuid
		&& board.schematic?.uuid === args.sourceSchematicUuid
		&& board.pcb?.uuid === args.sourcePcbUuid
		&& board.schematic?.parentProjectUuid === sourceProjectUuid
		&& board.pcb?.parentProjectUuid === sourceProjectUuid);
	if (matches.length !== 1)
		fail('复用模块来源工程中未找到唯一的父原理图与 PCB 同板 Board');
	const board = matches[0];
	if (!Array.isArray(board.schematic?.page))
		fail('来源父原理图缺少有效图页列表');
	const childPages = board.schematic.page;
	if (childPages.length !== 1)
		fail(childPages.length === 0 ? '来源父原理图下没有子页' : '来源父原理图下存在多个子页，无法唯一选择');
	const childPage = childPages[0];
	if (childPage?.itemType !== 'Schematic Page' || typeof childPage.uuid !== 'string' || !childPage.uuid.trim()
		|| childPage.parentSchematicUuid !== args.sourceSchematicUuid)
		fail('来源子页类型或 UUID 无效');
	const sourceDocument = await openActivateAndRead(sourceProjectUuid, childPage.uuid, 'schematic');
	const sourceComponents = componentRecordsWithAttributes(sourceDocument);
	if (!sourceComponents.length)
		fail('来源子页没有可用于建立实例对应的组件');
	return {
		sourceProjectUuid,
		sourceBoard: { name: board.name, parentProjectUuid: board.parentProjectUuid, schematicUuid: board.schematic.uuid, pcbUuid: board.pcb.uuid },
		childPageUuid: childPage.uuid,
		sourceComponents,
	};
}

async function currentDocument(projectUuid: string, uuid: string, expectedType: 'schematic' | 'pcb'): Promise<any> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	const documentType = expectedType === 'schematic' ? 1 : 3;
	if (!document || document.uuid !== uuid || document.parentProjectUuid !== projectUuid || document.documentType !== documentType)
		fail(`当前文档身份、工程归属或类型不匹配：${uuid}`);
	return document;
}

async function openActivateAndRead(projectUuid: string, uuid: string, expectedType: 'schematic' | 'pcb', retryScope?: IdentityProjectGetterRetryScope): Promise<any> {
	if (retryScope) retryScope.expectedDocumentUuid = uuid;
	await readProject(projectUuid, retryScope);
	const tabId = await eda.dmt_EditorControl.openDocument(uuid);
	if (typeof tabId !== 'string' || !tabId)
		fail(`打开文档失败：${uuid}`);
	if (await eda.dmt_EditorControl.activateDocument(tabId) !== true)
		fail(`激活文档失败：${uuid}`);
	await readProject(projectUuid, retryScope);
	await currentDocument(projectUuid, uuid, expectedType);
	const source = await eda.sys_FileManager.getDocumentSource();
	const parsed = parseDocumentSource(source, uuid, expectedType);
	await readProject(projectUuid, retryScope);
	await currentDocument(projectUuid, uuid, expectedType);
	return parsed;
}

async function readCurrentAndRead(projectUuid: string, uuid: string, expectedType: 'schematic' | 'pcb'): Promise<any> {
	await readProject(projectUuid);
	await currentDocument(projectUuid, uuid, expectedType);
	const source = await eda.sys_FileManager.getDocumentSource();
	const parsed = parseDocumentSource(source, uuid, expectedType);
	await readProject(projectUuid);
	await currentDocument(projectUuid, uuid, expectedType);
	return parsed;
}

function parseDocumentSource(source: unknown, uuid: string, expectedType: 'schematic' | 'pcb'): any {
	if (typeof source !== 'string' || !source)
		fail('sys_FileManager.getDocumentSource 返回空或非法值');
	const parsed = parseSourceLog(source);
	const docType = expectedType === 'schematic' ? 'SCH_PAGE' : 'PCB';
	if (parsed.uuid !== uuid || parsed.docType.toUpperCase() !== docType)
		fail(`DOCHEAD 与目标身份/类型不符：期望 ${docType}/${uuid}，实际 ${parsed.docType}/${parsed.uuid}`);
	for (const record of parsed.records) {
		if (record.header.type !== 'DOCHEAD' && (typeof record.header.type !== 'string' || !record.header.type.trim() || typeof record.header.id !== 'string' || !record.header.id.trim()))
			fail(`源码包含无法安全比较的记录（第 ${record.line} 行）`);
	}
	const effective = resolveRecords(parsed);
	return { parsed, effective, recordCount: effective.size, source };
}

function effectiveRecordForComparison(record: any): { header: any; data: any } {
	const header = { ...record.header };
	delete header.ticket;
	let data = record.data;
	if (header.type === 'ATTR' && plainObject(data) && !Object.prototype.hasOwnProperty.call(data, 'strikeout'))
		data = { ...data, strikeout: false };
	if (header.type === 'COMPONENT' && plainObject(data)) {
		const attrs = plainObject(data.attrs) ? data.attrs : data.attrs === undefined ? {} : undefined;
		if (attrs && !Object.prototype.hasOwnProperty.call(attrs, 'isSwitchClose'))
			data = { ...data, attrs: { ...attrs, isSwitchClose: false } };
	}
	return { header, data };
}

function sameEffectiveRecord(left: any, right: any): boolean {
	return stableStringify(effectiveRecordForComparison(left)) === stableStringify(effectiveRecordForComparison(right));
}

function sameEffectiveRecords(left: any, right: any): boolean {
	if (left.effective.size !== right.effective.size)
		return false;
	for (const [key, leftRecord] of left.effective.entries()) {
		const rightRecord = right.effective.get(key);
		if (!rightRecord || !sameEffectiveRecord(leftRecord, rightRecord))
			return false;
	}
	return true;
}

function blankFrameOnlyPage(document: any): { componentId: string; childRecords: any[] } | undefined {
	const records = [...document.effective.values()];
	const components = records.filter((record: any) => record.header.type === 'COMPONENT');
	if (components.length !== 1 || records.some((record: any) => !['CANVAS', 'COMPONENT', 'ATTR'].includes(record.header.type)))
		return undefined;
	const component = components[0];
	const rawDeviceName = component.data?.attrs?.DeviceName;
	let deviceName: any = rawDeviceName;
	if (typeof rawDeviceName === 'string') {
		try { deviceName = JSON.parse(rawDeviceName); }
		catch { return undefined; }
	}
	if (typeof deviceName?.name !== 'string' || !deviceName.name.startsWith('Drawing-Symbol_'))
		return undefined;
	const childRecords = records.filter((record: any) => record.header.type === 'ATTR' && record.data?.parentId === component.header.id);
	if (!childRecords.length || records.filter((record: any) => record.header.type === 'ATTR').length !== childRecords.length)
		return undefined;
	return { componentId: component.header.id, childRecords };
}

function orderedFrameChildIds(children: any[]): string[] | undefined {
	const indexed = children.map(record => ({ id: record.header.id, z: record.data?.zIndex }));
	if (indexed.some(item => typeof item.z !== 'number' || !Number.isFinite(item.z))
		|| new Set(indexed.map(item => item.z)).size !== indexed.length)
		return undefined;
	return indexed.sort((a, b) => a.z - b.z).map(item => item.id);
}

function sameTargetSnapshotContent(left: any, right: any): boolean {
	if (sameEffectiveRecords(left, right))
		return true;
	if (left.effective.size !== right.effective.size)
		return false;
	const leftFrame = blankFrameOnlyPage(left);
	const rightFrame = blankFrameOnlyPage(right);
	if (!leftFrame || !rightFrame || leftFrame.componentId !== rightFrame.componentId)
		return false;
	const leftOrderedIds = orderedFrameChildIds(leftFrame.childRecords);
	const rightOrderedIds = orderedFrameChildIds(rightFrame.childRecords);
	if (!leftOrderedIds || !rightOrderedIds || stableStringify(leftOrderedIds) !== stableStringify(rightOrderedIds))
		return false;
	for (const [key, before] of left.effective.entries()) {
		const after = right.effective.get(key);
		if (!after)
			return false;
		if (before.header.type !== 'ATTR' || before.data?.parentId !== leftFrame.componentId) {
			if (!sameEffectiveRecord(before, after)) return false;
			continue;
		}
		const beforeComparable = effectiveRecordForComparison(before);
		const afterComparable = effectiveRecordForComparison(after);
		if (stableStringify(beforeComparable.header) !== stableStringify(afterComparable.header))
			return false;
		const beforeData = { ...beforeComparable.data };
		const afterData = { ...afterComparable.data };
		const beforeZ = beforeData.zIndex;
		const afterZ = afterData.zIndex;
		delete beforeData.zIndex;
		delete afterData.zIndex;
		if (typeof beforeZ !== 'number' || !Number.isFinite(beforeZ)
			|| typeof afterZ !== 'number' || !Number.isFinite(afterZ)
			|| stableStringify(beforeData) !== stableStringify(afterData))
			return false;
	}
	return true;
}

function displayDiffValue(value: any): any {
	const serialized = stableStringify(value);
	return serialized.length <= 120 ? value : `${serialized.slice(0, 117)}...`;
}

function recordFieldChanges(before: any, after: any): any[] {
	const fields: any[] = [];
	for (const section of ['header', 'data']) {
		const oldPart = section === 'header' ? effectiveRecordForComparison(before).header : effectiveRecordForComparison(before).data;
		const newPart = section === 'header' ? effectiveRecordForComparison(after).header : effectiveRecordForComparison(after).data;
		const keys = new Set([...Object.keys(oldPart ?? {}), ...Object.keys(newPart ?? {})]);
		for (const key of [...keys].sort()) {
			const hasOld = Object.prototype.hasOwnProperty.call(oldPart ?? {}, key);
			const hasNew = Object.prototype.hasOwnProperty.call(newPart ?? {}, key);
			if (hasOld === hasNew && stableStringify(oldPart?.[key]) === stableStringify(newPart?.[key]))
				continue;
			fields.push({ field: `${section}.${key}`, old: hasOld ? displayDiffValue(oldPart[key]) : '<missing>', new: hasNew ? displayDiffValue(newPart[key]) : '<missing>' });
			if (fields.length >= 8)
				return fields;
		}
	}
	return fields;
}

function targetContentDiff(before: any, after: any): Record<string, unknown> {
	const addedIds: any[] = [];
	const removedIds: any[] = [];
	const changed: any[] = [];
	for (const [key, record] of after.effective.entries()) {
		const previous = before.effective.get(key);
		const identity = { type: record.header.type, id: record.header.id };
		if (!previous)
			addedIds.push(identity);
		else if (!sameEffectiveRecord(previous, record))
			changed.push({ ...identity, fields: recordFieldChanges(previous, record) });
	}
	for (const [key, record] of before.effective.entries())
		if (!after.effective.has(key))
			removedIds.push({ type: record.header.type, id: record.header.id });
	const MAX_IDS = 20;
	const MAX_CHANGED = 12;
	return {
		expectedEffectiveCount: before.effective.size,
		actualEffectiveCount: after.effective.size,
		addedIds: addedIds.slice(0, MAX_IDS),
		removedIds: removedIds.slice(0, MAX_IDS),
		changed: changed.slice(0, MAX_CHANGED),
		...(addedIds.length > MAX_IDS ? { omittedAddedIdCount: addedIds.length - MAX_IDS } : {}),
		...(removedIds.length > MAX_IDS ? { omittedRemovedIdCount: removedIds.length - MAX_IDS } : {}),
		...(changed.length > MAX_CHANGED ? { omittedChangedRecordCount: changed.length - MAX_CHANGED } : {}),
	};
}

class TargetContentMismatchError extends Error {
	readonly targetContentDiff: Record<string, unknown>;

	constructor(expected: any, actual: any) {
		super('恢复目标工程后目标图页内容发生变化');
		this.name = 'TargetContentMismatchError';
		this.targetContentDiff = targetContentDiff(expected, actual);
	}
}

class TargetRestoreVerificationError extends Error {
	readonly phase = 'target_project_tree_restore';

	constructor(message: string) {
		super(message);
		this.name = 'TargetRestoreVerificationError';
	}
}

function componentReuseBlocks(document: any): any[] {
	const componentIds = new Set<string>();
	for (const record of document.effective.values())
		if (record.header.type === 'COMPONENT')
			componentIds.add(record.header.id);
	const attrs = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR' && componentIds.has(record.data?.parentId));
	return attrs.filter((record: any) => record.data?.key === 'Reuse Block' && typeof record.data.value === 'string' && record.data.value.trim())
		.map((record: any) => {
			const componentId = record.data.parentId;
			const valueFor = (key: string): any => attrs.find((item: any) => item.data.parentId === componentId && item.data.key === key)?.data.value;
			return { componentId, value: record.data.value, groupId: valueFor('Group ID'), channelId: valueFor('Channel ID') };
		});
}

function reuseBlockAttributes(document: any, componentIds: string[]): any[] {
	return componentIds.map(componentId => {
		const matches = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR'
			&& record.data?.parentId === componentId && record.data?.key === 'Reuse Block');
		if (matches.length !== 1 || typeof matches[0].data.value !== 'string' || !matches[0].data.value.trim())
			fail(`新增组件 ${componentId} 缺少唯一有效的 Reuse Block 属性`);
		return { componentId, attributeId: matches[0].header.id, value: matches[0].data.value };
	});
}

function oneAttributePerComponent(document: any, componentIds: string[], key: string): any[] {
	return componentIds.map(componentId => {
		const matches = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR'
			&& record.data?.parentId === componentId && record.data?.key === key);
		if (matches.length !== 1 || typeof matches[0].data.value !== 'string' || !matches[0].data.value.trim())
			fail(`新增组件 ${componentId} 缺少唯一有效的 ${key} 属性`);
		return { componentId, attributeId: matches[0].header.id, value: matches[0].data.value };
	});
}

function physicalPcbChannels(document: any, requiredUids?: Set<string>): Map<string, string> {
	const componentRecords = [...document.effective.values()].filter((record: any) => record.header.type === 'COMPONENT');
	const rows = new Map<string, string>();
	for (const component of componentRecords) {
		const uidMatches = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR'
			&& record.data?.parentId === component.header.id && record.data?.key === 'Unique ID');
		const channelMatches = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR'
			&& record.data?.parentId === component.header.id && record.data?.key === 'Channel ID');
		const uid = (plainObject(component.data?.attrs) ? component.data.attrs['Unique ID'] : undefined) ?? uidMatches[0]?.data?.value;
		const channel = (plainObject(component.data?.attrs) ? component.data.attrs['Channel ID'] : undefined) ?? channelMatches[0]?.data?.value;
		if (requiredUids && (typeof uid !== 'string' || !requiredUids.has(uid))) continue;
		if (uid === undefined && channel === undefined) continue;
		if (typeof uid !== 'string' || !uid.trim() || typeof channel !== 'string' || !channel.trim()
			|| uidMatches.length > 1 || channelMatches.length > 1)
			fail(`模板 PCB 物理器件 ${component.header.id} 缺少唯一 UID/Channel ID`);
		if (rows.has(uid)) fail(`模板 PCB 物理器件 Unique ID 重复：${uid}`);
		rows.set(uid, channel);
	}
	if (requiredUids)
		for (const uid of requiredUids)
			if (!rows.has(uid)) fail(`模板 PCB 中找不到已配对来源 Unique ID 的物理器件：${uid}`);
	return rows;
}

function channelUpdatesForPlacement(templateSchematic: any, targetDocument: any, templatePcb: any, placementRecord: any, pairing?: any): any[] {
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(componentIds) || !componentIds.length) fail('placement 没有新增组件，不能核验通道映射');
	const sourceComponents = componentRecordsWithAttributes(templateSchematic);
	pairing ??= uniqueTranslatedComponentPairing(sourceComponents, targetDocument, componentIds);
	if (pairing.verified !== true) fail(`无法验证来源 SCH 与实例组件对应：${pairing.reason}`);
	const pcbChannels = physicalPcbChannels(templatePcb);
	const targetById = new Map(componentRecordsWithAttributes(targetDocument, new Set(componentIds)).map((item: any) => [item.id, item]));
	const targetChannels = oneAttributePerComponent(targetDocument, componentIds, 'Channel ID');
	const channelByTarget = new Map<string, string>();
	for (const pair of pairing.pairs) {
		const physicalChannel = pcbChannels.get(pair.sourceUid);
		if (!physicalChannel) fail(`模板 PCB 中找不到来源 Unique ID 的物理器件：${pair.sourceUid}`);
		channelByTarget.set(pair.targetId, physicalChannel);
	}
	if (channelByTarget.size !== componentIds.length) fail('来源组件到物理 PCB 通道映射未覆盖全部 placement 组件');
	const existing = new Map(targetChannels.map((item: any) => [item.componentId, item]));
	const pairByTarget = new Map(pairing.pairs.map((item: any) => [item.targetId, item]));
	return componentIds.map((componentId: string) => {
		const current: any = existing.get(componentId), pair: any = targetById.get(componentId), correspondence: any = pairByTarget.get(componentId), afterValue = channelByTarget.get(componentId);
		if (!current || !pair || !correspondence || typeof afterValue !== 'string') fail(`placement 组件通道对应缺失：${componentId}`);
		const placementChannel = placementRecord.targetPageReadback.reuseBlocks.find((item: any) => item.componentId === componentId)?.channelId;
		if (current.value !== placementChannel && current.value !== afterValue)
			fail(`目标组件 Channel ID 与原放置值及模板 PCB 预期值均不一致：${componentId}`);
		return { componentId, sourceComponentId: correspondence.sourceId, sourceUid: correspondence.sourceUid,
			sourcePartId: correspondence.sourcePartId, sourceSymbol: correspondence.sourceSymbol,
			sourceRotation: correspondence.sourceRotation, sourceIsMirror: correspondence.sourceIsMirror,
			sourceX: correspondence.sourceX, sourceY: correspondence.sourceY, targetUid: correspondence.targetUid,
			attributeId: current.attributeId, key: 'Channel ID', beforeValue: current.value, afterValue };
	});
}

function persistedAlignmentComponentPairing(pairing: any, templateSchematicUuid: string, templatePageUuid: string, templatePcbUuid: string): any {
	return {
		verified: pairing?.verified === true,
		templateSchematicUuid,
		templatePageUuid,
		templatePcbUuid,
		dx: pairing?.dx,
		dy: pairing?.dy,
		pairs: Array.isArray(pairing?.pairs) ? pairing.pairs.map((item: any) => ({ ...item, actualTargetUid: item.targetUid })) : [],
	};
}

function alignmentPairingMatchesTarget(document: any, placementRecord: any, alignmentPairing?: any): boolean {
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(componentIds) || !componentIds.length) return false;
	const legacyPairing = placementRecord.targetPageReadback?.componentPairing;
	const pairs = alignmentPairing?.verified === true ? alignmentPairing.pairs
		: legacyPairing?.verified === true ? legacyPairing.pairs : undefined;
	if (!Array.isArray(pairs) || pairs.length !== componentIds.length) return false;
	let targetComponents: any[];
	try { targetComponents = componentRecordsWithAttributes(document, new Set(componentIds)); }
	catch { return false; }
	if (targetComponents.length !== componentIds.length) return false;
	const targetById = new Map(targetComponents.map((item: any) => [item.id, item]));
	const seenTargets = new Set<string>();
	const sourceToTargetUid = new Map<string, string>();
	const targetToSourceUid = new Map<string, string>();
	for (const pair of pairs) {
		if (!plainObject(pair) || typeof pair.targetId !== 'string' || !componentIds.includes(pair.targetId)
			|| typeof pair.sourceUid !== 'string' || !pair.sourceUid.trim()
			|| typeof pair.targetUid !== 'string' || !pair.targetUid.trim()
			|| (alignmentPairing?.verified === true && pair.actualTargetUid !== pair.targetUid)
			|| seenTargets.has(pair.targetId)) return false;
		seenTargets.add(pair.targetId);
		const actual: any = targetById.get(pair.targetId);
		if (!actual || actual.uniqueId !== pair.targetUid || actual.partId !== pair.targetPartId
			|| actual.symbol !== pair.targetSymbol || actual.rotation !== pair.targetRotation
			|| actual.isMirror !== pair.targetIsMirror || actual.x !== pair.targetX || actual.y !== pair.targetY)
			return false;
		const existingTarget = sourceToTargetUid.get(pair.sourceUid);
		const existingSource = targetToSourceUid.get(pair.targetUid);
		if ((existingTarget && existingTarget !== pair.targetUid) || (existingSource && existingSource !== pair.sourceUid)) return false;
		sourceToTargetUid.set(pair.sourceUid, pair.targetUid);
		targetToSourceUid.set(pair.targetUid, pair.sourceUid);
	}
	return seenTargets.size === componentIds.length;
}

function pcbItems(project: any): any[] {
	const found: any[] = [];
	const visited = new Set<any>();
	const visit = (value: any): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!plainObject(value) || visited.has(value)) return;
		visited.add(value);
		if ((value.itemType === 'PCB' || value.itemType === 'CBB PCB') && typeof value.uuid === 'string' && value.uuid)
			found.push(value);
		for (const child of Object.values(value)) visit(child);
	};
	visit(project?.data);
	return found;
}

function projectPcbName(project: any, pcbUuid: string): string {
	const allMatches = pcbItems(project).filter(pcb => pcb.uuid === pcbUuid);
	if (!allMatches.length)
		fail('工程树中找不到模板 PCB');
	if (allMatches.some(pcb => pcb.parentProjectUuid !== project.uuid))
		fail('工程树中模板 PCB 工程归属不一致');
	const matches = allMatches;
	const names = [...new Set(matches.map(pcb => pcb.name).filter((name: any) => typeof name === 'string' && name.trim()))];
	if (names.length !== 1)
		fail('工程树中模板 PCB 名称缺失或同 UUID 节点名称不一致');
	return names[0];
}

function hasDuplicatePcbName(project: any, templatePcbUuid: string, name: string): boolean {
	return pcbItems(project).some(pcb => pcb.uuid !== templatePcbUuid && pcb.name === name);
}

function unchangedExceptReuseBlockValues(before: any, after: any, updates: any[]): boolean {
	if (before.effective.size !== after.effective.size) return false;
	const updatesById = new Map<string, any>();
	for (const update of updates) {
		if (!update || typeof update.attributeId !== 'string' || updatesById.has(update.attributeId)) return false;
		updatesById.set(update.attributeId, update);
	}
	const seen = new Set<string>();
	for (const [key, beforeRecord] of before.effective.entries()) {
		const afterRecord = after.effective.get(key);
		if (!afterRecord) return false;
		const update = updatesById.get(beforeRecord.header.id);
		if (!update) {
			if (!sameEffectiveRecord(beforeRecord, afterRecord)) return false;
			continue;
		}
		seen.add(update.attributeId);
		if (beforeRecord.header.type !== 'ATTR' || afterRecord.header.type !== 'ATTR'
			|| beforeRecord.data?.parentId !== update.componentId || afterRecord.data?.parentId !== update.componentId
			|| beforeRecord.data?.key !== (update.key ?? 'Reuse Block') || afterRecord.data?.key !== (update.key ?? 'Reuse Block')
			|| beforeRecord.data.value !== update.beforeValue || afterRecord.data.value !== update.afterValue)
			return false;
		const beforeComparable = effectiveRecordForComparison(beforeRecord);
		const afterComparable = effectiveRecordForComparison(afterRecord);
		const { value: _beforeValue, ...beforeData } = beforeComparable.data;
		const { value: _afterValue, ...afterData } = afterComparable.data;
		if (stableStringify(beforeComparable.header) !== stableStringify(afterComparable.header)
			|| stableStringify(beforeData) !== stableStringify(afterData)) return false;
	}
	return seen.size === updatesById.size;
}

function placementAddedWireIds(placementRecord: any): string[] {
	const addedRecords = placementRecord.targetPageReadback?.addedRecords;
	if (!Array.isArray(addedRecords))
		fail('placement 记录缺少新增图元类型及 ID 清单，无法定位本实例导线');
	const wireIds = addedRecords.filter((item: any) => item?.type === 'WIRE').map((item: any) => item.id);
	if (wireIds.some((id: unknown) => typeof id !== 'string' || !id.trim()) || new Set(wireIds).size !== wireIds.length)
		fail('placement 记录中的新增 WIRE ID 缺失或重复');
	return wireIds;
}

function netAttributeRecords(document: any): any[] {
	return [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR' && record.data?.key === 'NET');
}

function buildNetMappingPlan(document: any, placementRecord: any, netMap: NetMapRow[]): { bindings: NetBinding[]; mappedNetworks: any[]; changedWireIds: string[]; allWireIds: string[] } {
	const addedWireIds = placementAddedWireIds(placementRecord);
	const addedWireIdSet = new Set(addedWireIds);
	const effectiveWires = new Map([...document.effective.values()]
		.filter((record: any) => record.header.type === 'WIRE')
		.map((record: any) => [record.header.id, record]));
	for (const wireId of addedWireIds)
		if (!effectiveWires.has(wireId))
			fail(`placement 新增导线在当前源码中缺失：${wireId}`);

	const attrsByWire = new Map<string, any[]>();
	for (const attr of netAttributeRecords(document)) {
		const parentId = attr.data?.parentId;
		if (!addedWireIdSet.has(parentId))
			continue;
		if (typeof attr.header.id !== 'string' || !attr.header.id.trim() || typeof attr.data.value !== 'string')
			fail(`本实例导线的 NET 属性缺少有效 ID 或字符串值：${attr.header.id ?? '<missing>'}`);
		const value = attr.data.value;
		if (!value.trim())
			continue;
		const list = attrsByWire.get(parentId) ?? [];
		list.push(attr);
		attrsByWire.set(parentId, list);
	}
	for (const [wireId, attrs] of attrsByWire) {
		const names = [...new Set(attrs.map(attr => attr.data.value))];
		if (names.length !== 1)
			fail(`新增导线 ${wireId} 绑定了多个不同 NET 名称：${names.join(', ')}`);
	}
	const requiredSources = [...new Set([...attrsByWire.values()].flatMap(attrs => attrs.map(attr => attr.data.value)))];
	const requestedSources = new Set(netMap.map(row => row.sourceNet));
	const requiredSourceSet = new Set(requiredSources);
	const missingSources = requiredSources.filter(name => !requestedSources.has(name));
	const extraSources = netMap.map(row => row.sourceNet).filter(name => !requiredSourceSet.has(name));
	if (missingSources.length || extraSources.length)
		fail(`netMap 与本实例实际命名 NET 来源不一致；实际来源=[${requiredSources.join(', ')}]；缺少映射=[${missingSources.join(', ')}]；多余/未知 sourceNet=[${extraSources.join(', ')}]`);

	const oldNetNames = [...new Set(netAttributeRecords(document)
		.filter((attr: any) => !addedWireIdSet.has(attr.data?.parentId) && typeof attr.data?.value === 'string' && attr.data.value.trim())
		.map((attr: any) => attr.data.value as string))];
	for (const row of netMap.filter(item => item.kind === 'internal')) {
		if (oldNetNames.includes(row.targetNet))
			fail(`internal targetNet ${row.targetNet} 与目标页旧实例或其他命名来源冲突`);
		const otherRows = netMap.filter(item => item.sourceNet !== row.sourceNet);
		const collision = otherRows.find(item => item.targetNet === row.targetNet);
		if (collision)
			fail(`internal targetNet ${row.targetNet} 会与另一来源 ${collision.sourceNet} 合并`);
	}

	const rowBySource = new Map(netMap.map(row => [row.sourceNet, row]));
	const bindings: NetBinding[] = [];
	const mappedNetworks = netMap.map(row => {
		const attrs = [...attrsByWire.values()].flat()
			.filter((attr: any) => attr.data.value === row.sourceNet);
		const wireIds = [...new Set(attrs.map((attr: any) => attr.data.parentId as string))].sort();
		const attributeIds = attrs.map((attr: any) => attr.header.id as string).sort();
		for (const attr of attrs) {
			const wireId = attr.data.parentId as string;
			bindings.push({ ...row, wireId, attributeId: attr.header.id, beforeValue: attr.data.value, afterValue: row.targetNet });
		}
		return { ...row, wireIds, attributeIds };
	});
	if (bindings.some(binding => !rowBySource.has(binding.sourceNet)))
		fail('源码包含未能归属到唯一 netMap 行的 NET 属性');
	const allWireIds = [...new Set(bindings.map(binding => binding.wireId))];
	const changedWireIds = allWireIds.filter(wireId => bindings.some(binding => binding.wireId === wireId && binding.beforeValue !== binding.afterValue));
	return { bindings, mappedNetworks, changedWireIds, allWireIds };
}

function sameRecordsWithMappedNetValues(before: any, after: any, bindings: NetBinding[], targetWireIds: Set<string>, tentativeWireId?: string, allowAnyMappedValue = false): boolean {
	if (before.effective.size !== after.effective.size)
		return false;
	const bindingByAttributeId = new Map(bindings.map(binding => [binding.attributeId, binding]));
	for (const [key, beforeRecord] of before.effective.entries()) {
		const afterRecord = after.effective.get(key);
		if (!afterRecord)
			return false;
		const binding = bindingByAttributeId.get(beforeRecord.header.id);
		if (!binding) {
			if (!sameEffectiveRecord(beforeRecord, afterRecord))
				return false;
			continue;
		}
		if (beforeRecord.header.type !== 'ATTR' || afterRecord.header.type !== 'ATTR'
			|| beforeRecord.data?.parentId !== binding.wireId || afterRecord.data?.parentId !== binding.wireId
			|| beforeRecord.data?.key !== 'NET' || afterRecord.data?.key !== 'NET'
			|| beforeRecord.data.value !== binding.beforeValue)
			return false;
		const afterValue = afterRecord.data.value;
		if (allowAnyMappedValue) {
			if (afterValue !== binding.beforeValue && afterValue !== binding.afterValue)
				return false;
		}
		else if (targetWireIds.has(binding.wireId)) {
			if (afterValue !== binding.afterValue)
				return false;
		}
		else if (binding.wireId === tentativeWireId) {
			if (afterValue !== binding.beforeValue && afterValue !== binding.afterValue)
				return false;
		}
		else if (afterValue !== binding.beforeValue) {
			return false;
		}
		const beforeComparable = effectiveRecordForComparison(beforeRecord);
		const afterComparable = effectiveRecordForComparison(afterRecord);
		const { value: _beforeValue, ...beforeData } = beforeComparable.data;
		const { value: _afterValue, ...afterData } = afterComparable.data;
		if (stableStringify(beforeComparable.header) !== stableStringify(afterComparable.header)
			|| stableStringify(beforeData) !== stableStringify(afterData))
			return false;
	}
	return true;
}

function sameNetMappingIdentity(expected: any, current: any): boolean {
	if (stableStringify(expected.mappedNetworks) !== stableStringify(current.mappedNetworks)
		|| stableStringify(expected.allWireIds) !== stableStringify(current.allWireIds)
		|| expected.bindings.length !== current.bindings.length)
		return false;
	const currentBindings = new Map(current.bindings.map((binding: NetBinding) => [binding.attributeId, binding]));
	return expected.bindings.every((binding: NetBinding) => {
		const actual = currentBindings.get(binding.attributeId) as NetBinding | undefined;
		return Boolean(actual
			&& actual.sourceNet === binding.sourceNet && actual.targetNet === binding.targetNet && actual.kind === binding.kind
			&& actual.wireId === binding.wireId && actual.afterValue === binding.afterValue
			&& (actual.beforeValue === binding.beforeValue || actual.beforeValue === binding.afterValue));
	});
}

function normalizeMappedValuesForPlanning(document: any, bindings: NetBinding[]): any {
	const byAttribute = new Map(bindings.map(binding => [binding.attributeId, binding.beforeValue]));
	const effective = new Map([...document.effective.entries()].map(([key, record]: [string, any]) => {
		if (!byAttribute.has(record.header.id))
			return [key, record];
		return [key, { ...record, data: { ...record.data, value: byAttribute.get(record.header.id) } }];
	}));
	return { ...document, effective };
}

async function readSchWireNets(requiredWireIds: string[]): Promise<Map<string, string>> {
	const wires: ISCH_PrimitiveWire[] = await eda.sch_PrimitiveWire.getAll();
	if (!Array.isArray(wires))
		fail('sch_PrimitiveWire.getAll 返回非法结果');
	const found = new Map<string, string>();
	const required = new Set(requiredWireIds);
	for (const wire of wires) {
		const wireId = wire.getState_PrimitiveId();
		if (!required.has(wireId))
			continue;
		if (found.has(wireId))
			fail(`sch_PrimitiveWire.getAll 返回重复 WIRE ID：${wireId}`);
		const net = wire.getState_Net();
		if (typeof net !== 'string')
			fail(`sch_PrimitiveWire.getState_Net 返回非字符串：${wireId}`);
		found.set(wireId, net);
	}
	return found;
}

async function readSchWireStyle(wireId: string): Promise<{ lineWidth: any; color: any; lineType: any }> {
	const wire = await eda.sch_PrimitiveWire.get(wireId);
	if (!wire || typeof wire.getState_PrimitiveId !== 'function' || wire.getState_PrimitiveId() !== wireId)
		fail(`sch_PrimitiveWire.get 未返回匹配的 WIRE：${wireId}`);
	for (const getter of ['getState_LineWidth', 'getState_Color', 'getState_LineType'])
		if (typeof (wire as any)[getter] !== 'function')
			fail(`sch_PrimitiveWire.get 缺少 ${getter}：${wireId}`);
	const lineWidth = wire.getState_LineWidth();
	const color = wire.getState_Color();
	const lineType = wire.getState_LineType();
	if (lineWidth === undefined || color === undefined || lineType === undefined)
		fail(`sch_PrimitiveWire.get 返回未定义的线型属性：${wireId}`);
	return { lineWidth, color, lineType };
}

function addedPageRecords(before: any, after: any): { addedRecords: any[]; addedComponents: any[]; reuseBlocks: any[] } {
	const addedRecords: any[] = [];
	for (const [key, previous] of before.effective.entries()) {
		const current = after.effective.get(key);
		if (!current || !sameEffectiveRecord(previous, current))
			fail(`原目标图页既有记录丢失或被修改：${key}`);
	}
	for (const [key, record] of after.effective.entries()) {
		const previous = before.effective.get(key);
		if (!previous)
			addedRecords.push(record);
	}
	const componentMap = new Map<string, any>();
	for (const record of addedRecords)
		if (record.header.type === 'COMPONENT')
			componentMap.set(record.header.id, record);
	const attrs = addedRecords.filter(record => record.header.type === 'ATTR' && componentMap.has(record.data?.parentId));
	const valueFor = (componentId: string, key: string): any => attrs.find(record => record.data.parentId === componentId && record.data.key === key)?.data.value;
	const addedComponents = [...componentMap.entries()].map(([componentId, record]) => {
		const attrs = plainObject(record.data?.attrs) ? record.data.attrs : undefined;
		const embeddedUniqueIdPresent = Boolean(attrs && Object.prototype.hasOwnProperty.call(attrs, 'Unique ID'));
		return {
			id: componentId,
			groupId: record.data?.groupId,
			embeddedUniqueIdPresent,
			...(embeddedUniqueIdPresent ? { embeddedUniqueId: attrs?.['Unique ID'] } : {}),
		};
	});
	const reuseBlocks = addedComponents.flatMap(component => {
		const value = valueFor(component.id, 'Reuse Block');
		return typeof value === 'string' && value.trim() ? [{
			componentId: component.id,
			value,
			groupId: valueFor(component.id, 'Group ID') ?? component.groupId,
			channelId: valueFor(component.id, 'Channel ID'),
		}] : [];
	});
	return { addedRecords, addedComponents, reuseBlocks };
}

function componentIdentityData(record: any, attributes: Map<string, any>): any {
	const data = record.data;
	const attrs = { ...(plainObject(data?.attrs) ? data.attrs : {}) };
	for (const [key, value] of attributes.entries())
		attrs[key] = value;
	const uniqueId = attrs['Unique ID'] ?? data?.uniqueId;
	const symbol = data?.symbol ?? attrs.Symbol ?? data?.symbolId;
	if (typeof data?.partId !== 'string' || !data.partId.trim()
		|| typeof symbol !== 'string' || !symbol.trim()
		|| typeof uniqueId !== 'string' || !uniqueId.trim()
		|| typeof data.x !== 'number' || !Number.isFinite(data.x)
		|| typeof data.y !== 'number' || !Number.isFinite(data.y)
		|| typeof data.rotation !== 'number' || !Number.isFinite(data.rotation)
		|| typeof data.isMirror !== 'boolean')
		fail(`组件缺少唯一几何对应所需属性：${record.header.id}`);
	return { id: record.header.id, partId: data.partId, symbol, rotation: data.rotation, isMirror: data.isMirror,
		x: data.x, y: data.y, uniqueId };
}

function isDrawingFrameComponent(record: any, attributes: Map<string, any>): boolean {
	const rawDeviceName = (plainObject(record.data?.attrs) ? record.data.attrs.DeviceName : undefined) ?? attributes.get('DeviceName');
	let deviceName: any = rawDeviceName;
	if (typeof rawDeviceName === 'string') {
		try { deviceName = JSON.parse(rawDeviceName); }
		catch { return false; }
	}
	return typeof deviceName?.name === 'string' && deviceName.name.startsWith('Drawing-Symbol_');
}

function componentRecordsWithAttributes(document: any, allowedIds?: Set<string>): any[] {
	const attrsByComponent = new Map<string, Map<string, any>>();
	for (const record of document.effective.values())
		if (record.header.type === 'ATTR' && typeof record.data?.parentId === 'string' && typeof record.data?.key === 'string') {
			const attrs = attrsByComponent.get(record.data.parentId) ?? new Map<string, any>();
			if (attrs.has(record.data.key)) fail(`组件属性重复：${record.data.parentId}/${record.data.key}`);
			attrs.set(record.data.key, record.data.value);
			attrsByComponent.set(record.data.parentId, attrs);
		}
	const eligible = [...document.effective.values()].filter((record: any) => record.header.type === 'COMPONENT'
		&& (!allowedIds || allowedIds.has(record.header.id))
		&& !isDrawingFrameComponent(record, attrsByComponent.get(record.header.id) ?? new Map())
		&& (allowedIds || (attrsByComponent.get(record.header.id)?.has('Unique ID')
			|| (plainObject(record.data?.attrs) && typeof record.data.attrs['Unique ID'] === 'string' && record.data.attrs['Unique ID'].trim()))));
	return eligible.map((record: any) => componentIdentityData(record, attrsByComponent.get(record.header.id) ?? new Map()));
}

function uniqueTranslatedComponentPairing(sourceComponents: any[], targetDocument: any, addedComponentIds: string[]): any {
	const source = sourceComponents;
	const targetIds = new Set(addedComponentIds);
	let target: any[];
	try { target = componentRecordsWithAttributes(targetDocument, targetIds); }
	catch (error) { return { verified: false, reason: error instanceof Error ? error.message : String(error) }; }
	if (!source.length || source.length !== target.length || target.length !== addedComponentIds.length)
		return { verified: false, reason: '来源组件与本次 placement 新增组件数量不一致' };
	const structuralMatch = (left: any, right: any) => left.partId === right.partId && left.symbol === right.symbol
		&& left.rotation === right.rotation && left.isMirror === right.isMirror;
	const translations = new Map<string, { dx: number; dy: number }>();
	for (const left of source) for (const right of target) if (structuralMatch(left, right)) {
		const dx = right.x - left.x, dy = right.y - left.y;
		translations.set(`${dx}\u0000${dy}`, { dx, dy });
	}
	const solutions: any[] = [];
	for (const translation of translations.values()) {
		const pairs: any[] = [];
		let valid = true;
		for (const left of source) {
			const matches = target.filter((right: any) => structuralMatch(left, right)
				&& right.x - left.x === translation.dx && right.y - left.y === translation.dy);
			if (matches.length !== 1) { valid = false; break; }
			pairs.push({
				sourceId: left.id, sourceUid: left.uniqueId, sourcePartId: left.partId, sourceSymbol: left.symbol,
				sourceRotation: left.rotation, sourceIsMirror: left.isMirror, sourceX: left.x, sourceY: left.y,
				targetId: matches[0].id, targetUid: matches[0].uniqueId, targetPartId: matches[0].partId,
				targetSymbol: matches[0].symbol, targetRotation: matches[0].rotation, targetIsMirror: matches[0].isMirror,
				targetX: matches[0].x, targetY: matches[0].y, dx: translation.dx, dy: translation.dy,
			});
		}
		if (valid && new Set(pairs.map((item: any) => item.targetId)).size === target.length)
			solutions.push({ dx: translation.dx, dy: translation.dy, pairs });
	}
	if (solutions.length > 1)
		fail('来源与 placement 组件几何对应不唯一');
	if (!solutions.length)
		return { verified: false, reason: '来源与 placement 组件几何对应不完整或属性不匹配' };
	return { verified: true, ...solutions[0] };
}

function boardPairKeys(project: any): string[] {
	return boardItems(project).map(board => `${board.schematic?.uuid || ''}\u0000${board.pcb?.uuid || ''}`);
}

function displayBoardPairKey(key: string): string {
	const [schematicUuid, pcbUuid] = key.split('\u0000');
	return `${schematicUuid || '(空)'} / ${pcbUuid || '(空)'}`;
}

function compareBoardPairKeys(expected: unknown, actual: unknown): { matches: boolean; diagnostic?: string } {
	if (!Array.isArray(expected) || !Array.isArray(actual))
		return { matches: false, diagnostic: `键列表无效：预期=${stableStringify(expected)}；实际=${stableStringify(actual)}` };
	const expectedSorted = [...expected].sort();
	const actualSorted = [...actual].sort();
	if (stableStringify(expectedSorted) === stableStringify(actualSorted))
		return { matches: true };
	const counts = (keys: string[]) => keys.reduce((result: Map<string, number>, key) => {
		result.set(key, (result.get(key) || 0) + 1);
		return result;
	}, new Map<string, number>());
	const expectedCounts = counts(expected);
	const actualCounts = counts(actual);
	const allKeys = [...new Map([...expectedCounts.keys(), ...actualCounts.keys()].map(key => [key, key])).keys()].sort();
	const missing = allKeys.flatMap(key => Array.from({ length: Math.max(0, (expectedCounts.get(key) || 0) - (actualCounts.get(key) || 0)) }, () => displayBoardPairKey(key)));
	const added = allKeys.flatMap(key => Array.from({ length: Math.max(0, (actualCounts.get(key) || 0) - (expectedCounts.get(key) || 0)) }, () => displayBoardPairKey(key)));
	const duplicates = (keys: Map<string, number>) => [...keys.entries()].filter(([, count]) => count > 1).map(([key, count]) => `${displayBoardPairKey(key)} ×${count}`);
	const duplicateDetails = [...duplicates(expectedCounts).map(key => `预期 ${key}`), ...duplicates(actualCounts).map(key => `实际 ${key}`)];
	const kind = duplicateDetails.length ? '重复配对' : missing.length && added.length ? '配对身份变化' : missing.length ? '缺失配对' : '新增配对';
	return {
		matches: false,
		diagnostic: `Board ${kind}；预期(${expected.length})=[${expectedSorted.map(displayBoardPairKey).join('; ')}]；实际(${actual.length})=[${actualSorted.map(displayBoardPairKey).join('; ')}]${missing.length ? `；缺失=[${missing.join('; ')}]` : ''}${added.length ? `；新增=[${added.join('; ')}]` : ''}${duplicateDetails.length ? `；重复=[${duplicateDetails.join('; ')}]` : ''}`,
	};
}

function introducedBoards(previousKeys: string[], after: any): any[] {
	const previous = new Set(previousKeys);
	return boardItems(after)
		.filter(board => board.schematic?.uuid && board.pcb?.uuid && !previous.has(`${board.schematic.uuid}\u0000${board.pcb.uuid}`))
		.map(board => ({
			boardName: board.name,
			schematicUuid: board.schematic?.uuid,
			schematicName: board.schematic?.name,
			pageUuids: pageIds(board),
			pcbUuid: board.pcb?.uuid,
			pcbName: board.pcb?.name,
		}));
}

function pageIds(board: any): string[] {
	return Array.isArray(board?.schematic?.page) ? board.schematic.page.map((page: any) => page?.uuid).filter((uuid: any) => typeof uuid === 'string' && uuid) : [];
}

function resolveIntroducedTemplatePage(project: any, board: any, introducedPair: any, placementOperationId: string): { uuid: string; resolution: Record<string, unknown> } {
	const historicalPageUuids = introducedPair?.pageUuids;
	if (!Array.isArray(historicalPageUuids))
		fail('placement introducedBoards 缺少历史模板图页列表');
	if (historicalPageUuids.length > 1)
		fail('placement 历史模板原理图包含多个子页，拒绝推断来源页');
	const pages = board?.schematic?.page;
	if (!Array.isArray(pages) || board.parentProjectUuid !== project.uuid
		|| board.schematic?.parentProjectUuid !== project.uuid || board.pcb?.parentProjectUuid !== project.uuid)
		fail('当前模板 Board、原理图或 PCB 工程归属不一致');
	if (pages.length !== 1 || !plainObject(pages[0]) || pages[0].itemType !== 'Schematic Page'
		|| typeof pages[0].uuid !== 'string' || !pages[0].uuid.trim()
		|| pages[0].parentSchematicUuid !== board.schematic.uuid)
		fail(pages.length > 1 ? '模板 Board 当前图页清单不唯一或含无效页' : '模板 Board 当前图页清单缺少有效子页');
	const currentPage = pages[0];
	if (historicalPageUuids.length === 1) {
		const historicalUuid = historicalPageUuids[0];
		if (typeof historicalUuid !== 'string' || !historicalUuid.trim()
			|| currentPage.uuid !== historicalUuid)
			fail('当前模板图页与 placement 保存的唯一历史图页不一致');
	}
	const matches = boardItems(project).flatMap((candidate: any) => pageIds(candidate).includes(currentPage.uuid) ? [candidate] : []);
	if (matches.length !== 1 || matches[0] !== board)
		fail('模板图页不能唯一归属到所选同工程 Board');
	const mode = historicalPageUuids.length === 1 ? 'historical_unique' : 'resolved_from_empty_history';
	if (historicalPageUuids.length !== 1 && historicalPageUuids.length !== 0)
		fail('placement 历史模板图页列表无效，拒绝推断来源页');
	return { uuid: currentPage.uuid, resolution: {
		mode,
		placementOperationId,
		projectUuid: project.uuid,
		templateSchematicUuid: board.schematic.uuid,
		templatePcbUuid: board.pcb.uuid,
		historicalPageUuids: [...historicalPageUuids],
		currentPages: [{ uuid: currentPage.uuid, parentSchematicUuid: currentPage.parentSchematicUuid }],
		resolvedPageUuid: currentPage.uuid,
	} };
}

function boardSummary(board: any): Record<string, unknown> {
	return {
		boardName: board.name,
		schematicUuid: board.schematic.uuid,
		schematicName: board.schematic.name,
		pageUuids: pageIds(board),
		pcbUuid: board.pcb.uuid,
		pcbName: board.pcb.name,
	};
}

function findPageAndBoard(project: any, pageUuid: string): { board: any; page: any } {
	const matches = boardItems(project).flatMap(board => {
		const page = pageByUuid(board, pageUuid);
		return page ? [{ board, page }] : [];
	});
	if (matches.length !== 1)
		fail(matches.length ? '工程树中存在多个同 UUID 图页，无法唯一确认' : `工程树中找不到图页：${pageUuid}`);
	const { board, page } = matches[0];
	if (board.parentProjectUuid !== project.uuid || board.schematic?.parentProjectUuid !== project.uuid || page.parentSchematicUuid !== board.schematic.uuid)
		fail('目标图页或其 Board 工程归属不一致');
	return { board, page };
}

async function persistNotStarted(record: any, phase: string, error: unknown, targetRestoreAlreadyAttempted = false, expectedContent?: any): Promise<never> {
	let restoreError: string | undefined;
	let effectivePhase = error instanceof TargetRestoreVerificationError ? error.phase : phase;
	let restoreMismatch = false;
	let diagnosticDiff = error instanceof TargetContentMismatchError ? error.targetContentDiff : undefined;
	if (!targetRestoreAlreadyAttempted && typeof record.args?.targetSchematicPageUuid === 'string') {
		try { await restoreTargetAndVerify(record, expectedContent); }
		catch (restoreFailure) {
			restoreError = restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure);
			if (restoreFailure instanceof TargetRestoreVerificationError)
				effectivePhase = restoreFailure.phase;
			if (restoreFailure instanceof TargetContentMismatchError) {
				restoreMismatch = true;
				diagnosticDiff = restoreFailure.targetContentDiff;
			}
		}
	}
	const lostTargetContent = error instanceof TargetContentMismatchError || restoreMismatch;
	if (lostTargetContent) {
		const updated = {
			...record,
			preState: { ...record.preState, targetSnapshot: { ...record.preState?.targetSnapshot, contentVerified: false, contentDiff: diagnosticDiff } },
		};
		return await persistUnknown(updated, 'target_content_lost_after_project_switch', error);
	}
	const updated = {
		...record,
		...(diagnosticDiff ? { preState: { ...record.preState, targetContentDiff: diagnosticDiff } } : {}),
		outcome: 'not_started',
		phase: effectivePhase,
		error: `${error instanceof Error ? error.message : String(error)}${restoreError ? `；恢复阶段=${effectivePhase} 失败：${restoreError}` : ''}`,
	};
	try { await persistRecord(updated); }
	catch (persistError) { updated.error += `；not_started 状态未能持久化：${persistError instanceof Error ? persistError.message : String(persistError)}`; }
	throw new NativePlacementError(updated.error, { partial: false, retryable: false, outcome: 'not_started', operationId: record.operationId, phase: effectivePhase });
}

async function persistUnknown(record: any, phase: string, error: unknown): Promise<never> {
	const updated = {
		...record,
		outcome: 'unknown',
		phase,
		error: error instanceof Error ? error.message : String(error),
	};
	try { await persistRecord(updated); }
	catch (persistError) { updated.error += `；unknown 状态未能持久化：${persistError instanceof Error ? persistError.message : String(persistError)}`; }
	throw new NativePlacementError(updated.error, {
		partial: true,
		retryable: false,
		outcome: 'unknown',
		operationId: record.operationId,
		phase,
	});
}

async function persistPlacementConfirmed(record: any): Promise<Record<string, unknown>> {
	try { await persistRecord(record); }
	catch (error) { return await persistUnknown(record, 'persist_placement_confirmed', error); }
	return operationData(record);
}

async function readCbb(cbbUuid: string, libraryUuid: string): Promise<any> {
	const cbb = await eda.lib_Cbb.get(cbbUuid, libraryUuid);
	if (!plainObject(cbb) || cbb.uuid !== cbbUuid || cbb.libraryUuid !== libraryUuid)
		fail('复用模块 UUID 或 libraryUuid 与请求不一致');
	return cbb;
}

async function restoreTargetAndVerify(record: any, expectedContent?: any): Promise<any> {
	try {
		if (typeof eda.dmt_Project.openProject !== 'function')
			fail('SDK 未提供 dmt_Project.openProject，无法恢复目标工程');
		if (await eda.dmt_Project.openProject(record.targetProjectUuid) !== true)
			fail('恢复目标工程失败');
		const project = await readOpenedProjectWhenEmpty(record.targetProjectUuid, 'target_project_tree_restore');
		const board = boardByPair(project, record.args.targetSchematicPageUuid, record.args.targetPcbUuid);
		const pairComparison = compareBoardPairKeys(record.preState.boardPairKeys, boardPairKeys(project));
		if (board.schematic.uuid !== record.args.targetSchematicUuid
			|| stableStringify(boardSummary(board)) !== stableStringify(record.preState.targetBoard)
			|| !pairComparison.matches)
			fail(`恢复目标工程后 Board 身份或页面列表发生变化${pairComparison.diagnostic ? `；${pairComparison.diagnostic}` : ''}`);
		const content = await openActivateAndRead(record.targetProjectUuid, record.args.targetSchematicPageUuid, 'schematic');
		if (expectedContent && !(record.operation === 'placeSchematicPage'
			? sameTargetSnapshotContent(expectedContent, content)
			: sameEffectiveRecords(expectedContent, content)))
			throw new TargetContentMismatchError(expectedContent, content);
		return content;
	}
	catch (error) {
		if (error instanceof TargetContentMismatchError || error instanceof TargetRestoreVerificationError)
			throw error;
		throw new TargetRestoreVerificationError(error instanceof Error ? error.message : String(error));
	}
}

export async function placeSchematicPage(rawParams: Record<string, any>): Promise<Record<string, unknown>> {
	const args = validatePlaceSchematicPageParams(rawParams);
	const prior = existingRecord(args.operationId, args.targetProjectUuid, args);
	if (prior?.outcome === 'pending-verification') {
		try {
			if (prior.targetPageReadback?.uuid !== args.targetSchematicPageUuid
				|| prior.targetPageReadback?.schematicUuid !== args.targetSchematicUuid
				|| prior.targetPageReadback?.docType !== 'SCH_PAGE'
				|| !Array.isArray(prior.targetPageReadback?.addedComponentIds)
				|| !Array.isArray(prior.targetPageReadback?.reuseBlocks)
				|| !prior.targetPageReadback.reuseBlocks.length
				|| !Array.isArray(prior.introducedBoards))
				fail('旧放置记录缺少可复核的目标页组件证据');
			const project = await readProject(args.targetProjectUuid);
			const board = boardByPair(project, args.targetSchematicPageUuid, args.targetPcbUuid);
			if (board.schematic.uuid !== args.targetSchematicUuid)
				fail('旧放置记录的目标 Board/原理图身份已变化');
			const currentPage = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
			verifyPlacementComponents(currentPage, prior);
			const upgraded = {
				...prior,
				outcome: 'placed',
				phase: 'placement-readback-confirmed',
				placementVerified: true,
				pairAssociationVerified: false,
				error: undefined,
			};
			return await persistPlacementConfirmed(upgraded);
		}
		catch (error) {
			if (error instanceof NativePlacementError)
				throw error;
			throw new NativePlacementError(`旧原生放置记录无法通过当前页读回确认，未重发放置：${error instanceof Error ? error.message : String(error)}`, {
				partial: true,
				retryable: false,
				outcome: 'unknown',
				operationId: args.operationId,
				phase: 'legacy_placement_readback',
			});
		}
	}
	if (prior)
		return operationData(prior);

	const projectBefore = await readProject(args.targetProjectUuid);
	const targetBoardBefore = boardByPair(projectBefore, args.targetSchematicPageUuid, args.targetPcbUuid);
	const preBoardPairKeys = boardPairKeys(projectBefore);
	if (targetBoardBefore.schematic.uuid !== args.targetSchematicUuid)
		fail('targetSchematicUuid 与目标图页所属原理图不一致');
	if (typeof eda.sch_PrimitiveComponent.placeCbbSchematicPage !== 'function') {
		const unsupported: any = { operation: 'placeSchematicPage', operationId: args.operationId, targetProjectUuid: args.targetProjectUuid, args,
			preState: { targetBoard: boardSummary(targetBoardBefore), boardPairKeys: preBoardPairKeys }, outcome: 'not_started' };
		return persistNotStarted(unsupported, 'sdk_capability', 'SDK 未提供 placeCbbSchematicPage');
	}
	let targetBefore = await readCurrentAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
	const targetSnapshot: Record<string, unknown> = {
		projectUuid: args.targetProjectUuid,
		documentUuid: args.targetSchematicPageUuid,
		source: targetBefore.source,
		effectiveRecordCount: targetBefore.recordCount,
		saveAttempted: false,
		saveConfirmed: false,
		saveReadbackConfirmed: false,
		closeAttempted: false,
		closeConfirmed: false,
		reopenConfirmed: false,
		contentVerified: false,
	};
	const preState: any = {
		projectUuid: projectBefore.uuid,
		targetBoard: boardSummary(targetBoardBefore),
		targetPageDocType: targetBefore.parsed.docType,
		targetPageUuid: targetBefore.parsed.uuid,
		targetPageRecordCount: targetBefore.recordCount,
		boardPairKeys: preBoardPairKeys,
		targetSnapshot,
	};
	const record: any = {
		operation: 'placeSchematicPage',
		operationId: args.operationId,
		targetProjectUuid: args.targetProjectUuid,
		args,
		preState,
		inputSignature: stableStringify(args),
		outcome: 'not_started',
		phase: 'target_snapshot_captured',
	};
	try { await persistRecord(record); }
	catch (error) {
		throw new NativePlacementError(`切换来源前无法持久化目标原理图快照：${error instanceof Error ? error.message : String(error)}`, {
			partial: false, retryable: false, outcome: 'not_started', operationId: args.operationId, phase: 'persist_target_snapshot',
		});
	}
	let targetAfterReopen: any;
	let closeApiInvoked = false;
	try {
		if (typeof eda.sch_Document?.save !== 'function')
			fail('SDK 未提供 sch_Document.save，无法保护目标原理图');
		targetSnapshot.saveAttempted = true;
		record.phase = 'target_save_started';
		await persistRecord(record);
		let saveResult: unknown;
		try { saveResult = await eda.sch_Document.save(); }
		catch (error) {
			targetSnapshot.saveError = error instanceof Error ? error.message : String(error);
			return await persistNotStarted(record, 'target_save_failed', error, true);
		}
		targetSnapshot.saveResult = saveResult;
		if (saveResult !== true)
			return await persistNotStarted(record, 'target_save_failed', 'sch_Document.save 未返回 true', true);
		targetSnapshot.saveConfirmed = true;
		record.phase = 'target_save_confirmed';
		await persistRecord(record);
		const savedTargetReadback = await readCurrentAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (!sameTargetSnapshotContent(targetBefore, savedTargetReadback)) {
			targetSnapshot.saveReadbackConfirmed = false;
			targetSnapshot.contentDiff = targetContentDiff(targetBefore, savedTargetReadback);
			return await persistUnknown(record, 'target_save_content_readback', '目标原理图保存后源码读回与完整快照不一致');
		}
		targetSnapshot.saveReadbackConfirmed = true;
		const activeTargetDocument = await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (typeof activeTargetDocument.tabId !== 'string' || !activeTargetDocument.tabId.trim())
			fail('当前目标原理图文档缺少有效 tabId，无法安全关闭');
		if (typeof eda.dmt_EditorControl?.closeDocument !== 'function')
			return await persistNotStarted(record, 'target_close_capability', 'SDK 未提供 closeDocument', true);
		targetSnapshot.closeAttempted = true;
		record.phase = 'target_document_close_started';
		await persistRecord(record);
		let closeResult: unknown;
		closeApiInvoked = true;
		try { closeResult = await eda.dmt_EditorControl.closeDocument(activeTargetDocument.tabId); }
		catch (error) {
			return await persistUnknown(record, 'target_document_close', error);
		}
		if (closeResult !== true)
			return await persistUnknown(record, 'target_document_close', 'closeDocument 未返回 true，文档关闭状态不确定');
		targetSnapshot.closeConfirmed = true;
		record.phase = 'target_document_closed';
		try { await persistRecord(record); }
		catch (error) { return await persistUnknown(record, 'persist_target_document_closed', error); }
		try { targetAfterReopen = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic'); }
		catch (error) { return await persistUnknown(record, 'target_reopen_readback', error); }
		if (!sameTargetSnapshotContent(targetBefore, targetAfterReopen)) {
			targetSnapshot.reopenConfirmed = true;
			targetSnapshot.contentVerified = false;
			targetSnapshot.contentDiff = targetContentDiff(targetBefore, targetAfterReopen);
			return await persistUnknown(record, 'target_reopen_content_readback', '目标页关闭重开后内容未保持');
		}
		targetSnapshot.reopenConfirmed = true;
		targetSnapshot.contentVerified = true;
		targetSnapshot.reopenedEffectiveRecordCount = targetAfterReopen.recordCount;
		record.phase = 'target_save_reopen_confirmed';
		await persistRecord(record);
		targetBefore = targetAfterReopen;
	}
	catch (error) {
		if (error instanceof NativePlacementError)
			throw error;
		if (closeApiInvoked)
			return await persistUnknown(record, 'target_close_reopen_guard', error);
		return await persistNotStarted(record, record.phase || 'target_persistence_guard', error, true);
	}
	let sourcePage: Record<string, any>;
	let initialTargetRestoreAttempted = false;
	try {
		sourcePage = await resolveCbbSourcePage(args);
		initialTargetRestoreAttempted = true;
		targetBefore = await restoreTargetAndVerify(record, targetAfterReopen);
	}
	catch (error) {
		return persistNotStarted(record, 'source_child_page_resolution', error, initialTargetRestoreAttempted, targetAfterReopen);
	}
	Object.assign(preState, {
		sourceBoardName: sourcePage.sourceBoard.name,
		sourceProjectUuid: sourcePage.sourceProjectUuid,
		sourceChildPageUuid: sourcePage.childPageUuid,
		sourceComponents: sourcePage.sourceComponents,
	});
	record.phase = 'target_and_source_preflight_confirmed';
	try { await persistRecord(record); }
	catch (error) {
		return persistNotStarted(record, 'persist_preflight', error, true, targetAfterReopen);
	}

	record.outcome = 'unknown';
	record.phase = 'write_started';
	try { await persistRecord(record); }
	catch (error) {
		throw new NativePlacementError(`原生放置前无法持久化 write_started：${error instanceof Error ? error.message : String(error)}`, {
			partial: false, retryable: false, outcome: 'not_started', operationId: args.operationId, phase: 'persist_write_started',
		});
	}
	let sdkStarted = false;
	let targetRestoreAttempted = false;
	try {
		const projectRecheck = await readProject(args.targetProjectUuid);
		const targetBoardRecheck = boardByPair(projectRecheck, args.targetSchematicPageUuid, args.targetPcbUuid);
		if (stableStringify(boardSummary(targetBoardRecheck)) !== stableStringify(preState.targetBoard)
			|| !compareBoardPairKeys(preBoardPairKeys, boardPairKeys(projectRecheck)).matches)
			fail('持久化 write_started 后目标 Board 身份或页面列表发生变化');
		if (targetBoardRecheck.schematic.uuid !== args.targetSchematicUuid)
			fail('持久化 write_started 后目标原理图身份发生变化');
		const targetContentRecheck = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (!sameTargetSnapshotContent(targetBefore, targetContentRecheck))
			throw new TargetContentMismatchError(targetBefore, targetContentRecheck);
		const sourceRecheck = await resolveCbbSourcePage(args);
		if (stableStringify(sourceRecheck) !== stableStringify(sourcePage))
			fail('持久化 write_started 后 CBB 来源配对或子页身份发生变化');
		targetRestoreAttempted = true;
		await restoreTargetAndVerify(record, targetBefore);
		if (typeof eda.sch_PrimitiveComponent.placeCbbSchematicPage !== 'function')
			return persistNotStarted(record, 'sdk_capability_recheck', 'SDK 未提供 placeCbbSchematicPage', true);

		sdkStarted = true;
		let sdkResult: unknown;
		try {
			sdkResult = await eda.sch_PrimitiveComponent.placeCbbSchematicPage(
				{ libraryUuid: args.libraryUuid, cbbUuid: args.cbbUuid, uuid: sourcePage.childPageUuid },
				args.x,
				args.y,
				{ reimportWhenNameRepeated: args.reimportWhenNameRepeated },
			);
		}
		catch (error) {
			record.sdkResult = undefined;
			return await persistUnknown(record, 'sdk_place', error);
		}
		record.sdkResult = sdkResult;
		record.phase = 'sdk_place_returned';
		if (sdkResult !== true)
			return await persistUnknown(record, 'sdk_result', 'SDK 放置未返回 true，结果状态不确定');

		let targetContentAfter: any;
		let projectAfter: any;
		let pageDiff: { addedRecords: any[]; addedComponents: any[]; reuseBlocks: any[] } | undefined;
		let complete = false;
		const readbackStartedAt = Date.now();
		for (let attempt = 0; attempt <= PLACEMENT_READBACK_MAX_POLLS; attempt++) {
			if (attempt > 0 && Date.now() - readbackStartedAt >= PLACEMENT_READBACK_BUDGET_MS)
				break;
			projectAfter = await readProject(args.targetProjectUuid);
			const targetBoardAfter = boardByPair(projectAfter, args.targetSchematicPageUuid, args.targetPcbUuid);
			if (targetBoardAfter.schematic.uuid !== args.targetSchematicUuid
				|| stableStringify(boardSummary(targetBoardAfter)) !== stableStringify(preState.targetBoard))
				return await persistUnknown(record, 'target_identity_readback', '放置后目标 Board 或原理图身份发生变化');
			targetContentAfter = await readCurrentAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
			pageDiff = addedPageRecords(targetBefore, targetContentAfter);
			if (pageDiff.addedComponents.length > 0 && pageDiff.reuseBlocks.length === pageDiff.addedComponents.length) {
				complete = true;
				break;
			}
			const elapsedMs = Date.now() - readbackStartedAt;
			if (attempt >= PLACEMENT_READBACK_MAX_POLLS || elapsedMs >= PLACEMENT_READBACK_BUDGET_MS)
				break;
			await new Promise<void>(resolve => setTimeout(
				resolve,
				Math.min(PLACEMENT_READBACK_POLL_INTERVAL_MS, PLACEMENT_READBACK_BUDGET_MS - elapsedMs),
			));
		}
		if (!complete || !pageDiff)
			return await persistUnknown(record, 'target_page_content_readback', '新增组件及 Reuse Block 在观察限额内未读齐');
		const componentPairing = uniqueTranslatedComponentPairing(sourcePage.sourceComponents, targetContentAfter, pageDiff.addedComponents.map((item: any) => item.id));
		const reuseBlockNames = [...new Set(pageDiff.reuseBlocks.map((value: any) => value.value))];
		if (reuseBlockNames.length !== 1)
			return await persistUnknown(record, 'target_page_reuse_block_readback', '新增组件的 Reuse Block 值不唯一');
		const newBoards = introducedBoards(preBoardPairKeys, projectAfter);
		record.outcome = 'placed';
		record.phase = 'placement-readback-confirmed';
		record.placementVerified = true;
		record.pairAssociationVerified = false;
		record.targetPageReadback = {
			uuid: targetContentAfter.parsed.uuid,
			schematicUuid: args.targetSchematicUuid,
			docType: targetContentAfter.parsed.docType,
			recordCount: targetContentAfter.recordCount,
			addedRecordIds: pageDiff.addedRecords.map((item: any) => item.header.id),
			addedRecords: pageDiff.addedRecords.map((item: any) => ({ type: item.header.type, id: item.header.id })),
			addedComponentIds: pageDiff.addedComponents.map((item: any) => item.id),
			addedComponents: pageDiff.addedComponents,
			reuseBlocks: pageDiff.reuseBlocks,
			componentPairing,
		};
		record.introducedBoards = newBoards;
		return await persistPlacementConfirmed(record);
	}
	catch (error) {
		if (error instanceof NativePlacementError)
			throw error;
		if (sdkStarted)
			return await persistUnknown(record, record.phase || 'post_sdk_readback', error);
		return await persistNotStarted(record, 'guard_before_sdk', error, targetRestoreAttempted, targetBefore);
	}
}

function boardBySchematicAndPcb(project: any, schematicUuid: string, pcbUuid: string): any {
	const matches = boardItems(project).filter(board => board.schematic?.uuid === schematicUuid && board.pcb?.uuid === pcbUuid);
	if (matches.length !== 1)
		fail(matches.length === 0 ? '指定父原理图与 PCB 未在工程树中证明属于同一 Board' : '工程树中存在多个匹配父原理图与 PCB 的 Board');
	const board = matches[0];
	if (board.parentProjectUuid !== project.uuid || board.schematic?.parentProjectUuid !== project.uuid || board.pcb?.parentProjectUuid !== project.uuid)
		fail('模板 Board、原理图或 PCB 的工程归属不一致');
	return board;
}

function locateTemplatePair(project: any, schematicUuid: string, pcbUuid: string): { board: any } {
	return { board: boardBySchematicAndPcb(project, schematicUuid, pcbUuid) };
}

function referencedPlacementRecord(operationId: string, targetProjectUuid: string, targetPageUuid: string): any {
	const record = ownValue(readStoredState().operations, operationId);
	if (!record || record.operation !== 'placeSchematicPage' || record.targetProjectUuid !== targetProjectUuid)
		fail('placementOperationId 未指向当前目标工程的原生放置操作');
	if ((record.outcome !== 'placed' && record.outcome !== 'pending-verification')
		|| (record.outcome === 'placed' && record.placementVerified !== true)
		|| record.args?.targetSchematicPageUuid !== targetPageUuid)
		fail('引用的放置操作没有可用的目标页读回证据，或与指定目标主图页不同');
	if (record.targetPageReadback?.uuid !== targetPageUuid
		|| record.targetPageReadback?.schematicUuid !== record.args?.targetSchematicUuid
		|| record.targetPageReadback?.docType !== 'SCH_PAGE')
		fail('引用的放置操作目标页身份读回不一致');
	const reuseBlocks = record.targetPageReadback?.reuseBlocks;
	if (!Array.isArray(reuseBlocks) || !reuseBlocks.length || reuseBlocks.some((item: any) => !plainObject(item) || typeof item.value !== 'string' || !item.value.trim()))
		fail('引用的放置操作未保存有效 Reuse Block 读回');
	const addedComponentIds = record.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(addedComponentIds) || new Set(addedComponentIds).size !== addedComponentIds.length
		|| reuseBlocks.some((item: any) => !addedComponentIds.includes(item.componentId))
		|| addedComponentIds.length !== reuseBlocks.length)
		fail('引用的放置操作新增组件 ID 与 Reuse Block 读回不一致');
	const names = [...new Set(reuseBlocks.map((item: any) => item.value))];
	if (names.length !== 1)
		fail('引用的放置操作新增组件包含多个 Reuse Block 名称');
	if (!Array.isArray(record.introducedBoards))
		fail('引用的放置操作缺少 introducedBoards 读回');
	return { record, reuseBlock: names[0] };
}

function verifyPlacementComponents(document: any, placementRecord: any, acceptedReuseBlockValues?: string[]): void {
	const expected = placementRecord.targetPageReadback?.reuseBlocks;
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(expected) || !expected.length || !Array.isArray(componentIds)
		|| new Set(componentIds).size !== componentIds.length || componentIds.length !== expected.length
		|| expected.some((item: any) => !plainObject(item) || typeof item.componentId !== 'string' || !item.componentId || !componentIds.includes(item.componentId))
		|| new Set(expected.map((item: any) => item.componentId)).size !== expected.length)
		fail('引用的放置操作缺少 Reuse Block 组件记录');
	const actual = componentReuseBlocks(document);
	for (const item of expected) {
		const match = actual.find((value: any) => value.componentId === item.componentId);
		if (!match || (acceptedReuseBlockValues && !acceptedReuseBlockValues.includes(match.value))
			|| (acceptedReuseBlockValues
				? match.groupId !== item.groupId
				: stableStringify(match) !== stableStringify(item)))
			fail(`引用放置操作中的 Reuse Block 组件读回已变化：${item.componentId}`);
	}
}

function placementWithChannelUpdates(placementRecord: any, updates: any[]): any {
	const channelByComponent = new Map(updates.map((item: any) => [item.componentId, item.afterValue]));
	return {
		...placementRecord,
		targetPageReadback: {
			...placementRecord.targetPageReadback,
			reuseBlocks: placementRecord.targetPageReadback.reuseBlocks.map((item: any) => ({
				...item, channelId: channelByComponent.get(item.componentId) ?? item.channelId,
			})),
		},
	};
}

type PlacementReferenceSnapshot = {
	placementRecord: any;
	alignmentSnapshot?: any;
	originalReference: boolean;
	actualAttributes: any[];
};

function alignmentSnapshot(record: any): any {
	return {
		operationId: record.operationId,
		operation: record.operation,
		targetProjectUuid: record.targetProjectUuid,
		args: record.args,
		outcome: record.outcome,
		contentsVerified: record.contentsVerified,
		confirmedIDs: record.confirmedIDs,
		pendingIDs: record.pendingIDs,
		affectedIDs: record.affectedIDs,
		channelBeforeAfter: record.channelBeforeAfter,
		channelConfirmedIDs: record.channelConfirmedIDs,
		channelPendingIDs: record.channelPendingIDs,
		alignmentComponentPairing: record.alignmentComponentPairing,
	};
}

function validatedAlignmentSnapshot(candidate: any, placementRecord: any, targetProjectUuid: string, targetPageUuid: string): any | undefined {
	if (!plainObject(candidate) || candidate.operation !== 'alignTemplatePcb'
		|| typeof candidate.operationId !== 'string' || !candidate.operationId.trim()
		|| candidate.targetProjectUuid !== targetProjectUuid || candidate.args?.targetProjectUuid !== targetProjectUuid
		|| candidate.args?.targetSchematicPageUuid !== targetPageUuid
		|| candidate.args?.placementOperationId !== placementRecord.operationId
		|| candidate.outcome !== 'reference-aligned' || candidate.contentsVerified !== true
		|| !Array.isArray(candidate.pendingIDs) || candidate.pendingIDs.length !== 0
		|| !Array.isArray(candidate.confirmedIDs) || !Array.isArray(candidate.affectedIDs)
		|| !Array.isArray(candidate.channelBeforeAfter) || !Array.isArray(candidate.channelConfirmedIDs)
		|| !Array.isArray(candidate.channelPendingIDs) || candidate.channelPendingIDs.length !== 0)
		return undefined;
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(componentIds) || !componentIds.length || candidate.affectedIDs.length !== componentIds.length)
		return undefined;
	const affectedByComponent = new Map<string, any>();
	const affectedAttributeIds = new Set<string>();
	const affectedValues = new Set<string>();
	for (const item of candidate.affectedIDs) {
		if (!plainObject(item) || typeof item.componentId !== 'string' || typeof item.attributeId !== 'string'
			|| !item.attributeId.trim() || typeof item.beforeValue !== 'string' || typeof item.afterValue !== 'string'
			|| !item.afterValue.trim() || !componentIds.includes(item.componentId)
			|| affectedByComponent.has(item.componentId) || affectedAttributeIds.has(item.attributeId))
			return undefined;
		affectedByComponent.set(item.componentId, item);
		affectedAttributeIds.add(item.attributeId);
		affectedValues.add(item.afterValue);
	}
	if (affectedByComponent.size !== componentIds.length || affectedValues.size !== 1
		|| candidate.confirmedIDs.length !== affectedAttributeIds.size
		|| new Set(candidate.confirmedIDs).size !== candidate.confirmedIDs.length
		|| candidate.confirmedIDs.some((id: any) => !affectedAttributeIds.has(id)))
		return undefined;
	if (candidate.channelBeforeAfter.length !== componentIds.length) return undefined;
	const channelByComponent = new Map<string, any>();
	const channelAttributeIds = new Set<string>();
	for (const item of candidate.channelBeforeAfter) {
		if (!plainObject(item) || typeof item.componentId !== 'string' || !componentIds.includes(item.componentId)
			|| (item.sourceUid !== undefined && (typeof item.sourceUid !== 'string' || !item.sourceUid.trim()))
			|| (item.targetUid !== undefined && (typeof item.targetUid !== 'string' || !item.targetUid.trim()))
			|| ((item.sourceUid === undefined) !== (item.targetUid === undefined))
			|| typeof item.attributeId !== 'string' || !item.attributeId.trim()
			|| typeof item.beforeValue !== 'string' || typeof item.afterValue !== 'string'
			|| channelByComponent.has(item.componentId) || channelAttributeIds.has(item.attributeId)) return undefined;
		channelByComponent.set(item.componentId, item);
		channelAttributeIds.add(item.attributeId);
	}
	if (channelByComponent.size !== componentIds.length
		|| candidate.channelConfirmedIDs.length !== channelAttributeIds.size
		|| new Set(candidate.channelConfirmedIDs).size !== candidate.channelConfirmedIDs.length
		|| candidate.channelConfirmedIDs.some((id: any) => !channelAttributeIds.has(id))) return undefined;
	const alignmentPairing = candidate.alignmentComponentPairing;
	if (alignmentPairing !== undefined) {
		const introducedPair = placementRecord.introducedBoards?.find((board: any) =>
			board.schematicUuid === candidate.args?.templateSchematicUuid && board.pcbUuid === candidate.args?.templatePcbUuid);
		const pageResolution = candidate.templatePageResolution;
		const resolvedPage = pageResolution?.currentPages?.[0];
		const expectedResolutionMode = introducedPair?.pageUuids?.length === 0 ? 'resolved_from_empty_history' : 'historical_unique';
		const hasCurrentPageResolution = plainObject(pageResolution)
			&& pageResolution.mode === expectedResolutionMode
			&& pageResolution.placementOperationId === placementRecord.operationId
			&& pageResolution.projectUuid === targetProjectUuid
			&& pageResolution.templateSchematicUuid === candidate.args?.templateSchematicUuid
			&& pageResolution.templatePcbUuid === candidate.args?.templatePcbUuid
			&& Array.isArray(pageResolution.historicalPageUuids)
			&& stableStringify(pageResolution.historicalPageUuids) === stableStringify(introducedPair?.pageUuids)
			&& Array.isArray(pageResolution.currentPages) && pageResolution.currentPages.length === 1
			&& plainObject(resolvedPage) && typeof resolvedPage.uuid === 'string' && !!resolvedPage.uuid.trim()
			&& resolvedPage.parentSchematicUuid === candidate.args?.templateSchematicUuid
			&& pageResolution.resolvedPageUuid === resolvedPage.uuid
			&& candidate.preState?.templatePageUuid === resolvedPage.uuid
			&& candidate.preState?.templateBoard?.schematicUuid === candidate.args?.templateSchematicUuid
			&& candidate.preState?.templateBoard?.pcbUuid === candidate.args?.templatePcbUuid
			&& stableStringify(candidate.preState?.templateBoard?.pageUuids) === stableStringify([resolvedPage.uuid]);
		if (!plainObject(alignmentPairing) || alignmentPairing.verified !== true
			|| alignmentPairing.templateSchematicUuid !== candidate.args?.templateSchematicUuid
			|| alignmentPairing.templatePcbUuid !== candidate.args?.templatePcbUuid
			|| !introducedPair || !Array.isArray(introducedPair.pageUuids)
			|| (introducedPair.pageUuids.length !== 1 && introducedPair.pageUuids.length !== 0)
			|| (introducedPair.pageUuids.length === 1 && alignmentPairing.templatePageUuid !== introducedPair.pageUuids[0])
			|| (introducedPair.pageUuids.length === 0 && !hasCurrentPageResolution)
			|| (pageResolution !== undefined && !hasCurrentPageResolution)
			|| (pageResolution === undefined && introducedPair.pageUuids.length !== 1)
			|| (hasCurrentPageResolution && alignmentPairing.templatePageUuid !== resolvedPage.uuid)
			|| typeof alignmentPairing.dx !== 'number' || !Number.isFinite(alignmentPairing.dx)
			|| typeof alignmentPairing.dy !== 'number' || !Number.isFinite(alignmentPairing.dy)
			|| !Array.isArray(alignmentPairing.pairs) || alignmentPairing.pairs.length !== componentIds.length)
			return undefined;
		const targetById = new Map<string, any>();
		const sourceIds = new Set<string>();
		const sourceToTargetUid = new Map<string, string>();
		const targetToSourceUid = new Map<string, string>();
		for (const pair of alignmentPairing.pairs) {
			if (!plainObject(pair) || typeof pair.sourceId !== 'string' || !pair.sourceId.trim()
				|| typeof pair.sourceUid !== 'string' || !pair.sourceUid.trim()
				|| typeof pair.sourcePartId !== 'string' || !pair.sourcePartId.trim()
				|| typeof pair.sourceSymbol !== 'string' || !pair.sourceSymbol.trim()
				|| typeof pair.sourceRotation !== 'number' || !Number.isFinite(pair.sourceRotation)
				|| typeof pair.sourceIsMirror !== 'boolean' || typeof pair.sourceX !== 'number' || !Number.isFinite(pair.sourceX)
				|| typeof pair.sourceY !== 'number' || !Number.isFinite(pair.sourceY)
				|| typeof pair.targetId !== 'string' || !componentIds.includes(pair.targetId)
				|| typeof pair.actualTargetUid !== 'string' || !pair.actualTargetUid.trim() || pair.targetUid !== pair.actualTargetUid
				|| typeof pair.targetPartId !== 'string' || !pair.targetPartId.trim()
				|| typeof pair.targetSymbol !== 'string' || !pair.targetSymbol.trim()
				|| typeof pair.targetRotation !== 'number' || !Number.isFinite(pair.targetRotation)
				|| typeof pair.targetIsMirror !== 'boolean' || typeof pair.targetX !== 'number' || !Number.isFinite(pair.targetX)
				|| typeof pair.targetY !== 'number' || !Number.isFinite(pair.targetY)
				|| pair.sourcePartId !== pair.targetPartId || pair.sourceSymbol !== pair.targetSymbol
				|| pair.sourceRotation !== pair.targetRotation || pair.sourceIsMirror !== pair.targetIsMirror
				|| pair.targetX - pair.sourceX !== alignmentPairing.dx || pair.targetY - pair.sourceY !== alignmentPairing.dy
				|| targetById.has(pair.targetId) || sourceIds.has(pair.sourceId)) return undefined;
			targetById.set(pair.targetId, pair);
			sourceIds.add(pair.sourceId);
			const targetUid = sourceToTargetUid.get(pair.sourceUid), sourceUid = targetToSourceUid.get(pair.actualTargetUid);
			if ((targetUid && targetUid !== pair.actualTargetUid) || (sourceUid && sourceUid !== pair.sourceUid)) return undefined;
			sourceToTargetUid.set(pair.sourceUid, pair.actualTargetUid);
			targetToSourceUid.set(pair.actualTargetUid, pair.sourceUid);
		}
		if (targetById.size !== componentIds.length || componentIds.some((id: string) => !targetById.has(id))) return undefined;
		for (const [componentId, pair] of targetById) {
			const channel = channelByComponent.get(componentId);
			if (!channel || channel.sourceComponentId !== pair.sourceId || channel.sourceUid !== pair.sourceUid
				|| channel.targetUid !== pair.actualTargetUid) return undefined;
		}
	}
	else if (placementRecord.targetPageReadback?.componentPairing?.verified !== true) return undefined;
	return alignmentSnapshot(candidate);
}

function pcbIdentityRecord(operationId: string, targetProjectUuid: string): any {
	const record = ownValue(readStoredState().operations, operationId);
	if (!plainObject(record) || record.operation !== 'preparePcbInstanceIdentities'
		|| record.operationId !== operationId || record.targetProjectUuid !== targetProjectUuid
		|| record.outcome !== 'confirmed' || record.contentsVerified !== true
		|| record.phase !== 'identity-readback-confirmed')
		fail('identityOperationId 未指向完整确认的 PCB 身份导出记录');
	if (typeof record.netlistText !== 'string' || typeof record.netlistSha256 !== 'string'
		|| !Array.isArray(record.afterPages) || !record.afterPages.length || !Array.isArray(record.instances)
		|| !plainObject(record.preState) || !Array.isArray(record.preState.pageUuids) || !record.preState.pageUuids.length)
		fail('PCB 身份确认记录缺少完整网表或父 SCH 读回快照');
	return record;
}

function confirmedPlacementNetMappings(placementOperationId: string, targetProjectUuid: string, targetPageUuid: string, placementRecord: any, targetDocument: any): {
	netMappings: Array<{ sourceNet: string; targetNet: string }>;
	netMappingEvidence: Record<string, unknown>;
} {
	const state = readStoredState();
	const mapRecords = Object.values(state.operations).filter((item: any) => item?.operation === 'mapInstanceNets'
		&& item.args?.placementOperationId === placementOperationId);
	if (!mapRecords.length)
		return { netMappings: [], netMappingEvidence: {
			status: 'template-net-retained', verifiedNoMapRecords: true, pendingOrUnknownRecords: [], mapOperationIds: [],
		} };
	if (mapRecords.some((item: any) => item.targetProjectUuid !== targetProjectUuid
		|| item.args?.targetProjectUuid !== targetProjectUuid || item.args?.targetSchematicPageUuid !== targetPageUuid))
		fail(`placement ${placementOperationId} 存在目标工程或图页不匹配的网名映射记录`);
	const safeNotStartedPhases = new Set(['preflight', 'sdk_capability', 'wire_style_unavailable', 'already_mapped_readback', 'wire_binding_missing', 'wire_mapping_ambiguous']);
	const legacyNoSetterPhases = new Set(['sdk_capability', 'wire_style_unavailable', 'already_mapped_readback']);
	const ignoredNotStarted = mapRecords.filter((item: any) => item.outcome === 'not_started'
		&& safeNotStartedPhases.has(item.phase)
		&& (item.setterInvoked === false || (item.setterInvoked === undefined && legacyNoSetterPhases.has(item.phase))));
	const completed = mapRecords.filter((item: any) => item.outcome === 'mapped' && item.contentsVerified === true
		&& item.geometryUnchanged === true && item.namedSourcesMapped === true && Array.isArray(item.pendingIDs) && item.pendingIDs.length === 0);
	const unresolved = mapRecords.filter((item: any) => !ignoredNotStarted.includes(item) && !completed.includes(item));
	if (unresolved.length)
		fail(`placement ${placementOperationId} 存在未确认或未知的网名映射记录：${unresolved.map((item: any) => `${item.operationId}(${item.outcome}/${item.phase})`).join(', ')}`);
	if (!completed.length)
		return { netMappings: [], netMappingEvidence: {
			status: 'template-net-retained', verifiedNoMapRecords: false, verifiedNoEffectiveMappings: true,
			pendingOrUnknownRecords: [], mapOperationIds: [], ignoredNotStartedOperationIds: ignoredNotStarted.map((item: any) => item.operationId),
		} };
	if (completed.length > 1 && completed.some((item: any) => !Number.isSafeInteger(item.startedAt)))
		fail(`placement ${placementOperationId} 的多条网名映射记录缺少可验证时间顺序`);
	const orderedMapRecords: any[] = completed.length > 1
		? [...completed].sort((left: any, right: any) => left.startedAt - right.startedAt) : completed;
	if (orderedMapRecords.length > 1 && orderedMapRecords.some((item: any, index: number) => index > 0 && item.startedAt === orderedMapRecords[index - 1].startedAt))
		fail(`placement ${placementOperationId} 的网名映射记录顺序存在时间戳冲突`);
	const latest: any = orderedMapRecords[orderedMapRecords.length - 1];
	if (!Array.isArray(latest.netMap) || !latest.netMap.length || !Array.isArray(latest.bindings) || !latest.bindings.length
		|| !Array.isArray(latest.mappedNetworks))
		fail(`最新网名映射记录 ${latest.operationId} 缺少 netMap 或 WIRE/NET bindings`);
	const rows = new Map<string, { sourceNet: string; targetNet: string }>();
	for (const row of latest.netMap) {
		if (!plainObject(row) || typeof row.sourceNet !== 'string' || !row.sourceNet.trim()
			|| typeof row.targetNet !== 'string' || !row.targetNet.trim() || rows.has(row.sourceNet))
			fail(`最新网名映射记录 ${latest.operationId} 的 netMap 无效或重复`);
		rows.set(row.sourceNet, { sourceNet: row.sourceNet, targetNet: row.targetNet });
	}
	const addedWireIds = new Set(placementAddedWireIds(placementRecord));
	const seenAttributes = new Set<string>();
	const seenWires = new Set<string>();
	for (const binding of latest.bindings) {
		if (!plainObject(binding) || typeof binding.sourceNet !== 'string' || typeof binding.targetNet !== 'string'
			|| typeof binding.wireId !== 'string' || typeof binding.attributeId !== 'string'
			|| binding.beforeValue !== binding.sourceNet || binding.afterValue !== binding.targetNet
			|| !addedWireIds.has(binding.wireId) || seenAttributes.has(binding.attributeId))
			fail(`最新网名映射记录 ${latest.operationId} 的 WIRE/NET binding 无效或不属于该 placement`);
		const row = rows.get(binding.sourceNet);
		const attribute = targetDocument.effective.get(`ATTR\u0000${binding.attributeId}`);
		if (!row || row.targetNet !== binding.targetNet || !attribute || attribute.data?.parentId !== binding.wireId
			|| attribute.data?.key !== 'NET' || attribute.data?.value !== binding.afterValue)
			fail(`最新网名映射记录 ${latest.operationId} 的当前源码 NET binding 未能读回：${binding.attributeId}`);
		seenAttributes.add(binding.attributeId);
		seenWires.add(binding.wireId);
	}
	const expectedMappedWireIds = new Set<string>();
	const expectedMappedAttributeIds = new Set<string>();
	const mappedSources = new Set<string>();
	for (const network of latest.mappedNetworks) {
		if (!plainObject(network) || typeof network.sourceNet !== 'string' || typeof network.targetNet !== 'string'
			|| rows.get(network.sourceNet)?.targetNet !== network.targetNet || !Array.isArray(network.wireIds)
			|| !Array.isArray(network.attributeIds)
			|| mappedSources.has(network.sourceNet))
			fail(`最新网名映射记录 ${latest.operationId} 的 mappedNetworks 与 netMap 不一致`);
		mappedSources.add(network.sourceNet);
		for (const attributeId of network.attributeIds) {
			if (typeof attributeId !== 'string' || !attributeId.trim() || expectedMappedAttributeIds.has(attributeId))
				fail(`最新网名映射记录 ${latest.operationId} 的 mappedNetworks ATTR 清单无效`);
			expectedMappedAttributeIds.add(attributeId);
		}
		for (const wireId of network.wireIds) {
			if (typeof wireId !== 'string' || !addedWireIds.has(wireId) || expectedMappedWireIds.has(wireId))
				fail(`最新网名映射记录 ${latest.operationId} 的 mappedNetworks WIRE 清单无效`);
			expectedMappedWireIds.add(wireId);
		}
	}
	if (mappedSources.size !== rows.size || [...rows.keys()].some(sourceNet => !mappedSources.has(sourceNet))
		|| expectedMappedWireIds.size !== seenWires.size || [...expectedMappedWireIds].some(wireId => !seenWires.has(wireId))
		|| expectedMappedAttributeIds.size !== seenAttributes.size || [...expectedMappedAttributeIds].some(attributeId => !seenAttributes.has(attributeId)))
		fail(`最新网名映射记录 ${latest.operationId} 的 bindings 未覆盖已确认 mappedNetworks`);
	return { netMappings: [...rows.values()], netMappingEvidence: {
		status: 'mapped', mapOperationId: latest.operationId, verifiedNoMapRecords: false,
		pendingOrUnknownRecords: [], mapOperationIds: orderedMapRecords.map((item: any) => item.operationId),
		ignoredNotStartedOperationIds: ignoredNotStarted.map((item: any) => item.operationId), bindingCount: latest.bindings.length,
	} };
}

async function getPlacedPcbIdentityContext(targetProjectUuid: string, placementOperationId: string, identityOperationId: string,
	retryScope?: IdentityProjectGetterRetryScope): Promise<Record<string, unknown>> {
	const identity = pcbIdentityRecord(identityOperationId, targetProjectUuid);
	const instance = identity.instances.find((item: any) => item.placementOperationId === placementOperationId);
	if (!instance || !plainObject(instance.contextBefore) || !Array.isArray(instance.sourceUidMappingsAfter))
		fail('PCB 身份确认记录未包含该 placement 的完整来源对应');
	const placementRecord = ownValue(readStoredState().operations, placementOperationId);
	if (!placementRecord || stableStringify(placementRecord) !== stableStringify(instance.placementSnapshot))
		fail('PCB 身份确认后的 placement 历史发生变化');
	const alignmentRecord = ownValue(readStoredState().operations, instance.alignmentOperationId);
	if (!alignmentRecord || stableStringify(alignmentSnapshot(alignmentRecord)) !== stableStringify(instance.alignmentSnapshot))
		fail('PCB 身份确认后的 alignment 历史发生变化');
	const parsedNetlist = parseJlcEdaNetlist(identity.netlistText);
	if (await sha256Hex(identity.netlistText) !== identity.netlistSha256
		|| stableStringify(parsedNetlist.raw) !== stableStringify(identity.netlist))
		fail('PCB 身份确认记录的网表哈希或内容不一致');
	const project = await readProject(targetProjectUuid, retryScope);
	const targetPageUuid = requireId(identity.args.targetSchematicPageUuid, 'targetSchematicPageUuid');
	const target = findPageAndBoard(project, targetPageUuid);
	if (target.board.schematic.uuid !== identity.args.targetSchematicUuid
		|| target.board.pcb?.uuid !== identity.args.targetPcbUuid
		|| stableStringify(pageIds(target.board)) !== stableStringify(identity.preState?.pageUuids))
		fail('PCB 身份确认后的目标 Board 或父 SCH 图页集合发生变化');
	const savedByPage = new Map<string, any>(identity.afterPages.map((item: any) => [item.pageUuid, item]));
	const liveDocuments = new Map<string, any>();
	let targetDocument: any;
	try {
		for (const pageUuid of identity.preState.pageUuids) {
			const saved: any = savedByPage.get(pageUuid);
			if (!saved || typeof saved.source !== 'string') fail(`PCB 身份确认记录缺少父 SCH 页面快照：${pageUuid}`);
			const current = await openActivateAndRead(targetProjectUuid, pageUuid, 'schematic', retryScope);
			const savedDocument = parseDocumentSource(saved.source, pageUuid, 'schematic');
			if (!sameEffectiveRecords(savedDocument, current))
				fail(`PCB 身份确认后父 SCH 页面内容发生变化：${pageUuid}`);
			liveDocuments.set(pageUuid, current);
			if (pageUuid === targetPageUuid) targetDocument = current;
		}
	}
	finally {
		const restored = await openActivateAndRead(targetProjectUuid, targetPageUuid, 'schematic', retryScope);
		const expected = savedByPage.get(targetPageUuid);
		if (!expected || !sameEffectiveRecords(parseDocumentSource(expected.source, targetPageUuid, 'schematic'), restored))
			fail('读取父 SCH 身份快照期间目标页变化，无法确认恢复');
		targetDocument = restored;
	}
	if (!targetDocument) fail('PCB 身份确认后的目标主图页读回失败');
	for (const component of instance.componentsAfter) {
		const document = liveDocuments.get(component.pageUuid);
		const unique = document?.effective.get(`ATTR\u0000${component.uniqueIdAttributeId}`);
		const designator = document?.effective.get(`ATTR\u0000${component.designatorAttributeId}`);
		if (unique?.data?.parentId !== component.componentId || unique.data.key !== 'Unique ID' || unique.data.value !== component.afterUid
			|| designator?.data?.parentId !== component.componentId || designator.data.key !== 'Designator' || designator.data.value !== component.afterDesignator)
			fail(`PCB 身份确认后的 UID/Designator 读回发生变化：${component.componentId}`);
	}
	const mappings = instance.sourceUidMappingsAfter.map((mapping: any) => {
		if (!plainObject(mapping) || typeof mapping.sourceUid !== 'string' || typeof mapping.actualTargetUid !== 'string'
			|| !Array.isArray(mapping.targetSchComponentIds)) fail('PCB 身份确认记录的 UID 对应结构无效');
		return { sourceUid: mapping.sourceUid, actualTargetUid: mapping.actualTargetUid, targetSchComponentIds: mapping.targetSchComponentIds };
	});
	const netEvidence = confirmedPlacementNetMappings(placementOperationId, targetProjectUuid, targetPageUuid, placementRecord, targetDocument);
	netEvidence.netMappingEvidence.identityOperationId = identityOperationId;
	return {
		...instance.contextBefore,
		identityOperationId,
		netlistSha256: identity.netlistSha256,
		sourceUidMappings: mappings,
		netMappings: netEvidence.netMappings,
		netMappingEvidence: netEvidence.netMappingEvidence,
	};
}

function validatePreparePcbInstanceIdentitiesParams(rawParams: Record<string, any>): any {
	const fields = ['operationId', 'targetProjectUuid', 'targetSchematicUuid', 'targetSchematicPageUuid', 'targetPcbUuid', 'placementOperationIds'];
	if (!plainObject(rawParams) || Object.keys(rawParams).length !== fields.length
		|| fields.some(key => !Object.prototype.hasOwnProperty.call(rawParams, key)))
		fail('preparePcbInstanceIdentities 参数字段不符合严格白名单');
	const result: any = {};
	for (const key of fields) if (key !== 'placementOperationIds') result[key] = requireId(rawParams[key], key);
	if (!Array.isArray(rawParams.placementOperationIds) || !rawParams.placementOperationIds.length
		|| rawParams.placementOperationIds.some((item: any) => typeof item !== 'string' || !item.trim())
		|| new Set(rawParams.placementOperationIds).size !== rawParams.placementOperationIds.length)
		fail('placementOperationIds 必须是非空、无重复的操作 ID 数组');
	result.placementOperationIds = [...rawParams.placementOperationIds];
	return result;
}

function identityAttributesForComponent(document: any, pageUuid: string, componentId: string): any {
	const component = document.effective.get(`COMPONENT\u0000${componentId}`);
	if (!component) fail(`父 SCH 页 ${pageUuid} 缺少身份组件 ${componentId}`);
	const attr = (key: 'Unique ID' | 'Designator') => {
		const matches = [...document.effective.values()].filter((record: any) => record.header.type === 'ATTR'
			&& record.data?.parentId === componentId && record.data?.key === key);
		if (matches.length !== 1 || typeof matches[0].data.value !== 'string' || !matches[0].data.value.trim())
			fail(`身份组件 ${componentId} 缺少唯一有效的 ${key} ATTR`);
		return { pageUuid, componentId, attributeId: matches[0].header.id, key, parentId: componentId, value: matches[0].data.value };
	};
	return { component, uniqueId: attr('Unique ID'), designator: attr('Designator') };
}

function componentIdentityAttrsAcrossPages(documents: Map<string, any>): any[] {
	const result: any[] = [];
	for (const [pageUuid, document] of documents) {
		const attributesByComponent = new Map<string, Map<string, any>>();
		for (const record of document.effective.values()) if (record.header.type === 'ATTR' && typeof record.data?.parentId === 'string' && typeof record.data?.key === 'string') {
			const attrs = attributesByComponent.get(record.data.parentId) ?? new Map<string, any>();
			if (attrs.has(record.data.key)) fail(`父 SCH 页 ${pageUuid} 器件属性重复：${record.data.parentId}/${record.data.key}`);
			attrs.set(record.data.key, record);
			attributesByComponent.set(record.data.parentId, attrs);
		}
		for (const record of document.effective.values()) if (record.header.type === 'COMPONENT') {
			if (isDrawingFrameComponent(record, new Map([...attributesByComponent.get(record.header.id) ?? []].map(([key, value]) => [key, value.data.value])))) continue;
			const attrs = attributesByComponent.get(record.header.id) ?? new Map<string, any>();
			if (!attrs.has('Unique ID')) continue;
			const unique = attrs.get('Unique ID'), designator = attrs.get('Designator');
			if (typeof unique.data?.value !== 'string' || !unique.data.value.trim()
				|| !designator || typeof designator.data?.value !== 'string' || !designator.data.value.trim())
				fail(`父 SCH 页 ${pageUuid} 器件 ${record.header.id} 的 UID/Designator 属性无效`);
			result.push({ pageUuid, componentId: record.header.id, uniqueId: unique.data.value, designator: designator.data.value });
		}
	}
	return result;
}

function findStrictPlacementAlignment(placementRecord: any): any {
	const records = Object.values(readStoredState().operations).filter((candidate: any) => candidate?.operation === 'alignTemplatePcb'
		&& candidate.args?.placementOperationId === placementRecord.operationId
		&& candidate.targetProjectUuid === placementRecord.targetProjectUuid
		&& candidate.args?.targetSchematicPageUuid === placementRecord.args?.targetSchematicPageUuid).reverse();
	let lastError: unknown;
	for (const candidate of records) {
		if (!validatedAlignmentSnapshot(candidate, placementRecord, placementRecord.targetProjectUuid, placementRecord.args.targetSchematicPageUuid)) continue;
		try {
			return { candidate, context: undefined };
		}
		catch (error) { lastError = error; }
	}
	if (lastError) fail(lastError instanceof Error ? lastError.message : String(lastError));
	fail(`placement ${placementRecord.operationId} 没有完整成功的模板 PCB alignment 记录`);
}

async function resolveStrictIdentityInstance(placementOperationId: string, args: any, retryScope?: IdentityProjectGetterRetryScope): Promise<any> {
	const placement = referencedPlacementRecord(placementOperationId, args.targetProjectUuid, args.targetSchematicPageUuid);
	if (placement.record.args?.targetSchematicUuid !== args.targetSchematicUuid
		|| placement.record.args?.targetPcbUuid !== args.targetPcbUuid)
		fail(`placement ${placementOperationId} 的父 SCH/PCB 与请求不一致`);
	const { candidate } = findStrictPlacementAlignment(placement.record);
	const context = await getPlacedPcbContext({ targetProjectUuid: args.targetProjectUuid, placementOperationId, alignmentOperationId: candidate.operationId }, retryScope);
	return { placement, candidate, context: { ...context, alignmentOperationId: candidate.operationId } };
}

async function readParentSchematicPages(targetProjectUuid: string, pageUuids: string[], retryScope?: IdentityProjectGetterRetryScope): Promise<Map<string, any>> {
	const result = new Map<string, any>();
	for (const pageUuid of pageUuids) result.set(pageUuid, await openActivateAndRead(targetProjectUuid, pageUuid, 'schematic', retryScope));
	return result;
}

function collectInstanceIdentityComponents(instances: any[], beforeDocuments: Map<string, any>): { components: any[]; allowedBefore: any[] } {
	const seenComponentIds = new Set<string>();
	const groups: any[] = [];
	for (const instance of instances) for (const mapping of instance.contextBefore.sourceUidMappings) {
		if (!plainObject(mapping) || typeof mapping.sourceUid !== 'string' || !mapping.sourceUid.trim()
			|| typeof mapping.actualTargetUid !== 'string' || !mapping.actualTargetUid.trim()
			|| !Array.isArray(mapping.targetSchComponentIds) || !mapping.targetSchComponentIds.length
			|| new Set(mapping.targetSchComponentIds).size !== mapping.targetSchComponentIds.length)
			fail(`placement ${instance.placementOperationId} 的 sourceUidMappings 无效`);
		const componentSnapshots = mapping.targetSchComponentIds.map((componentId: string) => {
			if (typeof componentId !== 'string' || !componentId.trim() || seenComponentIds.has(componentId))
				fail(`多个 placement/source UID 重复拥有目标组件：${componentId}`);
			seenComponentIds.add(componentId);
			const matches = [...beforeDocuments.entries()].filter(([, document]) => document.effective.has(`COMPONENT\u0000${componentId}`));
			if (matches.length !== 1) fail(`目标组件 ${componentId} 未在父 SCH 页面中唯一找到`);
			const [pageUuid, document] = matches[0];
			const attrs = identityAttributesForComponent(document, pageUuid, componentId);
			if (attrs.uniqueId.value !== mapping.actualTargetUid)
				fail(`目标组件 ${componentId} 的当前 UID 与 strict placement 对应不同`);
			return { pageUuid, componentId, uniqueIdAttributeId: attrs.uniqueId.attributeId, designatorAttributeId: attrs.designator.attributeId,
				beforeUid: attrs.uniqueId.value, beforeDesignator: attrs.designator.value };
		});
		if (new Set(componentSnapshots.map((item: any) => item.beforeUid)).size !== 1
			|| new Set(componentSnapshots.map((item: any) => item.beforeDesignator)).size !== 1)
			fail(`同一 physical source UID 的 multipart SCH 组件身份不一致：${mapping.sourceUid}`);
		groups.push({ placementOperationId: instance.placementOperationId, sourceUid: mapping.sourceUid,
			beforeUid: componentSnapshots[0].beforeUid, beforeDesignator: componentSnapshots[0].beforeDesignator, components: componentSnapshots });
	}
	const allowedBefore = groups.flatMap(group => group.components.flatMap((item: any) => [
		{ pageUuid: item.pageUuid, attributeId: item.uniqueIdAttributeId, componentId: item.componentId, key: 'Unique ID', parentId: item.componentId, beforeValue: item.beforeUid },
		{ pageUuid: item.pageUuid, attributeId: item.designatorAttributeId, componentId: item.componentId, key: 'Designator', parentId: item.componentId, beforeValue: item.beforeDesignator },
	]));
	return { components: groups, allowedBefore };
}

/**
 * Internal read-only context for native PCB import. This is intentionally not
 * registered as an AI/RPC operation: callers must already have a confirmed
 * placement and a confirmed alignTemplatePcb operation.
 */
export async function getPlacedPcbContext(rawParams: Record<string, any>, retryScope?: IdentityProjectGetterRetryScope): Promise<Record<string, unknown>> {
	if (!plainObject(rawParams) || Object.keys(rawParams).length !== 3
		|| !['targetProjectUuid', 'placementOperationId'].every(key => Object.prototype.hasOwnProperty.call(rawParams, key)))
		fail('getPlacedPcbContext 只接受 targetProjectUuid、placementOperationId 和 alignmentOperationId 或 identityOperationId');
	const targetProjectUuid = requireId(rawParams.targetProjectUuid, 'targetProjectUuid');
	const placementOperationId = requireId(rawParams.placementOperationId, 'placementOperationId');
	if (Object.keys(rawParams).includes('identityOperationId') && !Object.keys(rawParams).includes('alignmentOperationId')
		&& Object.keys(rawParams).length === 3)
		return getPlacedPcbIdentityContext(targetProjectUuid, placementOperationId, requireId(rawParams.identityOperationId, 'identityOperationId'), retryScope);
	if (!Object.keys(rawParams).includes('alignmentOperationId') || Object.keys(rawParams).length !== 3)
		fail('getPlacedPcbContext 只接受 targetProjectUuid、placementOperationId 和 alignmentOperationId 或 identityOperationId');
	const alignmentOperationId = requireId(rawParams.alignmentOperationId, 'alignmentOperationId');
	const alignmentRecord = ownValue(readStoredState().operations, alignmentOperationId);
	if (!plainObject(alignmentRecord) || alignmentRecord.operationId !== alignmentOperationId || alignmentRecord.operation !== 'alignTemplatePcb')
		fail('alignmentOperationId 未指向持久的 alignTemplatePcb 操作');
	if (alignmentRecord.targetProjectUuid !== targetProjectUuid || alignmentRecord.args?.targetProjectUuid !== targetProjectUuid
		|| alignmentRecord.args?.placementOperationId !== placementOperationId)
		fail('持久对齐操作与请求的目标工程或 placement 不一致');
	const targetSchematicPageUuid = requireId(alignmentRecord.args?.targetSchematicPageUuid, 'targetSchematicPageUuid');
	const placement = referencedPlacementRecord(placementOperationId, targetProjectUuid, targetSchematicPageUuid);
	if (placement.record.operationId !== placementOperationId)
		fail('持久 placement 标识不一致');
	const alignment = validatedAlignmentSnapshot(alignmentRecord, placement.record, targetProjectUuid, targetSchematicPageUuid);
	if (!alignment)
		fail('指定对齐操作没有完整、成功且匹配当前 placement 的持久确认');
	const templateSchematicUuid = requireId(alignmentRecord.args?.templateSchematicUuid, 'templateSchematicUuid');
	const templatePcbUuid = requireId(alignmentRecord.args?.templatePcbUuid, 'templatePcbUuid');
	const introducedPair = placement.record.introducedBoards.find((board: any) =>
		board.schematicUuid === templateSchematicUuid && board.pcbUuid === templatePcbUuid);
	if (!introducedPair || !Array.isArray(introducedPair.pageUuids))
		fail('持久对齐模板 SCH/PCB 配对不属于该 placement 的引入 Board');
	const project = await readProject(targetProjectUuid, retryScope);
	const target = findPageAndBoard(project, targetSchematicPageUuid);
	if (target.board.schematic.uuid !== placement.record.args?.targetSchematicUuid
		|| target.board.pcb?.uuid !== placement.record.args?.targetPcbUuid)
		fail('当前目标 SCH 页所属 Board 与持久 placement 不一致');
	const template = locateTemplatePair(project, templateSchematicUuid, templatePcbUuid);
	let resolvedTemplatePageUuid: string;
	try { resolvedTemplatePageUuid = resolveIntroducedTemplatePage(project, template.board, introducedPair, placementOperationId).uuid; }
	catch { fail('当前模板 Board 工程归属或图页与持久引入配对不一致'); }
	if (alignment.alignmentComponentPairing?.templatePageUuid !== resolvedTemplatePageUuid)
		fail('当前模板 Board 工程归属或图页与持久引入配对不一致');
	const document = await openActivateAndRead(targetProjectUuid, targetSchematicPageUuid, 'schematic', retryScope);
	let context: Record<string, unknown>;
	try {
	const templateSchematic = await openActivateAndRead(targetProjectUuid, resolvedTemplatePageUuid, 'schematic', retryScope);
	const templatePcb = await openActivateAndRead(targetProjectUuid, templatePcbUuid, 'pcb', retryScope);
	const componentIds = placement.record.targetPageReadback?.addedComponentIds;
	const legacyPairing = placement.record.targetPageReadback?.componentPairing;
	const pairing = alignment.alignmentComponentPairing?.verified === true
		? alignment.alignmentComponentPairing : legacyPairing;
	if (!Array.isArray(componentIds) || !componentIds.length || pairing?.verified !== true
		|| !Array.isArray(pairing.pairs) || pairing.pairs.length !== componentIds.length)
		fail('placement 或 alignment 没有完整持久的来源 UID 与目标组件几何对应');
	if (!alignmentPairingMatchesTarget(document, placement.record, alignment.alignmentComponentPairing))
		fail('当前目标 SCH 器件与持久 alignment 组件配对不一致');
	const componentIdSet = new Set(componentIds);
	if (componentIdSet.size !== componentIds.length)
		fail('placement 新增组件 ID 缺失或重复');
	const pairedTargetIds = pairing.pairs.map((item: any) => item?.targetId);
	if (pairedTargetIds.length !== componentIds.length || new Set(pairedTargetIds).size !== componentIds.length
		|| pairedTargetIds.some((id: any) => !componentIdSet.has(id)))
		fail('placement 来源 UID 对应未覆盖本次全部新增 SCH 组件');
	const actualComponents = componentRecordsWithAttributes(document, componentIdSet);
	if (actualComponents.length !== componentIds.length)
		fail('当前目标 SCH 新增器件身份读回不完整');
	const actualById = new Map(actualComponents.map((item: any) => [item.id, item]));
	for (const snapshot of placement.record.targetPageReadback.addedComponents) {
		if (!plainObject(snapshot) || typeof snapshot.id !== 'string'
			|| !Object.prototype.hasOwnProperty.call(snapshot, 'embeddedUniqueIdPresent'))
			continue;
		const component = document.effective.get(`COMPONENT\u0000${snapshot.id}`);
		const attrs = plainObject(component?.data?.attrs) ? component.data.attrs : undefined;
		const embeddedUniqueIdPresent = Boolean(attrs && Object.prototype.hasOwnProperty.call(attrs, 'Unique ID'));
		if (embeddedUniqueIdPresent !== snapshot.embeddedUniqueIdPresent
			|| (embeddedUniqueIdPresent && stableStringify(attrs?.['Unique ID']) !== stableStringify(snapshot.embeddedUniqueId)))
			fail(`当前目标 SCH 内嵌 UID cache 与 placement 历史不同：${snapshot.id}`);
	}
	const alignedPairByComponent = new Map(alignment.channelBeforeAfter.map((item: any) => [item.componentId, item]));
	const placementPairByComponent = new Map(pairing.pairs.map((item: any) => [item.targetId, item]));
	const expectedReferenceValues = new Map<string, string>(alignment.affectedIDs.map((item: any) => [item.componentId, item.afterValue]));
	const expectedChannels = new Map<string, string>(alignment.channelBeforeAfter.map((item: any) => [item.componentId, item.afterValue]));
	const actualReuseAttributes = reuseBlockAttributes(document, componentIds);
	if (!sameReuseBlockAttributeSnapshot(actualReuseAttributes, alignment.affectedIDs)
		|| !validatePlacementReferenceValues(document, placement.record, actualReuseAttributes, expectedReferenceValues, expectedChannels))
		fail('当前目标 SCH 的 Reuse Block、Group ID 或 Channel ID 已偏离持久 placement/alignment 确认');
	const actualChannelAttributes = oneAttributePerComponent(document, componentIds, 'Channel ID');
	const expectedChannelIds = new Map(alignment.channelBeforeAfter.map((item: any) => [item.componentId, item.attributeId]));
	if (actualChannelAttributes.some((item: any) => expectedChannelIds.get(item.componentId) !== item.attributeId))
		fail('当前目标 SCH Channel ID 属性身份与持久对齐确认不一致');
	const sourceComponentIds = new Set<string>();
	const requiredSourceUids = new Set<string>();
	for (const item of alignment.channelBeforeAfter) {
		if (typeof item.sourceComponentId !== 'string' || !item.sourceComponentId.trim()
			|| typeof item.sourceUid !== 'string' || !item.sourceUid.trim()
			|| typeof item.sourcePartId !== 'string' || !item.sourcePartId.trim()
			|| typeof item.sourceSymbol !== 'string' || !item.sourceSymbol.trim()
			|| typeof item.sourceRotation !== 'number' || !Number.isFinite(item.sourceRotation)
			|| typeof item.sourceIsMirror !== 'boolean'
			|| typeof item.sourceX !== 'number' || !Number.isFinite(item.sourceX)
			|| typeof item.sourceY !== 'number' || !Number.isFinite(item.sourceY)
			|| sourceComponentIds.has(item.sourceComponentId))
			fail('持久 alignment 缺少唯一且完整的来源 SCH 器件快照');
		sourceComponentIds.add(item.sourceComponentId);
		requiredSourceUids.add(item.sourceUid);
	}
	const currentSourceComponents = componentRecordsWithAttributes(templateSchematic, sourceComponentIds);
	if (currentSourceComponents.length !== sourceComponentIds.size)
		fail('当前模板 SCH 缺少 alignment 已配对的来源器件');
	const currentSourceById = new Map(currentSourceComponents.map((item: any) => [item.id, item]));
	for (const item of alignment.channelBeforeAfter) {
		const source: any = currentSourceById.get(item.sourceComponentId);
		const placedPair: any = placementPairByComponent.get(item.componentId);
		if (!source || source.uniqueId !== item.sourceUid || source.partId !== item.sourcePartId
			|| source.symbol !== item.sourceSymbol || source.rotation !== item.sourceRotation
			|| source.isMirror !== item.sourceIsMirror || source.x !== item.sourceX || source.y !== item.sourceY
			|| !placedPair || placedPair.sourceUid !== item.sourceUid || placedPair.sourcePartId !== item.sourcePartId
			|| placedPair.sourceSymbol !== item.sourceSymbol || placedPair.sourceRotation !== item.sourceRotation
			|| placedPair.sourceIsMirror !== item.sourceIsMirror || placedPair.sourceX !== item.sourceX
			|| placedPair.sourceY !== item.sourceY)
			fail(`当前模板 SCH 已配对来源器件与 placement/alignment 快照不一致：${item.sourceComponentId}`);
	}
	const templateChannels = physicalPcbChannels(templatePcb, requiredSourceUids);
	for (const item of alignment.channelBeforeAfter)
		if (templateChannels.get(item.sourceUid) !== item.afterValue)
			fail(`当前模板 PCB 已配对物理 UID/Channel ID 与确认对齐值不一致：${item.sourceUid}`);
	const mappingBySourceUid = new Map<string, { actualTargetUid: string; targetSchComponentIds: string[] }>();
	const sourceUidByTargetUid = new Map<string, string>();
	for (const pair of pairing.pairs) {
		const actualTargetUid = pair?.actualTargetUid ?? pair?.targetUid;
		if (!plainObject(pair) || typeof pair.sourceUid !== 'string' || !pair.sourceUid.trim()
			|| typeof actualTargetUid !== 'string' || !actualTargetUid.trim()
			|| typeof pair.targetId !== 'string' || !pair.targetId.trim())
			fail('placement 持久组件对应缺少来源或目标 UID');
		const confirmedPair: any = alignedPairByComponent.get(pair.targetId);
		if (!confirmedPair || confirmedPair.sourceComponentId !== pair.sourceId || confirmedPair.sourceUid !== pair.sourceUid
			|| confirmedPair.targetUid !== actualTargetUid)
			fail(`当前 placement UID 对应与持久 alignment 通道对应不一致：${pair.targetId}`);
		const actual: any = actualById.get(pair.targetId);
		if (!actual || actual.uniqueId !== actualTargetUid || actual.partId !== pair.targetPartId
			|| actual.symbol !== pair.targetSymbol || actual.rotation !== pair.targetRotation
			|| actual.isMirror !== pair.targetIsMirror || actual.x !== pair.targetX || actual.y !== pair.targetY
			|| pair.dx !== actual.x - pair.sourceX || pair.dy !== actual.y - pair.sourceY
			|| typeof pair.sourcePartId !== 'string' || typeof pair.sourceSymbol !== 'string'
			|| typeof pair.sourceRotation !== 'number' || typeof pair.sourceIsMirror !== 'boolean'
			|| typeof pair.sourceX !== 'number' || typeof pair.sourceY !== 'number')
			fail(`当前目标 SCH 组件身份或几何与 placement 对应快照不同：${pair.targetId}`);
		const previousSourceUid = sourceUidByTargetUid.get(actual.uniqueId);
		if (previousSourceUid && previousSourceUid !== pair.sourceUid)
			fail(`多个来源物理 UID 当前合并到同一目标 UID：${actual.uniqueId}`);
		sourceUidByTargetUid.set(actual.uniqueId, pair.sourceUid);
		const mapping = mappingBySourceUid.get(pair.sourceUid);
		if (mapping && mapping.actualTargetUid !== actual.uniqueId)
			fail(`同一来源物理 UID 对应到多个目标 UID：${pair.sourceUid}`);
		if (mapping) mapping.targetSchComponentIds.push(pair.targetId);
		else mappingBySourceUid.set(pair.sourceUid, { actualTargetUid: actual.uniqueId, targetSchComponentIds: [pair.targetId] });
	}
	context = {
		targetProjectUuid,
		placementOperationId,
		alignmentOperationId,
		targetSchematicPageUuid,
		templatePcbUuid,
		templateSchematicUuid,
		sourceUidMappings: [...mappingBySourceUid.entries()].map(([sourceUid, mapping]) => ({
			sourceUid, actualTargetUid: mapping.actualTargetUid, targetSchComponentIds: mapping.targetSchComponentIds,
		})),
	};
	}
	finally {
		const restoredTarget = await openActivateAndRead(targetProjectUuid, targetSchematicPageUuid, 'schematic');
		if (!sameEffectiveRecords(document, restoredTarget))
			fail('读取模板来源期间目标 SCH 发生变化，且无法确认恢复后的目标页内容一致');
	}
	const projectAfterReadback = await readProject(targetProjectUuid);
	const targetAfterReadback = findPageAndBoard(projectAfterReadback, targetSchematicPageUuid);
	const templateAfterReadback = locateTemplatePair(projectAfterReadback, templateSchematicUuid, templatePcbUuid);
	if (stableStringify(boardSummary(target.board)) !== stableStringify(boardSummary(targetAfterReadback.board))
		|| stableStringify(boardSummary(template.board)) !== stableStringify(boardSummary(templateAfterReadback.board))
		|| !sameStoredAlignmentSnapshot(alignment))
		fail('构建 PCB 上下文期间工程配对或持久对齐证据发生变化');
	return context;
}

function getIdentityResultSummary(record: any): Record<string, unknown> {
	return {
		operationId: record.operationId,
		operation: record.operation,
		outcome: record.outcome,
		phase: record.phase,
		netlistSha256: record.netlistSha256,
		pageSha256: record.afterPages?.map((item: any) => ({ pageUuid: item.pageUuid, sha256: item.sha256 })),
	};
}

type PreparedPcbInstanceIdentities = {
	outcome: 'confirmed';
	phase: 'identity-readback-confirmed';
	identityRecord: Record<string, unknown>;
	instances: Array<{ placementOperationId: string; context: any }>;
	expectedComponents: Array<{ targetUid: string; designator: string; pads: Array<{ padNumber: string; net: string }> }>;
	netlist: Record<string, any>;
};

async function confirmedIdentityResult(record: any): Promise<PreparedPcbInstanceIdentities> {
	const instances = [];
	for (const item of record.instances)
		instances.push({ placementOperationId: item.placementOperationId,
			context: await getPlacedPcbContext({ targetProjectUuid: record.targetProjectUuid,
				placementOperationId: item.placementOperationId, identityOperationId: record.operationId }) });
	const parsed = parseJlcEdaNetlist(record.netlistText);
	return { outcome: 'confirmed', phase: 'identity-readback-confirmed', identityRecord: getIdentityResultSummary(record), instances,
		expectedComponents: parsed.components.map(({ targetUid, designator, pads }) => ({ targetUid, designator, pads })), netlist: parsed.raw };
}

function makePageSnapshots(documents: Map<string, any>): Promise<any[]> {
	return Promise.all([...documents.entries()].map(async ([pageUuid, document]) => ({
		pageUuid, source: document.source, recordCount: document.recordCount, sha256: await sha256Hex(document.source),
	})));
}

function updatedIdentityChanges(groups: any[], afterDocuments: Map<string, any>): { changes: AllowedAttributeChange[]; componentsAfter: any[]; sourceUidMappingsAfter: any[] } {
	const changes: AllowedAttributeChange[] = [];
	const componentsAfter: any[] = [];
	const sourceUidMappingsAfter: any[] = [];
	for (const group of groups) {
		const afterValues = group.components.map((component: any) => {
			const document = afterDocuments.get(component.pageUuid);
			const uidRecord = document?.effective.get(`ATTR\u0000${component.uniqueIdAttributeId}`);
			const designatorRecord = document?.effective.get(`ATTR\u0000${component.designatorAttributeId}`);
			if (uidRecord?.data?.parentId !== component.componentId || uidRecord.data.key !== 'Unique ID'
				|| typeof uidRecord.data.value !== 'string' || !uidRecord.data.value.trim()
				|| designatorRecord?.data?.parentId !== component.componentId || designatorRecord.data.key !== 'Designator'
				|| typeof designatorRecord.data.value !== 'string' || !designatorRecord.data.value.trim())
				fail(`网表导出后身份 ATTR 不完整：${component.componentId}`);
			const afterUid = uidRecord.data.value;
			const afterDesignator = designatorRecord.data.value;
			changes.push({ pageUuid: component.pageUuid, attributeId: component.uniqueIdAttributeId, componentId: component.componentId,
				key: 'Unique ID', parentId: component.componentId, beforeValue: component.beforeUid, afterValue: afterUid });
			changes.push({ pageUuid: component.pageUuid, attributeId: component.designatorAttributeId, componentId: component.componentId,
				key: 'Designator', parentId: component.componentId, beforeValue: component.beforeDesignator, afterValue: afterDesignator });
			componentsAfter.push({ ...component, afterUid, afterDesignator });
			return { afterUid, afterDesignator };
		});
		if (new Set(afterValues.map((item: any) => item.afterUid)).size !== 1
			|| new Set(afterValues.map((item: any) => item.afterDesignator)).size !== 1)
			fail(`导出后同一 physical source UID 的 multipart SCH 身份不一致：${group.sourceUid}`);
		sourceUidMappingsAfter.push({ placementOperationId: group.placementOperationId, sourceUid: group.sourceUid,
			beforeUid: group.beforeUid, actualTargetUid: afterValues[0].afterUid, designator: afterValues[0].afterDesignator,
			targetSchComponentIds: group.components.map((item: any) => item.componentId) });
	}
	return { changes, componentsAfter, sourceUidMappingsAfter };
}

function verifyExportedIdentityBindings(parsedNetlist: ReturnType<typeof parseJlcEdaNetlist>, documents: Map<string, any>, groups: any[], componentsAfter: any[]): void {
	const netlistByUid = new Map(parsedNetlist.components.map(item => [item.targetUid, item]));
	const componentOwner = new Map<string, string>();
	for (const group of groups) for (const component of group.components) {
		if (componentOwner.has(component.componentId)) fail(`PCB 身份映射重复目标组件：${component.componentId}`);
		componentOwner.set(component.componentId, `${group.placementOperationId}\u0000${group.sourceUid}`);
	}
	const afterById = new Map(componentsAfter.map(item => [item.componentId, item]));
	const physicalByKey = new Map<string, any[]>();
	for (const item of componentIdentityAttrsAcrossPages(documents)) {
		const owner = componentOwner.get(item.componentId) ?? `unmapped\u0000${item.pageUuid}\u0000${item.componentId}`;
		const key = `${item.uniqueId}\u0000${item.designator}`;
		const entries = physicalByKey.get(key) ?? [];
		entries.push({ ...item, owner });
		physicalByKey.set(key, entries);
		const expected = afterById.get(item.componentId);
		if (expected && (expected.afterUid !== item.uniqueId || expected.afterDesignator !== item.designator))
			fail(`网表导出后 SCH UID/Designator 绑定不一致：${item.componentId}`);
	}
	const physicalByUid = new Map<string, { designator: string; owner: string }>();
	for (const entries of physicalByKey.values()) {
		const owners = new Set(entries.map(item => item.owner));
		if (owners.size !== 1)
			fail(`多个 physical SCH 实例具有相同 UID/Designator，禁止跨 placement 合并：${entries[0].uniqueId}/${entries[0].designator}`);
		const owner = entries[0].owner;
		const knownGroup = groups.find(group => `${group.placementOperationId}\u0000${group.sourceUid}` === owner);
		if (knownGroup && entries.length !== knownGroup.components.length)
			fail(`multipart physical SCH 组件覆盖不完整：${knownGroup.sourceUid}`);
		if (!knownGroup && entries.length !== 1)
			fail(`未由 placement 证据确认的重复 physical SCH UID：${entries[0].uniqueId}`);
		if (physicalByUid.has(entries[0].uniqueId))
			fail(`多个 physical SCH 器件具有相同 UID：${entries[0].uniqueId}`);
		physicalByUid.set(entries[0].uniqueId, { designator: entries[0].designator, owner });
	}
	if (physicalByUid.size !== parsedNetlist.components.length)
		fail(`JLCEDA 网表器件数量与父 SCH physical 器件不一致：netlist=${parsedNetlist.components.length} SCH=${physicalByUid.size}`);
	for (const component of parsedNetlist.components) {
		const physical = physicalByUid.get(component.targetUid);
		if (!physical || physical.designator !== component.designator)
			fail(`JLCEDA 网表 UID/Designator 无法唯一绑定父 SCH：${component.targetUid}/${component.designator}`);
	}
	for (const mapping of groups) {
		const latest = componentsAfter.filter(item => mapping.components.some((component: any) => component.componentId === item.componentId));
		if (latest.length !== mapping.components.length || latest.some(item => item.afterUid !== latest[0].afterUid || item.afterDesignator !== latest[0].afterDesignator))
			fail(`physical UID 对应的目标 SCH multipart 不一致：${mapping.sourceUid}`);
		const netlist = netlistByUid.get(latest[0].afterUid);
		if (!netlist || netlist.designator !== latest[0].afterDesignator)
			fail(`JLCEDA 网表未能按唯一 UID/Designator 确认 placement：${latest[0].afterUid}/${latest[0].afterDesignator}`);
	}
}

/** Internal, single-shot JLCEDA export and identity confirmation for native PCB helpers. */
export async function preparePcbInstanceIdentities(rawParams: Record<string, any>): Promise<PreparedPcbInstanceIdentities> {
	const args = validatePreparePcbInstanceIdentitiesParams(rawParams);
	const prior = ownValue(readStoredState().operations, args.operationId);
	if (prior) {
		if (prior.operation !== 'preparePcbInstanceIdentities' || prior.targetProjectUuid !== args.targetProjectUuid
			|| stableStringify(prior.args) !== stableStringify(args))
			fail('operationId 已用于不同操作、参数或目标工程，拒绝重放');
		if (prior.outcome !== 'confirmed')
			throw new NativePlacementError(`PCB 身份导出已有 ${prior.outcome} 状态（${prior.phase}），禁止重导：${prior.error || ''}`, {
				partial: prior.outcome === 'unknown', retryable: false, outcome: prior.outcome, operationId: args.operationId, phase: prior.phase,
			});
		return confirmedIdentityResult(prior);
	}
	const record: any = { operation: 'preparePcbInstanceIdentities', operationId: args.operationId,
		targetProjectUuid: args.targetProjectUuid, args, outcome: 'not_started', phase: 'identity_preflight',
		contentsVerified: false, confirmedIDs: [], pendingIDs: [] };
	try { await persistRecord(record); }
	catch (error) {
		throw new NativePlacementError(`PCB 身份操作开始记录未能持久化：${error instanceof Error ? error.message : String(error)}`, {
			partial: false, retryable: false, outcome: 'not_started', operationId: args.operationId, phase: 'identity_preflight_persist',
		});
	}
	let exportInvoked = false;
	const retryScope: IdentityProjectGetterRetryScope = {
		retriesRemaining: IDENTITY_PROJECT_GETTER_MAX_RETRIES,
		remainingRetryWaitMs: IDENTITY_PROJECT_GETTER_RETRY_BUDGET_MS,
		record,
		expectedDocumentUuid: args.targetSchematicPageUuid,
	};
	try {
		const projectBefore = await readProject(args.targetProjectUuid, retryScope);
		const target = findPageAndBoard(projectBefore, args.targetSchematicPageUuid);
		if (target.board.schematic.uuid !== args.targetSchematicUuid || target.board.pcb?.uuid !== args.targetPcbUuid
			|| target.board.pcb.parentProjectUuid !== args.targetProjectUuid)
			fail('目标父 SCH/PCB 配对与请求不一致');
		const pageUuids = pageIds(target.board);
		if (!pageUuids.length || pageUuids.length !== target.board.schematic.page.length
			|| new Set(pageUuids).size !== pageUuids.length
			|| target.board.schematic.page.some((page: any) => page?.parentSchematicUuid !== args.targetSchematicUuid))
			fail('父 SCH 图页列表缺失、重复或工程归属不一致');
		const strictInstances = [];
		for (const placementOperationId of args.placementOperationIds)
			strictInstances.push(await resolveStrictIdentityInstance(placementOperationId, args, retryScope));
		const beforeDocuments = await readParentSchematicPages(args.targetProjectUuid, pageUuids, retryScope);
		const targetBefore = beforeDocuments.get(args.targetSchematicPageUuid);
		if (!targetBefore) fail('目标父 SCH 页面未能完整读取');
		const identityGroups = collectInstanceIdentityComponents(strictInstances.map((item: any) => ({ placementOperationId: item.placement.record.operationId,
			contextBefore: item.context })), beforeDocuments);
		const beforePages = await makePageSnapshots(beforeDocuments);
		const instanceSnapshots = strictInstances.map((item: any) => ({
			placementOperationId: item.placement.record.operationId,
			alignmentOperationId: item.candidate.operationId,
			contextBefore: item.context,
			placementSnapshot: item.placement.record,
			alignmentSnapshot: alignmentSnapshot(item.candidate),
			sourceUidMappingsBefore: item.context.sourceUidMappings,
			sourceUidMappingsAfter: [],
			componentsBefore: identityGroups.components.filter((group: any) => group.placementOperationId === item.placement.record.operationId)
				.flatMap((group: any) => group.components),
			componentsAfter: [],
		}));
		record.preState = { projectUuid: projectBefore.uuid, targetBoard: boardSummary(target.board), pageUuids, beforePages,
			componentChangesAllowed: identityGroups.allowedBefore };
		record.instances = instanceSnapshots;
		if (typeof eda.sch_ManufactureData?.getNetlistFile !== 'function')
			fail('SDK 未提供 sch_ManufactureData.getNetlistFile');
		record.outcome = 'unknown';
		record.phase = 'netlist_export_started';
		await persistRecord(record);
		const exportTarget = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic', retryScope);
		if (!sameEffectiveRecords(targetBefore, exportTarget))
			fail('JLCEDA 网表导出前目标 SCH 内容相对持久快照发生变化');
		exportInvoked = true;
		const file = await eda.sch_ManufactureData.getNetlistFile(undefined, 'JLCEDA' as ESYS_NetlistType);
		if (!file || typeof file.text !== 'function') fail('JLCEDA 网表导出未返回可读文件');
		const netlistText = await file.text();
		if (typeof netlistText !== 'string' || !netlistText.trim()) fail('JLCEDA 网表文件为空');
		const parsedNetlist = parseJlcEdaNetlist(netlistText);
		record.phase = 'netlist_export_readback';
		const afterDocuments = await readParentSchematicPages(args.targetProjectUuid, pageUuids, retryScope);
		const updated = updatedIdentityChanges(identityGroups.components, afterDocuments);
		for (const pageUuid of pageUuids) verifyOnlyAllowedIdentityChanges(beforeDocuments.get(pageUuid), afterDocuments.get(pageUuid), pageUuid, updated.changes);
		verifyExportedIdentityBindings(parsedNetlist, afterDocuments, identityGroups.components, updated.componentsAfter);
		const afterPages = await makePageSnapshots(afterDocuments);
		const beforeByPage = new Map(beforePages.map((item: any) => [item.pageUuid, item]));
		for (const page of afterPages) {
			const currentSource = afterDocuments.get(page.pageUuid);
			if (await sha256Hex(currentSource.source) !== page.sha256 || !beforeByPage.has(page.pageUuid))
				fail(`父 SCH 页身份前后 SHA 读回缺失或不一致：${page.pageUuid}`);
		}
		const netlistSha256 = await sha256Hex(netlistText);
		const mappingsByInstance = new Map<string, any[]>();
		for (const mapping of updated.sourceUidMappingsAfter) {
			const values = mappingsByInstance.get(mapping.placementOperationId) ?? [];
			values.push({ sourceUid: mapping.sourceUid, actualTargetUid: mapping.actualTargetUid, targetSchComponentIds: mapping.targetSchComponentIds });
			mappingsByInstance.set(mapping.placementOperationId, values);
		}
		record.afterPages = afterPages;
		record.allowedIdentityChanges = updated.changes;
		record.componentsAfter = updated.componentsAfter;
		record.netlistText = netlistText;
		record.netlist = parsedNetlist.raw;
		record.netlistSha256 = netlistSha256;
		record.expectedComponents = parsedNetlist.components.map(({ targetUid, designator, pads }) => ({ targetUid, designator, pads }));
		record.instances = instanceSnapshots.map((item: any) => ({ ...item,
			sourceUidMappingsAfter: mappingsByInstance.get(item.placementOperationId) ?? [],
			componentsAfter: updated.componentsAfter.filter((component: any) => item.componentsBefore.some((before: any) => before.componentId === component.componentId)),
		}));
		const projectAfter = await readProject(args.targetProjectUuid, retryScope);
		const boardAfter = findPageAndBoard(projectAfter, args.targetSchematicPageUuid);
		if (stableStringify(boardSummary(boardAfter.board)) !== stableStringify(record.preState.targetBoard)
			|| stableStringify(pageIds(boardAfter.board)) !== stableStringify(pageUuids))
			fail('JLCEDA 网表导出期间目标 Board 或父 SCH 图页身份发生变化');
		record.outcome = 'confirmed';
		record.phase = 'identity-readback-confirmed';
		record.contentsVerified = true;
		record.confirmedIDs = updated.changes.map(item => item.attributeId);
		record.pendingIDs = [];
		await persistRecord(record);
	}
	catch (error) {
		record.outcome = exportInvoked ? 'unknown' : 'not_started';
		record.phase = exportInvoked ? (record.phase === 'netlist_export_started' ? 'netlist_export_readback' : record.phase) : 'identity_preflight';
		record.error = error instanceof Error ? error.message : String(error);
		try { await persistRecord(record); }
		catch (persistError) { record.error += `；身份操作状态未能持久化：${persistError instanceof Error ? persistError.message : String(persistError)}`; }
		throw new NativePlacementError(record.error, { partial: exportInvoked, retryable: false,
			outcome: record.outcome, operationId: record.operationId, phase: record.phase });
	}
	return await confirmedIdentityResult(record);
}

function sameStoredAlignmentSnapshot(snapshot: any): boolean {
	const current = ownValue(readStoredState().operations, snapshot.operationId);
	return !!current && stableStringify(alignmentSnapshot(current)) === stableStringify(snapshot);
}

function validatePlacementReferenceValues(document: any, placementRecord: any, actualAttributes: any[], expectedValues: Map<string, string>, expectedChannels?: Map<string, string>): boolean {
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	const expected = placementRecord.targetPageReadback?.reuseBlocks;
	if (!Array.isArray(componentIds) || !Array.isArray(expected) || actualAttributes.length !== componentIds.length
		|| expected.length !== componentIds.length
		|| new Set(actualAttributes.map(item => item.componentId)).size !== componentIds.length
		|| new Set(actualAttributes.map(item => item.attributeId)).size !== componentIds.length)
		return false;
	const actualByComponent = new Map(actualAttributes.map(item => [item.componentId, item]));
	if (componentIds.some((componentId: string) => {
		const actual = actualByComponent.get(componentId);
		return !actual || expectedValues.get(componentId) !== actual.value;
	}))
		return false;
	const alignedPlacement = {
		...placementRecord,
		targetPageReadback: {
			...placementRecord.targetPageReadback,
			reuseBlocks: expected.map((item: any) => ({ ...item, value: expectedValues.get(item.componentId), channelId: expectedChannels?.get(item.componentId) ?? item.channelId })),
		},
	};
	try {
		verifyPlacementComponents(document, alignedPlacement);
		if (expectedChannels) {
			const currentChannels = oneAttributePerComponent(document, componentIds, 'Channel ID');
			if (currentChannels.some((item: any) => expectedChannels.get(item.componentId) !== item.value)) return false;
		}
		return true;
	}
	catch {
		return false;
	}
}

function sameReuseBlockAttributeSnapshot(actualAttributes: any[], affectedIDs: any[]): boolean {
	if (actualAttributes.length !== affectedIDs.length)
		return false;
	const actualByComponent = new Map(actualAttributes.map(item => [item.componentId, item]));
	return affectedIDs.every((item: any) => {
		const actual = actualByComponent.get(item.componentId);
		return !!actual && actual.attributeId === item.attributeId && actual.value === item.afterValue;
	});
}

function resolvePlacementReferenceSnapshot(
	document: any,
	placement: any,
	targetProjectUuid: string,
	targetPageUuid: string,
	fixedReferenceSnapshot?: PlacementReferenceSnapshot,
): PlacementReferenceSnapshot {
	const placementRecord = placement.record;
	const componentIds = placementRecord.targetPageReadback?.addedComponentIds;
	if (!Array.isArray(componentIds) || !componentIds.length)
		fail('引用的放置操作没有有效新增组件，不能核对 Reuse Block 引用');
	const actualAttributes = reuseBlockAttributes(document, componentIds);
	if (fixedReferenceSnapshot?.alignmentSnapshot) {
		const fixedAlignmentSnapshot = fixedReferenceSnapshot.alignmentSnapshot;
		if (!sameStoredAlignmentSnapshot(fixedAlignmentSnapshot))
			fail('已选 Reuse Block 对齐记录在映射期间发生变化');
		const expectedValues = new Map<string, string>(fixedAlignmentSnapshot.affectedIDs.map((item: any) => [item.componentId, item.afterValue]));
		const expectedChannels = new Map<string, string>(fixedAlignmentSnapshot.channelBeforeAfter.map((item: any) => [item.componentId, item.afterValue]));
		if (!sameReuseBlockAttributeSnapshot(actualAttributes, fixedAlignmentSnapshot.affectedIDs)
			|| !validatePlacementReferenceValues(document, placementRecord, actualAttributes, expectedValues, expectedChannels)
			|| !alignmentPairingMatchesTarget(document, placementRecord, fixedAlignmentSnapshot.alignmentComponentPairing))
			fail('已选 Reuse Block 对齐引用或组件附属属性在映射期间发生变化');
		return { placementRecord: placementWithChannelUpdates(placementRecord, fixedAlignmentSnapshot.channelBeforeAfter), alignmentSnapshot: fixedAlignmentSnapshot, originalReference: false, actualAttributes };
	}

	if (fixedReferenceSnapshot?.originalReference) {
		if (placementRecord.targetPageReadback?.componentPairing?.verified !== true)
			fail('未验证原始来源对应的 placement 必须先具备独立的模板对齐配对确认');
		const originalValues = new Map<string, string>(placementRecord.targetPageReadback.reuseBlocks.map((item: any) => [item.componentId, item.value]));
		if (!validatePlacementReferenceValues(document, placementRecord, actualAttributes, originalValues))
			fail('原始 Reuse Block 引用在映射期间发生变化');
		return { placementRecord, originalReference: true, actualAttributes };
	}

	try {
		if (placementRecord.targetPageReadback?.componentPairing?.verified === true) {
			verifyPlacementComponents(document, placementRecord);
			const originalValues = new Map<string, string>(placementRecord.targetPageReadback.reuseBlocks.map((item: any) => [item.componentId, item.value]));
			if (validatePlacementReferenceValues(document, placementRecord, actualAttributes, originalValues))
				return { placementRecord, originalReference: true, actualAttributes };
		}
	}
	catch {
		// A confirmed alignment record may be the only valid source for the current references.
	}

	const records = Object.values(readStoredState().operations);
	const validSnapshots = records
		.map(record => validatedAlignmentSnapshot(record, placementRecord, targetProjectUuid, targetPageUuid))
		.filter((value): value is any => value !== undefined);
	for (let index = validSnapshots.length - 1; index >= 0; index--) {
		const snapshot = validSnapshots[index];
		const expectedValues = new Map<string, string>(snapshot.affectedIDs.map((item: any) => [item.componentId, item.afterValue]));
		const expectedChannels = new Map<string, string>(snapshot.channelBeforeAfter.map((item: any) => [item.componentId, item.afterValue]));
		if (sameReuseBlockAttributeSnapshot(actualAttributes, snapshot.affectedIDs)
			&& validatePlacementReferenceValues(document, placementRecord, actualAttributes, expectedValues, expectedChannels)
			&& alignmentPairingMatchesTarget(document, placementRecord, snapshot.alignmentComponentPairing))
			return { placementRecord: placementWithChannelUpdates(placementRecord, snapshot.channelBeforeAfter), alignmentSnapshot: snapshot, originalReference: false, actualAttributes };
	}
	fail('目标主原理图 Reuse Block 与原放置记录不一致，且没有覆盖本次 placement 的已确认对齐记录');
}

export async function alignTemplatePcb(rawParams: Record<string, any>): Promise<Record<string, unknown>> {
	const args = validateAlignTemplatePcbParams(rawParams);
	const prior = existingRecord(args.operationId, args.targetProjectUuid, args);
	if (prior)
		return operationData(prior);

	const projectBefore = await readProject(args.targetProjectUuid);
	const target = findPageAndBoard(projectBefore, args.targetSchematicPageUuid);
	if (!target.board.pcb?.uuid || target.board.pcb.parentProjectUuid !== projectBefore.uuid)
		fail('目标主原理图图页缺少属于目标工程的同板 PCB');
	let template: { board: any };
	try { template = locateTemplatePair(projectBefore, args.templateSchematicUuid, args.templatePcbUuid); }
	catch (error) {
		const unresolvedRecord = {
			operation: 'alignTemplatePcb', operationId: args.operationId, targetProjectUuid: args.targetProjectUuid, args,
			preState: { projectUuid: projectBefore.uuid, targetBoard: boardSummary(target.board), placementOperationId: args.placementOperationId },
			inputSignature: stableStringify(args), outcome: 'not_started', phase: 'template_board_pair_resolution',
		};
		return persistNotStarted(unresolvedRecord, 'template_board_pair_resolution', error, true);
	}
	if (template.board.schematic.uuid === target.board.schematic.uuid && template.board.pcb.uuid === target.board.pcb.uuid)
		fail('模板原理图与 PCB 必须属于不同于目标主原理图的 Board');
	const placement = referencedPlacementRecord(args.placementOperationId, args.targetProjectUuid, args.targetSchematicPageUuid);
	if (placement.record.args.targetSchematicUuid !== target.board.schematic.uuid || placement.record.args.targetPcbUuid !== target.board.pcb.uuid)
		fail('引用的放置操作目标 Board 与当前目标图页/PCB 配对不一致');
	const introducedPair = placement.record.introducedBoards.find((board: any) => board.schematicUuid === args.templateSchematicUuid && board.pcbUuid === args.templatePcbUuid);
	if (!introducedPair)
		fail('所选模板 SCH/PCB 配对不属于引用放置操作 introducedBoards');
	let templatePageUuid: string;
	let templatePageResolution: Record<string, unknown>;
	try {
		const pageResolution = resolveIntroducedTemplatePage(projectBefore, template.board, introducedPair, args.placementOperationId);
		templatePageUuid = pageResolution.uuid;
		templatePageResolution = pageResolution.resolution;
	}
	catch (error) {
		const unresolvedBoard = boardItems(projectBefore).find((board: any) => board.schematic?.uuid === args.templateSchematicUuid
			&& board.pcb?.uuid === args.templatePcbUuid);
		const unresolvedRecord = {
			operation: 'alignTemplatePcb', operationId: args.operationId, targetProjectUuid: args.targetProjectUuid, args,
			preState: { projectUuid: projectBefore.uuid, targetBoard: boardSummary(target.board),
				...(unresolvedBoard ? { templateBoard: boardSummary(unresolvedBoard) } : {}),
				placementOperationId: args.placementOperationId, unresolvedTemplatePageUuids: introducedPair.pageUuids },
			inputSignature: stableStringify(args), outcome: 'not_started', phase: 'template_page_resolution',
		};
		return persistNotStarted(unresolvedRecord, 'template_page_resolution', error, true);
	}
	const mainSource = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
	const oldReferenceName = placement.reuseBlock;
	const templatePcbName = projectPcbName(projectBefore, args.templatePcbUuid);
	if (typeof templatePcbName !== 'string' || !templatePcbName.trim())
		fail('引入模板 PCB 缺少有效名称，无法核对 Reuse Block 引用');
	if (template.board.pcb.name !== templatePcbName)
		fail('模板 Board 与工程 PCB 树对模板名称的读回不一致');
	if (oldReferenceName !== template.board.schematic.name || oldReferenceName !== introducedPair.schematicName)
		fail('引用的 placement 记录与引入模板原理图名称不一致');
	if (hasDuplicatePcbName(projectBefore, args.templatePcbUuid, templatePcbName))
		fail('工程中存在另一项同名 PCB，拒绝误选模板引用目标');
	const componentIds = placement.record.targetPageReadback.addedComponentIds as string[];
	verifyPlacementComponents(mainSource, placement.record, [oldReferenceName, templatePcbName]);
	const reuseAttrs = reuseBlockAttributes(mainSource, componentIds);
	if (reuseAttrs.some((item: any) => item.value !== oldReferenceName && item.value !== templatePcbName))
		fail('目标主原理图新增 Reuse Block 属性与 placement 读回不一致');
	const allAlreadyAligned = reuseAttrs.every((item: any) => item.value === templatePcbName);
	const allAtOriginalReference = reuseAttrs.every((item: any) => item.value === oldReferenceName);
	if (!allAlreadyAligned && !allAtOriginalReference)
		fail('目标主原理图新增 Reuse Block 属性处于混合引用状态，拒绝继续修改');
	const affectedIDs = reuseAttrs.map((item: any) => ({
		componentId: item.componentId, attributeId: item.attributeId,
		beforeValue: item.value, afterValue: templatePcbName,
	}));
	const referenceBeforeAfter = affectedIDs.map((item: any) => ({
		componentId: item.componentId, beforeValue: item.beforeValue, afterValue: item.afterValue,
	}));
	const templateSchematicBefore = await openActivateAndRead(args.targetProjectUuid, templatePageUuid, 'schematic');
	const templatePcbBefore = await openActivateAndRead(args.targetProjectUuid, args.templatePcbUuid, 'pcb');
	const templateComponentPairing = uniqueTranslatedComponentPairing(componentRecordsWithAttributes(templateSchematicBefore), mainSource,
		placement.record.targetPageReadback?.addedComponentIds ?? []);
	if (templateComponentPairing.verified !== true)
		fail(`引入模板与本次 placement 新增组件无法形成唯一几何配对：${templateComponentPairing.reason}`);
	const alignmentComponentPairing = persistedAlignmentComponentPairing(templateComponentPairing, args.templateSchematicUuid,
		templatePageUuid, args.templatePcbUuid);
	const channelBeforeAfter = channelUpdatesForPlacement(templateSchematicBefore, mainSource, templatePcbBefore, placement.record, templateComponentPairing);
	const channelsAlreadyAligned = channelBeforeAfter.every((item: any) => item.beforeValue === item.afterValue);
	const mainBeforeWrite = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
	if (!sameEffectiveRecords(mainSource, mainBeforeWrite))
		fail('读取模板 PCB 期间目标主原理图内容发生变化');
	verifyPlacementComponents(mainBeforeWrite, placement.record, [oldReferenceName, templatePcbName]);
	const preState = {
		projectUuid: projectBefore.uuid,
		targetBoard: boardSummary(target.board),
		targetPageUuid: args.targetSchematicPageUuid,
		targetPageParentSchematicUuid: target.page.parentSchematicUuid,
		templateBoard: boardSummary(template.board),
		templatePageUuid,
		templateSchematicUuid: args.templateSchematicUuid,
		templateSchematicName: template.board.schematic.name,
		templatePcbName,
		oldReferenceName,
		channelBeforeAfter,
		alignmentComponentPairing,
		placementOperationId: args.placementOperationId,
		boardPairKeys: boardPairKeys(projectBefore),
		affectedIDs,
		pcbRecordCount: templatePcbBefore.recordCount,
		mainPageRecordCount: mainBeforeWrite.recordCount,
	};
	const record: any = {
		operation: 'alignTemplatePcb', operationId: args.operationId, targetProjectUuid: args.targetProjectUuid, args,
		preState, inputSignature: stableStringify(args), outcome: 'not_started', phase: 'preflight',
		templatePageResolution,
		affectedIDs,
		confirmedIDs: affectedIDs.filter((item: any) => item.beforeValue === item.afterValue).map((item: any) => item.attributeId),
		pendingIDs: affectedIDs.filter((item: any) => item.beforeValue !== item.afterValue).map((item: any) => item.attributeId), referenceBeforeAfter,
		channelBeforeAfter,
		alignmentComponentPairing,
		channelConfirmedIDs: channelBeforeAfter.filter((item: any) => item.beforeValue === item.afterValue).map((item: any) => item.attributeId),
		channelPendingIDs: channelBeforeAfter.filter((item: any) => item.beforeValue !== item.afterValue).map((item: any) => item.attributeId),
		renamed: false, noOp: false,
	};
	if (allAlreadyAligned && channelsAlreadyAligned) {
		const projectAfterNoOp = await readProject(args.targetProjectUuid);
		const targetAfterNoOp = findPageAndBoard(projectAfterNoOp, args.targetSchematicPageUuid);
		const templateAfterNoOp = locateTemplatePair(projectAfterNoOp, args.templateSchematicUuid, args.templatePcbUuid);
		if (stableStringify(boardSummary(targetAfterNoOp.board)) !== stableStringify(preState.targetBoard)
			|| stableStringify(boardSummary(templateAfterNoOp.board)) !== stableStringify(preState.templateBoard)
			|| !compareBoardPairKeys(preState.boardPairKeys, boardPairKeys(projectAfterNoOp)).matches
			|| projectPcbName(projectAfterNoOp, args.templatePcbUuid) !== templatePcbName
			|| hasDuplicatePcbName(projectAfterNoOp, args.templatePcbUuid, templatePcbName))
			fail('无写入的引用核对期间工程身份发生变化');
		const noOpMain = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		verifyPlacementComponents(noOpMain, placement.record, [oldReferenceName, templatePcbName]);
		const noOpTemplatePageUuid = resolveIntroducedTemplatePage(projectAfterNoOp, templateAfterNoOp.board, introducedPair, args.placementOperationId).uuid;
		if (noOpTemplatePageUuid !== templatePageUuid) fail('无写入的引用核对期间模板图页身份发生变化');
		const noOpTemplateSchematic = await openActivateAndRead(args.targetProjectUuid, templatePageUuid, 'schematic');
		if (!sameEffectiveRecords(templateSchematicBefore, noOpTemplateSchematic))
			fail('无写入的引用核对期间模板 SCH 有效记录发生变化');
		const noOpTemplatePcb = await openActivateAndRead(args.targetProjectUuid, args.templatePcbUuid, 'pcb');
		const noOpMainFinal = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (!sameEffectiveRecords(mainSource, noOpMainFinal)
			|| !sameEffectiveRecords(templatePcbBefore, noOpTemplatePcb)
			|| !await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic'))
			fail('无写入的引用核对读回不一致');
		record.outcome = 'reference-aligned';
		record.phase = 'already-aligned';
		record.noOp = true;
		record.contentsVerified = true;
		record.channelBeforeAfter = channelBeforeAfter;
		record.channelConfirmedIDs = channelBeforeAfter.map((item: any) => item.attributeId);
		record.channelPendingIDs = [];
		record.templateContentsUnchanged = true;
		record.geometryUnchanged = true;
		record.confirmedIDs = affectedIDs.map((item: any) => item.attributeId);
		record.pendingIDs = [];
		await persistRecord(record);
		return operationData(record);
	}
	if (typeof eda.sch_PrimitiveAttribute?.modify !== 'function' || typeof eda.sch_PrimitiveAttribute?.get !== 'function')
		return persistNotStarted(record, 'sdk_capability', 'SDK 未提供 sch_PrimitiveAttribute.modify/get', true);

	record.outcome = 'unknown';
	record.phase = 'write_started';
	const referenceWrites = affectedIDs.filter((item: any) => item.beforeValue !== item.afterValue);
	record.pendingIDs = referenceWrites.map((item: any) => item.attributeId);
	try { await persistRecord(record); }
	catch (error) {
		throw new NativePlacementError(`写入 Reuse Block 引用前无法持久化 write_started：${error instanceof Error ? error.message : String(error)}`, {
			partial: false, retryable: false, outcome: 'not_started', operationId: args.operationId, phase: 'persist_write_started',
		});
	}
	let attributeWriteStarted = false;
	try {
		const projectRecheck = await readProject(args.targetProjectUuid);
		const targetRecheck = findPageAndBoard(projectRecheck, args.targetSchematicPageUuid);
		const templateRecheck = locateTemplatePair(projectRecheck, args.templateSchematicUuid, args.templatePcbUuid);
		if (resolveIntroducedTemplatePage(projectRecheck, templateRecheck.board, introducedPair, args.placementOperationId).uuid !== templatePageUuid)
			fail('持久化 write_started 后模板图页身份发生变化');
		if (stableStringify(boardSummary(targetRecheck.board)) !== stableStringify(preState.targetBoard)
			|| stableStringify(boardSummary(templateRecheck.board)) !== stableStringify(preState.templateBoard)
			|| !compareBoardPairKeys(preState.boardPairKeys, boardPairKeys(projectRecheck)).matches)
			fail('持久化 write_started 后目标或模板 Board 身份发生变化');
		if (templateRecheck.board.pcb.name !== templatePcbName
			|| projectPcbName(projectRecheck, args.templatePcbUuid) !== templatePcbName
			|| oldReferenceName !== introducedPair.schematicName)
			fail('持久化 write_started 后模板 PCB 或来源原理图名称发生变化');
		if (hasDuplicatePcbName(projectRecheck, args.templatePcbUuid, templatePcbName))
			fail('持久化 write_started 后工程出现另一项同名 PCB，拒绝修改引用');
		const placementRecheck = referencedPlacementRecord(args.placementOperationId, args.targetProjectUuid, args.targetSchematicPageUuid);
		if (stableStringify(placementRecheck.record.targetPageReadback) !== stableStringify(placement.record.targetPageReadback)
			|| stableStringify(placementRecheck.record.introducedBoards) !== stableStringify(placement.record.introducedBoards))
			fail('持久化 write_started 后引用的放置操作读回发生变化');
		const mainRecheck = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		verifyPlacementComponents(mainRecheck, placementRecheck.record, [oldReferenceName]);
		if (!sameEffectiveRecords(mainBeforeWrite, mainRecheck))
			fail('write_started 后目标主原理图内容发生变化');
		const templateSchematicRecheck = await openActivateAndRead(args.targetProjectUuid, templatePageUuid, 'schematic');
		if (!sameEffectiveRecords(templateSchematicBefore, templateSchematicRecheck))
			fail('持久化 write_started 后模板 SCH 源码发生变化');
		const templatePcbRecheck = await openActivateAndRead(args.targetProjectUuid, args.templatePcbUuid, 'pcb');
		if (!sameEffectiveRecords(templatePcbBefore, templatePcbRecheck))
			fail('持久化 write_started 后模板 PCB 源码发生变化');
		await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (typeof eda.sch_PrimitiveAttribute?.modify !== 'function' || typeof eda.sch_PrimitiveAttribute?.get !== 'function')
			return await persistNotStarted(record, 'sdk_capability_recheck', 'SDK sch_PrimitiveAttribute.modify/get 在 write_started 后不可用', true);
		for (let index = 0; index < referenceWrites.length; index++) {
			const update = referenceWrites[index];
			record.phase = `before_attribute:${update.attributeId}`;
			await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
			let modifyResult: any;
			let modifyError: unknown;
			attributeWriteStarted = true;
			try { modifyResult = await eda.sch_PrimitiveAttribute.modify(update.attributeId, { value: templatePcbName }); }
			catch (error) { modifyError = error; }
			let attribute: ISCH_PrimitiveAttribute | undefined;
			let readError: unknown;
			try { attribute = await eda.sch_PrimitiveAttribute.get(update.attributeId); }
			catch (error) { readError = error; }
			let readbackMatches = false;
			let identityReadError: unknown;
			try {
				readbackMatches = !!attribute
					&& attribute.getState_PrimitiveId() === update.attributeId
					&& attribute.getState_ParentPrimitiveId() === update.componentId
					&& attribute.getState_Key() === 'Reuse Block'
					&& attribute.getState_Value() === templatePcbName;
			}
			catch (error) { readbackMatches = false; identityReadError = error; }
			if (readbackMatches) {
				record.confirmedIDs = [...record.confirmedIDs, update.attributeId];
				record.pendingIDs = referenceWrites.slice(index + 1).map((item: any) => item.attributeId);
			}
			if (modifyError || readError || !readbackMatches) {
				const detail = modifyError ? `modify 失败：${String(modifyError)}`
					: readError ? `属性读回失败：${String(readError)}`
					: identityReadError ? `属性身份读回失败：${String(identityReadError)}`
					: '属性读回身份或 value 与请求不一致';
				return await persistUnknown(record, 'attribute_modify_readback', `${update.attributeId} ${detail}`);
			}
			record.phase = 'attribute-readback-confirmed';
			try { await persistRecord(record); }
			catch (error) { return await persistUnknown(record, 'persist_attribute_progress', error); }
		}
		const channelWrites = channelBeforeAfter.filter((item: any) => item.beforeValue !== item.afterValue);
		for (let index = 0; index < channelWrites.length; index++) {
			const update = channelWrites[index];
			record.phase = `before_channel_attribute:${update.attributeId}`;
			await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
			let modifyError: unknown;
			try { await eda.sch_PrimitiveAttribute.modify(update.attributeId, { value: update.afterValue }); }
			catch (error) { modifyError = error; }
			let attribute: ISCH_PrimitiveAttribute | undefined;
			let readError: unknown;
			try { attribute = await eda.sch_PrimitiveAttribute.get(update.attributeId); }
			catch (error) { readError = error; }
			let readbackMatches = false;
			try {
				readbackMatches = !!attribute && attribute.getState_PrimitiveId() === update.attributeId
					&& attribute.getState_ParentPrimitiveId() === update.componentId
					&& attribute.getState_Key() === 'Channel ID' && attribute.getState_Value() === update.afterValue;
			}
			catch { readbackMatches = false; }
			if (readbackMatches) {
				record.channelConfirmedIDs = [...record.channelConfirmedIDs, update.attributeId];
				record.channelPendingIDs = channelWrites.slice(index + 1).map((item: any) => item.attributeId);
			}
			if (modifyError || readError || !readbackMatches)
				return await persistUnknown(record, 'channel_attribute_modify_readback', `${update.attributeId} Channel ID 更新或读回失败`);
			record.phase = 'channel-attribute-readback-confirmed';
			try { await persistRecord(record); }
			catch (error) { return await persistUnknown(record, 'persist_channel_attribute_progress', error); }
		}
		const projectAfter = await readProject(args.targetProjectUuid);
		const targetAfter = findPageAndBoard(projectAfter, args.targetSchematicPageUuid);
		const templateAfter = locateTemplatePair(projectAfter, args.templateSchematicUuid, args.templatePcbUuid);
		if (resolveIntroducedTemplatePage(projectAfter, templateAfter.board, introducedPair, args.placementOperationId).uuid !== templatePageUuid)
			return await persistUnknown(record, 'project_tree_readback', '引用更新后的模板图页身份不符合请求');
		if (stableStringify(boardSummary(targetAfter.board)) !== stableStringify(preState.targetBoard)
			|| stableStringify(boardSummary(templateAfter.board)) !== stableStringify(preState.templateBoard)
			|| !compareBoardPairKeys(preState.boardPairKeys, boardPairKeys(projectAfter)).matches
			|| projectPcbName(projectAfter, args.templatePcbUuid) !== templatePcbName
			|| hasDuplicatePcbName(projectAfter, args.templatePcbUuid, templatePcbName))
			return await persistUnknown(record, 'project_tree_readback', '引用更新后的工程树身份、配对或同名 PCB 检查不符合请求');
		const finalMainSource = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		const alignedPlacement = placementWithChannelUpdates(placement.record, channelBeforeAfter);
		verifyPlacementComponents(finalMainSource, alignedPlacement, [templatePcbName]);
		if (!unchangedExceptReuseBlockValues(mainBeforeWrite, finalMainSource, [...affectedIDs, ...channelBeforeAfter]))
			return await persistUnknown(record, 'main_content_compare', '目标主原理图除指定 Reuse Block/Channel ID.value 外有效记录发生变化');
		const templateSchematicAfter = await openActivateAndRead(args.targetProjectUuid, templatePageUuid, 'schematic');
		if (!sameEffectiveRecords(templateSchematicBefore, templateSchematicAfter))
			return await persistUnknown(record, 'template_schematic_content_compare', '引用更新期间模板 SCH 有效记录发生变化');
		const templatePcbAfter = await openActivateAndRead(args.targetProjectUuid, args.templatePcbUuid, 'pcb');
		if (!sameEffectiveRecords(templatePcbBefore, templatePcbAfter))
			return await persistUnknown(record, 'template_content_compare', '引用更新期间模板 PCB 有效记录发生变化');
		const restoredMain = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		verifyPlacementComponents(restoredMain, alignedPlacement, [templatePcbName]);
		if (!await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic'))
			return await persistUnknown(record, 'main_focus_restore', '完成引用读回后未恢复目标主图页');
		record.outcome = 'reference-aligned';
		record.phase = 'reference-aligned';
		record.renamed = false;
		record.noOp = false;
		record.contentsVerified = true;
		record.templateContentsUnchanged = true;
		record.geometryUnchanged = true;
		record.referenceBeforeAfter = affectedIDs.map((item: any) => ({
			componentId: item.componentId, beforeValue: item.beforeValue, afterValue: templatePcbName,
		}));
		record.channelBeforeAfter = channelBeforeAfter;
		try { await persistRecord(record); }
		catch (error) { return await persistUnknown(record, 'persist_reference_aligned', error); }
		return operationData(record);
	}
	catch (error) {
		if (error instanceof NativePlacementError)
			throw error;
		if (attributeWriteStarted)
			return await persistUnknown(record, record.phase || 'guard_after_attribute_write', error);
		return await persistNotStarted(record, record.phase || 'guard_before_attribute_write', error, true);
	}
}

export async function mapInstanceNets(rawParams: Record<string, any>): Promise<Record<string, unknown>> {
	const args = validateMapInstanceNetsParams(rawParams) as {
		operationId: string;
		placementOperationId: string;
		targetProjectUuid: string;
		targetSchematicPageUuid: string;
		netMap: NetMapRow[];
	};
	const prior = existingRecord(args.operationId, args.targetProjectUuid, args);
	if (prior) {
		if (prior.operation !== 'mapInstanceNets')
			fail('operationId 已属于其他原生操作');
		return operationData(prior);
	}

	const projectBefore = await readProject(args.targetProjectUuid);
	const targetBeforeBoard = findPageAndBoard(projectBefore, args.targetSchematicPageUuid);
	const placement = referencedPlacementRecord(args.placementOperationId, args.targetProjectUuid, args.targetSchematicPageUuid);
	if (placement.record.outcome !== 'placed' || placement.record.placementVerified !== true)
		fail('mapInstanceNets 只接受已确认放置成功的 placement 记录');
	if (placement.record.args.targetSchematicUuid !== targetBeforeBoard.board.schematic.uuid
		|| placement.record.args.targetPcbUuid !== targetBeforeBoard.board.pcb?.uuid)
		fail('placement 目标 Board 与当前原理图图页的板对不一致');
	const sourceBefore = await openActivateAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
	const placementReference = resolvePlacementReferenceSnapshot(sourceBefore, placement, args.targetProjectUuid, args.targetSchematicPageUuid);
	if (placement.record.targetPageReadback?.componentPairing?.verified !== true
		&& placementReference.alignmentSnapshot?.alignmentComponentPairing?.verified === true)
		await getPlacedPcbContext({ targetProjectUuid: args.targetProjectUuid, placementOperationId: args.placementOperationId,
			alignmentOperationId: placementReference.alignmentSnapshot.operationId });
	const plan = buildNetMappingPlan(sourceBefore, placement.record, args.netMap);
	const bindings: NetBinding[] = plan.bindings;
	const alreadyMappedWireIds = plan.allWireIds.filter(wireId => !plan.changedWireIds.includes(wireId));
	const previousMapTimes = Object.values(readStoredState().operations)
		.filter((item: any) => item?.operation === 'mapInstanceNets' && item.args?.placementOperationId === args.placementOperationId)
		.map((item: any) => item.startedAt).filter((value: any) => Number.isSafeInteger(value));
	const startedAt = Math.max(Date.now(), ...previousMapTimes.map((value: number) => value + 1));
	const preState = {
		projectUuid: projectBefore.uuid,
		targetBoard: boardSummary(targetBeforeBoard.board),
		targetPageUuid: args.targetSchematicPageUuid,
		targetPageParentSchematicUuid: targetBeforeBoard.page.parentSchematicUuid,
		boardPairKeys: boardPairKeys(projectBefore),
		targetPageRecordCount: sourceBefore.recordCount,
		placementOperationId: args.placementOperationId,
		reuseBlockReference: placementReference.alignmentSnapshot
			? { alignmentOperationId: placementReference.alignmentSnapshot.operationId, affectedIDs: placementReference.alignmentSnapshot.affectedIDs }
			: { alignmentOperationId: null, affectedIDs: placement.record.targetPageReadback.reuseBlocks },
		addedWireIds: placementAddedWireIds(placement.record),
		namedSources: [...new Set(bindings.map(binding => binding.sourceNet))],
	};
	const record: any = {
		operation: 'mapInstanceNets', operationId: args.operationId, targetProjectUuid: args.targetProjectUuid, args,
		startedAt, preState, inputSignature: stableStringify(args), outcome: 'not_started', phase: 'preflight',
		netMap: args.netMap, mappedNetworks: plan.mappedNetworks, bindings,
		setterInvoked: false,
		confirmedIDs: alreadyMappedWireIds, pendingIDs: [...plan.changedWireIds],
		noOp: false, contentsVerified: false, geometryUnchanged: false, namedSourcesMapped: false, netlistVerified: false,
	};

	const verifyCurrentTargetState = async (expectedDocument: any, expectedPlan: typeof plan) => {
		const project = await readProject(args.targetProjectUuid);
		const target = findPageAndBoard(project, args.targetSchematicPageUuid);
		if (target.board.schematic.uuid !== placement.record.args.targetSchematicUuid
			|| target.board.pcb?.uuid !== placement.record.args.targetPcbUuid
			|| stableStringify(boardSummary(target.board)) !== stableStringify(preState.targetBoard)
			|| !compareBoardPairKeys(preState.boardPairKeys, boardPairKeys(project)).matches)
			fail('目标工程、Board 或图页身份在网名映射期间发生变化');
		const currentPlacement = referencedPlacementRecord(args.placementOperationId, args.targetProjectUuid, args.targetSchematicPageUuid);
		if (stableStringify(currentPlacement.record.targetPageReadback) !== stableStringify(placement.record.targetPageReadback)
			|| stableStringify(currentPlacement.record.introducedBoards) !== stableStringify(placement.record.introducedBoards))
			fail('引用的 placement 新增图元清单在网名映射期间发生变化');
		const currentSource = await readCurrentAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
		if (!sameRecordsWithMappedNetValues(expectedDocument, currentSource, expectedPlan.bindings, new Set<string>(), undefined, true))
			throw new TargetContentMismatchError(expectedDocument, currentSource);
		resolvePlacementReferenceSnapshot(currentSource, currentPlacement, args.targetProjectUuid, args.targetSchematicPageUuid, placementReference);
		const currentPlan = buildNetMappingPlan(normalizeMappedValuesForPlanning(currentSource, expectedPlan.bindings), currentPlacement.record, args.netMap);
		if (!sameNetMappingIdentity(expectedPlan, currentPlan))
			fail('当前实例 NET 来源、属性 ID 或 WIRE 绑定与预检查不一致');
		return { project, target, source: currentSource, placement: currentPlacement.record };
	};

	if (plan.changedWireIds.length === 0) {
		try {
			const current = await verifyCurrentTargetState(sourceBefore, plan);
			if (!sameRecordsWithMappedNetValues(sourceBefore, current.source, bindings, new Set(plan.allWireIds)))
				throw new TargetContentMismatchError(sourceBefore, current.source);
			record.outcome = 'mapped';
			record.phase = 'already-mapped';
			record.noOp = true;
			record.contentsVerified = true;
			record.geometryUnchanged = true;
			record.namedSourcesMapped = true;
			record.confirmedIDs = [...plan.allWireIds];
			record.pendingIDs = [];
			await persistRecord(record);
			return operationData(record);
		}
		catch (error) {
			if (error instanceof NativePlacementError)
				throw error;
			return await persistNotStarted(record, 'already_mapped_readback', error, true, sourceBefore);
		}
	}
	if (typeof eda.sch_PrimitiveWire?.modify !== 'function' || typeof eda.sch_PrimitiveWire?.getAll !== 'function' || typeof eda.sch_PrimitiveWire?.get !== 'function')
		return persistNotStarted(record, 'sdk_capability', 'SDK 未提供 sch_PrimitiveWire.modify/getAll/get', true);
	try {
		for (const wireId of plan.changedWireIds)
			await readSchWireStyle(wireId);
	}
	catch (error) {
		return persistNotStarted(record, 'wire_style_unavailable', error, true, sourceBefore);
	}

	record.outcome = 'unknown';
	record.phase = 'write_started';
	try { await persistRecord(record); }
	catch (error) {
		throw new NativePlacementError(`网名映射前无法持久化 write_started：${error instanceof Error ? error.message : String(error)}`, {
			partial: false, retryable: false, outcome: 'not_started', operationId: args.operationId, phase: 'persist_write_started',
		});
	}

	let wireWriteStarted = false;
	try {
		const guarded = await verifyCurrentTargetState(sourceBefore, plan);
		if (!sameRecordsWithMappedNetValues(sourceBefore, guarded.source, bindings, new Set(alreadyMappedWireIds)))
			throw new TargetContentMismatchError(sourceBefore, guarded.source);
		for (const wireId of plan.changedWireIds) {
			await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
			const wireBindings = bindings.filter(binding => binding.wireId === wireId);
			if (!wireBindings.length && wireWriteStarted)
				return await persistUnknown(record, 'wire_binding_missing', `待写 WIRE 缺少 NET 属性绑定：${wireId}`);
			if (!wireBindings.length)
				return await persistNotStarted(record, 'wire_binding_missing', `待写 WIRE 缺少 NET 属性绑定：${wireId}`, true, sourceBefore);
			const targetNet = wireBindings[0].afterValue;
			if (wireBindings.some(binding => binding.afterValue !== targetNet) && wireWriteStarted)
				return await persistUnknown(record, 'wire_mapping_ambiguous', `同一 WIRE 对应多个 targetNet：${wireId}`);
			if (wireBindings.some(binding => binding.afterValue !== targetNet))
				return await persistNotStarted(record, 'wire_mapping_ambiguous', `同一 WIRE 对应多个 targetNet：${wireId}`, true, sourceBefore);
			let wireStyle: { lineWidth: any; color: any; lineType: any };
			try { wireStyle = await readSchWireStyle(wireId); }
			catch (error) {
				if (!wireWriteStarted)
					return await persistNotStarted(record, 'wire_style_unavailable', error, true, sourceBefore);
				return await persistUnknown(record, 'wire_style_unavailable', error);
			}
			record.phase = `before_wire:${wireId}`;
			let modifyError: unknown;
			wireWriteStarted = true;
			record.setterInvoked = true;
			try { await eda.sch_PrimitiveWire.modify(wireId, { net: targetNet, ...wireStyle }); }
			catch (error) { modifyError = error; }
			const readbackDeadline = Date.now() + PLACEMENT_READBACK_BUDGET_MS;

			let lastReadbackError = '';
			let wireConfirmed = false;
			for (let attempt = 0; attempt <= PLACEMENT_READBACK_MAX_POLLS; attempt++) {
				try {
					await currentDocument(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
					const currentSource = await readCurrentAndRead(args.targetProjectUuid, args.targetSchematicPageUuid, 'schematic');
					const confirmedSet = new Set<string>(record.confirmedIDs);
					if (!sameRecordsWithMappedNetValues(sourceBefore, currentSource, bindings, confirmedSet, wireId)) {
						const diff = targetContentDiff(sourceBefore, currentSource);
						record.preState = { ...preState, targetContentDiff: diff };
						return await persistUnknown(record, 'target_content_changed', `目标图页出现本次 NET 绑定之外的变化：${stableStringify(diff)}`);
					}
					const wireNets = await readSchWireNets([wireId]);
					const netAttributesMatch = wireBindings.every(binding => currentSource.effective.get(`ATTR\u0000${binding.attributeId}`)?.data?.value === targetNet);
					if (netAttributesMatch && wireNets.get(wireId) === targetNet) {
						wireConfirmed = true;
						break;
					}
					lastReadbackError = `WIRE/NET 属性读回未同时达到 ${targetNet}（WIRE=${wireNets.get(wireId) ?? '<missing>'}，NETATTR=${netAttributesMatch ? 'matched' : 'pending'}）`;
				}
				catch (error) {
					if (error instanceof NativePlacementError)
						throw error;
					lastReadbackError = error instanceof Error ? error.message : String(error);
				}
				if (attempt >= PLACEMENT_READBACK_MAX_POLLS || Date.now() >= readbackDeadline)
					break;
				const remainingMs = readbackDeadline - Date.now();
				if (remainingMs > 0)
					await new Promise<void>(resolve => setTimeout(resolve, Math.min(PLACEMENT_READBACK_POLL_INTERVAL_MS, remainingMs)));
			}
			if (wireConfirmed) {
				record.confirmedIDs = [...record.confirmedIDs, wireId];
				record.pendingIDs = plan.changedWireIds.filter(id => !record.confirmedIDs.includes(id));
				record.phase = 'wire-readback-confirmed';
				try { await persistRecord(record); }
				catch (error) { return await persistUnknown(record, 'persist_wire_progress', error); }
			}
			if (modifyError)
				return await persistUnknown(record, 'wire_modify_readback', `${wireId} modify 抛错：${String(modifyError)}${wireConfirmed ? '；读回已确认本条，但停止后续写入' : ''}`);
			if (!wireConfirmed)
				return await persistUnknown(record, 'wire_modify_readback', `${wireId} ${lastReadbackError || '未能在有限预算内确认 WIRE 与 NET 属性读回'}`);
		}

		const finalTarget = await verifyCurrentTargetState(sourceBefore, plan);
		const allWireIds = new Set(plan.allWireIds);
		if (!sameRecordsWithMappedNetValues(sourceBefore, finalTarget.source, bindings, allWireIds)) {
			const diff = targetContentDiff(sourceBefore, finalTarget.source);
			record.preState = { ...preState, targetContentDiff: diff };
			return await persistUnknown(record, 'final_content_compare', `最终源码除指定 NET.value 外发生变化：${stableStringify(diff)}`);
		}
		const finalWireNets = await readSchWireNets(plan.allWireIds);
		const wireApiMismatch = bindings.find(binding => finalWireNets.get(binding.wireId) !== binding.afterValue);
		if (wireApiMismatch)
			return await persistUnknown(record, 'wire_api_readback', `最终 typed WIRE 读回不一致：${wireApiMismatch.wireId} expected=${wireApiMismatch.afterValue} actual=${finalWireNets.get(wireApiMismatch.wireId) ?? '<missing>'}`);
		const sourceMismatch = bindings.find(binding => finalTarget.source.effective.get(`ATTR\u0000${binding.attributeId}`)?.data?.value !== binding.afterValue);
		if (sourceMismatch)
			return await persistUnknown(record, 'net_attribute_readback', `最终 NET 属性读回不一致：${sourceMismatch.attributeId}`);
		record.outcome = 'mapped';
		record.phase = 'network-map-readback-confirmed';
		record.noOp = false;
		record.contentsVerified = true;
		record.geometryUnchanged = true;
		record.namedSourcesMapped = true;
		record.netlistVerified = false;
		record.confirmedIDs = [...plan.allWireIds];
		record.pendingIDs = [];
		try { await persistRecord(record); }
		catch (error) { return await persistUnknown(record, 'persist_network_map_confirmed', error); }
		return operationData(record);
	}
	catch (error) {
		if (error instanceof NativePlacementError)
			throw error;
		if (wireWriteStarted)
			return await persistUnknown(record, record.phase || 'guard_after_wire_write', error);
		return await persistNotStarted(record, record.phase || 'guard_before_wire_write', error, true, sourceBefore);
	}
}

export function placementOperationArgs(params: Record<string, any>): { operationId: string; targetProjectUuid: string } {
	if (!plainObject(params) || Object.keys(params).length !== 2 || !Object.prototype.hasOwnProperty.call(params, 'operationId') || !Object.prototype.hasOwnProperty.call(params, 'targetProjectUuid'))
		fail('getPlacementOperation 仅接受 operationId 和 targetProjectUuid');
	return { operationId: requireId(params.operationId, 'operationId'), targetProjectUuid: requireId(params.targetProjectUuid, 'targetProjectUuid') };
}

export function getPlacementOperation(operationId: string, targetProjectUuid: string): Record<string, unknown> {
	const record = ownValue(readStoredState().operations, operationId);
	if (!record)
		fail(`原生放置 operationId 不存在：${operationId}`);
	if (record.targetProjectUuid !== targetProjectUuid)
		fail('operationId 对应的目标工程与请求不一致');
	return operationData(record);
}
