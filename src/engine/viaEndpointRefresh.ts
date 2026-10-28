import { parseSourceLog, type ISourceRecord } from '../pcb/sourcelog'

type AnySdk = Record<string, any>
type BudgetedRead = <T>(label: string, operation: () => Promise<T> | T) => Promise<T>

export interface ViaEndpointTarget {
	primitiveId: string
	net: string
	layer: number
	startX: number
	startY: number
	endX: number
	endY: number
	lineWidth: number
	locked: unknown
}

export interface ViaEndpointPlan {
	status: 'ready' | 'skipped'
	reason?: string
	beforeViaSource?: string
	docHeadData?: Record<string, unknown>
	targets: ViaEndpointTarget[]
}

export interface ViaEndpointResult {
	attempted: boolean
	skipped?: boolean
	reason?: string
	creationTicketChanges?: Array<{ type: string, id?: string, before: unknown, after: unknown }>
	completedLineIds: string[]
	results: Array<{
		primitiveId: string
		rawReturnKind: string
		rawReturnedId?: unknown
		readbackVerified: boolean
		sourcePreserved: boolean
	}>
}

function state(item: any, name: string): unknown {
	const getter = item?.[`getState_${name}`]
	if (typeof getter !== 'function')
		throw new Error(`走线读回缺少 getState_${name}`)
	return getter.call(item)
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function sameRoundtripNumber(actual: unknown, expected: unknown): boolean {
	if (!finite(actual) || !finite(expected)) return false
	const tolerance = Math.min(1e-9, 4 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)))
	return Math.abs(actual - expected) <= tolerance
}

function parse(source: string) {
	if (typeof source !== 'string') throw new Error('PCB 源码不是字符串')
	return parseSourceLog(source)
}

function sourceWithoutDocHead(source: string): string {
	return parse(source).records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n')
}

function sourceDocHead(source: string): Record<string, unknown> {
	const head = parse(source).records.find(record => record.header.type === 'DOCHEAD')
	if (!head || !head.data || typeof head.data !== 'object' || Array.isArray(head.data)) throw new Error('DOCHEAD 无效')
	return head.data as Record<string, unknown>
}

function sameDocHeadIdentity(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
	const allowedRuntimeFields = new Set(['client', 'updateTime', 'version'])
	const keys = new Set([...Object.keys(before), ...Object.keys(after)])
	for (const key of keys) {		if (allowedRuntimeFields.has(key)) continue
		if (!Object.prototype.hasOwnProperty.call(before, key) || !Object.prototype.hasOwnProperty.call(after, key) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false
	}
	return true
}

function isCopperLayer(layer: any): boolean {
	return layer?.type === 'SIGNAL'
		&& Number.isInteger(layer?.id)
		&& (layer.layerStatus === 1 || layer.layerStatus === 2)
}

function sourceLine(record: ISourceRecord): ViaEndpointTarget | undefined {
	if (record.header.type !== 'LINE' || typeof record.header.id !== 'string' || !record.header.id || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return undefined
	const data = record.data as Record<string, unknown>
	if (typeof data.netName !== 'string' || !Number.isInteger(data.layerId) || !finite(data.startX) || !finite(data.startY) || !finite(data.endX) || !finite(data.endY) || !finite(data.width)) return undefined
	return {
		primitiveId: record.header.id,
		net: data.netName,
		layer: data.layerId as number,
		startX: data.startX,
		startY: data.startY,
		endX: data.endX,
		endY: data.endY,
		lineWidth: data.width,
		locked: data.locked,
	}
}

function sourceEndpointMatches(line: ViaEndpointTarget, x: number, y: number): boolean {
	return (sameRoundtripNumber(line.startX, x) && sameRoundtripNumber(line.startY, y))
		|| (sameRoundtripNumber(line.endX, x) && sameRoundtripNumber(line.endY, y))
}

function freshLineMatches(item: any, expected: ViaEndpointTarget): boolean {
	return state(item, 'PrimitiveId') === expected.primitiveId
		&& state(item, 'Net') === expected.net
		&& state(item, 'Layer') === expected.layer
		&& sameRoundtripNumber(state(item, 'StartX'), expected.startX)
		&& sameRoundtripNumber(state(item, 'StartY'), expected.startY)
		&& sameRoundtripNumber(state(item, 'EndX'), expected.endX)
		&& sameRoundtripNumber(state(item, 'EndY'), expected.endY)
		&& sameRoundtripNumber(state(item, 'LineWidth'), expected.lineWidth)
		&& state(item, 'PrimitiveLock') === expected.locked
}

export async function prepareViaEndpointRefresh(sdk: AnySdk, net: string, x: number, y: number, read: BudgetedRead): Promise<ViaEndpointPlan> {
	const skipped = (reason: string): ViaEndpointPlan => ({ status: 'skipped', reason, targets: [] })
	try {
		if (typeof sdk.sys_FileManager?.getDocumentSource !== 'function' || typeof sdk.pcb_Layer?.getAllLayers !== 'function' || typeof sdk.pcb_PrimitiveLine?.get !== 'function') return skipped('缺少源码、铜层或按 ID 读回能力')
		const source = await read('端点刷新计划的写前源码', () => sdk.sys_FileManager.getDocumentSource())
		const docHeadData = sourceDocHead(source)
		const document = parse(source)
		const layers = await read('端点刷新计划的铜层', () => sdk.pcb_Layer.getAllLayers())
		if (!Array.isArray(layers)) return skipped('铜层读回非数组')
		const copperLayers = new Set(layers.filter(isCopperLayer).map(layer => layer.id as number))
		if (!copperLayers.size) return skipped('未能确认启用铜层')
		const latest = new Map<string, ISourceRecord>()
		for (const record of document.records) {
			if (record.header.type !== 'LINE' || typeof record.header.id !== 'string') continue
			const previous = latest.get(record.header.id)
			if (!previous || Number(record.header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) latest.set(record.header.id, record)
		}
		const targets: ViaEndpointTarget[] = []
		for (const [id, effective] of latest) {
			if (effective.data === '') continue
			const expected = sourceLine(effective)
			if (!expected || expected.net !== net || !copperLayers.has(expected.layer) || !sourceEndpointMatches(expected, x, y)) continue
			const item = await read(`端点候选走线 ${id} 新鲜读回`, () => sdk.pcb_PrimitiveLine.get(id))
			if (!item || !freshLineMatches(item, expected)) return skipped(`端点候选 ${id} 的源码与新鲜 getter 不一致`)
			targets.push(expected)
		}
		return { status: 'ready', beforeViaSource: source, docHeadData, targets }
	}
	catch (error) {
		if ((error as any)?.budgetExceeded) throw error
		return skipped(`端点预检未完成：${error instanceof Error ? error.message : String(error)}`)
	}
}

function verifyViaOnlyAdded(beforeSource: string, afterSource: string, viaId: string): { verified: boolean; reason?: string; docHeadData?: Record<string, unknown>; creationTicketChanges?: ViaEndpointResult['creationTicketChanges'] } {
	const before = parse(beforeSource)
	const after = parse(afterSource)
	const beforeHead = sourceDocHead(beforeSource)
	const afterHead = sourceDocHead(afterSource)
	if (!sameDocHeadIdentity(beforeHead, afterHead)) return { verified: false, reason: '过孔创建期间 DOCHEAD 身份字段变化' }
	const expectedOriginal = before.records.filter(record => record.header.type !== 'DOCHEAD')
	const actual = after.records.filter(record => record.header.type !== 'DOCHEAD')
	if (expectedOriginal.some(record => record.header.id === viaId)) return { verified: false, reason: '目标 VIA ID 在创建前已存在' }
	const addedVias = actual.filter(record => record.header.type === 'VIA' && record.header.id === viaId)
	if (addedVias.length !== 1) return { verified: false, reason: '过孔创建后的源码未包含唯一目标 VIA 记录' }
	const remaining = actual.filter(record => record !== addedVias[0])
	if (remaining.length !== expectedOriginal.length || expectedOriginal.some((previous, index) => !sameRecordExceptTicket(previous, remaining[index])))
		return { verified: false, reason: '既有源码数据、记录顺序或非 ticket header 字段被改变' }
	const creationTicketChanges = expectedOriginal.flatMap((previous, index) => {
		const current = remaining[index]
		return previous.header.ticket === current.header.ticket ? [] : [{ type: previous.header.type, ...(previous.header.id ? { id: previous.header.id } : {}), before: previous.header.ticket, after: current.header.ticket }]
	})
	return { verified: true, docHeadData: afterHead, creationTicketChanges }
}

function sameRecordExceptTicket(a: ISourceRecord, b: ISourceRecord): boolean {
	const ah = { ...a.header }; const bh = { ...b.header }
	delete ah.ticket; delete bh.ticket
	return a.header.type === b.header.type && a.header.id === b.header.id
		&& JSON.stringify(ah) === JSON.stringify(bh)
		&& JSON.stringify(a.data) === JSON.stringify(b.data)
}

function rawKind(value: unknown): string {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (Array.isArray(value)) return 'array'
	return typeof value
}

function returnedId(value: any): unknown {
	if (!value || typeof value !== 'object') return undefined
	try {
		if (typeof value.getState_PrimitiveId === 'function') return value.getState_PrimitiveId()
		if (Object.prototype.hasOwnProperty.call(value, 'primitiveId')) return value.primitiveId
		if (Object.prototype.hasOwnProperty.call(value, 'id')) return value.id
	}
	catch { return undefined }
	return undefined
}

function compareRefreshSource(beforeSource: string, afterSource: string): boolean {
	const before = parse(beforeSource); const after = parse(afterSource)
	return sameDocHeadIdentity(sourceDocHead(beforeSource), sourceDocHead(afterSource))
		&& before.records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n')
		=== after.records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n')
}

export async function refreshViaEndpointLines(sdk: AnySdk, plan: ViaEndpointPlan, viaId: string, net: string, x: number, y: number, focusCheck: (phase: string) => Promise<void>, read: BudgetedRead): Promise<ViaEndpointResult> {
	if (plan.status !== 'ready' || !plan.targets.length) return { attempted: false, skipped: true, reason: plan.reason ?? '没有同网、启用 SIGNAL 铜层且端点重合的普通 LINE', completedLineIds: [], results: [] }
	const completedLineIds: string[] = []
	const results: ViaEndpointResult['results'] = []
	const partial = (message: string): never => {
		const error = new Error(message)
		;(error as any).endpointRefresh = { attempted: true, completedLineIds: [...completedLineIds], results: [...results] }
		throw error
	}
	try {
		await focusCheck('端点刷新前焦点复核')
		const afterViaSource = await read('过孔创建后源码', () => sdk.sys_FileManager.getDocumentSource())
		const viaDiff = verifyViaOnlyAdded(plan.beforeViaSource!, afterViaSource, viaId)
		if (!viaDiff.verified) partial(viaDiff.reason ?? '过孔创建源码差异未确认')
		let expectedSource = afterViaSource
		for (const target of plan.targets) {
			let result: ViaEndpointResult['results'][number] | undefined
			try {
				await focusCheck(`刷新 ${target.primitiveId} 前焦点复核`)
				const beforeSource = await read(`刷新 ${target.primitiveId} 前源码`, () => sdk.sys_FileManager.getDocumentSource())
				if (!compareRefreshSource(expectedSource, beforeSource)) partial(`刷新 ${target.primitiveId} 前完整 PCB 源码与上一读回不一致`)
				const fresh = await read(`刷新 ${target.primitiveId} 前新鲜走线`, () => sdk.pcb_PrimitiveLine.get(target.primitiveId))
				if (!fresh || !freshLineMatches(fresh, target) || target.net !== net || !Number.isInteger(target.layer) || !(sameRoundtripNumber(target.startX, x) && sameRoundtripNumber(target.startY, y) || sameRoundtripNumber(target.endX, x) && sameRoundtripNumber(target.endY, y))) partial(`刷新 ${target.primitiveId} 前走线新鲜 getter 与目标不符`)
				result = { primitiveId: target.primitiveId, rawReturnKind: 'not-returned', readbackVerified: false, sourcePreserved: false }
				results.push(result)
				let raw: unknown
				try { raw = await read(`刷新 ${target.primitiveId} 原始 modify`, () => sdk.pcb_PrimitiveLine.modify(target.primitiveId, { startX: target.startX, startY: target.startY, endX: target.endX, endY: target.endY })) }
				catch (error) { result.rawReturnKind = (error as any)?.budgetExceeded ? 'timeout' : 'throw'; partial(`刷新 ${target.primitiveId} 原始 modify 未返回：${error instanceof Error ? error.message : String(error)}`) }
				const id = returnedId(raw)
				result.rawReturnKind = rawKind(raw)
				if (id !== undefined) result.rawReturnedId = id
				if (result.rawReturnKind !== 'object' || id !== target.primitiveId) partial(`刷新 ${target.primitiveId} 的原始 modify 返回值/ID 未确认`)
				await focusCheck(`刷新 ${target.primitiveId} 后焦点复核`)
				const afterSource = await read(`刷新 ${target.primitiveId} 后源码`, () => sdk.sys_FileManager.getDocumentSource())
				const afterLine = await read(`刷新 ${target.primitiveId} 后走线读回`, () => sdk.pcb_PrimitiveLine.get(target.primitiveId))
				result.readbackVerified = Boolean(afterLine && freshLineMatches(afterLine, target))
				result.sourcePreserved = compareRefreshSource(beforeSource, afterSource)
				if (!result.readbackVerified || !result.sourcePreserved) partial(`刷新 ${target.primitiveId} 后走线或完整源码读回不符`)
				expectedSource = afterSource
				completedLineIds.push(target.primitiveId)
			}
			catch (error) {
				if ((error as any)?.endpointRefresh) throw error
				return partial(`刷新 ${target.primitiveId} 阶段失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return { attempted: true, creationTicketChanges: viaDiff.creationTicketChanges ?? [], completedLineIds, results }
	}
	catch (error) {
		if ((error as any)?.endpointRefresh) throw error
		return partial(`端点刷新阶段失败：${error instanceof Error ? error.message : String(error)}`)
	}
}
