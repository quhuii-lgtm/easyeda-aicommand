const STORAGE_KEY = 'module-reuse:file-restore:v1';
const POST_IMPORT_READBACK_TIMEOUT_MS = 3000;
const POST_IMPORT_READBACK_INTERVAL_MS = 250;
const EMPTY_STATE = () => ({ schema: 1, operations: Object.create(null) as Record<string, any> });

type RestoreCause = {
	partial: boolean;
	retryable: false;
	outcome: 'unknown' | 'not_started';
	operationId: string;
	phase: string;
	projectUuid?: string;
};

export class FileRestoreError extends Error {
	readonly operationCause?: RestoreCause;

	constructor(message: string, operationCause?: RestoreCause) {
		super(message);
		this.name = 'FileRestoreError';
		this.operationCause = operationCause;
	}
}

class ProjectIdentityMismatchError extends Error {}
class ProjectTreeReadbackTimeoutError extends Error {}

function fail(message: string): never {
	throw new Error(message);
}

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		fail(`${name} 必须是非空字符串`);
	return value;
}

function plainObject(value: unknown): value is Record<string, any> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ownValue(map: Record<string, any>, key: string): any {
	return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle)
		fail('当前环境不支持 SHA-256，已在导入前停止');
	const digest = await subtle.digest('SHA-256', toArrayBuffer(bytes));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function decodeBase64(value: unknown): Uint8Array {
	if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		fail('base64 必须是非空且格式有效的标准 Base64');
	let binary: string;
	try {
		binary = atob(value);
	}
	catch {
		fail('base64 解码失败');
	}
	if (!binary.length)
		fail('工程文件内容不能为空');
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++)
		bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export type FileRestoreParams = {
	operationId: string;
	targetProjectUuid: string;
	fileName: string;
	base64: string;
};

export function validateFileRestoreParams(params: Record<string, any>): FileRestoreParams {
	const expected = ['operationId', 'targetProjectUuid', 'fileName', 'base64'];
	if (!plainObject(params) || Object.keys(params).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(params, key)))
		fail('fileRestore 仅接受 operationId、targetProjectUuid、fileName、base64');
	const operationId = requireId(params.operationId, 'operationId');
	const targetProjectUuid = requireId(params.targetProjectUuid, 'targetProjectUuid');
	const fileName = requireId(params.fileName, 'fileName');
	if (/[\\/]/.test(fileName) || !/\.epro2?$/i.test(fileName))
		fail('fileName 必须是 .epro 或 .epro2 原生工程文件名');
	if (typeof params.base64 !== 'string' || !params.base64)
		fail('base64 必须是非空字符串');
	return { operationId, targetProjectUuid, fileName, base64: params.base64 };
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
		fail('文件恢复持久状态不是有效 JSON，已停止后续操作');
	}
	if (!plainObject(state) || state.schema !== 1 || !plainObject(state.operations))
		fail('文件恢复持久状态结构无效，已停止后续操作');
	return { ...state, operations: Object.assign(Object.create(null), state.operations) };
}

async function writeStoredState(next: any): Promise<void> {
	const serialized = JSON.stringify(next);
	const stored = await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY, serialized);
	if (stored !== true)
		fail('文件恢复状态写入返回 false 或空结果');
	const readback = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
	let parsed: unknown;
	try {
		parsed = typeof readback === 'string' ? JSON.parse(readback) : readback;
	}
	catch {
		fail('文件恢复状态写后读回不是有效 JSON');
	}
	if (stableStringify(parsed) !== stableStringify(next))
		fail('文件恢复状态写后读回不一致');
}

function restoreData(record: any): Record<string, unknown> {
	return {
		operationId: record.operationId,
		targetProjectUuid: record.targetProjectUuid,
		fileName: record.fileName,
		fileType: 'JLCEDA Pro',
		state: record.state,
		phase: record.phase,
		...(record.outcome ? { outcome: record.outcome } : {}),
		...(record.partial !== undefined ? { partial: record.partial } : {}),
		...(record.retryable !== undefined ? { retryable: record.retryable } : {}),
		...(record.importedProjectUuid !== undefined ? { importedProjectUuid: record.importedProjectUuid } : {}),
		...(record.metadataVerified !== undefined ? { metadataVerified: record.metadataVerified } : {}),
		...(record.contentVerified !== undefined ? { contentVerified: record.contentVerified } : {}),
		...(record.treeBefore !== undefined ? { treeBefore: record.treeBefore } : {}),
		...(record.treeAfter !== undefined ? { treeAfter: record.treeAfter } : {}),
		...(record.treeChanged !== undefined ? { treeChanged: record.treeChanged } : {}),
		...(record.treeReadbackProof !== undefined ? { treeReadbackProof: record.treeReadbackProof } : {}),
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
		updated.error += `；unknown 状态记录失败：${storageError instanceof Error ? storageError.message : String(storageError)}`;
	}
	throw new FileRestoreError(updated.error, {
		partial: true,
		retryable: false,
		outcome: 'unknown',
		operationId: record.operationId,
		phase,
		...(record.importedProjectUuid ? { projectUuid: record.importedProjectUuid } : {}),
	});
}

function collectProjectUuids(projectData: any[]): string[] {
	const found = new Set<string>();
	const seen = new WeakSet<object>();
	const walk = (value: any): void => {
		if (!value || typeof value !== 'object' || seen.has(value))
			return;
		seen.add(value);
		if (typeof value.uuid === 'string' && value.uuid)
			found.add(value.uuid);
		for (const child of Object.values(value))
			walk(child);
	};
	walk(projectData);
	return [...found].sort();
}

async function readTargetProject(projectUuid: string): Promise<{ project: any; summary: Record<string, unknown> }> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project || typeof project !== 'object')
		fail('读取当前工程失败：SDK 返回空结果');
	if (project.uuid !== projectUuid)
		throw new ProjectIdentityMismatchError(`当前工程与目标不一致：期望 ${projectUuid}，实际 ${String(project.uuid)}`);
	if (!Array.isArray(project.data))
		fail('当前工程树缺少有效 data 列表');
	const uuids = collectProjectUuids(project.data);
	return {
		project,
		summary: {
			projectUuid: project.uuid,
			entryCount: project.data.length,
			uuidCount: uuids.length,
			fingerprint: await sha256Hex(new TextEncoder().encode(JSON.stringify(uuids))),
		},
	};
}

async function readTargetProjectAfterImport(
	projectUuid: string,
	before: Record<string, unknown>,
): Promise<{ after?: Awaited<ReturnType<typeof readTargetProject>>; proof: Array<Record<string, unknown>>; error?: unknown }> {
	const startedAt = Date.now();
	const proof: Array<Record<string, unknown>> = [];
	let lastError: unknown;
	let latest: Awaited<ReturnType<typeof readTargetProject>> | undefined;
	while (true) {
		const elapsedMs = Date.now() - startedAt;
		const remainingMs = POST_IMPORT_READBACK_TIMEOUT_MS - elapsedMs;
		if (remainingMs <= 0)
			break;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			latest = await Promise.race([
				readTargetProject(projectUuid),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => reject(new ProjectTreeReadbackTimeoutError('导入后工程树读取在 3000 ms 收敛期限内未返回')), remainingMs);
				}),
			]);
			const changed = !sameTree(before, latest.summary);
			proof.push({ elapsedMs: Date.now() - startedAt, status: 'ok', treeChanged: changed, summary: latest.summary });
			if (changed)
				return { after: latest, proof };
		}
		catch (error) {
			lastError = error;
			proof.push({ elapsedMs: Date.now() - startedAt, status: 'error', error: error instanceof Error ? error.message : String(error) });
			if (error instanceof ProjectIdentityMismatchError || error instanceof ProjectTreeReadbackTimeoutError)
				return { after: latest, proof, error };
		}
		finally {
			if (timeoutId !== undefined)
				clearTimeout(timeoutId);
		}

		const remainingAfterQueryMs = POST_IMPORT_READBACK_TIMEOUT_MS - (Date.now() - startedAt);
		if (remainingAfterQueryMs <= 0)
			break;
		await new Promise<void>(resolve => setTimeout(resolve, Math.min(POST_IMPORT_READBACK_INTERVAL_MS, remainingAfterQueryMs)));
	}
	return { after: latest, proof, error: lastError ?? new Error('导入后工程树在 3000 ms 内没有可确认的变化') };
}

function sameTree(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	return left.projectUuid === right.projectUuid
		&& left.entryCount === right.entryCount
		&& left.uuidCount === right.uuidCount
		&& left.fingerprint === right.fingerprint;
}

async function signatureOf(params: FileRestoreParams, bytes: Uint8Array): Promise<string> {
	const fileHash = await sha256Hex(bytes);
	return sha256Hex(new TextEncoder().encode(JSON.stringify({ targetProjectUuid: params.targetProjectUuid, fileName: params.fileName, fileHash })));
}

let busy = false;

export function isFileRestoreBusy(): boolean {
	return busy;
}

export async function restoreNativeProjectFile(rawParams: Record<string, any>): Promise<Record<string, unknown>> {
	const params = validateFileRestoreParams(rawParams);
	const bytes = decodeBase64(params.base64);
	const signature = await signatureOf(params, bytes);
	const existing = ownValue(readStoredState().operations, params.operationId);
	if (existing) {
		if (existing.inputSignature !== signature)
			fail('operationId 已用于不同文件或目标，拒绝重放');
		return restoreData(existing);
	}
	if (busy)
		fail('文件恢复操作正在执行');
	if (typeof File !== 'function')
		fail('当前环境不支持 File，已在导入前停止');
	busy = true;
	try {
		const before = await readTargetProject(params.targetProjectUuid);
		const file = new File([toArrayBuffer(bytes)], params.fileName, { type: 'application/octet-stream' });
		const record: any = {
			operationId: params.operationId,
			targetProjectUuid: params.targetProjectUuid,
			fileName: params.fileName,
			inputSignature: signature,
			state: 'write_started',
			phase: 'write_started',
			partial: true,
			retryable: false,
			outcome: 'unknown',
			treeBefore: before.summary,
		};
		try {
			await persistOperation(record);
		}
		catch (error) {
			throw new FileRestoreError(`导入前无法持久化操作记录：${error instanceof Error ? error.message : String(error)}`, {
				partial: false,
				retryable: false,
				outcome: 'not_started',
				operationId: params.operationId,
				phase: 'persist_write_started',
			});
		}

		try {
			const rechecked = await readTargetProject(params.targetProjectUuid);
			if (!sameTree(before.summary, rechecked.summary))
				fail('持久化 write_started 后目标工程树发生变化，SDK 导入未调用');
		}
		catch (error) {
			record.state = 'not_started';
			record.phase = 'guard_before_sdk_import';
			record.partial = false;
			record.outcome = 'not_started';
			record.error = error instanceof Error ? error.message : String(error);
			try { await persistOperation(record); }
			catch (storageError) { record.error += `；未能记录停止状态：${storageError instanceof Error ? storageError.message : String(storageError)}`; }
			throw new FileRestoreError(record.error, {
				partial: false,
				retryable: false,
				outcome: 'not_started',
				operationId: params.operationId,
				phase: record.phase,
			});
		}

		let importResult: any;
		let importError: unknown;
		try {
			importResult = await eda.sys_FileManager.importProjectByProjectFile(
				file,
				'JLCEDA Pro',
				undefined,
				{ operation: 'Existing Project', existingProjectUuid: params.targetProjectUuid },
			);
		}
		catch (error) {
			importError = error;
		}

		record.importedProjectUuid = typeof importResult?.uuid === 'string' ? importResult.uuid : undefined;
		if (importError)
			return await persistUnknown(record, 'sdk_import', importError);
		if (!importResult || typeof importResult.uuid !== 'string' || !importResult.uuid)
			return await persistUnknown(record, 'sdk_import_result', 'SDK 未返回有效工程 UUID');
		if (importResult.uuid !== params.targetProjectUuid)
			return await persistUnknown(record, 'result_identity', `SDK 返回工程 ${importResult.uuid}，与目标 ${params.targetProjectUuid} 不符`);
		const readback = await readTargetProjectAfterImport(params.targetProjectUuid, before.summary);
		const after = readback.after;
		record.treeReadbackProof = readback.proof;
		record.treeAfter = after?.summary;
		record.treeChanged = after ? !sameTree(before.summary, after.summary) : undefined;
		if (readback.error)
			return await persistUnknown(record, readback.error instanceof ProjectIdentityMismatchError ? 'project_tree_readback' : (after ? 'project_tree_compare' : 'project_tree_readback'), readback.error);
		if (!after || after.project.uuid !== params.targetProjectUuid)
			return await persistUnknown(record, 'project_tree_readback', '导入后工程身份与目标不符');

		record.state = 'fileImported';
		record.phase = 'metadata_confirmed';
		record.partial = false;
		record.retryable = false;
		record.outcome = 'confirmed';
		record.metadataVerified = true;
		record.contentVerified = false;
		try {
			await persistOperation(record);
		}
		catch (error) {
			return await persistUnknown(record, 'persist_confirmed', error);
		}
		return restoreData(record);
	}
	finally {
		busy = false;
	}
}

export function getFileRestoreOperation(operationId: string): Record<string, unknown> {
	const record = ownValue(readStoredState().operations, operationId);
	if (!record)
		fail(`文件恢复 operationId 不存在：${operationId}`);
	return restoreData(record);
}

export function fileRestoreOperationArgs(params: Record<string, any>): { operationId: string } {
	if (!plainObject(params) || Object.keys(params).length !== 1 || !Object.prototype.hasOwnProperty.call(params, 'operationId'))
		fail('getFileRestoreOperation 仅接受 operationId');
	return { operationId: requireId(params.operationId, 'operationId') };
}
