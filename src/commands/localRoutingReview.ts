import type { ICommandContext, ICommandDef } from '../engine/types';
import type { LocalArc, LocalBounds, LocalPad, LocalTrace, LocalVia } from '../pcb/localRoutingReview';
import { pcbSourceRevision } from '../pcb/dsnSourceSnapshot';
import { analyzeLocalRouting } from '../pcb/localRoutingReview';

function state(object: any, getter: string, label: string): unknown {
	if (typeof object?.[getter] !== 'function')
		throw new Error(`${label} 缺少 ${getter} 读取接口`);
	const value = object[getter]();
	if (value === undefined || value === null)
		throw new Error(`${label} 的 ${getter} 读回为空`);
	return value;
}

function finiteNumber(value: unknown, label: string): number {
	const number = Number(value);
	if (!Number.isFinite(number))
		throw new Error(`${label} 不是有限数值`);
	return number;
}

function requiredString(value: unknown, label: string): string {
	const result = String(value);
	if (!result.trim())
		throw new Error(`${label} 为空`);
	return result;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs); }),
		]);
	}
	finally {
		if (timer !== undefined)
			clearTimeout(timer);
	}
}

function readNetName(object: any, label = '走线'): string {
	const getter = object?.getState_Net;
	if (typeof getter !== 'function')
		throw new Error(`${label} 缺少 getState_Net 读取接口`);
	const value = getter.call(object);
	// A native unassigned line may legitimately return null/undefined or an empty string.
	// Keep it as unidentified evidence rather than aborting the complete board read.
	if (value === undefined || value === null || value === '')
		return '';
	if (typeof value !== 'string')
		throw new Error(`${label}网络读回不是文本`);
	return value;
}

function parseRegion(value: unknown): LocalBounds | undefined {
	if (value === undefined)
		return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('region 必须是 { minX, minY, maxX, maxY }');
	const bounds = value as LocalBounds;
	if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
		|| bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
		throw new Error('region 必须含有限坐标，且 minX < maxX、minY < maxY');
	}
	return bounds;
}

async function readPcbRevision(ctx: ICommandContext): Promise<string | undefined> {
	if (typeof eda.sys_FileManager?.getDocumentSource !== 'function')
		return undefined;
	await ctx.assertDocumentTarget?.();
	try {
		const source = await withTimeout(eda.sys_FileManager.getDocumentSource(), 5000, 'PCB 修订读取');
		if (typeof source !== 'string')
			return undefined;
		return await pcbSourceRevision(source, ctx.documentTarget!.uuid);
	}
	catch {
		return undefined;
	}
}

async function readRequiredLines(): Promise<LocalTrace[]> {
	if (typeof eda.pcb_PrimitiveLine?.getAll !== 'function')
		throw new Error('当前 SDK 不支持读取 PCB 走线');
	const objects = await eda.pcb_PrimitiveLine.getAll();
	if (!Array.isArray(objects))
		throw new Error('PCB 走线列表读回不完整');
	return objects.map((line: any) => {
		const trace = {
			id: requiredString(state(line, 'getState_PrimitiveId', '走线'), '走线 ID'),
			net: readNetName(line),
			layer: finiteNumber(state(line, 'getState_Layer', '走线'), '走线层'),
			width: finiteNumber(state(line, 'getState_LineWidth', '走线'), '走线宽度'),
			start: { x: finiteNumber(state(line, 'getState_StartX', '走线'), '走线起点 X'), y: finiteNumber(state(line, 'getState_StartY', '走线'), '走线起点 Y') },
			end: { x: finiteNumber(state(line, 'getState_EndX', '走线'), '走线终点 X'), y: finiteNumber(state(line, 'getState_EndY', '走线'), '走线终点 Y') },
		};
		return trace;
	});
}

async function readOptionalCategory<T>(read: () => Promise<T[]>): Promise<{ values: T[]; status: 'read' | 'unknown'; reason?: string }> {
	try {
		return { values: await read(), status: 'read' };
	}
	catch (error) {
		return { values: [], status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
	}
}

async function readArcs(): Promise<LocalArc[]> {
	if (typeof eda.pcb_PrimitiveArc?.getAll !== 'function')
		throw new Error('SDK 没有圆弧列表接口');
	const objects = await eda.pcb_PrimitiveArc.getAll();
	if (!Array.isArray(objects))
		throw new Error('圆弧列表读回不完整');
	return objects.map((arc: any) => ({
		id: requiredString(state(arc, 'getState_PrimitiveId', '圆弧'), '圆弧 ID'),
		net: readNetName(arc, '圆弧'),
		layer: finiteNumber(state(arc, 'getState_Layer', '圆弧'), '圆弧层'),
		width: finiteNumber(state(arc, 'getState_LineWidth', '圆弧'), '圆弧线宽'),
		sweepDegrees: finiteNumber(state(arc, 'getState_ArcAngle', '圆弧'), '圆弧角度'),
		start: { x: finiteNumber(state(arc, 'getState_StartX', '圆弧'), '圆弧起点 X'), y: finiteNumber(state(arc, 'getState_StartY', '圆弧'), '圆弧起点 Y') },
		end: { x: finiteNumber(state(arc, 'getState_EndX', '圆弧'), '圆弧终点 X'), y: finiteNumber(state(arc, 'getState_EndY', '圆弧'), '圆弧终点 Y') },
	}));
}

async function readVias(): Promise<LocalVia[]> {
	if (typeof eda.pcb_PrimitiveVia?.getAll !== 'function')
		throw new Error('SDK 没有过孔列表接口');
	const objects = await eda.pcb_PrimitiveVia.getAll();
	if (!Array.isArray(objects))
		throw new Error('过孔列表读回不完整');
	return objects.map((via: any) => ({
		id: requiredString(state(via, 'getState_PrimitiveId', '过孔'), '过孔 ID'),
		net: readNetName(via, '过孔'),
		x: finiteNumber(state(via, 'getState_X', '过孔'), '过孔 X'),
		y: finiteNumber(state(via, 'getState_Y', '过孔'), '过孔 Y'),
		diameter: finiteNumber(state(via, 'getState_Diameter', '过孔'), '过孔外径'),
		holeDiameter: finiteNumber(state(via, 'getState_HoleDiameter', '过孔'), '过孔孔径'),
		viaType: finiteNumber(state(via, 'getState_ViaType', '过孔'), '过孔类型'),
	}));
}

export async function readRoutingPads(): Promise<LocalPad[]> {
	if (typeof eda.pcb_PrimitivePad?.getAll !== 'function')
		throw new Error('SDK 没有焊盘列表接口');
	const independent = await eda.pcb_PrimitivePad.getAll();
	if (typeof eda.pcb_PrimitiveComponent?.getAll !== 'function')
		throw new Error('SDK 没有器件列表接口，无法读取器件引脚焊盘');
	const components = await eda.pcb_PrimitiveComponent.getAll();
	if (!Array.isArray(independent) || !Array.isArray(components))
		throw new Error('焊盘列表读回不完整');
	const byId = new Map<string, LocalPad>();
	const add = (pad: any) => {
		const id = requiredString(state(pad, 'getState_PrimitiveId', '焊盘'), '焊盘 ID');
		const netValue = typeof pad.getState_Net === 'function' ? pad.getState_Net() : undefined;
		if (netValue != null && typeof netValue !== 'string')
			throw new Error(`焊盘 ${id} 网络读回不是文本`);
		byId.set(id, { id, net: netValue ?? '', rotation: finiteNumber(state(pad, 'getState_Rotation', '焊盘'), '焊盘角度'), shape: typeof pad.getState_Pad === 'function' ? pad.getState_Pad() : undefined, hole: typeof pad.getState_Hole === 'function' ? pad.getState_Hole() : undefined, special: typeof pad.getState_SpecialPad === 'function' ? pad.getState_SpecialPad() : undefined, layer: finiteNumber(state(pad, 'getState_Layer', '焊盘'), '焊盘层'), x: finiteNumber(state(pad, 'getState_X', '焊盘'), '焊盘 X'), y: finiteNumber(state(pad, 'getState_Y', '焊盘'), '焊盘 Y') });
	};
	for (const pad of independent) add(pad);
	for (const component of components) {
		const componentId = requiredString(state(component, 'getState_PrimitiveId', '器件'), '器件 ID');
		if (typeof component?.getAllPins !== 'function')
			throw new Error(`器件 ${componentId} 缺少 getAllPins`);
		const pins = await component.getAllPins();
		if (!Array.isArray(pins))
			throw new Error(`器件 ${componentId} 的焊盘列表读回不完整`);
		for (const pin of pins) add(pin);
	}
	return [...byId.values()];
}

export async function reviewLocalRouting(params: Record<string, any>, ctx?: ICommandContext) {
	if (params.nets !== undefined && (!Array.isArray(params.nets) || !params.nets.length
		|| params.nets.some((net: unknown) => typeof net !== 'string' || !net.trim()))) {
		throw new Error('nets 必须为非空网络名数组');
	}
	const region = parseRegion(params.region);
	if (!region && !params.nets?.length)
		throw new Error('nets 和 region 至少提供一项');
	const target = ctx?.documentTarget;
	if (!target || target.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('缺少当前 PCB 目标身份校验，拒绝生成局部布线报告');
	await ctx.assertDocumentTarget();
	const revisionBefore = await readPcbRevision(ctx);
	const lines = await readRequiredLines();
	const arcs = await readOptionalCategory(readArcs);
	const vias = await readOptionalCategory(readVias);
	const pads = await readOptionalCategory(readRoutingPads);
	await ctx.assertDocumentTarget();
	const revisionAfter = await readPcbRevision(ctx);
	const analysis = analyzeLocalRouting({ nets: params.nets as string[] | undefined, region, lines, arcs: arcs.values, vias: vias.values, pads: pads.values });
	const freshness = revisionBefore && revisionAfter
		? { status: revisionBefore === revisionAfter ? 'current' : 'stale', before: revisionBefore, after: revisionAfter }
		: { status: 'unknown', before: revisionBefore ?? null, after: revisionAfter ?? null, reason: '宿主未提供可核对的完整 PCB 源修订' };
	const categoryReadCompleteness = { lines: 'read', arcs: arcs.status, vias: vias.status, padsAndComponentPins: pads.status };
	const inputsComplete = Object.values(categoryReadCompleteness).every(status => status === 'read');
	return {
		...analysis,
		freshness,
		coverage: {
			...analysis.coverage,
			categoryReadCompleteness,
			currentAtReturn: freshness.status === 'current',
		},
		resultStatus: freshness.status !== 'current' ? freshness.status : inputsComplete ? 'current-partial-geometric-review' : 'partial-missing-read-categories',
		minimumTraceClearanceReadCompleteness: { status: inputsComplete ? 'all object categories read; supported shapes only' : 'partial-missing-read-categories', categoryReadCompleteness },
		geometryCompleteness: { status: 'partial', reason: '未覆盖铜区实填几何、全部形状和完整电气/跨层连通；见 coverage.unsupportedGeometry' },
		target,
		source: 'EDA SDK 走线图元读回；不写入工程',
		readStatus: {
			lines: { status: 'read', readObjects: lines.length },
			arcs: { status: arcs.status, count: arcs.values.length, reason: arcs.reason },
			vias: { status: vias.status, count: vias.values.length, reason: vias.reason },
			pads: { status: pads.status, count: pads.values.length, reason: pads.reason },
		},
	};
}

export const localRoutingReviewCommands: ICommandDef[] = [{
	name: 'pcb.reviewLocalRouting',
	summary: '只读检查指定网络或矩形区域内的直线/圆弧图形接触、非45度直线转角，以及与可识别焊盘和通孔的同层异网间距估算；不能证明完整电气连通、铜区填充或代替原生 DRC',
	params: [
		{ name: 'nets', type: 'string[]', description: '网络名列表；和 region 至少提供一项' },
		{ name: 'region', type: 'object', description: '局部矩形 {minX,minY,maxX,maxY}，单位 mil；和 nets 至少提供一项' },
	],
	returns: '{ target, tracks:{count,arcCount,traceGraphComponents,fullNetConnectivityVerified:false}, turns, minimumTraceClearance, contacts, coverage, readStatus }',
	example: { cmd: 'pcb.reviewLocalRouting', params: { nets: ['VBAT'] } },
	handler: reviewLocalRouting,
}];
