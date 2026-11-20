import type { ICommandDef, ICommandContext } from '../engine/types'
import { beginTask, failTask, finishTask, taskProgress } from '../engine/tasks'
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'
import { compareDocumentSources } from '../engine/documentRecovery'

type AnyRecord = Record<string, any>
const SYSTEM_KEYS = new Set(['instanceId', '__docUuid', '__tabId', '__projectUuid', '_timeoutMs'])

function validateKeys(params: AnyRecord, allowed: string[]): void {
	for (const key of Object.keys(params)) if (!allowed.includes(key) && !SYSTEM_KEYS.has(key) && !key.startsWith('__')) throw new Error(`未知参数: ${key}`)
}
function normalizedSource(source: string) {
	const parsed = parseSourceLog(source)
	return { parsed, records: resolveRecords(parsed) }
}
function recordData(record: any): AnyRecord { return record?.data && typeof record.data === 'object' ? record.data : {} }
function stableValue(value: any): any {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
	return value
}
function componentPropertiesChanged(before: Map<string, any>, after: Map<string, any>): string[] {
	const allowedMovement = new Set(['x', 'y', 'angle', 'positionX', 'positionY', 'rotation'])
	const changed: string[] = []
	for (const [key, old] of before) {
		if (old.header.type !== 'COMPONENT') continue
		const current = after.get(key)
		if (!current) { changed.push(key.replace('\0', ':')); continue }
		const oldProperties = Object.fromEntries(Object.entries(recordData(old)).filter(([name]) => !allowedMovement.has(name)))
		const newProperties = Object.fromEntries(Object.entries(recordData(current)).filter(([name]) => !allowedMovement.has(name)))
		if (JSON.stringify(stableValue(oldProperties)) !== JSON.stringify(stableValue(newProperties))) changed.push(key.replace('\0', ':'))
	}
	return changed
}
function primitiveId(item: any): string { return String(item?.getState_PrimitiveId?.() ?? item?.primitiveId ?? item?.id ?? '') }
function componentKey(item: any): string { return primitiveId(item) || String(item?.getState_Designator?.() ?? '') }
function coords(item: any) {
	const angle = item?.getState_Rotation?.() ?? item?.rotation
	const normalizedAngle = typeof angle === 'number' && Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : angle
	return [item?.getState_X?.() ?? item?.x, item?.getState_Y?.() ?? item?.y, normalizedAngle]
}
function snapshotComponent(item: any) {
	const coordsNow = coords(item)
	return { id: componentKey(item), ref: String(item?.getState_Designator?.() ?? item?.ref ?? componentKey(item)), x: coordsNow[0], y: coordsNow[1], rotation: coordsNow[2], layer: item?.getState_Layer?.() ?? item?.layer, locked: isLocked(item) }
}
function isLocked(item: any): boolean {
	return Boolean(item?.getState_PrimitiveLock?.() ?? item?.getState_Locked?.() ?? item?.primitiveLock ?? item?.locked)
}
async function assertTarget(ctx: ICommandContext): Promise<void> {
	ctx.stopSignal?.assertActive()
	if (!ctx.assertDocumentTarget) throw new Error('缺少文档目标守卫，拒绝执行 PCB 原生操作')
	await ctx.assertDocumentTarget()
	ctx.stopSignal?.assertActive()
}
async function readSource(ctx: ICommandContext): Promise<{ source: string, parsed: ReturnType<typeof parseSourceLog>, records: Map<string, any> }> {
	await assertTarget(ctx)
	const source = await eda.sys_FileManager.getDocumentSource()
	await assertTarget(ctx)
	if (typeof source !== 'string' || !source) throw new Error('PCB 源码读取失败或为空')
	const snapshot = normalizedSource(source)
	if (snapshot.parsed.docType !== 'PCB' || snapshot.parsed.uuid !== ctx.documentTarget?.uuid) throw new Error('PCB 源码读回与目标文档身份不一致')
	return { source, ...snapshot }
}
function routingCounts(records: Map<string, any>) {
	let lines = 0, vias = 0
	for (const record of records.values()) {
		if (record.header.type === 'LINE') lines++
		if (record.header.type === 'VIA') vias++
	}
	return { lines, vias, total: lines + vias }
}
function immutableChanged(before: Map<string, any>, after: Map<string, any>, excluded: Set<string> = new Set(), types?: Set<string>, ignoredTypes: Set<string> = new Set()): string[] {
	const errors: string[] = []
	for (const [key, old] of before) {
		if (excluded.has(key)) continue
		if (ignoredTypes.has(old.header.type)) continue
		if (types && !types.has(old.header.type)) continue
		const now = after.get(key)
		if (!now || JSON.stringify(recordData(now)) !== JSON.stringify(recordData(old))) errors.push(key.replace('\0', ':'))
	}
	for (const [key, current] of after) {
		if (before.has(key) || excluded.has(key) || ignoredTypes.has(current.header.type)) continue
		if (types && !types.has(current.header.type)) continue
		errors.push(key.replace('\0', ':'))
	}
	return errors
}
function startHeartbeat(task: ReturnType<typeof beginTask>['task']) {
	const started = Date.now()
	const timer = setInterval(() => {
		const patch = { taskId: task.id, stage: 'waiting-sdk', elapsedMs: Date.now() - started, note: 'SDK 调用仍在等待；此时间不是实际进度' }
		taskProgress(task, patch)
	}, 10_000)
	return () => clearInterval(timer)
}
function taskFor(cmd: string, params: AnyRecord, ctx: ICommandContext) {
	return beginTask(cmd, { ...params, document: ctx.documentTarget }, t => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress }))
}

async function runLayout(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} }
	validateKeys(params, ['dryRun', 'allowRoutedMovement'])
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 必须是 boolean')
	if (params.allowRoutedMovement !== undefined && typeof params.allowRoutedMovement !== 'boolean') throw new Error('allowRoutedMovement 必须是 boolean')
	const dryRun = params.dryRun !== false
	const before = await readSource(ctx)
	const routeBefore = routingCounts(before.records)
	const componentsBefore = await eda.pcb_PrimitiveComponent.getAll()
	await assertTarget(ctx)
	if (!Array.isArray(componentsBefore)) throw new Error('布局前组件读取未返回数组')
	const beforeComponents = componentsBefore.map(snapshotComponent)
	if (!dryRun && routeBefore.total > 0 && params.allowRoutedMovement !== true) throw new Error(`PCB 存在 ${routeBefore.total} 条既有线路/过孔；移动器件可能使连接关系失效。明确确认风险后传 allowRoutedMovement:true`)
	if (dryRun) return { dryRun: true, componentCount: beforeComponents.length, movableCount: beforeComponents.filter(c => !c.locked).length, lockedCount: beforeComponents.filter(c => c.locked).length, existingRouting: routeBefore, connectivityPreserved: routeBefore.total ? 'unverified' : 'not-applicable', rawResult: null, note: 'dryRun 仅读取现场，不调用原生布局' }
	const { task, existing } = taskFor('pcb.nativeAutoLayout', params, ctx)
	if (existing) return { taskId: task.id, alreadyRunning: true, state: task.state, progress: task.progress }
	const stop = startHeartbeat(task)
	let dispatched = false
	try {
		await assertTarget(ctx)
		dispatched = true
		const rawResult = await eda.pcb_Document.autoLayout()
		await assertTarget(ctx)
		const after = await readSource(ctx)
		const componentsAfter = await eda.pcb_PrimitiveComponent.getAll()
		await assertTarget(ctx)
		if (!Array.isArray(componentsAfter)) throw new Error('布局后组件读回未返回数组')
		const afterComponents = componentsAfter.map(snapshotComponent)
		const afterById = new Map(afterComponents.map(c => [c.id, c]))
		const moved: string[] = [], unchangedLocked: string[] = [], skippedLocked: string[] = []
		for (const c of beforeComponents) {
			const key = c.id, next = afterById.get(key), ref = c.ref
			if (!next) throw new Error(`布局后组件缺失，无法确认结果: ${ref}`)
			if (c.locked) {
				if (JSON.stringify([c.x, c.y, c.rotation, c.layer, c.locked]) !== JSON.stringify([next.x, next.y, next.rotation, next.layer, next.locked])) throw new Error(`锁定器件位置/层/锁定状态发生变化，无法作为跳过项报告: ${ref}`)
				unchangedLocked.push(ref); skippedLocked.push(ref); continue
			}
			if (JSON.stringify([c.x, c.y, c.rotation, c.layer]) !== JSON.stringify([next.x, next.y, next.rotation, next.layer])) moved.push(ref)
		}
		const beforeIds = new Set(beforeComponents.map(c => c.id))
		const addedComponents = afterComponents.filter(c => !beforeIds.has(c.id)).map(c => c.ref)
		if (addedComponents.length) throw new Error(`布局后出现输入集合之外的新器件，结果不符合原生布局预期：${addedComponents.join(', ')}`)
		const immutable = immutableChanged(before.records, after.records, new Set(), new Set(['PAD_NET', 'RULE', 'RULE_SELECTOR', 'LINE', 'VIA']))
		if (immutable.length) throw new Error(`布局后发现非预期源码记录变化，结果部分完成且停止：${immutable.slice(0, 8).join(', ')}`)
		const componentChanges = componentPropertiesChanged(before.records, after.records)
		if (componentChanges.length) throw new Error(`布局后器件关联/封装/属性发生非坐标变化，停止后续写入：${componentChanges.slice(0, 8).join(', ')}`)
		const missingAttributes = [...before.records].filter(([key, record]) => record.header.type === 'ATTR' && !after.records.has(key)).map(([key]) => key)
		if (missingAttributes.length) throw new Error(`布局后原有器件属性记录缺失：${missingAttributes.slice(0, 8).join(', ')}`)
		const sourceComparison = compareDocumentSources(before.source, after.source)
		if (rawResult?.success !== true) throw new Error(`原生布局 SDK 未报告 success=true；${sourceComparison.equal && moved.length === 0 ? '读回确认设计未改动' : '读回未能确认设计保持不变，停止依赖后续写入'}`, { cause: sourceComparison.equal && moved.length === 0 ? { partial: false, source: 'pcb-native-layout-no-source-change', sourceComparison } : undefined })
		const finalRoute = routingCounts(after.records)
		const failedIds = Array.isArray(rawResult?.failedComponents) ? rawResult.failedComponents.map(String) : []
		const byId = new Map(beforeComponents.map(c => [c.id, c]))
		const failedMovable = failedIds.filter(id => byId.has(id) && !byId.get(id)!.locked)
		const unknownFailedIds = failedIds.filter(id => !byId.has(id))
		const complete = rawResult?.success === true && failedMovable.length === 0 && unknownFailedIds.length === 0
		const data = { taskId: task.id, dryRun: false, rawResult, engineReportedSuccess: rawResult?.success === true, moved, unchangedLocked, skippedLocked, failedMovable, unknownFailedIds, complete, actualTotal: beforeComponents.length, movedCount: moved.length, addedComponents, existingRoutingBefore: routeBefore, existingRoutingAfter: finalRoute, connectivityPreserved: routeBefore.total ? 'unverified' : 'not-applicable', sourceReadback: 'verified', drc: 'not-run', persistence: 'not-verified', note: '原始失败列表保留在 rawResult；锁定器件统计为跳过项，complete 排除锁定器件并解析失败 ID，SDK 成功计数不单独证明完整布局' }
		finishTask(task, data)
		return data
	}
	catch (error) {
		failTask(task, error)
		if (dispatched && (error as any)?.cause?.partial !== false) throw new Error(error instanceof Error ? error.message : String(error), { cause: { partial: true, source: 'pcb-native-layout', taskId: task.id } })
		throw error
	}
	finally { stop() }
}

async function runRoute(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} }
	validateKeys(params, ['dryRun', 'RoutingNets', 'cornerStyle', 'existingPrimitiveMode', 'optimization', 'layers', 'ignoreNets'])
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 必须是 boolean')
	const dryRun = params.dryRun !== false
	const mode = params.existingPrimitiveMode ?? 'keep'
	if (mode !== 'keep' && mode !== 'remove') throw new Error('existingPrimitiveMode 仅支持 keep/remove')
	if (params.RoutingNets !== undefined && params.RoutingNets !== 'selected' && params.RoutingNets !== 'selectedComponents' && (!Array.isArray(params.RoutingNets) || params.RoutingNets.some((n: unknown) => typeof n !== 'string' || !n.trim()))) throw new Error('RoutingNets 必须为 selected、selectedComponents 或非空网络名称数组')
	if (params.ignoreNets !== undefined && (!Array.isArray(params.ignoreNets) || params.ignoreNets.some((n: unknown) => typeof n !== 'string'))) throw new Error('ignoreNets 必须是字符串数组')
	if (params.cornerStyle !== undefined && ![0, 1].includes(params.cornerStyle)) throw new Error('cornerStyle 仅支持 0/1')
	if (params.optimization !== undefined && ![0, 1].includes(params.optimization)) throw new Error('optimization 仅支持 0/1')
	if (params.layers !== undefined && (!Array.isArray(params.layers) || params.layers.some((layer: unknown) => typeof layer !== 'number' || !Number.isFinite(layer)))) throw new Error('layers 必须是实际铜层数值数组')
	const before = await readSource(ctx), routesBefore = routingCounts(before.records)
	if (dryRun) return { dryRun: true, routingBefore: routesBefore, routingNets: params.RoutingNets ?? 'all-unrouted', ignoreNets: params.ignoreNets ?? [], existingPrimitiveMode: mode, rawResult: null, note: 'dryRun 仅读取现场，不调用原生布线' }
	const { task, existing } = taskFor('pcb.nativeAutoRoute', params, ctx)
	if (existing) return { taskId: task.id, alreadyRunning: true, state: task.state, progress: task.progress }
	const stop = startHeartbeat(task)
	let dispatched = false
	try {
		await assertTarget(ctx)
		dispatched = true
		const rawResult = await eda.pcb_Document.autoRouting({ RoutingNets: params.RoutingNets, cornerStyle: params.cornerStyle, existingPrimitiveMode: mode, optimization: params.optimization, layers: params.layers, ignoreNets: params.ignoreNets })
		await assertTarget(ctx)
		const after = await readSource(ctx)
		const sourceComparison = compareDocumentSources(before.source, after.source)
		const sourceChanges = immutableChanged(before.records, after.records, new Set(), undefined, new Set(['LINE', 'VIA']))
		if (sourceChanges.length) throw new Error(`布线后固定组件/网络映射/规则发生变化，停止后续操作：${sourceChanges.slice(0, 8).join(', ')}`)
		const oldRoutes = new Map([...before.records].filter(([, record]) => record.header.type === 'LINE' || record.header.type === 'VIA'))
		const changedOldRoutes = mode === 'keep' ? [...oldRoutes].filter(([key, old]) => {
			const current = after.records.get(key)
			return !current || JSON.stringify(recordData(current)) !== JSON.stringify(recordData(old))
		}).map(([key]) => key.replace('\0', ':')) : []
		if (changedOldRoutes.length) throw new Error(`keep 模式下既有线路/过孔未完整保留：${changedOldRoutes.slice(0, 8).join(', ')}`)
		if (rawResult?.success !== true) throw new Error(`原生布线 SDK 未报告 success=true；${sourceComparison.equal ? '读回确认设计未改动' : '读回未能确认设计保持不变，停止依赖后续写入'}`, { cause: sourceComparison.equal ? { partial: false, source: 'pcb-native-route-no-source-change', sourceComparison } : undefined })
		const routesAfter = routingCounts(after.records)
		const addedRoutingRecords = [...after.records].filter(([key, record]) => (record.header.type === 'LINE' || record.header.type === 'VIA') && (!before.records.has(key) || JSON.stringify(recordData(before.records.get(key))) !== JSON.stringify(recordData(record)))).map(([, record]) => ({ type: record.header.type, id: record.header.id, netName: recordData(record).netName ?? null, layer: recordData(record).layer ?? recordData(record).layerId ?? null }))
		const selectedNets = Array.isArray(params.RoutingNets) && params.RoutingNets.length > 0 ? new Set(params.RoutingNets) : undefined
		const ignoredNets = new Set(params.ignoreNets ?? [])
		const unexpectedNets = addedRoutingRecords.filter(route => route.netName !== null && ((selectedNets && !selectedNets.has(route.netName)) || ignoredNets.has(route.netName)))
		if (unexpectedNets.length) throw new Error(`布线读回包含未请求或明确忽略的网络：${unexpectedNets.map(route => `${route.netName}/${route.id}`).join(', ')}`)
		const allUnrouted = params.RoutingNets === undefined || (Array.isArray(params.RoutingNets) && params.RoutingNets.length === 0)
		const netScopeVerified = allUnrouted ? true : Boolean(selectedNets) && addedRoutingRecords.every(route => route.netName !== null)
		const layerScopeVerified = params.layers === undefined ? true : addedRoutingRecords.every(route => route.layer !== null && params.layers.includes(route.layer))
		if (params.layers !== undefined && addedRoutingRecords.some(route => route.layer !== null && !params.layers.includes(route.layer))) throw new Error('布线读回包含不在 layers 参数中的图层')
		const routingScopeVerified = netScopeVerified && layerScopeVerified && addedRoutingRecords.every(route => route.netName !== null || ignoredNets.size === 0)
		const data = { taskId: task.id, dryRun: false, rawResult, engineReportedSuccess: rawResult?.success === true, routingBefore: routesBefore, routingAfter: routesAfter, addedRouting: addedRoutingRecords.length, addedRoutingRecords, routingScopeVerified, existingPrimitiveMode: mode, existingRoutingPreserved: mode === 'keep' ? 'verified' : 'not-applicable', sourceReadback: 'verified', drc: 'not-run', persistence: 'not-verified', note: '原生引擎返回值保留；源码读回核对固定组件/网络映射/规则、keep 模式旧线路及可识别的新增网络名/图层，不代表整板 DRC 或持久性验收' }
		finishTask(task, data)
		return data
	}
	catch (error) {
		failTask(task, error)
		if (dispatched && (error as any)?.cause?.partial !== false) throw new Error(error instanceof Error ? error.message : String(error), { cause: { partial: true, source: 'pcb-native-route', taskId: task.id } })
		throw error
	}
	finally { stop() }
}

export const pcbNativeAutomationCommands: ICommandDef[] = [
	{ name: 'pcb.nativeAutoLayout', summary: '调用 EDA 原生 PCB 自动布局并读回核对器件变化', params: [
		{ name: 'dryRun', type: 'boolean', description: '只检查现场，不调用 SDK（默认 true）；显式 false 执行原生布局' },
		{ name: 'allowRoutedMovement', type: 'boolean', description: '既有布线时显式确认移动器件会使连接关系需重新核验；默认拒绝执行' },
	], returns: '{ moved, unchangedLocked, skippedLocked, actualTotal, rawResult, sourceReadback, drc, persistence }', example: { cmd: 'pcb.nativeAutoLayout', params: { dryRun: true } }, handler: runLayout },
	{ name: 'pcb.nativeAutoRoute', summary: '调用 EDA 原生 PCB 自动布线并读回核对结果', params: [
		{ name: 'dryRun', type: 'boolean', description: '只检查现场，不调用 SDK（默认 true）；显式 false 执行原生布线' },
		{ name: 'RoutingNets', type: 'string[]|enum', description: '目标网络，selected/selectedComponents 或网络名数组' },
		{ name: 'cornerStyle', type: 'number', description: '拐角 0=45度，1=90度' },
		{ name: 'existingPrimitiveMode', type: 'string', description: '已有线路/过孔处理方式 keep（默认）或 remove' },
		{ name: 'optimization', type: 'number', description: '优化目标 1=布通率，0=速度' },
		{ name: 'layers', type: 'number[]', description: '允许布线的实际铜层 ID' },
		{ name: 'ignoreNets', type: 'string[]', description: '忽略的网络名' },
	], returns: '{ rawResult, routingBefore, routingAfter, existingRoutingPreserved, sourceReadback, drc, persistence }', example: { cmd: 'pcb.nativeAutoRoute', params: { dryRun: true, RoutingNets: ['GND'], existingPrimitiveMode: 'keep' } }, handler: runRoute },
]
