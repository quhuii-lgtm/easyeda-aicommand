import { parseSourceLog, resolveRecords } from './sourcelog';

const STORAGE_KEY = 'module-reuse:state:v1';
const EMPTY_STATE = () => ({ schema: 1, captures: Object.create(null) as Record<string, any>, operations: Object.create(null) as Record<string, any> });

export type OperationErrorCause = {
	partial: boolean;
	retryable: false;
	outcome: 'unknown' | 'not_started';
	operationId: string;
	phase: string;
	createdUuid?: string;
};

export class NativeCopyError extends Error {
	readonly operationCause?: OperationErrorCause;

	constructor(message: string, operationCause?: OperationErrorCause) {
		super(message);
		this.name = 'NativeCopyError';
		this.operationCause = operationCause;
	}
}

function fail(message: string): never {
	throw new Error(message);
}

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		fail(`${name} 必须是非空字符串`);
	return value;
}

function sorted(value: any): any {
	if (Array.isArray(value))
		return value.map(sorted);
	if (value && typeof value === 'object') {
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

function plainObject(value: unknown): value is Record<string, any> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ownValue(map: Record<string, any>, key: string): any {
	return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function readStoredState(): any {
	const raw = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
	if (raw === undefined)
		return EMPTY_STATE();
	let state: any;
	try {
		state = typeof raw === 'string' ? JSON.parse(raw) : raw;
	}
	catch {
		fail('插件持久状态不是有效 JSON，已停止后续操作');
	}
	if (!plainObject(state) || state.schema !== 1 || !plainObject(state.captures) || !plainObject(state.operations))
		fail('插件持久状态结构无效，已停止后续操作');
	return {
		...state,
		captures: Object.assign(Object.create(null), state.captures),
		operations: Object.assign(Object.create(null), state.operations),
	};
}

async function writeStoredState(next: any): Promise<void> {
	const serialized = JSON.stringify(next);
	const stored = await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY, serialized);
	if (stored !== true)
		fail('持久状态写入返回 false 或空结果');
	const readback = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
	let parsed: unknown;
	try {
		parsed = typeof readback === 'string' ? JSON.parse(readback) : readback;
	}
	catch {
		fail('持久状态回读不是有效 JSON');
	}
	if (stableStringify(parsed) !== stableStringify(next))
		fail('持久状态写后读回不一致');
}

function projectByUuid(project: any, expectedUuid: string): any {
	if (!project)
		fail('读取当前工程失败：SDK 返回空结果');
	if (project.uuid !== expectedUuid)
		fail(`当前工程不匹配：期望 ${expectedUuid}，实际 ${String(project.uuid)}`);
	if (!Array.isArray(project.data))
		fail('当前工程树缺少有效 data 列表');
	return project;
}

async function currentProject(expectedUuid: string): Promise<any> {
	return projectByUuid(await eda.dmt_Project.getCurrentProjectInfo(), expectedUuid);
}

function findSourceBoard(project: any, schematicPageUuid: string, pcbUuid: string): any {
	const matches = project.data.filter((item: any) => item?.schematic?.page?.some((page: any) => page?.uuid === schematicPageUuid)
		&& item?.pcb?.uuid === pcbUuid);
	if (matches.length !== 1)
		fail(matches.length === 0 ? '原理图图页与 PCB 未在工程树中证明属于同一 Board' : '工程树中存在多个匹配 Board，无法唯一确认来源成套关系');
	const board = matches[0];
	if (board.parentProjectUuid !== project.uuid
		|| board.schematic.parentProjectUuid !== project.uuid
		|| board.pcb.parentProjectUuid !== project.uuid)
		fail('来源 Board、原理图或 PCB 的工程归属不一致');
	return board;
}

function requireDocumentType(document: any, expected: 'schematic' | 'pcb', projectUuid: string, uuid: string): void {
	if (!document)
		fail('读取当前文档失败：SDK 返回空结果');
	const type = expected === 'schematic' ? 1 : 3;
	if (document.uuid !== uuid || document.parentProjectUuid !== projectUuid || document.documentType !== type)
		fail(`当前文档身份、工程归属或类型不匹配：${uuid}`);
}

async function currentDocument(projectUuid: string, documentType: 'schematic' | 'pcb', uuid: string): Promise<any> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	requireDocumentType(document, documentType, projectUuid, uuid);
	return document;
}

function validateDocumentSource(source: unknown, expectedUuid: string, documentType: 'schematic' | 'pcb'): { raw: string; parsed: ReturnType<typeof parseSourceLog>; validObjectCount: number } {
	if (typeof source !== 'string' || !source)
		fail('sys_FileManager.getDocumentSource 返回空或非法值');
	const parsed = parseSourceLog(source);
	const expectedDocType = documentType === 'schematic' ? 'SCH_PAGE' : 'PCB';
	if (parsed.uuid !== expectedUuid || parsed.docType.toUpperCase() !== expectedDocType)
		fail(`DOCHEAD 与目标身份/类型不符：期望 ${expectedDocType}/${expectedUuid}，实际 ${parsed.docType}/${parsed.uuid}`);
	for (const record of parsed.records) {
		if (record.header.type !== 'DOCHEAD' && (typeof record.header.type !== 'string' || !record.header.type.trim() || typeof record.header.id !== 'string' || !record.header.id.trim()))
			fail(`源码包含无法识别或缺少 ID 的记录（第 ${record.line} 行），不能安全比较`);
	}
	const effective = resolveRecords(parsed);
	return { raw: source, parsed, validObjectCount: effective.size };
}

async function openActivateAndRead(projectUuid: string, documentType: 'schematic' | 'pcb', uuid: string): Promise<any> {
	await currentProject(projectUuid);
	const tabId = await eda.dmt_EditorControl.openDocument(uuid);
	if (typeof tabId !== 'string' || !tabId)
		fail(`打开文档失败：${uuid}`);
	const activated = await eda.dmt_EditorControl.activateDocument(tabId);
	if (activated !== true)
		fail(`激活文档失败：${uuid}`);
	await currentProject(projectUuid);
	await currentDocument(projectUuid, documentType, uuid);
	const source = await eda.sys_FileManager.getDocumentSource();
	const verifiedSource = validateDocumentSource(source, uuid, documentType);
	await currentProject(projectUuid);
	await currentDocument(projectUuid, documentType, uuid);
	return verifiedSource;
}

export function validateCopyParams(params: Record<string, any>): Record<string, any> {
	const common = ['operationId', 'captureId', 'targetProjectUuid', 'documentType'];
	const expected = params.documentType === 'schematic' ? [...common, 'targetSchematicUuid'] : common;
	if (Object.keys(params).length !== expected.length || expected.some(key => !(key in params)))
		fail('probeNativeCopy 参数字段不符合当前 documentType');
	const operationId = requireId(params.operationId, 'operationId');
	const captureId = requireId(params.captureId, 'captureId');
	const targetProjectUuid = requireId(params.targetProjectUuid, 'targetProjectUuid');
	if (params.documentType !== 'schematic' && params.documentType !== 'pcb')
		fail('documentType 只能是 schematic 或 pcb');
	const result: Record<string, any> = { operationId, captureId, targetProjectUuid, documentType: params.documentType };
	if (params.documentType === 'schematic')
		result.targetSchematicUuid = requireId(params.targetSchematicUuid, 'targetSchematicUuid');
	return result;
}

function collectProjectUuids(project: any): Set<string> {
	const found = new Set<string>();
	const seen = new WeakSet<object>();
	const walk = (value: any): void => {
		if (!value || typeof value !== 'object' || seen.has(value))
			return;
		seen.add(value);
		if (typeof value.uuid === 'string')
			found.add(value.uuid);
		for (const child of Object.values(value))
			walk(child);
	};
	walk(project.data);
	return found;
}

function findTargetSchematic(project: any, schematicUuid: string): any {
	const matches: any[] = [];
	for (const item of project.data) {
		if (item?.schematic?.uuid === schematicUuid)
			matches.push(item.schematic);
		if (item?.uuid === schematicUuid && item?.page)
			matches.push(item);
	}
	if (matches.length !== 1)
		fail('目标 schematic 必须能在目标工程树中唯一确认');
	if (matches[0].parentProjectUuid !== project.uuid)
		fail('目标 schematic 不属于目标工程');
	return matches[0];
}

function findProjectItem(project: any, uuid: string): any[] {
	const result: any[] = [];
	const seen = new WeakSet<object>();
	const walk = (value: any): void => {
		if (!value || typeof value !== 'object' || seen.has(value))
			return;
		seen.add(value);
		if (value.uuid === uuid)
			result.push(value);
		for (const child of Object.values(value))
			walk(child);
	};
	walk(project.data);
	return result;
}

async function validateTarget(params: Record<string, any>, capture: any): Promise<{ project: any; existingUuids: Set<string> }> {
	const project = await currentProject(params.targetProjectUuid);
	if (params.documentType === 'schematic') {
		const target = findTargetSchematic(project, params.targetSchematicUuid);
		const info = await eda.dmt_Schematic.getSchematicInfo(target.uuid);
		if (!info || info.uuid !== target.uuid || info.parentProjectUuid !== params.targetProjectUuid)
			fail('读取 targetSchematic 失败或工程归属不符');
	}
	return { project, existingUuids: collectProjectUuids(project) };
}

function matchingEffectiveRecords(source: any, copied: any): { contentMatch: boolean; sourceObjectCount: number; createdObjectCount: number; difference?: string } {
	const left = resolveRecords(source.parsed);
	const right = resolveRecords(copied.parsed);
	const sourceObjectCount = left.size;
	const createdObjectCount = right.size;
	if (left.size !== right.size)
		return { contentMatch: false, sourceObjectCount, createdObjectCount, difference: `有效对象数不同（${left.size} != ${right.size}）` };
	for (const [key, sourceRecord] of left) {
		const copiedRecord = right.get(key);
		if (!copiedRecord)
			return { contentMatch: false, sourceObjectCount, createdObjectCount, difference: `副本缺少有效记录 ${key.replace('\u0000', ':')}` };
		const sourceHeader = { ...sourceRecord.header };
		const copiedHeader = { ...copiedRecord.header };
		delete sourceHeader.ticket;
		delete copiedHeader.ticket;
		if (stableStringify(sourceHeader) !== stableStringify(copiedHeader) || stableStringify(sourceRecord.data) !== stableStringify(copiedRecord.data))
			return { contentMatch: false, sourceObjectCount, createdObjectCount, difference: `记录内容不同 ${key.replace('\u0000', ':')}` };
	}
	return { contentMatch: true, sourceObjectCount, createdObjectCount };
}

function operationData(record: any): Record<string, any> {
	return {
		operationId: record.operationId,
		captureId: record.captureId,
		targetProjectUuid: record.targetProjectUuid,
		documentType: record.documentType,
		...(record.targetSchematicUuid ? { targetSchematicUuid: record.targetSchematicUuid } : {}),
		sourceUuid: record.sourceUuid,
		...(Array.isArray(record.existingTargetUuids) ? { existingTargetUuids: [...record.existingTargetUuids] } : {}),
		state: record.state,
		phase: record.phase,
		...(record.contentMatch !== undefined ? { contentMatch: record.contentMatch } : {}),
		...(record.sourceObjectCount !== undefined ? { sourceObjectCount: record.sourceObjectCount } : {}),
		...(record.createdObjectCount !== undefined ? { createdObjectCount: record.createdObjectCount } : {}),
		...(record.dependenciesVerified !== undefined ? { dependenciesVerified: record.dependenciesVerified } : {}),
		...(record.persisted !== undefined ? { persisted: record.persisted } : {}),
		...(record.pairAssociationVerified !== undefined ? { pairAssociationVerified: record.pairAssociationVerified } : {}),
		...(record.createdUuid ? { createdUuid: record.createdUuid } : {}),
		...(record.partial !== undefined ? { partial: record.partial } : {}),
		...(record.retryable !== undefined ? { retryable: record.retryable } : {}),
		...(record.outcome ? { outcome: record.outcome } : {}),
		...(record.error ? { error: record.error } : {}),
	};
}

async function persistOperation(record: any): Promise<void> {
	const state = readStoredState();
	state.operations[record.operationId] = record;
	await writeStoredState(state);
}

async function persistUnknown(record: any, phase: string, error: unknown): Promise<never> {
	const updated = {
		...record,
		state: 'unknown',
		phase,
		partial: true,
		retryable: false,
		outcome: 'unknown',
		error: error instanceof Error ? error.message : String(error),
	};
	try {
		await persistOperation(updated);
	}
	catch (storageError) {
		updated.error += `；操作状态记录失败：${storageError instanceof Error ? storageError.message : String(storageError)}`;
	}
	throw new NativeCopyError(updated.error, {
		partial: true,
		retryable: false,
		outcome: 'unknown',
		operationId: record.operationId,
		phase,
		...(record.createdUuid ? { createdUuid: record.createdUuid } : {}),
	});
}

export function validateCaptureParams(params: Record<string, any>): { projectUuid: string; schematicPageUuid: string; pcbUuid: string } {
	const keys = ['projectUuid', 'schematicPageUuid', 'pcbUuid'];
	if (Object.keys(params).length !== keys.length || keys.some(key => !(key in params)))
		fail('capturePair 仅接受 projectUuid、schematicPageUuid、pcbUuid');
	return {
		projectUuid: requireId(params.projectUuid, 'projectUuid'),
		schematicPageUuid: requireId(params.schematicPageUuid, 'schematicPageUuid'),
		pcbUuid: requireId(params.pcbUuid, 'pcbUuid'),
	};
}

async function capturePairInternal(params: Record<string, any>): Promise<Record<string, unknown>> {
	const ids = validateCaptureParams(params);
	const project = await currentProject(ids.projectUuid);
	const board = findSourceBoard(project, ids.schematicPageUuid, ids.pcbUuid);
	const schematicPage = board.schematic.page.find((page: any) => page.uuid === ids.schematicPageUuid);
	const pageInfo = await eda.dmt_Schematic.getSchematicPageInfo(ids.schematicPageUuid);
	const pcbInfo = await eda.dmt_Pcb.getPcbInfo(ids.pcbUuid);
	if (!pageInfo || pageInfo.uuid !== ids.schematicPageUuid || pageInfo.parentSchematicUuid !== board.schematic.uuid)
		fail('来源原理图图页详情与工程树不一致');
	if (!pcbInfo || pcbInfo.uuid !== ids.pcbUuid || pcbInfo.parentProjectUuid !== ids.projectUuid || pcbInfo.parentBoardName !== board.name)
		fail('来源 PCB 详情与工程树不一致');

	const schematic = await openActivateAndRead(ids.projectUuid, 'schematic', ids.schematicPageUuid);
	const pcb = await openActivateAndRead(ids.projectUuid, 'pcb', ids.pcbUuid);
	await currentProject(ids.projectUuid);
	await currentDocument(ids.projectUuid, 'pcb', ids.pcbUuid);
	const storage = eda.sys_Storage;
	if (!storage)
		fail('sys_Storage 不可用，不能持久化来源捕获');
	const captureId = globalThis.crypto.randomUUID().replaceAll('-', '');
	const record = {
		captureId,
		createdAt: new Date().toISOString(),
		source: {
			projectUuid: ids.projectUuid,
			boardName: board.name,
			schematicUuid: board.schematic.uuid,
			schematicPageUuid: ids.schematicPageUuid,
			pcbUuid: ids.pcbUuid,
		},
		documents: {
			schematic: { uuid: schematicPage.uuid, docType: schematic.parsed.docType, validObjectCount: schematic.validObjectCount },
			pcb: { uuid: ids.pcbUuid, docType: pcb.parsed.docType, validObjectCount: pcb.validObjectCount },
		},
		sources: { schematic: schematic.raw, pcb: pcb.raw },
	};
	const state = readStoredState();
	state.captures[captureId] = record;
	await writeStoredState(state);
	return {
		captureId,
		source: record.source,
		documents: record.documents,
	};
}

export async function capturePair(params: Record<string, any>): Promise<Record<string, unknown>> {
	if (busy)
		fail('模块复用正处于切页或复制操作中');
	busy = true;
	try {
		return await capturePairInternal(params);
	}
	finally {
		busy = false;
	}
}

export async function probeNativeCopy(params: Record<string, any>): Promise<Record<string, unknown>> {
	const args = validateCopyParams(params);
	const stateBefore = readStoredState();
	const prior = ownValue(stateBefore.operations, args.operationId);
	if (prior) {
		const priorArgs = { operationId: prior.operationId, captureId: prior.captureId, targetProjectUuid: prior.targetProjectUuid, documentType: prior.documentType, ...(prior.documentType === 'schematic' ? { targetSchematicUuid: prior.targetSchematicUuid } : {}) };
		if (stableStringify(priorArgs) !== stableStringify(args))
			fail('operationId 已被不同参数使用，拒绝重写');
		return operationData(prior);
	}
	const capture = ownValue(stateBefore.captures, args.captureId);
	if (!capture)
		fail('captureId 不存在，不能开始原生复制');
	if (busy)
		fail('模块复用正处于切页或复制操作中');
	busy = true;
	try {
		let target = await validateTarget(args, capture);
		const sourceUuid = args.documentType === 'schematic' ? capture.source.schematicPageUuid : capture.source.pcbUuid;
		const source = validateDocumentSource(capture.sources[args.documentType], sourceUuid, args.documentType);
		const record: any = {
			...args,
			sourceUuid,
			state: 'write_started',
			phase: 'write_started',
			partial: true,
			retryable: false,
			outcome: 'unknown',
			sourceObjectCount: source.validObjectCount,
			existingTargetUuids: [...target.existingUuids],
		};
		try {
			await persistOperation(record);
		}
		catch (error) {
			throw new NativeCopyError(`写入前无法持久化操作记录：${error instanceof Error ? error.message : String(error)}`, {
				partial: false,
				retryable: false,
				outcome: 'not_started',
				operationId: args.operationId,
				phase: 'persist_write_started',
			});
		}

		try {
			if (args.documentType === 'schematic' && args.targetProjectUuid === capture.source.projectUuid) {
				const liveSource = await openActivateAndRead(args.targetProjectUuid, 'schematic', sourceUuid);
				const sourceCheck = matchingEffectiveRecords(source, liveSource);
				if (!sourceCheck.contentMatch) fail(`来源捕获后已有变化，复制未调用：${sourceCheck.difference}`);
			}
			const recheckedTarget = await validateTarget(args, capture);
			if (stableStringify([...target.existingUuids].sort()) !== stableStringify([...recheckedTarget.existingUuids].sort()))
				fail('write_started 后目标工程树发生变化，SDK 写入未调用');
			target = recheckedTarget;
		}
		catch (error) {
			record.state = 'not_started';
			record.phase = 'guard_before_sdk_write';
			record.partial = false;
			record.retryable = false;
			record.outcome = 'not_started';
			record.error = error instanceof Error ? error.message : String(error);
			try { await persistOperation(record); }
			catch (storageError) { record.error += `；未能记录停止状态：${storageError instanceof Error ? storageError.message : String(storageError)}`; }
			throw new NativeCopyError(record.error, {
				partial: false,
				retryable: false,
				outcome: 'not_started',
				operationId: args.operationId,
				phase: record.phase,
			});
		}

		try {
			if (args.documentType === 'schematic') {
				record.createdUuid = await eda.dmt_Schematic.copySchematicPage(sourceUuid, args.targetSchematicUuid);
			}
			else {
				record.createdUuid = await eda.dmt_Pcb.copyPcb(sourceUuid);
			}
			if (typeof record.createdUuid !== 'string' || !record.createdUuid)
				fail('SDK copy API 返回空 UUID');
		}
		catch (error) {
			return await persistUnknown(record, 'sdk_copy', error);
		}

		let phase = 'persist_copy_result';
		try {
			record.state = 'copy_returned';
			record.phase = phase;
			await persistOperation(record);
			phase = 'metadata_readback';
			if (target.existingUuids.has(record.createdUuid))
				fail('SDK 返回的副本 UUID 已存在于目标工程，无法确认新建身份');
			const targetAfterCopy = await currentProject(args.targetProjectUuid);
			const targetMatches = findProjectItem(targetAfterCopy, record.createdUuid);
			if (targetMatches.length !== 1)
				fail('副本未在目标工程树中唯一读回');
			if (args.documentType === 'schematic') {
				const page = await eda.dmt_Schematic.getSchematicPageInfo(record.createdUuid);
				if (!page || page.uuid !== record.createdUuid || page.parentSchematicUuid !== args.targetSchematicUuid)
					fail('原理图副本图页身份或父原理图不符');
				const targetSchematic = await eda.dmt_Schematic.getSchematicInfo(args.targetSchematicUuid);
				if (!targetSchematic || targetSchematic.parentProjectUuid !== args.targetProjectUuid)
					fail('副本所属目标原理图不属于目标工程');
				const sourceCopy = await openActivateAndRead(args.targetProjectUuid, 'schematic', record.createdUuid);
				const result = matchingEffectiveRecords(source, sourceCopy);
				record.createdObjectCount = result.createdObjectCount;
				record.contentMatch = result.contentMatch;
				if (!result.contentMatch)
					fail(`副本有效对象与来源不一致：${result.difference}`);
			}
			else {
				const pcb = await eda.dmt_Pcb.getPcbInfo(record.createdUuid);
				if (!pcb || pcb.uuid !== record.createdUuid || pcb.parentProjectUuid !== args.targetProjectUuid || pcb.parentBoardName)
					fail('PCB 副本身份、目标工程或游离状态不符');
				const sourceCopy = await openActivateAndRead(args.targetProjectUuid, 'pcb', record.createdUuid);
				const result = matchingEffectiveRecords(source, sourceCopy);
				record.createdObjectCount = result.createdObjectCount;
				record.contentMatch = result.contentMatch;
				if (!result.contentMatch)
					fail(`副本有效对象与来源不一致：${result.difference}`);
			}
			phase = 'persist_confirmed';
			record.state = 'copyConfirmed';
			record.phase = phase;
			record.partial = false;
			record.retryable = false;
			record.outcome = 'confirmed';
			record.dependenciesVerified = false;
			record.persisted = false;
			record.pairAssociationVerified = false;
			await persistOperation(record);
			return {
				operationId: record.operationId,
				captureId: record.captureId,
				targetProjectUuid: record.targetProjectUuid,
				documentType: record.documentType,
				sourceUuid: record.sourceUuid,
				createdUuid: record.createdUuid,
				state: record.state,
				contentMatch: record.contentMatch,
				sourceObjectCount: record.sourceObjectCount,
				createdObjectCount: record.createdObjectCount,
				dependenciesVerified: false,
				persisted: false,
				pairAssociationVerified: false,
			};
		}
		catch (error) {
			return await persistUnknown({ ...record, createdUuid: record.createdUuid }, phase, error);
		}
	}
	finally {
		busy = false;
	}
}

let busy = false;

export function isBusy(): boolean {
	return busy;
}

export function getCopyOperation(operationId: string): Record<string, unknown> {
	const record = ownValue(readStoredState().operations, operationId);
	if (!record)
		fail(`operationId 不存在：${operationId}`);
	return operationData(record);
}

export function copyOperationArgs(params: Record<string, any>): { operationId: string } {
	if (Object.keys(params).length !== 1 || !('operationId' in params))
		fail('getCopyOperation 仅接受 operationId');
	return { operationId: requireId(params.operationId, 'operationId') };
}
