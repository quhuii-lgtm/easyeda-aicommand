import type { ICommandDef } from '../engine/types';
import { executeRouteTrack } from './pcb';
import { planDifferentialPair } from '../pcb/diffPairGeometry';
import { createGeometryHost } from '../pcb/geometryHost';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';
import { planSesImport, verifySesImport, type SesRouteLine } from '../engine/autoRouteSes';

function canonical(value: unknown): string {
	return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function layerId(value: unknown): number {
	if (value === undefined || value === 'top') return 1;
	if (value === 'bottom') return 2;
	if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
	if (typeof value !== 'number' || !Number.isInteger(value) || (value !== 1 && value !== 2 && !(value >= 15 && value <= 44))) throw new Error('layer 必须为 top、bottom 或有效信号铜层 ID');
	return value;
}

function sourceLine(record: ReturnType<typeof parseSourceLog>['records'][number], includeAttributes = true): SesRouteLine {
	const data = record.data as Record<string, any>;
	if (!data || typeof data !== 'object' || typeof data.netName !== 'string' || !Number.isInteger(data.layerId)
		|| ![data.startX, data.startY, data.endX, data.endY, data.width].every(value => typeof value === 'number' && Number.isFinite(value)) || data.width <= 0) throw new Error(`LINE ${record.header.id} 源码无法确认`);
	const attributes = { ...data };
	for (const field of ['startX', 'startY', 'endX', 'endY']) delete attributes[field];
	// Preserve unknown non-geometric attributes as part of the coverage grouping.
	if (Math.hypot(data.endX - data.startX, data.endY - data.startY) <= 0) throw new Error(`LINE ${record.header.id} 长度无效`);
	return { id: record.header.id, net: includeAttributes ? canonical(attributes) : data.netName, layer: data.layerId, widthMil: data.width,
		a: { x: data.startX, y: data.startY }, b: { x: data.endX, y: data.endY } };
}

function clipToPlanned(actual: SesRouteLine, a: number[], b: number[]): SesRouteLine | undefined {
	const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
	const projection = (point: { x: number; y: number }) => (point.x - a[0]) * ux + (point.y - a[1]) * uy;
	const normalDistance = (point: { x: number; y: number }) => Math.abs((point.x - a[0]) * uy - (point.y - a[1]) * ux);
	const tolerance = Math.min(0.001, length / 4);
	if (normalDistance(actual.a) > tolerance || normalDistance(actual.b) > tolerance) return undefined;
	const lo = Math.max(0, Math.min(projection(actual.a), projection(actual.b)));
	const hi = Math.min(length, Math.max(projection(actual.a), projection(actual.b)));
	if (!(hi > lo)) return undefined;
	return { ...actual, id: undefined, a: { x: a[0] + lo * ux, y: a[1] + lo * uy }, b: { x: a[0] + hi * ux, y: a[1] + hi * uy } };
}

function routeExpected(lines: SesRouteLine[]) {
	return { lines, vias: [], coordinateMapping: 'easyeda-pro-4.1.78-direct-xy' as const, toleranceMil: 0.001 as const,
		toleranceScope: 'current mil/1000 fixture' as const, holeDiameterStatus: 'not-specified-by-ses' as const };
}

function normalizeAttributeClips(lines: SesRouteLine[], check: () => void): SesRouteLine[] {
	const groups: Array<{ line: SesRouteLine; ux: number; uy: number; intervals: number[][] }> = [];
	for (const line of lines) {
		check();
		let matched: typeof groups[number] | undefined;
		for (const group of groups) {
			check();
			if (line.net !== group.line.net || line.layer !== group.line.layer || line.widthMil !== group.line.widthMil) continue;
			const scale = Math.max(1, Math.abs(line.a.x), Math.abs(line.a.y), Math.abs(line.b.x), Math.abs(line.b.y), Math.abs(group.line.a.x), Math.abs(group.line.a.y));
			const tolerance = Math.min(0.001, 32 * Number.EPSILON * scale);
			const normal = (point: { x: number; y: number }) => Math.abs((point.x - group.line.a.x) * group.uy - (point.y - group.line.a.y) * group.ux);
			if (normal(line.a) <= tolerance && normal(line.b) <= tolerance) { matched = group; break; }
		}
		if (!matched) {
			const length = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
			groups.push({ line, ux: (line.b.x - line.a.x) / length, uy: (line.b.y - line.a.y) / length, intervals: [[0, length]] });
			continue;
		}
		const project = (point: { x: number; y: number }) => (point.x - matched!.line.a.x) * matched!.ux + (point.y - matched!.line.a.y) * matched!.uy;
		const a = project(line.a), b = project(line.b);
		matched.intervals.push([Math.min(a, b), Math.max(a, b)]);
	}
	const result: SesRouteLine[] = [];
	for (const group of groups) {
		group.intervals.sort((a, b) => a[0] - b[0]);
		let current = group.intervals[0].slice();
		const emit = () => result.push({ ...group.line, id: undefined,
			a: { x: group.line.a.x + current[0] * group.ux, y: group.line.a.y + current[0] * group.uy },
			b: { x: group.line.a.x + current[1] * group.ux, y: group.line.a.y + current[1] * group.uy } });
		for (let i = 1; i < group.intervals.length; i++) {
			check();
			const next = group.intervals[i];
			if (next[0] <= current[1]) {
				if (Math.min(current[1], next[1]) - next[0] > 0.001) throw new Error('属性覆盖中发现超出读回容差的重复线段');
				current[1] = Math.max(current[1], next[1]);
			} else { emit(); current = next.slice(); }
		}
		emit();
	}
	return result;
}

async function routeDiffPair(params: Record<string, any>): Promise<unknown> {
	const started = performance.now();
	const budget = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs);
	if (!Number.isFinite(budget) || budget <= 0 || budget > 2_147_483_647) throw new Error('_timeoutMs 必须为有效正数');
	const deadline = started + Math.max(1000, budget);
	const pair = params.pair;
	if (!pair || typeof pair !== 'object' || Array.isArray(pair)
		|| typeof pair.positiveNet !== 'string' || !pair.positiveNet.trim()
		|| typeof pair.negativeNet !== 'string' || !pair.negativeNet.trim()
		|| pair.positiveNet === pair.negativeNet) throw new Error('pair 必须明确提供两个不同的非空 positiveNet / negativeNet');
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 必须为 boolean');
	const layer = layerId(params.layer);
	const host = await createGeometryHost(eda, params);
	let activeSide: 'positive' | 'negative' | undefined;
	const completed: Record<string, Awaited<ReturnType<typeof executeRouteTrack>>> = {};
	let pairWriteStarted = false;
	let phase = 'preflight';
	const check = () => { host.checkBudget(); if (performance.now() >= deadline) throw new Error('差分对共享时间预算已耗尽'); };
	try {
		check();
		const plan = planDifferentialPair({ path: params.path, width: params.width, gap: params.gap }, check);
		const nets = await host.read('核对正负网络', () => eda.pcb_Net.getAllNetsName());
		if (!Array.isArray(nets) || nets.some(net => typeof net !== 'string')) throw new Error('网络列表读取无效');
		for (const net of [pair.positiveNet, pair.negativeNet]) if (!nets.includes(net)) throw new Error(`差分网络 ${net} 不存在，未开始写入`);
		const layers = await host.read('核对差分走线目标层', () => eda.pcb_Layer.getAllLayers());
		if (!Array.isArray(layers)) throw new Error('图层列表读取无效');
		const targets = (layers as any[]).filter(item => (item.id ?? item.layerId) === layer);
		if (targets.length !== 1 || String(targets[0].type).toUpperCase() !== 'SIGNAL'
			|| ![1, 2].includes(targets[0].layerStatus ?? targets[0].status)
			|| (targets[0].layerStatus !== undefined && targets[0].status !== undefined && targets[0].layerStatus !== targets[0].status)) throw new Error('目标层不是已明确启用的 SIGNAL 铜层');
		const source = await host.read('读取成对布线前源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof source !== 'string') throw new Error('成对布线前源码读取无效');
		const before = parseSourceLog(source);
		if (before.uuid !== host.documentUuid || before.docType.toUpperCase() !== 'PCB') throw new Error('源码与目标 PCB 不符');
		const oldRows = resolveRecords(before);
		const beforeLineRows = [...oldRows.values()].filter(record => record.header.type === 'LINE');
		const beforeLines = beforeLineRows.map(record => sourceLine(record));
		const requestedLines: SesRouteLine[] = [];
		for (const side of ['positive', 'negative'] as const) {
			const points = side === 'positive' ? plan.positivePath : plan.negativePath;
			for (let i = 1; i < points.length; i++) {
				check();
				requestedLines.push({ net: side === 'positive' ? pair.positiveNet : pair.negativeNet, layer, widthMil: params.width,
					a: { x: points[i - 1][0], y: points[i - 1][1] }, b: { x: points[i][0], y: points[i][1] } });
			}
		}
		const geometryPlan = planSesImport(routeExpected(requestedLines), { documentUuid: host.documentUuid, lines: beforeLineRows.map(record => sourceLine(record, false)), vias: [] }, 'append');
		const rules = await host.read('读取成对布线前规则', () => eda.pcb_Drc.getCurrentRuleConfiguration());
		if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.keys(rules).length) throw new Error('设计规则读取无效');
		const base = { pair, layer, width: params.width, gap: params.gap, ...plan, documentUuid: host.documentUuid,
			spacingScope: '仅中心路径偏移生成的两侧几何；gap 是铜边间距。未检查全板其他铜、板框、禁布区或参考面。',
			boardClearanceVerified: false, connectivityVerified: false, impedanceVerified: false, equalLengthVerified: false, saved: false };
		const prewriteSource = await host.read('复核成对布线前源码', () => eda.sys_FileManager.getDocumentSource());
		if (!comparePcbSourceSnapshots(source, prewriteSource).matches) throw new Error('规划期间 PCB 变化，未开始写入');
		if (canonical(rules) !== canonical(await host.read('复核成对布线前规则', () => eda.pcb_Drc.getCurrentRuleConfiguration()))) throw new Error('规划期间规则变化，未开始写入');
		if (params.dryRun === true) { await host.finish(); return { ...base, dryRun: true, created: false }; }
		for (const side of ['positive', 'negative'] as const) {
			activeSide = side;
			phase = 'write';
			check();
			await host.read(`${side} 侧执行前核对目标`, () => undefined);
			// Reuse the strict single-net writer, including its focus, merge and partial-result checks.
			const result = await executeRouteTrack({ net: side === 'positive' ? pair.positiveNet : pair.negativeNet,
				points: side === 'positive' ? plan.positivePath : plan.negativePath, width: params.width, layer,
				_timeoutMs: budget }, { documentUuid: host.documentUuid, deadline });
			completed[side] = result;
			pairWriteStarted = true;
		}
		phase = 'final-verification';
		const afterSource = await host.read('读取成对布线后源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof afterSource !== 'string') throw new Error('成对布线后源码读取无效');
		const after = parseSourceLog(afterSource);
		if (after.uuid !== before.uuid || after.docType !== before.docType) throw new Error('成对布线后源码身份变化');
		const newIds = new Set(Object.values(completed).flatMap(result => result.segmentIds));
		const newRows = resolveRecords(after);
		for (const [key, record] of oldRows) {
			if (record.header.type === 'LINE') continue;
			const actual = newRows.get(key);
			if (!actual || canonical(record.data) !== canonical(actual.data)) throw new Error(`原有记录 ${key} 发生变化，须核对合并或外部修改`);
		}
		for (const [key, record] of newRows) {
			if (oldRows.has(key)) continue;
			if (record.header.type !== 'LINE' || !newIds.has(String(record.header.id))) throw new Error(`发现非预期新增记录 ${key}`);
			const data = record.data as Record<string, any>;
			if (![pair.positiveNet, pair.negativeNet].includes(data.netName) || data.layerId !== layer || typeof data.width !== 'number' || !Number.isFinite(data.width) || Math.abs(data.width - params.width) > 0.001) throw new Error(`新增线段 ${record.header.id} 源码属性不匹配`);
		}
		for (const id of newIds) if (!newRows.has(`LINE\0${id}`)) throw new Error(`已返回的线段 ${id} 未在最终源码中找到`);
		const afterLineRows = [...newRows.values()].filter(record => record.header.type === 'LINE');
		const afterLines = afterLineRows.map(record => sourceLine(record));
		const addedLines: SesRouteLine[] = [];
		for (const side of ['positive', 'negative'] as const) {
			const expectedNet = side === 'positive' ? pair.positiveNet : pair.negativeNet;
			const points = side === 'positive' ? plan.positivePath : plan.negativePath;
			for (let i = 1; i < points.length; i++) {
				check();
				for (const row of afterLineRows) {
					check();
					const data = row.data as Record<string, any>;
					if (data.netName !== expectedNet || data.layerId !== layer || Math.abs(data.width - params.width) > 0.001) continue;
					const clipped = clipToPlanned(sourceLine(row), points[i - 1], points[i]);
					if (clipped) addedLines.push(clipped);
				}
			}
		}
		const geometryCoverage = verifySesImport(geometryPlan, { documentUuid: host.documentUuid, lines: afterLineRows.map(record => sourceLine(record, false)), vias: [] });
		if (!geometryCoverage.verified) throw new Error(`最终走线源码几何不符：${JSON.stringify(geometryCoverage.differences)}`);
		const verificationPlan = planSesImport(routeExpected(normalizeAttributeClips(addedLines, check)),
			{ documentUuid: host.documentUuid, lines: beforeLines, vias: [] }, 'append');
		const sourceCoverage = verifySesImport(verificationPlan, { documentUuid: host.documentUuid, lines: afterLines, vias: [] });
		if (!sourceCoverage.verified) throw new Error(`最终走线源码覆盖不符：${JSON.stringify(sourceCoverage.differences)}`);
		const head = (document: typeof before) => document.records.filter(record => record.header.type === 'DOCHEAD').map(record => record.raw).join('\n');
		if (!comparePcbSourceSnapshots(head(before), head(after)).matches) throw new Error('DOCHEAD 身份或非挥发属性发生变化');
		if (canonical(rules) !== canonical(await host.read('核对成对布线后规则', () => eda.pcb_Drc.getCurrentRuleConfiguration()))) throw new Error('成对布线期间规则变化');
		await host.finish();
		return { ...base, dryRun: false, created: true, sides: completed, readbackVerified: true,
			originalNonLineRecordsPreserved: true, lineGeometryAndAttributesVerified: true, rulesStable: true, sourceCoverage,
			readbackToleranceMil: 0.001, actualLengths: '未计算整网实测长度；plannedLengths 为本次计划路径长度' };
	}
	catch (error) {
		const original = error instanceof Error ? error : new Error(String(error));
		const cause = (original as Error & { cause?: any }).cause;
		if (pairWriteStarted || cause?.partial) {
			throw new Error(`差分对执行未完成，已停止后续写入：${original.message}`, { cause: {
				partial: true, retryable: false, saved: false, phase, activeSide, completedSides: completed,
				failedSideEvidence: cause ?? null, operationError: original.message,
			} });
		}
		throw original;
	}
}

export const diffPairCommands: ICommandDef[] = [{
	name: 'pcb.routeDiffPair',
	summary: '按指定中心路径生成两侧差分走线，自动计算拐角偏移，串行创建并读回；不自动避障、调长、建差分规则或保存。可先 dryRun 只读预览；未知结果停止后续写入，不持续锁定',
	params: [
		{ name: 'pair', type: 'object', required: true, description: '{positiveNet,negativeNet}，两个已存在且不同的网络；正侧为前进方向数值法向[-dy,dx]，反向路径会交换空间两侧' },
		{ name: 'path', type: 'number[][]', required: true, description: '两线之间的中心路径，坐标mil；自动计算mitre拐点。生成线段沿用最短1mil要求；退化或铜间距不足写前报错' },
		{ name: 'width', type: 'number', required: true, description: '两线各自线宽，mil，必须明确提供' },
		{ name: 'gap', type: 'number', required: true, description: '两根线的铜边间隙，mil；不是中心线距离，不替代全板间距规则' },
		{ name: 'layer', type: 'string | number', description: 'top、bottom或数字铜层ID，默认top；必须为已启用SIGNAL层' },
		{ name: 'dryRun', type: 'boolean', description: 'true只读预览；默认false执行写入。拐弯两线可能不等长，不能据返回成功认定阻抗或DRC合格' },
	],
	returns: '{positivePath,negativePath,plannedLengths,minimumCopperGapMil,normalization,sides?,readbackVerified?,boardClearanceVerified:false,connectivityVerified:false,impedanceVerified:false,equalLengthVerified:false,saved:false}；失败可能partial，保留两侧已完成及失败侧候选证据，不自动重试/回滚',
	example: { cmd: 'pcb.routeDiffPair', params: { pair: { positiveNet: 'USB_DP', negativeNet: 'USB_DM' }, path: [[100, 100], [300, 100], [500, 300]], width: 6, gap: 4, dryRun: true } },
	handler: routeDiffPair,
}];
