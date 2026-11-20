import type { ICommandContext, ICommandDef } from '../engine/types';
import { pcbPlacementPrimitiveCommands } from './pcbPlacementPrimitives';
import { reviewCopperShape } from './copperShapeReview';
import { comparePolygonSource } from '../pcb/autoCopper/geometryReadback';
import { pcbRevisionDigest, pcbSourceRevision, comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';
import { effectiveRecordsByType, parseSourceLog } from '../pcb/sourcelog';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Keepout = {
	net: string;
	pourPrimitiveId: string;
	filledRegionId: string;
	layer: number;
	polygonSource: unknown[];
	widthMil: number;
	lengthMil: number;
	marginMil: number;
	action: 'create' | 'reuse';
	warning?: string;
};
type Plan = {
	target: NonNullable<ICommandContext['documentTarget']>;
	pcbRevision: string;
	regions: Keepout[];
	skipped: Array<{ net: string; pourPrimitiveId?: string; reason: string }>;
	warnings: string[];
};
type Primitive = Record<string, any>;

const METADATA = new Set(['__projectUuid', '__docUuid', '__tabId']);
const AREA_EPSILON_RATIO = 0.1;
const COMPARABLE_AREA_RATIO = 0.9;

function read<T = unknown>(object: Primitive, getter: string, label: string): T {
	const fn = object?.[`getState_${getter}`];
	if (typeof fn !== 'function')
		throw new Error(`${label} 缺少 ${getter} 读取接口`);
	const value = fn.call(object);
	if (value === undefined || value === null)
		throw new Error(`${label} 的 ${getter} 读回为空`);
	return value as T;
}

function assertParams(params: Record<string, any>, apply: boolean): { nets: string[]; maxStripWidthMil: number; marginMil: number; planId?: string } {
	const allowed = new Set(['nets', 'maxStripWidthMil', 'marginMil', ...(apply ? ['planId'] : [])]);
	const unknown = Object.keys(params).filter(key => !METADATA.has(key) && !allowed.has(key));
	if (unknown.length)
		throw new Error(`不支持的参数：${unknown.join(', ')}`);
	if (!Array.isArray(params.nets) || params.nets.length === 0 || params.nets.some((net: unknown) => typeof net !== 'string' || !net.trim()))
		throw new Error('nets 必须是非空网络名称数组');
	const nets = [...new Set(params.nets.map((net: string) => net.trim()))];
	if (typeof params.maxStripWidthMil !== 'number' || !Number.isFinite(params.maxStripWidthMil) || params.maxStripWidthMil <= 0)
		throw new Error('maxStripWidthMil 必须是明确提供的正数，单位 mil');
	const marginMil = params.marginMil === undefined ? 6 : params.marginMil;
	if (typeof marginMil !== 'number' || !Number.isFinite(marginMil) || marginMil < 0)
		throw new Error('marginMil 必须是大于等于 0 的有限数值，单位 mil');
	if (apply && (typeof params.planId !== 'string' || !params.planId.trim()))
		throw new Error('apply 必须提供预览返回的 planId');
	return { nets, maxStripWidthMil: params.maxStripWidthMil, marginMil, ...(apply ? { planId: params.planId } : {}) };
}

async function assertPcbTarget(ctx?: ICommandContext): Promise<NonNullable<ICommandContext['documentTarget']>> {
	const target = ctx?.documentTarget;
	if (!target || target.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('缺少当前 PCB 工程与图页身份，拒绝操作');
	await ctx.assertDocumentTarget();
	return target;
}

async function currentSource(target: NonNullable<ICommandContext['documentTarget']>, ctx?: ICommandContext): Promise<{ source: string; revision: string }> {
	await assertPcbTarget(ctx);
	const source = await (eda as any).sys_FileManager.getDocumentSource();
	if (typeof source !== 'string')
		throw new Error('无法读取当前 PCB 源码');
	const doc = parseSourceLog(source);
	if (doc.docType.toUpperCase() !== 'PCB' || doc.uuid !== target.uuid)
		throw new Error('当前编辑器 PCB 身份与绑定目标不一致');
	const revision = await pcbSourceRevision(source, target.uuid);
	await assertPcbTarget(ctx);
	return { source, revision };
}

function stablePolygon(value: unknown): unknown {
	if (value && typeof value === 'object' && typeof (value as any).getSource === 'function')
		return (value as any).getSource();
	return value;
}

function bboxPath(bounds: Bounds, margin: number): unknown[] {
	// The host reliably round-trips its native rectangle source form; explicit
	// outward rounding ensures the keepout never clips the verified copper bbox.
	const x1 = Math.floor(bounds.minX - margin + 1e-9);
	const y1 = Math.floor(bounds.minY - margin + 1e-9);
	const x2 = Math.ceil(bounds.maxX + margin - 1e-9);
	const y2 = Math.ceil(bounds.maxY + margin - 1e-9);
	// In this SDK's PCB coordinate convention, the rectangle's Y value is its
	// lower edge (maxY); height extends toward decreasing Y.
	return ['R', x1, y2, x2 - x1, y2 - y1, 0, 0];
}

function validateBounds(value: any): Bounds | undefined {
	const bounds = value?.boundsMil;
	if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))
		return undefined;
	if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY)
		return undefined;
	return bounds;
}

function getRegionListItem(item: Primitive): { primitiveId: string; layer: number; ruleType: number[]; polygonSource: unknown; primitiveLock: boolean } {
	const primitiveId = read<string>(item, 'PrimitiveId', '区域');
	const layer = read<number>(item, 'Layer', `区域 ${primitiveId}`);
	const ruleType = read<number[]>(item, 'RuleType', `区域 ${primitiveId}`);
	const polygon = read<any>(item, 'ComplexPolygon', `区域 ${primitiveId}`);
	const polygonSource = stablePolygon(polygon);
	const primitiveLock = read<boolean>(item, 'PrimitiveLock', `区域 ${primitiveId}`);
	if (!Array.isArray(ruleType) || !Array.isArray(polygonSource) || typeof primitiveLock !== 'boolean')
		throw new Error(`区域 ${primitiveId} 属性格式不受支持`);
	return { primitiveId, layer, ruleType, polygonSource, primitiveLock };
}

async function readExistingRegions(ctx?: ICommandContext): Promise<ReturnType<typeof getRegionListItem>[]> {
	await assertPcbTarget(ctx);
	const items = await (eda as any).pcb_PrimitiveRegion.getAll();
	if (!Array.isArray(items))
		throw new Error('当前禁止/约束区域列表读回不是数组');
	const result = items.map((item: Primitive) => getRegionListItem(item));
	await assertPcbTarget(ctx);
	return result;
}

function exactRegionMatch(region: Keepout, existing: ReturnType<typeof getRegionListItem>[]): ReturnType<typeof getRegionListItem> | undefined {
	return existing.find(item => item.layer === region.layer
		&& item.ruleType.length === 1 && item.ruleType[0] === 5
		&& comparePolygonSource(region.polygonSource, item.polygonSource).matches);
}

function decideMainRegion(net: string, pourPrimitiveId: string, rawRegions: any[], maxWidth: number): { bounds: Bounds; regionId: string; width: number; length: number; warning?: string } | { reason: string } {
	if (!Array.isArray(rawRegions) || rawRegions.length === 0)
		return { reason: '实填充没有闭合区域可识别' };
	const candidates = rawRegions.map((region: any) => ({
		region,
		area: region?.netContourAreaMil2,
		bounds: validateBounds(region),
	}));
	if (candidates.some(candidate => typeof candidate.area !== 'number' || !Number.isFinite(candidate.area) || candidate.area <= 0 || !candidate.bounds))
		return { reason: '实填区域面积或边界证据不完整' };
	const sorted = candidates.sort((a, b) => b.area - a.area);
	const largest = sorted[0];
	const significant = sorted.slice(1).filter(item => item.area >= largest.area * AREA_EPSILON_RATIO);
	if (significant.some(item => item.area >= largest.area * COMPARABLE_AREA_RATIO))
		return { reason: '存在面积接近的多个实填区域，无法确认要保护哪一条主铜路' };
	const selected = largest.region;
	if (!Array.isArray(selected.rings) || selected.rings.length !== 1 || selected.rings[0]?.closed !== true)
		return { reason: '最大实填区域有孔洞、多个边界或未闭合，当前不支持自动生成禁布区' };
	const ring = selected.rings[0];
	if (typeof ring.segmentCount !== 'number' || ring.segmentCount < 4)
		return { reason: '最大实填区域边界结构不完整' };
	const bounds = largest.bounds!;
	const dx = bounds.maxX - bounds.minX;
	const dy = bounds.maxY - bounds.minY;
	const width = Math.min(dx, dy);
	const length = Math.max(dx, dy);
	if (width > maxWidth)
		return { reason: `主实铜带宽 ${width.toFixed(2)} mil，超过指定上限 ${maxWidth} mil` };
	if (length < 2 * width)
		return { reason: `主实铜区长宽比不足 2:1（${length.toFixed(2)} × ${width.toFixed(2)} mil）` };
	const smallPieces = sorted.length - 1 - significant.length;
	const warnings: string[] = [];
	if (smallPieces > 0)
		warnings.push(`忽略了 ${smallPieces} 个面积小于主实填区域 10% 的孤立小片`);
	if ((ring.arcCount ?? 0) > 0)
		warnings.push('实填边界含圆弧（可能包含焊盘热焊/避让细节）；禁布区按其外接矩形保守生成');
	return {
		bounds,
		regionId: String(selected.id ?? `${net}/${pourPrimitiveId}/largest`),
		width,
		length,
		...(warnings.length ? { warning: warnings.join('；') } : {}),
	};
}

async function buildPlan(params: { nets: string[]; maxStripWidthMil: number; marginMil: number }, ctx?: ICommandContext): Promise<Plan> {
	const target = await assertPcbTarget(ctx);
	const { source, revision } = await currentSource(target, ctx);
	const document = parseSourceLog(source);
	const pours = effectiveRecordsByType(document, 'POUR').filter(record => params.nets.includes(String((record.data as any)?.netName ?? '')));
	const skipped: Plan['skipped'] = [];
	const regions: Keepout[] = [];
	const warnings: string[] = ['仅生成 ruleType 5 禁止导线区域；检查预览中现有线路与其他图元是否会被覆盖。不会自动重铺铜或布线。'];
	const pourById = new Map(pours.map(record => [String(record.header.id), record]));
	for (const net of params.nets) {
		const netPours = pours.filter(record => String((record.data as any)?.netName ?? '') === net);
		if (!netPours.length) {
			skipped.push({ net, reason: '当前 PCB 源码中没有该网络的覆铜记录' });
			continue;
		}
		for (const record of netPours) {
			const pourPrimitiveId = String(record.header.id);
			try {
				const report = await reviewCopperShape({ primitiveId: pourPrimitiveId }, ctx);
				if (report.pour?.net !== net || report.pour?.primitiveId !== pourPrimitiveId || report.pour?.matchedSource !== true)
					throw new Error('覆铜复核没有确认源网络及图元身份');
				const selected = decideMainRegion(net, pourPrimitiveId, report.regions, params.maxStripWidthMil);
				if ('reason' in selected) {
					skipped.push({ net, pourPrimitiveId, reason: selected.reason });
					continue;
				}
				const sourcePour = (record.data as any);
				const actualLayer = sourcePour.layerId;
				if (typeof actualLayer !== 'number' || actualLayer !== report.pour.layer)
					throw new Error('覆铜图层与源码读回不一致');
				regions.push({
					net,
					pourPrimitiveId,
					filledRegionId: selected.regionId,
					layer: actualLayer,
					polygonSource: bboxPath(selected.bounds, params.marginMil),
					widthMil: selected.width,
					lengthMil: selected.length,
					marginMil: params.marginMil,
					action: 'create',
					...(selected.warning ? { warning: selected.warning } : {}),
				});
				if (selected.warning)
					warnings.push(`${net}/${pourPrimitiveId}: ${selected.warning}`);
			}
			catch (error) {
				skipped.push({ net, pourPrimitiveId, reason: `覆铜证据无法确认：${error instanceof Error ? error.message : String(error)}` });
			}
		}
	}
	if (pourById.size !== pours.length)
		throw new Error('覆铜 ID 存在重复，拒绝创建禁布区计划');
	const existing = await readExistingRegions(ctx);
	for (const region of regions) {
		if (exactRegionMatch(region, existing))
			region.action = 'reuse';
	}
	const current = await currentSource(target, ctx);
	if (current.revision !== revision || !comparePcbSourceSnapshots(source, current.source).matches)
		throw new Error('预览期间 PCB 内容发生变化，请重新生成禁布区预览');
	await assertPcbTarget(ctx);
	return { target, pcbRevision: revision, regions, skipped, warnings };
}

async function planWithId(params: { nets: string[]; maxStripWidthMil: number; marginMil: number }, ctx?: ICommandContext): Promise<Plan & { planId: string }> {
	const plan = await buildPlan(params, ctx);
	const stableParams = { nets: params.nets, maxStripWidthMil: params.maxStripWidthMil, marginMil: params.marginMil };
	const planId = await pcbRevisionDigest({
		target: plan.target,
		pcbRevision: plan.pcbRevision,
		params: stableParams,
		regions: plan.regions,
		skipped: plan.skipped,
	});
	return { ...plan, planId };
}

export async function planCopperKeepouts(params: Record<string, any>, ctx?: ICommandContext) {
	const normalized = assertParams(params, false);
	const plan = await planWithId(normalized, ctx);
	return {
		planId: plan.planId,
		target: plan.target,
		pcbRevision: plan.pcbRevision,
		regions: plan.regions,
		skipped: plan.skipped,
		warnings: plan.warnings,
		readStatus: 'preview-only-no-write',
	};
}

function partialWriteError(error: unknown, details: Record<string, unknown>): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`铜路禁布区仅部分完成，已停止后续写入：${message}`, {
		cause: { partial: true, retryable: false, writeAttempted: true, ...details },
	});
}

export async function applyCopperKeepouts(params: Record<string, any>, ctx?: ICommandContext) {
	const normalized = assertParams(params, true);
	const target = await assertPcbTarget(ctx);
	const freshPlan = await planWithId(normalized, ctx);
	if (freshPlan.planId !== normalized.planId)
		throw new Error('PCB 或覆铜状态已变化，预览计划已过期；没有执行写入，请重新预览');
	const placeRegion = pcbPlacementPrimitiveCommands.find(command => command.name === 'pcb.placeRegion')?.handler;
	if (!placeRegion)
		throw new Error('现有 pcb.placeRegion 指令不可用，未执行写入');
	const created: Array<{ primitiveId: string; region: Keepout; readbackVerified: true }> = [];
	const reused: Array<{ primitiveId: string; region: Keepout }> = [];
	const initial = await currentSource(target, ctx);
	if (initial.revision !== freshPlan.pcbRevision)
		throw new Error('PCB 在计划复核后发生变化，预览计划已过期；没有执行写入，请重新预览');
	let expectedSource = initial.source;
	for (const region of freshPlan.regions) {
		await assertPcbTarget(ctx);
		const before = await currentSource(target, ctx);
		if (!comparePcbSourceSnapshots(expectedSource, before.source).matches)
			throw created.length || reused.length
				? partialWriteError(new Error('PCB 在分批写入期间被其他操作修改'), { created, reused, failedRegion: region, phase: 'before-next-write' })
				: new Error('PCB 内容在写入前发生变化，请重新预览；没有执行写入');
		const currentRegions = await readExistingRegions(ctx);
		const afterRegionRead = await currentSource(target, ctx);
		if (!comparePcbSourceSnapshots(before.source, afterRegionRead.source).matches)
			throw created.length
				? partialWriteError(new Error('PCB 在区域读回期间被其他操作修改'), { created, reused, failedRegion: region, phase: 'before-next-write' })
				: new Error('PCB 在区域读回期间发生变化；没有执行写入，请重新预览');
		const duplicate = exactRegionMatch(region, currentRegions);
		if (duplicate) {
			reused.push({ primitiveId: duplicate.primitiveId, region });
			expectedSource = afterRegionRead.source;
			continue;
		}
		try {
			const result = await placeRegion({
				layer: region.layer,
				polygonSource: region.polygonSource,
				ruleType: [5],
				primitiveLock: true,
			}, ctx);
			if (!result?.primitiveId || result.readbackVerified !== true || result.properties?.ruleType?.length !== 1 || result.properties.ruleType[0] !== 5
				|| result.properties.layer !== region.layer || result.properties.primitiveLock !== true
				|| !comparePolygonSource(region.polygonSource, result.properties.polygonSource).matches)
				throw new Error('区域写入回执未确认图层、轮廓、ruleType=5 和锁定状态');
			created.push({ primitiveId: result.primitiveId, region, readbackVerified: true });
			const after = await currentSource(target, ctx);
			const readbackRegion = (await readExistingRegions(ctx)).find(item => item.primitiveId === result.primitiveId);
			if (!readbackRegion || readbackRegion.layer !== region.layer || readbackRegion.ruleType.length !== 1 || readbackRegion.ruleType[0] !== 5
				|| readbackRegion.primitiveLock !== true || !comparePolygonSource(region.polygonSource, readbackRegion.polygonSource).matches)
				throw new Error('新建禁布区列表读回与计划不一致');
			expectedSource = after.source;
		}
		catch (error) {
			throw partialWriteError(error, { created, reused, failedRegion: region, phase: 'write-or-readback' });
		}
	}
	await assertPcbTarget(ctx);
	return {
		created,
		reused,
		skipped: freshPlan.skipped,
		warnings: freshPlan.warnings,
		readStatus: 'each-created-region-readback-verified',
		persistence: 'not-saved-or-reopened',
		scope: '只创建 ruleType=5 的禁止导线区域；未重铺铜、未自动布线、未保存或关闭工程',
	};
}

export const copperKeepoutCommands: ICommandDef[] = [
	{
		name: 'pcb.planCopperKeepouts',
		summary: '只读预览指定网络中可确认的窄 SOLID 实铜带，并提出带余量的禁止导线区域；不改板',
		params: [
			{ name: 'nets', type: 'string[]', required: true, description: '要识别保护的网络名称' },
			{ name: 'maxStripWidthMil', type: 'number', required: true, description: '最大窄铜带宽度，单位 mil；必须由调用方明确指定' },
			{ name: 'marginMil', type: 'number', description: '禁布区超出实铜带边界的外扩距离，单位 mil，默认 6' },
		],
		returns: '{ planId, pcbRevision, regions:[{net,pourPrimitiveId,layer,polygonSource,widthMil,lengthMil,action}], skipped:[{net,reason}], warnings }；仅预览，不写入',
		example: { cmd: 'pcb.planCopperKeepouts', params: { nets: ['3.3V', 'GND'], maxStripWidthMil: 105, marginMil: 6 } },
		handler: planCopperKeepouts,
	},
	{
		name: 'pcb.applyCopperKeepouts',
		summary: '重新核对同一 PCB 修订后，按预览创建 ruleType 5 禁止导线区域并逐个读回；不会自动重铺铜或布线',
		params: [
			{ name: 'nets', type: 'string[]', required: true, description: '必须与预览相同的网络名称数组' },
			{ name: 'maxStripWidthMil', type: 'number', required: true, description: '必须与预览相同，单位 mil' },
			{ name: 'marginMil', type: 'number', description: '必须与预览相同，单位 mil，默认 6' },
			{ name: 'planId', type: 'string', required: true, description: 'pcb.planCopperKeepouts 返回的计划 ID；PCB 修订变化时拒绝写入' },
		],
		returns: '{ created:[{primitiveId,region,readbackVerified}], reused:[{primitiveId,region}], skipped, warnings, readStatus, persistence }；中途失败返回结构化部分完成状态',
		example: { cmd: 'pcb.applyCopperKeepouts', params: { nets: ['3.3V'], maxStripWidthMil: 105, planId: '上一步返回的计划ID' } },
		handler: applyCopperKeepouts,
	},
];
