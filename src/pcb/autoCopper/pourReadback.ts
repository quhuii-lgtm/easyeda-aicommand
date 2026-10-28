import type { GeometryHost } from '../geometryHost';
import { comparePolygonSource } from './geometryReadback';
import { normalizePouredPathSource, readEditorVersion } from '../pouredUnits';

interface ParentExpectation {
	primitiveId: string;
	net: string;
	layerId: number;
}

interface ParentReadback {
	id: string;
	net: string;
	layer: number;
}

interface FilledRegionReadback {
	pouredId: string;
	id: string | null;
	fill: boolean | null;
	lineWidth: number | null;
	pathGetter: 'function' | 'missing';
	pathSource?: unknown;
	normalizedPathMil?: unknown | null;
	coordinateUnit: 'mil' | 'unknown';
	normalization: { status: 'normalized' | 'unsupported'; reason: string; editorVersion: string | null; conversionFactor: number | null };
}

export interface PourFillReadback {
	parent: ParentReadback;
	parentSource: unknown;
	boundaryComparison: { mode: string; matches: boolean | null };
	association: { matchedPouredIds: string[]; count: number };
	netLayerSource: 'parent-pour';
	pouredNetLayerGetters: Array<{ pouredId: string; net: 'function' | 'missing'; layer: 'function' | 'missing' }>;
	filledRegions: FilledRegionReadback[];
}

function state<T = any>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		return undefined;
	return getter.call(object) as T;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function validSource(source: unknown): boolean {
	if (!Array.isArray(source) || source.length === 0)
		return false;
	const pending: unknown[] = [source];
	const visited = new WeakSet<object>();
	while (pending.length) {
		const current = pending.pop();
		if (Array.isArray(current)) {
			if (current.length === 0 || visited.has(current))
				return false;
			visited.add(current);
			for (const item of current)
				pending.push(item);
			continue;
		}
		if (!finite(current) && !(typeof current === 'string' && current.length > 0))
			return false;
	}
	return true;
}

function sourceSnapshot(source: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(source)) {
		if (seen.has(source))
			return { type: 'array-cycle' };
		seen.add(source);
		return source.map(item => sourceSnapshot(item, seen));
	}
	if (source === null || typeof source === 'string' || typeof source === 'number' || typeof source === 'boolean')
		return source;
	if (source === undefined)
		return null;
	return { type: typeof source };
}

function fail(message: string, evidence: Record<string, unknown>): never {
	const error = new Error(message) as Error & { cause?: unknown };
	error.cause = { fillReadback: evidence };
	throw error;
}

async function collectPourFillReadback(host: GeometryHost, sdk: any, expected: ParentExpectation & { plannedSource?: unknown }, observed: Record<string, unknown>): Promise<PourFillReadback> {
	const editorVersion = readEditorVersion(sdk);
	const parentObject = await host.read(`按 ID 读回覆铜边框 ${expected.primitiveId}`, async () => await sdk.pcb_PrimitivePour.get(expected.primitiveId));
	if (!parentObject)
		fail(`覆铜边框 ${expected.primitiveId} 按 ID 读回为空`, { parentId: expected.primitiveId, matchedPouredIds: [] });
	const parent = await host.read(`读取覆铜边框 ${expected.primitiveId} 网络、层和边界`, () => {
		const polygon = state<any>(parentObject, 'ComplexPolygon');
		const hasSourceGetter = typeof polygon?.getSource === 'function';
		return {
			id: state<string>(parentObject, 'PrimitiveId'),
			net: state<string>(parentObject, 'Net'),
			layer: state<number>(parentObject, 'Layer'),
			parentSource: hasSourceGetter ? polygon.getSource() : undefined,
			hasSourceGetter,
		};
	});
	const parentSource = parent.parentSource;
	observed.parent = { id: parent.id ?? null, net: parent.net ?? null, layer: parent.layer ?? null };
	observed.parentSource = sourceSnapshot(parentSource);
	if (parent.id !== expected.primitiveId || parent.net !== expected.net || Number(parent.layer) !== expected.layerId)
		fail(`覆铜边框 ${expected.primitiveId} 的父边界 ID/网络/层与预期不符`, { parent: { id: parent.id ?? null, net: parent.net ?? null, layer: parent.layer ?? null }, parentSource: parentSource ?? null, expected });
	if (!parent.hasSourceGetter)
		fail(`覆铜边框 ${expected.primitiveId} 的 ComplexPolygon 缺少 getSource()`, { parent: { id: parent.id ?? null, net: parent.net ?? null, layer: parent.layer ?? null }, parentSource: null });
	if (!validSource(parentSource))
		fail(`覆铜边框 ${expected.primitiveId} 的 ComplexPolygon.getSource() 未返回非空合法数组`, { parent: { id: parent.id ?? null, net: parent.net ?? null, layer: parent.layer ?? null }, parentSource: parentSource ?? null });
	const comparison = expected.plannedSource === undefined ? undefined : comparePolygonSource(expected.plannedSource, parentSource);
	const boundaryComparison = comparison
		? { ...comparison, mode: `planned-source-${comparison.mode}` }
		: { mode: 'observed-only-no-planned-source', matches: null };
	if (boundaryComparison.matches === false)
		fail(`覆铜边框 ${expected.primitiveId} 的重建后边界与计划不符`, { parent: { id: parent.id, net: parent.net, layer: parent.layer }, plannedSource: expected.plannedSource, parentSource, boundaryComparison });
	const poured = await host.read(`读取覆铜边框 ${expected.primitiveId} 的实填充列表`, async () => {
		const result = await sdk.pcb_PrimitivePoured.getAll();
		if (!Array.isArray(result))
			throw new Error('pcb_PrimitivePoured.getAll 未返回数组');
		return result;
	});
	const associations = await host.read(`读取实填充 ${expected.primitiveId} 关联 ID`, () => poured.map((item: any) => ({
		item,
		id: state<string>(item, 'PrimitiveId'),
		pourId: state<string>(item, 'PourPrimitiveId'),
	})));
	if (associations.some((item: any) => typeof item.id !== 'string' || !item.id || typeof item.pourId !== 'string' || !item.pourId))
		fail(`实填充列表中存在缺少自身 ID 或父边框 ID 的对象`, { parent, associations: associations.map(({ id, pourId }: any) => ({ id: id ?? null, pourId: pourId ?? null })) });
	const matched = associations.filter((item: any) => item.pourId === expected.primitiveId);
	observed.association = {
		matchedPouredIds: matched.map((item: any) => item.id),
		count: matched.length,
		observedPouredIds: associations.map((item: any) => ({ id: item.id ?? null, pourId: item.pourId ?? null })),
	};
	observed.pouredNetLayerGetters = matched.map((item: any) => ({
		pouredId: item.id,
		net: typeof item.item?.getState_Net === 'function' ? 'function' : 'missing',
		layer: typeof item.item?.getState_Layer === 'function' ? 'function' : 'missing',
	}));
	if (matched.length === 0)
		fail(`覆铜边框 ${expected.primitiveId} 没有按 PourPrimitiveId 关联的实填充`, { parent, matchedPouredIds: [] });
	const filledRegions: FilledRegionReadback[] = [];
	observed.filledRegions = filledRegions;
	let filledRegionCount = 0;
	for (const association of matched as Array<{ item: any; id: string; pourId: string }>) {
		await host.read(`读取实填充 ${association.id} 子区域`, () => {
			const fills = state<any[]>(association.item, 'PourFills');
			if (!Array.isArray(fills))
				throw new Error(`实填充 ${association.id} 的 PourFills 未返回数组`);
			return fills.map((region, index) => {
				const id = region?.id;
				const fill = region?.fill;
				const lineWidth = region?.lineWidth;
				const path = region?.path;
				const evidence: FilledRegionReadback = {
					pouredId: association.id,
					id: typeof id === 'string' ? id : null,
					fill: typeof fill === 'boolean' ? fill : null,
					lineWidth: finite(lineWidth) ? lineWidth : null,
					pathGetter: typeof path?.getSource === 'function' ? 'function' : 'missing',
					coordinateUnit: 'unknown',
					normalization: { status: 'unsupported', reason: fill === true ? 'path-not-read' : 'not-filled', editorVersion, conversionFactor: null },
				};
				filledRegions.push(evidence);
				if (typeof id !== 'string' || !id || typeof fill !== 'boolean' || !finite(lineWidth) || lineWidth < 0)
					throw new Error(`实填充 ${association.id} 的区域 ${index} ID/fill/lineWidth 无效`);
				if (fill) {
					if (evidence.pathGetter !== 'function')
						throw new Error(`实填充 ${association.id} 区域 ${id} 的 path 缺少 getSource()`);
					let source: unknown;
					try {
						source = path.getSource();
					}
					catch (error) {
						evidence.pathSource = { getSourceError: error instanceof Error ? error.message : String(error) };
						throw error;
					}
					evidence.pathSource = sourceSnapshot(source);
					if (!validSource(source))
						throw new Error(`实填充 ${association.id} 区域 ${id} 的 path.getSource() 未返回非空合法数组`);
					const normalized = normalizePouredPathSource(source, { fill, lineWidth, editorVersion, declaredCoordinateUnit: (region as any)?.coordinateUnit });
					evidence.coordinateUnit = normalized.coordinateUnit;
					evidence.normalization = { status: normalized.status, reason: normalized.normalization, editorVersion: normalized.editorVersion, conversionFactor: normalized.conversionFactor };
					evidence.normalizedPathMil = normalized.normalizedPathMil === undefined ? null : sourceSnapshot(normalized.normalizedPathMil);
					filledRegionCount++;
				}
				return { ...evidence };
			});
		});
	}
	const evidence: PourFillReadback = {
		parent: { id: parent.id as string, net: parent.net as string, layer: Number(parent.layer) },
		parentSource,
		boundaryComparison,
		association: { matchedPouredIds: matched.map((item: any) => item.id), count: matched.length },
		netLayerSource: 'parent-pour',
		pouredNetLayerGetters: matched.map((item: any) => ({
			pouredId: item.id,
			net: typeof item.item?.getState_Net === 'function' ? 'function' : 'missing',
			layer: typeof item.item?.getState_Layer === 'function' ? 'function' : 'missing',
		})),
		filledRegions,
	};
	if (filledRegionCount === 0)
		fail(`覆铜边框 ${expected.primitiveId} 没有 fill=true 的有效实填充区域`, evidence as unknown as Record<string, unknown>);
	return evidence;
}

export async function readPourFillReadback(host: GeometryHost, sdk: any, expected: ParentExpectation & { plannedSource?: unknown }): Promise<PourFillReadback> {
	const observed: Record<string, unknown> = {
		primitiveId: expected.primitiveId,
		expectedNet: expected.net,
		expectedLayer: expected.layerId,
		plannedSource: expected.plannedSource === undefined ? null : sourceSnapshot(expected.plannedSource),
		netLayerSource: 'parent-pour',
	};
	try {
		return await collectPourFillReadback(host, sdk, expected, observed);
	}
	catch (error) {
		const wrapped = (error instanceof Error ? error : new Error(String(error))) as Error & { cause?: unknown };
		const prior = wrapped.cause && typeof wrapped.cause === 'object' ? wrapped.cause as Record<string, unknown> : {};
		wrapped.cause = {
			...prior,
			fillReadback: {
				...observed,
				...(prior.fillReadback && typeof prior.fillReadback === 'object' ? prior.fillReadback as Record<string, unknown> : {}),
				readError: wrapped.message,
			},
		};
		throw wrapped;
	}
}
