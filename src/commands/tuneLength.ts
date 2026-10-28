import type { ICommandDef } from '../engine/types';
import type { ArcReadbackEvidence } from '../pcb/arcReadback';
import type { ArcLengthTunePlan, CurvePrimitive } from '../pcb/arcTuneGeometry';
import type { TuneLine, TuneRegion } from '../pcb/lengthTuneTargets';
import { assertArcReadback, inspectArcReadback } from '../pcb/arcReadback';
import { curveBounds, curveFromEndpoints, curveLength, planArcLengthTune, sampleCurves } from '../pcb/arcTuneGeometry';
import { writeTuneCurves } from '../pcb/curveTuneWriter';
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';
import { createGeometryHost } from '../pcb/geometryHost';
import { readTuneContacts } from '../pcb/lengthTuneContacts';
import { checkTuneAttachments, resolveTuneSelection } from '../pcb/lengthTuneTargets';
import { identifyOldBypassFragments, oldBypassFragmentSdkMatches } from '../pcb/oldBypassFragments';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';

function canonical(value: unknown): string {
	return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
		: item);
}
function docHeadSnapshot(source: string): string {
	const doc = parseSourceLog(source);
	const record = doc.records.find(item => item.header.type === 'DOCHEAD');
	if (!record)
		throw new Error('源码缺少DOCHEAD');
	return record.raw;
}
function sourceLines(source: string, uuid: string) {
	const doc = parseSourceLog(source);
	if (doc.uuid !== uuid || doc.docType.toUpperCase() !== 'PCB')
		throw new Error('补长源码与目标 PCB 不符');
	const records = resolveRecords(doc);
	const lines: TuneLine[] = [];
	for (const record of records.values()) {
		if (record.header.type !== 'LINE')
			continue;
		const d = record.data as Record<string, any>;
		if (!d || typeof d.netName !== 'string' || !Number.isInteger(d.layerId)
			|| ![d.startX, d.startY, d.endX, d.endY, d.width].every(v => typeof v === 'number' && Number.isFinite(v)) || d.width <= 0) {
			throw new Error(`LINE ${record.header.id} 源码属性不完整，停止补长`);
		}
		lines.push({ id: String(record.header.id), net: d.netName, layer: d.layerId, width: d.width, a: [d.startX, d.startY], b: [d.endX, d.endY], locked: d.locked === true });
	}
	return { doc, records, lines };
}
function sourceCurve(record: { header: { type: string; id?: string }; data: unknown }): CurvePrimitive {
	const data = record.data as Record<string, any>;
	if (record.header.type === 'LINE') {
		if (!data || ![data.startX, data.startY, data.endX, data.endY].every(v => typeof v === 'number' && Number.isFinite(v)))
			throw new Error(`LINE ${record.header.id} 源码端点不完整`);
		return { type: 'line', a: [data.startX, data.startY], b: [data.endX, data.endY] };
	}
	if (record.header.type !== 'ARC')
		throw new Error(`图元 ${record.header.id} 不是LINE或ARC`);
	if (!data || typeof data.netName !== 'string' || !Number.isInteger(data.layerId)
		|| data.arcType !== 'DOT'
		|| ![data.startX, data.startY, data.endX, data.endY, data.width, data.angle].every(v => typeof v === 'number' && Number.isFinite(v)) || data.width <= 0) {
		throw new Error(`ARC ${record.header.id} 源码属性不完整，停止补长`);
	}
	return curveFromEndpoints([data.startX, data.startY], [data.endX, data.endY], data.angle);
}
function sourcePrimitive(record: { header: { type: string; id?: string }; data: unknown }) {
	const data = record.data as Record<string, any>;
	if (!data || typeof data.netName !== 'string' || !Number.isInteger(data.layerId)
		|| typeof data.width !== 'number' || !Number.isFinite(data.width) || data.width <= 0) {
		throw new Error(`${record.header.type} ${record.header.id} 源码的net/layer/width不完整`);
	}
	return { id: String(record.header.id), type: record.header.type.toLowerCase() as 'line' | 'arc', net: data.netName, layer: data.layerId, width: data.width, curve: sourceCurve(record) };
}
function samePoint(a: number[], b: number[], tolerance = 0.001): boolean {
	return a.length === 2 && b.length === 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
}
function sameCurve(actual: CurvePrimitive, expected: CurvePrimitive): boolean {
	if (actual.type !== expected.type)
		return false;
	const direct = samePoint(actual.a, expected.a) && samePoint(actual.b, expected.b);
	const reverse = samePoint(actual.a, expected.b) && samePoint(actual.b, expected.a);
	if (actual.type === 'line' && expected.type === 'line')
		return direct || reverse;
	if (actual.type !== 'arc' || expected.type !== 'arc')
		return false;
	const sweepMatches = direct ? Math.abs(actual.sweepDegrees - expected.sweepDegrees) <= 1e-8 : reverse && Math.abs(actual.sweepDegrees + expected.sweepDegrees) <= 1e-8;
	return sweepMatches && samePoint(actual.center, expected.center) && Math.abs(actual.radius - expected.radius) <= 0.001;
}
function orientCurveAlongPlan(actual: CurvePrimitive, planned: CurvePrimitive): CurvePrimitive {
	if (actual.type !== planned.type)
		throw new Error('实际图元类型与规划不符');
	if (samePoint(actual.a, planned.a))
		return actual;
	if (!samePoint(actual.a, planned.b) || !samePoint(actual.b, planned.a))
		throw new Error('实际图元端点与规划不等价');
	if (actual.type === 'line')
		return { type: 'line', a: actual.b, b: actual.a };
	return curveFromEndpoints(actual.b, actual.a, -actual.sweepDegrees);
}
function curveInsideRegion(curve: CurvePrimitive, region: TuneRegion, halfWidth: number, tolerance = 0.001): boolean {
	const bounds = curveBounds(curve);
	return bounds.xMin >= region.xMin + halfWidth - tolerance && bounds.xMax <= region.xMax - halfWidth + tolerance
		&& bounds.yMin >= region.yMin + halfWidth - tolerance && bounds.yMax <= region.yMax - halfWidth + tolerance;
}
function publicPlan(plan: ArcLengthTunePlan, width: number, bendRadius: number) {
	return {
		changed: plan.changed,
		originalSelectedLength: plan.originalSelectedLength,
		originalLocalLength: plan.originalLocalLength,
		plannedSelectedLength: plan.plannedSelectedLength,
		plannedLocalLength: plan.plannedLocalLength,
		plannedAddedLength: plan.plannedAddedLength,
		primitives: plan.localPrimitives,
		selectedSide: plan.selectedSide,
		unitCount: plan.unitCount,
		plannedFamilySelfGapLowerBoundMil: plan.changed ? 2 * bendRadius - width : 'not-applicable',
		samplePointCount: plan.samples.points.length,
		curveSagittaMil: plan.samples.maxSagittaMil,
		precisionExplanation: plan.precisionExplanation,
	};
}
async function tuneLength(params: Record<string, any>): Promise<unknown> {
	if (!params || typeof params.net !== 'string' || !params.net.trim())
		throw new Error('net 必须是非空字符串');
	if (params.minSelfGap === undefined)
		throw new Error('缺少必需参数 minSelfGap；当前SDK尚无已核实适用于局部蛇形的项目规则映射，请明确填写');
	if (params.lengthTolerance === undefined)
		throw new Error('缺少必需参数 lengthTolerance；必须显式给出总长容差');
	if (params.bendRadius === undefined)
		throw new Error('缺少必需参数 bendRadius；当前SDK无已核实的项目最小弯曲半径映射，请明确填写');
	if (typeof params.bendRadius !== 'number' || !Number.isFinite(params.bendRadius) || params.bendRadius <= 0)
		throw new Error('bendRadius 必须为正的有限数值，单位mil');
	if (!params.region || typeof params.region !== 'object')
		throw new Error('region 是必需参数');
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
		throw new Error('dryRun 必须是 boolean');
	const budget = Number(params._timeoutMs ?? 290_000);
	if (!Number.isFinite(budget) || budget <= 0 || budget > 2_147_483_647)
		throw new Error('_timeoutMs 必须为有效正数且不超过 2147483647ms');
	const parameterSources = { bendRadius: 'explicit-no-confirmed-project-rule-fallback', minSelfGap: 'explicit', lengthTolerance: 'explicit', projectRuleMapping: 'not-confirmed-applicable-in-current-sdk', reason: '当前SDK没有已核实的项目最小弯曲半径、网络相对长度、差分长度容差或适用于局部蛇形的不同网络SAFE间距映射' };
	const host = await createGeometryHost(eda, params);
	let phase = 'preflight';
	let createdIds: string[] = [];
	let createdPrimitives: Array<{ type: 'line' | 'arc'; id: string }> = [];
	let actualPrimitives: CurvePrimitive[] = [];
	let deletedIds: string[] = [];
	const attemptedDeletedIds: string[] = [];
	let writerStarted = false;
	let oldBypassState: boolean | 'unknown' = 'unknown';
	let originalTargetId: string | undefined;
	let oldBypassFragmentIds: string[] = [];
	let nativeReplacedOriginalIds: string[] = [];
	const finalArcReadback: ArcReadbackEvidence[] = [];
	try {
		host.checkBudget();
		const baseline = await host.getBaseline();
		const source = await host.read('读取补长前完整源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof source !== 'string')
			throw new Error('补长前源码读取无效');
		const before = sourceLines(source, host.documentUuid);
		const selection = resolveTuneSelection({ net: params.net, lines: before.lines, ...(params.primitiveIds === undefined ? {} : { primitiveIds: params.primitiveIds }), ...(params.tunePrimitiveId === undefined ? {} : { tunePrimitiveId: params.tunePrimitiveId }), region: params.region });
		for (const id of selection.orderedIds) {
			await host.read(`核对旧线 ${id} 锁定状态`, async () => {
				const line = await eda.pcb_PrimitiveLine.get(id);
				const getLock = line?.getState_PrimitiveLock;
				if (typeof getLock !== 'function')
					throw new Error(`旧线 ${id} 无法读取锁定状态`);
				const locked = getLock.call(line);
				if (typeof locked !== 'boolean')
					throw new Error(`旧线 ${id} 锁定状态不是boolean`);
				if (locked)
					throw new Error(`旧线 ${id} 已锁定`);
			});
		}
		const layerId = before.lines.find(line => line.id === selection.orderedIds[0])?.layer;
		const layers = await host.read('核对补长目标层', () => eda.pcb_Layer.getAllLayers()) as any[];
		const targetLayers = Array.isArray(layers) ? layers.filter(layer => (layer.id ?? layer.layerId) === layerId) : [];
		if (targetLayers.length !== 1 || String(targetLayers[0].type).toUpperCase() !== 'SIGNAL'
			|| ![1, 2].includes(targetLayers[0].layerStatus ?? targetLayers[0].status)
			|| (targetLayers[0].layerStatus !== undefined && targetLayers[0].status !== undefined && targetLayers[0].layerStatus !== targetLayers[0].status)) {
			throw new Error('补长目标层不是明确启用的SIGNAL铜层');
		}
		const candidates = selection.tuneSegmentIndices;
		const sides = params.side === undefined || params.side === 'auto' ? ['left', 'right'] : [params.side];
		let targetIndex = -1;
		let first: TuneLine | undefined;
		let plan: ArcLengthTunePlan | undefined;
		let attachments: ReturnType<typeof checkTuneAttachments> | undefined;
		const rejected: string[] = [];
		let contacts: Awaited<ReturnType<typeof readTuneContacts>> | undefined;
		for (const candidateIndex of candidates) {
			const candidate = before.lines.find(line => line.id === selection.orderedIds[candidateIndex]);
			if (!candidate) {
				rejected.push(`候选段 ${candidateIndex} 未找到`);
				continue;
			}
			for (const side of sides) {
				host.checkBudget();
				try {
					const candidatePlan = planArcLengthTune({ path: selection.path, tuneSegmentIndex: candidateIndex, targetLength: params.targetLength, region: params.region, side, width: candidate.width, minSelfGap: params.minSelfGap, lengthTolerance: params.lengthTolerance, bendRadius: params.bendRadius }, host.checkBudget);
					if (!candidatePlan.changed) {
						targetIndex = candidateIndex;
						first = candidate;
						plan = candidatePlan;
						break;
					}
					contacts ??= await readTuneContacts(host, candidate.layer as number);
					const localSamples = sampleCurves(candidatePlan.localPrimitives, candidatePlan.samples.maxSagittaMil, host.checkBudget);
					const candidateAttachments = checkTuneAttachments({ targetLine: candidate, remainingLines: before.lines.filter(line => line.id !== candidate.id), newLocalPath: localSamples.points, newEdgePrimitiveIndices: localSamples.edgePrimitiveIndices, curveSagittaMil: localSamples.maxSagittaMil, contacts, checkBudget: host.checkBudget });
					if (candidateAttachments.interiorConnections.length || candidateAttachments.bypassRisks.length || candidateAttachments.uncertainContacts.length || candidateAttachments.coverage.unresolved) {
						rejected.push(`段 ${candidateIndex}/${side}: ${JSON.stringify(candidateAttachments)}`);
						continue;
					}
					targetIndex = candidateIndex;
					first = candidate;
					plan = candidatePlan;
					attachments = candidateAttachments;
					break;
				}
				catch (error) { rejected.push(`段 ${candidateIndex}/${side}: ${error instanceof Error ? error.message : String(error)}`); }
			}
			if (plan)
				break;
		}
		if (!first || !plan || (plan.changed && !attachments))
			throw new Error(`所有调节候选均不可行：${rejected.join('；')}`);
		const targetId = selection.orderedIds[targetIndex];
		originalTargetId = targetId;
		await host.assertBaseline(baseline);
		const sourceBeforeWrite = await host.read('写入前复核补长源码', () => eda.sys_FileManager.getDocumentSource());
		if (!comparePcbSourceSnapshots(source, sourceBeforeWrite).matches)
			throw new Error('补长规划期间源码变化，未开始写入');
		if (params.dryRun === true) {
			await host.finish();
			return { changed: false, dryRun: true, originalSelectedLength: plan.originalSelectedLength, plannedSelectedLength: plan.plannedSelectedLength, actualSelectedLength: plan.originalSelectedLength, oldBypassState: 'unknown', plan: publicPlan(plan, first.width, params.bendRadius), attachmentCheck: attachments ?? 'not-required-no-write', parameterSources, selectionReason: selection.selectionReason, saved: false };
		}
		if (!plan.changed) {
			await host.finish();
			return { changed: false, dryRun: false, originalSelectedLength: plan.originalSelectedLength, plannedSelectedLength: plan.plannedSelectedLength, actualSelectedLength: plan.originalSelectedLength, oldBypassState: 'unknown', plan: publicPlan(plan, first.width, params.bendRadius), parameterSources, selectionReason: selection.selectionReason, saved: false };
		}
		phase = 'create';
		writerStarted = true;
		const result = await writeTuneCurves(host, { net: first.net, layer: first.layer as number, width: first.width, primitives: plan.localPrimitives });
		createdPrimitives = result.createdPrimitives;
		actualPrimitives = result.actualPrimitives;
		createdIds = createdPrimitives.map(item => item.id);
		phase = 'verify-created';
		if (!createdIds.length || createdIds.length !== plan.localPrimitives.length)
			throw new Error('创建曲线返回ID数量不符；保留旧线并报告partial');
		const afterCreateSource = await host.read('读取新路径源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof afterCreateSource !== 'string')
			throw new Error('新路径源码读回无效');
		const afterCreate = sourceLines(afterCreateSource, host.documentUuid);
		const afterCreateRecords = afterCreate.records;
		if (afterCreate.doc.uuid !== before.doc.uuid || afterCreate.doc.docType.toUpperCase() !== 'PCB')
			throw new Error('创建后源码身份核对失败');
		const originalTargetRecord = before.records.get(`LINE\0${targetId}`);
		if (!originalTargetRecord)
			throw new Error(`写入前源码缺少原target ${targetId}`);
		const writerKeys = new Set(createdPrimitives.map(item => `${item.type.toUpperCase()}\0${item.id}`));
		const nativeSplit = identifyOldBypassFragments({ targetId, target: originalTargetRecord, beforeRecords: before.records, afterRecords: afterCreateRecords, writerKeys, planned: plan.localPrimitives });
		oldBypassFragmentIds = nativeSplit.fragmentIds;
		nativeReplacedOriginalIds = nativeSplit.split ? [targetId] : [];
		for (const [key, old] of before.records) {
			if (nativeSplit.split && key === `LINE\0${targetId}`)
				continue;
			const now = afterCreate.records.get(key);
			if (!now || canonical(old.data) !== canonical(now.data))
				throw new Error(`创建后既有记录 ${key} 变化；保留旧线`);
		}
		const newKeys = [...afterCreate.records.keys()].filter(key => !before.records.has(key));
		const expectedNewKeys = [...createdPrimitives.map(item => `${item.type.toUpperCase()}\0${item.id}`), ...oldBypassFragmentIds.map(id => `LINE\0${id}`)];
		if (newKeys.length !== expectedNewKeys.length || newKeys.some(key => !expectedNewKeys.includes(key)))
			throw new Error('创建后新增源码记录类型或ID与 writer / 原target分片不符；保留旧线');
		if (!nativeSplit.split)
			oldBypassState = true;
		const sourceActual: CurvePrimitive[] = [];
		for (let i = 0; i < createdPrimitives.length; i++) {
			const created = createdPrimitives[i];
			const row = afterCreate.records.get(`${created.type.toUpperCase()}\0${created.id}`);
			if (!row)
				throw new Error(`创建${created.type} ${created.id} 未在源码中找到；保留旧线`);
			const actual = sourcePrimitive(row);
			const expected = plan.localPrimitives[i];
			if (actual.type !== created.type || actual.net !== first.net || actual.layer !== first.layer || Math.abs(actual.width - first.width) > 0.001 || !sameCurve(actual.curve, expected))
				throw new Error(`新${created.type} ${created.id} 的源码属性或几何与规划不符（type=${actual.type}, net=${actual.net}, layer=${actual.layer}, width=${actual.width}, curveMatch=${sameCurve(actual.curve, expected)}, actual=${JSON.stringify(actual.curve)}, expected=${JSON.stringify(expected)}）；保留旧线`);
			sourceActual.push(orientCurveAlongPlan(actual.curve, expected));
			host.recordVerified(created.id);
		}
		if (sourceActual.length !== actualPrimitives.length || sourceActual.some((item, i) => !sameCurve(item, actualPrimitives[i])))
			throw new Error('独立源码读回曲线与 SDK writer 实测不一致；保留旧线');
		const sourceArcRadii = sourceActual.filter((curve): curve is Extract<CurvePrimitive, { type: 'arc' }> => curve.type === 'arc').map(curve => curve.radius);
		const sourceFamilySelfGapLowerBoundMil = Math.min(...sourceArcRadii) * 2 - first.width;
		const plannedFamilySelfGapLowerBoundMil = 2 * params.bendRadius - first.width;
		if (sourceFamilySelfGapLowerBoundMil + 0.001 < params.minSelfGap)
			throw new Error(`源码读回圆弧族间距下界 ${sourceFamilySelfGapLowerBoundMil} mil 小于 minSelfGap ${params.minSelfGap} mil；保留旧线`);
		if (sourceActual.some(curve => !curveInsideRegion(curve, params.region, first!.width / 2)))
			throw new Error('源码读回曲线的完整LINE/ARC边界超出指定region；保留旧线');
		let actualMaxJoinDeviationMil = 0;
		for (let i = 1; i < sourceActual.length; i++) {
			const deviation = Math.hypot(sourceActual[i - 1].b[0] - sourceActual[i].a[0], sourceActual[i - 1].b[1] - sourceActual[i].a[1]);
			actualMaxJoinDeviationMil = Math.max(actualMaxJoinDeviationMil, deviation);
		}
		if (actualMaxJoinDeviationMil > 0.001)
			throw new Error(`源码读回相邻曲线接点最大偏差 ${actualMaxJoinDeviationMil} mil 超出0.001mil门限；保留旧线`);
		const sourceSelectedLength = plan.originalSelectedLength - plan.originalLocalLength
			+ sourceActual.reduce((sum, curve) => sum + curveLength(curve), 0);
		if (!Number.isFinite(sourceSelectedLength) || Math.abs(sourceSelectedLength - params.targetLength) > params.lengthTolerance)
			throw new Error(`源码读回总长超出 lengthTolerance（实际 ${sourceSelectedLength} mil，目标 ${params.targetLength} mil，容差 ${params.lengthTolerance} mil）；保留旧线`);
		const actualSamples = sampleCurves(sourceActual, plan.samples.maxSagittaMil, host.checkBudget);
		const actualAttachments = checkTuneAttachments({ targetLine: first, remainingLines: before.lines.filter(line => line.id !== first!.id), newLocalPath: actualSamples.points, newEdgePrimitiveIndices: actualSamples.edgePrimitiveIndices, curveSagittaMil: actualSamples.maxSagittaMil, contacts: contacts ?? [], checkBudget: host.checkBudget });
		if (actualAttachments.interiorConnections.length || actualAttachments.bypassRisks.length || actualAttachments.uncertainContacts.length || actualAttachments.coverage.unresolved)
			throw new Error('新曲线实际读回后的接触检查未通过；保留旧线');
		for (const id of oldBypassFragmentIds) {
			const record = afterCreateRecords.get(`LINE\0${id}`);
			const data = record?.data as Record<string, any> | undefined;
			if (!record || !data)
				throw new Error(`原target分片 ${id} 源码缺失；保留旁路线段`);
			const sdk = await host.read(`fresh getter 核对原target分片 ${id}`, () => eda.pcb_PrimitiveLine.get(id)) as any;
			if (!sdk)
				throw new Error(`原target分片 ${id} fresh getter 未返回对象；保留旁路线段`);
			const read = (name: string) => {
				const getter = sdk[`getState_${name}`];
				if (typeof getter !== 'function')
					throw new Error(`原target分片 ${id} 缺少SDK ${name}`);
				return getter.call(sdk);
			};
			const sdkState = { id: read('PrimitiveId'), type: read('PrimitiveType'), net: read('Net'), layer: read('Layer'), width: read('LineWidth'), start: [read('StartX'), read('StartY')] as [number, number], end: [read('EndX'), read('EndY')] as [number, number] };
			const sourceState = { id, net: data.netName, layer: data.layerId, width: data.width, start: [data.startX, data.startY] as [number, number], end: [data.endX, data.endY] as [number, number] };
			if (!oldBypassFragmentSdkMatches(sourceState, sdkState)) {
				throw new Error(`原target分片 ${id} fresh SDK身份或属性与源码不符；保留旁路线段`);
			}
		}
		oldBypassState = true;
		phase = 'delete-old';
		host.checkBudget();
		oldBypassState = 'unknown';
		const idsToDelete = nativeSplit.split ? oldBypassFragmentIds : [targetId];
		if (nativeSplit.split && (!oldBypassFragmentIds.length || oldBypassFragmentIds.length !== nativeSplit.expectedEndpoints.length))
			throw new Error('原target分片身份未完整确认，停止删除');
		const deleteAccepted = await host.write(`删除已替换旧线/旁路分片 ${idsToDelete.join(', ')}`, () => {
			attemptedDeletedIds.push(...idsToDelete);
			return eda.pcb_PrimitiveLine.delete(idsToDelete);
		});
		if (deleteAccepted !== true)
			throw new Error('SDK未明确接受旧线/旁路分片删除；停止后续写入并报告partial');
		phase = 'verify-final';
		const finalSource = await host.read('读取删除旧线后的源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof finalSource !== 'string')
			throw new Error('最终源码读回无效');
		const final = sourceLines(finalSource, host.documentUuid);
		const docHeadCheck = comparePcbSourceSnapshots(docHeadSnapshot(source), docHeadSnapshot(finalSource));
		if (!docHeadCheck.matches)
			throw new Error(`最终DOCHEAD变化：${docHeadCheck.reason}`);
		if (!nativeSplit.split && final.records.has(`LINE\0${targetId}`))
			throw new Error(`旧线 ${targetId} 删除后仍存在`);
		for (const [key, old] of before.records) {
			if (key === `LINE\0${targetId}`)
				continue;
			const now = final.records.get(key);
			if (!now || canonical(old.data) !== canonical(now.data))
				throw new Error(`最终读回时非目标记录 ${key} 发生变化`);
		}
		for (const created of createdPrimitives) {
			const key = `${created.type.toUpperCase()}\0${created.id}`;
			const afterCreate = afterCreateRecords.get(key);
			const afterDelete = final.records.get(key);
			if (!afterCreate || !afterDelete || canonical(afterCreate.data) !== canonical(afterDelete.data))
				throw new Error(`删除旧线后新${created.type} ${created.id} 的完整源码属性发生变化`);
		}
		const expectedFinalKeys = new Set([...before.records.keys()].filter(key => key !== `LINE\0${targetId}`));
		for (const created of createdPrimitives) expectedFinalKeys.add(`${created.type.toUpperCase()}\0${created.id}`);
		if (final.records.size !== expectedFinalKeys.size || [...final.records.keys()].some(key => !expectedFinalKeys.has(key)))
			throw new Error('最终源码包含非预期新增或缺失记录');
		const sdkByTypedId = new Map<string, any>();
		const sdkEnumerations: any[][] = [];
		sdkEnumerations.push(await host.read('核对最终SDK线段枚举', () => eda.pcb_PrimitiveLine.getAll()) as any[]);
		sdkEnumerations.push(await host.read('核对最终SDK圆弧枚举', () => eda.pcb_PrimitiveArc.getAll()) as any[]);
		for (const [kindIndex, objects] of sdkEnumerations.entries()) {
			if (!Array.isArray(objects))
				throw new Error(`最终SDK${kindIndex === 0 ? 'LINE' : 'ARC'}枚举无效`);
			for (const object of objects) {
				const get = (name: string) => {
					const getter = object?.[`getState_${name}`];
					if (typeof getter !== 'function')
						throw new Error(`最终SDK${kindIndex === 0 ? 'LINE' : 'ARC'}缺少${name}状态`);
					return getter.call(object);
				};
				const id = get('PrimitiveId');
				if (typeof id !== 'string' || !id)
					throw new Error('最终SDK图元ID无效');
				sdkByTypedId.set(`${kindIndex === 0 ? 'LINE' : 'ARC'}\0${id}`, object);
			}
		}
		const stillInSource = idsToDelete.filter(id => final.records.has(`LINE\0${id}`));
		const stillInSdk = idsToDelete.filter(id => sdkByTypedId.has(`LINE\0${id}`));
		deletedIds = idsToDelete.filter(id => !stillInSource.includes(id) && !stillInSdk.includes(id));
		const originalTargetStillInSdk = sdkByTypedId.has(`LINE\0${targetId}`);
		if (final.records.has(`LINE\0${targetId}`) || originalTargetStillInSdk || stillInSource.length || stillInSdk.length) {
			oldBypassState = 'unknown';
			throw new Error(`最终SDK枚举或源码仍包含旧target/旁路分片（originalTargetSDK=${originalTargetStillInSdk}, source=${stillInSource.join(',')}, sdk=${stillInSdk.join(',')}`);
		}
		oldBypassState = false;
		for (let i = 0; i < createdPrimitives.length; i++) {
			const created = createdPrimitives[i];
			const object = sdkByTypedId.get(`${created.type.toUpperCase()}\0${created.id}`);
			if (!object)
				throw new Error(`新${created.type} ${created.id} 未出现在最终SDK枚举中`);
			if (created.type === 'arc') {
				const record = final.records.get(`ARC\0${created.id}`);
				if (!record)
					throw new Error(`最终源码缺少新ARC ${created.id}`);
				const evidence = inspectArcReadback(object, record, { id: created.id, net: first.net, layer: first.layer as number, width: first.width as number, curve: plan.localPrimitives[i] as Extract<CurvePrimitive, { type: 'arc' }> }, 'final-sdk');
				assertArcReadback(evidence);
				finalArcReadback.push(evidence);
				continue;
			}
			const get = (name: string) => object[`getState_${name}`]();
			const start: [number, number] = [get('StartX'), get('StartY')];
			const end: [number, number] = [get('EndX'), get('EndY')];
			const sdkWidth = get('LineWidth');
			if (typeof sdkWidth !== 'number' || !Number.isFinite(sdkWidth))
				throw new Error(`新${created.type} ${created.id} 的最终SDK线宽无效`);
			if (get('PrimitiveType') !== (created.type === 'line' ? 'Line' : 'Arc'))
				throw new Error(`新${created.type} ${created.id} 的最终SDK类型不符`);
			const curve = created.type === 'line' ? { type: 'line', a: start, b: end } as CurvePrimitive : curveFromEndpoints(start, end, get('ArcAngle'));
			if (get('Net') !== first.net || get('Layer') !== first.layer || Math.abs(sdkWidth - first.width) > 0.001 || !sameCurve(curve, plan.localPrimitives[i]))
				throw new Error(`新${created.type} ${created.id} 的最终SDK状态与规划不一致`);
		}
		const finalPrimitives = createdPrimitives.map((created, index) => {
			const record = final.records.get(`${created.type.toUpperCase()}\0${created.id}`);
			if (!record)
				throw new Error(`最终源码缺少新${created.type} ${created.id}`);
			const primitive = sourcePrimitive(record);
			if (primitive.net !== first.net || primitive.layer !== first.layer || Math.abs(primitive.width - first.width) > 0.001)
				throw new Error(`最终新${created.type} ${created.id} 的网络/图层/线宽不符`);
			if (!sameCurve(primitive.curve, plan.localPrimitives[index]))
				throw new Error(`最终新${created.type} ${created.id} 的几何与规划不符`);
			return orientCurveAlongPlan(primitive.curve, plan.localPrimitives[index]);
		});
		const actualPath: CurvePrimitive[] = [];
		for (const id of selection.orderedIds) {
			if (id === targetId) {
				actualPath.push(...finalPrimitives);
				continue;
			}
			const line = final.lines.find(item => item.id === id);
			if (!line)
				throw new Error(`最终所选链缺少LINE ${id}`);
			actualPath.push({ type: 'line', a: line.a, b: line.b });
		}
		const actualLength = actualPath.reduce((sum, primitive) => sum + curveLength(primitive), 0);
		if (Math.abs(actualLength - params.targetLength) > params.lengthTolerance)
			throw new Error(`最终实际链长 ${actualLength} 与目标偏差超出 lengthTolerance`);
		if (sourceActual.some((curve, i) => !sameCurve(curve, finalPrimitives[i])))
			throw new Error('最终源码新曲线与删除前独立读回不一致');
		const finalRules = await host.read('复核补长后规则', () => eda.pcb_Drc.getCurrentRuleConfiguration());
		if (canonical(finalRules) !== canonical(baseline.rules))
			throw new Error('补长期间 PCB 规则发生变化');
		await host.finish();
		return { changed: true, originalSelectedLength: plan.originalSelectedLength, plannedSelectedLength: plan.plannedSelectedLength, actualSelectedLength: actualLength, oldBypassState, originalTargetId: targetId, oldBypassFragmentIds, nativeReplacedOriginalIds, attemptedDeletedIds, plannedFamilySelfGapLowerBoundMil, sourceFamilySelfGapLowerBoundMil, familySelfGapMeaning: '曲线族半径给出的往返支路铜边间距下界；不是全链或整板实测最小值，也不比较旧线之间的间距。', sourceRegionContainmentVerified: true, actualMaxJoinDeviationMil, sourceJoinToleranceMil: 0.001, createdIds, createdPrimitives, actualPrimitives: finalPrimitives, finalArcReadback, deletedIds, selectedSide: plan.selectedSide, attachmentCheck: actualAttachments, parameterSources, boardClearanceVerified: false, connectivityVerified: false, impedanceVerified: false, precisionExplanation: plan.precisionExplanation, selectionReason: selection.selectionReason, saved: false };
	}
	catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		const cause = failure.cause && typeof failure.cause === 'object' ? failure.cause as Record<string, any> : {};
		if (writerStarted) {
			const writerCreated = Array.isArray(cause.createdPrimitives) ? cause.createdPrimitives.filter((item: any) => item && (item.type === 'line' || item.type === 'arc') && typeof item.id === 'string') : [];
			createdPrimitives = [...new Map([...createdPrimitives, ...writerCreated].map((item: { type: 'line' | 'arc'; id: string }) => [`${item.type}\0${item.id}`, item])).values()];
			const candidate = cause.candidatePrimitive && (cause.candidatePrimitive.type === 'line' || cause.candidatePrimitive.type === 'arc') && typeof cause.candidatePrimitive.id === 'string'
				? cause.candidatePrimitive as { type: 'line' | 'arc'; id: string }
				: undefined;
			createdIds = [...new Set([...createdIds, ...createdPrimitives.map(item => item.id), ...(candidate?.id ? [candidate.id] : [])])];
			actualPrimitives = Array.isArray(cause.actualPrimitives) ? cause.actualPrimitives : actualPrimitives;
			failure.cause = { ...cause, partial: true, retryable: false, createdIds, createdPrimitives, actualPrimitives, possibleCreatedPrimitive: candidate, attemptedDeletedIds, deletedIds, oldBypassState, originalTargetId, oldBypassFragmentIds, nativeReplacedOriginalIds };
		}
		host.fail(failure, { failedStep: phase, createdIds, deletedIds, attemptedDeletedIds, oldBypassState, retryable: false });
	}
}

async function inspectCurveReadback(params: Record<string, any>): Promise<unknown> {
	if (!params || !Array.isArray(params.primitiveIds) || params.primitiveIds.length === 0 || params.primitiveIds.length > 50)
		throw new Error('primitiveIds 必须是1至50项的显式列表');
	const seen = new Set<string>();
	for (const [index, item] of params.primitiveIds.entries()) {
		if (!item || typeof item !== 'object' || Array.isArray(item) || !['line', 'arc'].includes(item.type)
			|| typeof item.id !== 'string' || !item.id.trim() || Object.keys(item).some(key => !['type', 'id'].includes(key))) {
			throw new Error(`primitiveIds[${index}] 必须只包含 type ('line'|'arc') 与非空 id`);
		}
		const key = `${item.type.toUpperCase()}\0${item.id}`;
		if (seen.has(key))
			throw new Error(`primitiveIds[${index}] 重复：${item.type} ${item.id}`);
		seen.add(key);
	}
	const timeoutMs = Number(params._timeoutMs ?? 60_000);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
		throw new Error('_timeoutMs 必须为有效正数且不超过 2147483647ms');
	const host = await createGeometryHost(eda, params);
	const results: unknown[] = [];
	try {
		host.checkBudget();
		const sourceText = await host.read('读取曲线诊断源码', () => eda.sys_FileManager.getDocumentSource());
		if (typeof sourceText !== 'string')
			throw new Error('源码读回无效');
		const document = parseSourceLog(sourceText);
		if (document.uuid !== host.documentUuid || document.docType.toUpperCase() !== 'PCB')
			throw new Error('源码文档身份与目标 PCB 不符');
		const records = resolveRecords(document);
		for (const item of params.primitiveIds as Array<{ type: 'line' | 'arc'; id: string }>) {
			host.checkBudget();
			const type = item.type.toUpperCase();
			const record = records.get(`${type}\0${item.id}`);
			if (!record)
				throw new Error(`源码中找不到${type} ${item.id}`);
			let object: any;
			if (item.type === 'line')
				object = await host.read(`fresh getter 读取LINE ${item.id}`, () => eda.pcb_PrimitiveLine.get(item.id));
			else
				object = await host.read(`fresh getter 读取ARC ${item.id}`, () => eda.pcb_PrimitiveArc.get(item.id));
			if (!object)
				throw new Error(`fresh getter 未返回${type} ${item.id}`);
			if (item.type === 'arc') {
				const primitive = sourcePrimitive(record);
				if (primitive.type !== 'arc')
					throw new Error(`源码 ${item.id} 不是ARC`);
				const evidence = inspectArcReadback(object, record, { id: item.id, net: primitive.net, layer: primitive.layer, width: primitive.width, curve: primitive.curve as Extract<CurvePrimitive, { type: 'arc' }> }, 'fresh-getter');
				results.push(evidence);
			}
			else {
				const data = record.data as Record<string, any>;
				const rawSDK: Record<string, unknown> = {};
				const differences: string[] = [];
				for (const name of ['PrimitiveId', 'PrimitiveType', 'Net', 'Layer', 'LineWidth', 'StartX', 'StartY', 'EndX', 'EndY']) {
					try {
						const getter = object[`getState_${name}`];
						if (typeof getter !== 'function')
							throw new Error(`缺少getState_${name}()`);
						rawSDK[name] = getter.call(object);
					}
					catch (error) { differences.push(error instanceof Error ? error.message : String(error)); }
				}
				if (rawSDK.PrimitiveId !== item.id)
					differences.push('SDK PrimitiveId与目标ID不符');
				if (rawSDK.PrimitiveType !== 'Line')
					differences.push('SDK PrimitiveType与LINE不符');
				if (rawSDK.Net !== data.netName)
					differences.push('SDK Net与源码不符');
				if (rawSDK.Layer !== data.layerId)
					differences.push('SDK Layer与源码不符');
				if (rawSDK.LineWidth !== data.width)
					differences.push('SDK LineWidth与源码不符');
				const sdkA: [unknown, unknown] = [rawSDK.StartX, rawSDK.StartY];
				const sdkB: [unknown, unknown] = [rawSDK.EndX, rawSDK.EndY];
				const direct = sdkA[0] === data.startX && sdkA[1] === data.startY && sdkB[0] === data.endX && sdkB[1] === data.endY;
				const reversed = sdkA[0] === data.endX && sdkA[1] === data.endY && sdkB[0] === data.startX && sdkB[1] === data.startY;
				if (!direct && !reversed)
					differences.push('SDK端点与LINE源码不符');
				results.push({ readbackMode: 'fresh-getter', rawSDK, source: { id: item.id, type: record.header.type, net: data.netName, layer: data.layerId, width: data.width, start: [data.startX, data.startY], end: [data.endX, data.endY] }, differences });
			}
		}
		await host.finish();
		return { documentUuid: host.documentUuid, readOnly: true, results };
	}
	catch (error) {
		host.fail(error, { failedStep: 'inspect-curve-readback', retryable: false });
	}
}

export const lengthTuneCommands: ICommandDef[] = [{
	name: 'pcb.tuneLength',
	summary: '按显式弯曲半径在明确区域内创建真实LINE/ARC补长，并在读回核验后替换原LINE或经确认的宿主分片。',
	params: [
		{ name: 'net', type: 'string', required: true, description: '目标网络名称。' },
		{ name: 'targetLength', type: 'number', required: true, description: '所选整条开放线链的目标总长，mil。' },
		{ name: 'region', type: 'object', required: true, description: '调节区域，包含xMin/yMin/xMax/yMax，单位mil。' },
		{ name: 'primitiveIds', type: 'string[]', description: '可选：明确指定构成一条开放单链的LINE ID。' },
		{ name: 'tunePrimitiveId', type: 'string', description: '可选：指定链中需要补长的LINE ID。' },
		{ name: 'side', type: 'string', description: 'auto、left或right，默认auto。' },
		{ name: 'minSelfGap', type: 'number', required: true, description: '新增圆弧曲线族内部往返支路的最小铜边间距，mil；必须明确提供。' },
		{ name: 'lengthTolerance', type: 'number', required: true, description: '规划及实测整条选中链的累计总长误差容限，mil；当前无已核实的局部调节规则映射，明确提供，不套用差分默认10mil。' },
		{ name: 'bendRadius', type: 'number', required: true, description: '四分之一圆弧的中心线半径，mil；当前SDK无已核实的项目最小弯曲半径映射，必须明确填写。' },
		{ name: 'dryRun', type: 'boolean', description: 'true时只规划并检查，不创建或删除走线。' },
	],
	returns: '返回原target ID、宿主替代的原target ID、确认的旧旁路分片ID，以及实际尝试删除和源码+SDK均确认删除的ID列表；writer创建ID独立列出。返回整链实测长度与曲线族半径间距下界（不代表整板最小铜间距）；失败可能partial，未知写入停止且不自动重试或回滚。',
	handler: tuneLength,
}, {
	name: 'pcb.inspectCurveReadback',
	summary: '只读核对显式 LINE/ARC ID 的 fresh getter 与同 ID 源码属性；不创建、修改、删除或保存图元。',
	params: [
		{ name: 'primitiveIds', type: '{type:\'line\'|\'arc\',id:string}[]', required: true, description: '显式图元列表，1至50项；每项仅含 type 和 id。' },
	],
	returns: '每个项目返回 fresh-getter 原始 SDK 属性、同 ID 源码属性、readbackMode 与 differences；ARC 另含端点读回模式和源码几何。',
	handler: inspectCurveReadback,
}];
