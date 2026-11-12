import { preparePcbInstanceIdentities } from './nativePlacement';
import { forceImportPcbComponents, type NativePcbImportResult } from './nativePcbImport';
import { captureTemplateFootprints, restoreImportedFootprints, type PcbFootprintHostResult, type TemplateFootprintCapture } from './pcbFootprintHost';
import { revalidatePadCoveredLineAssociations, type NativePcbTemplateInstance, type TemplatePhysicalVerification } from './pcbTemplatePhysical';

type JsonObject = Record<string, unknown>;
type IdentityMapping = { sourceUid: string; actualTargetUid: string };
type IdentityContext = {
	templatePcbUuid: string;
	sourceUidMappings: IdentityMapping[];
	netMappings?: Array<{ sourceNet: string; targetNet: string }>;
	netMapOperationId?: string;
	netMappingEvidence?: { status: string; verifiedNoMapRecords?: boolean; mapOperationId?: string; mapOperationIds?: string[]; [key: string]: unknown };
	[key: string]: unknown;
};
type PreparedIdentity = {
	outcome: 'confirmed' | 'unknown' | 'not_started';
	identityRecord?: JsonObject;
	instances?: Array<{ placementOperationId: string; context: IdentityContext }>;
	expectedComponents?: Array<{ targetUid: string; designator: string; pads: Array<{ padNumber: string; net: string }>; [key: string]: unknown }>;
	netlist?: unknown;
	phase?: string;
	reason?: string;
	writeAttempted?: boolean;
	operationCause?: { partial?: boolean; outcome?: string; phase?: string };
	[key: string]: unknown;
};

const STORAGE_KEY = 'module-reuse:pcb-instance-import:v1';

export type PcbInstanceImportParams = {
	operationId: string;
	targetProjectUuid: string;
	targetSchematicUuid: string;
	targetSchematicPageUuid: string;
	targetPcbUuid: string;
	placementOperationIds: string[];
};

export type PcbInstanceImportOperation = {
	operation: 'importPcbInstances';
	operationId: string;
	targetProjectUuid: string;
	args: Omit<PcbInstanceImportParams, 'operationId'>;
	outcome: 'unknown' | 'not_started' | 'confirmed';
	phase: string;
	stage: 'pcb_component_import_and_footprint_reference';
	writeAttempted: boolean;
	identityOperationId: string;
	identityRecord?: JsonObject;
	expectedComponents?: PreparedIdentity['expectedComponents'];
	netlist?: unknown;
	instanceProgress: Array<Record<string, unknown>>;
	templateCaptureDiagnostics?: Array<{ placementOperationId: string; diagnostics: NonNullable<TemplateFootprintCapture['diagnostics']> }>;
	pcbImportResult?: NativePcbImportResult;
	instanceResults: Array<{
		placementOperationId: string;
		result: PcbFootprintHostResult;
		padVerification?: { verified: boolean; targetUids: string[]; mismatches: string[] };
		padCoverageVerification?: { verified: boolean; mismatches: string[] };
	}>;
	layoutRoutingVerified: false;
	saveReloadVerified: false;
	result?: JsonObject;
	error?: string;
};

export type PcbInstanceImportCause = {
	partial: boolean;
	retryable: false;
	outcome: 'unknown' | 'not_started';
	operationId: string;
	phase: string;
};

export class PcbInstanceImportError extends Error {
	readonly operationCause: PcbInstanceImportCause;

	constructor(message: string, operationCause: PcbInstanceImportCause) {
		super(message);
		this.name = 'PcbInstanceImportError';
		this.operationCause = operationCause;
	}
}

export type PcbInstanceImportDependencies = {
	prepareIdentities: (input: PcbInstanceImportParams) => Promise<PreparedIdentity>;
	captureTemplate: (input: { projectUuid: string; templatePcbUuid: string }) => Promise<TemplateFootprintCapture>;
	forceImport: (input: { projectUuid: string; targetPcbUuid: string; schematicUuid: string; expectedComponents: Array<{ targetUid: string; pads: Array<{ padNumber: string; net: string }>; zeroNumberedPadsSource?: { footprintUuid: string; documentSource: string } }>; templateInstances: NativePcbTemplateInstance[] }) => Promise<NativePcbImportResult>;
	restoreFootprints: (input: { projectUuid: string; targetPcbUuid: string; templateCapture: TemplateFootprintCapture; sourceUidMappings: Array<{ sourceUid: string; actualTargetUid: string }>; existingComponentIds: string[]; placementOperationId?: string; actualExpectedComponents?: Array<{ targetUid: string; designator: string; pads: Array<{ padNumber: string; net: string }> }>; targetPropsByUid?: Record<string, Record<string, unknown>>; netMappings?: Array<{ sourceNet: string; targetNet: string }>; stableTransform?: { rotationDegrees: number; dx: number; dy: number }; nativeGroupEvidence?: { placementOperationId: string; componentGroups: TemplatePhysicalVerification['componentGroups']; verifiedGroups: TemplatePhysicalVerification['verifiedGroups']; lineGroupNormalizations: TemplatePhysicalVerification['lineGroupNormalizations'] } }) => Promise<PcbFootprintHostResult>;
	openTargetPcb: (input: { projectUuid: string; targetPcbUuid: string }) => Promise<void>;
	getStoredValue: () => unknown;
	setStoredValue: (value: string) => Promise<unknown>;
};

function plainObject(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message: string): never { throw new Error(message); }

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${name} 必须是非空字符串`);
	return value;
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (plainObject(value)) {
		const result: JsonObject = Object.create(null);
		for (const key of Object.keys(value).sort()) result[key] = sorted(value[key]);
		return result;
	}
	return value;
}

function stable(value: unknown): string { return JSON.stringify(sorted(value)); }

function readStore(deps: PcbInstanceImportDependencies): Record<string, PcbInstanceImportOperation> {
	const raw = deps.getStoredValue();
	if (raw === undefined) return Object.create(null);
	let parsed: unknown;
	try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
	catch { fail('PCB 实例导入状态不是有效 JSON，停止操作'); }
	if (!plainObject(parsed) || parsed.schema !== 1 || !plainObject(parsed.operations))
		fail('PCB 实例导入状态结构无效，停止操作');
	return Object.assign(Object.create(null), parsed.operations);
}

async function writeStore(deps: PcbInstanceImportDependencies, operations: Record<string, PcbInstanceImportOperation>): Promise<void> {
	const next = { schema: 1, operations };
	if (await deps.setStoredValue(JSON.stringify(next)) !== true) fail('PCB 实例导入状态写入未确认');
	const readback = readStore(deps);
	if (stable(readback) !== stable(operations)) fail('PCB 实例导入状态写后读回不一致');
}

function operationArgs(params: PcbInstanceImportParams): PcbInstanceImportOperation['args'] {
	return {
		targetProjectUuid: params.targetProjectUuid,
		targetSchematicUuid: params.targetSchematicUuid,
		targetSchematicPageUuid: params.targetSchematicPageUuid,
		targetPcbUuid: params.targetPcbUuid,
		placementOperationIds: [...params.placementOperationIds],
	};
}

export function validatePcbInstanceImportParams(raw: unknown): PcbInstanceImportParams {
	const keys = ['operationId', 'targetProjectUuid', 'targetSchematicUuid', 'targetSchematicPageUuid', 'targetPcbUuid', 'placementOperationIds'];
	if (!plainObject(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key)))
		fail(`importPcbInstances 参数必须且只能包含：${keys.join(', ')}`);
	const placementOperationIds = raw.placementOperationIds;
	if (!Array.isArray(placementOperationIds) || !placementOperationIds.length)
		fail('placementOperationIds 必须包含至少一个放置操作 ID');
	const normalized = placementOperationIds.map((id, index) => requireId(id, `placementOperationIds[${index}]`));
	if (new Set(normalized).size !== normalized.length) fail('placementOperationIds 不可重复');
	return {
		operationId: requireId(raw.operationId, 'operationId'),
		targetProjectUuid: requireId(raw.targetProjectUuid, 'targetProjectUuid'),
		targetSchematicUuid: requireId(raw.targetSchematicUuid, 'targetSchematicUuid'),
		targetSchematicPageUuid: requireId(raw.targetSchematicPageUuid, 'targetSchematicPageUuid'),
		targetPcbUuid: requireId(raw.targetPcbUuid, 'targetPcbUuid'),
		placementOperationIds: normalized,
	};
}

export function pcbImportOperationArgs(raw: unknown): { operationId: string; targetProjectUuid: string } {
	if (!plainObject(raw) || Object.keys(raw).length !== 2 || !Object.prototype.hasOwnProperty.call(raw, 'operationId')
		|| !Object.prototype.hasOwnProperty.call(raw, 'targetProjectUuid'))
		fail('getPcbImportOperation 仅接受 operationId 和 targetProjectUuid');
	return { operationId: requireId(raw.operationId, 'operationId'), targetProjectUuid: requireId(raw.targetProjectUuid, 'targetProjectUuid') };
}

function validatePreparedIdentity(prepared: PreparedIdentity, params: PcbInstanceImportParams): asserts prepared is PreparedIdentity & {
	identityRecord: JsonObject;
	instances: NonNullable<PreparedIdentity['instances']>;
	expectedComponents: NonNullable<PreparedIdentity['expectedComponents']>;
} {
	if (prepared.outcome !== 'confirmed' || !plainObject(prepared.identityRecord)
		|| !Array.isArray(prepared.instances) || !Array.isArray(prepared.expectedComponents)) fail(prepared.reason ?? 'PCB 身份准备未确认');
	const instanceIds = prepared.instances.map(instance => instance.placementOperationId);
	if (instanceIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(instanceIds).size !== instanceIds.length
		|| stable([...instanceIds].sort()) !== stable([...params.placementOperationIds].sort()))
		fail('身份记录中的 placementOperationIds 与请求不完全一致');
	for (const instance of prepared.instances) {
		const context = instance.context;
		if (!plainObject(context) || typeof context.templatePcbUuid !== 'string' || !context.templatePcbUuid.trim()
			|| !Array.isArray(context.sourceUidMappings) || !Array.isArray(context.netMappings) || !plainObject(context.netMappingEvidence))
			fail(`身份上下文缺少封装 UID 对应或持久网络映射：${instance.placementOperationId}`);
		const sourceUids = context.sourceUidMappings.map(mapping => mapping?.sourceUid);
		const targetUids = context.sourceUidMappings.map(mapping => mapping?.actualTargetUid);
		if (sourceUids.some(uid => typeof uid !== 'string' || !uid.trim())
			|| targetUids.some(uid => typeof uid !== 'string' || !uid.trim())
			|| new Set(sourceUids).size !== sourceUids.length || new Set(targetUids).size !== targetUids.length)
			fail(`身份上下文 UID 映射缺失或重复：${instance.placementOperationId}`);
		if (context.netMappings.some(mapping => !plainObject(mapping) || typeof mapping.sourceNet !== 'string'
			|| typeof mapping.targetNet !== 'string')) fail(`持久网络映射结构无效：${instance.placementOperationId}`);
		const evidence = context.netMappingEvidence;
		if (!Array.isArray(evidence.pendingOrUnknownRecords) || evidence.pendingOrUnknownRecords.length !== 0)
			fail(`网络映射历史含待确认或未知记录：${instance.placementOperationId}`);
		const mapIds = evidence.mapOperationIds;
		if (!Array.isArray(mapIds) || mapIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(mapIds).size !== mapIds.length)
			fail(`网络映射操作 ID 列表无效：${instance.placementOperationId}`);
		if (evidence.status === 'template-net-retained') {
			const ignoredIds = evidence.ignoredNotStartedOperationIds;
			const noMapHistory = evidence.verifiedNoMapRecords === true && mapIds.length === 0
				&& (evidence.mapOperationId === undefined || evidence.mapOperationId === '');
			const safeNoEffectiveHistory = evidence.verifiedNoEffectiveMappings === true && evidence.verifiedNoMapRecords === false
				&& mapIds.length === 0 && Array.isArray(ignoredIds) && ignoredIds.length > 0
				&& ignoredIds.every(id => typeof id === 'string' && Boolean(id.trim())) && new Set(ignoredIds).size === ignoredIds.length;
			if (!noMapHistory && !safeNoEffectiveHistory)
				fail(`模板原网络保留证据状态不一致：${instance.placementOperationId}`);
		}
		else if (evidence.status === 'mapped') {
			if (mapIds.some(id => typeof id !== 'string' || !id.trim())
				|| (!mapIds.length && (typeof evidence.mapOperationId !== 'string' || !evidence.mapOperationId.trim())))
				fail(`网络映射缺少已确认操作记录：${instance.placementOperationId}`);
		}
		else fail(`网络映射缺少已验证状态证据：${instance.placementOperationId}`);
	}
	const targetUids = prepared.expectedComponents.map(component => component?.targetUid);
	if (targetUids.some(uid => typeof uid !== 'string' || !uid.trim()) || new Set(targetUids).size !== targetUids.length)
		fail('完整父 SCH 网表器件 UID 缺失或重复');
	for (const component of prepared.expectedComponents) {
		if (typeof component.designator !== 'string' || !Array.isArray(component.pads)
			|| component.pads.some(pad => !plainObject(pad) || typeof pad.padNumber !== 'string' || !pad.padNumber.trim() || typeof pad.net !== 'string'))
			fail(`父 SCH 网表器件期望焊盘结构无效：${component.targetUid}`);
	}
}

function makeDependencies(): PcbInstanceImportDependencies {
	return {
		prepareIdentities: input => preparePcbInstanceIdentities(input),
		captureTemplate: input => captureTemplateFootprints(input),
		forceImport: input => forceImportPcbComponents(input),
		restoreFootprints: input => restoreImportedFootprints(input),
		openTargetPcb: async ({ projectUuid, targetPcbUuid }) => {
			const project = await eda.dmt_Project.getCurrentProjectInfo();
			if (!project || project.uuid !== projectUuid) fail('当前工程与 PCB 实例导入目标不一致');
			const tabId = await eda.dmt_EditorControl.openDocument(targetPcbUuid);
			if (typeof tabId !== 'string' || !tabId) fail('打开目标 PCB 失败');
			if (await eda.dmt_EditorControl.activateDocument(tabId) !== true) fail('激活目标 PCB 失败');
			const activeProject = await eda.dmt_Project.getCurrentProjectInfo();
			const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
			if (!activeProject || activeProject.uuid !== projectUuid || !document || document.uuid !== targetPcbUuid
				|| document.parentProjectUuid !== projectUuid || document.documentType !== 3) fail('目标 PCB 激活后身份读回不符');
		},
		getStoredValue: () => eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY),
		setStoredValue: value => eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY, value),
	};
}

function resourceForEmptyPads(capture: TemplateFootprintCapture, mapping: IdentityMapping): { footprintUuid: string; documentSource: string } {
	const component = capture.components.find(item => item.sourceUid === mapping.sourceUid);
	if (!component) fail(`模板捕获缺少零编号焊盘来源器件：${mapping.sourceUid}`);
	const resources = capture.resources.filter(item => item.footprintUuid === component.footprintReference);
	if (resources.length !== 1 || typeof resources[0].documentSource !== 'string' || !resources[0].documentSource.trim())
		fail(`模板捕获缺少唯一完整工程封装资源：${component.footprintReference}`);
	return { footprintUuid: resources[0].footprintUuid, documentSource: resources[0].documentSource };
}

function decorateExpectedComponents(
	expectedComponents: NonNullable<PreparedIdentity['expectedComponents']>,
	instances: NonNullable<PreparedIdentity['instances']>,
	captures: Map<string, TemplateFootprintCapture>,
): Array<{ targetUid: string; pads: Array<{ padNumber: string; net: string }>; zeroNumberedPadsSource?: { footprintUuid: string; documentSource: string } }> {
	return expectedComponents.map(expected => {
		if (!Array.isArray(expected.pads)) fail(`网表期望器件 ${expected.targetUid} 缺少 pads 数组`);
		const result: { targetUid: string; pads: Array<{ padNumber: string; net: string }>; zeroNumberedPadsSource?: { footprintUuid: string; documentSource: string } } = {
			targetUid: expected.targetUid,
			pads: expected.pads.map(pad => ({ padNumber: pad.padNumber, net: pad.net })),
		};
		if (result.pads.length) return result;
		const owners = instances.flatMap(instance => instance.context.sourceUidMappings
			.filter(mapping => mapping.actualTargetUid === expected.targetUid)
			.map(mapping => ({ instance, mapping })));
		if (owners.length !== 1) fail(`空焊盘器件 ${expected.targetUid} 没有唯一的实例封装来源映射`);
		const capture = captures.get(owners[0].instance.placementOperationId);
		if (!capture) fail(`缺少实例模板封装捕获：${owners[0].instance.placementOperationId}`);
		result.zeroNumberedPadsSource = resourceForEmptyPads(capture, owners[0].mapping);
		return result;
	});
}

function verifyRestoredTypedPads(
	instance: NonNullable<PreparedIdentity['instances']>[number],
	expectedComponents: NonNullable<PreparedIdentity['expectedComponents']>,
	result: PcbFootprintHostResult,
): { verified: boolean; targetUids: string[]; mismatches: string[] } {
	const mappings = instance.context.sourceUidMappings;
	const targetUids = mappings.map(mapping => mapping.actualTargetUid);
	const mismatches: string[] = [];
	if (!result.attributeContentVerified) mismatches.push('封装属性内容未确认');
	if (!result.actualPadsReadable || !Array.isArray(result.targetPads)) {
		mismatches.push('替换后的 typed 焊盘未读回');
		return { verified: false, targetUids, mismatches };
	}
	const expectedByUid = new Map(expectedComponents.map(expected => [expected.targetUid, expected]));
	const actualByUid = new Map<string, NonNullable<PcbFootprintHostResult['targetPads']>[number][]>();
	for (const pads of result.targetPads) {
		if (typeof pads.targetUid !== 'string' || !targetUids.includes(pads.targetUid)) {
			mismatches.push(`typed 焊盘读回含未映射目标 UID：${String(pads.targetUid)}`);
			continue;
		}
		actualByUid.set(pads.targetUid, [...(actualByUid.get(pads.targetUid) ?? []), pads]);
	}
	for (const targetUid of targetUids) {
		const expected = expectedByUid.get(targetUid);
		const actuals = actualByUid.get(targetUid) ?? [];
		if (!expected) { mismatches.push(`父网表缺少目标 UID：${targetUid}`); continue; }
		if (actuals.length !== 1) { mismatches.push(`typed 焊盘目标 UID 不唯一：${targetUid}`); continue; }
		const actualPads = actuals[0].pads;
		if (!Array.isArray(actualPads) || actualPads.some(pad => !pad || typeof pad.padNumber !== 'string'
			|| (pad.net !== undefined && typeof pad.net !== 'string'))) {
			mismatches.push(`typed 焊盘编号/网络结构无效：${targetUid}`);
			continue;
		}
		const normalizedExpected = [...new Set(expected.pads.filter(pad => pad.padNumber.trim())
			.map(pad => `${pad.padNumber}\u0000${pad.net}`))].sort();
		const normalizedActual = [...new Set(actualPads.filter(pad => pad.padNumber.trim())
			.map(pad => `${pad.padNumber}\u0000${pad.net ?? ''}`))].sort();
		if (stable(normalizedExpected) !== stable(normalizedActual))
			mismatches.push(`${targetUid} 封装替换后 typed 焊盘编号/网络与父网表不符`);
	}
	return { verified: mismatches.length === 0, targetUids, mismatches };
}

function confirmedTargetProps(prepared: PreparedIdentity, targetUids: string[]): Record<string, Record<string, unknown>> {
	if (!plainObject(prepared.netlist) || !plainObject(prepared.netlist.components)) fail('身份准备结果缺少完整 SCH 器件网表属性');
	const expectedByUid = new Map((prepared.expectedComponents ?? []).map(component => [component.targetUid, component]));
	const result: Record<string, Record<string, unknown>> = {};
	for (const uid of targetUids) {
		const component = prepared.netlist.components[uid];
		if (!plainObject(component) || !plainObject(component.props) || component.props['Unique ID'] !== uid)
			fail(`SCH 网表缺少目标 UID 属性证据：${uid}`);
		const expected = expectedByUid.get(uid);
		if (!expected || component.props.Designator !== expected.designator) fail(`SCH 网表位号与准备读回不一致：${uid}`);
		const props: Record<string, unknown> = {};
		for (const key of ['Channel ID', 'Group ID', 'Reuse Block'])
			if (Object.prototype.hasOwnProperty.call(component.props, key)) props[key] = component.props[key];
		result[uid] = props;
	}
	return result;
}

function operationCauseFrom(error: unknown): { partial?: boolean; outcome?: string; phase?: string } | undefined {
	if (!error || typeof error !== 'object' || !('operationCause' in error)) return undefined;
	const cause = (error as { operationCause?: unknown }).operationCause;
	return plainObject(cause) ? cause as { partial?: boolean; outcome?: string; phase?: string } : undefined;
}

export function createPcbInstanceImportService(dependencies: PcbInstanceImportDependencies = makeDependencies()) {
	async function getPcbImportOperation(operationId: string, targetProjectUuid: string): Promise<PcbInstanceImportOperation> {
		const id = requireId(operationId, 'operationId');
		const projectUuid = requireId(targetProjectUuid, 'targetProjectUuid');
		const operation = readStore(dependencies)[id];
		if (!operation) fail(`PCB 实例导入 operationId 不存在：${id}`);
		if (operation.targetProjectUuid !== projectUuid) fail('PCB 实例导入目标工程不符');
		return operation;
	}

	async function importPcbInstances(raw: unknown): Promise<PcbInstanceImportOperation> {
		const params = validatePcbInstanceImportParams(raw);
		const existing = readStore(dependencies)[params.operationId];
		if (existing) {
			if (existing.targetProjectUuid !== params.targetProjectUuid || stable(existing.args) !== stable(operationArgs(params)))
				fail('operationId 已用于不同 PCB 实例导入参数，拒绝重放');
			return existing;
		}
		const identityOperationId = `${params.operationId}:identity`;
		const initial: PcbInstanceImportOperation = {
			operation: 'importPcbInstances', operationId: params.operationId, targetProjectUuid: params.targetProjectUuid,
			args: operationArgs(params), outcome: 'unknown', phase: 'operation_started',
			stage: 'pcb_component_import_and_footprint_reference', writeAttempted: false, identityOperationId,
			instanceProgress: [], instanceResults: [], layoutRoutingVerified: false, saveReloadVerified: false,
		};
		const operations = readStore(dependencies);
		operations[params.operationId] = initial;
		try { await writeStore(dependencies, operations); }
		catch (error) {
			throw new PcbInstanceImportError(error instanceof Error ? error.message : String(error), {
				partial: false, retryable: false, outcome: 'not_started', operationId: params.operationId, phase: 'persist_operation_started',
			});
		}
		let current = initial;
		const persist = async (patch: Partial<PcbInstanceImportOperation>) => {
			current = { ...current, ...patch };
			const next = readStore(dependencies);
			next[params.operationId] = current;
			await writeStore(dependencies, next);
		};
		const stop = async (outcome: 'unknown' | 'not_started', phase: string, error: string): Promise<never> => {
			let finalError = error;
			try { await persist({ outcome, phase, error }); }
			catch (persistError) {
				finalError = `${error}；停止状态持久读回失败：${persistError instanceof Error ? persistError.message : String(persistError)}`;
				current = { ...current, outcome: 'unknown', phase: `${phase}_persist_failed`, error: finalError };
			}
			throw new PcbInstanceImportError(finalError, {
				partial: current.writeAttempted || current.instanceResults.some(item => item.result.writeAttempted),
				retryable: false, outcome: current.outcome === 'unknown' ? 'unknown' : outcome, operationId: params.operationId, phase: current.phase,
			});
		};

		try {
			await persist({ phase: 'identity_preparation_started' });
			const prepared = await dependencies.prepareIdentities({ ...params, operationId: identityOperationId });
			try { validatePreparedIdentity(prepared, params); }
			catch (error) {
			const partial = prepared.outcome === 'unknown' || prepared.outcome === 'confirmed'
				? true : prepared.writeAttempted ?? prepared.operationCause?.partial ?? false;
				if (partial) await persist({ writeAttempted: true });
				return await stop(prepared.outcome === 'not_started' ? 'not_started' : 'unknown', prepared.phase ?? 'identity_preparation', error instanceof Error ? error.message : String(error));
			}
			await persist({ phase: 'identity_prepared', identityRecord: prepared.identityRecord, expectedComponents: prepared.expectedComponents, netlist: prepared.netlist, writeAttempted: true });

			const captures = new Map<string, TemplateFootprintCapture>();
			for (const instance of prepared.instances) {
				await persist({ phase: 'capture_template_started' });
				const capture = await dependencies.captureTemplate({ projectUuid: params.targetProjectUuid, templatePcbUuid: instance.context.templatePcbUuid });
				const sourceUids = new Set(capture.components.map(item => item.sourceUid));
				const mappings = instance.context.sourceUidMappings;
				if (mappings.length !== capture.components.length || mappings.some(mapping => !sourceUids.has(mapping.sourceUid)))
					return await stop('not_started', 'capture_template', `模板捕获未完整覆盖实例 sourceUid：${instance.placementOperationId}`);
				captures.set(instance.placementOperationId, capture);
				await persist({
					phase: 'template_captured',
					instanceProgress: [...current.instanceProgress, {
						placementOperationId: instance.placementOperationId, templatePcbUuid: capture.templatePcbUuid,
						templateSourceSha256: capture.templateSourceSha256, componentCount: capture.components.length,
						resourceKeys: capture.resources.map(resource => resource.footprintUuid),
						...(capture.legacyBodyCapture ? { legacyBody: {
							boardName: capture.legacyBodyCapture.boardName,
							schematicUuid: capture.legacyBodyCapture.schematicUuid,
							legacyPcbUuid: capture.legacyBodyCapture.legacyPcbUuid,
							instances: capture.legacyBodyCapture.instances.map(item => ({ sourceUid: item.sourceUid, footprintUuid: item.footprintUuid, masterSha256: item.master.sha256 })),
						} } : {}),
					...(capture.legacyBodyCaptureError ? { legacyBodyCaptureError: capture.legacyBodyCaptureError } : {}),
					}],
					...(capture.diagnostics?.length ? {
						templateCaptureDiagnostics: [
							...(current.templateCaptureDiagnostics ?? []),
							{ placementOperationId: instance.placementOperationId, diagnostics: capture.diagnostics },
						],
					} : {}),
				});
				if (capture.diagnostics?.length && !capture.legacyBodyCapture) {
					return await stop('unknown', 'template_footprint_body_unverified',
						`模板 Footprint 属性缺失且旧格式完整 PCB body 未绑定：${capture.legacyBodyCaptureError ?? capture.diagnostics.map(item => `${item.sourceUid}(${item.reasons.join('; ')})`).join(' | ')}；诊断已保存，force 未调用`);
				}
			}

			const expectedComponents = decorateExpectedComponents(prepared.expectedComponents, prepared.instances, captures);
		const templateInstances: NativePcbTemplateInstance[] = prepared.instances.map(instance => {
			const capture = captures.get(instance.placementOperationId)!;
			return {
				placementOperationId: instance.placementOperationId,
				templateCapture: {
					templateSource: capture.templateSource,
					components: capture.components.map(component => ({ sourceUid: component.sourceUid, sourceComponentId: component.sourceComponentId })),
					...(capture.sourcePads ? { sourcePads: capture.sourcePads } : {}),
					...(capture.legacyBodyCapture ? { legacyBodyCapture: capture.legacyBodyCapture } : {}),
					resources: capture.resources,
				},
				sourceUidMappings: instance.context.sourceUidMappings.map(mapping => ({ sourceUid: mapping.sourceUid, actualTargetUid: mapping.actualTargetUid })),
				netMappings: instance.context.netMappings!,
			};
		});
			await dependencies.openTargetPcb({ projectUuid: params.targetProjectUuid, targetPcbUuid: params.targetPcbUuid });
			await persist({ phase: 'target_pcb_activated' });
			await persist({ phase: 'force_import_started', writeAttempted: true });
			const importResult = await dependencies.forceImport({
				projectUuid: params.targetProjectUuid, targetPcbUuid: params.targetPcbUuid,
				schematicUuid: params.targetSchematicUuid, expectedComponents, templateInstances,
			});
			await persist({ phase: 'force_import_readback', pcbImportResult: importResult, writeAttempted: true });
			if (importResult.status !== 'confirmed')
				return await stop(importResult.status === 'not_started' ? 'not_started' : 'unknown', 'force_import', importResult.reason ?? 'PCB 器件导入未确认');

			for (const instance of prepared.instances) {
				await persist({ phase: 'footprint_restore_started' });
				const capture = captures.get(instance.placementOperationId)!;
				const stableTransform = importResult.templatePhysicalVerification?.stableTransform
					.find(item => item.placementOperationId === instance.placementOperationId);
				const physicalVerification = importResult.templatePhysicalVerification;
				const restoreResult = await dependencies.restoreFootprints({
					projectUuid: params.targetProjectUuid,
					targetPcbUuid: params.targetPcbUuid,
					templateCapture: capture,
					sourceUidMappings: instance.context.sourceUidMappings.map(mapping => ({ sourceUid: mapping.sourceUid, actualTargetUid: mapping.actualTargetUid })),
					existingComponentIds: importResult.baselineComponentIds,
					placementOperationId: instance.placementOperationId,
					actualExpectedComponents: prepared.expectedComponents.map(component => ({
						targetUid: component.targetUid, designator: component.designator,
						pads: component.pads.map(pad => ({ padNumber: pad.padNumber, net: pad.net })),
					})),
					...(capture.legacyBodyCapture ? { targetPropsByUid: confirmedTargetProps(prepared, instance.context.sourceUidMappings.map(mapping => mapping.actualTargetUid)) } : {}),
					netMappings: instance.context.netMappings,
					...(stableTransform ? { stableTransform: { rotationDegrees: stableTransform.rotationDegrees, dx: stableTransform.dx, dy: stableTransform.dy } } : {}),
					...(physicalVerification ? { nativeGroupEvidence: {
						placementOperationId: instance.placementOperationId,
						componentGroups: physicalVerification.componentGroups.filter(item => item.placementOperationId === instance.placementOperationId),
						verifiedGroups: physicalVerification.verifiedGroups.filter(item => item.placementOperationId === instance.placementOperationId),
						lineGroupNormalizations: (physicalVerification.lineGroupNormalizations ?? []).filter(item => item.placementOperationId === instance.placementOperationId),
					} } : {}),
				});
				const instanceResults = [...current.instanceResults, { placementOperationId: instance.placementOperationId, result: restoreResult }];
				const padVerification = restoreResult.status === 'confirmed'
					? verifyRestoredTypedPads(instance, prepared.expectedComponents, restoreResult)
					: undefined;
				const padCoverageVerification = restoreResult.status === 'confirmed'
					? revalidatePadCoveredLineAssociations(physicalVerification?.padCoveredLineAssociations ?? [], instance.placementOperationId,
						restoreResult.targetPads?.map(item => ({ targetUid: item.targetUid, componentId: item.targetComponentId, pads: item.pads })))
					: undefined;
				if (padVerification) instanceResults[instanceResults.length - 1].padVerification = padVerification;
				if (padCoverageVerification) instanceResults[instanceResults.length - 1].padCoverageVerification = padCoverageVerification;
				await persist({ phase: padVerification ? 'footprint_pad_readback' : 'footprint_restore_readback', instanceResults });
				if (restoreResult.status !== 'confirmed')
					return await stop(restoreResult.status === 'not_started' ? 'not_started' : 'unknown', 'footprint_restore', restoreResult.reason ?? `实例封装恢复未确认：${instance.placementOperationId}`);
				if (!padVerification?.verified)
					return await stop('unknown', 'footprint_pad_verification', `封装属性虽已读回，但替换后的焊盘未通过父网表核对：${padVerification?.mismatches.join('; ') ?? '未验证'}`);
				if (!padCoverageVerification?.verified)
					return await stop('unknown', 'footprint_pad_coverage_verification', `恢复后 PAD 覆盖证据不再成立：${padCoverageVerification?.mismatches.join('; ') ?? '未验证'}`);
			}
			const result: JsonObject = {
				stage: 'pcb_component_import_and_footprint_reference',
				identityRecord: prepared.identityRecord,
				expectedComponents,
				pcbImportResult: importResult,
				instanceResults: current.instanceResults,
				layoutRoutingVerified: false,
				saveReloadVerified: false,
			};
			await persist({ outcome: 'confirmed', phase: 'completed', result });
			return current;
		}
		catch (error) {
			if (error instanceof PcbInstanceImportError) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			const cause = operationCauseFrom(error);
			if (current.phase === 'identity_preparation_started' && cause?.partial === false && cause.outcome === 'not_started')
				return await stop('not_started', cause.phase ?? current.phase, `${reason}；helper 明确报告尚未写入`);
			if (!current.writeAttempted && ['identity_preparation_started', 'force_import_started', 'footprint_restore_started'].includes(current.phase))
				await persist({ writeAttempted: true });
			return await stop('unknown', cause?.phase ?? current.phase, `${reason}；本 operationId 不重发 PCB 写入`);
		}
	}

	return { importPcbInstances, getPcbImportOperation };
}

const defaultService = createPcbInstanceImportService();
export const importPcbInstances = defaultService.importPcbInstances;
export const getPcbImportOperation = defaultService.getPcbImportOperation;
