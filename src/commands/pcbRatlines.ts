import type { ICommandContext, ICommandDef, TCommandHandler } from '../engine/types';

interface Point { x: number; y: number }
interface Ratline {
	primitiveId: string;
	net: string;
	start: Point;
	end: Point;
	startId: string;
	endId: string;
	length: number;
	locked: boolean;
}

interface RatlinePage {
	items: Ratline[];
	hasMore: boolean;
	nextCursor?: string;
	total?: number;
}

interface RatlineOptions { net?: string; cursor?: string; limit: number }

interface RatlineDocumentApi {
	getRatlines: (options?: RatlineOptions) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`getRatlines 返回的 ${label} 缺失或无效`);
	return value;
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`getRatlines 返回的 ${label} 不是有限数值`);
	return value;
}

function readPoint(value: unknown, label: string): Point {
	if (!isRecord(value))
		throw new Error(`getRatlines 返回的 ${label} 坐标无效`);
	return { x: finiteNumber(value.x, `${label}.x`), y: finiteNumber(value.y, `${label}.y`) };
}

function readRatline(value: unknown, index: number): Ratline {
	const label = `items[${index}]`;
	if (!isRecord(value))
		throw new Error(`getRatlines 返回的 ${label} 不是对象`);
	if (typeof value.locked !== 'boolean')
		throw new Error(`getRatlines 返回的 ${label}.locked 不是布尔值`);
	const length = finiteNumber(value.length, `${label}.length`);
	if (length < 0)
		throw new Error(`getRatlines 返回的 ${label}.length 不能为负数`);
	return {
		primitiveId: requiredString(value.primitiveId, `${label}.primitiveId`),
		net: requiredString(value.net, `${label}.net`),
		start: readPoint(value.start, `${label}.start`),
		end: readPoint(value.end, `${label}.end`),
		startId: requiredString(value.startId, `${label}.startId`),
		endId: requiredString(value.endId, `${label}.endId`),
		length,
		locked: value.locked,
	};
}

function readPage(value: unknown): RatlinePage {
	if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean')
		throw new Error('getRatlines 返回结构无效：需要 items 数组和 hasMore 布尔值');
	const items = value.items.map(readRatline);
	const nextCursor = value.nextCursor;
	if (nextCursor !== undefined && (typeof nextCursor !== 'string' || !nextCursor.trim()))
		throw new Error('getRatlines 返回的 nextCursor 无效');
	if (value.hasMore && nextCursor === undefined)
		throw new Error('getRatlines 表示还有下一页，但未返回 nextCursor');
	const total = value.total;
	if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0))
		throw new Error('getRatlines 返回的 total 必须是非负安全整数');
	return {
		items,
		hasMore: value.hasMore,
		...(nextCursor === undefined ? {} : { nextCursor }),
		...(total === undefined ? {} : { total }),
	};
}

function parseOptions(params: Record<string, any>): RatlineOptions {
	const allowed = new Set(['net', 'cursor', 'limit', '__docUuid', '__projectUuid', '__tabId', '__instanceId', 'instanceId', '_timeoutMs']);
	for (const key of Object.keys(params)) {
		if (!allowed.has(key) && !key.startsWith('__'))
			throw new Error(`pcb.listRatlines 不支持参数 ${key}`);
	}
	let net: string | undefined;
	if (params.net !== undefined) {
		if (typeof params.net !== 'string' || !params.net.trim())
			throw new Error('net 必须是非空网络名称');
		net = params.net.trim();
	}
	let cursor: string | undefined;
	if (params.cursor !== undefined) {
		if (typeof params.cursor !== 'string' || !params.cursor.trim())
			throw new Error('cursor 必须是非空字符串');
		cursor = params.cursor;
	}
	const limit = params.limit === undefined ? 200 : params.limit;
	if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0)
		throw new Error('limit 必须是正整数');
	return { ...(net === undefined ? {} : { net }), ...(cursor === undefined ? {} : { cursor }), limit };
}

async function listRatlines(params: Record<string, any>, ctx?: ICommandContext): Promise<RatlinePage & { document: ICommandContext['documentTarget'] }> {
	const options = parseOptions(params);
	const target = ctx?.documentTarget;
	if (target?.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('pcb.listRatlines 需要当前 PCB 文档身份校验');
	ctx.stopSignal?.assertActive();
	await ctx.assertDocumentTarget();
	const document = eda.pcb_Document as unknown as RatlineDocumentApi;
	let raw: unknown;
	try {
		raw = await document.getRatlines(options);
	}
	catch (error) {
		throw new Error(`读取 PCB 飞线失败：${error instanceof Error ? error.message : String(error)}`);
	}
	ctx.stopSignal?.assertActive();
	await ctx.assertDocumentTarget();
	return { ...readPage(raw), document: target };
}

async function protectedRatlines(nets: Set<string>, ctx: ICommandContext | undefined): Promise<Map<string, Ratline>> {
	const ratlines = new Map<string, Ratline>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let rows = 0;
	let total: number | undefined;
	do {
		const page = await listRatlines({ limit: 200, cursor }, ctx);
		rows += page.items.length;
		if (page.total !== undefined) {
			if (total !== undefined && total !== page.total)
				throw new Error('翻页期间飞线总数变化');
			total = page.total;
		}
		for (const item of page.items) {
			if (!nets.has(item.net))
				continue;
			const key = JSON.stringify([item.net, ...[item.startId, item.endId].sort()]);
			ratlines.set(key, item);
		}
		cursor = page.hasMore ? page.nextCursor : undefined;
		if (cursor) {
			if (seenCursors.has(cursor) || page.items.length === 0 || (total !== undefined && rows >= total))
				throw new Error('飞线分页未取得完整结果');
			seenCursors.add(cursor);
		}
	} while (cursor);
	if (total !== undefined && rows !== total)
		throw new Error('飞线条数与宿主总数不一致');
	return ratlines;
}

export function withCopperConnectivityProtection(rebuild: TCommandHandler): TCommandHandler {
	return async (params, ctx) => {
		if (params.protectNets === undefined)
			return rebuild(params, ctx);
		const names = params.protectNets;
		if (!Array.isArray(names) || names.length === 0
			|| names.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim()))
			throw new Error('protectNets 必须是非空的准确网络名数组，未重铺');
		const nets = new Set<string>(names);
		const before = await protectedRatlines(nets, ctx).catch(error => {
			throw new Error(`无法核对重铺前的飞线，未重铺：${error instanceof Error ? error.message : String(error)}`);
		});
		await ctx?.assertDocumentTarget?.();
		const allNets = await eda.pcb_Net.getAllNetsName();
		await ctx?.assertDocumentTarget?.();
		ctx?.stopSignal?.assertActive();
		if (!Array.isArray(allNets) || [...nets].some(name => !allNets.includes(name)))
			throw new Error('protectNets 包含当前 PCB 中未确认的网络，未重铺');
		const result = await rebuild(params, ctx);
		let after: Map<string, Ratline>;
		try {
			after = await protectedRatlines(nets, ctx);
		}
		catch (error) {
			throw new Error('已调用重铺，保护网的飞线读回未确认，停止后续保存或验收', {
				cause: { partial: true, retryable: false, phase: 'copper-connectivity-after', result, protectedNets: [...nets],
					readError: error instanceof Error ? error.message : String(error) },
			});
		}
		const addedRatlines = [...after].filter(([key]) => !before.has(key)).map(([, line]) => line);
		const connectivity = {
			status: addedRatlines.length ? 'new-ratlines' : 'no-new-ratlines',
			protectedNets: [...nets],
			beforeCount: before.size,
			afterCount: after.size,
			addedRatlines,
		};
		if (addedRatlines.length)
			throw new Error('重铺后保护网新增飞线，停止后续保存或验收', {
				cause: { partial: true, retryable: false, phase: 'copper-connectivity-after', result, connectivity },
			});
		return { ...result, connectivity };
	};
}

export const pcbRatlineCommands: ICommandDef[] = [{
	name: 'pcb.listRatlines',
	summary: '只读读取当前 PCB 飞线一页；默认最多读取 200 条，不自动翻页。飞线表示未完成连接提示，不等同于完整电气连通或 DRC 结论。',
	params: [
		{ name: 'net', type: 'string', description: '可选网络名筛选' },
		{ name: 'cursor', type: 'string', description: '续读上一页返回的 nextCursor' },
		{ name: 'limit', type: 'number', description: '本页条数上限，正整数，默认 200' },
	],
	returns: '{ document, items:[{primitiveId,net,start:{x,y},end:{x,y},startId,endId,length,locked}], hasMore, nextCursor?, total? }；只返回宿主当前页，不自动拉取后续页，不证明整网连通或 DRC 结果',
	example: { cmd: 'pcb.listRatlines', params: { limit: 200 } },
	handler: listRatlines,
}];
