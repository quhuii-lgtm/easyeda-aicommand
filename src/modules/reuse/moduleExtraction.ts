import JSZip from 'jszip';
import { createNativeInspector } from './native-analysis/inspector-core.mjs';
import { createModuleExtractor } from './native-analysis/module-extract-core.mjs';
import { cloneJsonData } from './jsonDataClone';

const CAPTURE_KEY = 'module-reuse:module-extraction:v1';
const inspector = createNativeInspector();
const encoderFileName = 'sha256-utf8.txt';

type JsonMap = Record<string, unknown>;
type CaptureRecord = {
	captureId: string;
	projectUuid: string;
	fileName: string;
	sourceSha: string;
	base64: string;
	availableEpru: string[];
	documentSummary: Array<{ docType: string; uuid: string; rawRecordCount: number; effectiveRecordCount: number; metadata?: JsonMap }>;
};
type ExtractionRecord = {
	operationId: string;
	inputSignature: string;
	result: Record<string, unknown>;
};
type StoredState = { schema: 1; captures: Record<string, CaptureRecord>; operations: Record<string, ExtractionRecord> };

export class ModuleExtractionError extends Error {
	constructor(message: string) { super(message); this.name = 'ModuleExtractionError'; }
}

function fail(message: string): never { throw new ModuleExtractionError(message); }
function object(value: unknown): value is JsonMap { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function id(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${name} 必须是非空字符串`);
	return value;
}
function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return id(value, name);
}
function readState(): StoredState {
	const raw = eda.sys_Storage.getExtensionUserConfig(CAPTURE_KEY);
	if (raw === undefined) return { schema: 1, captures: Object.create(null), operations: Object.create(null) };
	let parsed: unknown;
	try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
	catch { fail('模块提取持久状态不是有效 JSON，已停止'); }
	if (!object(parsed) || parsed.schema !== 1 || !object(parsed.captures) || !object(parsed.operations)) fail('模块提取持久状态结构无效，已停止');
	return { schema: 1, captures: Object.assign(Object.create(null), parsed.captures), operations: Object.assign(Object.create(null), parsed.operations) } as StoredState;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}
async function persistState(next: StoredState): Promise<void> {
	const serialized = JSON.stringify(next);
	if (await eda.sys_Storage.setExtensionUserConfig(CAPTURE_KEY, serialized) !== true) fail('模块提取状态写入失败');
	const readback = eda.sys_Storage.getExtensionUserConfig(CAPTURE_KEY);
	let parsed: unknown;
	try { parsed = typeof readback === 'string' ? JSON.parse(readback) : readback; }
	catch { fail('模块提取状态写后读回不是有效 JSON'); }
	if (canonical(parsed) !== canonical(next)) fail('模块提取状态写后读回不一致');
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}
function bytesToBase64(bytes: Uint8Array): string {
	const step = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += step)
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
	return btoa(binary);
}
async function sha256(value: Uint8Array | string): Promise<string> {
	if (!globalThis.crypto?.subtle) fail('当前环境不支持 SHA-256');
	const bytes = typeof value === 'string' ? new Uint8Array(await new File([value], encoderFileName).arrayBuffer()) : value;
	const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function moduleExtractor() {
	return createModuleExtractor({
		JSZip,
		sha256,
		inspectNativeProject: input => inspector.inspectNativeProject(input) as unknown as ReturnType<Parameters<typeof createModuleExtractor>[0]['inspectNativeProject']>,
		cloneJson: cloneJsonData,
	});
}
function currentProjectUuid(project: unknown): string {
	if (!object(project) || typeof project.uuid !== 'string' || !project.uuid) fail('读取当前工程失败：缺少工程 UUID');
	return project.uuid;
}
async function projectFor(uuid: string): Promise<JsonMap> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!object(project)) fail('读取当前工程失败：SDK 返回空结果');
	if (currentProjectUuid(project) !== uuid) fail('当前工程与请求工程不一致');
	return project;
}
function summarizeDocuments(projectMetadata: JsonMap, epruTextByName: Array<{ fileName: string; source: string }>) {
	const docs = new Map<string, { docType: string; uuid: string; rawRecordCount: number; effectiveRecordCount: number; metadata?: JsonMap }>();
	for (const entry of epruTextByName) {
		const inspection = inspector.inspectNativeProject({ projectMetadata, source: entry.source });
		for (const rawDoc of inspection.documents) {
			const doc = rawDoc;
			if (!['BOARD', 'SCH', 'SCH_PAGE', 'PCB'].includes(doc.docType)) continue;
			if (typeof doc.docType !== 'string' || typeof doc.uuid !== 'string' || typeof doc.rawRecordCount !== 'number' || typeof doc.effectiveRecordCount !== 'number')
				fail(`文档摘要字段无效：${entry.fileName}`);
			const metaRecord = doc.effectiveRecords.find(record => record.header.type === 'META');
			const rawMetadata = object(metaRecord?.data) ? metaRecord.data : undefined;
			const metadata = rawMetadata ? Object.fromEntries(['title', 'name', 'board', 'schematic', 'pcb'].filter(key => rawMetadata[key] !== undefined).map(key => [key, rawMetadata[key]])) : undefined;
			docs.set(`${doc.docType}:${doc.uuid}`, {
				docType: doc.docType,
				uuid: doc.uuid,
				rawRecordCount: doc.rawRecordCount,
				effectiveRecordCount: doc.effectiveRecordCount,
				...(metadata && Object.keys(metadata).length ? { metadata } : {}),
			});
		}
	}
	return [...docs.values()];
}
function toPlainBytes(bytes: Uint8Array): Uint8Array { return new Uint8Array(bytes); }

export type CaptureExtractionSourceParams = { projectUuid: string; fileName?: string; includeSource?: boolean };
export function validateCaptureExtractionSourceParams(params: Record<string, unknown>): CaptureExtractionSourceParams {
	const allowed = ['projectUuid', 'fileName', 'includeSource'];
	if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !('projectUuid' in params)) fail('captureExtractionSource 仅接受 projectUuid、fileName、includeSource');
	const fileName = optionalString(params.fileName, 'fileName');
	if (fileName && /[\\/]/.test(fileName)) fail('fileName 不能包含路径');
	if (params.includeSource !== undefined && typeof params.includeSource !== 'boolean') fail('includeSource 必须是布尔值');
	return { projectUuid: id(params.projectUuid, 'projectUuid'), ...(fileName ? { fileName } : {}), ...(params.includeSource ? { includeSource: true } : {}) };
}

export async function captureExtractionSource(rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
	const params = validateCaptureExtractionSourceParams(rawParams);
	const before = await projectFor(params.projectUuid);
	const requestedName = params.fileName ?? String(before.name ?? before.title ?? 'module-source');
	const exported = await eda.sys_FileManager.getProjectFile(requestedName, undefined, 'epro2');
	if (!(exported instanceof File)) fail('当前工程归档导出失败：SDK 未返回 File');
	const originalBytes = new Uint8Array(await exported.arrayBuffer());
	if (!originalBytes.length) fail('当前工程归档导出为空');
	const sourceSha = await sha256(originalBytes);
	const zip = await JSZip.loadAsync(originalBytes);
	const metadataFile = zip.file('project2.json');
	if (!metadataFile) fail('当前归档缺少 project2.json，无法生成模块选择摘要');
	const projectMetadata = JSON.parse(await metadataFile.async('string')) as unknown;
	if (!object(projectMetadata)) fail('project2.json 不是有效工程对象');
	const availableEpru = Object.keys(zip.files).filter(name => name.toLowerCase().endsWith('.epru') && !zip.files[name].dir).sort();
	if (!availableEpru.length) fail('当前归档未包含 .epru 原生文档');
	const epruTextByName = await Promise.all(availableEpru.map(async name => ({ fileName: name, source: await zip.file(name)!.async('string') })));
	const documentSummary = summarizeDocuments(projectMetadata, epruTextByName);
	const after = await projectFor(params.projectUuid);
	if (currentProjectUuid(after) !== currentProjectUuid(before)) fail('归档导出期间工程身份发生变化');
	const captureId = crypto.randomUUID();
	const fileName = exported.name || `${requestedName.replace(/\.epro2?$/i, '')}.epro2`;
	const record: CaptureRecord = { captureId, projectUuid: params.projectUuid, fileName, sourceSha, base64: bytesToBase64(originalBytes), availableEpru, documentSummary };
	const state = readState();
	state.captures[captureId] = record;
	await persistState(state);
	return { captureId, sourceSha, fileName, availableEpru, documentSummary, ...(params.includeSource ? { base64: record.base64, bytes: originalBytes.byteLength } : {}) };
}

export type ExtractModuleArchiveParams = { operationId: string; projectUuid: string; captureId: string; workcard: Record<string, unknown>; sourceEpru?: string; outputEpru?: string; fileName?: string };
export function validateExtractModuleArchiveParams(params: Record<string, unknown>): ExtractModuleArchiveParams {
	const allowed = ['operationId', 'projectUuid', 'captureId', 'workcard', 'sourceEpru', 'outputEpru', 'fileName'];
	if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || ['operationId', 'projectUuid', 'captureId', 'workcard'].some(key => !(key in params))) fail('extractModuleArchive 需要 operationId、projectUuid、captureId、workcard，可选 sourceEpru、outputEpru、fileName');
	if (!object(params.workcard)) fail('workcard 必须是对象');
	const sourceEpru = optionalString(params.sourceEpru, 'sourceEpru');
	const outputEpru = optionalString(params.outputEpru, 'outputEpru');
	const fileName = optionalString(params.fileName, 'fileName');
	return { operationId: id(params.operationId, 'operationId'), projectUuid: id(params.projectUuid, 'projectUuid'), captureId: id(params.captureId, 'captureId'), workcard: params.workcard, ...(sourceEpru ? { sourceEpru } : {}), ...(outputEpru ? { outputEpru } : {}), ...(fileName ? { fileName } : {}) };
}
function extractionSignature(params: ExtractModuleArchiveParams, sourceSha: string): string {
	return canonical({ projectUuid: params.projectUuid, captureId: params.captureId, sourceSha, sourceEpru: params.sourceEpru, outputEpru: params.outputEpru, fileName: params.fileName, workcard: params.workcard });
}

export async function extractModuleArchive(rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
	const params = validateExtractModuleArchiveParams(rawParams);
	const state = readState();
	const capture = state.captures[params.captureId];
	if (!capture) fail(`captureId 不存在：${params.captureId}`);
	if (capture.projectUuid !== params.projectUuid) fail('captureId 属于其他工程');
	const signature = extractionSignature(params, capture.sourceSha);
	const existing = state.operations[params.operationId];
	if (existing) {
		if (existing.inputSignature !== signature) fail('operationId 已用于不同提取输入，拒绝重放');
		return cloneJsonData(existing.result);
	}
	const card = cloneJsonData(params.workcard);
	if (card.sourceSha !== undefined && card.sourceSha !== capture.sourceSha) fail('workcard.sourceSha 与捕获归档不一致');
	if (card.sourceSha256 !== undefined && card.sourceSha256 !== capture.sourceSha) fail('workcard.sourceSha256 与捕获归档不一致');
	if (card.sourceProjectUuid !== undefined && card.sourceProjectUuid !== capture.projectUuid) fail('workcard.sourceProjectUuid 与捕获工程不一致');
	card.sourceSha = capture.sourceSha;
	card.sourceSha256 = capture.sourceSha;
	card.sourceProjectUuid = capture.projectUuid;
	if (card.resourceAdaptations !== undefined) {
		if (!Array.isArray(card.resourceAdaptations)) fail('workcard.resourceAdaptations 必须是数组');
		const moduleName = object(card.newModule) && typeof card.newModule.name === 'string' && card.newModule.name.trim() ? card.newModule.name.trim() : 'module';
		card.resourceAdaptations = card.resourceAdaptations.map((adaptation, index) => {
			if (!object(adaptation)) fail(`resourceAdaptations[${index}] 必须是对象`);
			return {
				...adaptation,
				newDeviceUuid: adaptation.newDeviceUuid ?? crypto.randomUUID(),
				newFootprintUuid: adaptation.newFootprintUuid ?? crypto.randomUUID(),
				newDeviceName: adaptation.newDeviceName ?? `${moduleName}-Device`,
				newFootprintName: adaptation.newFootprintName ?? `${moduleName}-Footprint`,
			};
		});
	}
	const sourceBytes = Uint8Array.from(atob(capture.base64), character => character.charCodeAt(0));
	let result: Record<string, unknown>;
	try {
		const extraction = await moduleExtractor().extractModuleArchive({ sourceBytes, workcard: card, ...(params.sourceEpru ? { sourceEpru: params.sourceEpru } : {}), ...(params.outputEpru ? { outputEpru: params.outputEpru } : {}) });
		const outputZip = toPlainBytes(extraction.outputZip);
		const defaultName = `${String(object(card.newModule) ? card.newModule.name : 'module')}.epro2`;
		const fileName = params.fileName ?? defaultName;
		if (/[\\/]/.test(fileName) || !/\.epro2?$/i.test(fileName)) fail('fileName 必须是安全的 .epro 或 .epro2 文件名');
		result = {
			state: 'extracted', outcome: 'confirmed', contentImported: false,
			operationId: params.operationId, fileName,
			base64: bytesToBase64(outputZip), sha256: await sha256(outputZip), bytes: outputZip.byteLength,
			proof: extraction.proof,
		};
	}
	catch (error) {
		result = { state: 'failed', outcome: 'not_started', contentImported: false, operationId: params.operationId, error: error instanceof Error ? error.message : String(error) };
	}
	const next = readState();
	next.operations[params.operationId] = { operationId: params.operationId, inputSignature: signature, result };
	await persistState(next);
	return result;
}
