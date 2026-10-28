import type { ICommandDef } from '../engine/types';
import {
	collectPotentialConflicts,
	compareSilkscreenSourceSnapshots,
	normalizeSdkBox,
	padSides,
	silkSide,
	validateSilkscreenCheckParams,
} from '../engine/silkscreenCheck';
import type { BBox, CheckedBoxObject } from '../engine/silkscreenCheck';
import type { GeometryHost } from '../pcb/geometryHost';
import { createGeometryHost } from '../pcb/geometryHost';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';
import { analyzeFootprintArcBoardParticipation, analyzeManufacturingMaskOverlapParticipation, analyzePadMaskOpeningAssociations, analyzeSilkscreenGerber } from '../pcb/silkscreenGerber';
import type { GerberLayerGeometry } from '../pcb/silkscreenGerber';
import { locateManufacturingSourceCandidates } from '../engine/silkscreenSourceLocations';
import { analyzeFootprintSilkscreen, compareFootprintSourceSummaries, extractFootprintPadMaskCandidates, findMissingProjectLibraryFootprintUuids, invalidateFootprintSilkscreenSource, projectComponentFootprintSilkUnsupported, readEmbeddedFootprintSources, readProjectLibrarySources, summarizeFootprintSourceSet, unavailableFootprintSilkscreen } from '../engine/footprintSilkscreen';

function state<T = unknown>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`];
	return typeof getter === 'function' ? getter.call(object) as T : undefined;
}

function padMaskSnapshot(pad: any, componentId: string, box: BBox | undefined): any {
	try {
		const shape = state<unknown[]>(pad, 'Pad');
		const layer = state(pad, 'Layer');
		const copyState = (name: string): unknown => {
			const value = state(pad, name);
			return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
		};
		let maskExpansionState: { status: string; value?: unknown; reason?: string };
		try {
			const getter = pad?.getState_SolderMaskAndPasteMaskExpansion;
			if (typeof getter !== 'function') maskExpansionState = { status: 'unavailable' };
			else {
				const value = getter.call(pad);
				maskExpansionState = { status: value === null ? 'null' : 'value', value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) };
			}
		}
		catch (error) { maskExpansionState = { status: 'exception', reason: error instanceof Error ? error.message : String(error) }; }
		return {
			id: state(pad, 'PrimitiveId'), componentId, padNumber: state(pad, 'PadNumber'), layer, rotation: state(pad, 'Rotation'), net: state(pad, 'Net'),
			shape: Array.isArray(shape) ? shape[0] : undefined, shapeState: Array.isArray(shape) ? JSON.parse(JSON.stringify(shape)) : undefined, box: box ? { ...box } : undefined, maskExpansionState,
			...(layer === 12 ? {
				holeState: copyState('Hole'), specialPadState: copyState('SpecialPad'),
				holeOffsetX: state(pad, 'HoleOffsetX'), holeOffsetY: state(pad, 'HoleOffsetY'),
				holeRotation: state(pad, 'HoleRotation'), metallization: state(pad, 'Metallization'),
			} : {}),
		};
	}
	catch (error) {
		return { componentId, readError: error instanceof Error ? error.message : String(error) };
	}
}

async function attachPhysicalPadViews(host: GeometryHost, snapshots: any[]): Promise<void> {
	const byNet = new Map<string, any[]>();
	for (const snapshot of snapshots) {
		host.checkBudget();
		if (snapshot.layer !== 12 || !Array.isArray(snapshot.specialPadState)) continue;
		const keys = snapshot.specialPadState.map((entry: any) => Array.isArray(entry) ? JSON.stringify(entry.slice(0, 2)) : undefined);
		if (new Set(keys).size === keys.length) continue;
		if (typeof snapshot.net !== 'string') { snapshot.runtimePhysicalPadView = { status: 'unavailable', reason: '同一PAD网络getter未返回字符串，无法读取具名物理面', requestNetwork: { type: snapshot.net === null ? 'null' : typeof snapshot.net } }; continue; }
		byNet.set(snapshot.net, [...(byNet.get(snapshot.net) ?? []), snapshot]);
	}
	for (const [net, targets] of byNet) {
		const result = await host.read('读取重复层键焊盘的具名物理面', async () => {
			if (typeof host.sdk.pcb_Net?.getAllPrimitivesByNet !== 'function') return { status: 'unavailable', reason: '公开网络图元读取接口不可用' };
			try {
				const values = await host.sdk.pcb_Net.getAllPrimitivesByNet(net);
				return Array.isArray(values) ? { status: 'value', values } : { status: 'invalid', reason: '公开网络图元读取未返回数组' };
			}
			catch (error) { return { status: 'sdk-error', reason: error instanceof Error ? error.message : String(error) }; }
		});
		for (const target of targets) {
			host.checkBudget();
			const missing = net === '' ? '空网补充视图未取得' : '网络补充视图未取得';
			const diagnostic: Record<string, unknown> = { api: 'pcb_Net.getAllPrimitivesByNet', requestNetwork: { type: 'string', value: net }, resultStatus: result.status, ...(result.values ? { resultCount: result.values.length } : {}) };
			if (result.status !== 'value' || !result.values) { target.runtimePhysicalPadView = { ...diagnostic, status: result.status, reason: `${missing}：${result.reason ?? '未知原因'}` }; continue; }
			const matches = result.values.filter((value: any) => value?.globalIndex === target.id);
			diagnostic.idMatchCount = matches.length;
			if (matches.length !== 1) { target.runtimePhysicalPadView = { ...diagnostic, status: 'invalid', reason: `${missing}：目标运行时ID缺失或重复` }; continue; }
			const raw = matches[0];
			diagnostic.rawNetwork = Object.hasOwn(raw, 'net') ? { present: true, type: raw.net === null ? 'null' : typeof raw.net, ...(['string', 'number', 'boolean'].includes(typeof raw.net) || raw.net === null ? { value: raw.net } : {}) } : { present: false, type: 'missing' };
			const bindingFailures = Object.entries({ parentId: raw.parentId === target.componentId, layerId: raw.layerId === target.layer, pcbItemPrimitiveType: raw.pcbItemPrimitiveType === 'Pad', net: raw.net === net }).filter(([, matches]) => !matches).map(([field]) => field);
			if (bindingFailures.length) {
				target.runtimePhysicalPadView = { ...diagnostic, status: 'invalid', bindingFailures, reason: `${missing}：父组件、层、图元类型或网络不一致` }; continue;
			}
			try {
				const consumed = Object.fromEntries(['globalIndex', 'parentId', 'layerId', 'pcbItemPrimitiveType', 'net', 'topType', 'topWidth', 'topHeight', 'topRatio', 'bottomType', 'bottomWidth', 'bottomHeight', 'bottomRatio', 'inner'].map(key => [key, raw[key]]));
				target.runtimePhysicalPadView = { ...diagnostic, status: 'value', raw: stableRules(JSON.parse(JSON.stringify(consumed))) };
			}
			catch (error) { target.runtimePhysicalPadView = { ...diagnostic, status: 'invalid', reason: `${missing}：${error instanceof Error ? error.message : String(error)}` }; }
		}
	}
}

function stablePadMaskSnapshots(values: any[]): string {
	return JSON.stringify([...values].sort((a, b) => `${a.componentId}:${a.id}`.localeCompare(`${b.componentId}:${b.id}`)));
}

function needsNativeDsnOuterSelection(snapshots: any[]): boolean {
	return snapshots.some(snapshot => snapshot.net === '' && snapshot.layer === 12 && snapshot.runtimePhysicalPadView?.api === 'pcb_Net.getAllPrimitivesByNet'
		&& snapshot.runtimePhysicalPadView?.resultStatus === 'value' && snapshot.runtimePhysicalPadView?.resultCount === 0 && snapshot.runtimePhysicalPadView?.idMatchCount === 0
		&& Array.isArray(snapshot.specialPadState) && new Set(snapshot.specialPadState.map((entry: any) => Array.isArray(entry) ? JSON.stringify(entry.slice(0, 2)) : undefined)).size !== snapshot.specialPadState.length);
}

async function readNativeDsnOuterSelection(host: GeometryHost): Promise<{ status: 'value'; text: string } | { status: 'unavailable'; reason: string }> {
	return host.read('读取无网焊盘外层选择的原生DSN', async () => {
		if (typeof host.sdk.pcb_ManufactureData?.getDsnFile !== 'function') return { status: 'unavailable' as const, reason: '公开原生DSN导出接口不可用' };
		try {
			const file = await host.sdk.pcb_ManufactureData.getDsnFile('silkscreen-pad-outer');
			if (!file || typeof file.arrayBuffer !== 'function') return { status: 'unavailable' as const, reason: '原生DSN导出未返回文件' };
			const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
			return text.trim() ? { status: 'value' as const, text } : { status: 'unavailable' as const, reason: '原生DSN文件为空' };
		}
		catch (error) { return { status: 'unavailable' as const, reason: `原生DSN导出失败：${error instanceof Error ? error.message : String(error)}` }; }
	});
}

interface UnsupportedObject {
	type: string;
	id?: string;
	componentId?: string;
	designator?: string;
	layer?: number;
	reason: string;
}

interface SourceSnapshot {
	source: string;
	document: ReturnType<typeof parseSourceLog>;
}

async function readSource(host: GeometryHost, label: string): Promise<SourceSnapshot> {
	return host.read(label, async () => {
		const source = await host.sdk.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string')
			throw new Error(`${label} 未返回完整字符串源码`);
		const document = parseSourceLog(source);
		if (document.uuid !== host.documentUuid || document.docType.toUpperCase() !== 'PCB')
			throw new Error(`${label} DOCHEAD 不属于当前 PCB`);
		return { source, document };
	});
}

function stableRules(value: any): any {
	if (Array.isArray(value)) return value.map(stableRules);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableRules(value[key])]));
	return value;
}

async function readRules(host: GeometryHost): Promise<unknown> {
	return host.read('读取丝印检查的独立设计规则', async () => {
		const value = await host.sdk.pcb_Drc.getCurrentRuleConfiguration();
		const prototype = value && typeof value === 'object' && !Array.isArray(value) ? Object.getPrototypeOf(value) : undefined;
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0
			|| !(prototype === null || (prototype && Object.getPrototypeOf(prototype) === null && prototype.constructor?.name === 'Object')))
			throw new Error('pcb_Drc.getCurrentRuleConfiguration 必须返回非空普通对象');
		return stableRules(value);
	});
}

async function readArray(host: GeometryHost, api: any, label: string): Promise<any[]> {
	return host.read(label, async () => {
		if (typeof api?.getAll !== 'function')
			throw new Error(`${label} 所需的公开 getAll() 不存在`);
		const values = await api.getAll();
		if (!Array.isArray(values))
			throw new Error(`${label} 未返回完整数组`);
		return values;
	});
}

function addUnsupported(unsupported: UnsupportedObject[], item: UnsupportedObject): void {
	unsupported.push(item);
}

async function getBox(host: GeometryHost, id: string, label: string): Promise<BBox | undefined> {
	const api = host.sdk.pcb_Primitive;
	if (typeof api?.getPrimitivesBBox !== 'function')
		return undefined;
	return host.read(`读取 ${label} 包围盒 ${id}`, async () => {
		const value = await api.getPrimitivesBBox([id]);
		return normalizeSdkBox(value);
	});
}

async function addCheckedObject(
	host: GeometryHost,
	checked: CheckedBoxObject[],
	unsupported: UnsupportedObject[],
	seen: Map<string, CheckedBoxObject>,
	conflictedIds: Set<string>,
	base: Omit<CheckedBoxObject, 'box'>,
): Promise<void> {
	if (!base.id) {
		addUnsupported(unsupported, { type: base.type, componentId: base.componentId, designator: base.designator, reason: '图元 ID 缺失，不能请求真实对象包围盒' });
		return;
	}
	if (conflictedIds.has(base.id))
		return;
	const existing = seen.get(base.id);
	if (existing) {
		if (existing.type === 'standalone-pad' && base.type === 'component-pad' && existing.layer === base.layer) {
			existing.type = 'component-pad';
			existing.componentId = base.componentId;
			existing.designator = base.designator;
			return;
		}
		if (existing.type === 'component-pad' && base.type === 'standalone-pad' && existing.layer === base.layer)
			return;
		if (existing.type !== base.type || existing.layer !== base.layer || existing.componentId !== base.componentId) {
			seen.delete(base.id);
			conflictedIds.add(base.id);
			const checkedIndex = checked.findIndex(item => item.id === base.id);
			if (checkedIndex >= 0)
				checked.splice(checkedIndex, 1);
			addUnsupported(unsupported, { type: 'ambiguous-object', id: base.id, componentId: base.componentId, designator: base.designator, reason: '同一 ID 被多个列表以不同对象身份、层或父器件返回；已排除该 ID，不参与候选检测' });
		}
		return;
	}
	const box = await getBox(host, base.id, base.type);
	if (!box) {
		const reason = typeof host.sdk.pcb_Primitive?.getPrimitivesBBox !== 'function'
			? 'pcb_Primitive.getPrimitivesBBox() 不存在；该对象未纳入候选检测'
			: 'SDK 包围盒缺失、非有限或边界顺序无效';
		addUnsupported(unsupported, { type: base.type, id: base.id, componentId: base.componentId, designator: base.designator, reason });
		return;
	}
	const item = { ...base, box } as CheckedBoxObject;
	seen.set(base.id, item);
	checked.push(item);
}

function requiredGetter<T = unknown>(object: any, name: string, label: string): T {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		throw new Error(`${label} 缺少 SDK 声明的 getState_${name}()`);
	return getter.call(object) as T;
}

async function checkSilkscreen(params: Record<string, any>) {
	const input = validateSilkscreenCheckParams(params);
	const host = await createGeometryHost(eda, params);
	try {
		const baselineSource = await readSource(host, '读取丝印检查完整源码基线');
		const baselineRules = await readRules(host);
		const before = await readSource(host, '读取丝印预检开始源码');
		const initialComparison = compareSilkscreenSourceSnapshots(baselineSource.source, before.source);
		if (!initialComparison.matches)
			throw new Error(`丝印预检开始时源码发生变化：${initialComparison.reason}`);

		const checkedObjects: CheckedBoxObject[] = [];
		const unsupported: UnsupportedObject[] = [];
		const seen = new Map<string, CheckedBoxObject>();
		const conflictedIds = new Set<string>();
		const footprintSourcesBefore = await readEmbeddedFootprintSources(host, '读取丝印检查开始时的文档嵌入封装来源');
		const records = resolveRecords(before.document);
		const componentRecords = [...records.values()].filter(record => record.header.type === 'COMPONENT');
		const componentsById = new Map<string, { designator: string; data: Record<string, any> }>();
		for (const record of componentRecords) {
			if (typeof record.header.id !== 'string' || !record.header.id || !record.data || typeof record.data !== 'object' || Array.isArray(record.data))
				continue;
			const componentId = record.header.id;
			const designatorAttrs = [...records.values()].filter((candidate) => {
				if (candidate.header.type !== 'ATTR' || !candidate.data || typeof candidate.data !== 'object' || Array.isArray(candidate.data))
					return false;
				const data = candidate.data as Record<string, any>;
				return data.parentId === componentId && data.key === 'Designator';
			});
			const designator = designatorAttrs.find(item => typeof (item.data as any).value === 'string')?.data as Record<string, any> | undefined;
			const componentData = record.data as Record<string, any>;
			const embeddedAttrs = componentData.attrs && typeof componentData.attrs === 'object' && !Array.isArray(componentData.attrs) ? componentData.attrs as Record<string, unknown> : {};
			componentsById.set(componentId, { designator: String(designator?.value ?? embeddedAttrs.Designator ?? componentData.designator ?? ''), data: componentData });
		}

		const silkAttrs = [...records.values()].filter(record => record.header.type === 'ATTR');
		for (const record of silkAttrs) {
			if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
				addUnsupported(unsupported, { type: 'ATTR', id: typeof record.header.id === 'string' ? record.header.id : undefined, reason: 'ATTR 源码数据不是对象' });
				continue;
			}
			const data = record.data as Record<string, any>;
			if (data.layerId !== 3 && data.layerId !== 4)
				continue;
			const parentId = typeof data.parentId === 'string' ? data.parentId : '';
			const component = componentsById.get(parentId);
			if (data.keyVisible === false && data.valueVisible === false)
				continue;
			if (data.key === 'Designator') {
				if (typeof data.valueVisible !== 'boolean' || typeof data.keyVisible !== 'boolean') {
					addUnsupported(unsupported, { type: 'Designator', id: typeof record.header.id === 'string' ? record.header.id : undefined, componentId: parentId || undefined, designator: String(data.value ?? ''), layer: data.layerId, reason: 'ATTR 可见性状态缺失或不是 boolean' });
					continue;
				}
				if (!data.valueVisible) {
					addUnsupported(unsupported, { type: 'Designator', id: typeof record.header.id === 'string' ? record.header.id : undefined, componentId: parentId || undefined, designator: String(data.value ?? ''), layer: data.layerId, reason: 'Designator 值不可见但键仍可见；本轮无法单独解释键文字包围盒' });
					continue;
				}
				if (!component || typeof record.header.id !== 'string' || !record.header.id) {
					addUnsupported(unsupported, { type: 'Designator', id: typeof record.header.id === 'string' ? record.header.id : undefined, componentId: parentId || undefined, designator: String(data.value ?? ''), layer: data.layerId, reason: 'Designator 未关联到有效的当前 PCB 器件' });
					continue;
				}
				const layer = silkSide(data.layerId)!;
				await addCheckedObject(host, checkedObjects, unsupported, seen, conflictedIds, { id: record.header.id, type: 'designator', layer, componentId: parentId, designator: String(data.value) });
			}
			else {
				addUnsupported(unsupported, {
					type: 'visible-attribute',
					id: typeof record.header.id === 'string' ? record.header.id : undefined,
					componentId: parentId || undefined,
					designator: component?.designator,
					layer: data.layerId,
					reason: `丝印层可见的非 Designator ATTR (${String(data.key ?? 'unknown')}) 未纳入候选检测`,
				});
			}
		}

		const strings = await readArray(host, host.sdk.pcb_PrimitiveString, '读取独立 PCB 丝印文字');
		for (const string of strings) {
			const id = requiredGetter<string>(string, 'PrimitiveId', 'PCB 字符串');
			const layerId = requiredGetter<number>(string, 'Layer', `PCB 字符串 ${id}`);
			const layer = silkSide(layerId);
			if (!layer)
				continue;
			const text = requiredGetter<string>(string, 'Text', `PCB 字符串 ${id}`);
			await addCheckedObject(host, checkedObjects, unsupported, seen, conflictedIds, { id, type: 'text', layer, text });
		}

		for (const entry of [
			{ type: 'silk-polyline' as const, api: host.sdk.pcb_PrimitivePolyline, label: '读取 PCB 多段线' },
			{ type: 'silk-line' as const, api: host.sdk.pcb_PrimitiveLine, label: '读取 PCB 直线' },
			{ type: 'silk-arc' as const, api: host.sdk.pcb_PrimitiveArc, label: '读取 PCB 圆弧' },
		]) {
			if (typeof entry.api?.getAll !== 'function') {
				addUnsupported(unsupported, { type: entry.type, reason: `${entry.label}所需的公开 getAll() 不存在；该类候选未覆盖` });
				continue;
			}
			const strokes = await readArray(host, entry.api, entry.label);
			for (const stroke of strokes) {
				let id: string | undefined;
				let layerId: number | undefined;
				try {
					const idGetter = stroke?.getState_PrimitiveId;
					if (typeof idGetter !== 'function')
						throw new Error('缺少 SDK 声明的 getState_PrimitiveId()');
					const value = idGetter.call(stroke);
					if (typeof value !== 'string' || !value)
						throw new Error('getState_PrimitiveId() 未返回有效 ID');
					id = value;
					const layerGetter = stroke?.getState_Layer;
					if (typeof layerGetter !== 'function')
						throw new Error('缺少 SDK 声明的 getState_Layer()');
					const layerValue = layerGetter.call(stroke);
					if (typeof layerValue !== 'number' || !Number.isFinite(layerValue))
						throw new Error('getState_Layer() 未返回有效数值层号');
					layerId = layerValue;
				}
				catch (error) {
					addUnsupported(unsupported, { type: entry.type, id, reason: `${entry.label}对象缺少有效 ID/图层 getter：${error instanceof Error ? error.message : String(error)}` });
					continue;
				}
				if (typeof id !== 'string' || !id) {
					addUnsupported(unsupported, { type: entry.type, reason: `${entry.label}对象缺少有效图元 ID` });
					continue;
				}
				const layer = silkSide(layerId);
				if (!layer)
					continue;
				await addCheckedObject(host, checkedObjects, unsupported, seen, conflictedIds, { id, type: entry.type, layer });
			}
		}

		const pads = await readArray(host, host.sdk.pcb_PrimitivePad, '读取独立 PCB 焊盘');
		for (const pad of pads) {
			const id = requiredGetter<string>(pad, 'PrimitiveId', 'PCB 独立焊盘');
			const layer = requiredGetter<number>(pad, 'Layer', `PCB 焊盘 ${id}`);
			const sides = padSides(layer);
			if (!sides) {
				addUnsupported(unsupported, { type: 'standalone-pad', id, layer, reason: '焊盘层不是支持的 1/2/12，未纳入铜盘候选检测' });
				continue;
			}
			await addCheckedObject(host, checkedObjects, unsupported, seen, conflictedIds, { id, type: 'standalone-pad', layer: layer === 12 ? 'multi' : sides[0] });
		}

		const components = await readArray(host, host.sdk.pcb_PrimitiveComponent, '读取 PCB 器件');
		const runtimeComponents: any[] = [];
		const padMaskSnapshots: any[] = [];
		const observedComponentIds = new Set<string>();
		for (const componentObject of components) {
			runtimeComponents.push(componentObject);
			const componentId = state<string>(componentObject, 'PrimitiveId');
			if (typeof componentId !== 'string' || !componentId) {
				addUnsupported(unsupported, { type: 'component', reason: '器件列表包含缺少 PrimitiveId 的项目；无法读取封装焊盘或登记封装丝印缺口' });
				continue;
			}
			if (observedComponentIds.has(componentId)) {
				addUnsupported(unsupported, { type: 'component', id: componentId, designator: componentsById.get(componentId)?.designator, reason: '器件 getAll() 返回重复 ID' });
				continue;
			}
			observedComponentIds.add(componentId);
			const sourceComponent = componentsById.get(componentId);
			const designator = sourceComponent?.designator;
			if (!sourceComponent)
				addUnsupported(unsupported, { type: 'component', id: componentId, reason: '运行时器件未出现在本次 PCB 源码快照中' });
			const pins = await host.read(`读取器件 ${componentId} 的真实焊盘图元`, async () => {
				if (typeof host.sdk.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId !== 'function')
					throw new Error('pcb_PrimitiveComponent.getAllPinsByPrimitiveId() 不存在');
				return await host.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
			});
			if (pins === undefined) {
				addUnsupported(unsupported, { type: 'component-pads', componentId, designator, reason: 'getAllPinsByPrimitiveId 返回 undefined；封装焊盘覆盖未知' });
				continue;
			}
			if (!Array.isArray(pins))
				throw new Error(`器件 ${componentId} 的 getAllPinsByPrimitiveId() 未返回数组`);
			for (const pad of pins) {
				const id = state<string>(pad, 'PrimitiveId');
				const layer = state<number>(pad, 'Layer');
				const parentId = state<string>(pad, 'ParentComponentPrimitiveId');
				if (typeof id !== 'string' || !id || parentId !== componentId) {
					addUnsupported(unsupported, { type: 'component-pad', id: typeof id === 'string' ? id : undefined, componentId, designator, layer, reason: '焊盘 ID 缺失或器件归属与查询目标不符' });
					continue;
				}
				const sides = padSides(layer);
				if (!sides) {
					addUnsupported(unsupported, { type: 'component-pad', id, componentId, designator, layer, reason: '器件焊盘层不是支持的 1/2/12，未纳入铜盘候选检测' });
					continue;
				}
				await addCheckedObject(host, checkedObjects, unsupported, seen, conflictedIds, { id, type: 'component-pad', layer: layer === 12 ? 'multi' : sides[0], componentId, designator });
				padMaskSnapshots.push(padMaskSnapshot(pad, componentId, seen.get(id)?.box));
			}
		}
		const projectFootprintUuids = footprintSourcesBefore.available
			? findMissingProjectLibraryFootprintUuids(before.document.records as any, runtimeComponents, footprintSourcesBefore.value, host.checkBudget)
			: [];
		const projectFootprintSourcesBefore = await readProjectLibrarySources(host, projectFootprintUuids, '读取丝印检查开始时的工程库封装来源', host.checkBudget);
		await attachPhysicalPadViews(host, padMaskSnapshots);
		const nativeDsnRequested = needsNativeDsnOuterSelection(padMaskSnapshots);
		const nativeDsnBefore = nativeDsnRequested ? await readNativeDsnOuterSelection(host) : undefined;

		// The exported layers include the real footprint strokes, font regions and mask
		// openings. Keep this result separate from source-object bounding-box candidates.
		let manufacturingLayers: readonly GerberLayerGeometry[] = [];
		const manufacturing = typeof host.sdk.pcb_ManufactureData?.getGerberFile === 'function'
			? await host.read('导出并检查丝印制造图层', async () => {
				const file = await host.sdk.pcb_ManufactureData.getGerberFile('silkscreen-check');
				if (!file || typeof file.arrayBuffer !== 'function')
					throw new Error('丝印检查的官方 Gerber 导出未返回文件');
				const bytes = new Uint8Array(await file.arrayBuffer());
				host.checkBudget();
				const report = await analyzeSilkscreenGerber(bytes, input.minClearance, host.checkBudget, (layers) => { manufacturingLayers = layers; });
				return report;
			})
			: { complete: false, scope: 'exported-manufacturing-only', unavailableReason: '当前宿主没有公开 Gerber 导出接口，制造图层未检查' };

		const padMaskSnapshotsAfter: any[] = [];
		for (const componentId of observedComponentIds) {
			const pins = await host.read(`复核器件 ${componentId} 的开窗关联焊盘快照`, () => host.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId));
			if (!Array.isArray(pins)) {
				padMaskSnapshotsAfter.push({ componentId, readError: '复核焊盘列表不可用' });
				continue;
			}
			for (const pad of pins) {
				const id = state<string>(pad, 'PrimitiveId');
				if (typeof id !== 'string' || !id || conflictedIds.has(id) || state(pad, 'ParentComponentPrimitiveId') !== componentId || !padSides(state<number>(pad, 'Layer')))
					continue;
				padMaskSnapshotsAfter.push(padMaskSnapshot(pad, componentId, await getBox(host, id, '开窗关联复核焊盘')));
			}
		}
		await attachPhysicalPadViews(host, padMaskSnapshotsAfter);
		const padMaskSnapshotsStable = stablePadMaskSnapshots(padMaskSnapshots) === stablePadMaskSnapshots(padMaskSnapshotsAfter);
		const nativeDsnAfter = nativeDsnBefore?.status === 'value' ? await readNativeDsnOuterSelection(host) : undefined;
		const nativeDsnStable = nativeDsnBefore?.status === 'value' && nativeDsnAfter?.status === 'value' && nativeDsnBefore.text === nativeDsnAfter.text;
		const nativeDsnOuterSelection = { requested: nativeDsnRequested, status: nativeDsnRequested ? nativeDsnStable ? 'stable' : 'unavailable' : 'not-needed', stable: nativeDsnStable,
			...(nativeDsnRequested && !nativeDsnStable ? { reason: nativeDsnBefore?.status === 'unavailable' ? nativeDsnBefore.reason : nativeDsnAfter?.status === 'unavailable' ? nativeDsnAfter.reason : '检查前后原生DSN不同，外层选择证据不可用' } : {}) };

		const footprintSourcesAfter = await readEmbeddedFootprintSources(host, '读取丝印检查结束时的文档嵌入封装来源');
		const projectFootprintSourcesAfter = await readProjectLibrarySources(host, projectFootprintUuids, '读取丝印检查结束时的工程库封装来源', host.checkBudget);
		const footprintSilkscreen = footprintSourcesBefore.available
			? analyzeFootprintSilkscreen({ pcbRecords: before.document.records as any, components: runtimeComponents, footprintSources: footprintSourcesBefore.value, projectLibrarySources: projectFootprintSourcesBefore, minClearance: input.minClearance, checkedObjects, checkBudget: host.checkBudget })
			: unavailableFootprintSilkscreen(footprintSourcesBefore.reason ?? '文档嵌入封装来源不可用');
		const footprintSourcesStable = footprintSourcesBefore.available && footprintSourcesAfter.available
			&& compareFootprintSourceSummaries(footprintSilkscreen.sourceSummary, summarizeFootprintSourceSet(footprintSourcesAfter.value, projectFootprintSourcesAfter, host.checkBudget));
		footprintSilkscreen.coverage.sourceStable = footprintSourcesStable;
		if (!footprintSourcesStable) {
			const sourceUnavailableReason = footprintSourcesBefore.reason ?? footprintSourcesAfter.reason;
			invalidateFootprintSilkscreenSource(
				footprintSilkscreen,
				[...observedComponentIds].map(componentId => ({ componentId, designator: componentsById.get(componentId)?.designator })),
				'预检期间嵌入来源、工程库身份或有效封装来源发生变化/不可用；封装丝印候选已作废',
				sourceUnavailableReason ? `文档嵌入来源读取失败：${sourceUnavailableReason}` : undefined,
			);
		}
		for (const item of projectComponentFootprintSilkUnsupported(footprintSilkscreen.unsupported))
			addUnsupported(unsupported, item);

		const after = await readSource(host, '读取丝印预检结束源码');
		const sourceComparison = compareSilkscreenSourceSnapshots(before.source, after.source);
		if (!sourceComparison.matches)
			throw new Error(`只读丝印预检期间 PCB 源码发生变化；结果作废：${sourceComparison.reason}`);
		const currentRules = await readRules(host);
		if (JSON.stringify(currentRules) !== JSON.stringify(baselineRules))
			throw new Error('只读丝印检查期间设计规则发生变化，结果作废');

		const potentialConflicts = collectPotentialConflicts(checkedObjects, input.minClearance);
		const manufacturingSourceLocations = locateManufacturingSourceCandidates({ manufacturing: manufacturing as any, checkedObjects, footprintSilkscreen, minClearanceMil: input.minClearance, checkBudget: host.checkBudget });
		const footprintArcBoardParticipation = analyzeFootprintArcBoardParticipation({ layers: manufacturingLayers, footprintSilkscreen, checkBudget: host.checkBudget });
		const manufacturingMaskOverlapParticipation = analyzeManufacturingMaskOverlapParticipation({ layers: manufacturingLayers, manufacturing, checkBudget: host.checkBudget });
		const footprintPadMaskCandidates = extractFootprintPadMaskCandidates({ pcbRecords: before.document.records as any, components: runtimeComponents, footprintSources: footprintSourcesBefore.value, projectLibrarySources: projectFootprintSourcesBefore, padSnapshots: padMaskSnapshots, sourceStable: footprintSourcesStable && padMaskSnapshotsStable, ...(nativeDsnStable && nativeDsnBefore?.status === 'value' ? { nativeDsnText: nativeDsnBefore.text } : {}), checkBudget: host.checkBudget });
		const padMaskOpeningAssociations = analyzePadMaskOpeningAssociations({ layers: manufacturingLayers, padCandidates: footprintPadMaskCandidates, maskParticipation: manufacturingMaskOverlapParticipation, checkBudget: host.checkBudget });
		const { sourceSummary: internalSourceSummary, ...footprintSilkscreenReport } = footprintSilkscreen;
		void internalSourceSummary;
		const manufacturingConfirmedCount = Array.isArray((manufacturing as any).confirmedConflicts) ? (manufacturing as any).confirmedConflicts.length : 0;
		const manufacturingPotentialCount = Array.isArray((manufacturing as any).potentialConflicts) ? (manufacturing as any).potentialConflicts.length : 0;
		const counts = (type: CheckedBoxObject['type']) => checkedObjects.filter(item => item.type === type).length;
		const unsupportedCounts = (type: string) => unsupported.filter(item => item.type === type).length;
		const coverage = {
			scope: 'source-object-bounding-boxes',
			method: 'SDK bounding-box neighbor candidates only',
			minClearanceMil: input.minClearance,
			checkedTextCount: counts('text'),
			checkedDesignatorCount: counts('designator'),
			checkedSilkPolylineCount: counts('silk-polyline'),
			checkedSilkLineCount: counts('silk-line'),
			checkedSilkArcCount: counts('silk-arc'),
			unsupportedSilkPolylineCount: unsupportedCounts('silk-polyline'),
			unsupportedSilkLineCount: unsupportedCounts('silk-line'),
			unsupportedSilkArcCount: unsupportedCounts('silk-arc'),
			checkedStandalonePadCount: counts('standalone-pad'),
			checkedComponentPadCount: counts('component-pad'),
			supportedCategories: ['text', 'designator', 'sdk-enumerated-silkscreen-polyline-bbox-candidates', 'supplemental-sdk-enumerated-silkscreen-line-bbox-candidates', 'supplemental-sdk-enumerated-silkscreen-arc-bbox-candidates', 'silk-to-pad-copper', 'silk-to-silk'],
			uncoveredCategories: ['footprint-silkscreen-source-mapping-and-enumeration-completeness', 'real-solder-mask-openings', 'complex-board-outline-boundary', 'silkscreen-ink-width-and-font-strokes'],
			footprintSilkscreenSourceSubset: '仅覆盖来源稳定且实例映射一致的封装局部 layer 3/4、有限正线宽、完整 L/ARC 混合路径 POLY 子集；points 是路径节点而非弧采样，segments 明确区分 line/arc，候选按精确线段/弧段极值生成扩宽包围盒；其他曲线及未知命令整条 unsupported，候选确认仍为 false，完整性仍为 false',
			polylineSourceEvidence: 'native-silkscreen-line-observed-as-POLY',
			polylineSourceMapping: 'unknown',
			polylineEnumerationCompleteness: 'not-verified',
			polylineMayIncludeFootprintObjects: true,
			lineArcSourceMapping: 'unknown',
			lineArcEnumerationCompleteness: 'not-verified',
			lineArcMayIncludeFootprintObjects: true,
			layerVisibilityChecked: false,
			complete: false,
		};
		await host.finish();
		return {
			documentUuid: host.documentUuid,
			operation: 'checkSilkscreen',
			units: 'mil',
			checkedObjects,
			potentialConflicts,
			footprintSilkscreen: footprintSilkscreenReport,
			manufacturing,
			manufacturingSourceLocations,
			footprintArcBoardParticipation,
			manufacturingMaskOverlapParticipation,
			padMaskOpeningAssociations,
			nativeDsnOuterSelection,
			unsupported,
			coverage,
			complete: false,
			message: manufacturing.complete === true
				? `制造图层报告 ${manufacturingConfirmedCount} 项确认汇总、${manufacturingPotentialCount} 项待复核汇总（按面与类别统计，不代表问题处数）；来源位置候选状态见 manufacturingSourceLocations。设计对象包围盒另有 ${potentialConflicts.length} 个未确认近邻候选。`
				: `制造检查不可用或未完成；保留制造报告中的原始原因。来源位置候选状态见 manufacturingSourceLocations。设计对象包围盒另有 ${potentialConflicts.length} 个未确认近邻候选。`,
			confirmedConflictCount: manufacturingConfirmedCount,
			designBoundingBoxConfirmedConflictCount: 0,
			saved: false,
			sourceStable: true,
			sourceComparison: { initial: initialComparison, final: sourceComparison, meaning: '设计数据在已验证的表示变化规则下相同，不代表源码字节完全一致' },
			rulesStable: true,
		};
	}
	catch (error) {
		return host.fail(error, { operation: 'checkSilkscreen', readOnly: true });
	}
}

export const silkscreenCheckCommands: ICommandDef[] = [
	{
		name: 'pcb.checkSilkscreen',
		summary: '只读检查导出的顶/底丝印、阻焊开口及支持的板框；制造 Gerber 子集覆盖 G01 直线，以及非区域、非 GKO 图层上 G75 多象限 G02/G03 的圆形光圈笔画；G74、非圆光圈圆弧、区域圆弧及板框圆弧仍明确排除。报告的maxEnvelopeErrorMil仅表示中心线模型补偿（delta+sagitta+数值裕量），不包含capsule圆帽的多边形近似误差；最终墨迹范围由inner/outer包络包含关系表示。已观察到原生丝印直线以 POLY 保存，故将 SDK 可枚举的丝印层多段线整体包围盒作为主要图元候选，并将直线/圆弧作为补充候选，与同面丝印及焊盘比较。另含文档嵌入封装来源和当前工程库精确补充的有限子集通道；来源映射及 SDK 枚举完整性仍不完整，所有候选未确认，不代表完整 DRC。',
		params: [
			{ name: 'minClearance', type: 'number', description: '检查间距阈值，单位 mil，默认 0。原设计包围盒报告重叠/相接候选；制造几何另行区分确认重叠、低于阈值和数值边界候选。不是自动读取的板厂规则。' },
		],
		returns: '原设计 complete 固定 false；checkedObjects/potentialConflicts 保持既有 SDK 包围盒近邻候选，所有候选 confirmed 均为 false。footprintSilkscreen 是独立来源通道：sourceIdentity 为 {componentId, footprintUuid, localPrimitiveId, source, libraryUuid?}；来源优先采用文档嵌入封装，只有 embedded 列表缺少目标 UUID 时才按实际工程库 UUID 精确补充，不查询个人/系统/云库。source 为 document-embedded 或 project-library；后者带实际 libraryUuid。候选保留单个 POLY 的来源身份，local/global 提供有序 points（路径节点，不是弧采样）、明确区分 line/arc 的 segments、closed、segmentCount，a/b 兼容表示首末点。支持局部 layer 3/4、有限正线宽和完整 L/ARC 混合语法：起始有限坐标后，L 后可连续接有限坐标对；ARC 形式为 ["ARC",signedSweepDegrees,x,y]，角度非零且绝对值小于 360，弧端点不得重合。路径末点等于首点时 closed=true，否则保持开放，不自动闭合。底层实例镜像弧中心并反转 sweep，局部 4 映射到顶面、局部 3 映射到底面。未知曲线类型、CARC/C/Bezier 等未知指令或非法路径整条列入 unsupported。包围盒按各直线和圆弧的精确极值合并后扩展半线宽。sourceStable 表示预检前后嵌入清单、工程库身份、来源渠道及有效记录摘要一致；近邻候选 confirmed=false，coverage.complete 固定 false。顶层 coverage 仍将封装完整来源映射与枚举列为未覆盖，但 footprintSilkscreen 单独覆盖其已确认映射的有限 L/ARC 来源子集。manufacturing 字段独立报告制造层导出几何检查与解析覆盖；这不宣称它能解析封装 ARC。读取不保存或修改 PCB。 manufacturingSourceLocations 按 confirmed/potential 桶、conflictIndex 与 areaIndex 链接制造区域，候选含 bboxDistanceToLocationMil，status 为 unavailable/candidate/ambiguous，confirmed 均为 false、complete 固定 false。零来源候选附原因，不证明无风险或唯一来源。搜索距离是 minClearanceMil+searchMarginMil，辅助margin不代表SDK精度或实际间距。该通道不追踪 clear-paint；阻焊类别中邻近焊盘仅是铜对象包围盒候选，不代表实际阻焊开口归属。制造统计按面和类别汇总，不是问题处数；来源 POLY ARC 与 Gerber G75 G02/G03 制造弧解析是独立覆盖。 板边距离可附locationKind=distance-witness及locationWitness：来自最终外包络、对应距离下界的一个代表点对，locationEnumerationComplete=false，不是全部接触位置或源对象归属。位置bbox可为零面积；来源定位透传见证元数据且候选仍未确认。 candidates新增role，roleGroups以candidateIndices按silkscreen-source与mask-opening-owner-candidate分别统计候选；mask类别两组分别给unavailable/candidate/ambiguous，板边和板外仅丝印组。原平铺status保留全部候选统计。附近焊盘仍只是铜bbox候选，不能确认开窗归属；每组各一个也不证明实际冲突对象对，confirmed及complete仍为false。 footprintArcBoardParticipation独立核对同次稳定封装单段ARC中心线与简单直线GKO交点，并对唯一几何匹配dark圆光圈制造弧做省略重放。verified-at-witnesses只证明所列交点严格在完整lower内、省略后upper外；sourceMapping为geometry-correlated且uniqueSourceAttribution=false，不改原制造或候选确认状态。sourceIntersectionPointsMil保留可靠源交点，witnesses单列制造贡献核对；contactEnumerationComplete=false，未解决接触另有unresolvedContactReason。不覆盖文字字形、完整间距或所有图元，无中心线交点不表示无制造风险。 manufacturingMaskOverlapParticipation独立核对已确认正面积丝印/开窗交叠的内部见证及两侧制造图元必要贡献；见证来自同次最终lower真实交集，分别省略图元重放后核对对应upper。逐个省略所有覆盖候选，仅两侧各一个已证明必要贡献者且核对可靠时verified-at-witnesses，无法确认时说明原因。制造引用不表示EDA身份，uniqueSourceAttribution=false，不改变来源候选或宣称全部对象对已枚举。 padMaskOpeningAssociations独立连接稳定封装PAD、实际PAD_NET和运行时焊盘，以精确铜bbox中心、实际旋转及源RECT/ELLIPSE/OVAL尺寸和有效扩张构造模型，按独立已验精度匹配同次完整开窗几何，并链接已证明必要贡献的mask见证。前后焊盘快照需稳定；已识别覆盖或无法可靠匹配时说明原因。geometry-correlated不等于唯一源身份，uniqueSourceAttribution=false，原报告及候选状态保持。保留两面源扩张值；已验证局部铜层1普通SMD的topSolderExpansion随组件实际铜面生效，顶底实例均选源top，实际制造目标仍为GTS/GBS。局部铜层2普通SMD使用源bottomSolderExpansion，实际PAD应位于组件反面。sourcePadModel返回localCopperLayerId=1|2及对应expansionMapping；局部1为local-layer1-follows-component-side，局部2为local-layer2-opposite-component-side。候选面及GTS/GBS目标使用已核对的实际PAD面；无可靠同次制造见证不补造链接。未支持或缺失/非法源层明确skipped，不解释getter字段通用翻面语义。 圆形分支另支持源ELLIPSE有限正等宽高的无孔NORMAL SMD，sourcePadModel返回shape=ELLIPSE和diameterMil及层/扩张来源。实际ELLIPSE精确铜bbox须匹配源直径；C flash核对完整中心和openingDiameter=diameter+2*expansion，geometryChecks使用circleOnly/flashCenterMatched/positiveDiameterMatched。C直径独立采用实测五位毫米量化半界0.000005mm加浮点余量，不按词元长度放宽；未知精度只在纯浮点匹配时确认，否则保留原因且不形成无条件唯一匹配。圆形见证按开窗半径成员核对，原RECT字段和结果保持。 圆形派生中心、正开窗直径和外边界必须有限，计算溢出明确skipped且不生成候选。 OVAL长圆按胶囊模型核对完整中心、核端点和直径，支持轴向O及精确Oval宏flash；零核长另支持C，跨表示的重复和精度未知候选统一判定。非等径源ELLIPSE在已验证宿主按width成圆，保留sourceHeightMil与circle-width-based-runtime解释，不表示数学椭圆。layer12普通ROUND等径孔可展开两个localSurface候选；唯一单外层specialPad选择对应面形状及源扩张，再随组件翻面映射GTS/GBS。runtimeBBoxModel=default-and-special-union只表示SDK聚合范围，不证明物理铜层存在；每面开窗独立匹配。sourceDrillMetadata仅为源声明，不表示钻孔或连通验收。可读取的孔、specialPad、偏移、角度和镀孔状态参与前后稳定性核对。零/负扩张在剩余几何为正时继续检查；退化闭合另报源预测和source-copper-region内最终制造开窗观测，空引用不伪造归属。源严格null使用同PAD物理面的有限有效扩张；缺字段、异常及源/运行时矛盾明确说明。复杂SPECIAL按同PAD稳定有效视图恢复源精确几何，规范化三项或重复层键的具名物理视图分别核验聚合bbox；不按层号、数组位置、bbox或Gerber猜面。具名视图按运行时ID、父器件和网络绑定，完整inner只参与铜范围，每面开窗仍独立匹配；新增只读字段检查前后必须稳定。未支持的属性或无法恢复唯一精确值逐项说明；文字制造检查保留，文字源对象仍候选。 仅已确认空网补充查询返回空数组时，可使用检查前后字节一致的原生DSN独立选择同PAD顶底形状；nativeDsnOuterSelection报告是否请求、稳定状态及不可用原因。单u1零放置与canonical eN身份链、完整轮廓及0.01mil网格半格均须匹配；精度歧义保持unknown。dsnPhysicalView标识dsn-export-derived及导出版本、pin/stack、完整模式和量化信息。runtimeBBoxModel=dsn-outer-and-runtime-special-union仅使用SDK实际返回全部tuple恢复的源精确形状计算铜范围，不把DSN inner或polygon当精确铜；制造开窗仍独立核对。',
		example: { cmd: 'pcb.checkSilkscreen', params: { minClearance: 5 } },
		handler: checkSilkscreen,
	},
];

