import {
	applyPcbFootprintRestorePlan,
	applyPcbInstanceStateRestorePlan,
	bindPcbInstanceStateRestoreValues,
	planPcbFootprintRestore,
	planPcbInstanceStateRestore,
	verifyPcbFootprintRestore,
	verifyPcbInstanceStateRestore,
	type FootprintResourceSource,
	type FootprintRestorePlan,
	type PcbInstanceStateRestorePlan,
} from './pcbFootprints';
import {
	captureLegacyFootprintBoard,
	verifyLegacyFootprintBodyReadback,
	type LegacyFootprintBoardCapture,
	type LegacyPcbComponentIdentity,
	type LegacyFootprintBodyMapping,
	type LegacyFootprintBoardAliasProof,
} from './pcbFootprintBody';
import type { LineGroupNormalization, PadCopperState } from './pcbTemplatePhysical';
import { cloneJsonData } from './jsonDataClone';

type JsonObject = Record<string, unknown>;
type RecordValue = { header: JsonObject; data: unknown; lineIndex: number };
type ParsedDocument = { uuid: string; docType: string; effective: Map<string, RecordValue> };

export type TemplateFootprintCapture = {
	projectUuid: string;
	templatePcbUuid: string;
	templateSource: string;
	templateSourceSha256: string;
	components: Array<{ sourceUid: string; sourceComponentId: string; footprintReference?: string; footprintReferenceOrigin?: 'pcb-attr' | 'component-getter' }>;
	sourcePads?: Array<{ sourceUid: string; sourceComponentId: string; pads: PadCopperState[] }>;
	sourcePadReadErrors?: Array<{ sourceUid: string; error: string }>;
	resources: FootprintResourceSource[];
	diagnostics?: MissingFootprintAttributeDiagnostic[];
	legacyBodyCapture?: LegacyFootprintBoardCapture;
	legacyBodyCaptureError?: string;
};

export type MissingFootprintAttributeDiagnostic = {
	sourceUid: string;
	sourceComponentId: string;
	reason: 'missing' | 'duplicate' | 'invalid';
	attributeIds: string[];
	bindingOrigin: 'component-getter';
	getterFootprint?: { libraryUuid: string; uuid: string; name?: string };
	getterError?: string;
	resourceBindingVerified: boolean;
	instanceBodyVerified: false;
	resourceMatches: Array<{ footprintUuid: string; sourceLength: number; sourceDigest: string | null; documentSource: string }>;
	resourceInventory: Array<{ footprintUuid: string | null; sourceLength: number | null; sourceDigest: string | null; documentSource: string | null; error?: string }>;
	resourceReadError?: string;
	actualPads: Array<{ primitiveId: unknown; parentComponentPrimitiveId: unknown; padNumber: unknown; net: unknown; layer: unknown; x: unknown; y: unknown; rotation: unknown; shape: unknown }> | null;
	padReadError?: string;
	reasons: string[];
};

export type PcbFootprintHostResult = {
	status: 'not_started' | 'unknown' | 'confirmed';
	writeAttempted: boolean;
	reason?: string;
	attributeContentVerified: boolean;
	actualPadsReadable: boolean;
	plan?: FootprintRestorePlan;
	verification?: { ok: boolean; noOp: boolean; changedAttributeIds: string[]; error?: string };
	bodyVerification?: { confirmed: boolean; noOp: boolean; referenceRestoreEligible: boolean;
		requiresFinalFootprintVerification: boolean; stateRestoreEligible: boolean; stateRestoreOriginalMismatches?: string[];
		matched: Array<{ sourceUid: string; targetUid: string; footprintUuid: string; associatedRecordCount: number }>;
		mismatches: string[]; referenceRepairMismatches: string[] };
	referenceRestorePhase?: { status: 'not_required' | 'confirmed' | 'unknown'; writeAttempted: boolean };
	instanceStateRestore?: { status: 'not_required' | 'confirmed' | 'unknown'; writeAttempted: boolean;
		changed: Array<{ targetUid: string; field: string }>; error?: string };
	instanceStatePlan?: PcbInstanceStateRestorePlan;
	instanceStateVerification?: { ok: boolean; changed: Array<{ targetUid: string; field: string }>; error?: string };
	targetPads?: Array<{
		sourceUid: string;
		targetUid: string;
		targetComponentId: string;
		pads: Array<{
			primitiveId?: string | number;
			parentComponentPrimitiveId?: string | number;
			padNumber: string;
			net: string;
			layer?: string | number;
			x?: number;
			y?: number;
			rotation?: number;
			shape?: unknown;
			hole?: unknown;
			specialPad?: unknown;
			holeOffsetX?: number | null;
			holeOffsetY?: number | null;
			holeRotation?: number | null;
			geometryComplete?: boolean;
		}>;
	}>;
};

type TypedPadReadback = PadCopperState[];

function fail(message: string): never {
	throw new Error(message);
}

function object(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

function normalizedComponentDegrees(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 角度不是有限数值`);
	const normalized = ((value % 360) + 360) % 360;
	return Object.is(normalized, -0) ? 0 : normalized;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${name} 必须是非空字符串`);
	return value;
}

function state<T>(target: any, getter: string, name: string): T {
	const method = target?.[getter];
	if (typeof method !== 'function') fail(`${name} 缺少 ${getter}`);
	return method.call(target) as T;
}

function parseDocument(source: unknown, expectedUuid: string, expectedType: string): ParsedDocument {
	if (typeof source !== 'string' || !source.trim()) fail(`${expectedType} 源码为空`);
	const records: RecordValue[] = [];
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	const highestByKey = new Map<string, RecordValue>();
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex].replace(/[\r\n]+$/, '');
		if (!line.trim()) continue;
		const separator = line.indexOf('||');
		if (separator < 0) fail(`${expectedType} 源码第 ${lineIndex + 1} 行缺少 ||`);
		let header: unknown;
		let data: unknown;
		try {
			header = JSON.parse(line.slice(0, separator));
			let text = line.slice(separator + 2);
			if (text.endsWith('|')) text = text.slice(0, -1);
			data = text === '' ? '' : JSON.parse(text);
		}
		catch { fail(`${expectedType} 源码第 ${lineIndex + 1} 行 JSON 无效`); }
		if (!object(header) || typeof header.type !== 'string' || !header.type.trim()) fail('源码 header 无效');
		if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim())) fail('源码记录缺少 id');
		if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket))) fail('源码 ticket 无效');
		const record = { header, data, lineIndex };
		records.push(record);
		if (header.type !== 'DOCHEAD') {
			const key = `${header.type}\u0000${String(header.id)}`;
			const prior = highestByKey.get(key);
			if (!prior || Number(header.ticket ?? 0) >= Number(prior.header.ticket ?? 0)) highestByKey.set(key, record);
		}
	}
	const heads = records.filter(record => record.header.type === 'DOCHEAD');
	if (!heads.length || heads.some(record => !object(record.data)
		|| record.data.uuid !== expectedUuid || record.data.docType !== expectedType))
		fail(`DOCHEAD 与指定身份不符：期望 ${expectedType}/${expectedUuid}`);
	const effective = new Map<string, RecordValue>();
	for (const [key, record] of highestByKey) if (record.data !== '') effective.set(key, record);
	return { uuid: expectedUuid, docType: expectedType, effective };
}

async function sha256(source: string): Promise<string> {
	if (!globalThis.crypto?.subtle) fail('当前环境没有 SHA-256 能力');
	const bytes = new TextEncoder().encode(source);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
	if (!globalThis.crypto?.subtle) fail('当前环境没有 SHA-256 能力');
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function currentIdentity(projectUuid: string, pcbUuid: string): Promise<void> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project || project.uuid !== projectUuid) fail('当前工程与指定工程不一致');
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!document || document.uuid !== pcbUuid || document.parentProjectUuid !== projectUuid || document.documentType !== 3)
		fail(`当前活动文档不是指定 PCB：${pcbUuid}`);
}

async function currentPcbSource(projectUuid: string, pcbUuid: string): Promise<string> {
	await currentIdentity(projectUuid, pcbUuid);
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim()) fail('当前 PCB 源码读取为空');
	parseDocument(source, pcbUuid, 'PCB');
	await currentIdentity(projectUuid, pcbUuid);
	return source;
}

function footprintAttributes(document: ParsedDocument, componentId: string): RecordValue[] {
	return [...document.effective.values()].filter(record => record.header.type === 'ATTR' && object(record.data)
		&& record.data.parentId === componentId && record.data.key === 'Footprint');
}

async function requiredFootprintReference(document: ParsedDocument, componentId: string, uid: string): Promise<{ reference: string; origin: 'pcb-attr' | 'component-getter' }> {
	const attributes = footprintAttributes(document, componentId);
	if (attributes.length === 1 && object(attributes[0].data) && typeof attributes[0].data.value === 'string' && attributes[0].data.value.trim())
		return { reference: attributes[0].data.value, origin: 'pcb-attr' };
	if (attributes.length !== 0)
		fail(`原生 Footprint ATTR 缺失、重复或无效：${uid}`);
	const inventory = await eda.sys_FileManager.getDocumentFootprintSources();
	if (!Array.isArray(inventory)) fail(`目标器件 ${uid} 的 Footprint 资源清单不可读`);
	const diagnostic = await diagnoseMissingFootprintAttribute({ sourceUid: uid, sourceComponentId: componentId }, 'missing', [], inventory);
	if (!diagnostic.resourceBindingVerified || diagnostic.resourceMatches.length !== 1)
		fail(`原生 Footprint ATTR 缺失且实例 getter 未唯一绑定资源：${uid}`);
	return { reference: diagnostic.resourceMatches[0].footprintUuid, origin: 'component-getter' };
}

function componentsByUid(document: ParsedDocument): Map<string, RecordValue[]> {
	const result = new Map<string, RecordValue[]>();
	for (const record of document.effective.values()) {
		if (record.header.type !== 'COMPONENT' || !object(record.data) || !object(record.data.attrs)) continue;
		const uid = record.data.attrs['Unique ID'];
		if (typeof uid !== 'string' || !uid.trim()) continue;
		result.set(uid, [...(result.get(uid) ?? []), record]);
	}
	return result;
}

function buildInstanceStateProjection(input: {
	sourceDocument: ParsedDocument;
	targetDocument: ParsedDocument;
	sourceLegacy: LegacyFootprintBoardCapture;
	targetLegacy: LegacyFootprintBoardCapture;
	mappings: Array<{ sourceUid: string; actualTargetUid: string }>;
	existingComponentIds: string[];
}): { eligible: Array<{ targetUid: string; field: 'locked' | 'Footprint.specialColor' }>;
	colorValues: Array<{ targetUid: string; field: 'Footprint.specialColor'; value: string }>;
	projectedTarget: LegacyFootprintBoardCapture } {
	const eligible: Array<{ targetUid: string; field: 'locked' | 'Footprint.specialColor' }> = [];
	const colorValues: Array<{ targetUid: string; field: 'Footprint.specialColor'; value: string }> = [];
	const projectedTarget = cloneJsonData(input.targetLegacy);
	for (let index = 0; index < input.targetLegacy.instances.length; index++) {
		const original = input.targetLegacy.instances[index];
		const projected = projectedTarget.instances[index];
		const associated = new Map(original.associatedRows.map((row, rowIndex) => [row, projected.associatedRows[rowIndex]]));
		projected.componentRow = associated.get(original.componentRow) ?? cloneJsonData(original.componentRow);
		for (const key of ['attributeRows', 'propertyRows', 'padNetRows', 'inactivePadNetCache', 'connectRows', 'instancePrimitiveRows'] as const)
			projected[key] = original[key].map(row => associated.get(row) ?? cloneJsonData(row));
	}
	const sourceNativeByUid = new Map(input.mappings.map(mapping => {
		const source = input.sourceLegacy.instances.find(instance => instance.sourceUid === mapping.sourceUid);
		const sourceNative = source ? input.sourceDocument.effective.get(`COMPONENT\u0000${source.sourceComponentId}`) : undefined;
		const targetNativeMatches = input.targetDocument.effective.values();
		const targetNative = [...targetNativeMatches].filter(record => record.header.type === 'COMPONENT' && object(record.data)
			&& object(record.data.attrs) && record.data.attrs['Unique ID'] === mapping.actualTargetUid);
		const target = input.targetLegacy.instances.find(instance => instance.sourceUid === mapping.actualTargetUid);
		const projected = projectedTarget.instances.find(instance => instance.sourceUid === mapping.actualTargetUid);
		return [mapping.sourceUid, { source, sourceNative, targetNative, target, projected }];
	}));
	for (const mapping of input.mappings) {
		const values = sourceNativeByUid.get(mapping.sourceUid);
		const source = values?.source, sourceNative = values?.sourceNative;
		const targetNative = values?.targetNative ?? [];
		const target = values?.target, projected = values?.projected;
		if (!source || !target || !projected || !object(sourceNative?.data) || targetNative.length !== 1 || !object(targetNative[0].data)) continue;
		const nativeTarget = targetNative[0];
		const targetComponentId = String(nativeTarget.header.id);
		if (input.existingComponentIds.includes(targetComponentId)) continue;
		const nativeTargetData = nativeTarget.data as JsonObject;
		if (sourceNative.data.locked === true && nativeTargetData.locked === false
			&& source.componentRow[8] === 1 && target?.componentRow[8] === 0) {
			eligible.push({ targetUid: mapping.actualTargetUid, field: 'locked' });
			projected.componentRow[8] = source.componentRow[8];
			const associatedComponent = projected.associatedRows.find(row => row[0] === 'COMPONENT' && row[1] === projected.componentRow[1]);
			if (associatedComponent) associatedComponent[8] = source.componentRow[8];
		}
		const sourceAttr = [...input.sourceDocument.effective.values()].filter(record => record.header.type === 'ATTR'
			&& object(record.data) && record.data.parentId === source.sourceComponentId && record.data.key === 'Footprint');
		const targetAttr = [...input.targetDocument.effective.values()].filter(record => record.header.type === 'ATTR'
			&& object(record.data) && record.data.parentId === targetComponentId && record.data.key === 'Footprint');
		if (sourceAttr.length !== 1 || targetAttr.length !== 1 || !object(sourceAttr[0].data) || !object(targetAttr[0].data)) continue;
		const desiredColor = sourceAttr[0].data.specialColor;
		if (typeof desiredColor !== 'string' || !desiredColor.trim() || targetAttr[0].data.specialColor !== null) continue;
		const sourceProps = source.propertyRows.filter(row => row[0] === 'PROP' && row[1] === source.footprintAttributeRow[1]);
		const targetProps = target?.propertyRows.filter(row => row[0] === 'PROP' && row[1] === target.footprintAttributeRow[1]) ?? [];
		if (sourceProps.length !== 1 || sourceProps[0][2] !== desiredColor || targetProps.length !== 0) continue;
		eligible.push({ targetUid: mapping.actualTargetUid, field: 'Footprint.specialColor' });
		colorValues.push({ targetUid: mapping.actualTargetUid, field: 'Footprint.specialColor', value: desiredColor });
		const row = ['PROP', target.footprintAttributeRow[1], desiredColor];
		projected.propertyRows.push(row);
		projected.associatedRows.push(row);
	}
	return { eligible, colorValues, projectedTarget };
}

function legacyComponentIdentities(document: ParsedDocument, components: TemplateFootprintCapture['components']): LegacyPcbComponentIdentity[] {
	return components.map(component => {
		const record = document.effective.get(`COMPONENT\u0000${component.sourceComponentId}`);
		if (!record || !object(record.data) || !object(record.data.attrs)) fail(`模板 COMPONENT 读回缺少几何字段：${component.sourceUid}`);
		const data = record.data;
		for (const key of ['layerId', 'x', 'y', 'angle'])
			if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) fail(`模板 COMPONENT ${component.sourceUid} 的 ${key} 无效`);
		return {
			sourceUid: component.sourceUid,
			sourceComponentId: component.sourceComponentId,
			layerId: data.layerId as number,
			x: data.x as number,
			y: data.y as number,
			angle: data.angle as number,
			nativeAttributes: { ...(data.attrs as JsonObject) },
			...(component.footprintReference ? { nativeFootprintUuid: component.footprintReference,
				nativeFootprintBindingOrigin: component.footprintReferenceOrigin === 'component-getter' ? 'component-getter' : 'native-pcb-attr' } : {}),
		};
	});
}

async function bindLegacyFootprintAliases(projectUuid: string, body: LegacyFootprintBoardCapture,
	components: TemplateFootprintCapture['components'], resourceSources: FootprintResourceSource[], fetchMissingResources: boolean): Promise<void> {
	const boardProof = body.boardAliasProof;
	if (!boardProof || boardProof.projectUuid !== projectUuid || boardProof.boardName !== body.boardName
		|| boardProof.compiledPcbUuid !== body.legacyPcbUuid || boardProof.compiledPcbPath !== body.pcbPath
		|| boardProof.uidPoseBindings.length !== body.instances.length || boardProof.archiveSha256.length !== 64
		|| boardProof.nativeRawBeforeSha256.length !== 64 || boardProof.nativeRawAfterSha256.length !== 64
		|| boardProof.nativeSemanticSha256.length !== 64 || boardProof.nativeReadbackSemanticSha256.length !== 64
		|| boardProof.nativeSemanticSha256 !== boardProof.nativeReadbackSemanticSha256 || boardProof.nativeReadbackVerified !== true)
		fail('legacy Footprint alias 缺少 host 捕获的跨格式 Board/PCB 绑定证明');
	const byUid = new Map<string, TemplateFootprintCapture['components']>();
	for (const component of components) byUid.set(component.sourceUid, [...(byUid.get(component.sourceUid) ?? []), component]);
	for (const legacy of body.instances) {
		const componentMatches = byUid.get(legacy.sourceUid) ?? [];
		if (componentMatches.length !== 1) fail(`legacy Footprint alias 的原生 UID 不唯一：${legacy.sourceUid}`);
		const component = componentMatches[0];
		if (component.sourceComponentId !== legacy.sourceComponentId) fail(`legacy Footprint alias 的原生 COMPONENT 身份不符：${legacy.sourceUid}`);
		const poseBinding = boardProof.uidPoseBindings.filter(item => item.sourceUid === legacy.sourceUid
			&& item.nativeComponentId === component.sourceComponentId && item.legacyComponentId === legacy.legacyComponentId);
		if (poseBinding.length !== 1) fail(`legacy Footprint alias 缺少唯一 UID/组件/位置绑定：${legacy.sourceUid}`);
		const nativeUuid = requiredString(component.footprintReference, `原生 Footprint ATTR ${legacy.sourceUid}`);
		const nativeOrigin = component.footprintReferenceOrigin === 'component-getter' ? 'component-getter' : 'native-pcb-attr';
		if (legacy.footprintAttributeRow[3] !== legacy.legacyComponentId || legacy.footprintAttributeRow[8] !== legacy.footprintUuid
			|| legacy.master.uuid !== legacy.footprintUuid)
			fail(`legacy Footprint ATTR 与完整 master UUID 绑定不符：${legacy.sourceUid}`);
		let sources = resourceSources.filter(resource => resource.footprintUuid === nativeUuid);
		if (!sources.length && fetchMissingResources) {
			const source = await eda.lib_Footprint.getDocumentSource(nativeUuid, projectUuid);
			if (typeof source !== 'string' || !source.trim()) fail(`读取目标原生完整封装资源失败：${nativeUuid}`);
			resourceSources.push({ footprintUuid: nativeUuid, documentSource: source });
			sources = [{ footprintUuid: nativeUuid, documentSource: source }];
		}
		if (sources.length !== 1) fail(`原生 Footprint 完整资源绑定不唯一或缺失：${nativeUuid}`);
		const nativeResource = footprintResourceDocument(sources[0].documentSource, nativeUuid);
		const headRow = legacy.master.rows.find(row => row[0] === 'HEAD');
		if (!headRow) fail(`legacy Footprint master 缺少 HEAD：${legacy.sourceUid}`);
		legacy.legacyFootprintUuid = legacy.footprintUuid;
		legacy.nativeFootprintUuid = nativeUuid;
		legacy.canonicalFootprintReference = nativeUuid;
		legacy.footprintAliasProof = {
			sourceUid: legacy.sourceUid,
			nativeComponentId: component.sourceComponentId,
			legacyComponentId: legacy.legacyComponentId,
			nativeFootprintUuid: nativeUuid,
			legacyFootprintUuid: legacy.footprintUuid,
			nativeFootprintBindingOrigin: nativeOrigin,
			nativeResourceDocumentUuid: nativeResource.uuid,
			nativeResourceSha256: await sha256(sources[0].documentSource),
			legacyBoardPath: body.pcbPath,
			legacyMasterPath: legacy.master.path,
			legacyMasterHeadSha256: await sha256(JSON.stringify(headRow)),
			legacyMasterSha256: legacy.master.sha256,
			boardAliasProof: boardProof,
		};
	}
}

async function captureLegacyBody(projectUuid: string, templatePcbUuid: string, document: ParsedDocument,
	components: TemplateFootprintCapture['components'], nativeSource: string): Promise<LegacyFootprintBoardCapture> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project || project.uuid !== projectUuid) fail('读取旧格式封装 body 时工程身份不符');
	const boards = project.data.filter(item => item.itemType === 'Board') as Array<{
		itemType: string; name: string; parentProjectUuid: string;
		pcb: { uuid: string; name: string; parentProjectUuid: string };
		schematic: { uuid: string; parentProjectUuid: string };
	}>;
	const matchingBoards = boards.filter(item => item.pcb.uuid === templatePcbUuid);
	if (matchingBoards.length !== 1) fail(`当前工程树中模板 PCB 未唯一关联 Board：${templatePcbUuid}`);
	const board = matchingBoards[0];
	if (board.parentProjectUuid !== projectUuid || board.pcb.parentProjectUuid !== projectUuid
		|| board.schematic.parentProjectUuid !== projectUuid)
		fail('模板 Board/SCH/PCB 工程关联不一致');
	const file = await eda.sys_FileManager.getProjectFile(undefined, undefined, 'epro');
	if (!(file instanceof File)) fail('旧格式 epro 导出没有返回 File');
	const archive = await file.arrayBuffer();
	const captured = await captureLegacyFootprintBoard({
		archive,
		board: { boardName: board.name, schematicUuid: board.schematic.uuid, pcbUuid: board.pcb.uuid, pcbName: board.pcb.name },
		components: legacyComponentIdentities(document, components),
	});
	const projectAfter = await eda.dmt_Project.getCurrentProjectInfo();
	if (!projectAfter || projectAfter.uuid !== projectUuid) fail('导出旧格式工程后当前工程身份变化');
	const boardsAfter = projectAfter.data.filter(item => item.itemType === 'Board') as typeof boards;
	const after = boardsAfter.filter(item => item.pcb.uuid === templatePcbUuid);
	if (after.length !== 1 || stableJson({ name: after[0].name, parentProjectUuid: after[0].parentProjectUuid,
		pcbUuid: after[0].pcb.uuid, pcbName: after[0].pcb.name, pcbParent: after[0].pcb.parentProjectUuid,
		schematicUuid: after[0].schematic.uuid, schematicParent: after[0].schematic.parentProjectUuid })
		!== stableJson({ name: board.name, parentProjectUuid: board.parentProjectUuid, pcbUuid: board.pcb.uuid, pcbName: board.pcb.name,
			pcbParent: board.pcb.parentProjectUuid, schematicUuid: board.schematic.uuid, schematicParent: board.schematic.parentProjectUuid }))
		fail('导出旧格式工程期间 native Board/SCH/PCB 配对发生变化');
	await currentIdentity(projectUuid, templatePcbUuid);
	const nativeReadbackSource = await currentPcbSource(projectUuid, templatePcbUuid);
	const nativeReadbackDocument = parseDocument(nativeReadbackSource, templatePcbUuid, 'PCB');
	const sourceRecords = [...document.effective.values()].map(record => ({ type: record.header.type, id: String(record.header.id), data: record.data }))
		.sort((left, right) => `${left.type}\u0000${left.id}`.localeCompare(`${right.type}\u0000${right.id}`));
	const readbackRecords = [...nativeReadbackDocument.effective.values()].map(record => ({ type: record.header.type, id: String(record.header.id), data: record.data }))
		.sort((left, right) => `${left.type}\u0000${left.id}`.localeCompare(`${right.type}\u0000${right.id}`));
	const nativeSemantic = stableJson(sourceRecords);
	const nativeReadbackSemantic = stableJson(readbackRecords);
	if (document.effective.size !== nativeReadbackDocument.effective.size || nativeSemantic !== nativeReadbackSemantic)
		fail('导出旧格式工程期间当前 PCB 有效设计源码发生变化');
	const uidPoseBindings: LegacyFootprintBoardAliasProof['uidPoseBindings'] = [];
	for (const component of components) {
		const native = document.effective.get(`COMPONENT\u0000${component.sourceComponentId}`);
		const legacy = captured.instances.filter(instance => instance.sourceUid === component.sourceUid);
		if (!native || !object(native.data) || legacy.length !== 1 || String(native.header.id) !== component.sourceComponentId
			|| !object(native.data.attrs) || native.data.attrs['Unique ID'] !== component.sourceUid)
			fail(`跨格式 Board alias 的 UID/COMPONENT 身份不唯一：${component.sourceUid}`);
		const instance = legacy[0];
		if (instance.sourceComponentId !== component.sourceComponentId || !object(instance.componentRow[7])
			|| instance.componentRow[7]['Unique ID'] !== component.sourceUid
			|| instance.componentRow[3] !== native.data.layerId || instance.componentRow[4] !== native.data.x
			|| instance.componentRow[5] !== native.data.y
			|| normalizedComponentDegrees(instance.componentRow[6], `${component.sourceUid} legacy COMPONENT[6]`)
				!== normalizedComponentDegrees(native.data.angle, `${component.sourceUid} native angle`))
			fail(`跨格式 Board alias 的 UID/姿态对应不符：${component.sourceUid}`);
		uidPoseBindings.push({ sourceUid: component.sourceUid, nativeComponentId: component.sourceComponentId,
			legacyComponentId: instance.legacyComponentId, layerId: native.data.layerId as number,
		x: native.data.x as number, y: native.data.y as number, angle: native.data.angle as number,
			legacyAngle: instance.componentRow[6] as number });
	}
	captured.boardAliasProof = {
		projectUuid, boardName: board.name, nativePcbUuid: board.pcb.uuid, nativeSchematicUuid: board.schematic.uuid,
		nativePcbName: board.pcb.name, compiledPcbUuid: captured.legacyPcbUuid, compiledPcbPath: captured.pcbPath,
		archiveSha256: await sha256Bytes(archive), nativeRawBeforeSha256: await sha256(nativeSource),
		nativeRawAfterSha256: await sha256(nativeReadbackSource), nativeSemanticSha256: await sha256(nativeSemantic),
		nativeReadbackSemanticSha256: await sha256(nativeReadbackSemantic), nativeEffectiveRecordCount: document.effective.size,
		nativeReadbackVerified: true,
		headUuidAbsent: captured.pcbHeadUuidAbsent, uidPoseBindings,
	};
	return captured;
}

export async function readSourcePads(components: TemplateFootprintCapture['components']): Promise<{
	sourcePads: NonNullable<TemplateFootprintCapture['sourcePads']>;
	errors: NonNullable<TemplateFootprintCapture['sourcePadReadErrors']>;
}> {
	const sourcePads: NonNullable<TemplateFootprintCapture['sourcePads']> = [];
	const errors: NonNullable<TemplateFootprintCapture['sourcePadReadErrors']> = [];
	for (const component of components) {
		try {
			const pins = eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
			if (typeof pins !== 'function') throw new Error('pcb_PrimitiveComponent.getAllPinsByPrimitiveId 不可用');
			const result = await pins.call(eda.pcb_PrimitiveComponent, component.sourceComponentId);
			if (!Array.isArray(result)) throw new Error('源焊盘读回不是数组');
			const pads: PadCopperState[] = result.map((pad: any) => {
				const required = (getter: string, label: string): unknown => state(pad, getter, `源 PCB 焊盘 ${label}`);
				const primitiveId = required('getState_PrimitiveId', 'primitiveId');
				const parentComponentPrimitiveId = required('getState_ParentComponentPrimitiveId', 'parentComponentPrimitiveId');
				const padNumber = required('getState_PadNumber', 'padNumber');
				const rawNet = required('getState_Net', 'net');
				const net = rawNet === undefined ? '' : rawNet;
				if ((typeof primitiveId !== 'string' && typeof primitiveId !== 'number')
					|| (typeof parentComponentPrimitiveId !== 'string' && typeof parentComponentPrimitiveId !== 'number')
					|| String(parentComponentPrimitiveId) !== component.sourceComponentId
					|| typeof padNumber !== 'string' || typeof net !== 'string')
					throw new Error(`源焊盘身份/网络字段无效：${component.sourceUid}`);
				let geometryComplete = true;
				const optional = (getter: string): unknown => {
					if (typeof pad?.[getter] !== 'function') { geometryComplete = false; return undefined; }
					try { return pad[getter](); }
					catch { geometryComplete = false; return undefined; }
				};
				const layer = optional('getState_Layer');
				const x = optional('getState_X');
				const y = optional('getState_Y');
				const rotation = optional('getState_Rotation');
				const shape = optional('getState_Pad');
				const hole = optional('getState_Hole');
				const holeOffsetX = optional('getState_HoleOffsetX');
				const holeOffsetY = optional('getState_HoleOffsetY');
				const holeRotation = optional('getState_HoleRotation');
				const rawSpecialPad = optional('getState_SpecialPad');
				const specialPad = typeof pad?.getState_SpecialPad === 'function' ? rawSpecialPad ?? null : undefined;
				if ((typeof x !== 'number' || !Number.isFinite(x)) || (typeof y !== 'number' || !Number.isFinite(y))
					|| typeof rotation !== 'number' || !Number.isFinite(rotation) || shape === undefined
					|| typeof layer !== 'string' && typeof layer !== 'number'
					|| typeof holeOffsetX !== 'number' || !Number.isFinite(holeOffsetX)
					|| typeof holeOffsetY !== 'number' || !Number.isFinite(holeOffsetY)
					|| typeof holeRotation !== 'number' || !Number.isFinite(holeRotation) || hole === undefined)
					geometryComplete = false;
				return {
					primitiveId, parentComponentPrimitiveId, padNumber, net,
					...(layer !== undefined ? { layer: layer as string | number } : {}),
					...(typeof x === 'number' ? { x } : {}), ...(typeof y === 'number' ? { y } : {}),
					...(typeof rotation === 'number' ? { rotation } : {}), ...(shape !== undefined ? { shape } : {}),
					...(hole !== undefined ? { hole } : {}), ...(specialPad !== undefined ? { specialPad } : {}),
					...(typeof holeOffsetX === 'number' ? { holeOffsetX } : {}), ...(typeof holeOffsetY === 'number' ? { holeOffsetY } : {}),
					...(typeof holeRotation === 'number' ? { holeRotation } : {}), geometryComplete,
				};
			});
			sourcePads.push({ sourceUid: component.sourceUid, sourceComponentId: component.sourceComponentId, pads });
		}
		catch (error) {
			errors.push({ sourceUid: component.sourceUid, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { sourcePads, errors };
}

function docHeadIdentity(source: string, expectedUuid: string, expectedType: string): ParsedDocument {
	return parseDocument(source, expectedUuid, expectedType);
}

function serializable(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.map(item => serializable(item, seen));
	if (typeof value !== 'object') return value === undefined ? null : String(value);
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	const result: JsonObject = {};
	for (const key of Object.keys(value)) {
		const item = (value as JsonObject)[key];
		if (typeof item !== 'function' && item !== undefined) result[key] = serializable(item, seen);
	}
	seen.delete(value);
	return result;
}

async function diagnoseMissingFootprintAttribute(
	component: { sourceUid: string; sourceComponentId: string },
	reason: MissingFootprintAttributeDiagnostic['reason'],
	attributeIds: string[],
	projectFootprintSources: Array<{ footprintUuid: string; documentSource: string }> | undefined,
	resourceReadError?: string,
): Promise<MissingFootprintAttributeDiagnostic> {
	const reasons = [`有效 Footprint ATTR ${reason === 'missing' ? '缺失' : reason === 'duplicate' ? '重复' : '内容无效'}`];
	let getterFootprint: MissingFootprintAttributeDiagnostic['getterFootprint'];
	let getterError: string | undefined;
	let actualPads: MissingFootprintAttributeDiagnostic['actualPads'] = null;
	let padReadError: string | undefined;
	try {
		const found = await eda.pcb_PrimitiveComponent.get([component.sourceComponentId]);
		const instance = Array.isArray(found) && found.length === 1 ? found[0] : undefined;
		if (!instance) throw new Error(`SDK get([source COMPONENT id]) 返回 ${Array.isArray(found) ? found.length : '非数组'} 个器件`);
		const actualId = instance.getState_PrimitiveId();
		if (actualId !== component.sourceComponentId) throw new Error(`SDK primitive ID 与源码 COMPONENT id 不一致：${String(actualId)}`);
		const footprint = instance.getState_Footprint();
		if (footprint !== undefined && footprint !== null) {
			if (typeof footprint !== 'object' || typeof footprint.libraryUuid !== 'string' || typeof footprint.uuid !== 'string')
				throw new Error('getState_Footprint() 返回结构缺少 libraryUuid/uuid');
			getterFootprint = {
				libraryUuid: footprint.libraryUuid,
				uuid: footprint.uuid,
				...(typeof footprint.name === 'string' ? { name: footprint.name } : {}),
			};
		}
		else reasons.push('getState_Footprint() 未返回实例封装');
		try {
			const pins = await instance.getAllPins();
			if (!Array.isArray(pins)) throw new Error('getAllPins() 未返回数组');
			actualPads = pins.map(pin => ({
				primitiveId: serializable(pin.getState_PrimitiveId()),
				parentComponentPrimitiveId: serializable(pin.getState_ParentComponentPrimitiveId()),
				padNumber: serializable(pin.getState_PadNumber()),
				net: serializable(pin.getState_Net()),
				layer: serializable(pin.getState_Layer()),
				x: serializable(pin.getState_X()),
				y: serializable(pin.getState_Y()),
				rotation: serializable(pin.getState_Rotation()),
				shape: serializable(pin.getState_Pad()),
			}));
		}
		catch (error) { padReadError = error instanceof Error ? error.message : String(error); }
	}
	catch (error) {
		getterError = error instanceof Error ? error.message : String(error);
		reasons.push(`读取实例组件/getter 失败：${getterError}`);
	}
	const resourceInventory: MissingFootprintAttributeDiagnostic['resourceInventory'] = [];
	const resourceMatches: MissingFootprintAttributeDiagnostic['resourceMatches'] = [];
	let resourceBindingVerified = false;
	if (resourceReadError) reasons.push(resourceReadError);
	for (const item of projectFootprintSources ?? []) {
		const validKey = typeof item?.footprintUuid === 'string' && Boolean(item.footprintUuid.trim());
		const validSource = typeof item?.documentSource === 'string';
		let sourceDigest: string | null = null;
		if (validSource) {
			try { sourceDigest = await sha256(item.documentSource); }
			catch { /* Keep the complete source when WebCrypto digest is unavailable. */ }
		}
		resourceInventory.push({
			footprintUuid: validKey ? item.footprintUuid : null,
			sourceLength: validSource ? item.documentSource.length : null,
			sourceDigest,
			documentSource: validSource ? item.documentSource : null,
			...(!validKey ? { error: '资源条目缺少有效 footprintUuid' } : {}),
			...(!validSource ? { error: '资源条目缺少完整 documentSource' } : {}),
		});
		if (validKey && validSource && getterFootprint?.uuid === item.footprintUuid)
			resourceMatches.push({ footprintUuid: item.footprintUuid, sourceLength: item.documentSource.length, sourceDigest, documentSource: item.documentSource });
	}
	resourceBindingVerified = Boolean(getterFootprint && resourceMatches.length === 1);
	if (!resourceBindingVerified) reasons.push(`实例 getter 封装与工程资源键未能唯一绑定（匹配数 ${resourceMatches.length}）`);
	else reasons.push('资源键唯一命中，但资源源码尚未证明是当前 PCB 实例完整 body');
	if (padReadError) reasons.push(`读取真实实例 pads 失败：${padReadError}`);
	return {
		sourceUid: component.sourceUid,
		sourceComponentId: component.sourceComponentId,
		reason,
		attributeIds,
		bindingOrigin: 'component-getter',
		...(getterFootprint ? { getterFootprint } : {}),
		...(getterError ? { getterError } : {}),
		resourceBindingVerified,
		instanceBodyVerified: false,
		resourceMatches,
		resourceInventory,
		...(resourceReadError ? { resourceReadError } : {}),
		actualPads,
		...(padReadError ? { padReadError } : {}),
		reasons,
	};
}

function footprintResourceDocument(source: string, reference: string): ParsedDocument {
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	const heads: Array<{ lineIndex: number; uuid: string; docType: string }> = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex].replace(/[\r\n]+$/, '');
		if (!line.trim()) continue;
		const separator = line.indexOf('||');
		if (separator < 0) fail(`原生封装资源第 ${lineIndex + 1} 行缺少 ||`);
		let header: unknown;
		let data: unknown;
		try {
			header = JSON.parse(line.slice(0, separator));
			let text = line.slice(separator + 2);
			if (text.endsWith('|')) text = text.slice(0, -1);
			data = text === '' ? '' : JSON.parse(text);
		}
		catch { fail(`原生封装资源第 ${lineIndex + 1} 行无效`); }
		if (!object(header) || typeof header.type !== 'string') fail(`原生封装资源第 ${lineIndex + 1} 行 header 无效`);
		if (header.type === 'DOCHEAD') {
			if (!object(data) || typeof data.uuid !== 'string' || !data.uuid.trim()
				|| typeof data.docType !== 'string' || !data.docType.trim())
				fail('原生封装资源 DOCHEAD 无效');
			heads.push({ lineIndex, uuid: data.uuid, docType: data.docType });
		}
	}
	if (!heads.length) fail(`原生封装资源没有 DOCHEAD：${reference}`);
	const identities = new Map(heads.map(head => [`${head.docType}\u0000${head.uuid}`, head]));
	const exact = identities.get(`FOOTPRINT\u0000${reference}`);
	const identity = exact ?? (identities.size === 1 && heads[0].docType === 'FOOTPRINT' ? heads[0] : undefined);
	if (!identity) fail(`原生封装资源内容与封装引用不匹配或存在歧义：${reference}`);
	const sections: string[] = [];
	for (let index = 0; index < heads.length; index++) {
		const head = heads[index];
		if (head.uuid !== identity.uuid || head.docType !== identity.docType) continue;
		sections.push(lines.slice(head.lineIndex, heads[index + 1]?.lineIndex ?? lines.length).join(''));
	}
	return parseDocument(sections.join(''), identity.uuid, 'FOOTPRINT');
}

export async function captureTemplateFootprints(input: {
	projectUuid: string;
	templatePcbUuid: string;
}): Promise<TemplateFootprintCapture> {
	const projectUuid = requiredString(input?.projectUuid, 'projectUuid');
	const templatePcbUuid = requiredString(input?.templatePcbUuid, 'templatePcbUuid');
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project || project.uuid !== projectUuid) fail('当前工程与模板工程不一致');
	const tabId = await eda.dmt_EditorControl.openDocument(templatePcbUuid);
	if (typeof tabId !== 'string' || !tabId) fail('打开模板 PCB 失败');
	if (await eda.dmt_EditorControl.activateDocument(tabId) !== true) fail('激活模板 PCB 失败');
	await currentIdentity(projectUuid, templatePcbUuid);
	const templateSource = await eda.sys_FileManager.getDocumentSource();
	if (typeof templateSource !== 'string' || !templateSource.trim()) fail('模板 PCB 源码读取为空');
	const parsed = docHeadIdentity(templateSource, templatePcbUuid, 'PCB');
	const components: TemplateFootprintCapture['components'] = [];
	const missingFootprintAttrs: Array<{
		component: { sourceUid: string; sourceComponentId: string };
		reason: MissingFootprintAttributeDiagnostic['reason'];
		attributeIds: string[];
	}> = [];
	const seenUids = new Set<string>();
	for (const record of parsed.effective.values()) {
		if (record.header.type !== 'COMPONENT' || !object(record.data) || !object(record.data.attrs)) continue;
		const sourceUid = record.data.attrs['Unique ID'];
		if (typeof sourceUid !== 'string' || !sourceUid.trim()) fail(`模板 COMPONENT ${String(record.header.id)} 缺少有效 Unique ID`);
		if (seenUids.has(sourceUid)) fail(`模板 PCB 中 Unique ID 不唯一：${sourceUid}`);
		seenUids.add(sourceUid);
		const componentId = String(record.header.id);
		const attrs = footprintAttributes(parsed, componentId);
		if (attrs.length !== 1) {
			missingFootprintAttrs.push({
				component: { sourceUid, sourceComponentId: componentId },
				reason: attrs.length === 0 ? 'missing' : 'duplicate',
				attributeIds: attrs.map(attr => String(attr.header.id)),
			});
			components.push({ sourceUid, sourceComponentId: componentId });
			continue;
		}
		if (!object(attrs[0].data) || typeof attrs[0].data.value !== 'string' || !attrs[0].data.value.trim()) {
			missingFootprintAttrs.push({
				component: { sourceUid, sourceComponentId: componentId }, reason: 'invalid', attributeIds: [String(attrs[0].header.id)],
			});
			components.push({ sourceUid, sourceComponentId: componentId });
			continue;
		}
		components.push({ sourceUid, sourceComponentId: componentId, footprintReference: attrs[0].data.value as string, footprintReferenceOrigin: 'pcb-attr' });
	}
	if (!components.length) fail('模板 PCB 没有可捕获的有效 COMPONENT');
	const resources: FootprintResourceSource[] = [];
	const seenRefs = new Set<string>();
	for (const component of components) {
		const reference = component.footprintReference;
		if (!reference || seenRefs.has(reference)) continue;
		seenRefs.add(reference);
		const source = await eda.lib_Footprint.getDocumentSource(reference, projectUuid);
		if (typeof source !== 'string' || !source.trim()) fail(`读取工程封装资源失败：${reference}`);
		const resourceDocument = footprintResourceDocument(source, reference);
		if (!resourceDocument.effective.size) fail(`工程封装资源没有有效记录：${component.footprintReference}`);
		resources.push({ footprintUuid: reference, documentSource: source });
	}
	let diagnostics: MissingFootprintAttributeDiagnostic[] | undefined;
	if (missingFootprintAttrs.length) {
		let projectFootprintSources: Array<{ footprintUuid: string; documentSource: string }> | undefined;
		let resourceReadError: string | undefined;
		try {
			const result = await eda.sys_FileManager.getDocumentFootprintSources();
			if (!Array.isArray(result)) throw new Error('getDocumentFootprintSources 返回值不是数组');
			projectFootprintSources = result;
		}
		catch (error) { resourceReadError = error instanceof Error ? error.message : String(error); }
		diagnostics = [];
		for (const missing of missingFootprintAttrs) {
			const diagnostic = await diagnoseMissingFootprintAttribute(
				missing.component, missing.reason, missing.attributeIds, projectFootprintSources, resourceReadError,
			);
			diagnostics.push(diagnostic);
			if (diagnostic.resourceBindingVerified && diagnostic.resourceMatches.length === 1
				&& !seenRefs.has(diagnostic.resourceMatches[0].footprintUuid)) {
				seenRefs.add(diagnostic.resourceMatches[0].footprintUuid);
				resources.push({ footprintUuid: diagnostic.resourceMatches[0].footprintUuid, documentSource: diagnostic.resourceMatches[0].documentSource });
			}
			const captured = components.find(item => item.sourceUid === missing.component.sourceUid);
			if (captured && missing.reason === 'missing' && diagnostic.resourceBindingVerified && diagnostic.resourceMatches.length === 1) {
				captured.footprintReference = diagnostic.resourceMatches[0].footprintUuid;
				captured.footprintReferenceOrigin = 'component-getter';
			}
		}
	}
	let legacyBodyCapture: LegacyFootprintBoardCapture | undefined;
	let legacyBodyCaptureError: string | undefined;
	try {
		const candidate = await captureLegacyBody(projectUuid, templatePcbUuid, parsed, components, templateSource);
		await bindLegacyFootprintAliases(projectUuid, candidate, components, resources, false);
		legacyBodyCapture = candidate;
	}
	catch (error) { legacyBodyCaptureError = error instanceof Error ? error.message : String(error); }
	const sourcePadCapture = await readSourcePads(components);
	await currentIdentity(projectUuid, templatePcbUuid);
	return {
		projectUuid,
		templatePcbUuid,
		templateSource,
		templateSourceSha256: await sha256(templateSource),
		components,
		sourcePads: sourcePadCapture.sourcePads,
		...(sourcePadCapture.errors.length ? { sourcePadReadErrors: sourcePadCapture.errors } : {}),
		resources,
		...(legacyBodyCapture ? { legacyBodyCapture } : {}),
		...(legacyBodyCaptureError ? { legacyBodyCaptureError } : {}),
		...(diagnostics ? { diagnostics } : {}),
	};
}

function normalizePads(component: any, componentId: string): TypedPadReadback {
	const pins = component;
	if (!Array.isArray(pins)) fail(`组件焊盘读回不是数组：${componentId}`);
	return pins.map((pad: any) => {
		const primitiveId = state<string | number>(pad, 'getState_PrimitiveId', 'PCB 焊盘');
		const parentComponentPrimitiveId = state<string | number>(pad, 'getState_ParentComponentPrimitiveId', 'PCB 焊盘');
		const padNumber = state<string>(pad, 'getState_PadNumber', 'PCB 焊盘');
		const net = state<string | undefined>(pad, 'getState_Net', 'PCB 焊盘');
		if (!primitiveId || String(parentComponentPrimitiveId) !== componentId || typeof padNumber !== 'string')
			fail(`PCB 焊盘归属或状态无效：${componentId}`);
		let geometryComplete = true;
		const optional = (getter: string): unknown => {
			if (typeof pad?.[getter] !== 'function') { geometryComplete = false; return undefined; }
			try { return pad[getter](); }
			catch { geometryComplete = false; return undefined; }
		};
		const layer = optional('getState_Layer');
		const x = optional('getState_X');
		const y = optional('getState_Y');
		const rotation = optional('getState_Rotation');
		const shape = optional('getState_Pad');
		const hole = optional('getState_Hole');
		const holeOffsetX = optional('getState_HoleOffsetX');
		const holeOffsetY = optional('getState_HoleOffsetY');
		const holeRotation = optional('getState_HoleRotation');
		const rawSpecialPad = optional('getState_SpecialPad');
		const specialPad = typeof pad?.getState_SpecialPad === 'function' ? rawSpecialPad ?? null : undefined;
		if ((typeof x !== 'number' || !Number.isFinite(x)) || (typeof y !== 'number' || !Number.isFinite(y))
			|| typeof rotation !== 'number' || !Number.isFinite(rotation) || shape === undefined
			|| typeof layer !== 'string' && typeof layer !== 'number'
			|| typeof holeOffsetX !== 'number' || !Number.isFinite(holeOffsetX)
			|| typeof holeOffsetY !== 'number' || !Number.isFinite(holeOffsetY)
			|| typeof holeRotation !== 'number' || !Number.isFinite(holeRotation) || hole === undefined)
			geometryComplete = false;
		return {
			primitiveId, parentComponentPrimitiveId, padNumber, net: net ?? '',
			...(layer !== undefined ? { layer: layer as string | number } : {}),
			...(typeof x === 'number' ? { x } : {}), ...(typeof y === 'number' ? { y } : {}),
			...(typeof rotation === 'number' ? { rotation } : {}), ...(shape !== undefined ? { shape } : {}),
			...(hole !== undefined ? { hole } : {}), ...(specialPad !== undefined ? { specialPad } : {}),
			...(typeof holeOffsetX === 'number' ? { holeOffsetX } : {}), ...(typeof holeOffsetY === 'number' ? { holeOffsetY } : {}),
			...(typeof holeRotation === 'number' ? { holeRotation } : {}), geometryComplete,
		};
	});
}

function nativeLineIdsForGroup(document: ParsedDocument, groupId: string | number): string[] {
	return [...document.effective.values()].filter(record => record.header.type === 'LINE' && object(record.data)
		&& record.data.groupId === groupId).map(record => String(record.header.id)).sort();
}

function validateLineGroupNormalizations(evidence: NonNullable<Parameters<typeof restoreImportedFootprints>[0]['nativeGroupEvidence']>,
	placementOperationId: string, source: ParsedDocument, target: ParsedDocument): LineGroupNormalization[] {
	const normalizations = evidence.lineGroupNormalizations ?? [];
	if (!Array.isArray(normalizations)) fail('原生 GROUP LINE 正规化证据不是数组');
	const keyOf = (sourceId: string | number, targetId: string | number) => `${typeof sourceId}:${String(sourceId)}\u0000${typeof targetId}:${String(targetId)}`;
	const seenPairs = new Set<string>();
	for (const proof of normalizations) {
		if (!proof || proof.status !== 'conditional_on_final_footprint_verification' || proof.placementOperationId !== placementOperationId)
			fail('原生 GROUP LINE 正规化状态或 placementOperationId 不符');
		const pairKey = keyOf(proof.sourceNativeGroupId, proof.targetNativeGroupId);
		if (seenPairs.has(pairKey)) fail('原生 GROUP LINE 正规化组配对重复');
		seenPairs.add(pairKey);
		const sourceIds = proof.sourceLineIds;
		const targetIds = proof.targetLineIds;
		if (!Array.isArray(sourceIds) || !Array.isArray(targetIds) || !Array.isArray(proof.merges) || !Array.isArray(proof.padCovered)
			|| sourceIds.some(id => typeof id !== 'string' || !id.trim()) || targetIds.some(id => typeof id !== 'string' || !id.trim())
			|| new Set(sourceIds).size !== sourceIds.length || new Set(targetIds).size !== targetIds.length
			|| proof.sourceLineCount !== sourceIds.length || proof.targetLineCount !== targetIds.length)
			fail('原生 GROUP LINE 正规化成员快照或数量无效');
		const actualSourceIds = nativeLineIdsForGroup(source, proof.sourceNativeGroupId);
		const actualTargetIds = nativeLineIdsForGroup(target, proof.targetNativeGroupId);
		if (stableJson(actualSourceIds) !== stableJson([...sourceIds].sort())
			|| stableJson(actualTargetIds) !== stableJson([...targetIds].sort()))
			fail(`原生 GROUP LINE 成员快照已变化：${proof.sourceNativeGroupId}→${proof.targetNativeGroupId}`);
		const sourceSet = new Set(sourceIds), targetSet = new Set(targetIds);
		const consumedSourceIds = new Set<string>(), projectedTargetIds = new Set<string>();
		for (const merge of proof.merges) {
			if (!Array.isArray(merge.sourceLineIds) || merge.sourceLineIds.length < 2 || typeof merge.targetLineId !== 'string'
				|| !targetSet.has(merge.targetLineId) || projectedTargetIds.has(merge.targetLineId)
				|| merge.sourceLineIds.some(id => !sourceSet.has(id) || consumedSourceIds.has(id))
				|| new Set(merge.sourceLineIds).size !== merge.sourceLineIds.length)
				fail('原生 GROUP LINE merge 成员重复、越组或无效');
			merge.sourceLineIds.forEach(id => consumedSourceIds.add(id));
			projectedTargetIds.add(merge.targetLineId);
		}
		const associationIds = new Set<string>();
		for (const covered of proof.padCovered) {
			if (typeof covered.sourceLineId !== 'string' || !sourceSet.has(covered.sourceLineId) || consumedSourceIds.has(covered.sourceLineId)
				|| typeof covered.padCoverageAssociationId !== 'string' || !covered.padCoverageAssociationId.trim()
				|| associationIds.has(covered.padCoverageAssociationId))
				fail('原生 GROUP LINE PAD 覆盖证明重复或无效');
			consumedSourceIds.add(covered.sourceLineId);
			associationIds.add(covered.padCoverageAssociationId);
		}
		const remainingSourceCount = sourceIds.length - consumedSourceIds.size;
		const remainingTargetCount = targetIds.length - projectedTargetIds.size;
		const reduction = proof.merges.reduce((sum, merge) => sum + merge.sourceLineIds.length - 1, 0) + proof.padCovered.length;
		if (remainingSourceCount !== remainingTargetCount || proof.targetLineCount !== proof.sourceLineCount - reduction)
			fail('原生 GROUP LINE 正规化计数公式不成立');
	}
	return normalizations;
}

export async function restoreImportedFootprints(input: {
	projectUuid: string;
	targetPcbUuid: string;
	templateCapture: TemplateFootprintCapture;
	sourceUidMappings: Array<{ sourceUid: string; actualTargetUid: string }>;
	existingComponentIds: string[];
	placementOperationId?: string;
	actualExpectedComponents?: Array<{ targetUid: string; designator: string; pads: Array<{ padNumber: string; net: string }> }>;
	targetPropsByUid?: Record<string, Record<string, unknown>>;
	netMappings?: Array<{ sourceNet: string; targetNet: string }>;
	stableTransform?: { rotationDegrees: number; dx: number; dy: number };
	nativeGroupEvidence?: {
		placementOperationId: string;
		componentGroups: Array<{ placementOperationId: string; sourceUid: string; targetUid: string; targetComponentId: string; sourceNativeGroupId: string | number; targetNativeGroupId: string | number }>;
		verifiedGroups: Array<{ placementOperationId: string; sourceNativeGroupId: string | number; targetNativeGroupId: string | number; groupRecord: { type: 'GROUP'; id: string; data: unknown }; memberComponentIds: string[] }>;
		lineGroupNormalizations?: LineGroupNormalization[];
	};
}): Promise<PcbFootprintHostResult> {
	let plan: FootprintRestorePlan | undefined;
	let statePlan: PcbInstanceStateRestorePlan | undefined;
	let writeAttempted = false;
	let referencePhase: NonNullable<PcbFootprintHostResult['referenceRestorePhase']> = { status: 'not_required', writeAttempted: false };
	let instanceStatePhase: NonNullable<PcbFootprintHostResult['instanceStateRestore']> = { status: 'not_required', writeAttempted: false, changed: [] };
	let attributeContentVerified = false;
	let actualPadsReadable = false;
	let verification: PcbFootprintHostResult['verification'];
	let targetPads: PcbFootprintHostResult['targetPads'];
	let bodyVerification: PcbFootprintHostResult['bodyVerification'];
	let stateVerification: Awaited<ReturnType<typeof verifyPcbInstanceStateRestore>> | undefined;
	try {
		const projectUuid = requiredString(input?.projectUuid, 'projectUuid');
		const targetPcbUuid = requiredString(input?.targetPcbUuid, 'targetPcbUuid');
		const capture = input.templateCapture;
		if (!capture || capture.projectUuid !== projectUuid || !capture.templatePcbUuid || !capture.templateSource
			|| !Array.isArray(capture.components) || !Array.isArray(capture.resources))
			fail('模板封装捕获信息无效或来自其它工程');
		if (!Array.isArray(input.sourceUidMappings) || !Array.isArray(input.existingComponentIds))
			fail('sourceUidMappings 与 existingComponentIds 必须是数组');
		const sourceHash = await sha256(capture.templateSource);
		if (sourceHash !== capture.templateSourceSha256) fail('模板源码捕获后已变化');
		const expectedUids = capture.components.map(component => requiredString(component.sourceUid, 'templateCapture.sourceUid'));
		if (new Set(expectedUids).size !== expectedUids.length) fail('模板捕获中 sourceUid 重复');
		const mappingBySource = new Map<string, string>();
		for (const mapping of input.sourceUidMappings) {
			if (!object(mapping)) fail('sourceUidMappings 含无效项');
			const sourceUid = requiredString(mapping.sourceUid, 'sourceUidMappings.sourceUid');
			const actualTargetUid = requiredString(mapping.actualTargetUid, 'sourceUidMappings.actualTargetUid');
			if (mappingBySource.has(sourceUid)) fail(`sourceUid 映射重复：${sourceUid}`);
			mappingBySource.set(sourceUid, actualTargetUid);
		}
		if (mappingBySource.size !== expectedUids.length || expectedUids.some(uid => !mappingBySource.has(uid)))
			fail('sourceUidMappings 未完整覆盖模板中的器件 UID');
		if ([...mappingBySource.values()].some((uid, index, all) => all.indexOf(uid) !== index))
			fail('多个模板器件映射到相同 actualTargetUid');

		const targetSource = await currentPcbSource(projectUuid, targetPcbUuid);
		const target = parseDocument(targetSource, targetPcbUuid, 'PCB');
		const targetByUid = componentsByUid(target);
		const existing = new Set(input.existingComponentIds.map((id, index) => requiredString(id, `existingComponentIds[${index}]`)));
		const bindings: Array<{ sourceUid: string; targetComponentId: string; expectedTargetUid: string }> = [];
		const targetUidByComponent = new Map<string, string>();
		for (const sourceUid of expectedUids) {
			const actualTargetUid = mappingBySource.get(sourceUid)!;
			const matches = targetByUid.get(actualTargetUid) ?? [];
			if (matches.length !== 1) fail(matches.length ? `目标 Unique ID 不唯一：${actualTargetUid}` : `目标 PCB 缺少预期 Unique ID：${actualTargetUid}`);
			const targetComponentId = String(matches[0].header.id);
			if (existing.has(targetComponentId)) fail(`目标器件属于写前已存在集合，拒绝修改：${targetComponentId}`);
			bindings.push({ sourceUid, expectedTargetUid: actualTargetUid, targetComponentId });
			targetUidByComponent.set(targetComponentId, actualTargetUid);
		}

		if (capture.legacyBodyCapture) {
			if (!input.placementOperationId || !input.stableTransform || !Array.isArray(input.netMappings))
				fail('旧格式完整 Footprint body 读回缺少 placement/transform/持久网络映射证据');
			const sourceDocument = parseDocument(capture.templateSource, capture.templatePcbUuid, 'PCB');
			const lineGroupNormalizations = input.nativeGroupEvidence
				? validateLineGroupNormalizations(input.nativeGroupEvidence, input.placementOperationId!, sourceDocument, target)
				: [];
			const sourceGroupIds = new Set([...sourceDocument.effective.values()].filter(record => record.header.type === 'GROUP').map(record => String(record.header.id)));
			const targetGroupIds = new Set([...target.effective.values()].filter(record => record.header.type === 'GROUP').map(record => String(record.header.id)));
			const needsNativeGroupProof = capture.components.some(component => {
				const sourceRecord = sourceDocument.effective.get(`COMPONENT\u0000${component.sourceComponentId}`);
				const targetMatches = targetByUid.get(mappingBySource.get(component.sourceUid) ?? '') ?? [];
				if (!object(sourceRecord?.data) || targetMatches.length !== 1 || !object(targetMatches[0].data)) return true;
				const sourceGroupId = sourceRecord.data.groupId;
				const targetGroupId = targetMatches[0].data.groupId;
				return sourceGroupId !== targetGroupId || targetGroupId !== undefined && targetGroupIds.has(String(targetGroupId))
					&& !sourceGroupIds.has(String(targetGroupId));
			});
		if (needsNativeGroupProof && (!input.nativeGroupEvidence || input.nativeGroupEvidence.placementOperationId !== input.placementOperationId
				|| !Array.isArray(input.nativeGroupEvidence.componentGroups) || !Array.isArray(input.nativeGroupEvidence.verifiedGroups)))
				fail('旧格式完整 Footprint body 读回缺少独立原生 GROUP 绑定证据');
			const nativeGroupEvidence = input.nativeGroupEvidence ?? { placementOperationId: input.placementOperationId, componentGroups: [], verifiedGroups: [] };
			const groupEvidenceBySource = new Map<string, typeof nativeGroupEvidence.componentGroups[number]>();
			for (const evidence of nativeGroupEvidence.componentGroups) {
				if (evidence.placementOperationId !== input.placementOperationId || groupEvidenceBySource.has(evidence.sourceUid))
					fail('原生 GROUP 绑定证据含错置或重复 sourceUid');
				if (!mappingBySource.has(evidence.sourceUid) || mappingBySource.get(evidence.sourceUid) !== evidence.targetUid)
					fail(`原生 GROUP 绑定证据不属于本次 sourceUid mapping：${evidence.sourceUid}`);
				groupEvidenceBySource.set(evidence.sourceUid, evidence);
			}
			const nativeGroupPairs = new Set<string>();
			for (const evidence of nativeGroupEvidence.verifiedGroups) {
				if (evidence.placementOperationId !== input.placementOperationId || evidence.groupRecord.type !== 'GROUP'
					|| evidence.groupRecord.id !== String(evidence.targetNativeGroupId) || new Set(evidence.memberComponentIds).size !== evidence.memberComponentIds.length)
					fail('原生 GROUP 读回证据结构或成员列表无效');
				const currentGroup = target.effective.get(`GROUP\u0000${evidence.groupRecord.id}`);
				if (!currentGroup || stableJson(currentGroup.data) !== stableJson(evidence.groupRecord.data))
					fail(`目标原生 GROUP 读回快照已变化：${evidence.groupRecord.id}`);
				const componentMembers = nativeGroupEvidence.componentGroups.filter(item => item.placementOperationId === input.placementOperationId
					&& item.sourceNativeGroupId === evidence.sourceNativeGroupId && item.targetNativeGroupId === evidence.targetNativeGroupId)
					.map(item => item.targetComponentId).sort();
				if (!componentMembers.length) fail(`原生 GROUP 快照没有本次实例成员绑定：${evidence.groupRecord.id}`);
				const pairKey = `${typeof evidence.sourceNativeGroupId}:${String(evidence.sourceNativeGroupId)}\u0000${typeof evidence.targetNativeGroupId}:${String(evidence.targetNativeGroupId)}`;
				if (nativeGroupPairs.has(pairKey)) fail(`原生 GROUP 快照/成员证据重复：${evidence.groupRecord.id}`);
				nativeGroupPairs.add(pairKey);
				if (stableJson(componentMembers) !== stableJson([...evidence.memberComponentIds].sort()))
					fail(`原生 GROUP 绑定与成员证据不一致：${evidence.groupRecord.id}`);
				const actualTargetMembers = [...target.effective.values()].filter(record => record.header.type === 'COMPONENT'
					&& object(record.data) && record.data.groupId === evidence.targetNativeGroupId)
					.map(record => String(record.header.id)).sort();
				if (stableJson(actualTargetMembers) !== stableJson([...evidence.memberComponentIds].sort()))
					fail(`目标原生 GROUP 成员含遗漏、旧组件或其他实例：${evidence.groupRecord.id}`);
			}
			if (nativeGroupPairs.size !== new Set(nativeGroupEvidence.componentGroups.map(item =>
				`${typeof item.sourceNativeGroupId}:${String(item.sourceNativeGroupId)}\u0000${typeof item.targetNativeGroupId}:${String(item.targetNativeGroupId)}`)).size)
				fail('原生 GROUP 组件绑定缺少完整的唯一 GROUP 快照/成员证据');
			const targetComponents: TemplateFootprintCapture['components'] = [];
			for (const mapping of input.sourceUidMappings) {
				const matches = targetByUid.get(mapping.actualTargetUid) ?? [];
				if (matches.length !== 1 || !object(matches[0].data)) fail(`旧格式 body 验证目标 COMPONENT 不唯一：${mapping.actualTargetUid}`);
			const reference = await requiredFootprintReference(target, String(matches[0].header.id), mapping.actualTargetUid);
			targetComponents.push({ sourceUid: mapping.actualTargetUid, sourceComponentId: String(matches[0].header.id),
				footprintReference: reference.reference, footprintReferenceOrigin: reference.origin });
			}
			const targetLegacy = await captureLegacyBody(projectUuid, targetPcbUuid, target, targetComponents, targetSource);
			await bindLegacyFootprintAliases(projectUuid, targetLegacy, targetComponents, [...capture.resources], true);
			let targetSourceForState = targetSource;
			let targetDocumentForState = target;
			const expectedByUid = new Map((input.actualExpectedComponents ?? []).map(component => [component.targetUid, component]));
			const bodyMappings: LegacyFootprintBodyMapping[] = input.sourceUidMappings.map(mapping => {
				const source = capture.legacyBodyCapture!.instances.find(item => item.sourceUid === mapping.sourceUid);
				const targetRecord = targetByUid.get(mapping.actualTargetUid)?.[0];
				const expected = expectedByUid.get(mapping.actualTargetUid);
				if (!source || !targetRecord || !object(targetRecord.data) || !object(targetRecord.data.attrs)) fail(`完整 body 映射缺少器件属性：${mapping.sourceUid}`);
				if (expected) {
					const designators = [...target.effective.values()].filter(record => record.header.type === 'ATTR' && object(record.data)
						&& record.data.parentId === targetRecord.header.id && record.data.key === 'Designator');
					if (designators.length !== 1 || !object(designators[0].data) || designators[0].data.value !== expected.designator)
						fail(`目标 PCB Designator 与 SCH 网表不符或不唯一：${mapping.actualTargetUid}`);
				}
				const attrs = targetRecord.data.attrs;
				const sourceRecord = sourceDocument.effective.get(`COMPONENT\u0000${source.sourceComponentId}`);
				if (!sourceRecord || !object(sourceRecord.data)) fail(`模板原生 COMPONENT 读回缺失：${mapping.sourceUid}`);
				const groupEvidence = groupEvidenceBySource.get(mapping.sourceUid);
				const sourceNativeGroupId = sourceRecord.data.groupId;
				const targetNativeGroupId = targetRecord.data.groupId;
				if (sourceNativeGroupId === undefined) {
					if (groupEvidence || targetNativeGroupId !== undefined) fail(`未分组器件出现目标 GROUP 绑定：${mapping.sourceUid}`);
				}
				else if (needsNativeGroupProof && (!groupEvidence || groupEvidence.sourceNativeGroupId !== sourceNativeGroupId
					|| groupEvidence.targetNativeGroupId !== targetNativeGroupId
					|| groupEvidence.targetUid !== mapping.actualTargetUid
					|| groupEvidence.targetComponentId !== String(targetRecord.header.id)))
					fail(`原生 GROUP 绑定与目标 COMPONENT 读回不符：${mapping.sourceUid}`);
				else if (groupEvidence) {
					if (groupEvidence.sourceNativeGroupId !== sourceNativeGroupId || groupEvidence.targetNativeGroupId !== targetNativeGroupId
						|| groupEvidence.targetUid !== mapping.actualTargetUid || groupEvidence.targetComponentId !== String(targetRecord.header.id))
						fail(`原生 GROUP 绑定与目标 COMPONENT 读回不符：${mapping.sourceUid}`);
					const verified = nativeGroupEvidence.verifiedGroups.filter(item => item.placementOperationId === input.placementOperationId
						&& item.sourceNativeGroupId === sourceNativeGroupId && item.targetNativeGroupId === targetNativeGroupId);
					if (verified.length !== 1) fail(`原生 GROUP 缺少唯一成员与快照读回：${mapping.sourceUid}`);
				}
				const targetProps = input.targetPropsByUid?.[mapping.actualTargetUid];
				if (!targetProps || !object(targetProps)) fail(`缺少 SCH 已确认的目标器件属性：${mapping.actualTargetUid}`);
				for (const key of ['Channel ID', 'Group ID', 'Reuse Block']) {
					if (!Object.prototype.hasOwnProperty.call(targetProps, key)) continue;
					if (attrs[key] !== targetProps[key]) fail(`目标 PCB 当前 COMPONENT ${key} 与 SCH 身份读回不符：${mapping.actualTargetUid}`);
				}
				return {
					sourceUid: mapping.sourceUid,
					targetUid: mapping.actualTargetUid,
					...(groupEvidence ? { sourceNativeGroupId: groupEvidence.sourceNativeGroupId, targetNativeGroupId: groupEvidence.targetNativeGroupId } : {}),
					targetProps,
					...(expected?.designator ? { targetDesignator: expected.designator } : {}),
					transform: input.stableTransform!,
				};
			});
			bodyVerification = verifyLegacyFootprintBodyReadback({
				template: capture.legacyBodyCapture, target: targetLegacy, mappings: bodyMappings, netMappings: input.netMappings,
				lineGroupNormalizations,
			});
		let stateProjection = buildInstanceStateProjection({ sourceDocument, targetDocument: target, sourceLegacy: capture.legacyBodyCapture,
				targetLegacy, mappings: input.sourceUidMappings, existingComponentIds: input.existingComponentIds });
			let projectedComparison = verifyLegacyFootprintBodyReadback({
				template: capture.legacyBodyCapture, target: stateProjection.projectedTarget, mappings: bodyMappings, netMappings: input.netMappings,
				lineGroupNormalizations,
			});
			const stateEligible = stateProjection.eligible.length > 0 && (projectedComparison.confirmed || projectedComparison.referenceRestoreEligible);
		const stateRestoreOriginalMismatches = stateEligible ? [...bodyVerification.mismatches] : undefined;
		bodyVerification = { ...bodyVerification, stateRestoreEligible: stateEligible,
			...(stateRestoreOriginalMismatches ? { stateRestoreOriginalMismatches } : {}) };
			if (!bodyVerification.confirmed) {
				const shouldRestoreReference = projectedComparison.referenceRestoreEligible || bodyVerification.referenceRestoreEligible;
				if (!shouldRestoreReference && !stateEligible)
					return { status: 'unknown', writeAttempted: false, attributeContentVerified: false, actualPadsReadable: false,
						reason: `旧格式完整 Footprint 实例 body 未确认：${bodyVerification.mismatches.join('; ')}`, bodyVerification,
						referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase };
				if (shouldRestoreReference) {
					referencePhase = { status: 'unknown', writeAttempted: false };
				plan = await planPcbFootprintRestore({
					templateUuid: capture.templatePcbUuid,
					targetUuid: targetPcbUuid,
					templateSource: capture.templateSource,
					targetSource,
					resources: capture.resources,
					bindings,
					existingComponentIds: input.existingComponentIds,
				});
				const writeBaseline = targetSource;
				const prepared = await applyPcbFootprintRestorePlan(plan, writeBaseline);
				if (prepared.noOp)
					return { status: 'unknown', writeAttempted: false, attributeContentVerified: false, actualPadsReadable: false,
						reason: '旧格式确认到封装引用差异，但原生引用恢复计划没有可执行变化', plan, bodyVerification,
						referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase };
				await currentIdentity(projectUuid, targetPcbUuid);
				const immediatelyBeforeWrite = await eda.sys_FileManager.getDocumentSource();
				if (typeof immediatelyBeforeWrite !== 'string' || !immediatelyBeforeWrite.trim()) fail('写入前 PCB 源码读取为空');
				parseDocument(immediatelyBeforeWrite, targetPcbUuid, 'PCB');
				if (await sha256(immediatelyBeforeWrite) !== plan.targetSourceSha256) fail('写入前目标 PCB 源码已变化');
				writeAttempted = true;
				referencePhase = { status: 'unknown', writeAttempted: true };
				const writeResult = await eda.sys_FileManager.setDocumentSource(prepared.source);
				if (writeResult !== true)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: '封装引用 setDocumentSource 未返回 true；不重试、不回滚', plan, bodyVerification,
						referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase };
				const afterSource = await currentPcbSource(projectUuid, targetPcbUuid);
				verification = await verifyPcbFootprintRestore({
					plan,
					beforeTargetSource: writeBaseline,
					afterTargetSource: afterSource,
					templateSource: capture.templateSource,
					resources: capture.resources,
				});
				if (!verification.ok)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: verification.error ?? '封装引用源码读回验证失败', plan, verification, bodyVerification,
						referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase };
				const verifiedTarget = parseDocument(afterSource, targetPcbUuid, 'PCB');
				targetSourceForState = afterSource;
				targetDocumentForState = verifiedTarget;
				const verifiedByUid = componentsByUid(verifiedTarget);
				const verifiedComponents: TemplateFootprintCapture['components'] = [];
				for (const mapping of input.sourceUidMappings) {
					const matches = verifiedByUid.get(mapping.actualTargetUid) ?? [];
					if (matches.length !== 1 || !object(matches[0].data)) fail(`引用写回后目标 COMPONENT 不唯一：${mapping.actualTargetUid}`);
					const reference = await requiredFootprintReference(verifiedTarget, String(matches[0].header.id), mapping.actualTargetUid);
					verifiedComponents.push({ sourceUid: mapping.actualTargetUid, sourceComponentId: String(matches[0].header.id),
						footprintReference: reference.reference, footprintReferenceOrigin: reference.origin });
				}
				const verifiedLegacy = await captureLegacyBody(projectUuid, targetPcbUuid, verifiedTarget, verifiedComponents, afterSource);
				await bindLegacyFootprintAliases(projectUuid, verifiedLegacy, verifiedComponents, [...capture.resources], true);
				const verifiedLineGroupNormalizations = input.nativeGroupEvidence
					? validateLineGroupNormalizations(input.nativeGroupEvidence, input.placementOperationId!, sourceDocument, verifiedTarget)
					: [];
				bodyVerification = verifyLegacyFootprintBodyReadback({
					template: capture.legacyBodyCapture, target: verifiedLegacy, mappings: bodyMappings, netMappings: input.netMappings,
					lineGroupNormalizations: verifiedLineGroupNormalizations,
				});
				stateProjection = buildInstanceStateProjection({ sourceDocument, targetDocument: verifiedTarget, sourceLegacy: capture.legacyBodyCapture,
					targetLegacy: verifiedLegacy, mappings: input.sourceUidMappings, existingComponentIds: input.existingComponentIds });
				projectedComparison = verifyLegacyFootprintBodyReadback({
					template: capture.legacyBodyCapture, target: stateProjection.projectedTarget, mappings: bodyMappings, netMappings: input.netMappings,
					lineGroupNormalizations: verifiedLineGroupNormalizations,
				});
				bodyVerification = { ...bodyVerification, stateRestoreEligible: stateProjection.eligible.length > 0
					&& (projectedComparison.confirmed || projectedComparison.referenceRestoreEligible),
					...(stateRestoreOriginalMismatches ? { stateRestoreOriginalMismatches } : {}) };
				referencePhase = { status: 'confirmed', writeAttempted: true };
				if (!bodyVerification.confirmed && !bodyVerification.stateRestoreEligible)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: `封装引用已写回，但完整旧格式 body 验证失败：${bodyVerification.mismatches.join('; ')}`, plan, verification, bodyVerification,
						referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase };
			}
			if (!bodyVerification.confirmed && bodyVerification.stateRestoreEligible) {
				instanceStatePhase = { status: 'unknown', writeAttempted: false, changed: [] };
				const targetBindings = input.sourceUidMappings.map(mapping => {
					const matches = componentsByUid(targetDocumentForState).get(mapping.actualTargetUid) ?? [];
					if (matches.length !== 1) fail(`实例状态阶段目标 UID 重新绑定不唯一：${mapping.actualTargetUid}`);
					return { targetUid: mapping.actualTargetUid, targetComponentId: String(matches[0].header.id) };
				});
			statePlan = await planPcbInstanceStateRestore({
					targetUuid: targetPcbUuid,
					targetSource: targetSourceForState,
					bindings: targetBindings,
					existingComponentIds: input.existingComponentIds,
					eligible: stateProjection.eligible,
				});
				statePlan = await bindPcbInstanceStateRestoreValues({ plan: statePlan, targetSource: targetSourceForState,
					values: stateProjection.colorValues });
				const preparedState = await applyPcbInstanceStateRestorePlan(statePlan, targetSourceForState);
				if (preparedState.noOp) fail('实例状态差异有证据但恢复计划没有可执行变化');
				await currentIdentity(projectUuid, targetPcbUuid);
				const immediatelyBeforeStateWrite = await eda.sys_FileManager.getDocumentSource();
				if (typeof immediatelyBeforeStateWrite !== 'string' || !immediatelyBeforeStateWrite.trim()) fail('实例状态写入前 PCB 源码读取为空');
				parseDocument(immediatelyBeforeStateWrite, targetPcbUuid, 'PCB');
				if (await sha256(immediatelyBeforeStateWrite) !== statePlan.targetSourceSha256) fail('实例状态写入前目标 PCB 源码已变化');
				writeAttempted = true;
				instanceStatePhase = { status: 'unknown', writeAttempted: true, changed: [] };
				const stateWriteResult = await eda.sys_FileManager.setDocumentSource(preparedState.source);
				if (stateWriteResult !== true)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: '实例状态 setDocumentSource 未返回 true；引用阶段状态已单独报告，不重试、不回滚', plan,
						verification, bodyVerification, referenceRestorePhase: referencePhase,
						instanceStateRestore: { ...instanceStatePhase, error: 'setDocumentSource 未返回 true' }, instanceStatePlan: statePlan };
				const afterStateSource = await currentPcbSource(projectUuid, targetPcbUuid);
				stateVerification = await verifyPcbInstanceStateRestore({ plan: statePlan, beforeTargetSource: targetSourceForState, afterTargetSource: afterStateSource });
				if (!stateVerification.ok)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: stateVerification.error ?? '实例状态源码读回验证失败；不重试、不回滚', plan, verification, bodyVerification,
						referenceRestorePhase: referencePhase,
						instanceStateRestore: { ...instanceStatePhase, error: stateVerification.error }, instanceStatePlan: statePlan,
						instanceStateVerification: stateVerification };
				instanceStatePhase = { status: 'confirmed', writeAttempted: true, changed: stateVerification.changed };
				const finalTarget = parseDocument(afterStateSource, targetPcbUuid, 'PCB');
				const finalByUid = componentsByUid(finalTarget);
				const finalComponents: TemplateFootprintCapture['components'] = [];
				for (const mapping of input.sourceUidMappings) {
					const matches = finalByUid.get(mapping.actualTargetUid) ?? [];
					if (matches.length !== 1 || !object(matches[0].data)) fail(`状态写回后目标 COMPONENT 不唯一：${mapping.actualTargetUid}`);
					const reference = await requiredFootprintReference(finalTarget, String(matches[0].header.id), mapping.actualTargetUid);
					finalComponents.push({ sourceUid: mapping.actualTargetUid, sourceComponentId: String(matches[0].header.id),
						footprintReference: reference.reference, footprintReferenceOrigin: reference.origin });
				}
				const finalLegacy = await captureLegacyBody(projectUuid, targetPcbUuid, finalTarget, finalComponents, afterStateSource);
				await bindLegacyFootprintAliases(projectUuid, finalLegacy, finalComponents, [...capture.resources], true);
				const finalLineNormalizations = input.nativeGroupEvidence
					? validateLineGroupNormalizations(input.nativeGroupEvidence, input.placementOperationId!, sourceDocument, finalTarget) : [];
				bodyVerification = { ...verifyLegacyFootprintBodyReadback({ template: capture.legacyBodyCapture, target: finalLegacy,
					mappings: bodyMappings, netMappings: input.netMappings, lineGroupNormalizations: finalLineNormalizations }),
					stateRestoreEligible: true, ...(stateRestoreOriginalMismatches ? { stateRestoreOriginalMismatches } : {}) };
				if (!bodyVerification.confirmed)
					return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false,
						reason: `实例状态写回后原始完整 body 仍未确认：${bodyVerification.mismatches.join('; ')}`, plan, verification,
						bodyVerification, referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase,
						instanceStatePlan: statePlan, instanceStateVerification: stateVerification };
				targetDocumentForState = finalTarget;
				targetSourceForState = afterStateSource;
			}
			}
			attributeContentVerified = true;
			targetPads = [];
			for (const binding of bindings) {
				const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(binding.targetComponentId);
				const pads = normalizePads(pins, binding.targetComponentId);
				targetPads.push({ sourceUid: binding.sourceUid, targetUid: targetUidByComponent.get(binding.targetComponentId)!, targetComponentId: binding.targetComponentId, pads });
			}
			actualPadsReadable = true;
			return { status: 'confirmed', writeAttempted, attributeContentVerified, actualPadsReadable,
				verification: verification ?? { ok: true, noOp: true, changedAttributeIds: [] }, bodyVerification, targetPads,
				referenceRestorePhase: referencePhase, instanceStateRestore: instanceStatePhase,
				...(plan ? { plan } : {}), ...(statePlan ? { instanceStatePlan: statePlan } : {}),
				...(stateVerification ? { instanceStateVerification: stateVerification } : {}) };
		}

		plan = await planPcbFootprintRestore({
			templateUuid: capture.templatePcbUuid,
			targetUuid: targetPcbUuid,
			templateSource: capture.templateSource,
			targetSource,
			resources: capture.resources,
			bindings,
			existingComponentIds: input.existingComponentIds,
		});
		const writeBaseline = await currentPcbSource(projectUuid, targetPcbUuid);
		const prepared = await applyPcbFootprintRestorePlan(plan, writeBaseline);
		if (!prepared.noOp) {
			await currentIdentity(projectUuid, targetPcbUuid);
			const immediatelyBeforeWrite = await eda.sys_FileManager.getDocumentSource();
			if (typeof immediatelyBeforeWrite !== 'string' || !immediatelyBeforeWrite.trim()) fail('写入前 PCB 源码读取为空');
			parseDocument(immediatelyBeforeWrite, targetPcbUuid, 'PCB');
			if (await sha256(immediatelyBeforeWrite) !== plan.targetSourceSha256) fail('写入前目标 PCB 源码已变化');
			writeAttempted = true;
			const writeResult = await eda.sys_FileManager.setDocumentSource(prepared.source);
			if (writeResult !== true) return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false, reason: 'setDocumentSource 未返回 true；不重试、不回滚', plan };
		}

		const afterSource = await currentPcbSource(projectUuid, targetPcbUuid);
		verification = await verifyPcbFootprintRestore({
			plan,
			beforeTargetSource: writeBaseline,
			afterTargetSource: afterSource,
			templateSource: capture.templateSource,
			resources: capture.resources,
		});
		if (!verification.ok)
			return { status: 'unknown', writeAttempted, attributeContentVerified: false, actualPadsReadable: false, reason: verification.error ?? '目标源码读回验证失败', plan, verification };
		attributeContentVerified = true;
		targetPads = [];
		for (const binding of bindings) {
			const targetComponentId = binding.targetComponentId;
			const typedPins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(targetComponentId);
			const pads = normalizePads(typedPins, targetComponentId);
			targetPads.push({ sourceUid: binding.sourceUid, targetUid: targetUidByComponent.get(targetComponentId)!, targetComponentId, pads });
		}
		actualPadsReadable = true;
		return { status: 'confirmed', writeAttempted, attributeContentVerified, actualPadsReadable, plan, verification, targetPads };
	}
	catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			status: writeAttempted ? 'unknown' : 'not_started',
			writeAttempted,
			attributeContentVerified,
			actualPadsReadable,
			reason: writeAttempted ? `${reason}；源码写入已尝试，未自动重试或回滚` : reason,
			...(plan ? { plan } : {}),
			...(statePlan ? { instanceStatePlan: statePlan } : {}),
			...(stateVerification ? { instanceStateVerification: stateVerification } : {}),
			...(referencePhase ? { referenceRestorePhase: referencePhase } : {}),
			...(instanceStatePhase ? { instanceStateRestore: instanceStatePhase } : {}),
			...(verification ? { verification } : {}),
			...(targetPads ? { targetPads } : {}),
		};
	}
}
