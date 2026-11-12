import { preparePcbComposition, type PcbCompositionPlanParams } from './pcbCompositionPlan';
import type { PcbCompositionInput } from './pcbComposition';
import { parseSourceLog, resolveRecords } from './sourcelog';
import { readSourcePads } from './pcbFootprintHost';

type JsonObject = Record<string, unknown>;
const PLAN_PREFIX = 'module-reuse:composition-plan:v1:';
function object(value: unknown): value is JsonObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function sourceContent(source: string): unknown {
	const parsed = parseSourceLog(source);
	return { uuid: parsed.uuid, docType: parsed.docType, records: [...resolveRecords(parsed)]
		.filter(([, record]) => !['CANVAS', 'ACTIVE_LAYER'].includes(record.header.type))
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, record]) => {
		const { ticket: _ticket, ...header } = record.header;
		return { key, header, data: record.data };
	}) };
}
function id(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
	return value;
}
function normalizeDeviceBinding(value: unknown): { libraryUuid: string; uuid: string } {
	if (!object(value)) throw new Error('来源器件缺少可读的实际器件引用');
	const libraryUuid = id(value.libraryUuid, '来源器件 libraryUuid');
	const rawUuid = value.uuid;
	const uuid = typeof rawUuid === 'string' ? id(rawUuid, '来源器件 uuid')
		: object(rawUuid) ? id(rawUuid.uuid, '来源器件 uuid.uuid')
			: id(undefined, '来源器件 uuid');
	return { libraryUuid, uuid };
}
function corroborateDeviceBinding(records: ReturnType<typeof resolveRecords<JsonObject>> extends Map<any, infer R> ? R[] : never,
	componentId: string, bindingUuid: string): void {
	const component = records.find(record => record.header.type === 'COMPONENT' && record.header.id === componentId);
	if (!component || !object(component.data) || !object(component.data.attrs)) throw new Error(`来源组件 ${componentId} 缺少可核对的原生引用`);
	const references: string[] = [];
	const deviceName = component.data.attrs.DeviceName;
	if (deviceName !== undefined) {
		if (typeof deviceName !== 'string') throw new Error(`来源组件 ${componentId} DeviceName 格式无效`);
		let parsed: unknown;
		try { parsed = JSON.parse(deviceName); } catch { throw new Error(`来源组件 ${componentId} DeviceName JSON 无效`); }
		if (!object(parsed)) throw new Error(`来源组件 ${componentId} DeviceName JSON 无效`);
		references.push(id(parsed.uuid, `来源组件 ${componentId} DeviceName.uuid`));
	}
	const deviceAttrs = records.filter(record => record.header.type === 'ATTR' && object(record.data)
		&& record.data.parentId === componentId && record.data.key === 'Device');
	if (deviceAttrs.length > 1) throw new Error(`来源组件 ${componentId} Device ATTR 不唯一`);
	if (deviceAttrs.length === 1) {
		if (!object(deviceAttrs[0].data)) throw new Error(`来源组件 ${componentId} Device ATTR 无效`);
		references.push(id(deviceAttrs[0].data.value, `来源组件 ${componentId} Device ATTR.value`));
	}
	if (references.some(reference => reference !== bindingUuid)) throw new Error(`来源组件 ${componentId} 的实际器件引用与原生 DeviceName/Device ATTR 冲突`);
}
export type PrepareCompositionParams = Omit<PcbCompositionPlanParams, 'source' | 'sourcePads' | 'deviceBindings' | 'targetComponents' | 'standalonePads' | 'sourceArcCaptures' | 'sourceViaCaptures' | 'sourceRuleConfiguration'> & { targetSchematicPageUuid: string };
export function validatePrepareCompositionParams(raw: unknown): PrepareCompositionParams {
	if (!object(raw)) throw new Error('组合准备参数必须是对象');
	for (const key of ['operationId', 'projectUuid', 'sourcePcbUuid', 'targetPcbUuid', 'targetSchematicPageUuid']) id(raw[key], key);
	if (!Array.isArray(raw.uidMappings) || !Array.isArray(raw.netMappings) || !object(raw.transform)) throw new Error('需要 UID、网络映射和放置坐标');
	return { operationId: raw.operationId as string, projectUuid: raw.projectUuid as string, sourcePcbUuid: raw.sourcePcbUuid as string,
		targetPcbUuid: raw.targetPcbUuid as string, targetSchematicPageUuid: raw.targetSchematicPageUuid as string,
		uidMappings: raw.uidMappings as PrepareCompositionParams['uidMappings'], netMappings: raw.netMappings as PrepareCompositionParams['netMappings'],
		transform: raw.transform as PrepareCompositionParams['transform'] };
}
async function projectGuard(projectUuid: string): Promise<any> {
	const current = await eda.dmt_Project.getCurrentProjectInfo();
	if (!current || current.uuid !== projectUuid) throw new Error('当前工程与组合目标不符');
	return current;
}
function checkBoardPair(project: any, params: PrepareCompositionParams): void {
	const boards = (project.data ?? []) as any[];
	const targetBoards = boards.filter(board => board?.pcb?.uuid === params.targetPcbUuid
		&& board?.schematic?.page?.some((page: any) => page.uuid === params.targetSchematicPageUuid));
	if (targetBoards.length !== 1) throw new Error('目标原理图页与 PCB 未在工程树中唯一配对');
	if (!boards.some(board => board?.pcb?.uuid === params.sourcePcbUuid)) throw new Error('来源 PCB 不在当前工程；先使用已实现的文件恢复入口取回来源');
}
async function openDocument(projectUuid: string, documentUuid: string, type: 1 | 3): Promise<void> {
	await projectGuard(projectUuid);
	const tabId = await eda.dmt_EditorControl.openDocument(documentUuid);
	if (!tabId || await eda.dmt_EditorControl.activateDocument(tabId) !== true) throw new Error('无法打开并激活组合文档');
	await projectGuard(projectUuid);
	const current = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!current || current.uuid !== documentUuid || current.parentProjectUuid !== projectUuid || current.documentType !== type) throw new Error('组合文档身份不符');
}
async function readRuleConfiguration(): Promise<JsonObject> {
	const result: unknown = await eda.pcb_Drc.getCurrentRuleConfiguration();
	if (!object(result) || !object(result.config)) throw new Error('无法读取当前 PCB 规则配置');
	return result.config;
}
function targetBlindRuleSnapshot(config: JsonObject, rules: NonNullable<PcbCompositionInput['requiredBlindRules']>): JsonObject {
	const physics = object(config.Physics) ? config.Physics : {};
	const blindGroup = object(physics['Blind/Buried Via']) ? physics['Blind/Buried Via'] : null;
	const blindVia = blindGroup && object(blindGroup.blindVia) ? blindGroup.blindVia : null;
	const table = blindVia && Array.isArray(blindVia.table) ? blindVia.table : [];
	const rows: JsonObject = Object.create(null);
	for (const name of [...new Set(rules.map(rule => rule.name))]) rows[name] = table.filter((row: unknown) => object(row) && row.name === name);
	const sizeGroup = object(physics['Via Size']) ? physics['Via Size'] : {};
	const sizes: JsonObject = Object.create(null);
	for (const name of [...new Set(rules.map(rule => rule.viaSizeRule))]) sizes[name] = Object.hasOwn(sizeGroup, name) ? sizeGroup[name] : null;
	return { rows, sizes };
}
function checkSourceRuleDependencies(config: JsonObject, input: PcbCompositionInput): void {
	const physics = object(config.Physics) ? config.Physics : {};
	const blindGroup = object(physics['Blind/Buried Via']) ? physics['Blind/Buried Via'] : {};
	const blindVia = object(blindGroup.blindVia) ? blindGroup.blindVia : {};
	const table = Array.isArray(blindVia.table) ? blindVia.table : [];
	const sizeGroup = object(physics['Via Size']) ? physics['Via Size'] : {};
	for (const rule of input.requiredBlindRules ?? []) {
		const rows = table.filter((row: unknown) => object(row) && row.name === rule.name);
		const size = sizeGroup[rule.viaSizeRule];
		if (rows.length !== 1 || !object(rows[0]) || rows[0].startLayer !== rule.startLayer || rows[0].endLayer !== rule.endLayer
			|| rows[0].viaSizeRule !== rule.viaSizeRule || stable(size) !== stable(rule.typedViaSizeConfig)) throw new Error(`来源盲埋孔规则依赖在准备后变化：${rule.name}`);
	}
}

/** Prepare in the extension. The caller supplies identities and placement, not SDK source code. */
export async function prepareComposition(raw: unknown): Promise<JsonObject> {
	const params = validatePrepareCompositionParams(raw);
	const project = await projectGuard(params.projectUuid);
	checkBoardPair(project, params);
	await openDocument(params.projectUuid, params.sourcePcbUuid, 3);
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source) throw new Error('来源 PCB 内容为空');
	const sourceRecords = [...resolveRecords<JsonObject>(parseSourceLog(source)).values()];
	const sourceRuleConfiguration = await readRuleConfiguration();
	const nativeArcs = sourceRecords.filter(item => item.header.type === 'ARC');
	const sourceArcCaptures: NonNullable<PcbCompositionPlanParams['sourceArcCaptures']> = [];
	for (const record of nativeArcs) {
		const getArc = (eda.pcb_PrimitiveArc as any)?.get;
		if (typeof getArc !== 'function') throw new Error('当前 SDK 缺少 ARC typed getter');
		const arc = await getArc.call(eda.pcb_PrimitiveArc, String(record.header.id));
		if (!arc || String(arc.getState_PrimitiveId?.()) !== String(record.header.id)) throw new Error(`来源 ARC typed getter 未按原生 ID 读回：${String(record.header.id)}`);
		sourceArcCaptures.push({ sourceId: String(record.header.id), typed: {
			primitiveId: String(arc.getState_PrimitiveId()), net: arc.getState_Net(), layer: arc.getState_Layer(),
			startX: arc.getState_StartX(), startY: arc.getState_StartY(), endX: arc.getState_EndX(), endY: arc.getState_EndY(),
			arcAngle: arc.getState_ArcAngle(), lineWidth: arc.getState_LineWidth(), interactiveMode: arc.getState_InteractiveMode(), primitiveLock: arc.getState_PrimitiveLock(),
		} });
	}
	const nativeStandalonePads = sourceRecords.filter(item => item.header.type === 'PAD' && object(item.data) && item.data.parentId == null);
	const standalonePads: NonNullable<PcbCompositionPlanParams['standalonePads']> = [];
	for (const record of nativeStandalonePads) {
		const sourceId = String(record.header.id);
		const getPad = (eda.pcb_PrimitivePad as any)?.get;
		if (typeof getPad !== 'function') throw new Error('当前 SDK 缺少独立 PAD typed getter');
		const pad = await getPad.call(eda.pcb_PrimitivePad, sourceId);
		if (!pad || String(pad.getState_PrimitiveId?.()) !== sourceId) throw new Error(`来源独立 PAD typed getter 未按原生 ID 读回：${sourceId}`);
		standalonePads.push({ sourceId, data: record.data as JsonObject, typed: {
			primitiveId: String(pad.getState_PrimitiveId()), layer: pad.getState_Layer(), padNumber: pad.getState_PadNumber(), net: pad.getState_Net(),
			x: pad.getState_X(), y: pad.getState_Y(), rotation: pad.getState_Rotation(), pad: pad.getState_Pad(), hole: pad.getState_Hole(),
			holeOffsetX: pad.getState_HoleOffsetX(), holeOffsetY: pad.getState_HoleOffsetY(), holeRotation: pad.getState_HoleRotation(),
			metallization: pad.getState_Metallization(), padType: pad.getState_PadType(), specialPad: pad.getState_SpecialPad(),
			maskExpansion: pad.getState_SolderMaskAndPasteMaskExpansion(), heatWelding: pad.getState_HeatWelding(), primitiveLock: pad.getState_PrimitiveLock(),
		} });
	}
	const nativeVias = sourceRecords.filter(item => item.header.type === 'VIA');
	const sourceViaCaptures: NonNullable<PcbCompositionPlanParams['sourceViaCaptures']> = [];
	for (const record of nativeVias) {
		const sourceId = String(record.header.id);
		const getVia = (eda.pcb_PrimitiveVia as any)?.get;
		if (typeof getVia !== 'function') throw new Error('当前 SDK 缺少 VIA typed getter');
		const via = await getVia.call(eda.pcb_PrimitiveVia, sourceId);
		if (!via || String(via.getState_PrimitiveId?.()) !== sourceId) throw new Error(`来源 VIA typed getter 未按原生 ID 读回：${sourceId}`);
		sourceViaCaptures.push({ sourceId, typed: {
			primitiveId: String(via.getState_PrimitiveId()), net: via.getState_Net(), x: via.getState_X(), y: via.getState_Y(),
			holeDiameter: via.getState_HoleDiameter(), diameter: via.getState_Diameter(), viaType: via.getState_ViaType(),
			blindRuleName: via.getState_DesignRuleBlindViaName(), solderMaskExpansion: via.getState_SolderMaskExpansion(), primitiveLock: via.getState_PrimitiveLock(),
		} });
	}
	const typed = await eda.pcb_PrimitiveComponent.getAll();
	const deviceBindings: PcbCompositionPlanParams['deviceBindings'] = [];
	const sourceOwners: Array<{ sourceUid: string; sourceComponentId: string }> = [];
	for (const component of typed) {
		const sourceUid = component.getState_UniqueId();
		const binding = normalizeDeviceBinding(component.getState_Component());
		const sourceComponentId = component.getState_PrimitiveId();
		if (!sourceUid || !sourceComponentId) throw new Error('来源器件缺少可读的 UID 或图元 ID');
		corroborateDeviceBinding(sourceRecords, sourceComponentId, binding.uuid);
		deviceBindings.push({ sourceUid, component: binding });
		sourceOwners.push({ sourceUid, sourceComponentId });
	}
	const sourcePadCapture = await readSourcePads(sourceOwners);
	if (sourcePadCapture.errors.length) throw new Error(`来源焊盘读取失败：${sourcePadCapture.errors.map(item => `${item.sourceUid}: ${item.error}`).join('; ')}`);
	await openDocument(params.projectUuid, params.targetSchematicPageUuid, 1);
	const file = await eda.sch_ManufactureData.getNetlistFile('module-composition-plan', 'JLCEDA' as ESYS_NetlistType);
	if (!file) throw new Error('目标原理图网表导出返回空结果');
	const netlist: unknown = JSON.parse(await file.text());
	if (!object(netlist) || !object(netlist.components)) throw new Error('目标原理图网表缺少组件表');
	const prepared = preparePcbComposition({ ...params, source, sourcePads: sourcePadCapture.sourcePads, standalonePads, sourceArcCaptures, sourceViaCaptures, sourceRuleConfiguration, deviceBindings,
		targetComponents: netlist.components as PcbCompositionPlanParams['targetComponents'] });
	await openDocument(params.projectUuid, params.targetPcbUuid, 3);
	const targetRules = targetBlindRuleSnapshot(await readRuleConfiguration(), prepared.input.requiredBlindRules ?? []);
	const planId = globalThis.crypto.randomUUID().replaceAll('-', '');
	const plan = { schema: 1, planId, params, input: prepared.input, source, targetComponents: netlist.components, targetRules,
		unsupported: prepared.unsupported, deferred: prepared.deferred, retainedTargetSettings: prepared.retainedTargetSettings };
	const key = PLAN_PREFIX + planId;
	if (await eda.sys_Storage.setExtensionUserConfig(key, JSON.stringify(plan)) !== true) throw new Error('组合计划保存未确认');
	const readback = readCompositionPlan(planId, params.projectUuid, params.targetPcbUuid);
	if (JSON.stringify(readback) !== JSON.stringify(plan)) throw new Error('组合计划保存后读回不一致');
	return { planId, operationId: params.operationId, projectUuid: params.projectUuid, targetPcbUuid: params.targetPcbUuid,
		ready: prepared.unsupported.length === 0, components: prepared.input.components.length,
		pads: prepared.input.components.reduce((sum, item) => sum + item.pads.length, 0), lines: prepared.input.lines.length,
		vias: prepared.input.vias.length, strings: prepared.input.strings.length, attributes: prepared.input.attributes.length,
		arcs: prepared.input.arcs?.length ?? 0, standalonePads: prepared.input.standalonePads?.length ?? 0, requiredBlindRules: prepared.input.requiredBlindRules?.length ?? 0,
		unsupported: prepared.unsupported, deferred: prepared.deferred, retainedTargetSettings: prepared.retainedTargetSettings,
		pcbCreated: false, saveReloadVerified: false };
}

function readCompositionPlan(planId: string, projectUuid: string, targetPcbUuid: string): JsonObject {
	const stored = eda.sys_Storage.getExtensionUserConfig(PLAN_PREFIX + id(planId, 'planId'));
	const plan: unknown = typeof stored === 'string' ? JSON.parse(stored) : stored;
	if (!object(plan) || plan.schema !== 1 || plan.planId !== planId || !object(plan.input)) throw new Error('组合计划不存在或结构无效');
	if (plan.input.projectUuid !== projectUuid || plan.input.targetPcbUuid !== targetPcbUuid) throw new Error('组合计划属于其他工程或 PCB');
	return plan;
}
export function compositionPlanArgs(raw: unknown): { planId: string; projectUuid: string; targetPcbUuid: string } {
	if (!object(raw)) throw new Error('组合执行参数必须是对象');
	return { planId: id(raw.planId, 'planId'), projectUuid: id(raw.projectUuid, 'projectUuid'), targetPcbUuid: id(raw.targetPcbUuid, 'targetPcbUuid') };
}
export async function readPreparedComposition(raw: unknown): Promise<PcbCompositionInput> {
	const params = compositionPlanArgs(raw);
	const plan = readCompositionPlan(params.planId, params.projectUuid, params.targetPcbUuid);
	if (!Array.isArray(plan.unsupported) || plan.unsupported.length) throw new Error('组合计划有尚未接通的实际对象，停止本次写入；请查看准备结果');
	const savedParams = plan.params as unknown as PrepareCompositionParams;
	checkBoardPair(await projectGuard(params.projectUuid), savedParams);
	await openDocument(params.projectUuid, savedParams.sourcePcbUuid, 3);
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || typeof plan.source !== 'string' || stable(sourceContent(source)) !== stable(sourceContent(plan.source))) throw new Error('来源内容在准备后变化，请重新准备');
	checkSourceRuleDependencies(await readRuleConfiguration(), plan.input as unknown as PcbCompositionInput);
	await openDocument(params.projectUuid, savedParams.targetSchematicPageUuid, 1);
	const file = await eda.sch_ManufactureData.getNetlistFile('module-composition-check', 'JLCEDA' as ESYS_NetlistType);
	if (!file) throw new Error('执行前无法读取实际目标网表');
	const netlist: unknown = JSON.parse(await file.text());
	if (!object(netlist) || stable(netlist.components) !== stable(plan.targetComponents)) throw new Error('目标网表在准备后变化，请重新准备');
	await openDocument(params.projectUuid, params.targetPcbUuid, 3);
	checkBoardPair(await projectGuard(params.projectUuid), savedParams);
	const requiredRules = (plan.input as unknown as PcbCompositionInput).requiredBlindRules ?? [];
	if (!object(plan.targetRules) || stable(targetBlindRuleSnapshot(await readRuleConfiguration(), requiredRules)) !== stable(plan.targetRules)) throw new Error('目标盲埋孔规则配置在准备后变化，请重新准备');
	return plan.input as unknown as PcbCompositionInput;
}
