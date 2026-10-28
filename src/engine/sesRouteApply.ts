import type { IDocumentSnapshot, TDocumentWrite } from './documentRecovery'
import { verifySesImport, type SesImportPlan, type SesRouteLine, type SesRouteVia, type SesImportVerification } from './autoRouteSes'
import { readRouteSnapshot, verifySourceChanges, type HostRouteSnapshot } from './autoRouteSesHost'

type JournalWrite = {
	kind: string
	attempted: boolean
	settled: boolean
	settlement?: 'returned' | 'threw' | 'unsettled'
	confirmed: boolean
	candidateId?: string | string[]
	expectedGeometry?: unknown
	phase: string
	result?: unknown
	error?: string
	mergeReadback?: { candidateId: string, actualIds: string[], confirmedLineCount: number }
}

export interface SesRouteApplyContextOptions {
	api: any
	snapshot: IDocumentSnapshot
	before: HostRouteSnapshot
	plan: SesImportPlan
	deletedArcIds: string[]
	file: File
	timeoutMs: number
	manualAppendViaFirst?: boolean
	onStage?: (stage: string) => void
	onMayWrite?: () => void
}

export interface SesRouteApplyContext {
	backend: 'direct-primitives' | 'native-ses'
	journal: { writes: JournalWrite[], phase: string }
	focusGuard(): Promise<void>
	apply(write: TDocumentWrite): Promise<{ result: SesImportVerification, cleared: { lines: number, vias: number, arcs: number } }>
	recover(context: { snapshot: IDocumentSnapshot, operationError: unknown, write: TDocumentWrite }): Promise<{ restored: boolean, cause: Record<string, unknown> }>
}

function state<T>(item: any, getter: string): T {
	const fn = item?.[getter]
	if (typeof fn !== 'function')
		throw new Error(`SDK 图元缺少 ${getter}`)
	return fn.call(item)
}

function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function routeSourceRecords(snapshot: HostRouteSnapshot, ids: string[]): Array<{ type: string, id: string }> {
	return ids.flatMap(id => {
		const matches = snapshot.sourceRecords.filter(record => record.id === id && ['LINE', 'VIA', 'ARC', 'TRACK'].includes(record.type))
		if (matches.length !== 1)
			throw new Error(`路由 ${id} 在源记录中匹配 ${matches.length} 条，无法确认`)
		return [{ type: matches[0].type, id }]
	})
}

function sourceSame(before: HostRouteSnapshot, after: HostRouteSnapshot): boolean {
	return verifySourceChanges(before, after, [], []).verified
}

function geometrySame(before: HostRouteSnapshot, after: HostRouteSnapshot): boolean {
	const project = (snapshot: HostRouteSnapshot) => ({
		lines: snapshot.lines.map(({ id, net, layer, widthMil, a, b, locked }) => ({ id, net, layer, widthMil, a, b, locked })).sort((a, b) => a.id.localeCompare(b.id)),
		vias: snapshot.vias.map(({ id, net, x, y, diameterMil, holeDiameterMil, viaType, locked }) => ({ id, net, x, y, diameterMil, holeDiameterMil, viaType, locked })).sort((a, b) => a.id.localeCompare(b.id)),
		arcs: snapshot.arcs.map(({ id, net, layer, widthMil, start, end, angle, locked }) => ({ id, net, layer, widthMil, start, end, angle, locked })).sort((a, b) => a.id.localeCompare(b.id)),
	})
	return equal(project(before), project(after))
}

export function createSesRouteApplyContext(options: SesRouteApplyContextOptions): SesRouteApplyContext {
	const { api, snapshot, before, plan } = options
	const credibleVia = (via: SesRouteVia) => Number.isFinite(via.holeDiameterMil)
		&& (via.viaType === undefined || via.viaType === 0 || via.viaType === 'through')
	const backend: SesRouteApplyContext['backend'] = plan.deltaVias.length === 0 || plan.deltaVias.every(credibleVia)
		? 'direct-primitives'
		: 'native-ses'
	const manualAppendViaFirst = options.manualAppendViaFirst === true
		&& plan.mode === 'append'
		&& backend === 'direct-primitives'
		&& plan.deltaVias.length > 0
	const journal: SesRouteApplyContext['journal'] = { writes: [], phase: 'prepared' }
	const confirmedAddedLineIds = new Set<string>()
	const beforeLineIds = new Set(before.sourceRecords.filter(record => record.type === 'LINE' || record.type === 'TRACK').map(record => record.id))
	const lineIdSetsEqual = (actual: string[], expected: Iterable<string>) => {
		const actualSet = new Set(actual)
		const expectedSet = new Set(expected)
		return actual.length === actualSet.size
			&& actualSet.size === expectedSet.size
			&& [...expectedSet].every(id => actualSet.has(id))
	}
	const readAllLineIds = async () => {
		const ids = await readBounded('走线 ID 枚举', () => api.pcb_PrimitiveLine.getAllPrimitiveId())
		if (!Array.isArray(ids) || ids.some((value: unknown) => typeof value !== 'string'))
			throw new Error('走线 ID 枚举返回无效结果')
		return ids
	}
	const budgetStart = Date.now()
	const totalDeadline = budgetStart + Math.max(1, options.timeoutMs)
	const recoveryReserveMs = Math.min(Math.max(20, Math.floor(options.timeoutMs * 0.2)), Math.max(20, options.timeoutMs - 1))
	const operationDeadline = totalDeadline - recoveryReserveMs
	let timedOut = false
	let recovering = false
	let focusLost = false
	let deletionStarted = false
	let writeSettledCount = 0
	let writeAttemptCount = 0
	const phase = (value: string) => {
		journal.phase = value
		options.onStage?.(value)
	}
	const remaining = () => (recovering ? totalDeadline : operationDeadline) - Date.now()
	const bounded = async <T>(kind: string, action: () => Promise<T>): Promise<T> => {
		const left = remaining()
		if (left <= 25)
			throw new Error(`SES 路由总预算耗尽，停止 ${kind}`)
		let active = true
		let timer: ReturnType<typeof setTimeout> | undefined
		const task = Promise.resolve().then(action).then(value => ({ state: 'done' as const, value }), error => ({ state: 'error' as const, error }))
		const timeout = new Promise<{ state: 'timeout' }>(resolve => {
			timer = setTimeout(() => { active = false; timedOut = true; resolve({ state: 'timeout' }) }, Math.max(1, left - 20))
		})
		const result = await Promise.race([task, timeout])
		if (timer) clearTimeout(timer)
		if (result.state === 'timeout')
			throw new Error(`SES 路由 SDK ${kind} 超时；后续动作已停止`)
		if (result.state === 'error')
			throw result.error
		if (!active || timedOut || remaining() <= 20)
			throw new Error(`SES 路由 SDK ${kind} 在预算边界返回；结果不用于后续动作`)
		return result.value
	}
	const fresh = async () => {
		const guardedFocus = async () => {
			await focusGuard()
		}
		await guardedFocus()
		const result = await bounded('路由与源码读回', () => readRouteSnapshot(api, guardedFocus))
		if (result.documentUuid !== snapshot.documentUuid)
			throw new Error('SES 路由读回目标文档 UUID 变化')
		return result
	}
	const focusGuard = async () => {
		if (focusLost)
			throw new Error('SES 路由焦点已丢失或不可判定；后续动作已锁止')
		if (timedOut || remaining() <= 20)
			throw new Error('SES 路由总预算耗尽，停止后续 SDK 动作')
		let current: any
		try {
			current = await bounded('焦点检查', () => api.dmt_SelectControl.getCurrentDocumentInfo())
		}
		catch (error) {
			focusLost = true
			throw error
		}
		if (current?.uuid !== snapshot.documentUuid || current?.documentType !== snapshot.documentType) {
			focusLost = true
			throw new Error(`焦点文档已变化，拒绝 SES 路由读写（目标 ${snapshot.documentUuid}）`)
		}
	}
	const readBounded = async <T>(kind: string, action: () => Promise<T>): Promise<T> => {
		await focusGuard()
		const result = await bounded(kind, action)
		await focusGuard()
		return result
	}
	const recordWrite = async <T>(kind: string, invoke: () => Promise<T>, write: TDocumentWrite, candidateId?: string | string[], expectedGeometry?: unknown): Promise<T> => {
		const entry: JournalWrite = { kind, attempted: false, settled: false, confirmed: false, phase: journal.phase, ...(candidateId ? { candidateId } : {}), ...(expectedGeometry === undefined ? {} : { expectedGeometry: JSON.parse(JSON.stringify(expectedGeometry)) }) }
		journal.writes.push(entry)
		writeAttemptCount++
		try {
			const value = await bounded(kind, () => write(async () => {
				entry.attempted = true
				options.onMayWrite?.()
				return await invoke()
			}))
			entry.settled = true
			entry.settlement = 'returned'
			entry.result = typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' || value == null
				? value
				: { kind: 'object-returned' }
			writeSettledCount++
			await focusGuard()
			return value
		}
		catch (error) {
			entry.error = error instanceof Error ? error.message : String(error)
			if (entry.attempted && !timedOut && !entry.settled) {
				entry.settled = true
				entry.settlement = 'threw'
				writeSettledCount++
			}
			throw error
		}
	}
	const readCreatedLine = async (line: SesRouteLine, id: string) => {
		const ids = await readAllLineIds()
		if (!lineIdSetsEqual(ids, [...beforeLineIds, ...confirmedAddedLineIds, id]))
			return undefined
		const item = await readBounded(`走线 ${id} fresh get`, () => api.pcb_PrimitiveLine.get(id))
		if (!item || state(item, 'getState_PrimitiveId') !== id || state(item, 'getState_Net') !== line.net || state(item, 'getState_Layer') !== line.layer)
			throw new Error(`新走线 ${id} 身份、网络或层读回不匹配`)
		const actual: SesRouteLine = { id, net: state(item, 'getState_Net'), layer: state(item, 'getState_Layer'), widthMil: state(item, 'getState_LineWidth'), a: { x: state(item, 'getState_StartX'), y: state(item, 'getState_StartY') }, b: { x: state(item, 'getState_EndX'), y: state(item, 'getState_EndY') } }
		const check = verifySesImport({ ...plan, targetLines: [line], targetVias: [] }, { documentUuid: snapshot.documentUuid, lines: [actual], vias: [] })
		if (!check.verified) throw new Error(`新走线 ${id} 几何读回失败：${JSON.stringify(check.differences)}`)
		return actual
	}
	const verifyCreatedLinePrefix = (current: HostRouteSnapshot, lineCount: number, viaCount: number, currentLineIds: string[]) => {
		const beforeIds = new Set([...before.lines, ...before.vias, ...before.arcs].map(item => item.id))
		const addedLines = current.lines.filter(item => !beforeIds.has(item.id))
		const addedVias = current.vias.filter(item => !beforeIds.has(item.id))
		const addedArcs = current.arcs.filter(item => !beforeIds.has(item.id))
		if (addedArcs.length)
			throw new Error('新走线合并读回期间出现非预期圆弧')
		if (!lineIdSetsEqual(currentLineIds, [...beforeLineIds, ...addedLines.map(item => item.id)]))
			throw new Error('新走线合并读回期间LINE ID列表与完整源码/几何不一致')
		const confirmedViaIds = journal.writes
			.filter(item => item.kind === 'create-via' && item.confirmed && typeof item.candidateId === 'string')
			.map(item => item.candidateId as string)
			.sort()
		if (addedVias.map(item => item.id).sort().join('\0') !== confirmedViaIds.join('\0'))
			throw new Error('新走线合并读回期间新增过孔 ID 与已确认候选不一致')
		if (!geometrySame(before, {
			...current,
			lines: current.lines.filter(item => beforeIds.has(item.id)),
			vias: current.vias.filter(item => beforeIds.has(item.id)),
			arcs: current.arcs.filter(item => beforeIds.has(item.id)),
		}) || !verifySourceChanges(before, current, [], routeSourceRecords(current, [...addedLines, ...addedVias].map(item => item.id)).map(item => ({ type: item.type, id: item.id }))).verified)
			throw new Error('新走线合并读回期间原有路由或有效源码发生变化')
		const prefix: SesImportPlan = {
			...plan,
			targetLines: [...before.lines, ...plan.deltaLines.slice(0, lineCount)],
			targetVias: [...before.vias, ...plan.deltaVias.slice(0, viaCount)],
		}
		const semantic = verifySesImport(prefix, { documentUuid: current.documentUuid, lines: current.lines, vias: current.vias })
		if (!semantic.verified)
			throw new Error(`新走线候选 ID 消失，且本批完整前缀几何不等价：${JSON.stringify(semantic.differences)}`)
		return addedLines.map(item => item.id)
	}
	const readCreatedVia = async (via: SesRouteVia, id: string) => {
		const ids = await readBounded('过孔 ID 枚举', () => api.pcb_PrimitiveVia.getAllPrimitiveId())
		if (!Array.isArray(ids) || ids.some((value: unknown) => typeof value !== 'string') || !ids.includes(id))
			throw new Error(`新过孔 ${id} 未出现在完整 ID 列表`)
		const item = await readBounded(`过孔 ${id} fresh get`, () => api.pcb_PrimitiveVia.get(id))
		if (!item || state(item, 'getState_PrimitiveId') !== id || state(item, 'getState_Net') !== via.net)
			throw new Error(`新过孔 ${id} 身份或网络读回不匹配`)
		const actual: SesRouteVia = { id, net: state(item, 'getState_Net'), x: state(item, 'getState_X'), y: state(item, 'getState_Y'), diameterMil: state(item, 'getState_Diameter'), holeDiameterMil: state(item, 'getState_HoleDiameter'), viaType: state(item, 'getState_ViaType') }
		const check = verifySesImport({ ...plan, targetLines: [], targetVias: [via] }, { documentUuid: snapshot.documentUuid, lines: [], vias: [actual] })
		if (!check.verified) throw new Error(`新过孔 ${id} 几何读回失败：${JSON.stringify(check.differences)}`)
		return actual
	}
	const checkSnapshot = (planToVerify: SesImportPlan, current: HostRouteSnapshot, deletedIds: string[], addedIds: string[]) => {
		const semantic = verifySesImport(planToVerify, { documentUuid: current.documentUuid, lines: current.lines, vias: current.vias })
		if (!semantic.verified) throw new Error(`SES 路由几何未通过验证：${JSON.stringify(semantic.differences)}`)
		const source = verifySourceChanges(before, current, routeSourceRecords(before, deletedIds), routeSourceRecords(current, addedIds))
		if (!source.verified) throw new Error(`SES 路由源码改变超出计划：${JSON.stringify(source.differences)}`)
		return semantic
	}
	const addLines = async (write: TDocumentWrite, ids: string[]) => {
		for (const [index, line] of plan.deltaLines.entries()) {
			phase('create-line')
			const created = await recordWrite('create-line', () => api.pcb_PrimitiveLine.create(line.net, line.layer, line.a.x, line.a.y, line.b.x, line.b.y, line.widthMil), write, undefined, line)
			const id = state<unknown>(created, 'getState_PrimitiveId')
			if (typeof id !== 'string' || !id.trim()) throw new Error('新建走线未返回有效图元 ID')
			ids.push(id)
			journal.writes.at(-1)!.candidateId = id
			const actual = await readCreatedLine(line, id)
			if (!actual) {
				if (plan.mode !== 'append')
					throw new Error(`新走线 ${id} 未出现在完整 ID 列表`)
				phase('verify-merged-line-prefix')
				const current = await fresh()
				const currentLineIds = await readAllLineIds()
				const actualIds = verifyCreatedLinePrefix(current, index + 1, manualAppendViaFirst ? plan.deltaVias.length : 0, currentLineIds)
				if (!actualIds.length)
					throw new Error(`新走线 ${id} 未出现在完整 ID 列表，无法确认合并后的本批新线`)
				const beforeIds = new Set([...before.lines, ...before.vias, ...before.arcs].map(item => item.id))
				const viaIds = current.vias.filter(item => !beforeIds.has(item.id)).map(item => item.id)
				confirmedAddedLineIds.clear()
				for (const actualId of actualIds) confirmedAddedLineIds.add(actualId)
				ids.splice(0, ids.length, ...actualIds, ...viaIds)
				journal.writes.at(-1)!.mergeReadback = { candidateId: id, actualIds, confirmedLineCount: index + 1 }
			}
			else {
				confirmedAddedLineIds.add(id)
			}
			journal.writes.at(-1)!.confirmed = true
		}
	}
	const addVias = async (write: TDocumentWrite, ids: string[]) => {
		for (const via of plan.deltaVias) {
			phase('create-via')
			const created = await recordWrite('create-via', () => api.pcb_PrimitiveVia.create(via.net, via.x, via.y, via.holeDiameterMil, via.diameterMil), write, undefined, via)
			const id = state<unknown>(created, 'getState_PrimitiveId')
			if (typeof id !== 'string' || !id.trim()) throw new Error('新建过孔未返回有效图元 ID')
			ids.push(id)
			journal.writes.at(-1)!.candidateId = id
			await readCreatedVia(via, id)
			journal.writes.at(-1)!.confirmed = true
			if (manualAppendViaFirst) {
				phase('calculate-ratline')
				await focusGuard()
				const accepted = await recordWrite('calculate-ratline', () => api.pcb_Document.startCalculatingRatline(), write, undefined, { primitiveId: id, via })
				if (accepted !== true)
					throw new Error(`新过孔 ${id} 后的飞线重算请求未接受（startCalculatingRatline 返回 ${String(accepted)}）`)
				journal.writes.at(-1)!.confirmed = true
			}
		}
	}
	const deleteIds = async (kind: 'line' | 'via' | 'arc', ids: string[], write: TDocumentWrite) => {
		if (!ids.length) return
		deletionStarted = true
		phase(`delete-${kind}`)
		const apiObj = kind === 'line' ? api.pcb_PrimitiveLine : kind === 'via' ? api.pcb_PrimitiveVia : api.pcb_PrimitiveArc
		const result = await recordWrite(`delete-${kind}`, () => apiObj.delete(ids), write, ids)
		if (result !== true) throw new Error(`删除旧 ${kind} 返回 ${String(result)}`)
	}

	return {
		backend,
		journal,
		focusGuard,
		async apply(write) {
			const addedIds: string[] = []
			const deleteLineIds = plan.deleteLines.map(item => item.id).filter((id): id is string => Boolean(id))
			const deleteViaIds = plan.deleteVias.map(item => item.id).filter((id): id is string => Boolean(id))
			phase('apply-start')
			if (backend === 'native-ses' && (plan.deltaLines.length || plan.deltaVias.length)) {
				phase('native-import')
				const result = await recordWrite('native-ses-import', () => api.pcb_Document.importAutoRouteSesFile(options.file), write)
				if (result !== true) throw new Error(`官方 SES 导入返回 ${String(result)}`)
				const after = await fresh()
				const added = [...after.lines, ...after.vias].filter(item => !new Set([...before.lines, ...before.vias, ...before.arcs].map(old => old.id)).has(item.id)).map(item => item.id)
				addedIds.push(...added)
			}
			else {
				if (manualAppendViaFirst) {
					await addVias(write, addedIds)
					await addLines(write, addedIds)
				}
				else {
					await addLines(write, addedIds)
					await addVias(write, addedIds)
				}
			}
			const temporaryPlan: SesImportPlan = { ...plan, targetLines: [...before.lines, ...plan.deltaLines], targetVias: [...before.vias, ...plan.deltaVias] }
			phase('verify-temporary')
			let current = await fresh()
			if (backend === 'direct-primitives' && plan.mode === 'append') {
				const currentLineIds = await readAllLineIds()
				if (!lineIdSetsEqual(currentLineIds, [...beforeLineIds, ...confirmedAddedLineIds])) {
					const actualIds = verifyCreatedLinePrefix(current, plan.deltaLines.length, plan.deltaVias.length, currentLineIds)
					confirmedAddedLineIds.clear()
					for (const actualId of actualIds) confirmedAddedLineIds.add(actualId)
					const beforeIds = new Set([...before.lines, ...before.vias, ...before.arcs].map(item => item.id))
					const viaIds = current.vias.filter(item => !beforeIds.has(item.id)).map(item => item.id)
					addedIds.splice(0, addedIds.length, ...actualIds, ...viaIds)
					const lastLineWrite = [...journal.writes].reverse().find(entry => entry.kind === 'create-line' && entry.confirmed && typeof entry.candidateId === 'string')
					if (lastLineWrite)
						lastLineWrite.mergeReadback = { candidateId: String(lastLineWrite.candidateId), actualIds, confirmedLineCount: plan.deltaLines.length }
				}
			}
			let semantic = checkSnapshot(temporaryPlan, current, [], addedIds)
			if (deleteLineIds.length || deleteViaIds.length || options.deletedArcIds.length) {
				phase('delete-old-routes')
				await deleteIds('line', deleteLineIds, write)
				await deleteIds('via', deleteViaIds, write)
				await deleteIds('arc', options.deletedArcIds, write)
				current = await fresh()
				semantic = checkSnapshot(plan, current, [...deleteLineIds, ...deleteViaIds, ...options.deletedArcIds], addedIds)
			}
			for (const entry of journal.writes) if (entry.attempted && entry.settled) entry.confirmed = true
			phase('verified')
			return { result: semantic, cleared: { lines: deleteLineIds.length, vias: deleteViaIds.length, arcs: options.deletedArcIds.length } }
		},
		async recover({ operationError, write }) {
			recovering = true
			const details = () => ({ backend, phase: journal.phase, journal: JSON.parse(JSON.stringify(journal)), focusLost, sourceRestoreCalls: 0, operationError: operationError instanceof Error ? operationError.message : String(operationError) })
			if (focusLost || timedOut || writeAttemptCount !== writeSettledCount || journal.writes.some(item => item.attempted && item.settlement !== 'returned') || deletionStarted || remaining() <= 25)
				return { restored: false, cause: { ...details(), compensation: focusLost ? 'skipped-focus-lost' : 'skipped-unsettled-or-delete-started-or-budget' } }
			try {
				phase('recovery-read')
				const after = await fresh()
				const beforeIds = new Set([...before.lines, ...before.vias, ...before.arcs].map(item => item.id))
				const newLines = after.lines.filter(item => !beforeIds.has(item.id))
				const newVias = after.vias.filter(item => !beforeIds.has(item.id))
				const newArcs = after.arcs.filter(item => !beforeIds.has(item.id))
				if (newArcs.length)
					return { restored: false, cause: { ...details(), compensation: 'skipped-unknown-or-no-candidate' } }
				if (newLines.length + newVias.length === 0) {
					if (geometrySame(before, after) && sourceSame(before, after)) {
						phase('no-change-confirmed')
						return { restored: true, cause: { ...details(), noRecoveryWriteNeeded: true, compensation: 'no-change-confirmed' } }
					}
					return { restored: false, cause: { ...details(), compensation: 'skipped-unknown-or-no-candidate' } }
				}
				if (!geometrySame(before, { ...after, lines: after.lines.filter(item => beforeIds.has(item.id)), vias: after.vias.filter(item => beforeIds.has(item.id)), arcs: after.arcs.filter(item => beforeIds.has(item.id)) })
					|| !verifySourceChanges(before, after, [], routeSourceRecords(after, [...newLines, ...newVias].map(item => item.id))).verified)
					return { restored: false, cause: { ...details(), compensation: 'skipped-old-or-source-drift' } }
				const confirmedViaIds = journal.writes
					.filter(item => item.kind === 'create-via' && item.confirmed && typeof item.candidateId === 'string')
					.map(item => item.candidateId as string)
				const confirmedIds = new Set([...confirmedAddedLineIds, ...confirmedViaIds])
				if ([...newLines, ...newVias].some(item => !confirmedIds.has(item.id)))
					return { restored: false, cause: { ...details(), compensation: 'skipped-unrecognized-added-id' } }
				const lineIds = newLines.map(item => item.id)
				const viaIds = newVias.map(item => item.id)
			if (lineIds.length) {
				const deleted = await recordWrite('compensate-delete-lines', () => api.pcb_PrimitiveLine.delete(lineIds), write, lineIds)
				if (deleted !== true) throw new Error(`补偿删除新走线返回 ${String(deleted)}`)
			}
			if (viaIds.length) {
				const deleted = await recordWrite('compensate-delete-vias', () => api.pcb_PrimitiveVia.delete(viaIds), write, viaIds)
				if (deleted !== true) throw new Error(`补偿删除新过孔返回 ${String(deleted)}`)
			}
				const restored = await fresh()
				if (!geometrySame(before, restored) || !sourceSame(before, restored))
					return { restored: false, cause: { ...details(), compensation: 'delete-readback-mismatch' } }
				phase('compensated')
				return { restored: true, cause: { ...details(), noRecoveryWriteNeeded: false, compensation: 'exact-new-route-primitives-deleted', compensatedIds: [...lineIds, ...viaIds] } }
			}
			catch (error) {
				return { restored: false, cause: { ...details(), compensationError: error instanceof Error ? error.message : String(error) } }
			}
		},
	}
}
