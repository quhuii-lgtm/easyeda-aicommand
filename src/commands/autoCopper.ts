import type { ICommandDef } from '../engine/types';
import type { GeometryHost } from '../pcb/geometryHost';
import { configureCopperRuntime } from '../pcb/autoCopper/runtime';
import { createGeometryHost } from '../pcb/geometryHost';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';

interface Point { x: number; y: number }
type Target = Record<string, any> & { primitiveId: string; type: string; net: string };
interface PolygonPlan {
	net: string;
	layer: 'top' | 'bottom';
	layerId: number;
	polygonSources: unknown[];
	points: Point[];
	area: number;
}
interface AutoCopperPlan {
	documentUuid: string;
	operation: 'autoCopper';
	units: 'mil';
	inputs: Record<string, unknown>;
	baseline: { source: string; rules: unknown };
	targets: Array<Record<string, unknown>>;
	excludedTargets: Array<Record<string, unknown>>;
	groups: Array<Record<string, unknown>>;
	plannedPrimitives: PolygonPlan[];
	executable: boolean;
	coverage: Record<string, unknown>;
	warnings: Array<Record<string, unknown>>;
	provenance: Record<string, unknown>;
}

const TOP = 1;
const BOTTOM = 2;
const MULTI = 12;
const BOARD_OUTLINE = 11;
const VIA_THROUGH = 0;
const FILL_MODE_SOLID = 0;
const POUR_LINE_WIDTH = 12;
const UPSTREAM_COMMIT = '98317b6b5941977a3ae90948a05295f9d8b1169f';

function state<T = any>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		return undefined;
	return getter.call(object) as T;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function stableJson(value: unknown): string {
	const sort = (item: any): any => Array.isArray(item)
		? item.map(sort)
		: item && typeof item === 'object'
			? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
			: item;
	return JSON.stringify(sort(value)) ?? 'undefined';
}

function readArray(host: GeometryHost, api: any, label: string, ...args: unknown[]): Promise<any[]> {
	return host.read(label, async () => {
		const getter = api?.getAll;
		if (typeof getter !== 'function')
			throw new Error(`${label} 所需的公开 getAll 不存在`);
		const result = await getter.apply(api, args);
		if (!Array.isArray(result))
			throw new Error(`${label} 未完整返回数组`);
		return result;
	});
}

function requestedLayer(layer: unknown): { name: 'top' | 'bottom'; id: number } {
	if (layer === 'top')
		return { name: 'top', id: TOP };
	if (layer === 'bottom')
		return { name: 'bottom', id: BOTTOM };
	throw new Error('layer 必须明确为 top 或 bottom');
}

function validateInputs(params: Record<string, any>) {
	if (!Array.isArray(params.targetIds) || params.targetIds.length === 0
		|| params.targetIds.some((id: unknown) => typeof id !== 'string' || !id.trim())) {
		throw new Error('targetIds 必须是非空的图元 ID 字符串数组');
	}
	const targetIds = [...new Set(params.targetIds as string[])];
	if (targetIds.length !== params.targetIds.length)
		throw new Error('targetIds 不得重复');
	const layer = requestedLayer(params.layer);
	const expansion = params.expansion == null ? 5 : params.expansion;
	if (typeof expansion !== 'number' || !Number.isFinite(expansion) || expansion < 0)
		throw new Error('expansion 必须是大于或等于 0 的有限 mil 数值');
	const generationType = params.generationType == null ? 'pour' : params.generationType;
	if (generationType !== 'pour' && generationType !== 'fill')
		throw new Error('generationType 只能是 pour 或 fill');
	if (params.net != null && (typeof params.net !== 'string' || !params.net.trim()))
		throw new Error('net 必须是非空网络名称字符串');
	const enableChamfer = params.enableChamfer == null ? false : params.enableChamfer;
	if (typeof enableChamfer !== 'boolean')
		throw new Error('enableChamfer 必须是布尔值');
	const chamferType = params.chamferType == null ? 'straight' : params.chamferType;
	if (chamferType !== 'straight' && chamferType !== 'round')
		throw new Error('chamferType 只能是 straight 或 round');
	const chamferWidth = params.chamferWidth == null ? 5 : params.chamferWidth;
	if (typeof chamferWidth !== 'number' || !Number.isFinite(chamferWidth) || chamferWidth < 0)
		throw new Error('chamferWidth 必须是大于或等于 0 的有限 mil 数值');
	return {
		targetIds,
		layer,
		net: params.net as string | undefined,
		expansion,
		generationType: generationType as 'pour' | 'fill',
		enableChamfer,
		chamferType: chamferType as 'straight' | 'round',
		chamferWidth,
	};
}

function layerOf(target: any): number | undefined {
	const value = state<any>(target, 'Layer');
	if (typeof value === 'number' && Number.isFinite(value))
		return value;
	if (value === 'TOP')
		return TOP;
	if (value === 'BOTTOM')
		return BOTTOM;
	if (value === 'MULTI')
		return MULTI;
	return undefined;
}

function padInputProblem(pad: any, id: string, polygonUtils: any): string | undefined {
	const x = state(pad, 'X');
	const y = state(pad, 'Y');
	const rotation = state(pad, 'Rotation');
	const shape = state<any[]>(pad, 'Pad');
	if (!finite(x) || !finite(y))
		return `焊盘 ${id} 缺少有效 X/Y`;
	if (!finite(rotation))
		return `焊盘 ${id} 缺少有效 Rotation`;
	if (!Array.isArray(shape))
		return `焊盘 ${id} 缺少有效 Pad 外形`;
	if (shape[0] === 'RECT' || shape[0] === 'ELLIPSE' || shape[0] === 'OVAL') {
		if (!finite(shape[1]) || shape[1] <= 0 || !finite(shape[2]) || shape[2] <= 0)
			return `焊盘 ${id} 的 ${shape[0]} 外形尺寸无效`;
		return undefined;
	}
	if (shape[0] === 'NGON') {
		if (!finite(shape[1]) || shape[1] <= 0 || !finite(shape[2]) || shape[2] < 3 || !Number.isInteger(shape[2]))
			return `焊盘 ${id} 的 NGON 直径或边数无效`;
		return undefined;
	}
	if (shape[0] === 'POLYGON') {
		const points = polygonUtils.makePointsFromPolygonSource(shape[1]);
		if (!Array.isArray(points) || points.length < 3)
			return `焊盘 ${id} 的 POLYGON 外形缺少有效轮廓`;
		return undefined;
	}
	return `焊盘 ${id} 的外形类型 ${String(shape[0] ?? '(缺失)')} 不受上游几何支持`;
}

function targetBounds(points: Point[], expansion = 0) {
	return {
		minX: Math.min(...points.map(point => point.x)) - expansion,
		minY: Math.min(...points.map(point => point.y)) - expansion,
		maxX: Math.max(...points.map(point => point.x)) + expansion,
		maxY: Math.max(...points.map(point => point.y)) + expansion,
	};
}

function boxesOverlap(first: any, second: any): boolean {
	return first.minX <= second.maxX && first.maxX >= second.minX
		&& first.minY <= second.maxY && first.maxY >= second.minY;
}

function asBox(target: any): any {
	return {
		minX: Number(target.x) - Number(target.width) / 2,
		minY: Number(target.y) - Number(target.height) / 2,
		maxX: Number(target.x) + Number(target.width) / 2,
		maxY: Number(target.y) + Number(target.height) / 2,
	};
}

function outlineRings(lines: any[], polygonUtils: any): { rings: Point[][]; reason?: string } {
	if (lines.length === 0)
		return { rings: [] };
	const raw = lines.map(line => ({
		startX: state<number>(line, 'StartX'),
		startY: state<number>(line, 'StartY'),
		endX: state<number>(line, 'EndX'),
		endY: state<number>(line, 'EndY'),
	}));
	if (raw.some(segment => !finite(segment.startX) || !finite(segment.startY) || !finite(segment.endX) || !finite(segment.endY)))
		return { rings: [], reason: '板框线段坐标缺失' };
	const remaining: Array<{ start: Point; end: Point }> = raw.map(segment => ({
		start: { x: segment.startX as number, y: segment.startY as number },
		end: { x: segment.endX as number, y: segment.endY as number },
	}));
	const rings: Point[][] = [];
	while (remaining.length) {
		const first = remaining.shift()!;
		const ring = [first.start, first.end];
		while (Math.hypot(ring[ring.length - 1].x - ring[0].x, ring[ring.length - 1].y - ring[0].y) > 0.01) {
			const current = ring[ring.length - 1];
			const hits = remaining.flatMap((segment, index) => {
				if (Math.hypot(segment.start.x - current.x, segment.start.y - current.y) <= 0.01)
					return [{ index, point: segment.end }];
				if (Math.hypot(segment.end.x - current.x, segment.end.y - current.y) <= 0.01)
					return [{ index, point: segment.start }];
				return [];
			});
			if (hits.length !== 1)
				return { rings: [], reason: '板框线段不能唯一拼成闭环' };
			ring.push(hits[0].point);
			remaining.splice(hits[0].index, 1);
			if (ring.length > lines.length + 2)
				return { rings: [], reason: '板框闭环拼接未收敛' };
		}
		ring.pop();
		const cleaned = polygonUtils.cleanBoundaryPoints(ring);
		if (cleaned.length < 3)
			return { rings: [], reason: '板框闭环少于三个点' };
		rings.push(cleaned);
	}
	return { rings };
}

async function makePlan(host: GeometryHost, sdk: any, rawParams: Record<string, any>, baseline?: { source: string; rules: unknown }): Promise<AutoCopperPlan> {
	baseline ??= await host.getBaseline();
	const input = validateInputs(rawParams);
	const { layer, targetIds, net: requestedNet, expansion, generationType } = input;
	const targetLayerId = layer.id;
	const allPads = await readArray(host, sdk.pcb_PrimitivePad, '读取 PCB 焊盘');
	const allVias = await readArray(host, sdk.pcb_PrimitiveVia, '读取 PCB 过孔');
	const allComponents = await readArray(host, sdk.pcb_PrimitiveComponent, '读取 PCB 器件');
	const padsById = new Map(allPads.map(pad => [String(state(pad, 'PrimitiveId') ?? ''), pad]));
	const viasById = new Map(allVias.map(via => [String(state(via, 'PrimitiveId') ?? ''), via]));
	const componentsById = new Map(allComponents.map(component => [String(state(component, 'PrimitiveId') ?? ''), component]));
	const selectedTargets: Array<{ primitive: any; resolved: Target; sourceLayer: number; viaType?: number; owner?: string; netSource: string }> = [];
	const selectedPadIds = new Set<string>();
	const excludedTargets: Array<Record<string, unknown>> = [];
	const warnings: Array<Record<string, unknown>> = [];
	const unresolved: string[] = [];
	const { upstream, core, diagnostics } = configureCopperRuntime(sdk, host);
	for (const requestedId of targetIds) {
		const pad = padsById.get(requestedId);
		const via = viasById.get(requestedId);
		const component = componentsById.get(requestedId);
		if (pad) {
			if (selectedPadIds.has(requestedId))
				continue;
			selectedPadIds.add(requestedId);
			const geometryProblem = padInputProblem(pad, requestedId, upstream.polygonUtils);
			if (geometryProblem) {
				unresolved.push(geometryProblem);
				warnings.push({ code: 'unresolvedPadGeometry', targetId: requestedId, reason: geometryProblem, rawShape: state(pad, 'Pad') ?? null });
				continue;
			}
			const sourceLayer = layerOf(pad);
			const resolved = upstream.primitiveTargets.makePadTarget(pad) as Target;
			if (sourceLayer === undefined) {
				unresolved.push(`焊盘 ${requestedId} 缺少实际层`);
				continue;
			}
			selectedTargets.push({ primitive: pad, resolved, sourceLayer, netSource: 'pad.getState_Net', owner: undefined });
		}
		else if (via) {
			const sourceLayer = layerOf(via);
			const rawX = state(via, 'X');
			const rawY = state(via, 'Y');
			const rawDiameter = state(via, 'Diameter');
			const rawViaType = state(via, 'ViaType');
			const viaType = Number(rawViaType);
			if (!finite(rawX) || !finite(rawY) || !finite(rawDiameter) || rawDiameter <= 0 || !finite(rawViaType)) {
				const reason = `过孔 ${requestedId} 缺少有效 X/Y、Diameter 或 ViaType`;
				unresolved.push(reason);
				warnings.push({ code: 'unresolvedViaGeometry', targetId: requestedId, reason, raw: { x: rawX ?? null, y: rawY ?? null, diameter: rawDiameter ?? null, viaType: rawViaType ?? null } });
				continue;
			}
			const resolved = upstream.primitiveTargets.makeViaTarget(via) as Target;
			if (sourceLayer === undefined && viaType !== VIA_THROUGH) {
				unresolved.push(`盲埋孔 ${requestedId} 缺少可核实的跨层信息`);
				continue;
			}
			selectedTargets.push({ primitive: via, resolved, sourceLayer: sourceLayer ?? MULTI, viaType, netSource: 'via.getState_Net' });
		}
		else if (component) {
			const pins = await host.read(`读取器件 ${requestedId} 所有焊盘`, async () => {
				if (typeof component.getAllPins !== 'function')
					throw new Error(`器件 ${requestedId} 不支持公开 getAllPins`);
				const result = await component.getAllPins();
				if (!Array.isArray(result))
					throw new Error(`器件 ${requestedId} 的 getAllPins 未返回完整数组`);
				return result;
			});
			if (pins.length === 0) {
				unresolved.push(`器件 ${requestedId} 未返回焊盘`);
				continue;
			}
			for (const componentPad of pins) {
				const padId = String(state(componentPad, 'PrimitiveId') ?? '');
				if (!padId) {
					unresolved.push(`器件 ${requestedId} 返回的焊盘缺少 PrimitiveId`);
					continue;
				}
				if (selectedPadIds.has(padId))
					continue;
				selectedPadIds.add(padId);
				const geometryProblem = padInputProblem(componentPad, padId, upstream.polygonUtils);
				if (geometryProblem) {
					unresolved.push(geometryProblem);
					warnings.push({ code: 'unresolvedPadGeometry', targetId: padId, requestedBy: requestedId, reason: geometryProblem, rawShape: state(componentPad, 'Pad') ?? null });
					continue;
				}
				const sourceLayer = layerOf(componentPad);
				if (sourceLayer === undefined) {
					unresolved.push(`器件 ${requestedId} 焊盘 ${padId} 缺少实际层`);
					continue;
				}
				const resolved = upstream.primitiveTargets.makePadTarget(componentPad) as Target;
				selectedTargets.push({ primitive: componentPad, resolved, sourceLayer, netSource: 'component.getAllPins().getState_Net', owner: requestedId });
			}
		}
		else {
			unresolved.push(`targetId ${requestedId} 不存在，或不是焊盘/过孔/器件`);
		}
	}

	const selectedIds = new Set(selectedTargets.map(target => target.resolved.primitiveId));
	const layerTargets: Target[] = [];
	for (const item of selectedTargets) {
		const net = typeof item.resolved.net === 'string' ? item.resolved.net.trim() : '';
		if (!net) {
			unresolved.push(`${item.resolved.type} ${item.resolved.primitiveId} 缺少网络`);
			continue;
		}
		if (requestedNet && requestedNet !== net) {
			excludedTargets.push({ primitiveId: item.resolved.primitiveId, requestedBy: item.owner ?? null, type: item.resolved.type, net, layerId: item.sourceLayer, reason: `net 与筛选 ${requestedNet} 不匹配` });
			continue;
		}
		if (item.resolved.type === 'Via') {
			if (item.viaType !== VIA_THROUGH) {
				unresolved.push(`过孔 ${item.resolved.primitiveId} 类型 ${item.viaType} 的跨层范围不可由公开状态核实`);
				continue;
			}
		}
		else if (item.sourceLayer !== targetLayerId && item.sourceLayer !== MULTI) {
			excludedTargets.push({ primitiveId: item.resolved.primitiveId, requestedBy: item.owner ?? null, type: item.resolved.type, net, layerId: item.sourceLayer, reason: `实际层 ${item.sourceLayer} 与目标层 ${targetLayerId} 不符` });
			continue;
		}
		if (![item.resolved.x, item.resolved.y, item.resolved.shapeWidth, item.resolved.shapeHeight].every(finite)
			|| item.resolved.shapeWidth <= 0 || item.resolved.shapeHeight <= 0) {
			unresolved.push(`${item.resolved.type} ${item.resolved.primitiveId} 缺少有效位置或几何尺寸`);
			continue;
		}
		layerTargets.push({ ...item.resolved, resolvedLayer: layer.name, resolvedLayerId: targetLayerId, sourceLayerId: item.sourceLayer, viaType: item.viaType ?? null, requestedBy: item.owner ?? null, netSource: item.netSource });
	}
	if (layerTargets.length === 0)
		unresolved.push('目标层筛选后没有可用的焊盘或过孔');

	const netGroups = new Map<string, Target[]>();
	for (const target of layerTargets) {
		const key = `${target.net}\u0000${targetLayerId}`;
		const group = netGroups.get(key) ?? [];
		group.push(target);
		netGroups.set(key, group);
	}
	const config = {
		...upstream.constants.DEFAULT_CONFIG,
		generationType,
		targetLayer: targetLayerId,
		expansion,
		padBboxExpansion: expansion,
		enableChamfer: input.enableChamfer,
		chamferType: input.chamferType,
		chamferWidth: input.chamferWidth,
	};
	const drcRules = await upstream.drcRules.getPcbDrcRuleContext();
	const groups: Array<Record<string, unknown>> = [];
	const plannedPrimitives: PolygonPlan[] = [];
	const groupClearanceByNet = new Map<string, any>();
	for (const [_key, targets] of netGroups) {
		host.checkBudget();
		const net = targets[0].net;
		const genericClearance = upstream.drcRules.resolveDrcClearanceMil(net, '', drcRules, 'Pad', { generationType, layer: targetLayerId });
		if (!genericClearance)
			unresolved.push(`网络 ${net} 层 ${layer.name} 无法从完整 DRC 配置解析铜层异网间距规则`);
		else
			groupClearanceByNet.set(net, genericClearance);
		const boundaryRaw = await upstream.targetCollectors.collectCopperObstacles(targets, net, targetLayerId);
		host.checkBudget();
		const boundaryObstacles = upstream.drcRules.applyDrcClearanceToObstacles(boundaryRaw, net, drcRules, 'boundary', { generationType, layer: targetLayerId });
		const avoidanceRaw = await upstream.targetCollectors.collectCopperObstacles(targets, net, targetLayerId, { includeMultiPads: true, includeRegions: true });
		host.checkBudget();
		const avoidanceObstacles = upstream.drcRules.applyDrcClearanceToObstacles(avoidanceRaw, net, drcRules, 'avoidance', { generationType, layer: targetLayerId });
		const edgeShieldObstacles = await upstream.targetCollectors.collectPadEdgeShieldObstacles(targets, targetLayerId, { reportPadEdgeDiagnostic: (...args: unknown[]) => diagnostics.push({ level: 'diagnostic', args }), summarizePadEdgeCollection: (items: unknown[]) => items.map((item: any) => ({ id: item.primitiveId, type: item.type, net: item.net })) });
		host.checkBudget();
		const traceRaw = await upstream.targetCollectors.collectTraceClipObstacles(targets, net, targetLayerId);
		host.checkBudget();
		const traceObstacles = upstream.drcRules.applyDrcClearanceToObstacles(traceRaw, net, drcRules, 'trace clipping', { generationType, layer: targetLayerId });
		const copperAreaRaw = await upstream.targetCollectors.collectCopperAreaClipObstacles(targets, net, targetLayerId);
		host.checkBudget();
		const copperAreaObstacles = upstream.drcRules.applyDrcClearanceToObstacles(copperAreaRaw, net, drcRules, 'copper area clipping', { generationType, layer: targetLayerId });
		const targetMarginAdjustment = core.applyDrcAwareTargetMargins(targets, config, avoidanceObstacles.concat(traceObstacles, copperAreaObstacles));
		host.checkBudget();
		let polygonData = core.makeCleanPourPolygonData(targetMarginAdjustment.targets, config, boundaryObstacles, avoidanceObstacles, traceObstacles, copperAreaObstacles, { edgeShieldObstacles });
		host.checkBudget();
		let copperNodeClipObstacles = core.resolveCopperNodeClipObstacles(avoidanceObstacles, polygonData, generationType);
		let clearanceClipResult = core.makeClearanceClippedPolygons(polygonData, traceObstacles, copperAreaObstacles, copperNodeClipObstacles);
		host.checkBudget();
		let polygons = Array.isArray(clearanceClipResult.polygons) ? clearanceClipResult.polygons : [];
		if (polygons.length === 0 && core.shouldRetryMultiPadHybridBridgeAfterClipping(polygonData, clearanceClipResult)) {
			host.checkBudget();
			warnings.push({ code: 'upstreamBoundaryStrategyFallback', net, layer: layer.name, from: 'envelope', to: 'bridge', reason: clearanceClipResult.reason, debug: clearanceClipResult.debug });
			polygonData = core.makeCleanPourPolygonData(targetMarginAdjustment.targets, config, boundaryObstacles, avoidanceObstacles, traceObstacles, copperAreaObstacles, { edgeShieldObstacles, multiPadHybridForceBridge: true, allowMultiPadHybridBridgeRetry: false });
			copperNodeClipObstacles = core.resolveCopperNodeClipObstacles(avoidanceObstacles, polygonData, generationType);
			clearanceClipResult = core.makeClearanceClippedPolygons(polygonData, traceObstacles, copperAreaObstacles, copperNodeClipObstacles);
			host.checkBudget();
			polygons = Array.isArray(clearanceClipResult.polygons) ? clearanceClipResult.polygons : [];
		}
		const groupPolygons: Array<Record<string, unknown>> = [];
		for (const clipPolygon of polygons) {
			host.checkBudget();
			const polygon = clipPolygon as any;
			const sourcePolygon = polygon?.getSource?.();
			if (!sourcePolygon)
				throw new Error(`网络 ${net} 层 ${layer.name} 的上游裁剪结果没有 SDKPolygon 源码`);
			const sourceParts = upstream.polygonUtils.getPolygonSourceParts(sourcePolygon);
			const rings = sourceParts.map((part: unknown, index: number) => {
				const points = upstream.polygonUtils.makePointsFromFlatPolygonSource(part);
				if (points.length < 3)
					throw new Error(`网络 ${net} 层 ${layer.name} 的第 ${index} 个多边形环无效`);
				return upstream.polygonUtils.makeOrientedPolygonSource(points, index === 0 ? 1 : -1);
			});
			const polygonSources = rings.filter((source: unknown[]) => source.length >= 3);
			if (!Array.isArray(sourcePolygon) || polygonSources.length === 0)
				throw new Error(`网络 ${net} 层 ${layer.name} 的裁剪多边形源码读回为空`);
			const outerPoints = upstream.polygonUtils.makePointsFromFlatPolygonSource(sourceParts[0]);
			const area = Math.abs(outerPoints.reduce((sum: number, point: Point, index: number) => {
				const next = outerPoints[(index + 1) % outerPoints.length];
				return sum + point.x * next.y - next.x * point.y;
			}, 0) / 2);
			const polygonPlan: PolygonPlan = { net, layer: layer.name, layerId: targetLayerId, polygonSources, points: outerPoints, area };
			plannedPrimitives.push(polygonPlan);
			groupPolygons.push({ primitiveIndex: plannedPrimitives.length - 1, polygonSources, points: outerPoints, holeCount: polygonSources.length - 1, area });
		}
		if (polygons.length === 0)
			unresolved.push(`网络 ${net} 层 ${layer.name} 无可执行多边形：${clearanceClipResult.reason ?? '几何裁剪结果为空'}`);
		const { polygons: _sdkPolygons, ...clearanceSummary } = clearanceClipResult as any;
		const resolved = {
			targetMarginAdjustment,
			boundaryReducedExpansionCount: polygonData.boundaryReducedExpansionCount ?? 0,
			boundarySelection: Object.fromEntries(Object.entries(polygonData).filter(([name]) => /boundary|Fallback|degrad|avoid|unresolved/i.test(name))),
			clearance: { ...clearanceSummary, polygonSources: polygons.map((polygon: any) => polygon?.getSource?.() ?? null) },
			skippedObstacleCount: (clearanceClipResult as any).debug?.skippedNonClipObstacleCount ?? 0,
			obstacles: {
				boundary: boundaryObstacles.map((obstacle: any) => ({ id: obstacle.primitiveId, type: obstacle.type, net: obstacle.net, layer: obstacle.layer, clearanceMil: obstacle.clearanceMil, clearanceRuleSource: obstacle.clearanceRuleSource, clearanceRulePath: obstacle.clearanceRulePath })),
				avoidance: avoidanceObstacles.map((obstacle: any) => ({ id: obstacle.primitiveId, type: obstacle.type, net: obstacle.net, layer: obstacle.layer, clearanceMil: obstacle.clearanceMil, clearanceRuleSource: obstacle.clearanceRuleSource, clearanceRulePath: obstacle.clearanceRulePath })),
				trace: traceObstacles.map((obstacle: any) => ({ id: obstacle.primitiveId, type: obstacle.type, net: obstacle.net, layer: obstacle.layer, clearanceMil: obstacle.clearanceMil, clearanceRuleSource: obstacle.clearanceRuleSource, clearanceRulePath: obstacle.clearanceRulePath })),
				copperArea: copperAreaObstacles.map((obstacle: any) => ({ id: obstacle.primitiveId, type: obstacle.type, net: obstacle.net, layer: obstacle.layer, clearanceMil: obstacle.clearanceMil, clearanceRuleSource: obstacle.clearanceRuleSource, clearanceRulePath: obstacle.clearanceRulePath })),
			},
		};
		groups.push({ key: `${net}:${targetLayerId}`, net, layer: layer.name, layerId: targetLayerId, targets: targets.map(target => target.primitiveId), plannedPrimitiveIndexes: groupPolygons.map(item => item.primitiveIndex), genericCopperClearanceRule: genericClearance ?? null, resolved, diagnostics: diagnostics.slice() });
		if (targetMarginAdjustment.reducedCount > 0 || resolved.boundaryReducedExpansionCount > 0)
			warnings.push({ code: 'upstreamExpansionReduced', net, layer: layer.name, requestedMil: expansion, reducedMarginCount: targetMarginAdjustment.reducedCount, boundaryReducedCount: resolved.boundaryReducedExpansionCount, resolved: targetMarginAdjustment.targets.map((target: any) => ({ id: target.primitiveId, boundaryMargin: target.boundaryMargin ?? expansion, autoReducedExpansion: target.autoReducedExpansion ?? false, boundaryReducedExpansion: target.boundaryReducedExpansion ?? false })) });
		if (polygonData.multiPadBoundaryStrategy || polygonData.multiPadUnionBoundaryFallback || polygonData.multiPadHybridDegradationReasons)
			warnings.push({ code: 'upstreamBoundaryResolution', net, layer: layer.name, strategy: polygonData.multiPadBoundaryStrategy, unionFallback: polygonData.multiPadUnionBoundaryFallback ?? false, hybridDegradationReasons: polygonData.multiPadHybridDegradationReasons ?? [] });
		const neckDebug = (clearanceClipResult as any)?.debug ?? {};
		if (Number(neckDebug.neckNarrowCountAfter) > 0 || neckDebug.neckRepairReason)
			warnings.push({ code: 'upstreamNarrowNeckResolution', net, layer: layer.name, narrowCountBefore: neckDebug.neckNarrowCountBefore ?? null, narrowCountAfter: neckDebug.neckNarrowCountAfter ?? null, minimumWidthBefore: neckDebug.neckMinWidthBefore ?? null, minimumWidthAfter: neckDebug.neckMinWidthAfter ?? null, repairApplied: neckDebug.neckRepairApplied ?? false, repairPassCount: neckDebug.neckRepairPassCount ?? 0, repairReason: neckDebug.neckRepairReason ?? null, debug: neckDebug });
	}
	const crossGroupClearance: Array<Record<string, unknown>> = [];
	for (let firstGroup = 0; firstGroup < groups.length; firstGroup++) {
		host.checkBudget();
		for (let secondGroup = firstGroup + 1; secondGroup < groups.length; secondGroup++) {
			host.checkBudget();
			const a = groups[firstGroup] as any;
			const b = groups[secondGroup] as any;
			if (a.net === b.net || a.layerId !== b.layerId)
				continue;
			const rule = upstream.drcRules.resolveDrcClearanceMil(a.net, b.net, drcRules, 'CopperNode', { generationType, layer: targetLayerId });
			if (!rule) {
				unresolved.push(`不同网络 ${a.net}/${b.net} 间无法解析 DRC 铜间距规则`);
				crossGroupClearance.push({ nets: [a.net, b.net], resolved: false });
				continue;
			}
			const clearanceMil = Number(rule.value);
			crossGroupClearance.push({ nets: [a.net, b.net], resolved: true, clearanceMil, ruleSource: rule.source, rulePath: rule.path, check: 'conservative-expanded outer bounding boxes' });
			const gap = clearanceMil / 2;
			for (const firstIndex of a.plannedPrimitiveIndexes as number[]) {
				for (const secondIndex of b.plannedPrimitiveIndexes as number[]) {
					const first = plannedPrimitives[firstIndex];
					const second = plannedPrimitives[secondIndex];
					if (boxesOverlap(targetBounds(first.points, gap), targetBounds(second.points, gap)))
						unresolved.push(`不同网络 ${a.net}/${b.net} 的规划边界按 ${clearanceMil}mil 间距扩张后包围框相交 (${firstIndex}/${secondIndex})`);
				}
			}
		}
	}

	const arcObjects = await readArray(host, sdk.pcb_PrimitiveArc, '读取目标铜层圆弧', undefined, targetLayerId);
	const outlineLines = await readArray(host, sdk.pcb_PrimitiveLine, '读取板框层线段', undefined, BOARD_OUTLINE);
	const outlineArcs = await readArray(host, sdk.pcb_PrimitiveArc, '读取板框层圆弧', undefined, BOARD_OUTLINE);
	const outline = outlineArcs.length ? { rings: [], reason: '官方纯规划链不对板框弧线作拓扑内含验证' } : outlineRings(outlineLines, upstream.polygonUtils);
	const nearbyArcs: string[] = [];
	const boardConflictIds: string[] = [];
	for (const planned of plannedPrimitives) {
		host.checkBudget();
		const bounds = targetBounds(planned.points, expansion + POUR_LINE_WIDTH / 2);
		for (const arc of arcObjects) {
			const arcLayer = layerOf(arc);
			if (arcLayer !== undefined && arcLayer !== targetLayerId && arcLayer !== MULTI)
				continue;
			const arcTarget = upstream.primitiveTargets.makeArcObstacleTarget(arc);
			if (boxesOverlap(bounds, asBox(arcTarget)))
				nearbyArcs.push(String(state(arc, 'PrimitiveId') ?? '(无 ID)'));
		}
		for (const line of outlineLines) {
			const lineTarget = upstream.primitiveTargets.makeLineObstacleTarget(line);
			if (boxesOverlap(bounds, asBox(lineTarget)))
				boardConflictIds.push(String(state(line, 'PrimitiveId') ?? '(无 ID)'));
		}
		for (const arc of outlineArcs) {
			const arcTarget = upstream.primitiveTargets.makeArcObstacleTarget(arc);
			if (boxesOverlap(bounds, asBox(arcTarget)))
				boardConflictIds.push(String(state(arc, 'PrimitiveId') ?? '(无 ID)'));
		}
		if (!outline.reason && outline.rings.length === 1) {
			const outside = planned.points.some(point => !upstream.polygonUtils.pointInPolygon(point, outline.rings[0]));
			if (outside)
				boardConflictIds.push('candidate-outside-closed-board-outline');
		}
	}
	if (nearbyArcs.length)
		unresolved.push(`规划区域附近有官方链未处理的圆弧障碍：${[...new Set(nearbyArcs)].join(', ')}`);
	if (boardConflictIds.length)
		unresolved.push(`规划区域触及/越过板框：${[...new Set(boardConflictIds)].join(', ')}`);
	if (outline.reason)
		unresolved.push(outline.reason);
	if (!outline.reason && outline.rings.length !== 1)
		unresolved.push(`当前安全规划只支持一个已闭合线段板框，实际闭环数 ${outline.rings.length}`);

	warnings.push(...diagnostics.filter(item => item.level !== 'diagnostic').map(item => ({ code: 'upstreamGeometryDiagnostic', ...item })));
	const targets = selectedTargets.map(item => ({
		id: item.resolved.primitiveId,
		requestedBy: item.owner ?? null,
		type: item.resolved.type,
		x: item.resolved.x,
		y: item.resolved.y,
		net: item.resolved.net,
		netSource: item.netSource,
		layerId: item.sourceLayer,
		viaType: item.viaType ?? null,
		shapeKind: item.resolved.shapeKind,
		shapeWidth: item.resolved.shapeWidth,
		shapeHeight: item.resolved.shapeHeight,
		rotation: item.resolved.rotation,
	}));
	const coverage = {
		upstreamBoundaryAvoidanceAndClipping: '完整静态提取：实际边界生成、DRC margin、difference/union/offsetRings、障碍裁剪及多目标 envelope-to-bridge 几何策略',
		arcClearance: nearbyArcs.length ? { complete: false, nearbyArcIds: [...new Set(nearbyArcs)] } : { complete: true, method: '目标多边形边界框冲突核对，远离目标的圆弧不参与形状裁剪' },
		boardOutline: { complete: !outline.reason && outline.rings.length === 1 && boardConflictIds.length === 0, lineRingCount: outline.rings.length, arcs: outlineArcs.length, method: '线段闭环核对并验证多边形点；多环/弧线板框明确拒绝' },
		search: '上游按目标外接范围有限收集候选；collectors 对数据层执行完整 getAll 后再按搜索范围筛选',
		drc: '完整读取规则；候选网络需解析到通用铜间距规则，收集到的异网障碍逐一解析，计划网络之间另作保守包围框净距核对；不代表完整板级 DRC 结论',
		crossGroupClearance,
		excludedTargets,
		unresolved,
	};
	const plan: AutoCopperPlan = {
		documentUuid: host.documentUuid,
		operation: 'autoCopper',
		units: 'mil',
		inputs: { ...input, layer: layer.name },
		baseline,
		targets,
		excludedTargets,
		groups,
		plannedPrimitives,
		executable: unresolved.length === 0 && plannedPrimitives.length > 0 && excludedTargets.length < selectedIds.size,
		coverage,
		warnings,
		provenance: { repository: 'JLCEDA/eext-auto-copper-shape', commit: UPSTREAM_COMMIT, license: 'Apache-2.0', algorithm: 'static pure extraction; UI and original SDK write flow removed', geometryRuntime: 'bundled upstream polygon-clipping.js including clipper-lib offsetRings' },
	};
	await host.assertBaseline(baseline);
	return plan;
}

function mathPolygon(sdk: any, plan: PolygonPlan): any {
	const math = sdk.pcb_MathPolygon;
	if (!math || typeof math.createPolygon !== 'function' || typeof math.createComplexPolygon !== 'function')
		throw new Error('pcb_MathPolygon 缺少 createPolygon/createComplexPolygon');
	const polygon = plan.polygonSources.length === 1
		? math.createPolygon(plan.polygonSources[0])
		: math.createComplexPolygon(plan.polygonSources);
	if (!polygon)
		throw new Error(`网络 ${plan.net} 层 ${plan.layer} 的 plannedPrimitives 无法创建 SDKPolygon`);
	return polygon;
}

async function getPlan(params: Record<string, any>) {
	const host = await createGeometryHost(eda, params);
	try {
		const baseline = await host.getBaseline();
		const plan = await makePlan(host, eda, params, baseline);
		await host.finish();
		return plan;
	}
	catch (error) {
		return host.fail(error);
	}
}

async function executePlan(params: Record<string, any>) {
	const submitted = params.plan as AutoCopperPlan | undefined;
	if (!submitted || submitted.operation !== 'autoCopper' || submitted.units !== 'mil' || !submitted.baseline)
		throw new Error('必须传入由 pcb.getAutoCopperPlan 返回的完整 plan');
	const host = await createGeometryHost(eda, params, submitted.documentUuid);
	const created: Array<Record<string, unknown>> = [];
	let activePrimitiveIndex = -1;
	try {
		await host.assertBaseline(submitted.baseline);
		const input = { ...submitted.inputs, __docUuid: submitted.documentUuid } as Record<string, any>;
		const current = await makePlan(host, eda, input, submitted.baseline);
		if (!current.executable)
			throw new Error(`当前对象状态生成的计划不可执行：${JSON.stringify(current.coverage.unresolved)}`);
		for (const key of ['targets', 'excludedTargets', 'groups', 'plannedPrimitives', 'warnings', 'coverage']) {
			if (stableJson((current as any)[key]) !== stableJson((submitted as any)[key]))
				throw new Error(`plan.${key} 与当前 PCB/规则重新规划结果不一致，拒绝写入`);
		}
		await host.assertBaseline(submitted.baseline);
		if (!submitted.executable)
			throw new Error('plan.executable 为 false，拒绝写入');
		for (let index = 0; index < submitted.plannedPrimitives.length; index++) {
			activePrimitiveIndex = index;
			const planned = submitted.plannedPrimitives[index];
			const polygon = mathPolygon(eda, planned);
			let result: any;
			if (submitted.inputs.generationType === 'fill') {
				result = await host.write(`创建固定填充 ${index + 1}`, () => eda.pcb_PrimitiveFill.create(planned.layerId, polygon, planned.net, FILL_MODE_SOLID, POUR_LINE_WIDTH, false));
			}
			else {
				result = await host.write(`创建覆铜边框 ${index + 1}`, () => eda.pcb_PrimitivePour.create(planned.net, planned.layerId, polygon, 'solid' as any, false, `Auto Copper ${planned.net}`, undefined, POUR_LINE_WIDTH, false));
			}
			if (!result)
				throw new Error(`${planned.layer} 层 ${planned.net} 第 ${index + 1} 个铜皮创建返回 false/空值`);
			const id = String(state(result, 'PrimitiveId') ?? '');
			if (!id)
				throw new Error(`铜皮创建已返回对象，但没有 PrimitiveId，结果未知`);
			host.recordCreated(id);
			const api: any = submitted.inputs.generationType === 'fill' ? eda.pcb_PrimitiveFill : eda.pcb_PrimitivePour;
			const readback = await host.read(`按 ID 独立读回铜皮 ${id}`, async () => await api.get(id));
			if (!readback)
				throw new Error(`新铜皮 ${id} 按 ID 读回为空`);
			const actualNet = state<string>(readback, 'Net');
			const actualLayer = state<number>(readback, 'Layer');
			const actualPolygon = state<any>(readback, 'ComplexPolygon');
			const actualSource = actualPolygon?.getSource?.();
			if (actualNet !== planned.net || Number(actualLayer) !== planned.layerId || stableJson(actualSource) !== stableJson(planned.polygonSources.length === 1 ? planned.polygonSources[0] : planned.polygonSources))
				throw new Error(`新铜皮 ${id} 的独立读回网络/层/几何与计划不符`);
			host.recordVerified(id);
			const resultRecord: Record<string, unknown> = {
				id,
				net: actualNet,
				layer: actualLayer === TOP ? 'top' : actualLayer === BOTTOM ? 'bottom' : actualLayer,
				layerId: actualLayer,
				geometry: actualSource,
				status: submitted.inputs.generationType === 'fill' ? 'created-and-read-back-fixed-fill' : 'created-border; fill not yet verified',
			};
			created.push(resultRecord);
			if (submitted.inputs.generationType === 'pour') {
				const orderSource = await host.read(`读回铜皮排序源码 ${id}`, async () => {
					const source = await eda.sys_FileManager.getDocumentSource();
					if (typeof source !== 'string')
						throw new Error('源码读回为空或非字符串');
					const document = parseSourceLog(source);
					if (document.uuid !== submitted.documentUuid || document.docType.toUpperCase() !== 'PCB')
						throw new Error('覆铜源码读回的 DOCHEAD 不属于当前 PCB');
					const record = resolveRecords(document).get(`POUR\u0000${id}`);
					if (!record)
						throw new Error(`源码未读到新覆铜 ${id}`);
					const data = record.data as Record<string, unknown>;
					if (typeof data.order !== 'number' || !Number.isFinite(data.order))
						throw new Error(`源码中的覆铜 ${id} 未读到有效排序值`);
					return { order: data.order, sourceOrder: data.order, name: data.name ?? null };
				});
				resultRecord.orderReadback = orderSource;
				const pourObject = await host.read(`重建前覆铜对象读回 ${id}`, async () => await eda.pcb_PrimitivePour.get(id));
				if (!pourObject)
					throw new Error(`重建前覆铜 ${id} 读回为空`);
				if (typeof pourObject.rebuildCopperRegion !== 'function')
					throw new Error(`覆铜 ${id} 不支持 rebuildCopperRegion`);
				const poured = await host.write(`重建覆铜填充 ${id}`, async () => await pourObject.rebuildCopperRegion());
				if (!poured)
					throw new Error(`覆铜 ${id} rebuildCopperRegion 返回 false`);
				const fills = await readArray(host, eda.pcb_PrimitivePoured, `读回覆铜 ${id} 的实际填充`);
				const actualFills = fills.filter(fill => String(state(fill, 'PourPrimitiveId') ?? '') === id);
				if (actualFills.length === 0)
					throw new Error(`覆铜 ${id} 重建后没有读回填充图元`);
				resultRecord.status = 'created-border-and-rebuilt; fill read back';
				resultRecord.filledReadback = actualFills.map((fill) => {
					const fillsGeometry = state<any[]>(fill, 'PourFills');
					const geometry = Array.isArray(fillsGeometry) ? fillsGeometry.filter(item => item?.fill === true).map(item => item.path ?? null) : [];
					const net = state<string>(fill, 'Net');
					const layer = state<number>(fill, 'Layer');
					if (net !== planned.net || Number(layer) !== planned.layerId || geometry.length === 0 || geometry.some(item => !Array.isArray(item) || item.length === 0))
						throw new Error(`覆铜 ${id} 的实填充网络/层/几何读回与计划不符或为空`);
					return { id: state(fill, 'PrimitiveId'), pourPrimitiveId: state(fill, 'PourPrimitiveId'), net, layer, geometry };
				});
			}
		}
		await host.finish();
		return { documentUuid: host.documentUuid, operation: 'autoCopper', created, verifiedIds: [...created.map(item => item.id)], saved: false, drc: 'not run' };
	}
	catch (error) {
		const firstUnattempted = activePrimitiveIndex < 0 ? 0 : activePrimitiveIndex + 1;
		return host.fail(error, { created, unattemptedPrimitives: submitted.plannedPrimitives.slice(firstUnattempted).map((item, offset) => ({ index: firstUnattempted + offset, net: item.net, layer: item.layer })) });
	}
}

export const autoCopperCommands: ICommandDef[] = [
	{
		name: 'pcb.getAutoCopperPlan',
		summary: '只读生成自动局部铜皮计划；按目标对象网络及明确铜层分组并显示几何、规则、降级和覆盖范围。',
		params: [
			{ name: 'targetIds', type: 'string[]', required: true, description: '焊盘、过孔或器件的图元 ID；器件会展开其焊盘。' },
			{ name: 'layer', type: 'top|bottom', required: true, description: '明确的目标铜层；不会把 SMT 焊盘投影到另一面。' },
			{ name: 'net', type: 'string', required: false, description: '按网络名筛选。' },
			{ name: 'expansion', type: 'number', required: false, description: '外扩 mil，默认 5。' },
			{ name: 'generationType', type: 'pour|fill', required: false, description: 'pour 创建并重建覆铜，fill 创建固定填充；默认 pour。' },
			{ name: 'enableChamfer', type: 'boolean', required: false, description: '沿用上游倒角选项，默认 false。' },
			{ name: 'chamferType', type: 'straight|round', required: false, description: '倒角类型，默认 straight。' },
			{ name: 'chamferWidth', type: 'number', required: false, description: '倒角宽度 mil，默认 5。' },
		],
		returns: '含 documentUuid、operation、units、inputs、baseline、targets、excludedTargets、groups、plannedPrimitives、executable、coverage、warnings、provenance。只读，计划会携带完整源码基线。',
		example: { cmd: 'pcb.getAutoCopperPlan', params: { targetIds: ['pad-id'], layer: 'top', expansion: 5, generationType: 'pour' } },
		handler: getPlan,
	},
	{
		name: 'pcb.autoCopper',
		summary: '按此前计划创建局部铜皮；执行前核对焦点、对象、规则、几何计划和源码基线，逐项读回。',
		params: [{ name: 'plan', type: 'AutoCopperPlan', required: true, description: 'pcb.getAutoCopperPlan 返回的完整计划。' }],
		returns: '返回新建图元的网络、层、实际几何、覆铜排序源码读回、创建/填充读回状态；不自动保存。',
		example: { cmd: 'pcb.autoCopper', params: { plan: '$step1.data' } },
		handler: executePlan,
	},
];
