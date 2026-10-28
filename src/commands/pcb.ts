/**
 * PCB 类指令
 *
 * 注意：PCB 坐标默认单位为 mil（与 PCB 编辑器内部一致，界面显示 mm 时注意换算，1mm ≈ 39.37mil）
 */
import type { ICommandDef } from '../engine/types'
import { repairDsnClassNetReferences } from '../engine/dsnExport'
import { applyDsnLayerWidthRules } from '../engine/dsnLayerWidths'
import { requireEda42 } from '../engine/edaVersion'
import { assertSnapshotFocused, captureDocumentSnapshot, withDocumentRecovery } from '../engine/documentRecovery'
import { widthForCurrent } from '../knowledge/rules'
import { blobToBase64, fileToResult } from './util'
import { beginTask, failTask, finishTask, taskProgress } from '../engine/tasks'
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'
import { importAndVerifyChanges } from '../engine/pcbImport'
import { applySesViaHoleDiameters, mapSesRoutes, parseAutoRouteSes, planSesImport, serializeSesSubset, verifySesImport, type SesImportPlan, type SesRouteExpected } from '../engine/autoRouteSes'
import { readRouteSnapshot, verifySourceChanges, type HostRouteSnapshot } from '../engine/autoRouteSesHost'
import { createSesRouteApplyContext } from '../engine/sesRouteApply'
import { prepareDsnWithPouredPlanes } from '../pcb/dsnPreparation'
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot'
import { prepareDsnWithSlotClearances } from '../pcb/dsnSlots'
import { prepareViaEndpointRefresh, refreshViaEndpointLines } from '../engine/viaEndpointRefresh'
import { buildRoutingWidthSnapshot, checkSesWidthRules, compareDsnWidthRules } from '../engine/routingWidthRules'
import { readEditorVersion } from '../pcb/pouredUnits'
import { assertSesRouteBaselineMatchesDsn, buildSesRouteBaseline, resolveSesArcCoverage, type SesRouteBaseline } from '../pcb/sesArcCoverage'

/** 0.10.42：给无保护 await 加超时（官方偶发永不 resolve，曾致整批删除挂死 300s 无结果） */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			p,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（>${ms / 1000}s，官方无响应）`)), ms) }),
		])
	}
	finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

async function buildWidthSnapshotFromEvidence(source: string, layers: unknown[] | undefined, netRules: unknown, editorVersion: string | null, unknowns: string[] = []) {
	const snapshot = buildRoutingWidthSnapshot({ source, layers, netRules, editorVersion: editorVersion ?? '' })
	snapshot.unknowns.push(...unknowns)
	if (unknowns.length)
		snapshot.globalStatus = 'unknown'
	return snapshot
}

async function readRoutingWidthEvidence(source: string | undefined, options: { timeoutMs: number, remainingMs?: () => number, reserveMs?: number, layers?: unknown[], readLayers?: boolean } ) {
	const unknowns: string[] = []
	let layers = options.layers
	let netRules: unknown
	const read = async <T>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
		try {
			const available = options.remainingMs ? Math.max(0, options.remainingMs() - (options.reserveMs ?? 0)) : options.timeoutMs
			if (available <= 0)
				throw new Error('本次线宽规则读取没有剩余时间预算')
			const budget = Math.min(options.timeoutMs, available)
			const actionPromise = Promise.resolve().then(action)
			return await withTimeout(actionPromise, budget, label)
		}
		catch (error) { unknowns.push(`${label} 未能读回：${String((error as any)?.message ?? error)}`); return undefined }
	}
	if (options.readLayers) {
		const value = await read('读取铜层', async () => eda.pcb_Layer.getAllLayers())
		layers = Array.isArray(value) ? value : undefined
		if (!Array.isArray(value)) unknowns.push('读取铜层未返回数组')
	}
	const getNetRules = eda.pcb_Drc?.getNetRules
	if (typeof getNetRules === 'function') {
		netRules = await read('读取网络规则', async () => getNetRules.call(eda.pcb_Drc))
		if (netRules === undefined) unknowns.push('网络规则读回不可用，网络规则匹配保持未知')
	}
	else unknowns.push('网络规则读取接口不可用，网络规则匹配保持未知')
	const snapshot = source === undefined
		? undefined
		: await buildWidthSnapshotFromEvidence(source, layers, netRules, readEditorVersion(eda), unknowns)
	return { snapshot, unknowns }
}

async function assertRoutingSourceStable(documentUuid: string, source: string | undefined, timeoutMs: number, label: string, remainingMs?: () => number): Promise<void> {
	const budget = () => {
		const remaining = Math.min(timeoutMs, remainingMs ? remainingMs() : timeoutMs)
		if (remaining <= 0) throw new Error(`${label}时间预算已耗尽`)
		return remaining
	}
	const focusBudget = budget()
	const focusPromise = Promise.resolve().then(() => eda.dmt_SelectControl.getCurrentDocumentInfo())
	const focus = await withTimeout(focusPromise, focusBudget, `${label}焦点复核`)
	if (focus?.documentType !== 3 || focus.uuid !== documentUuid)
		throw new Error(`${label}期间 PCB 焦点已变化（原文档=${documentUuid}，当前=${focus?.uuid ?? '未知'}）`)
	if (source === undefined) return
	const sourceBudget = budget()
	const sourcePromise = Promise.resolve().then(() => eda.sys_FileManager.getDocumentSource())
	const currentSource = await withTimeout(sourcePromise, sourceBudget, `${label}源码复核`)
	const comparison = comparePcbSourceSnapshots(source, currentSource)
	if (!comparison.matches)
		throw new Error(`${label}期间 PCB 源码快照已变化：${comparison.reason ?? '无法比较'}`)
}

function incompleteDsnWidthComparison(reason: string) {
	return { status: 'incomplete' as const, defaultRule: { status: 'unknown' as const }, nets: [], unknowns: [reason] }
}

function comparePreparedDsnWidth(snapshot: Awaited<ReturnType<typeof buildWidthSnapshotFromEvidence>> | undefined, dsnText: string, unknowns: string[] = []) {
	if (!snapshot)
		return incompleteDsnWidthComparison(unknowns.join('；') || 'PCB 源码快照不可用，无法比较 DSN 线宽规则')
	const comparison = compareDsnWidthRules(snapshot, dsnText)
	comparison.unknowns.push(...unknowns)
	if (unknowns.length)
		invalidateDsnWidthComparison(comparison, '线宽规则读回存在未知项，具体规则对照降级为unknown')
	return comparison
}

function invalidateDsnWidthComparison(comparison: ReturnType<typeof compareDsnWidthRules>, reason: string) {
	comparison.status = 'incomplete'
	comparison.unknowns = [...new Set([...comparison.unknowns, reason])]
	comparison.defaultRule = { status: 'unknown', ruleKey: comparison.defaultRule.ruleKey }
	comparison.nets = comparison.nets.map(entry => ({ net: entry.net, ruleKey: entry.ruleKey, status: 'unknown' }))
	return comparison
}

// ---------- FreeRouting 自动布线（REST 客户端 + 任务状态） ----------
const FR_API_BASE = 'http://127.0.0.1:37864/v1'
let currentRouteJobId: string | undefined
const routeJobDocumentUuids = new Map<string, string>()
const routeJobBaselines = new Map<string, SesRouteBaseline>()
/** 已完成回灌消费（或回灌已作废）的任务集合（0.10.65）：COMPLETED 任务的清线+导入只执行一次，
 *  任一步抛错也不允许重复轮询再进清线分支（旧版会叠加删除未锁定走线/重复导入） */
const consumedRouteJobs = new Set<string>()
const routeJobRecoveryState = new Map<string, 'applying' | 'applied' | 'recoveryRequired'>()

const ROUTE_SOURCE_TYPES = new Set(['LINE', 'VIA', 'ARC', 'TRACK'])
const MIN_ROUTE_SEGMENT_LENGTH_MIL = 1

function assertMinimumRouteSegmentLength(a: { x: number, y: number }, b: { x: number, y: number }, label: string): void {
	const lengthMil = Math.hypot(b.x - a.x, b.y - a.y)
	if (lengthMil < MIN_ROUTE_SEGMENT_LENGTH_MIL)
		throw new Error(`${label}长度 ${lengthMil} mil 小于最低允许 ${MIN_ROUTE_SEGMENT_LENGTH_MIL} mil`)
}

function decodeSesUtf8(encoded: string): string {
	let binary: string
	try { binary = atob(encoded) }
	catch (error) { throw new Error(`SES 输出不是有效 Base64：${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index)
	try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
	catch (error) { throw new Error('SES 输出不是有效 UTF-8 文本', { cause: error }) }
}

function sesSnapshot(snapshot: HostRouteSnapshot) {
	return { documentUuid: snapshot.documentUuid, lines: snapshot.lines, vias: snapshot.vias, source: snapshot.source }
}

function sesCommandDeadline(params: Record<string, any>): number {
	const requested = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
	if (!Number.isFinite(requested) || requested <= 0 || requested > 300_000)
		throw new Error('_timeoutMs 必须是大于 0 且不超过 300000ms 的有限数值')
	return Date.now() + requested
}

function sesRemaining(deadline: number): number {
	const remaining = deadline - Date.now()
	if (remaining <= 0)
		throw new Error('SES 自动布线总预算已耗尽，拒绝继续写入')
	return remaining
}

async function assertSesSnapshotWithinBudget(deadline: number, snapshot: Awaited<ReturnType<typeof captureDocumentSnapshot>>): Promise<void> {
	const remaining = sesRemaining(deadline)
	await withTimeout(assertSnapshotFocused(snapshot), remaining, 'SES 最终焦点/文档身份检查')
}

function syncSesApplyDiagnostic(diagnostic: any, context: Awaited<ReturnType<typeof createSesRouteApplyContext>>): void {
	diagnostic.backend = context.backend
	diagnostic.journal = JSON.parse(JSON.stringify(context.journal))
	const native = context.journal.writes.find(item => item.kind === 'native-ses-import')
	if (!native)
		return
	diagnostic.sdk = native.attempted
		? native.settlement === 'returned'
			? { attempted: true, returned: true, threw: false, result: native.result }
			: native.settlement === 'threw' || native.settlement === 'unsettled'
				? { attempted: true, returned: false, threw: native.settlement === 'threw' }
				: { attempted: true, returned: false, threw: false }
		: { attempted: false, returned: false, threw: false }
}

let sesDiagnosticSequence = 0
type SesDiagnostic = Record<string, unknown> & { ref: string, documentUuid: string, command: string, at: string, issues: string[] }
const SES_DIAGNOSTIC_BUDGET_MS = 500

async function sesDiagnosticPhase<T>(record: SesDiagnostic, phase: string, action: (active: () => boolean) => Promise<T>): Promise<{ state: 'done', value: T } | { state: 'error', error: unknown } | { state: 'timeout' }> {
	let active = true
	let timer: ReturnType<typeof setTimeout> | undefined
	const task = Promise.resolve().then(() => action(() => active)).then(
		value => ({ state: 'done' as const, value }),
		error => ({ state: 'error' as const, error }),
	)
	const timed = new Promise<{ state: 'timeout' }>((resolve) => {
		timer = setTimeout(() => { active = false; resolve({ state: 'timeout' }) }, SES_DIAGNOSTIC_BUDGET_MS)
	})
	const result = await Promise.race([task, timed])
	if (timer)
		clearTimeout(timer)
	if (result.state === 'timeout')
		record.issues.push(`${phase}-timeout: exceeded ${SES_DIAGNOSTIC_BUDGET_MS}ms; later work in this phase was cancelled`)
	else if (result.state === 'error')
		record.issues.push(`${phase}-unavailable: ${result.error instanceof Error ? result.error.message : String(result.error)}`)
	return result
}

function createSesDiagnostic(command: string, documentUuid: string): SesDiagnostic {
	return {
		ref: `ses-diagnostic-${Date.now()}-${++sesDiagnosticSequence}`,
		command,
		documentUuid,
		at: new Date().toISOString(),
		issues: [],
		sdk: { attempted: false, returned: false, threw: false },
	}
}

async function attachSesInputDiagnostic(record: SesDiagnostic, file: File): Promise<void> {
	const textPhase = await sesDiagnosticPhase(record, 'sdk-input-text', async active => {
		const text = await file.text()
		if (!active())
			return undefined
		return text
	})
	if (textPhase.state !== 'done' || typeof textPhase.value !== 'string')
		return
	const text = textPhase.value
	const bytes = new TextEncoder().encode(text)
	record.sdkInput = { text, utf8Bytes: bytes.byteLength }
	const hashPhase = await sesDiagnosticPhase(record, 'sdk-input-hash', async active => {
		const cryptoApi = globalThis.crypto
		if (!cryptoApi?.subtle)
			throw new Error('Web Crypto subtle.digest 不可用')
		const digest = await cryptoApi.subtle.digest('SHA-256', bytes)
		if (!active())
			return undefined
		return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
	})
	if (hashPhase.state === 'done' && hashPhase.value)
		record.sdkInputHash = hashPhase.value
}

async function captureSesDiagnosticEvidence(record: SesDiagnostic, phase: 'beforeRecovery' | 'afterRecovery', snapshot: Awaited<ReturnType<typeof captureDocumentSnapshot>>): Promise<void> {
	const evidence: Record<string, unknown> = { capturedAt: new Date().toISOString() }
	const sourceResult = await sesDiagnosticPhase(record, `${phase}-source`, async active => {
		await assertSnapshotFocused(snapshot)
		if (!active())
			return undefined
		const source = await eda.sys_FileManager.getDocumentSource()
		if (!active())
			return undefined
		await assertSnapshotFocused(snapshot)
		if (!active())
			return undefined
		if (typeof source !== 'string' || !source.trim())
			throw new Error('document source unavailable or empty')
		return source
	})
	if (sourceResult.state === 'done' && typeof sourceResult.value === 'string') {
		evidence.source = sourceResult.value
		evidence.sourceUtf8Bytes = new TextEncoder().encode(sourceResult.value).byteLength
	}
	else if (sourceResult.state === 'timeout')
		evidence.sourceUnavailable = 'diagnostic phase timed out; route snapshot read was not started'
	else if (sourceResult.state === 'error')
		evidence.sourceUnavailable = sourceResult.error instanceof Error ? sourceResult.error.message : String(sourceResult.error)
	if (sourceResult.state !== 'timeout') {
		const routeResult = await sesDiagnosticPhase(record, `${phase}-routes`, async active => {
			const routes = await readRouteSnapshot(eda, async () => {
				if (!active())
					throw new Error('diagnostic phase expired; stopped before next host read')
				await assertSnapshotFocused(snapshot)
				if (!active())
					throw new Error('diagnostic phase expired; stopped before next host read')
			}, typeof evidence.source === 'string' ? evidence.source : undefined)
			if (!active())
				return undefined
			return { documentUuid: routes.documentUuid, lines: routes.lines, vias: routes.vias, arcs: routes.arcs }
		})
		if (routeResult.state === 'done' && routeResult.value)
			evidence.routeSnapshot = routeResult.value
		else if (routeResult.state === 'error')
			evidence.routeSnapshotUnavailable = routeResult.error instanceof Error ? routeResult.error.message : String(routeResult.error)
		else if (routeResult.state === 'timeout')
			evidence.routeSnapshotUnavailable = 'diagnostic phase timed out; later host reads stopped'
	}
	if (evidence.sourceUnavailable)
		record.issues.push(`${phase}-source-unavailable: ${String(evidence.sourceUnavailable)}`)
	if (evidence.routeSnapshotUnavailable)
		record.issues.push(`${phase}-route-snapshot-unavailable: ${String(evidence.routeSnapshotUnavailable)}`)
	record[phase] = evidence
}

async function persistSesDiagnostic(record: SesDiagnostic, stage: 'beforeRecovery' | 'afterRecovery'): Promise<{ ref: string, available: boolean, persisted: boolean, storageKey: string, issues: string[], record: SesDiagnostic }> {
	const key = `ses-failure-diagnostic:${record.documentUuid}:${record.ref}:${stage}`
	record.storageKey = key
	record.storageKeys = [...((record.storageKeys as string[] | undefined) ?? []), key]
	let text: string
	try { text = JSON.stringify(record) }
	catch (error) {
		record.issues.push(`${stage}-storage-unavailable: diagnostic serialization failed: ${error instanceof Error ? error.message : String(error)}`)
		return { ref: record.ref, available: true, persisted: false, storageKey: key, issues: [...record.issues], record }
	}
	const phase = await sesDiagnosticPhase(record, `${stage}-storage`, async active => {
		const savedOk = await eda.sys_Storage.setExtensionUserConfig(key, text)
		if (!active())
			return { persisted: false, reason: 'storage write completed after diagnostic timeout' }
		if (savedOk !== true)
			throw new Error('diagnostic storage write returned false')
		const saved = await eda.sys_Storage.getExtensionUserConfig(key)
		if (!active())
			return { persisted: false, reason: 'storage readback completed after diagnostic timeout' }
		if (saved !== text)
			throw new Error('diagnostic storage readback mismatch')
		return { persisted: true }
	})
	const persisted = phase.state === 'done' && phase.value.persisted === true
	if (!persisted && phase.state === 'error')
		record.issues.push(`${stage}-storage-unavailable: ${phase.error instanceof Error ? phase.error.message : String(phase.error)}`)
	return { ref: record.ref, available: true, persisted, storageKey: key, issues: [...record.issues], record }
}

function withSesDiagnostic(error: unknown, diagnostic: { ref: string, available: boolean, issues: string[] }): unknown {
	if (error && typeof error === 'object') {
		const cause = (error as any).cause
		if (cause && typeof cause === 'object' && Object.isExtensible(cause)) {
			try { Object.assign(cause, { sesDiagnostic: diagnostic }); return error }
			catch { /* Preserve the original cause in the wrapper below. */ }
		}
		if ((error as any) instanceof Error) {
			const copiedCause = cause && typeof cause === 'object' ? { ...cause, sesDiagnostic: diagnostic } : { sesDiagnostic: diagnostic }
			const wrapped = new Error((error as Error).message, { cause: copiedCause })
			wrapped.name = (error as Error).name
			Object.assign(wrapped, error)
			Object.defineProperty(wrapped, 'cause', { value: copiedCause, configurable: true, writable: true })
			return wrapped
		}
	}
	return error
}

function routeSourceRecord(snapshot: HostRouteSnapshot, id: string) {
	const matches = snapshot.sourceRecords.filter(record => record.id === id && ROUTE_SOURCE_TYPES.has(record.type))
	if (matches.length !== 1)
		throw new Error(`路由图元 ${id} 在有效 PCB 源码中对应 ${matches.length} 条路由记录`)
	return { type: matches[0].type, id: matches[0].id }
}

function sourceRouteDelta(
	before: HostRouteSnapshot,
	after: HostRouteSnapshot,
	deletedIds: string[],
): { verified: boolean, differences: Array<Record<string, unknown>> } {
	const beforeIds = new Set([...before.lines, ...before.vias, ...before.arcs].map(item => item.id))
	const afterIds = new Set([...after.lines, ...after.vias, ...after.arcs].map(item => item.id))
	const newArcs = after.arcs.filter(item => !beforeIds.has(item.id))
	if (newArcs.length)
		return { verified: false, differences: newArcs.map(item => ({ code: 'unexpectedArcAdded', id: item.id })) }
	const deleted = deletedIds.map(id => routeSourceRecord(before, id))
	const added = [...after.lines, ...after.vias]
		.filter(item => !beforeIds.has(item.id))
		.map(item => routeSourceRecord(after, item.id))
	return verifySourceChanges(before, after, deleted, added)
}

function requireRouteVerification(plan: SesImportPlan, after: HostRouteSnapshot, beforeSource: HostRouteSnapshot, deletedIds: string[]) {
	const semantic = verifySesImport(plan, sesSnapshot(after))
	if (!semantic.verified)
		throw new Error(`SES 路由几何读回不匹配：${JSON.stringify(semantic.differences)}`)
	const source = sourceRouteDelta(beforeSource, after, deletedIds)
	if (!source.verified)
		throw new Error(`SES 导入改变了计划外 PCB 源码记录：${JSON.stringify(source.differences)}`)
	return semantic
}

function requireClearedSnapshot(before: HostRouteSnapshot, after: HostRouteSnapshot, plan: SesImportPlan, deletedArcIds: string[]) {
	const actualLines = new Map(after.lines.map(item => [item.id, item]))
	const actualVias = new Map(after.vias.map(item => [item.id, item]))
	for (const item of plan.deleteLines) {
		if (!item.id || actualLines.has(item.id))
			throw new Error(`未锁定走线 ${item.id ?? '<missing-id>'} 清理后仍存在`)
	}
	for (const item of plan.deleteVias) {
		if (!item.id || actualVias.has(item.id))
			throw new Error(`未锁定过孔 ${item.id ?? '<missing-id>'} 清理后仍存在`)
	}
	for (const item of plan.retainedLines) {
		if (!item.id || !actualLines.has(item.id) || JSON.stringify(actualLines.get(item.id)) !== JSON.stringify(item))
			throw new Error(`保留走线 ${item.id ?? '<missing-id>'} 清理后缺失或属性变化`)
	}
	for (const item of plan.retainedVias) {
		if (!item.id || !actualVias.has(item.id) || JSON.stringify(actualVias.get(item.id)) !== JSON.stringify(item))
			throw new Error(`保留过孔 ${item.id ?? '<missing-id>'} 清理后缺失或属性变化`)
	}
	const afterArcIds = new Set(after.arcs.map(item => item.id))
	for (const item of before.arcs) {
		if (deletedArcIds.includes(item.id) ? afterArcIds.has(item.id) : !afterArcIds.has(item.id))
			throw new Error(`圆弧 ${item.id} 清理后状态与 SDK 锁定计划不符`)
	}
	const source = sourceRouteDelta(before, after, [...plan.deleteLines, ...plan.deleteVias].flatMap(item => item.id ? [item.id] : []).concat(deletedArcIds))
	if (!source.verified)
		throw new Error(`清理阶段改变了计划外 PCB 源码记录：${JSON.stringify(source.differences)}`)
}

/** FreeRouting REST 请求（走 eda.sys_ClientUrl 绕开扩展网络限制，与官方集成扩展同款） */
async function frRequest<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {
		'Freerouting-Environment-Host': 'EasyEDA/3.2',
		'Freerouting-Profile-ID': '4c11cc11-75b4-4eaa-96b8-95a71d3611ef',
	}
	if (body)
		headers['Content-Type'] = 'application/json'
	const res = await (eda.sys_ClientUrl as any).request(
		`${FR_API_BASE}${path}`, method, body ? JSON.stringify(body) : undefined, { headers },
	)
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`FreeRouting API ${method} ${path} 失败（${res.status}）：${text}`)
	}
	if (res.status === 204)
		return undefined as T
	return res.json() as Promise<T>
}

function safeState<T>(obj: any, method: string): T | undefined {
	try {
		const fn = obj?.[method]
		if (typeof fn === 'function')
			return fn.call(obj) as T
	}
	catch {
		// 忽略不支持的状态读取
	}
	return undefined
}

function sameRoundtripNumber(a: unknown, b: number): boolean {
	if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b))
		return false
	const tolerance = Math.min(1e-9, 4 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)))
	return Math.abs(a - b) <= tolerance
}

function heatWeldingReadback(pad: any): Record<string, unknown> {
	const rawFieldNames = ['connectionMethod', 'divergenceSpacing', 'divergenceLineWidth', 'divergenceAngle'] as const
	const safeMessage = (error: unknown) => {
		let message = '读取异常'
		try {
			if (error instanceof Error && typeof error.message === 'string')
				message = error.message
			else if (typeof error === 'string')
				message = error
			else if (error && (typeof error === 'object' || typeof error === 'function')) {
				const candidate = (error as any).message
				if (typeof candidate === 'string')
					message = candidate
			}
		}
		catch { /* Keep a safe generic message when the thrown value is hostile. */ }
		return message
	}
	const exceptionResult = (error: unknown) => {
		return { status: 'exception', error: { message: safeMessage(error) } }
	}
	const readRawFields = (value: unknown) => {
		const values: Record<string, unknown> = {}
		const evidence: Record<string, unknown> = {}
		for (const key of rawFieldNames) {
			let field: unknown
			try {
				field = value !== null && (typeof value === 'object' || typeof value === 'function')
					? (value as any)[key]
					: undefined
				values[key] = field
			}
			catch (error) {
				const message = safeMessage(error)
				values[key] = undefined
				evidence[key] = { status: 'exception', type: 'exception', error: { message } }
				continue
			}
			if (field === undefined) evidence[key] = { status: 'undefined', type: 'undefined' }
			else if (field === null || typeof field === 'string' || typeof field === 'boolean') evidence[key] = { status: 'value', type: typeof field, value: field }
			else if (typeof field === 'number') evidence[key] = Number.isFinite(field)
				? { status: 'value', type: 'number', value: field }
				: { status: 'value', type: 'number', finite: false }
			else evidence[key] = { status: 'value', type: typeof field }
		}
		return { values, evidence }
	}
	let getter: unknown
	try { getter = pad?.getState_HeatWelding }
	catch (error) { return exceptionResult(error) }
	if (typeof getter !== 'function')
		return { status: 'unavailable' }
	let raw: unknown
	try { raw = getter.call(pad) }
	catch (error) { return exceptionResult(error) }
	if (raw === null)
		return { status: 'null', value: null }
	const returnedType = raw === undefined ? 'undefined' : Array.isArray(raw) ? 'array' : typeof raw
	const fields = readRawFields(raw)
	const invalid = (reason: string) => ({ status: 'invalid', returnedType, reason, rawFields: fields.evidence })
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return invalid(raw === undefined ? '读取接口返回 undefined' : '读取接口应返回 null 或配置对象')
	const connectionMethodEvidence = fields.evidence.connectionMethod as { status?: string, error?: { message?: string } } | undefined
	if (connectionMethodEvidence?.status === 'exception')
		return { status: 'exception', error: { message: connectionMethodEvidence.error?.message ?? '读取异常' } }
	const connectionMethod = fields.values.connectionMethod
	if (connectionMethod !== 'Divergent' && connectionMethod !== 'Direct-connected' && connectionMethod !== 'Non-connected')
		return invalid('connectionMethod 不是已知 SDK 枚举值')
	const result: Record<string, unknown> = { connectionMethod }
	for (const key of rawFieldNames.slice(1)) {
		const fieldEvidence = fields.evidence[key] as { status?: string, error?: { message?: string } } | undefined
		if (fieldEvidence?.status === 'exception')
			return { status: 'exception', error: { message: fieldEvidence.error?.message ?? '读取异常' } }
		const field = fields.values[key]
		if (field === undefined)
			continue
		if (typeof field !== 'number' || !Number.isFinite(field))
			return invalid(`${key} 必须是有限数值`)
		result[key] = field
	}
	return { status: 'config', value: result }
}

function projectPadDirectValue(value: unknown, path: string, seen = new Set<object>()): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new Error(`${path} 含非有限数值`)
		return value
	}
	if (Array.isArray(value)) {
		if (seen.has(value))
			throw new Error(`${path} 含循环引用`)
		seen.add(value)
		const result = value.map((item, index) => projectPadDirectValue(item, `${path}[${index}]`, seen))
		seen.delete(value)
		return result
	}
	if (typeof value === 'object' && value) {
		if (seen.has(value))
			throw new Error(`${path} 含循环引用`)
		seen.add(value)
		const result: Record<string, unknown> = {}
		for (const key of Object.keys(value)) {
			const item = (value as Record<string, unknown>)[key]
			if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || item === undefined)
				throw new Error(`${path}.${key} 不是可安全读取的数据字段`)
			result[key] = projectPadDirectValue(item, `${path}.${key}`, seen)
		}
		seen.delete(value)
		return result
	}
	throw new Error(`${path} 返回了不可安全投影的值`)
}

function padDirectErrorMessage(error: unknown): string {
	try {
		if (error instanceof Error && typeof error.message === 'string')
			return error.message
		if (typeof error === 'string')
			return error
		if (error && (typeof error === 'object' || typeof error === 'function')) {
			const message = (error as { message?: unknown }).message
			if (typeof message === 'string')
				return message
		}
	}
	catch { /* hostile thrown values use a safe fallback */ }
	return 'SDK operation failed with an unreadable error value'
}

function readPadDirectGetter(pad: any, method: string): unknown {
	let getter: unknown
	try { getter = pad?.[method] }
	catch (error) { throw new Error(`${method} getter 访问异常：${padDirectErrorMessage(error)}`) }
	if (typeof getter !== 'function')
		throw new Error(`焊盘缺少必需 getter ${method}`)
	let value: unknown
	try { value = getter.call(pad) }
	catch (error) { throw new Error(`${method} 读取异常：${padDirectErrorMessage(error)}`) }
	return value
}

function readPadDirectSample(pad: any): Record<string, unknown> {
	const parentComponentId = readPadDirectGetter(pad, 'getState_ParentComponentPrimitiveId')
	const primitiveId = readPadDirectGetter(pad, 'getState_PrimitiveId')
	const padNumber = readPadDirectGetter(pad, 'getState_PadNumber')
	if (typeof parentComponentId !== 'string' || !parentComponentId.trim() || typeof primitiveId !== 'string' || !primitiveId.trim() || typeof padNumber !== 'string')
		throw new Error('焊盘身份 getter 返回了无效数据')
	const fields: Array<[string, string]> = [
		['net', 'getState_Net'], ['layer', 'getState_Layer'], ['x', 'getState_X'], ['y', 'getState_Y'],
		['rotation', 'getState_Rotation'], ['shape', 'getState_Pad'], ['hole', 'getState_Hole'],
		['holeOffsetX', 'getState_HoleOffsetX'], ['holeOffsetY', 'getState_HoleOffsetY'],
		['holeRotation', 'getState_HoleRotation'], ['primitiveLock', 'getState_PrimitiveLock'],
	]
	const sample: Record<string, unknown> = { primitiveId, parentComponentId, padNumber }
	for (const [key, method] of fields) {
		const value = readPadDirectGetter(pad, method)
		if (value === undefined && method !== 'getState_Net' && method !== 'getState_Pad')
			throw new Error(`${method} 返回 undefined，无法建立写前样本`)
		sample[key] = value === undefined ? { status: 'undefined' } : projectPadDirectValue(value, method)
	}
	const heatWelding = readPadDirectGetter(pad, 'getState_HeatWelding')
	if (heatWelding !== null && (!heatWelding || typeof heatWelding !== 'object' || Array.isArray(heatWelding)))
		throw new Error('getState_HeatWelding 返回了非法数据')
	if (heatWelding !== null) {
		const method = readPadDirectValueField(heatWelding as Record<string, unknown>, 'connectionMethod')
		if (method !== 'Divergent' && method !== 'Direct-connected' && method !== 'Non-connected')
			throw new Error('getState_HeatWelding.connectionMethod 不是已知 SDK 枚举值')
		const projected: Record<string, unknown> = { connectionMethod: method }
		for (const key of ['divergenceSpacing', 'divergenceLineWidth', 'divergenceAngle']) {
			const value = readPadDirectOptionalValueField(heatWelding as Record<string, unknown>, key)
			if (value !== undefined) {
				if (typeof value !== 'number' || !Number.isFinite(value))
					throw new Error(`getState_HeatWelding.${key} 必须是有限数值`)
				projected[key] = value
			}
		}
		sample.heatWelding = projected
	}
	else
		sample.heatWelding = null
	return sample
}

function readPadDirectValueField(value: Record<string, unknown>, key: string): unknown {
	return readPadDirectOptionalValueField(value, key)
}

function readPadDirectOptionalValueField(value: Record<string, unknown>, key: string): unknown {
	try { return value[key] }
	catch (error) { throw new Error(`热焊配置字段 ${key} 读取异常：${padDirectErrorMessage(error)}`) }
}

function padDirectSourceSnapshot(source: unknown, expectedUuid: string) {
	if (typeof source !== 'string' || !source.trim())
		throw new Error('getDocumentSource 返回空或非法 PCB 源码')
	const doc = parseSourceLog(source)
	if (doc.docType !== 'PCB' || doc.uuid !== expectedUuid)
		throw new Error(`PCB 源码身份不符（docType=${doc.docType}, 源码 UUID=${doc.uuid}, 请求 UUID=${expectedUuid}）`)
	return snapshotEffectiveSourceRecords(doc)
}

function padDirectSourceDiff(before: Array<[string, unknown]>, after: Array<[string, unknown]>) {
	const diff = diffSourceRecordSnapshots(before, after)
	const beforeMap = new Map(before)
	const afterMap = new Map(after)
	const decode = (key: string) => {
		const [type, id] = key.split('\u0000')
		return { type, id }
	}
	return {
		added: diff.added.map(key => ({ ...decode(key), after: afterMap.get(key) })),
		removed: diff.removed.map(key => ({ ...decode(key), before: beforeMap.get(key) })),
		changed: diff.changed.map(item => ({ ...decode(item.key), before: item.before, after: item.after })),
	}
}

function normalizeSourceData(value: unknown): unknown {
	if (Array.isArray(value))
		return value.map(normalizeSourceData)
	if (value && typeof value === 'object') {
		const object = value as Record<string, unknown>
		return Object.fromEntries(Object.keys(object).sort().map(key => [key, normalizeSourceData(object[key])]))
	}
	return value
}

function snapshotEffectiveSourceRecords(doc: ReturnType<typeof parseSourceLog>, type?: string, excludedPourId?: string): Array<[string, unknown]> {
	return Array.from(resolveRecords(doc, type).entries())
		.filter(([key]) => !(excludedPourId && key === `POUR\u0000${excludedPourId}`))
		.map(([key, record]): [string, unknown] => [key, normalizeSourceData(record.data)])
		.sort(([a], [b]) => a.localeCompare(b))
}

function diffSourceRecordSnapshots(before: Array<[string, unknown]>, after: Array<[string, unknown]>) {
	const beforeMap = new Map(before)
	const afterMap = new Map(after)
	return {
		added: after.filter(([key]) => !beforeMap.has(key)).map(([key]) => key),
		removed: before.filter(([key]) => !afterMap.has(key)).map(([key]) => key),
		changed: before.filter(([key, data]) => afterMap.has(key) && JSON.stringify(data) !== JSON.stringify(afterMap.get(key)))
			.map(([key, beforeData]) => ({ key, before: beforeData, after: afterMap.get(key) })),
	}
}

/** Convert CSS-style hexadecimal input to the RGBA object required by the SDK. */
function parsePcbColor(value: unknown): { r: number, g: number, b: number, alpha: number } {
	const input = String(value).trim()
	const match = /^#?([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(input)
	if (!match)
		throw new Error(`颜色格式无效：${input}（请使用 #RGB、#RGBA、#RRGGBB 或 #RRGGBBAA）`)
	let hex = match[1]
	if (hex.length === 3 || hex.length === 4)
		hex = [...hex].map(char => char + char).join('')
	const hasAlpha = hex.length === 8
	const channels = hex.match(/.{2}/g)!.map(channel => Number.parseInt(channel, 16))
	return {
		r: channels[0],
		g: channels[1],
		b: channels[2],
		alpha: hasAlpha ? channels[3] / 255 : 1,
	}
}

function parseFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
		throw new Error(`${label} 必须是有限数字`)
	const number = Number(value)
	if (!Number.isFinite(number))
		throw new Error(`${label} 必须是有限数字`)
	return number
}

/**
 * 0.10.24（P10 实锤：官方 modify 对多字段合并修改可能整体失效，拆单步各自成功）——
 * 把多字段修改请求拆成单字段/单类别步骤顺序执行，返回是否有任一步返回真（假失败不轻信，由调用方读回裁决）
 */
async function modifyInSteps(modifyFn: (props: Record<string, any>) => Promise<any>, steps: Array<Record<string, any>>): Promise<boolean> {
	let okAny = false
	for (const s of steps) {
		if (!Object.keys(s).length)
			continue
		try {
			if (await modifyFn(s))
				okAny = true
		}
		catch { /* 假失败不轻信，读回为准 */ }
	}
	return okAny
}

/**
 * 读回核对：对读回图元逐项比对（num 容差 0.5 / str 全等 / bool 全等），返回 readback 明细与整体 verified
 */
function verifyReadback(back: any, checks: Array<[string, string, any, 'num' | 'str' | 'bool']>): { readback: Record<string, unknown>, verified: boolean } {
	const readback: Record<string, unknown> = {}
	let verified = Boolean(back)
	for (const [field, getter, want, kind] of checks) {
		const actual = back ? safeState<any>(back, getter) : undefined
		readback[field] = actual ?? null
		if (actual == null) {
			verified = false
			continue
		}
		if (kind === 'num' && Math.abs(Number(actual) - Number(want)) > 0.5)
			verified = false
		if (kind === 'str' && String(actual) !== String(want))
			verified = false
		if (kind === 'bool' && Boolean(actual) !== Boolean(want))
			verified = false
	}
	return { readback, verified }
}

/**
 * 从多边形源数组解析包围盒（discretize 在扩展环境抛 "Not implemented"，用源数组解析替代）。
 * 源格式：['R', x, y(左上角), w, h, ...] / ['CIRCLE'|'C', cx, cy, r] / ['L', x1, y1, x2, y2] / ['ARC'|'CARC', ...]。
 * 坐标系 +Y 向上：'R' 的 y 是上沿，矩形向下延伸 h。
 */
function bboxFromPolygonSource(src: Array<unknown>): { x1: number, y1: number, x2: number, y2: number } | undefined {
	if (!Array.isArray(src))
		return undefined
	let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
	const addPt = (x: number, y: number) => {
		if (!Number.isFinite(x) || !Number.isFinite(y))
			return
		x1 = Math.min(x1, x); y1 = Math.min(y1, y)
		x2 = Math.max(x2, x); y2 = Math.max(y2, y)
	}
	let i = 0
	while (i < src.length) {
		const tok = src[i]
		if (tok === 'R') {
			const x = Number(src[i + 1]), y = Number(src[i + 2]), w = Number(src[i + 3]), h = Number(src[i + 4])
			addPt(x, y); addPt(x + w, y - h)
			i += 7 // R 源格式固定 7 元素（含两个保留位）
		}
		else if (tok === 'CIRCLE' || tok === 'C') {
			const cx = Number(src[i + 1]), cy = Number(src[i + 2]), r = Number(src[i + 3])
			addPt(cx - r, cy - r); addPt(cx + r, cy + r)
			i += 4
		}
		else if (tok === 'L') {
			addPt(Number(src[i + 1]), Number(src[i + 2]))
			addPt(Number(src[i + 3]), Number(src[i + 4]))
			i += 5
		}
		else if (typeof tok === 'string') {
			// ARC/CARC/未知标记：跳到下一个字符串标记
			i++
			while (i < src.length && typeof src[i] !== 'string')
				i++
		}
		else
			i++
	}
	return Number.isFinite(x1) ? { x1, y1, x2, y2 } : undefined
}

/** 合法层取值说明（报错时列出，0.10.39 起绝不静默回退） */
const LAYER_HELP = 'top(1)/bottom(2)/top-silk(3)/bottom-silk(4)/top-mask(5)/bottom-mask(6)/top-paste(7)/bottom-paste(8)/top-assembly(9)/bottom-assembly(10)/outline(11)/multi(12)/document(13)/mechanical(14)/inner1~inner32(15~46)/custom1~custom200(71~270)，或直接传层号数字（含数字字符串如 "13"）'

/**
 * 层名 → 层 ID（顶层 1 / 底层 2，允许数字或数字字符串）。
 * 0.10.39：不认识的层名/层号直接报错，绝不静默回退。
 * 0.10.43：未传 layer（undefined/null/空串）恢复缺省顶层 1——0.10.39 的改写把缺省情况一并丢进了
 * 报错分支，导致 routeTrack/pourCopper 等文档声明「默认 top」的指令省略 layer 即被拒（GPT 反馈 R2）。
 */
function resolveLayer(layer: string | number | undefined): number {
	if (layer == null || (typeof layer === 'string' && !layer.trim()))
		return 1
	return resolveLayerEx(layer, 1)
}

/**
 * 宽层名解析：top/bottom/top-silk/bottom-silk/top-mask/bottom-mask/top-paste/bottom-paste/
 * top-assembly/bottom-assembly/outline/multi/document/mechanical/inner<N>/custom<N> 或直接数字层 ID
 * （含数字字符串 "13"）。dflt 为缺省层（仅在 layer 未传时生效）。
 * 0.10.39：传了但不认识一律报错（旧版静默回退 dflt 曾把 layer:"13" 放到层 3 还报成功）。
 */
function resolveLayerEx(layer: string | number | undefined, dflt: number): number {
	if (layer == null)
		return dflt
	if (typeof layer === 'number' && Number.isFinite(layer))
		return layer
	const s = String(layer).trim().toLowerCase().replace(/[_\s]/g, '-')
	if (/^\d+$/.test(s))
		return Number(s)
	const map: Record<string, number> = {
		'top': 1, 't': 1, 'bottom': 2, 'b': 2,
		'top-silk': 3, 'bottom-silk': 4, 'top-silkscreen': 3, 'bottom-silkscreen': 4,
		'top-mask': 5, 'bottom-mask': 6, 'top-solder-mask': 5, 'bottom-solder-mask': 6,
		'top-paste': 7, 'bottom-paste': 8, 'top-paste-mask': 7, 'bottom-paste-mask': 8,
		'top-assembly': 9, 'bottom-assembly': 10,
		'outline': 11, 'board-outline': 11, 'multi': 12, 'multi-layer': 12,
		'document': 13, 'doc': 13, 'mechanical': 14,
	}
	if (map[s] != null)
		return map[s]
	const m = /^(inner|custom)-?(\d+)$/.exec(s)
	if (m)
		return m[1] === 'inner' ? 14 + Number(m[2]) : 70 + Number(m[2])
	throw new Error(`不认识的层 "${layer}"——0.10.39 起不再静默回退到缺省层 ${dflt}。合法取值：${LAYER_HELP}`)
}

const TERMINAL_ROUTE_STATES = new Set(['COMPLETED', 'CANCELLED', 'CANCELED', 'FAILED', 'ABORTED', 'ERROR'])

function isTerminalRouteState(state: unknown): boolean {
	return typeof state === 'string' && TERMINAL_ROUTE_STATES.has(state.trim().toUpperCase())
}

function releaseCurrentRouteJob(jobId: string): void {
	if (currentRouteJobId === jobId)
		currentRouteJobId = undefined
}

/**
 * 校验网络在当前 PCB 中存在。
 * 官方 API 对不存在的网络只给模糊报错（"可能是传入的参数不正确"），这里提前拦截并给出可操作提示。
 */
async function ensureNetExists(net: string): Promise<void> {
	let nets: Array<string> = []
	try {
		nets = (await eda.pcb_Net.getAllNetsName()) ?? []
	}
	catch {
		// 读不到网络列表时不拦截，交给创建接口自己报错
		return
	}
	if (!nets.includes(net))
		throw new Error(
			`网络 "${net}" 在当前 PCB 中不存在（现有 ${nets.length} 个网络${nets.length ? ': ' + nets.slice(0, 10).join(', ') + (nets.length > 10 ? '…' : '') : ''}）。`
			+ '请先确认原理图中该网络已连接并从原理图导入（pcb.importChanges），或检查网络名拼写',
		)
}

/**
 * 包装官方创建类错误：官方报错"可能是传入的参数不正确"具有误导性，
 * 实测参数正确时也会因 PCB 文档未在界面中打开渲染而失败，这里补充排查指引。
 */
function wrapCreateError(what: string, err: unknown): Error {
	const msg = err instanceof Error ? err.message : String(err)
	return new Error(
		`${what}失败：${msg}。排查顺序：1) 网络是否已存在于 PCB（pcb.listNets）；`
		+ '2) 是否已激活 PCB 文档（editor.openDocument）；3) 该 PCB 是否已在 EDA 界面中打开过一次（全新 PCB 未渲染时官方 API 会拒绝创建）',
	)
}

export async function executeRouteTrack(params: Record<string, any>, shared?: { documentUuid: string, deadline: number }): Promise<{ segmentIds: string[], width: number | undefined, mergeNotes?: Array<{ segmentIndex: number, candidateId: string, actualIds: string[] }> }> {
	if (shared !== undefined && (!shared || typeof shared.documentUuid !== 'string' || !shared.documentUuid.trim() || typeof shared.deadline !== 'number' || !Number.isFinite(shared.deadline)))
		throw new Error('routeTrack shared 必须包含非空 documentUuid 和有限 deadline')
	const monotonicStart = performance.now()
	const MAX_TIMER_MS = 2147483647
	const requestedTimeout = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
	if (!Number.isFinite(requestedTimeout) || requestedTimeout > MAX_TIMER_MS)
		throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`)
	const budgetMs = Math.max(1000, requestedTimeout)
	const deadline = shared ? Math.min(monotonicStart + budgetMs, shared.deadline) : monotonicStart + budgetMs
	const remaining = () => deadline - performance.now()
	if (!params.net)
		throw new Error('缺少参数 net')
	if (!Array.isArray(params.points) || params.points.length < 2)
		throw new Error('points 至少需要两个点')
	for (let i = 0; i < params.points.length; i++) {
		const point = params.points[i]
		if (!Array.isArray(point) || point.length !== 2 || !point.every(value => typeof value === 'number' && Number.isFinite(value)))
			throw new Error(`points[${i}] 必须是两个有限数值坐标`)
	}
	for (let i = 0; i < params.points.length - 1; i++) {
		const a = params.points[i]
		const b = params.points[i + 1]
		assertMinimumRouteSegmentLength({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, `routeTrack 相邻段 ${i + 1}`)
	}
	let width = params.width != null ? Number(params.width) : undefined
	if (width != null && (!Number.isFinite(width) || width <= 0))
		throw new Error('width 必须是大于 0 的有限数值')
	if (width == null && params.currentA != null && (!Number.isFinite(Number(params.currentA)) || Number(params.currentA) <= 0))
		throw new Error('currentA 必须是大于 0 的有限数值')
	const layer = resolveLayer(params.layer) as any
	const awaitWithinDeadline = async <T>(operation: () => Promise<T> | T, phase: string): Promise<T> => {
		const left = remaining()
		if (left <= 0)
			throw new Error(`${phase}超出 pcb.routeTrack 共享总时限`)
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			return await Promise.race([
				Promise.resolve().then(operation),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${phase}超出 pcb.routeTrack 共享总时限`)), left) }),
			])
		}
		finally {
			if (timer !== undefined)
				clearTimeout(timer)
		}
	}
	const assertRouteTrackFocus = async (phase: string) => {
		const focused = await awaitWithinDeadline(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), `${phase}焦点核对`)
		if (focused?.documentType !== 3 || focused.uuid !== routeTrackDocumentUuid)
			throw new Error(`${phase} PCB 焦点已变化（原文档=${routeTrackDocumentUuid}，当前=${focused?.uuid ?? '未知'}），已停止后续走线`)
	}
	const routeTrackDocument = await awaitWithinDeadline(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), '初始 PCB 焦点读取')
	if (routeTrackDocument?.documentType !== 3 || typeof routeTrackDocument.uuid !== 'string' || !routeTrackDocument.uuid.trim())
		throw new Error('pcb.routeTrack 必须在有效 PCB 文档中运行')
	const routeTrackDocumentUuid = routeTrackDocument.uuid
	if (shared && routeTrackDocumentUuid !== shared.documentUuid)
		throw new Error(`pcb.routeTrack 初始 PCB 与共享文档不匹配（期望=${shared.documentUuid}，当前=${routeTrackDocumentUuid}），未开始写入`)
	const readBudget = remaining()
	if (readBudget <= 0)
		throw new Error('pcb.routeTrack 在写入前超出总时限，未开始创建线段')
	let netCheckTimer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			ensureNetExists(String(params.net)),
			new Promise<never>((_, reject) => { netCheckTimer = setTimeout(() => reject(new Error('网络存在检查超出共享总时限')), readBudget) }),
		])
	}
	finally {
		if (netCheckTimer !== undefined)
			clearTimeout(netCheckTimer)
	}
	if (remaining() <= 0)
		throw new Error('pcb.routeTrack 在写入前超出总时限，未开始创建线段')
	await assertRouteTrackFocus('网络存在检查后')
	if (width == null && params.currentA != null) {
		const hit = widthForCurrent(Number(params.currentA))
		if (!hit)
			throw new Error(`载流 ${params.currentA}A 超出知识库线宽表范围，请显式指定 width`)
		width = hit.widthMil
	}

	const points = params.points as Array<Array<number>>
	const segmentIds: string[] = []
	const mergeNotes: Array<{ segmentIndex: number, candidateId: string, actualIds: string[] }> = []
	const readLineSnapshot = async (phase: string) => {
		const ids = await awaitWithinDeadline(() => eda.pcb_PrimitiveLine.getAllPrimitiveId(), `${phase}线段 ID 枚举`)
		if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()))
			throw new Error(`${phase}线段 ID 枚举返回无效结果`)
		const lines: Array<{ id: string, net: unknown, layer: unknown, x1: number, y1: number, x2: number, y2: number, width: number }> = []
		for (const id of ids) {
			const line = await awaitWithinDeadline(() => eda.pcb_PrimitiveLine.get(id), `${phase}线段 ${id} 读回`)
			const actualId = safeState<unknown>(line, 'getState_PrimitiveId')
			const actualNet = safeState<unknown>(line, 'getState_Net')
			const actualLayer = safeState<unknown>(line, 'getState_Layer')
			const x1 = safeState<unknown>(line, 'getState_StartX'), y1 = safeState<unknown>(line, 'getState_StartY')
			const x2 = safeState<unknown>(line, 'getState_EndX'), y2 = safeState<unknown>(line, 'getState_EndY')
			const lineWidth = safeState<unknown>(line, 'getState_LineWidth')
			if (actualId !== id || ![x1, y1, x2, y2, lineWidth].every(value => typeof value === 'number' && Number.isFinite(value)) || Number(lineWidth) <= 0)
				throw new Error(`${phase}线段 ${id} 无法完整读回，不能安全判断合并结果`)
			lines.push({ id, net: actualNet, layer: actualLayer, x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2), width: Number(lineWidth) })
		}
		return lines
	}
	const tryVerifyMergedSegment = async (before: Awaited<ReturnType<typeof readLineSnapshot>>, candidateId: string, a: [number, number], b: [number, number], segmentIndex: number): Promise<{ actualIds: string[], width: number } | undefined> => {
		const current = await readLineSnapshot(`第 ${segmentIndex} 段合并读回`)
		const requestedHorizontal = Math.abs(a[1] - b[1]) <= 0.001
		const requestedVertical = Math.abs(a[0] - b[0]) <= 0.001
		if (!requestedHorizontal && !requestedVertical)
			return undefined
		const axisCoord = requestedHorizontal ? a[1] : a[0]
		const requestLo = Math.min(requestedHorizontal ? a[0] : a[1], requestedHorizontal ? b[0] : b[1])
		const requestHi = Math.max(requestedHorizontal ? a[0] : a[1], requestedHorizontal ? b[0] : b[1])
		const aligned = (line: typeof before[number]) => requestedHorizontal
			? Math.abs(line.y1 - axisCoord) <= 0.001 && Math.abs(line.y2 - axisCoord) <= 0.001
			: Math.abs(line.x1 - axisCoord) <= 0.001 && Math.abs(line.x2 - axisCoord) <= 0.001
		const span = (line: typeof before[number]) => requestedHorizontal
			? [Math.min(line.x1, line.x2), Math.max(line.x1, line.x2)] as const
			: [Math.min(line.y1, line.y2), Math.max(line.y1, line.y2)] as const
		const localLines = before.filter(line => line.net === String(params.net) && line.layer === layer && aligned(line))
		const directTargets = localLines.filter(line => {
			const [lo, hi] = span(line)
			return lo <= requestHi + 0.001 && hi >= requestLo - 0.001
		})
		if (!directTargets.length)
			return undefined
		const directWidths = [...new Set(directTargets.map(line => line.width))]
		if (width == null && directWidths.length !== 1)
			return undefined
		const expectedWidth = width == null ? directWidths[0] : Number(width)
		let targetLo = requestLo, targetHi = requestHi
		const oldTargets: typeof before = []
		let expanded = true
		while (expanded) {
			expanded = false
			for (const line of localLines) {
				if (oldTargets.some(target => target.id === line.id) || Math.abs(line.width - expectedWidth) > 0.001)
					continue
				const [lo, hi] = span(line)
				if (lo > targetHi + 0.001 || hi < targetLo - 0.001)
					continue
				oldTargets.push(line)
				targetLo = Math.min(targetLo, lo)
				targetHi = Math.max(targetHi, hi)
				expanded = true
			}
		}
		if (!oldTargets.length || (width != null && !oldTargets.some(line => Math.abs(line.width - Number(width)) <= 0.001)))
			return undefined
		const candidates = current.filter(line => line.net === String(params.net) && line.layer === layer && aligned(line) && Math.abs(line.width - expectedWidth) <= 0.001
			&& (() => { const [lo, hi] = span(line); return lo <= targetHi + 0.001 && hi >= targetLo - 0.001 })())
		if (!candidates.length)
			return undefined
	const targets = oldTargets.map(line => line.id)
	const nonTargets = before.filter(line => !targets.includes(line.id))
	for (const original of nonTargets) {
		const after = current.find(line => line.id === original.id)
		if (!after || after.net !== original.net || after.layer !== original.layer || after.x1 !== original.x1 || after.y1 !== original.y1 || after.x2 !== original.x2 || after.y2 !== original.y2 || after.width !== original.width)
			throw new Error(`合并读回期间非目标原有线段 ${original.id} 消失或属性变化`)
	}
	const intervalsBefore = oldTargets.map(span).sort((left, right) => left[0] - right[0])
	let preCursor = requestLo
	for (const [start, end] of intervalsBefore) {
		if (end < preCursor - 0.001) continue
		if (start > preCursor + 0.001) break
		preCursor = Math.max(preCursor, end)
	}
	if (preCursor >= requestHi - 0.001)
		return undefined
	const intervals = candidates.map(span).sort((left, right) => left[0] - right[0])
	let cursor = targetLo
	let previousEnd = targetLo
	for (const [start, end] of intervals) {
		if (start < targetLo - 0.001 || end > targetHi + 0.001)
			return undefined
		if (start < previousEnd - 0.001)
			return undefined
		if (start > cursor + 0.001)
			return undefined
		cursor = Math.max(cursor, end)
		previousEnd = Math.max(previousEnd, end)
	}
	if (cursor < targetHi - 0.001)
		return undefined
	const actualIds = candidates.map(line => line.id)
	if (actualIds.length === 0 || actualIds.includes(candidateId)) return undefined
	return { actualIds, width: expectedWidth }
	}
	const failPartial = (segmentIndex: number, error: unknown, attempted = true, failedPrimitiveId?: string): never => {
		const operationError = error instanceof Error ? error.message : String(error)
		const cause = {
			partial: true,
			retryable: false,
			segmentIds: [...segmentIds],
			failedSegmentIndex: segmentIndex,
			failedSegmentAttempted: attempted,
		...(typeof failedPrimitiveId === 'string' && failedPrimitiveId.trim() ? { failedPrimitiveId } : {}),
			unprocessedSegments: points.length - 1 - segmentIndex + (attempted ? 0 : 1),
			phase: 'pcb.routeTrack',
			operationError,
		}
		throw new Error(`pcb.routeTrack 第 ${segmentIndex} 段结果未确认${attempted ? '；该段可能已生效' : '；该段尚未发出'}，已停止后续写入：${operationError}`, { cause })
	}
	for (let i = 0; i < points.length - 1; i++) {
		const [x1, y1] = points[i]
		const [x2, y2] = points[i + 1]
		const left = remaining()
		if (left <= 0) {
			if (i === 0)
				throw new Error('pcb.routeTrack 在写入前超出总时限，未开始创建线段')
			failPartial(i + 1, new Error('总时限已耗尽'), false)
		}
		let line: any
		let candidateId: string | undefined
		let createAttempted = false
		let preWriteLines: Awaited<ReturnType<typeof readLineSnapshot>>
		try {
			await assertRouteTrackFocus(`第 ${i + 1} 段创建前`)
			preWriteLines = await readLineSnapshot(`第 ${i + 1} 段创建前`)
			await assertRouteTrackFocus(`第 ${i + 1} 段线段快照后`)
			line = await awaitWithinDeadline(() => {
				createAttempted = true
				return eda.pcb_PrimitiveLine.create(String(params.net), layer, Number(x1), Number(y1), Number(x2), Number(y2), width)
			}, `第 ${i + 1} 段创建`)
			candidateId = safeState<unknown>(line, 'getState_PrimitiveId') as string | undefined
			await assertRouteTrackFocus(`第 ${i + 1} 段创建后`)
		}
		catch (err) {
			failPartial(i + 1, wrapCreateError(`第 ${i + 1} 段走线创建/焦点核对`, err), createAttempted, candidateId)
		}
		if (!line)
			failPartial(i + 1, new Error('官方返回空'))
		if (typeof candidateId !== 'string' || !candidateId.trim())
			failPartial(i + 1, new Error('官方返回对象缺少有效线段 ID'))
		const candidatePrimitiveId = candidateId as string
		try {
			await assertRouteTrackFocus(`第 ${i + 1} 段读回前`)
			const readback = await awaitWithinDeadline(() => eda.pcb_PrimitiveLine.get(candidatePrimitiveId), `第 ${i + 1} 段按 ID 读回`)
			await assertRouteTrackFocus(`第 ${i + 1} 段按 ID 读回后`)
			const listedIds = await awaitWithinDeadline(() => eda.pcb_PrimitiveLine.getAllPrimitiveId(), `第 ${i + 1} 段 ID 枚举`)
			await assertRouteTrackFocus(`第 ${i + 1} 段 ID 枚举后`)
			if (!Array.isArray(listedIds) || listedIds.some(value => typeof value !== 'string' || !value.trim()))
				throw new Error('getAllPrimitiveId 返回非数组或含无效 ID')
			if (!listedIds.includes(candidatePrimitiveId)) {
				const merged = await tryVerifyMergedSegment(preWriteLines!, candidatePrimitiveId, [Number(x1), Number(y1)], [Number(x2), Number(y2)], i + 1)
				if (!merged) throw new Error(`新线段 ID 未出现在图元枚举中，且无法验证等价合并结果（candidate=${candidatePrimitiveId}）`)
				segmentIds.splice(0, segmentIds.length, ...segmentIds.filter(id => listedIds.includes(id)), ...merged.actualIds)
				mergeNotes.push({ segmentIndex: i + 1, candidateId: candidatePrimitiveId, actualIds: merged.actualIds })
				width = merged.width
				continue
			}
			if (!readback)
				throw new Error('按 ID 读回为空')
			const actualId = safeState<unknown>(readback, 'getState_PrimitiveId')
			const actualNet = safeState<unknown>(readback, 'getState_Net')
			const actualLayer = safeState<unknown>(readback, 'getState_Layer')
			const actualStartX = safeState<unknown>(readback, 'getState_StartX')
			const actualStartY = safeState<unknown>(readback, 'getState_StartY')
			const actualEndX = safeState<unknown>(readback, 'getState_EndX')
			const actualEndY = safeState<unknown>(readback, 'getState_EndY')
			const actualWidth = safeState<unknown>(readback, 'getState_LineWidth')
			if (actualId !== candidatePrimitiveId || actualNet !== String(params.net) || actualLayer !== layer)
				throw new Error(`读回身份不匹配（id=${String(actualId)} net=${String(actualNet)} layer=${String(actualLayer)}）`)
			if (![actualStartX, actualStartY, actualEndX, actualEndY, actualWidth].every(value => typeof value === 'number' && Number.isFinite(value)) || Number(actualWidth) <= 0)
				throw new Error('读回坐标或线宽不是有限有效数值')
			const actualLength = Math.hypot(Number(actualEndX) - Number(actualStartX), Number(actualEndY) - Number(actualStartY))
			if (actualLength <= 0)
				throw new Error('读回线段长度为零')
			const expectedLength = Math.hypot(Number(x2) - Number(x1), Number(y2) - Number(y1))
			const coordinateTolerance = Math.min(0.001, expectedLength / 4)
			const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance
			const direct = near(Number(actualStartX), Number(x1), coordinateTolerance) && near(Number(actualStartY), Number(y1), coordinateTolerance)
				&& near(Number(actualEndX), Number(x2), coordinateTolerance) && near(Number(actualEndY), Number(y2), coordinateTolerance)
			const reverse = near(Number(actualStartX), Number(x2), coordinateTolerance) && near(Number(actualStartY), Number(y2), coordinateTolerance)
				&& near(Number(actualEndX), Number(x1), coordinateTolerance) && near(Number(actualEndY), Number(y1), coordinateTolerance)
			if (!direct && !reverse)
				throw new Error('读回端点与请求线段不匹配')
			if (width != null && Math.abs(Number(actualWidth) - Number(width)) > 0.001)
				throw new Error(`读回线宽不匹配（读回 ${String(actualWidth)}，请求 ${String(width)}）`)
		}
		catch (err) {
			failPartial(i + 1, err, true, candidateId)
		}
		segmentIds.push(candidatePrimitiveId)
		if (remaining() <= 0)
			failPartial(i + 1, new Error('创建调用完成时共享预算已耗尽'))
	}
	return { segmentIds, width, ...(mergeNotes.length ? { mergeNotes } : {}) }
}

export const pcbCommands: Array<ICommandDef> = [
	{
		name: 'pcb.listComponents',
		summary: '列出 PCB 中的全部器件',
		params: [
			{ name: 'layer', type: 'string', description: 'top | bottom，留空为全部层' },
		],
		returns: '器件列表 [{ primitiveId, designator, x, y, layer, rotation }]',
		example: { cmd: 'pcb.listComponents' },
		handler: async (params) => {
			const layer = params.layer ? (resolveLayer(params.layer) as any) : undefined
			const components = await eda.pcb_PrimitiveComponent.getAll(layer)
			return (components ?? []).map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
				layer: safeState<number>(c, 'getState_Layer'),
				rotation: safeState<number>(c, 'getState_Rotation'),
			}))
		},
	},
	{
		name: 'pcb.moveComponent',
		summary: '移动 / 旋转 PCB 器件（primitiveId 或 designator 二选一）',
		params: [
			{ name: 'primitiveId', type: 'string', description: '器件图元 ID（与 designator 二选一）' },
			{ name: 'designator', type: 'string', description: '器件位号，如 R1 / U1（与 primitiveId 二选一）' },
			{ name: 'x', type: 'number', description: '新坐标 X' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'rotation', type: 'number', description: '旋转角度' },
			{ name: 'layer', type: 'string', description: 'top | bottom（换层）' },
		],
		returns: '是否修改成功',
		example: { cmd: 'pcb.moveComponent', params: { designator: 'R1', x: 1000, y: 800, rotation: 90 } },
		handler: async (params) => {
			let primitiveId = params.primitiveId ? String(params.primitiveId) : undefined
			if (!primitiveId && params.designator) {
				const components = await eda.pcb_PrimitiveComponent.getAll()
				const hit = (components ?? []).find(
					c => safeState<string>(c, 'getState_Designator') === String(params.designator),
				)
				if (!hit)
					throw new Error(`未找到位号 ${params.designator}（请先激活对应 PCB）`)
				primitiveId = safeState<string>(hit, 'getState_PrimitiveId')
			}
			if (!primitiveId)
				throw new Error('缺少参数 primitiveId 或 designator')
			const property: Record<string, any> = {}
			if (params.x != null)
				property.x = Number(params.x)
			if (params.y != null)
				property.y = Number(params.y)
			if (params.rotation != null)
				property.rotation = Number(params.rotation)
			if (params.layer != null)
				property.layer = resolveLayer(params.layer)
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（x / y / rotation / layer）')
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——位置 / 旋转 / 换层各自独立步骤
			const compSteps: Array<Record<string, any>> = []
			if (property.x != null || property.y != null) {
				const s: Record<string, any> = {}
				if (property.x != null)
					s.x = property.x
				if (property.y != null)
					s.y = property.y
				compSteps.push(s)
			}
			if (property.rotation != null)
				compSteps.push({ rotation: property.rotation })
			if (property.layer != null)
				compSteps.push({ layer: property.layer })
			const okAny = await modifyInSteps(
				async props => eda.pcb_PrimitiveComponent.modify(primitiveId, props as any),
				compSteps,
			).catch((err) => { throw wrapCreateError('修改器件', err) })
			// 读回验证（0.10.24：官方返回值不可信，成败以读回为准）
			await new Promise(resolve => setTimeout(resolve, 300))
			const comps = await eda.pcb_PrimitiveComponent.getAll().catch(() => undefined)
			const back = (comps ?? []).find(c => safeState<string>(c, 'getState_PrimitiveId') === primitiveId)
			const checks: Array<[string, string, any, 'num' | 'str' | 'bool']> = []
			if (property.x != null)
				checks.push(['x', 'getState_X', property.x, 'num'])
			if (property.y != null)
				checks.push(['y', 'getState_Y', property.y, 'num'])
			if (property.rotation != null)
				checks.push(['rotation', 'getState_Rotation', property.rotation, 'num'])
			if (property.layer != null)
				checks.push(['layer', 'getState_Layer', property.layer, 'num'])
			const { readback, verified } = verifyReadback(back, checks)
			if (!verified && checks.length)
				throw new Error(`器件 ${primitiveId} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return {
				modified: okAny || verified,
				primitiveId,
				...(checks.length ? { readback: { ...readback, verified } } : {}),
			}
		},
	},
	{
		name: 'pcb.routeTrack',
		summary: 'PCB 走线（折线，自动拆成线段）；每个相邻段必须至少 1 mil；可按载流自动计算线宽。每段创建后按 ID 读回并核对图元枚举、网络、层、端点和线宽，确认后才报告成功；按 PCB 焦点及共享总时限执行，分段失败时返回 partial 证据并停止后续段',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名（须已存在于 PCB，可用 pcb.listNets 查看）' },
			{ name: 'points', type: 'number[][]', required: true, description: '折点坐标 [[x1,y1],[x2,y2],...]' },
			{ name: 'layer', type: 'string | number', description: '层名或层号（如 inner1），默认 top；按实际目标图层执行与读回' },
			{ name: 'width', type: 'number', description: '线宽（与 currentA 二选一）' },
			{ name: 'currentA', type: 'number', description: '载流（安培），由知识库自动换算线宽' },
		],
		returns: '{ segmentIds, width }；仅读回验证通过的段计入 segmentIds。分段失败时 error.cause={partial:true,retryable:false,segmentIds,failedSegmentIndex,failedSegmentAttempted,failedPrimitiveId?,unprocessedSegments,phase,operationError}；failedPrimitiveId 表示失败段可能已创建的候选 ID，不代表成功',
		example: { cmd: 'pcb.routeTrack', params: { net: 'VCC', points: [[100, 100], [500, 100]], width: 12 } },
		handler: async (params) => executeRouteTrack(params),
	},
	{
		name: 'pcb.placeVia',
		summary: '放置通孔并核对 ID、网络、坐标与孔径，随后请求飞线重算；对同网 SIGNAL 铜层的重合端点 LINE 各做一次原坐标刷新并读回。跳过或完成刷新均不代表电气连通已验证',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名（须已存在于 PCB）' },
			{ name: 'x', type: 'number', required: true, description: '坐标 X' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
			{ name: 'holeDiameter', type: 'number', required: true, description: '孔径' },
			{ name: 'diameter', type: 'number', required: true, description: '外径' },
		],
		returns: '{ primitiveId, readbackVerified:true, ratlineCalculation:{ requested:true, accepted:true }, endpointRefresh:{attempted,skipped?,reason?,completedLineIds,results}, connectivityVerified:false }；端点刷新失败时 error.cause 保留已创建过孔和已完成 LINE 列表，partial:true,retryable:false',
		example: { cmd: 'pcb.placeVia', params: { net: 'GND', x: 100, y: 100, holeDiameter: 12, diameter: 24 } },
		handler: async (params) => {
			const net = typeof params.net === 'string' ? params.net.trim() : ''
			if (!net)
				throw new Error('缺少参数 net')
			const numeric = ['x', 'y', 'holeDiameter', 'diameter'] as const
			for (const name of numeric) {
				if (typeof params[name] !== 'number' || !Number.isFinite(params[name]))
					throw new Error(`${name} 必须是有限数值`)
			}
			const { x, y, holeDiameter, diameter } = params as { x: number, y: number, holeDiameter: number, diameter: number }
			if (holeDiameter <= 0 || diameter <= 0 || holeDiameter >= diameter)
				throw new Error('holeDiameter 和 diameter 必须大于 0，且 holeDiameter 小于 diameter')
			const MAX_TIMER_MS = 2147483647
			const requestedTimeout = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > MAX_TIMER_MS)
				throw new Error(`_timeoutMs 必须是大于 0 且不超过 ${MAX_TIMER_MS}ms 的有限数值`)
			const budgetMs = Math.max(1000, requestedTimeout)
			const deadline = performance.now() + budgetMs
			const awaitPlaceVia = async <T>(label: string, operation: () => Promise<T> | T): Promise<T> => {
				const remaining = deadline - performance.now()
				if (remaining <= 0) {
					const error = new Error(`${label}超出 pcb.placeVia 共享时间预算（${budgetMs}ms）；原调用可能仍在后台执行`)
					;(error as any).budgetExceeded = true
					throw error
				}
				let pending: Promise<T>
				try { pending = Promise.resolve(operation()) }
				catch (error) { throw error }
				try {
					const value = await withTimeout(pending, remaining, label)
					if (deadline - performance.now() <= 0) throw new Error(`${label}完成时 pcb.placeVia 共享时间预算已耗尽`)
					return value
				}
				catch (error) {
					if (deadline - performance.now() <= 0) (error as any).budgetExceeded = true
					throw error
				}
			}
			const focus = await awaitPlaceVia('读取 PCB 焦点', () => eda.dmt_SelectControl.getCurrentDocumentInfo())
			if (focus?.documentType !== 3 || typeof focus.uuid !== 'string' || !focus.uuid.trim())
				throw new Error('pcb.placeVia 必须在有效 PCB 文档中运行')
			const documentUuid = focus.uuid
			await awaitPlaceVia('检查网络', () => ensureNetExists(net))
			const assertPlaceViaFocus = async (phase: string) => {
				const current = await awaitPlaceVia(phase, () => eda.dmt_SelectControl.getCurrentDocumentInfo())
				if (current?.documentType !== 3 || current.uuid !== documentUuid)
					throw new Error(`${phase} PCB 焦点已变化（原文档=${documentUuid}，当前=${current?.uuid ?? '未知'}）`)
			}
			const planRead = <T>(label: string, operation: () => Promise<T> | T) => awaitPlaceVia(label, operation)
			const endpointPlan = await prepareViaEndpointRefresh(eda, net, x, y, planRead)
			await assertPlaceViaFocus('过孔创建前')
			let via: any
			let createAttempted = false
			try {
				createAttempted = true
				via = await awaitPlaceVia('创建过孔', () => eda.pcb_PrimitiveVia.create(
					net,
					x,
					y,
					holeDiameter,
					diameter,
					0,
				))
			}
			catch (err) {
				throw new Error(`过孔创建结果未确认（${String((err as any)?.message ?? err)}）`, { cause: { partial: createAttempted, retryable: false, phase: 'create', operationError: String((err as any)?.message ?? err) } })
			}
			const primitiveId = safeState<string>(via, 'getState_PrimitiveId')
			const failViaPartial = (phase: string, operationError: unknown, verified = false, ratlineRequested = false, endpointRefresh?: unknown): never => {
				const message = operationError instanceof Error ? operationError.message : String(operationError)
				throw new Error(`过孔已可能创建但${phase}未确认；请保留 PCB 现场并按 ID 核实，不要重试：${message}`, {
					cause: {
						partial: true,
						retryable: false,
						...(typeof primitiveId === 'string' && primitiveId.trim() ? { primitiveId } : {}),
						...(verified ? { readbackVerified: true } : {}),
						ratlineCalculation: { requested: ratlineRequested, accepted: phase === '端点刷新' },
						...(endpointRefresh ? { endpointRefresh } : {}),
						phase,
						operationError: message,
					},
				})
			}
			if (!via || typeof primitiveId !== 'string' || !primitiveId.trim())
				failViaPartial('创建 ID 读取', new Error('官方返回空对象或无有效 primitiveId'))
			const verifiedPrimitiveId = primitiveId as string
			let readback: any
			try {
				await assertPlaceViaFocus('过孔创建后')
				const ids = await awaitPlaceVia('枚举过孔 ID', () => eda.pcb_PrimitiveVia.getAllPrimitiveId())
				if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== 'string' || !id.trim()) || !ids.includes(verifiedPrimitiveId))
					throw new Error('过孔 ID 未通过完整图元枚举核对')
				const freshVias = await awaitPlaceVia('新鲜读取过孔', () => eda.pcb_PrimitiveVia.getAll())
				if (!Array.isArray(freshVias))
					throw new Error('过孔新鲜读回 getAll 返回非数组')
				readback = freshVias.find((item: any) => safeState<unknown>(item, 'getState_PrimitiveId') === verifiedPrimitiveId)
				await assertPlaceViaFocus('过孔新鲜读回后')
				if (!readback)
					throw new Error('按 ID 新鲜读回为空')
				const actual = {
					primitiveId: safeState<unknown>(readback, 'getState_PrimitiveId'),
					net: safeState<unknown>(readback, 'getState_Net'),
					x: safeState<unknown>(readback, 'getState_X'),
					y: safeState<unknown>(readback, 'getState_Y'),
					holeDiameter: safeState<unknown>(readback, 'getState_HoleDiameter'),
					diameter: safeState<unknown>(readback, 'getState_Diameter'),
					viaType: safeState<unknown>(readback, 'getState_ViaType'),
				}
				if (actual.primitiveId !== verifiedPrimitiveId || actual.net !== net || !sameRoundtripNumber(actual.x, x) || !sameRoundtripNumber(actual.y, y) || !sameRoundtripNumber(actual.holeDiameter, holeDiameter) || !sameRoundtripNumber(actual.diameter, diameter) || actual.viaType !== 0)
					throw new Error(`过孔读回与请求不匹配（${JSON.stringify(actual)}）`)
			}
			catch (err) {
				failViaPartial('ID/几何/网络/通孔类型读回', err)
			}
			let ratlineRequested = false
			try {
				await assertPlaceViaFocus('飞线重算前')
				ratlineRequested = true
				const accepted = await awaitPlaceVia('飞线重算请求', () => eda.pcb_Document.startCalculatingRatline())
				if (accepted !== true)
					failViaPartial('飞线重算请求', new Error(`startCalculatingRatline 返回 ${String(accepted)}`), true, true)
				const endpointRefresh = endpointPlan.status === 'ready'
					? await refreshViaEndpointLines(eda, endpointPlan, verifiedPrimitiveId, net, x, y, assertPlaceViaFocus, planRead)
					: { attempted: false, skipped: true, reason: endpointPlan.reason ?? '端点预检未提供可用目标', completedLineIds: [], results: [] }
				return { primitiveId, readbackVerified: true, ratlineCalculation: { requested: true, accepted: true }, endpointRefresh, connectivityVerified: false }
			}
			catch (err) {
				const cause = (err as any)?.cause
				if (cause?.partial === true)
					throw err
				const endpointRefresh = (err as any)?.endpointRefresh
				failViaPartial(endpointRefresh ? '端点刷新' : '飞线重算请求', err, true, ratlineRequested, endpointRefresh)
			}
		},
	},
	{
		name: 'pcb.pourCopper',
		summary: '矩形铺铜（GND 平面等）；preserveSilos 可选控制是否保留孤岛，省略时沿用 SDK 默认行为',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名，通常为 GND（须已存在于 PCB）' },
			{ name: 'layer', type: 'string | number', description: `图层名称或数字层号，默认 top；内层可用 inner1(15) 等名称。目标铜层须已在 PCB 中启用。${LAYER_HELP}` },
			{ name: 'x', type: 'number', required: true, description: '矩形左下角 X' },
			{ name: 'y', type: 'number', required: true, description: '矩形左下角 Y' },
			{ name: 'width', type: 'number', required: true, description: '矩形宽度' },
			{ name: 'height', type: 'number', required: true, description: '矩形高度' },
			{ name: 'preserveSilos', type: 'boolean', description: '是否保留铺铜孤岛；省略时不传该SDK参数，使用宿主默认值' },
		],
		returns: '{ primitiveId, readback: { verified, net, layer, preserveSilos, path } }；仅确认铺铜边框属性与源码，未触发填充/重建',
		example: { cmd: 'pcb.pourCopper', params: { net: 'GND', layer: 'bottom', x: 0, y: 0, width: 2000, height: 1500, preserveSilos: true } },
		handler: async (params) => {
			const monotonicStart = performance.now()
			const MAX_TIMER_MS = 2147483647
			const requestedTimeout = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedTimeout) || requestedTimeout > MAX_TIMER_MS)
				throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`)
			const budgetMs = Math.max(1000, requestedTimeout)
			const deadline = monotonicStart + budgetMs
			const remaining = () => deadline - performance.now()
			const budgetError = (label: string, cause?: unknown) => {
				const error = new Error(`${label}超出单指令时间预算（${budgetMs}ms）；原调用可能仍在后台执行`, cause === undefined ? undefined : { cause })
				;(error as any).budgetExceeded = true
				return error
			}
			const awaitWithinBudget = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
				const left = remaining()
				if (left <= 0)
					throw budgetError(label)
				let pending: Promise<T>
				try { pending = Promise.resolve(operation()) }
				catch (error) {
					if (remaining() <= 0)
						throw budgetError(label, error)
					throw error
				}
				let value: T
				try { value = await withTimeout(pending, left, label) }
				catch (error) {
					if (remaining() <= 0)
						throw budgetError(label, error)
					throw error
				}
				if (remaining() <= 0)
					throw budgetError(label)
				return value
			}
			if (params.preserveSilos !== undefined && typeof params.preserveSilos !== 'boolean')
				throw new Error('preserveSilos 必须是布尔值')
			if (!params.net)
				throw new Error('缺少参数 net')
			const focus = await awaitWithinBudget('读取焦点文档', () => eda.dmt_SelectControl.getCurrentDocumentInfo())
			if (focus?.documentType !== 3 || typeof focus?.uuid !== 'string' || !focus.uuid.trim())
				throw new Error(`焦点文档不是有效 PCB（documentType=${focus?.documentType ?? '未知'}, uuid=${focus?.uuid ?? '无'}）`)
			const assertFocus = async (phase: string) => {
				const latest = await awaitWithinBudget(`${phase}复核焦点`, () => eda.dmt_SelectControl.getCurrentDocumentInfo())
				if (latest?.documentType !== 3 || latest.uuid !== focus.uuid)
					throw new Error(`${phase}时 PCB 焦点已变化（原页=${focus.uuid}, 当前=${latest?.uuid ?? '未知'}）`)
			}
			let netNames: Array<string> | undefined
			try { netNames = (await awaitWithinBudget('读取 PCB 网络列表', () => eda.pcb_Net.getAllNetsName())) ?? [] }
			catch (error) {
				if ((error as any)?.budgetExceeded)
					throw error
				// 与既有 ensureNetExists 保持一致：普通读取故障时交给创建接口判断。
			}
			if (netNames && !netNames.includes(String(params.net)))
				throw new Error(`网络 "${String(params.net)}" 在当前 PCB 中不存在（现有 ${netNames.length} 个网络${netNames.length ? ': ' + netNames.slice(0, 10).join(', ') + (netNames.length > 10 ? '…' : '') : ''}）。请先确认原理图中该网络已连接并从原理图导入（pcb.importChanges），或检查网络名拼写`)
			await assertFocus('网络检查后')
			// 官方 'R' 矩形的 (x,y) 是**左上角**（画布 +Y 向上，矩形向下延伸），
			// 本指令对外约定 (x,y) 为**左下角**，此处换算：官方y = 左下角y + height
			// （0.10.65 修复：此前未换算，铺铜整体偏移一个板高——与 drawOutline 同一约定）
			const polygon = eda.pcb_MathPolygon.createPolygon([
				'R',
				Number(params.x), Number(params.y) + Number(params.height),
				Number(params.width), Number(params.height),
				0, 0,
			])
			if (!polygon || typeof polygon.getSource !== 'function')
				throw new Error('矩形铺铜多边形创建失败或缺少源码读取接口')
			const expectedPath = polygon.getSource()
			const inspectRectanglePath = (raw: unknown) => {
				let format: 'flat-R' | 'single-R-wrapper' | 'invalid' = 'invalid'
				let candidate: unknown = raw
				if (Array.isArray(raw) && raw.length === 1 && Array.isArray(raw[0])) {
					format = 'single-R-wrapper'
					candidate = raw[0]
				}
				else if (Array.isArray(raw))
					format = 'flat-R'
				const valid = Array.isArray(candidate) && candidate.length === 7 && candidate[0] === 'R'
					&& candidate.slice(1).every(value => typeof value === 'number' && Number.isFinite(value))
				return {
					raw,
					format: valid ? format : 'invalid' as const,
					valid,
					normalized: valid ? candidate as Array<string | number> : null,
				}
			}
			const expectedPathInfo = inspectRectanglePath(expectedPath)
			if (!expectedPathInfo.valid)
				throw new Error('请求矩形轮廓不是合法的一维 R 或单个 R 外层包装格式')
			const layer = resolveLayerEx(params.layer === '' ? undefined : params.layer, 1) as any
			const readSource = async (phase: string) => {
				await assertFocus(`${phase}前读取源码`)
				const text = await awaitWithinBudget(`${phase}读取 PCB 源码`, () => eda.sys_FileManager.getDocumentSource())
				await assertFocus(`${phase}后读取源码`)
				if (typeof text !== 'string' || !text.trim())
					throw new Error(`${phase}返回空或非法 PCB 源码`)
				const doc = parseSourceLog(text)
				if (doc.docType !== 'PCB' || doc.uuid !== focus.uuid)
					throw new Error(`${phase}源码身份与当前 PCB 不符（docType=${doc.docType}, 源码 UUID=${doc.uuid}, 焦点 UUID=${focus.uuid}）`)
				return { text, doc }
			}
			const before = await readSource('创建前')
			const beforePours = resolveRecords<Record<string, any>>(before.doc, 'POUR')
			const beforeNonTargetRecords = snapshotEffectiveSourceRecords(before.doc)
			const failCandidate = (phase: string, error: unknown, candidateId?: string, details: Record<string, unknown> = {}): never => {
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(`铺铜创建后${phase}未确认：${message}`, {
					cause: {
						partial: true,
						retryable: false,
						phase,
						candidateId: candidateId ?? null,
						candidateUuid: focus.uuid,
						operationError: message,
						...details,
					},
				})
			}
			let pour: any
			await assertFocus('创建铺铜前')
			let createAttempted = false
			let pathComparison: Record<string, unknown> | undefined
			try {
				pour = await awaitWithinBudget('创建铺铜', async () => {
					createAttempted = true
					pour = params.preserveSilos === undefined
						? await eda.pcb_PrimitivePour.create(String(params.net), layer, polygon as any)
						: await eda.pcb_PrimitivePour.create(String(params.net), layer, polygon as any, undefined, params.preserveSilos)
					return pour
				})
			}
			catch (error) {
				if (createAttempted)
					failCandidate('创建调用', error, safeState<string>(pour, 'getState_PrimitiveId'))
				throw error
			}
			const primitiveId = safeState<string>(pour, 'getState_PrimitiveId')
			if (typeof primitiveId !== 'string' || !primitiveId)
				failCandidate('候选 ID 读取', new Error('官方创建接口未返回有效图元 ID'))
			const candidateId = primitiveId as string
			if (beforePours.has(`POUR\u0000${candidateId}`))
				failCandidate('候选 ID 冲突', new Error(`创建前源码已存在 POUR ${candidateId}`), candidateId)
			try {
				await assertFocus('按 ID 读回铺铜前')
				const fresh = await awaitWithinBudget('按 ID 读回铺铜', () => eda.pcb_PrimitivePour.get(candidateId))
				await assertFocus('按 ID 读回铺铜后')
				if (!fresh || typeof fresh.getState_PrimitiveId !== 'function' || typeof fresh.getState_Net !== 'function'
					|| typeof fresh.getState_Layer !== 'function' || typeof fresh.getState_PreserveSilos !== 'function'
					|| typeof fresh.getState_ComplexPolygon !== 'function')
					throw new Error('按 ID 读回对象缺少图元 ID/网络/层/保孤岛/轮廓 getter')
				const freshId = fresh.getState_PrimitiveId()
				const net = fresh.getState_Net()
				const readLayer = fresh.getState_Layer()
				const preserveSilos = fresh.getState_PreserveSilos()
				const readPolygon = fresh.getState_ComplexPolygon()
				if (!readPolygon || typeof readPolygon.getSource !== 'function')
					throw new Error('读回轮廓缺少 getSource 接口')
				const readPath = readPolygon.getSource()
				const after = await readSource('创建后')
				const afterPours = resolveRecords<Record<string, any>>(after.doc, 'POUR')
				const targetRecord = afterPours.get(`POUR\u0000${candidateId}`)
				const targetData = targetRecord?.data && typeof targetRecord.data === 'object' && !Array.isArray(targetRecord.data) ? targetRecord.data : undefined
				if (!targetData)
					throw new Error('源码中缺少有效候选铺铜记录')
				if (typeof freshId !== 'string' || freshId !== candidateId)
					throw new Error(`图元 ID 读回不匹配（创建=${candidateId}, 读回=${String(freshId)}）`)
				if (typeof net !== 'string' || net !== String(params.net) || targetData.netName !== String(params.net))
					throw new Error(`网络读回不匹配（API=${String(net)}, source=${String(targetData.netName)}, 请求=${String(params.net)}）`)
				if (readLayer !== layer || targetData.layerId !== layer)
					throw new Error(`层读回不匹配（API=${String(readLayer)}, source=${String(targetData.layerId)}, 请求=${String(layer)}）`)
				if (typeof preserveSilos !== 'boolean' || typeof targetData.keepIsland !== 'boolean' || preserveSilos !== targetData.keepIsland)
					throw new Error(`保留孤岛读回不匹配（API=${String(preserveSilos)}, source=${String(targetData.keepIsland)}）`)
				if (params.preserveSilos !== undefined && (preserveSilos !== params.preserveSilos || targetData.keepIsland !== params.preserveSilos))
					throw new Error(`保留孤岛读回与请求不匹配（读回=${String(preserveSilos)}, 请求=${String(params.preserveSilos)}）`)
				const getterPathInfo = inspectRectanglePath(readPath)
				const sourcePathInfo = inspectRectanglePath(targetData.path)
				const matchesExpected = (actual: typeof expectedPathInfo) => expectedPathInfo.valid && actual.valid
					&& expectedPathInfo.normalized!.length === actual.normalized!.length
					&& expectedPathInfo.normalized!.every((value, index) => value === actual.normalized![index])
				pathComparison = {
					expectedPath,
					getterPath: readPath,
					sourcePath: targetData.path,
					expected: expectedPathInfo,
					getter: getterPathInfo,
					source: sourcePathInfo,
					comparison: {
						getterMatchesExpected: matchesExpected(getterPathInfo),
						sourceMatchesExpected: matchesExpected(sourcePathInfo),
						strictElementEquality: true,
					},
				}
				if (!matchesExpected(getterPathInfo) || !matchesExpected(sourcePathInfo))
					throw new Error('铺铜轮廓读回与请求矩形不匹配')
				if (JSON.stringify(snapshotEffectiveSourceRecords(after.doc, undefined, candidateId)) !== JSON.stringify(beforeNonTargetRecords))
					throw new Error('创建同时改变了非目标源码记录（包括原POURED/POUR/其他对象），已保留候选并停止')
				if (remaining() <= 0)
					throw budgetError('铺铜创建后读回验证')
				return { primitiveId: candidateId, readback: { verified: true, net, layer: readLayer, preserveSilos, path: readPath } }
			}
			catch (error) {
				failCandidate('属性/源码读回', error, candidateId, pathComparison ? { pathComparison } : {})
			}
		},
	},
	{
		name: 'pcb.getSelection',
		summary: '获取 PCB 当前选中的图元',
		params: [],
		returns: '选中图元列表',
		example: { cmd: 'pcb.getSelection' },
		handler: async () => {
			return await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()
		},
	},
	{
		name: 'pcb.runDrc',
		summary: '运行 PCB DRC 设计规则检查，返回违规列表',
		params: [],
		returns: '{ passed, violations }',
		example: { cmd: 'pcb.runDrc' },
		handler: async () => {
			const violations = await eda.pcb_Drc.check(true, false, true)
			if (!Array.isArray(violations))
				throw new Error(`PCB DRC 结果不可判定：官方返回 ${violations === null ? 'null' : typeof violations}，预期为违规数组；不能按 0 项通过处理`)
			const list = violations
			return { passed: list.length === 0, violations: list }
		},
	},
	{
		name: 'pcb.runDrcDetailed',
		summary: '运行 PCB DRC 并返回逐条违规明细及归一化坐标。EDA 4.1.78 已核实原始 x/y 单位为 10mil，另返回 xMil/yMil 和 coordinateUnit=mil；其他或未知版本保留原始 x/y 并标 rawCoordinateUnit=unknown，不猜测换算',
		params: [],
		returns: '{ passed, totalCount, fatalCount, warnCount, violations: [逐条明细] }（按宿主版本标注坐标：EDA 4.1.78 的 x/y 保留原值并标 rawCoordinateUnit:"10mil"，同时给 xMil/yMil 和 coordinateUnit:"mil"；其他/未知版本仅给原值并标 rawCoordinateUnit:"unknown"。原始叶保留在 raw）',
		example: { cmd: 'pcb.runDrcDetailed' },
		handler: async () => {
			const violations = await eda.pcb_Drc.check(true, false, true)
			if (!Array.isArray(violations))
				throw new Error(`PCB DRC 结果不可判定：官方返回 ${violations === null ? 'null' : typeof violations}，预期为违规数组；不能按 0 项通过处理`)
			const list = violations
			let editorVersion: string | undefined
			try {
				const version = eda.sys_Environment?.getEditorCurrentVersion?.()
				if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:$|[-+\s])/.test(version.trim()))
					editorVersion = version.trim()
			}
			catch {
				// DRC remains useful when the host version endpoint is unavailable; coordinates stay raw and unconverted.
			}
			const rawCoordinatesAre10Mil = editorVersion === '4.1.78'
			// 0.10.25 归一化重写（0.10.24 装机实锤真实结构）：官方返回的是**树形分组**——
			// [{ name:'Connection Error', list:[{ name:'GND', list:[叶...] }] }]，
			// 叶字段：errorType/errorObjType/ruleName/net/explanation{str,param}/errData{position,obj1,obj1Type,errorType,obj1Suffix,layerIds}/objs[primitiveId]/pos{x,y}/parentId('DRCTab|_|Errors|_|...')
			const severityOf = (parentId: unknown): string | undefined => {
				const s = String(parentId ?? '')
				if (/\|_\|Errors\|_\|/i.test(s))
					return 'error'
				if (/\|_\|Warnings\|_\|/i.test(s))
					return 'warn'
				return undefined
			}
			const flat: Array<Record<string, unknown>> = []
			const walk = (node: any, groupName?: string, groupNet?: string) => {
				if (node == null || typeof node !== 'object') {
					flat.push({ message: String(node) })
					return
				}
				const isLeaf = node.errData != null || node.objs != null || node.errorType != null
				if (!isLeaf && Array.isArray(node.list)) {
					// 第一层分组的 name 是规则类别（rule），第二层是网络名（net），更深同理下传
					const isTop = groupName === undefined
					for (const child of node.list) {
						walk(
							child,
							isTop ? (node.name != null ? String(node.name) : undefined) : groupName,
							isTop ? groupNet : (node.name != null ? String(node.name) : groupNet),
						)
					}
					return
				}
				// 叶子：按实测结构提取（errData 嵌在 explanation 内部：leaf.explanation.errData）
				const explanation = node.explanation ?? {}
				const errData = node.errData ?? explanation.errData ?? {}
				const pos = node.pos ?? errData.position ?? {}
				const objs = Array.isArray(node.objs) ? node.objs.map(String) : (errData.obj1 != null ? [String(errData.obj1)] : [])
				const hasPosition = pos.x != null || pos.y != null
				const convertedPosition = rawCoordinatesAre10Mil
					&& typeof pos.x === 'number' && Number.isFinite(pos.x)
					&& typeof pos.y === 'number' && Number.isFinite(pos.y)
				flat.push({
					...(severityOf(node.parentId) ? { type: severityOf(node.parentId) } : {}),
					...(groupName != null ? { rule: groupName } : (node.ruleName != null ? { rule: String(node.ruleName) } : {})),
					...(node.ruleName != null ? { ruleName: String(node.ruleName) } : {}),
					...(errData.errorType != null || node.errorType != null ? { errorType: String(errData.errorType ?? node.errorType) } : {}),
					...(explanation.str != null ? { message: String(explanation.str), ...(explanation.param ? { messageParams: explanation.param } : {}) } : {}),
					...(node.net != null ? { net: String(node.net) } : (groupNet != null ? { net: groupNet } : (errData.net != null ? { net: String(errData.net) } : {}))),
					...(objs.length ? { primitiveId: objs[0], primitiveIds: objs } : {}),
					...(node.errorObjType != null || errData.obj1Type != null ? { objectType: String(node.errorObjType ?? errData.obj1Type) } : {}),
					...(errData.obj1Suffix != null ? { objectName: String(errData.obj1Suffix) } : {}),
					...(pos.x != null ? { x: pos.x } : {}),
					...(pos.y != null ? { y: pos.y } : {}),
					...(hasPosition ? {
						rawCoordinateUnit: rawCoordinatesAre10Mil ? '10mil' : 'unknown',
					...(convertedPosition ? { xMil: Math.round(pos.x * 10 * 1_000_000) / 1_000_000, yMil: Math.round(pos.y * 10 * 1_000_000) / 1_000_000, coordinateUnit: 'mil' } : {}),
					} : {}),
					...(Array.isArray(errData.layerIds) ? { layerIds: errData.layerIds } : {}),
					raw: node, // 原始叶兜底，字段没提全时自取
				})
			}
			for (const v of list)
				walk(v)
			const normalized = flat
			const totalCount = normalized.length
			const fatalCount = normalized.filter(v => /fatal|error/i.test(String(v.type ?? ''))).length
			const warnCount = normalized.filter(v => /warn/i.test(String(v.type ?? ''))).length
			return { passed: totalCount === 0, totalCount, fatalCount, warnCount, violations: normalized }
		},
	},
	{
		name: 'pcb.importChanges',
		summary: '将当前 Board 关联或指定原理图的多页变更导入 PCB；按组件身份、位号、封装映射和逐引脚网络读回核验，内容不符或未知时阻止后续依赖',
		params: [
			{ name: 'schematicUuid', type: 'string', description: '原理图 UUID，默认同 Board 关联的原理图' },
		],
		returns: '{ imported, sdkResult, outcome, importRequested, contentsVerified, completionVerified, verificationScope, persistenceVerified:false, documentUuid, schematicUuid, managedComponents, checkedComponents, pcbOnlyPreserved, differences }；核验范围只含器件身份、位号、封装关联和焊盘网络，不覆盖设计规则、保存、布局布线或铺铜',
		example: { cmd: 'pcb.importChanges' },
		handler: async (params) => importAndVerifyChanges(eda as any, params),
	},
	{
		name: 'pcb.drawOutline',
		summary: '绘制矩形板框（板框层，单位 mil）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '左下角 X（mil，PCB 画布 +Y 向上）' },
			{ name: 'y', type: 'number', required: true, description: '左下角 Y（mil）' },
			{ name: 'width', type: 'number', required: true, description: '宽度（mil，50mm = 1969）' },
			{ name: 'height', type: 'number', required: true, description: '高度（mil，40mm = 1575）' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'pcb.drawOutline', params: { x: 0, y: 0, width: 1969, height: 1575 } },
		handler: async (params) => {
			if ([params.x, params.y, params.width, params.height].some(v => v == null))
				throw new Error('缺少参数 x / y / width / height')
			// 板框层 ID = 11；直线接口不接受板框层，须用多边形接口
			// 官方 'R' 矩形的 (x,y) 是**左上角**（画布 +Y 向上，矩形向下延伸），
			// 本指令对外约定 (x,y) 为**左下角**，此处换算：官方y = 左下角y + height
			const polygon = eda.pcb_MathPolygon.createPolygon([
				'R',
				Number(params.x), Number(params.y) + Number(params.height),
				Number(params.width), Number(params.height),
				0, 0,
			])
			let outline: any
			try {
				outline = await eda.pcb_PrimitivePolyline.create('', 11 as any, polygon as any, 6)
			}
			catch (err) {
				throw wrapCreateError('板框创建', err)
			}
			if (!outline)
				throw new Error('板框创建失败（官方返回空；若已有板框请先 pcb.delete 旧板框）')
			return { primitiveId: safeState<string>(outline, 'getState_PrimitiveId') }
		},
	},
	{
		name: 'pcb.listNets',
		summary: '列出 PCB 全部网络',
		params: [],
		returns: '网络名列表',
		example: { cmd: 'pcb.listNets' },
		handler: async () => {
			return await eda.pcb_Net.getAllNetsName()
		},
	},
	{
		name: 'pcb.save',
		summary: '保存当前 PCB（注意：官方在无修改时返回 false，不代表失败）',
		params: [],
		returns: '{ saved, note? }',
		example: { cmd: 'pcb.save' },
		handler: async () => {
			const saved = await eda.pcb_Document.save()
			return saved
				? { saved: true }
				: { saved: false, note: '官方在无修改时返回 false，不代表保存失败；若此前确有修改，请确认 PCB 文档处于正常可写状态' }
		},
	},
	{
		name: 'pcb.delete',
		summary: '删除 PCB 图元（器件 / 走线 / 过孔 / 铺铜 / 板框(Region) / 文字等，按 primitiveId，可批量）；先识别类型再删，删后读回验证，杜绝假成功。按 batchSize 分批（默认 10，批间停 300ms）；确认某项仍存在时记录失败并继续，写入结果未知、超时或读回失败时停止后续删除；全局时间预算 100s（耗尽停开新项、累积结果照常返回），unprocessed 清单可续删',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '要删除的图元 ID 列表' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 10：每批之间停 300ms 并记录分批进度。大批删除建议保持默认多次调用，不要一次调大硬跑' },
		],
		returns: '{ taskId, deleted: [...], failed: [...], deletedBy: { id: type }, reconciled?, sessionHealth?, batches?, unprocessed?, failedNote? }（taskId 可配合 task.get 在客户端超时后查进度/补取结果——0.10.42 起同参数任务在跑时重发只回进度不重复执行；unprocessed 为熔断/预算退出时未轮到的 ID，再次调用接着删；0.10.25 起整批结束后终扫对账：报失败但实际已被后台删除的项挪入 deleted 并在 reconciled 注明；0.10.27 起出现过 reconciled/failed 时追加会话健康探针 sessionHealth: ok|degraded|inconclusive，degraded 建议只读复核后再决定是否不保存重开页面，inconclusive 为探针未得出可信结论（不采信）；0.10.40 起探针加固：焦点复核+3 次重试+创建/删除读回，删除异常时报 probeResidue 残留探针 ID）',
		example: { cmd: 'pcb.delete', params: { primitiveIds: ['xxx', 'yyy'] } },
		handler: async (params, ctx) => {
			const rawIds = Array.isArray(params.primitiveIds)
				? params.primitiveIds
				: params.primitiveIds == null ? [] : [params.primitiveIds]
			if (!rawIds.length || rawIds.some(id => !String(id).trim()))
				throw new Error('primitiveIds 不能为空')
			const ids = rawIds.map(String)
			// 0.10.42 任务登记（KIMI-EDA-20261002-03）：客户端超时后可凭 taskId 查实时进度/补取结果；
			// 相同 ID 清单的任务仍在跑时直接返回现有进度，不重复执行（防盲重发）
			// 0.10.49：onUpdate 心跳——任务进度每次更新都推给代理，重置其超时计时器
			const { task, existing } = beginTask('pcb.delete', { primitiveIds: [...ids].sort() },
				ctx && ((t) => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress })))
			if (existing)
				return {
					taskId: task.id,
					alreadyRunning: true,
					state: task.state,
					progress: task.progress,
					note: '相同删除任务仍在后台执行——这是实时进度，用 task.get 继续查询即可，不要重发（重发不会重复执行）',
				}
			try {
			// 各类图元的 列表/删除 接口（官方单对象 get() 有缓存：删除后仍返回旧对象、不匹配 ID 也可能命中，
			// 一律用 getAllPrimitiveId() 成员判定，delete 前识别真实类型，删后读回验证）
			const kinds: Array<{
				type: string
				list: () => Promise<Array<string>>
				del: (list: Array<string>) => Promise<boolean>
			}> = [
				{ type: 'component', list: () => eda.pcb_PrimitiveComponent.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveComponent.delete(list) },
				{ type: 'line', list: () => eda.pcb_PrimitiveLine.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveLine.delete(list) },
				{ type: 'via', list: () => eda.pcb_PrimitiveVia.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveVia.delete(list) },
				{ type: 'pour', list: () => eda.pcb_PrimitivePour.getAllPrimitiveId(), del: list => eda.pcb_PrimitivePour.delete(list) },
				{ type: 'polyline', list: () => eda.pcb_PrimitivePolyline.getAllPrimitiveId(), del: list => eda.pcb_PrimitivePolyline.delete(list) },
				{ type: 'text', list: () => eda.pcb_PrimitiveString.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveString.delete(list) },
				{ type: 'region', list: () => eda.pcb_PrimitiveRegion.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveRegion.delete(list) },
				{ type: 'fill', list: () => eda.pcb_PrimitiveFill.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveFill.delete(list) },
				{ type: 'arc', list: () => eda.pcb_PrimitiveArc.getAllPrimitiveId(), del: list => eda.pcb_PrimitiveArc.delete(list) },
			]
			const detectType = async (id: string): Promise<(typeof kinds)[number] | undefined> => {
				let enumerationFailed: unknown
				for (const kind of kinds) {
					try {
						if ((await kind.list()).includes(id))
							return kind
					}
					catch (error) {
						// 若没有任何类型命中，枚举失败必须保留为未知，不能当作对象不存在。
						enumerationFailed ??= error
					}
				}
				if (enumerationFailed)
					throw new Error(`图元类型读回未知：清单枚举失败（${String((enumerationFailed as any)?.message ?? enumerationFailed)}）`)
				return undefined
			}
			const deleted: Array<string> = []
			const failed: Array<string> = []
			const deletedBy: Record<string, string> = {}
			// 逐项超时停止后续删除；只有读回确认仍存在的项目归为已知未删除并可继续。
			// 分批和全局预算用于控制批次间隔及长任务收尾；每项是否删除仍以读回为准。
			const PER_ITEM_TIMEOUT_MS = 8000
			const GLOBAL_BUDGET_MS = 100000 // 扩展侧该指令超时已放宽到 140s，留 40s 余量给收尾与传输
			const batchSize = Math.max(1, Number(params.batchSize) || 10)
			const startedAt = Date.now()
			const batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> = []
			const attempted = new Set<string>()
			const diagnostics: Array<string> = []
			const failReason = new Map<string, string>() // 0.10.41：记录每项失败原因，终扫对账排除「从不存在」的 ID
			let circuitBroken = false
			let budgetExhausted = false
			class ConfirmedNotDeletedError extends Error {}
			const deleteOne = async (id: string): Promise<void> => {
				const kind = await detectType(id)
				if (!kind)
					throw new ConfirmedNotDeletedError('图元在完整类型清单中不存在，未调用删除接口')
				const sdkDeleted = await kind.del([id])
				// 删后读回验证：还能查到就是假成功。
				// 官方 get() 有缓存延迟，需等待并重试，否则会误报失败
				let stillThere = true
				for (const waitMs of [400, 600, 1000]) {
					await new Promise(resolve => setTimeout(resolve, waitMs))
					stillThere = Boolean(await detectType(id))
					if (!stillThere)
						break
				}
				if (stillThere)
					throw new ConfirmedNotDeletedError(sdkDeleted === false ? '官方返回 false，且删后读回确认图元仍在' : '删后读回确认图元仍在（未删除）')
				deletedBy[id] = kind.type
			}
			for (let bi = 0; bi < ids.length; bi += batchSize) {
				if (circuitBroken || budgetExhausted)
					break
				if (bi > 0)
					await new Promise(resolve => setTimeout(resolve, 300)) // 批间停顿，给官方编辑器喘息
				const batch = ids.slice(bi, bi + batchSize)
				let bDeleted = 0
				let bFailed = 0
				for (const id of batch) {
					if (circuitBroken)
						break
					if (Date.now() - startedAt > GLOBAL_BUDGET_MS) {
						budgetExhausted = true
						diagnostics.push(`全局时间预算耗尽（>${GLOBAL_BUDGET_MS / 1000}s），停止开新项，已累积结果照常返回；剩余 ID 请再次调用本指令续删`)
						break
					}
					attempted.add(id)
					try {
						await Promise.race([
							deleteOne(id),
							new Promise((_, reject) => setTimeout(() => reject(new Error(`单项超时（>${PER_ITEM_TIMEOUT_MS / 1000}s，疑似官方弹模态框或卡死）`)), PER_ITEM_TIMEOUT_MS)),
						])
						deleted.push(id)
						bDeleted++
					}
					catch (e: any) {
						failReason.set(id, String(e?.message ?? e))
						failed.push(id)
						bFailed++
						diagnostics.push(`${id}: ${String(e?.message ?? e)}`)
						if (!(e instanceof ConfirmedNotDeletedError)) {
							circuitBroken = true
							diagnostics.push('⚠️ 删除结果未知（SDK 异常、单项超时或读回失败），停止后续删除；请用只读清单核对现场后再决定下一步')
						}
					}
				}
				batches.push({ batch: batches.length + 1, attempted: batch.length, deleted: bDeleted, failed: bFailed })
				taskProgress(task, { stage: 'deleting', batches: [...batches], deleted: [...deleted], failed: [...failed], remaining: ids.length - attempted.size })
			}
			const unprocessed = ids.filter(id => !attempted.has(id))
			// 0.10.25 终扫对账（与 schematic.delete 同款）：官方 delete 假超时/后台继续删，
			// 整批结束后重新全量枚举，已不存在的「失败」项挪到 deleted 并注明；仍存在的保留 failed 附 failedNote
			const reconciled: Array<{ id: string, note: string }> = []
			if (failed.length) {
				try {
					taskProgress(task, { stage: 'final-sweep' })
					await new Promise(resolve => setTimeout(resolve, 1500))
					const alive = new Set<string>()
					let finalSweepComplete = true
					// 0.10.42：终扫枚举整体 20s 超时（旧版无保护，官方挂起时整批无返回）
					await withTimeout(Promise.all(kinds.map(async (k) => {
						try {
							for (const id of await k.list())
								alive.add(id)
						}
						catch { finalSweepComplete = false }
					})), 20000, '终扫枚举')
					for (const id of finalSweepComplete ? [...failed] : []) {
						if ((failReason.get(id) ?? '').includes('不存在'))
							continue // 0.10.41：从不存在的 ID 不参与对账（终扫必然查不到会误挪 deleted），保持 failed
						if (!alive.has(id)) {
							failed.splice(failed.indexOf(id), 1)
							deleted.push(id)
							reconciled.push({ id, note: '超时返回但后台已删除，经终扫确认' })
						}
					}
					if (!finalSweepComplete)
						diagnostics.push('终扫清单不完整，保留失败项未作删除结论')
					if (reconciled.length)
						diagnostics.push(`终扫对账：${reconciled.length} 个原报失败的 ID 已确认被后台删除（挪入 deleted）：${reconciled.map(r => r.id).join('、')}`)
				}
				catch { /* 终扫失败保持保守口径 */ }
			}
			// 0.10.27 会话健康探针 / 0.10.40 加固（与 schematic.delete 同步，GPT KIMI-EDA-20261002-02）：
			// 焦点文档复核（非 PCB 焦点→inconclusive 不误报）、create 最多 3 次重试（间隔 2s，多组候选坐标）、
			// 创建/删除均读回验证、删除失败报 probeResidue 供定点清理
			let sessionHealth: 'ok' | 'degraded' | 'inconclusive' | undefined
			let probeResidue: string | undefined
			if (reconciled.length || failed.length) {
				try {
					taskProgress(task, { stage: 'health-probe' })
					const doc = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined), 5000, '焦点文档查询')
					if (doc?.documentType !== 3) {
						sessionHealth = 'inconclusive'
						diagnostics.push(`会话健康探针未执行：焦点文档不是 PCB（documentType=${doc?.documentType ?? '无焦点'}），探针结果不可信未采信——请激活 PCB 页后用只读指令复核写通道`)
					}
					else {
						const candidates: Array<[number, number]> = [[0, 0], [500, 500], [2000, 2000]]
						let pid: string | undefined
						let probeErr = ''
						for (let attempt = 0; attempt < candidates.length && !pid; attempt++) {
							if (attempt)
								await new Promise(resolve => setTimeout(resolve, 2000))
							try {
								const [px, py] = candidates[attempt]
								const probeStr = await Promise.race([
									(eda.pcb_PrimitiveString.create as any)(13, px, py, 'spgprobe', 'default', 10, 2, 5, 0, false, 0, false, false),
									new Promise((_, reject) => setTimeout(() => reject(new Error('探针创建超时 10s')), 10000)),
								]) as any
								const got = safeState<string>(probeStr, 'getState_PrimitiveId')
								if (!got)
									throw new Error('探针创建未返回图元 ID')
								await new Promise(resolve => setTimeout(resolve, 400))
								const allIds = await withTimeout(eda.pcb_PrimitiveString.getAllPrimitiveId().catch(() => undefined), 10000, '探针读回') as any
								if (Array.isArray(allIds) && !allIds.map(String).includes(got)) {
									try { await eda.pcb_PrimitiveString.delete([got]) } catch { /* 清理失败忽略 */ }
									throw new Error('探针创建读回不存在（假成功）')
								}
								pid = got
							}
							catch (e: any) {
								probeErr = e instanceof Error ? e.message : JSON.stringify(e)
							}
						}
						if (!pid) {
							sessionHealth = 'degraded'
							diagnostics.push(`🛑 会话健康探针失败：创建阶段 3 次重试均失败（最后错误：${probeErr}）——读通道正常而创建持续失败才算写通道劣化，建议先只读复核再决定是否【不保存重开页面】`)
						}
						else {
							try {
								await withTimeout(eda.pcb_PrimitiveString.delete([pid]), 10000, '探针文字删除')
								await new Promise(resolve => setTimeout(resolve, 400))
								const left = await withTimeout(eda.pcb_PrimitiveString.getAllPrimitiveId().catch(() => undefined), 10000, '探针读回') as any
								if (Array.isArray(left) && left.map(String).includes(pid))
									throw new Error('删除读回仍存在')
								sessionHealth = 'ok'
							}
							catch (e: any) {
								sessionHealth = 'degraded'
								probeResidue = pid
								diagnostics.push(`🛑 会话健康探针失败：探针文字删除异常（${e instanceof Error ? e.message : JSON.stringify(e)}），残留探针文字 ${pid}（内容 spgprobe，会话恢复后用 pcb.delete 删它即可）`)
							}
						}
					}
				}
				catch (e: any) {
					sessionHealth = 'inconclusive'
					diagnostics.push(`会话健康探针自身异常（${e instanceof Error ? e.message : JSON.stringify(e)}），不采信也不影响删除结果`)
				}
			}
			if (!deleted.length)
				throw new Error(`删除失败：${ids.join(', ')}（图元不存在、被锁定或类型暂不支持；已读回验证）${diagnostics.length ? `。逐项诊断：${diagnostics.join('；')}` : ''}`)
			const deleteResult = {
				deleted,
				failed,
				deletedBy,
				...(reconciled.length ? { reconciled } : {}),
				...(sessionHealth ? { sessionHealth } : {}),
				...(sessionHealth === 'degraded' ? {
					warning: '🛑 会话健康探针失败（探针图元创建 3 次重试均败/删除异常）——EDA 写通道可能已损坏，本次删除结果仍有效；建议先用只读指令复核现场，再决定是否【不保存重开页面】后继续操作',
				} : {}),
				...(sessionHealth === 'inconclusive' ? {
					note: '会话健康探针未能得出可信结论（inconclusive，见 diagnostics），删除结果本身已经读回验证、不受影响',
				} : {}),
				...(probeResidue ? { probeResidue } : {}),
				...(batches.length > 1 ? { batches } : {}),
				...(unprocessed.length ? {
					unprocessed,
					resumeNote: `有 ${unprocessed.length} 个图元因熔断/时间预算未轮到处理——确认 EDA 会话健康后再次调用本指令即可接着删（已删的不会重复）`,
				} : {}),
				...(failed.length ? {
					failedNote: `${failed.length} 个图元经终扫确认仍存在（真失败，非后台已删）——确认会话健康后再次调用本指令续删：${failed.join('、')}`,
				} : {}),
				...(diagnostics.length ? { diagnostics } : {}),
			}
			finishTask(task, deleteResult)
			return { taskId: task.id, ...deleteResult }
			}
			catch (e) {
				failTask(task, e)
				throw e
			}
		},
	},
	{
		name: 'pcb.getComponentPads',
		summary: '读取 PCB 器件的全部焊盘（编号、网络、坐标、层）——验证原理图导入后网络是否正确的关键指令',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: 'PCB 器件图元 ID' },
		],
		returns: '焊盘列表 [{ padId, padNumber, net, x, y, layer, rotation, shape, heatWelding }]；padId来自焊盘图元实际PrimitiveId（读取失败时为null，不伪造）。heatWelding.status 为 null/config/unavailable/exception/invalid；exception.error 仅含 message，config.value 仅含 connectionMethod、divergenceSpacing、divergenceLineWidth、divergenceAngle',
		example: { cmd: 'pcb.getComponentPads', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			if (!pads?.length)
				throw new Error('未找到该器件的焊盘（请先激活对应 PCB）')
			return pads.map(p => ({
				padId: safeState<string>(p, 'getState_PrimitiveId') ?? null,
				padNumber: safeState<string>(p, 'getState_PadNumber'),
				net: safeState<string>(p, 'getState_Net'),
				x: safeState<number>(p, 'getState_X'),
				y: safeState<number>(p, 'getState_Y'),
				layer: safeState<number>(p, 'getState_Layer'),
				rotation: safeState<number>(p, 'getState_Rotation'),
				shape: safeState<Array<unknown>>(p, 'getState_Pad'),
				heatWelding: heatWeldingReadback(p),
			}))
		},
	},
	{
		name: 'pcb.connectComponentPadDirect',
		summary: '暂时停用：当前公开热焊写入接口的写后读回不可靠；待确认有可靠接口后再恢复',
		params: [
			{ name: 'documentUuid', type: 'string', required: true, description: '当前 PCB 文档 UUID，必须与焦点文档一致' },
			{ name: 'componentId', type: 'string', required: true, description: 'PCB 器件图元 ID' },
			{ name: 'padNumber', type: 'string', required: true, description: '封装焊盘编号；同编号重复时须传 padId 消歧' },
			{ name: 'padId', type: 'string', description: '可选焊盘图元 ID，用于同编号重复焊盘消歧' },
			{ name: '_timeoutMs', type: 'number', description: '整条命令共享时间预算（毫秒，有效预算最少 1000、默认 290000，最大 2147483647）' },
		],
		returns: '当前始终抛出暂时停用错误；error.cause={ disabled:true, retryable:false, writeAttempted:false }。不访问工程或SDK。',
		example: { cmd: 'pcb.connectComponentPadDirect', params: { documentUuid: 'pcb-uuid', componentId: 'component-id', padNumber: '1' } },
		handler: async () => {
			throw new Error('pcb.connectComponentPadDirect 暂时停用：当前公开热焊写入接口的写后读回不可靠，待确认有可靠接口后再恢复', {
				cause: { disabled: true, retryable: false, writeAttempted: false },
			})
		},
	},
	{
		name: 'pcb.checkPlacement',
		summary: 'PCB 布局间距检查：按焊盘旋转后的外接包围盒报告器件重叠与间距不足；未知或不支持的焊盘形状会跳过并令 complete=false。同时返回已检查器件的外形尺寸',
		params: [
			{ name: 'minClearance', type: 'number', description: '最小允许间距（mil，默认 0，即只报重叠）' },
			{ name: 'margin', type: 'number', description: '本体余量（mil，默认 0）：焊盘包围盒四向外扩，近似器件本体（连接器/电感本体大于焊盘，建议 10~30）' },
			{ name: 'designators', type: 'string[]', description: '只检查这些位号（留空为全部）' },
		],
		returns: '{ complete, components: [{ designator, layer, bbox:{x1,y1,x2,y2,w,h} }], overlaps: [{ a, b, overlapX, overlapY }], violations: [{ a, b, gap }], skippedNoPads?: [designator], skippedUnsupported?: [{ designator, primitiveId, padIndex, reason }] }',
		example: { cmd: 'pcb.checkPlacement', params: { minClearance: 20, margin: 15 } },
		handler: async (params) => {
			const minClearance = params.minClearance != null ? parseFiniteNumber(params.minClearance, 'minClearance') : 0
			if (minClearance < 0)
				throw new Error('minClearance 不能为负数')
			const margin = params.margin != null ? Number(params.margin) : 0
			const filter = Array.isArray(params.designators)
				? new Set(params.designators.map(String))
				: undefined
			const comps = (await eda.pcb_PrimitiveComponent.getAll()) ?? []
			type BBox = { x1: number, y1: number, x2: number, y2: number }
			const items: Array<{ designator: string, layer: number, bbox: BBox }> = []
			const skipped: Array<string> = []
			const skippedUnsupported: Array<{ designator: string, primitiveId: string, padIndex: number, reason: string }> = []
			for (const c of comps) {
				const designator = safeState<string>(c, 'getState_Designator') ?? ''
				if (!designator || (filter && !filter.has(designator)))
					continue
				const primitiveId = safeState<string>(c, 'getState_PrimitiveId')
				const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(primitiveId))
				if (!pads?.length) {
					skipped.push(designator)
					continue
				}
				let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
				let invalidReason = ''
				let invalidPadIndex = -1
				for (let padIndex = 0; padIndex < pads.length; padIndex++) {
					const p = pads[padIndex]
					const px = safeState<number>(p, 'getState_X')
					const py = safeState<number>(p, 'getState_Y')
					const rotation = safeState<number>(p, 'getState_Rotation')
					const shape = safeState<Array<unknown>>(p, 'getState_Pad')
					if (typeof px !== 'number' || !Number.isFinite(px) || typeof py !== 'number' || !Number.isFinite(py) || typeof rotation !== 'number' || !Number.isFinite(rotation) || !Array.isArray(shape)) {
						invalidReason = `pad ${padIndex + 1} 坐标、旋转或形状字段无效`
						invalidPadIndex = padIndex
						break
					}
					const type = String(shape[0] ?? '').toUpperCase()
					const a = shape[1], b = shape[2]
					if (type === 'POLYGON') {
						invalidReason = `pad ${padIndex + 1} 形状 POLYGON 当前未支持；未纳入间距检查`
						invalidPadIndex = padIndex
						break
					}
					if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) {
						invalidReason = `pad ${padIndex + 1} 尺寸无效`
						invalidPadIndex = padIndex
						break
					}
					const rad = rotation * Math.PI / 180
					const co = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad))
					let hw: number, hh: number
					if (type === 'RECT') {
						if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) { invalidReason = `pad ${padIndex + 1} 矩形高度无效`; invalidPadIndex = padIndex; break }
						hw = (a * co + b * si) / 2
						hh = (a * si + b * co) / 2
					}
					else if (type === 'ELLIPSE') {
						if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) { invalidReason = `pad ${padIndex + 1} 椭圆高度无效`; invalidPadIndex = padIndex; break }
						hw = Math.sqrt((a * co) ** 2 + (b * si) ** 2) / 2
						hh = Math.sqrt((a * si) ** 2 + (b * co) ** 2) / 2
					}
					else if (type === 'OVAL') {
						if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) { invalidReason = `pad ${padIndex + 1} 椭圆胶囊高度无效`; invalidPadIndex = padIndex; break }
						const radius = Math.min(a, b) / 2
						const axis = Math.abs(a - b) / 2
						const horizontalMajor = a >= b
						hw = radius + axis * (horizontalMajor ? co : si)
						hh = radius + axis * (horizontalMajor ? si : co)
					}
					else if (type === 'NGON') {
						// 第 3 项是边数，不是高度；外接圆给出安全保守包围盒。
						if (typeof b !== 'number' || !Number.isInteger(b) || b <= 2) { invalidReason = `pad ${padIndex + 1} NGON 边数无效`; invalidPadIndex = padIndex; break }
						hw = hh = a / 2
					}
					else {
						invalidReason = `pad ${padIndex + 1} 形状 ${type || '(空)'} 不支持`
						invalidPadIndex = padIndex
						break
					}
					x1 = Math.min(x1, px - hw)
					y1 = Math.min(y1, py - hh)
					x2 = Math.max(x2, px + hw)
					y2 = Math.max(y2, py + hh)
				}
				if (invalidReason) {
					skippedUnsupported.push({ designator, primitiveId: String(primitiveId ?? ''), padIndex: invalidPadIndex + 1, reason: invalidReason })
					continue
				}
				items.push({
					designator,
					layer: safeState<number>(c, 'getState_Layer') ?? 0,
					bbox: {
						x1: x1 - margin, y1: y1 - margin,
						x2: x2 + margin, y2: y2 + margin,
					},
				})
			}
			// 同层器件两两求包围盒间隙（负值即重叠）
			const overlaps: Array<{ a: string, b: string, overlapX: number, overlapY: number }> = []
			const violations: Array<{ a: string, b: string, gap: number }> = []
			for (let i = 0; i < items.length; i++) {
				for (let j = i + 1; j < items.length; j++) {
					const A = items[i], B = items[j]
					if (A.layer !== B.layer)
						continue
					const gapX = Math.max(B.bbox.x1 - A.bbox.x2, A.bbox.x1 - B.bbox.x2)
					const gapY = Math.max(B.bbox.y1 - A.bbox.y2, A.bbox.y1 - B.bbox.y2)
					if (gapX < 0 && gapY < 0)
						overlaps.push({ a: A.designator, b: B.designator, overlapX: -gapX, overlapY: -gapY })
					else {
						const gap = Math.round(Math.max(gapX, gapY) * 10) / 10
						if (gap < minClearance)
							violations.push({ a: A.designator, b: B.designator, gap })
					}
				}
			}
			return {
				components: items.map(it => ({
					designator: it.designator,
					layer: it.layer,
					bbox: { ...it.bbox, w: it.bbox.x2 - it.bbox.x1, h: it.bbox.y2 - it.bbox.y1 },
				})),
				complete: skipped.length === 0 && skippedUnsupported.length === 0,
				overlaps,
				violations,
				...(skipped.length ? { skippedNoPads: skipped } : {}),
				...(skippedUnsupported.length ? { skippedUnsupported } : {}),
			}
		},
	},
	{
		name: 'pcb.exportGerber',
		summary: '导出 Gerber 打板文件（返回 base64，通常为 zip 压缩包，AI 可自行落盘）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 gerber' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'pcb.exportGerber' },
		handler: async (params) => {
			const file = await eda.pcb_ManufactureData.getGerberFile(
				params.fileName ? String(params.fileName) : undefined,
			)
			const result = await fileToResult(file, 'gerber.zip')
			if (!result)
				throw new Error('Gerber 导出失败：官方返回空（请确认已激活 PCB 文档）')
			return result
		},
	},
	{
		name: 'pcb.exportPickPlace',
		summary: '导出贴片坐标文件（Pick and Place，返回 base64）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 pick-and-place' },
			{ name: 'fileType', type: 'string', description: 'xlsx | csv，默认 csv' },
			{ name: 'unit', type: 'string', description: 'mm | mil，默认 mm' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'pcb.exportPickPlace', params: { fileType: 'csv', unit: 'mm' } },
		handler: async (params) => {
			const fileType = String(params.fileType ?? 'csv').trim().toLowerCase()
			if (fileType !== 'xlsx' && fileType !== 'csv')
				throw new Error(`无效 fileType：${String(params.fileType)}（仅支持 xlsx | csv）`)
			const unitName = String(params.unit ?? 'mm').trim().toLowerCase()
			if (unitName !== 'mm' && unitName !== 'mil')
				throw new Error(`无效 unit：${String(params.unit)}（贴片坐标 API 仅支持 mm | mil）`)
			const unit = unitName as ESYS_Unit.MIL | ESYS_Unit.MILLIMETER
			const file = await eda.pcb_ManufactureData.getPickAndPlaceFile(
				params.fileName ? String(params.fileName) : undefined,
				fileType,
				unit,
			)
			const result = await fileToResult(file, `pick-and-place.${fileType}`)
			if (!result)
				throw new Error('贴片坐标导出失败：官方返回空（请确认已激活 PCB 文档）')
			return result
		},
	},
	{
		name: 'pcb.exportDsn',
		summary: '导出 Specctra DSN，修复已确认的 class 网络引用引号，并按已读回的实填充补写支持的内层平面；原始文件和转换诊断一并返回，其他约束仍须核对',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 board' },
			{ name: 'applyLayerWidthRules', type: 'boolean', description: '可选：仅当源码、焦点及逐层preferred线宽证据均已确认时，将已知DEFAULT层宽及网络class层宽差异写入DSN；默认false' },
		],
		returns: '{ fileName, size, mimeType, base64, original, routeBaseline?, conversion:{changed, changes, warnings, limitations, slotClearance?}, widthRuleComparison, routingConstraintsComplete:false }；源码稳定时routeBaseline绑定当前documentUuid、有效ARC源码记录及实际最终DSN中的完整protect wire，可传给pcb.importAutoRouteSes；基线不完整时明确标为incomplete，导入前将拒绝按ARC保护链消解；widthRuleComparison对比最终DSN与EDA线宽范围；默认不改DSN，applyLayerWidthRules:true时补写已确认的默认层rule与网络class层宽，并由conversion逐项披露。EDA4.1.78中，NORMAL/mil/open的显式NET多行TRACK规则仅在源码、唯一简单NET selector、SDK NET绑定及全部启用SIGNAL层ID逐层一致时按层确认；层范围不同时网络对照的layers列出各层结果，聚合项不提供单层范围。DEFAULT、NET与NET_CLASS多行规则可在完整逐层证据满足时按层确认；4.1.78中已验证形态的NET SAFE+TRACK可在SAFE引用结构及SDK双绑定一致时独立确认TRACK，同原始SAFE ID的严格ticket历史可消解到唯一最新实体，未消解删除或冲突仍未知；NET_CLASS混合在NET明确TRACK-only或自身SAFE／TRACK均经唯一SDK确认时可独立确认TRACK，显式NET优先；空NET继承仍未知。无structure base但完整默认层覆盖时可比较，转换为缺失层写明确preferred，非法base不作缺省。槽孔仅在原默认SAFE profile及已核对TRACK-only类结构、有效PAD_NET或独立NORMAL焊盘网络覆盖下补偿，不解释新的SAFE间距语义。preferred是配置值，不证明交互落线宽度；其余约束仍未完整表达',
		example: { cmd: 'pcb.exportDsn' },
		handler: async (params) => {
			if (params.applyLayerWidthRules !== undefined && typeof params.applyLayerWidthRules !== 'boolean')
				throw new Error('applyLayerWidthRules 必须是布尔值')
			const applyLayerWidthRulesRequested = params.applyLayerWidthRules === true
			const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			const documentUuid = focus?.documentType === 3 && typeof focus.uuid === 'string' && focus.uuid ? focus.uuid : undefined
			if (applyLayerWidthRulesRequested && !documentUuid)
				throw new Error('启用applyLayerWidthRules时必须先确认当前PCB焦点')
			let documentSource: string | undefined
			let snapshotWarning: string | undefined
			if (documentUuid) {
				try {
					const value = await eda.sys_FileManager.getDocumentSource()
					if (typeof value === 'string') documentSource = value
					else snapshotWarning = 'SDK 未返回 PCB 源码快照'
				}
				catch (error) { snapshotWarning = `读取 PCB 源码快照失败：${String((error as any)?.message ?? error)}` }
			}
			else snapshotWarning = '未能确认当前 PCB 焦点'
			const file = await eda.pcb_ManufactureData.getDsnFile(
				params.fileName ? String(params.fileName) : 'board',
			)
			const result = await fileToResult(file, 'board.dsn')
			if (!result)
				throw new Error('DSN 导出失败：官方返回空（请确认已激活 PCB 文档）')
			const source = new TextDecoder('utf-8', { fatal: true }).decode(await file!.arrayBuffer())
			const repaired = repairDsnClassNetReferences(source)
			let documentSourceAfterDsn: string | undefined
			if (documentSource !== undefined) {
				try { documentSourceAfterDsn = await eda.sys_FileManager.getDocumentSource() }
				catch (error) { snapshotWarning = `导出 DSN 后复核源码快照失败：${String((error as any)?.message ?? error)}` }
			}
			const exportSnapshotComparison = documentSource === undefined || documentSourceAfterDsn === undefined
				? undefined
				: comparePcbSourceSnapshots(documentSource, documentSourceAfterDsn)
			const prepared = documentSource !== undefined && exportSnapshotComparison?.matches
				? await prepareDsnWithPouredPlanes(eda, repaired.text, documentUuid!, documentSource)
				: { ...repaired, warnings: [...repaired.warnings, `${snapshotWarning ?? `导出 DSN 后 PCB 源码快照不匹配：${exportSnapshotComparison?.reason ?? '无法比较'}，保留原 DSN 平面内容`}`], limitations: [...repaired.limitations, '源码快照不可用或不稳定时不补写内层平面'] }
			let documentSourceAfterPreparation: string | undefined
			if (documentSource !== undefined) {
				try { documentSourceAfterPreparation = await eda.sys_FileManager.getDocumentSource() }
				catch (error) { snapshotWarning = `复核 PCB 源码快照失败：${String((error as any)?.message ?? error)}` }
			}
			const preparationSnapshotComparison = documentSource === undefined || documentSourceAfterPreparation === undefined
				? undefined
				: comparePcbSourceSnapshots(documentSource, documentSourceAfterPreparation)
			const stablePrepared = documentSource !== undefined && preparationSnapshotComparison?.matches
				? prepared
				: { ...repaired, warnings: [...prepared.warnings, `${snapshotWarning ?? `准备 DSN 后 PCB 源码快照不匹配：${preparationSnapshotComparison?.reason ?? '无法比较'}，保留原 DSN 平面内容`}`], limitations: [...prepared.limitations, '源码快照不可用或不稳定时不补写内层平面'] }
		const slotPrepared = documentSource !== undefined && preparationSnapshotComparison?.matches
			? await prepareDsnWithSlotClearances(eda, stablePrepared, documentUuid!, documentSource)
			: { ...stablePrepared, warnings: [...stablePrepared.warnings, '槽孔补偿未运行：源码快照不可用或不稳定'], limitations: [...stablePrepared.limitations, '槽孔补偿要求可复核的稳定 PCB 源码快照'] }
			const widthUnknowns: string[] = []
			let widthSourceStable = true
			const widthEvidence = await readRoutingWidthEvidence(documentSource, { timeoutMs: 5000, readLayers: true })
			widthUnknowns.push(...widthEvidence.unknowns)
			if (documentUuid) {
				try { await assertRoutingSourceStable(documentUuid, documentSource, 5000, 'DSN 线宽规则读取') }
				catch (error) { widthSourceStable = false; widthUnknowns.push(`线宽规则读取后源码/焦点无法确认：${String((error as any)?.message ?? error)}`) }
			}
			let finalPrepared = slotPrepared
			if (applyLayerWidthRulesRequested) {
				if (!documentUuid || documentSource === undefined || documentSourceAfterDsn === undefined || !exportSnapshotComparison?.matches
					|| documentSourceAfterPreparation === undefined || !preparationSnapshotComparison?.matches || !widthSourceStable || !widthEvidence.snapshot)
					throw new Error('启用applyLayerWidthRules时，PCB源码/焦点/逐层线宽证据必须从DSN导出到转换完成保持已确认')
				await assertRoutingSourceStable(documentUuid, documentSourceAfterPreparation, 5000, 'DSN分层线宽转换')
				finalPrepared = applyDsnLayerWidthRules(widthEvidence.snapshot, slotPrepared.text)
			}
			let widthRuleComparison = comparePreparedDsnWidth(widthEvidence.snapshot, finalPrepared.text, widthUnknowns)
			if (!widthSourceStable)
				widthRuleComparison = invalidateDsnWidthComparison(widthRuleComparison, '源码或焦点不稳定，规则对照结果不再代表当前 PCB')
			let routeBaseline: SesRouteBaseline | undefined
			if (documentUuid && documentSource !== undefined && widthSourceStable) {
				try { routeBaseline = buildSesRouteBaseline(documentUuid, documentSource, finalPrepared.text) }
				catch (error) {
					routeBaseline = { format: 'ai-command-engine-route-baseline/v1', version: 1, documentUuid, status: 'incomplete', arcs: [], protectedWires: [], issues: [`无法构造DSN ARC保护基线：${String((error as any)?.message ?? error)}`] }
				}
			}
			const converted = await fileToResult(new Blob([finalPrepared.text], { type: result.mimeType }), result.fileName)
			if (!converted) throw new Error('DSN 转换结果为空')
			const changes = [...new Map([...repaired.changes, ...slotPrepared.changes, ...finalPrepared.changes].map(change => [JSON.stringify(change), change])).values()]
			return { ...converted, original: result, conversion: { changed: repaired.changed || slotPrepared.changed || finalPrepared.changed, changes, warnings: [...new Set([...repaired.warnings, ...slotPrepared.warnings, ...finalPrepared.warnings])], limitations: [...new Set([...repaired.limitations, ...slotPrepared.limitations, ...finalPrepared.limitations])], ...(slotPrepared.slotClearance ? { slotClearance: slotPrepared.slotClearance } : {}) }, widthRuleComparison, routingConstraintsComplete: false, ...(routeBaseline ? { routeBaseline } : {}) }
		},
	},
	{
		name: 'pcb.exportNetlist',
		summary: '导出 PCB 网表文件（返回 base64）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 pcb-netlist' },
			{ name: 'netlistType', type: 'string', description: '网表格式，如 Protel2，默认官方默认格式' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'pcb.exportNetlist' },
		handler: async (params) => {
			const file = await eda.pcb_ManufactureData.getNetlistFile(
				params.fileName ? String(params.fileName) : undefined,
				params.netlistType ? String(params.netlistType) as any : undefined,
			)
			const result = await fileToResult(file, 'pcb-netlist.net')
			if (!result || !Number.isFinite(result.size) || result.size <= 0 || !result.base64)
				throw new Error('PCB 网表导出失败：官方返回空、零字节文件或空 base64')
			return result
		},
	},
	// ---------- 差分对 ----------
	{
		name: 'pcb.createDiffPair',
		summary: '创建差分对（USB D+/D- 等）',
		params: [
			{ name: 'name', type: 'string', required: true, description: '差分对名称，如 USB_DP_DM' },
			{ name: 'positiveNet', type: 'string', required: true, description: '正端网络名' },
			{ name: 'negativeNet', type: 'string', required: true, description: '负端网络名' },
		],
		returns: '{ created }',
		example: { cmd: 'pcb.createDiffPair', params: { name: 'USB_DP_DM', positiveNet: 'USB_DP', negativeNet: 'USB_DM' } },
		handler: async (params) => {
			if (!params.name || !params.positiveNet || !params.negativeNet)
				throw new Error('缺少参数 name / positiveNet / negativeNet')
			await ensureNetExists(String(params.positiveNet))
			await ensureNetExists(String(params.negativeNet))
			const created = await eda.pcb_Drc.createDifferentialPair(
				String(params.name), String(params.positiveNet), String(params.negativeNet),
			)
			return { created: Boolean(created) }
		},
	},
	{
		name: 'pcb.listDiffPairs',
		summary: '列出全部差分对',
		params: [],
		returns: '差分对列表',
		example: { cmd: 'pcb.listDiffPairs' },
		handler: async () => {
			return await eda.pcb_Drc.getAllDifferentialPairs()
		},
	},
	{
		name: 'pcb.deleteDiffPair',
		summary: '删除差分对',
		params: [
			{ name: 'name', type: 'string', required: true, description: '差分对名称' },
		],
		returns: '{ deleted }',
		example: { cmd: 'pcb.deleteDiffPair', params: { name: 'USB_DP_DM' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const deleted = await eda.pcb_Drc.deleteDifferentialPair(String(params.name))
			return { deleted: Boolean(deleted) }
		},
	},
	// ---------- 网络类 ----------
	{
		name: 'pcb.createNetClass',
		summary: '创建网络类（把一组网络归为一类，便于统一设规则）',
		params: [
			{ name: 'name', type: 'string', required: true, description: '网络类名称，如 POWER' },
			{ name: 'nets', type: 'string[]', required: true, description: '网络名列表' },
			{ name: 'color', type: 'string', description: '显示颜色（如 #FF0000），留空默认' },
		],
		returns: '{ created }',
		example: { cmd: 'pcb.createNetClass', params: { name: 'POWER', nets: ['3V3', '5V'] } },
		handler: async (params) => {
			if (!params.name || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 name / nets')
			for (const net of params.nets)
				await ensureNetExists(String(net))
			const created = await eda.pcb_Drc.createNetClass(
				String(params.name),
				params.nets.map(String),
				params.color ? parsePcbColor(params.color) : undefined as any,
			)
			if (created !== true)
				throw new Error(`创建网络类失败：官方接口返回 ${String(created)}`)
			return { created: true }
		},
	},
	{
		name: 'pcb.listNetClasses',
		summary: '列出全部网络类',
		params: [],
		returns: '网络类列表',
		example: { cmd: 'pcb.listNetClasses' },
		handler: async () => {
			return await eda.pcb_Drc.getAllNetClasses()
		},
	},
	{
		name: 'pcb.addNetToClass',
		summary: '把网络加入网络类',
		params: [
			{ name: 'netClass', type: 'string', required: true, description: '网络类名称' },
			{ name: 'nets', type: 'string[]', required: true, description: '网络名列表' },
		],
		returns: '{ added }',
		example: { cmd: 'pcb.addNetToClass', params: { netClass: 'POWER', nets: ['VBUS'] } },
		handler: async (params) => {
			if (!params.netClass || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 netClass / nets')
			const added = await eda.pcb_Drc.addNetToNetClass(String(params.netClass), params.nets.map(String))
			return { added: Boolean(added) }
		},
	},
	{
		name: 'pcb.removeNetFromClass',
		summary: '把网络移出网络类',
		params: [
			{ name: 'netClass', type: 'string', required: true, description: '网络类名称' },
			{ name: 'nets', type: 'string[]', required: true, description: '网络名列表' },
		],
		returns: '{ removed }',
		example: { cmd: 'pcb.removeNetFromClass', params: { netClass: 'POWER', nets: ['VBUS'] } },
		handler: async (params) => {
			if (!params.netClass || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 netClass / nets')
			const removed = await eda.pcb_Drc.removeNetFromNetClass(String(params.netClass), params.nets.map(String))
			return { removed: Boolean(removed) }
		},
	},
	{
		name: 'pcb.deleteNetClass',
		summary: '删除网络类',
		params: [
			{ name: 'name', type: 'string', required: true, description: '网络类名称' },
		],
		returns: '{ deleted }',
		example: { cmd: 'pcb.deleteNetClass', params: { name: 'POWER' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const deleted = await eda.pcb_Drc.deleteNetClass(String(params.name))
			return { deleted: Boolean(deleted) }
		},
	},
	{
		name: 'pcb.renameNetClass',
		summary: '重命名网络类',
		params: [
			{ name: 'name', type: 'string', required: true, description: '原网络类名称' },
			{ name: 'newName', type: 'string', required: true, description: '新网络类名称' },
		],
		returns: '{ renamed }',
		example: { cmd: 'pcb.renameNetClass', params: { name: 'POWER', newName: 'PWR' } },
		handler: async (params) => {
			if (!params.name || !params.newName)
				throw new Error('缺少参数 name / newName')
			const renamed = await eda.pcb_Drc.modifyNetClassName(String(params.name), String(params.newName))
			return { renamed: Boolean(renamed) }
		},
	},
	{
		name: 'pcb.getNetRules',
		summary: '读取当前设计规则中的网络规则（线宽/间距等，只读——写入接口 overwriteNetRules 结构复杂暂未开放）',
		params: [],
		returns: '网络规则列表',
		example: { cmd: 'pcb.getNetRules' },
		handler: async () => {
			return await eda.pcb_Drc.getNetRules()
		},
	},
	// ---------- 网络操作 ----------
	{
		name: 'pcb.getNetLength',
		summary: '查询网络已布线总长度（等长检查用）',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名' },
		],
		returns: '{ net, length }',
		example: { cmd: 'pcb.getNetLength', params: { net: 'GND' } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			const length = await eda.pcb_Net.getNetLength(String(params.net))
			return { net: String(params.net), length }
		},
	},
	{
		name: 'pcb.getNetInfo',
		summary: '查询网络详细信息',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名' },
		],
		returns: '网络信息对象',
		example: { cmd: 'pcb.getNetInfo', params: { net: 'GND' } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			const info = await eda.pcb_Net.getNet(String(params.net))
			if (!info)
				throw new Error(`网络 ${params.net} 不存在`)
			return info
		},
	},
	{
		name: 'pcb.getNetPrimitives',
		summary: '查询网络上的全部图元（走线/过孔/焊盘等）',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名；必须显式提供字符串，允许空字符串' },
		],
		returns: '当前SDK按网络查询返回的原始图元结果；空字符串网络的实际返回由SDK决定',
		example: { cmd: 'pcb.getNetPrimitives', params: { net: 'GND' } },
		handler: async (params) => {
			if (!params || typeof params !== 'object' || !Object.prototype.hasOwnProperty.call(params, 'net') || typeof params.net !== 'string')
				throw new Error('参数 net 必须显式提供字符串（允许空字符串）')
			return await eda.pcb_Net.getAllPrimitivesByNet(params.net)
		},
	},
	{
		name: 'pcb.highlightNet',
		summary: '高亮/取消高亮网络（高亮后画布上该网络会突出显示）',
		params: [
			{ name: 'net', type: 'string', description: '网络名；与 all=true 二选一' },
			{ name: 'highlight', type: 'boolean', description: 'true 高亮 / false 取消，默认 true' },
			{ name: 'all', type: 'boolean', description: 'true 时取消所有网络高亮（忽略 net）' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.highlightNet', params: { net: 'GND' } },
		handler: async (params) => {
			let done: boolean
			if (params.all) {
				done = await eda.pcb_Net.unhighlightAllNets()
			}
			else {
				if (!params.net)
					throw new Error('缺少参数 net（或传 all=true 取消全部高亮）')
				done = params.highlight === false
					? await eda.pcb_Net.unhighlightNet(String(params.net))
					: await eda.pcb_Net.highlightNet(String(params.net))
			}
			return { done: Boolean(done) }
		},
	},
	// ---------- 层管理 ----------
	{
		name: 'pcb.listLayers',
		summary: '列出 PCB 全部层',
		params: [],
		returns: '层列表 [{ ... }]',
		example: { cmd: 'pcb.listLayers' },
		handler: async () => {
			return await eda.pcb_Layer.getAllLayers()
		},
	},
	{
		name: 'pcb.getCurrentLayer',
		summary: '查询当前激活层；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）；低版本不以空值代替状态',
		params: [],
		returns: '当前层信息',
		example: { cmd: 'pcb.getCurrentLayer' },
		handler: async () => {
			requireEda42('pcb.getCurrentLayer')
			return await eda.pcb_Layer.getCurrentLayer()
		},
	},
	{
		name: 'pcb.selectLayer',
		summary: '切换当前激活层',
		params: [
			{ name: 'layer', type: 'string | number', required: true, description: `层名或层 ID；${LAYER_HELP}` },
		],
		returns: '{ selected }',
		example: { cmd: 'pcb.selectLayer', params: { layer: 'bottom' } },
		handler: async (params) => {
			if (params.layer == null)
				throw new Error('缺少参数 layer')
			let layer: number
			if (typeof params.layer === 'string') {
				const normalized = params.layer.trim().toLowerCase().replace(/[_\s]/g, '-')
				if (normalized === '' || normalized === 'top' || normalized === 't' || normalized === 'bottom' || normalized === 'b')
					layer = resolveLayer(params.layer)
				else {
					const namedLayer = /^(inner|custom)-?(\d+)$/.exec(normalized)
					if (namedLayer) {
						const number = Number(namedLayer[2])
						const maximum = namedLayer[1] === 'inner' ? 32 : 200
						if (number < 1 || number > maximum)
							throw new Error(`不认识的层 "${params.layer}"——合法命名层范围为 inner1~inner32、custom1~custom200`)
					}
					layer = resolveLayerEx(params.layer, 1)
				}
			}
			else
				layer = resolveLayerEx(params.layer, 1)
			const selected = await eda.pcb_Layer.selectLayer(layer as any)
			return { selected: Boolean(selected) }
		},
	},
	{
		name: 'pcb.setCopperLayers',
		summary: '设置铜层数（2/4/6…，改层数会影响叠层，谨慎操作）',
		params: [
			{ name: 'count', type: 'number', required: true, description: '2 到 32 的偶数铜层数，如 2 或 4' },
		],
		returns: '{ set }',
		example: { cmd: 'pcb.setCopperLayers', params: { count: 2 } },
		handler: async (params) => {
			if (params.count == null)
				throw new Error('缺少参数 count')
			if (typeof params.count !== 'number' || !Number.isInteger(params.count) || params.count < 2 || params.count > 32 || params.count % 2 !== 0)
				throw new Error('count 必须是 2 到 32 之间的偶数')
			const set = await eda.pcb_Layer.setTheNumberOfCopperLayers(params.count as any)
			return { set: Boolean(set) }
		},
	},
	{
		name: 'pcb.setLayerVisible',
		summary: '设置层显示/隐藏',
		params: [
			{ name: 'layers', type: 'Array<string|number>', required: true, description: `层列表（层名或层 ID；${LAYER_HELP}）` },
			{ name: 'visible', type: 'boolean', description: 'true 显示 / false 隐藏，默认 true' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.setLayerVisible', params: { layers: ['bottom'], visible: false } },
		handler: async (params) => {
			if (!Array.isArray(params.layers) || !params.layers.length)
				throw new Error('缺少参数 layers')
			const layers = params.layers.map(l => resolveLayer(l)) as any
			const done = params.visible === false
				? await eda.pcb_Layer.setLayerInvisible(layers)
				: await eda.pcb_Layer.setLayerVisible(layers)
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.setLayerLocked',
		summary: '锁定/解锁层',
		params: [
			{ name: 'layers', type: 'Array<string|number>', required: true, description: `层列表（层名或层 ID；${LAYER_HELP}）` },
			{ name: 'locked', type: 'boolean', description: 'true 锁定 / false 解锁，默认 true' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.setLayerLocked', params: { layers: ['top'], locked: true } },
		handler: async (params) => {
			if (!Array.isArray(params.layers) || !params.layers.length)
				throw new Error('缺少参数 layers')
			const layers = params.layers.map(l => resolveLayer(l)) as any
			const done = params.locked === false
				? await eda.pcb_Layer.unlockLayer(layers)
				: await eda.pcb_Layer.lockLayer(layers)
			return { done: Boolean(done) }
		},
	},
	// ---------- 选择控制 ----------
	{
		name: 'pcb.select',
		summary: '按图元 ID 选中 PCB 图元（可批量）',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '图元 ID 列表' },
		],
		returns: '{ selected }',
		example: { cmd: 'pcb.select', params: { primitiveIds: ['xxx'] } },
		handler: async (params) => {
			const ids = Array.isArray(params.primitiveIds)
				? params.primitiveIds.map(String)
				: [String(params.primitiveIds)]
			if (!ids.length)
				throw new Error('primitiveIds 不能为空')
			const selected = await eda.pcb_SelectControl.doSelectPrimitives(ids)
			return { selected: Boolean(selected) }
		},
	},
	{
		name: 'pcb.clearSelection',
		summary: '清空 PCB 当前选择',
		params: [],
		returns: '{ cleared }',
		example: { cmd: 'pcb.clearSelection' },
		handler: async () => {
			const cleared = await eda.pcb_SelectControl.clearSelected()
			return { cleared: Boolean(cleared) }
		},
	},
	{
		name: 'pcb.crossProbe',
		summary: '交叉探针：按位号/引脚/网络在原理图与 PCB 间联动定位（可高亮+选中）',
		params: [
			{ name: 'components', type: 'string[]', description: '位号列表，如 ["U1","R2"]' },
			{ name: 'pins', type: 'string[]', description: '引脚列表，如 ["U1.23"]' },
			{ name: 'nets', type: 'string[]', description: '网络名列表' },
			{ name: 'highlight', type: 'boolean', description: '是否高亮，默认 true' },
			{ name: 'select', type: 'boolean', description: '是否选中，默认 true' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.crossProbe', params: { components: ['U1'] } },
		handler: async (params) => {
			const done = await eda.pcb_SelectControl.doCrossProbeSelect(
				params.components?.map(String),
				params.pins?.map(String),
				params.nets?.map(String),
				params.highlight != null ? Boolean(params.highlight) : undefined,
				params.select != null ? Boolean(params.select) : undefined,
			)
			return { done: Boolean(done) }
		},
	},
	// ---------- 图元读回与修改（走线/过孔/铺铜/丝印文字） ----------
	{
		name: 'pcb.listLines',
		summary: '列出 PCB 走线线段（可按网络/层过滤）——布线后读回自查用',
		params: [
			{ name: 'net', type: 'string', description: '网络名过滤，留空为全部' },
			{ name: 'layer', type: 'string', description: '层过滤：top | bottom | inner1..30 | 数字层 ID，留空为全部' },
		],
		returns: '[{ primitiveId, net, layer, startX, startY, endX, endY, lineWidth, locked }]',
		example: { cmd: 'pcb.listLines', params: { net: '3V3' } },
		handler: async (params) => {
			const layer = params.layer != null ? resolveLayerEx(params.layer as string | number, 1) : undefined
			const lines = await eda.pcb_PrimitiveLine.getAll(
				params.net ? String(params.net) : undefined,
				layer as any,
			)
			return (lines ?? []).map(l => ({
				primitiveId: safeState<string>(l, 'getState_PrimitiveId'),
				net: safeState<string>(l, 'getState_Net'),
				layer: safeState<number>(l, 'getState_Layer'),
				startX: safeState<number>(l, 'getState_StartX'),
				startY: safeState<number>(l, 'getState_StartY'),
				endX: safeState<number>(l, 'getState_EndX'),
				endY: safeState<number>(l, 'getState_EndY'),
				lineWidth: safeState<number>(l, 'getState_LineWidth'),
				locked: safeState<boolean>(l, 'getState_PrimitiveLock'),
			}))
		},
	},
	{
		name: 'pcb.modifyLine',
		summary: '修改已有走线线段（网络/层/端点/线宽）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '线段图元 ID' },
			{ name: 'net', type: 'string', description: '新网络名' },
			{ name: 'layer', type: 'string', description: '新层：top | bottom | inner1..30 | 数字层 ID' },
			{ name: 'startX', type: 'number', description: '起点 X' },
			{ name: 'startY', type: 'number', description: '起点 Y' },
			{ name: 'endX', type: 'number', description: '终点 X' },
			{ name: 'endY', type: 'number', description: '终点 Y' },
			{ name: 'lineWidth', type: 'number', description: '线宽（mil）' },
		],
		returns: '{ modified }',
		example: { cmd: 'pcb.modifyLine', params: { primitiveId: 'xxx', lineWidth: 20 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.net != null)
				property.net = String(params.net)
			if (params.layer != null)
				property.layer = resolveLayerEx(params.layer as string | number, 1)
			for (const k of ['startX', 'startY', 'endX', 'endY', 'lineWidth']) {
				if (params[k] != null)
					property[k] = Number(params[k])
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const lineId = String(params.primitiveId)
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——网络 / 层 / 几何端点 / 线宽各自独立步骤
			const lineSteps: Array<Record<string, any>> = []
			if (property.net != null)
				lineSteps.push({ net: property.net })
			if (property.layer != null)
				lineSteps.push({ layer: property.layer })
			const geoProps: Record<string, any> = {}
			for (const k of ['startX', 'startY', 'endX', 'endY']) {
				if (property[k] != null)
					geoProps[k] = property[k]
			}
			if (Object.keys(geoProps).length)
				lineSteps.push(geoProps)
			if (property.lineWidth != null)
				lineSteps.push({ lineWidth: property.lineWidth })
			const okAny = await modifyInSteps(async props => eda.pcb_PrimitiveLine.modify(lineId, props as any), lineSteps)
			// 读回验证（0.10.24）
			await new Promise(resolve => setTimeout(resolve, 300))
			const lines = await eda.pcb_PrimitiveLine.getAll().catch(() => undefined)
			const back = (lines ?? []).find((l: any) => safeState<string>(l, 'getState_PrimitiveId') === lineId)
			const checks: Array<[string, string, any, 'num' | 'str' | 'bool']> = []
			if (property.net != null)
				checks.push(['net', 'getState_Net', property.net, 'str'])
			if (property.layer != null)
				checks.push(['layer', 'getState_Layer', property.layer, 'num'])
			for (const k of ['startX', 'startY', 'endX', 'endY']) {
				if (property[k] != null)
					checks.push([k, `getState_${k[0].toUpperCase()}${k.slice(1)}`, property[k], 'num'])
			}
			if (property.lineWidth != null)
				checks.push(['lineWidth', 'getState_LineWidth', property.lineWidth, 'num'])
			const { readback, verified } = verifyReadback(back, checks)
			if (!verified)
				throw new Error(`走线 ${lineId} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: okAny || verified, readback: { ...readback, verified } }
		},
	},
	{
		name: 'pcb.listVias',
		summary: '列出 PCB 过孔（可按网络过滤）',
		params: [
			{ name: 'net', type: 'string', description: '网络名过滤，留空为全部' },
		],
		returns: '[{ primitiveId, net, x, y, diameter, holeDiameter, viaType, locked }]',
		example: { cmd: 'pcb.listVias', params: { net: 'GND' } },
		handler: async (params) => {
			// getAll(net) 过滤参数运行时不可靠（原理图侧实测返回空），全量取回后手动过滤
			const vias = await eda.pcb_PrimitiveVia.getAll()
			const netFilter = params.net ? String(params.net) : undefined
			return (vias ?? [])
				.map(v => ({
					primitiveId: safeState<string>(v, 'getState_PrimitiveId'),
					net: safeState<string>(v, 'getState_Net'),
					x: safeState<number>(v, 'getState_X'),
					y: safeState<number>(v, 'getState_Y'),
					diameter: safeState<number>(v, 'getState_Diameter'),
					holeDiameter: safeState<number>(v, 'getState_HoleDiameter'),
					viaType: safeState<number>(v, 'getState_ViaType'),
					locked: safeState<boolean>(v, 'getState_PrimitiveLock'),
				}))
				.filter(v => !netFilter || v.net === netFilter)
		},
	},
	{
		name: 'pcb.modifyVia',
		summary: '修改已有过孔（网络/位置/孔径/外径）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '过孔图元 ID' },
			{ name: 'net', type: 'string', description: '新网络名' },
			{ name: 'x', type: 'number', description: '新坐标 X' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'holeDiameter', type: 'number', description: '孔径（mil）' },
			{ name: 'diameter', type: 'number', description: '外径（mil）' },
		],
		returns: '{ modified }',
		example: { cmd: 'pcb.modifyVia', params: { primitiveId: 'xxx', diameter: 24, holeDiameter: 12 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.net != null)
				property.net = String(params.net)
			for (const k of ['x', 'y', 'holeDiameter', 'diameter']) {
				if (params[k] != null)
					property[k] = Number(params[k])
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const viaId = String(params.primitiveId)
			// 0.10.24 原子化（P10）——网络 / 位置 / 孔径 / 外径各自独立步骤
			const viaSteps: Array<Record<string, any>> = []
			if (property.net != null)
				viaSteps.push({ net: property.net })
			if (property.x != null || property.y != null) {
				const s: Record<string, any> = {}
				if (property.x != null)
					s.x = property.x
				if (property.y != null)
					s.y = property.y
				viaSteps.push(s)
			}
			if (property.holeDiameter != null)
				viaSteps.push({ holeDiameter: property.holeDiameter })
			if (property.diameter != null)
				viaSteps.push({ diameter: property.diameter })
			const okAny = await modifyInSteps(async props => eda.pcb_PrimitiveVia.modify(viaId, props as any), viaSteps)
			// 读回验证（0.10.24）
			await new Promise(resolve => setTimeout(resolve, 300))
			const vias = await eda.pcb_PrimitiveVia.getAll().catch(() => undefined)
			const back = (vias ?? []).find((v: any) => safeState<string>(v, 'getState_PrimitiveId') === viaId)
			const checks: Array<[string, string, any, 'num' | 'str' | 'bool']> = []
			if (property.net != null)
				checks.push(['net', 'getState_Net', property.net, 'str'])
			if (property.x != null)
				checks.push(['x', 'getState_X', property.x, 'num'])
			if (property.y != null)
				checks.push(['y', 'getState_Y', property.y, 'num'])
			if (property.holeDiameter != null)
				checks.push(['holeDiameter', 'getState_HoleDiameter', property.holeDiameter, 'num'])
			if (property.diameter != null)
				checks.push(['diameter', 'getState_Diameter', property.diameter, 'num'])
			const { readback, verified } = verifyReadback(back, checks)
			if (!verified)
				throw new Error(`过孔 ${viaId} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: okAny || verified, readback: { ...readback, verified } }
		},
	},
	{
		name: 'pcb.listPours',
		summary: '列出 PCB 铺铜（可按网络/层过滤）；withFill 返回 filled/fillStatus 三态，读取异常标注未知',
		params: [
			{ name: 'net', type: 'string', description: '网络名过滤，留空为全部' },
			{ name: 'layer', type: 'string', description: '层过滤：top | bottom | inner1..30 | 数字层 ID，留空为全部' },
			{ name: 'withFill', type: 'boolean', description: 'true 时逐框读回复核：成功返回 filled 与 fillStatus；null/undefined 为 empty，读取失败或非法返回为 unknown 并附 fillReadError' },
		],
		returns: '[{ primitiveId, net, layer, pourName, pourPriority, lineWidth, fillMethod, locked, filled?: boolean|null, fillStatus?: filled|empty|unknown, fillReadError?, fillPrimitiveId?, fillRegions?, filledRegions? }]',
		example: { cmd: 'pcb.listPours', params: { net: 'GND', withFill: true } },
		handler: async (params) => {
			const readFillWithTimeout = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => { clearTimeout(timer); reject(new Error('getCopperRegion超时（>20s，官方无响应）')) }, 20000)
				void promise.then(
					value => { clearTimeout(timer); resolve(value) },
					error => { clearTimeout(timer); reject(error) },
				)
			})
			const validFillSource = (source: unknown): boolean => {
				if (!Array.isArray(source) || source.length === 0)
					return false
				const pending: unknown[] = [source]
				const visited = new WeakSet<object>()
				while (pending.length) {
					const current = pending.pop()
					if (Array.isArray(current)) {
						if (current.length === 0 || visited.has(current))
							return false
						visited.add(current)
						for (const item of current)
							pending.push(item)
					}
					else if (!(typeof current === 'number' && Number.isFinite(current)) && !(typeof current === 'string' && current.length > 0))
						return false
				}
				return true
			}
			const layer = params.layer != null ? resolveLayerEx(params.layer as string | number, 1) : undefined
			const pours = await eda.pcb_PrimitivePour.getAll(
				params.net ? String(params.net) : undefined,
				layer as any,
			)
			const withFill = Boolean(params.withFill)
			const out = []
			for (const p of pours ?? []) {
				const item: Record<string, any> = {
					primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
					net: safeState<string>(p, 'getState_Net'),
					layer: safeState<number>(p, 'getState_Layer'),
					pourName: safeState<string>(p, 'getState_PourName'),
					pourPriority: safeState<number>(p, 'getState_PourPriority'),
					lineWidth: safeState<number>(p, 'getState_LineWidth'),
					fillMethod: safeState<number>(p, 'getState_PourFillMethod'),
					locked: safeState<boolean>(p, 'getState_PrimitiveLock'),
				}
				if (withFill) {
					try {
						const region = await readFillWithTimeout((p as any).getCopperRegion())
						if (region == null) {
							item.filled = false
							item.fillStatus = 'empty'
							item.fillRegions = 0
							item.filledRegions = 0
						}
						else {
							const fillRegion = region as any
							if (typeof fillRegion !== 'object' || typeof fillRegion.getState_PrimitiveId !== 'function' || typeof fillRegion.getState_PourFills !== 'function')
								throw new Error('填充对象缺少必要读回方法')
							const id = fillRegion.getState_PrimitiveId()
							const fills = fillRegion.getState_PourFills()
							if (typeof id !== 'string' || !id || !Array.isArray(fills))
								throw new Error('填充对象 ID 或填充区域结构无效')
							item.fillPrimitiveId = id
							item.fillRegions = fills.length
							let filledRegions = 0
							for (const fill of fills as any[]) {
								if (fill == null || typeof fill !== 'object' || typeof fill.id !== 'string' || !fill.id || typeof fill.fill !== 'boolean' || typeof fill.lineWidth !== 'number' || !Number.isFinite(fill.lineWidth) || fill.lineWidth < 0)
									throw new Error('填充区域 ID、状态或线宽无效')
								if (fill.fill) {
									if (typeof fill.path?.getSource !== 'function')
										throw new Error(`填充区域 ${fill.id} 缺少有效路径读回方法`)
									if (!validFillSource(fill.path.getSource()))
										throw new Error(`填充区域 ${fill.id} 路径源无效`)
									filledRegions++
								}
							}
							item.filledRegions = filledRegions
							item.filled = filledRegions > 0
							item.fillStatus = filledRegions > 0 ? 'filled' : 'empty'
						}
					}
					catch (err) {
						item.filled = null
						item.fillStatus = 'unknown'
						item.fillReadError = err instanceof Error ? err.message : String(err)
					}
				}
				out.push(item)
			}
			return out
		},
	},
	{
		name: 'pcb.modifyPour',
		summary: '修改已有铺铜；网络和名称仅允许同值确认，改网/改名会在写入前拒绝；可修改层/优先级/线宽',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '铺铜图元 ID' },
			{ name: 'net', type: 'string', description: '只允许与当前网络相同；暂时禁止改变已有铺铜网络。创建新铺铜时可指定网络' },
			{ name: 'layer', type: 'string | number', description: `新层：${LAYER_HELP}` },
			{ name: 'pourName', type: 'string', description: '仅允许与当前名称一致；禁止修改已有铺铜名称' },
			{ name: 'pourPriority', type: 'number', description: '铺铜优先级（数字小先铺）' },
			{ name: 'lineWidth', type: 'number', description: '铺铜线宽（mil）' },
		],
		returns: '{ modified, readback: { verified, ... }, apiPriority?, sourceOrder?, sourceOrders }；优先级按 PCB 源码 order 验收；当前宿主可能将请求 priority 映射为同层锚点排序，读回不符时停止后续字段并标记 partial，不自动重试或保存',
		example: { cmd: 'pcb.modifyPour', params: { primitiveId: 'xxx', pourPriority: 1 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.net != null)
				property.net = String(params.net)
			if (params.layer != null)
				property.layer = resolveLayerEx(params.layer as string | number, 1)
			if (params.pourName != null)
				property.pourName = String(params.pourName)
			for (const k of ['pourPriority', 'lineWidth']) {
				if (params[k] != null) {
					property[k] = Number(params[k])
					if (!Number.isFinite(property[k]))
						throw new Error(`${k} 必须是有限数值`)
				}
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const pourId = String(params.primitiveId)
			const monotonicStart = performance.now()
			const MAX_TIMER_MS = 2147483647
			const requestedTimeout = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedTimeout) || requestedTimeout > MAX_TIMER_MS)
				throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`)
			const budgetMs = Math.max(1000, requestedTimeout)
			const deadline = monotonicStart + budgetMs
			const remaining = () => deadline - performance.now()
			const budgetError = (label: string, cause?: unknown) => new Error(`${label}超出单指令时间预算（${budgetMs}ms）；原调用可能仍在后台执行`, cause === undefined ? undefined : { cause })
			const awaitSdk = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
				if (remaining() <= 0)
					throw budgetError(label)
				let value: T
				try { value = await operation() }
				catch (error) {
					if (remaining() <= 0)
						throw budgetError(label, error)
					throw error
				}
				if (remaining() <= 0)
					throw budgetError(label)
				return value
			}
			const focus = await awaitSdk('读取焦点文档', () => eda.dmt_SelectControl.getCurrentDocumentInfo())
			if (focus?.documentType !== 3 || typeof focus?.uuid !== 'string' || !focus.uuid.trim())
				throw new Error(`焦点文档不是有效 PCB（documentType=${focus?.documentType ?? '未知'}, uuid=${focus?.uuid ?? '无'}）`)
			const assertSameFocus = async () => {
				const latestFocus = await awaitSdk('复核焦点文档', () => eda.dmt_SelectControl.getCurrentDocumentInfo())
				if (latestFocus?.documentType !== 3 || latestFocus.uuid !== focus.uuid)
					throw new Error(`当前 PCB 文档已变化（原页=${focus.uuid}, 当前=${latestFocus?.uuid ?? '未知'}）`)
			}
			const readSource = async () => {
				await assertSameFocus()
				const source = await awaitSdk('读取 PCB 源码', () => eda.sys_FileManager.getDocumentSource())
				await assertSameFocus()
				if (typeof source !== 'string' || !source.trim())
					throw new Error('getDocumentSource 返回空或非法值')
				const doc = parseSourceLog(source)
				if (doc.docType !== 'PCB' || doc.uuid !== focus.uuid)
					throw new Error(`源码身份与当前 PCB 不符（docType=${doc.docType}, 源码 UUID=${doc.uuid}, 焦点 UUID=${focus.uuid}）`)
				const records = resolveRecords(doc, 'POUR')
				const target = records.get(`POUR\u0000${pourId}`)
				if (!target || !target.data || typeof target.data !== 'object' || Array.isArray(target.data))
					throw new Error(`源码中不存在有效铺铜 ${pourId}`)
				const all = Array.from(records.values()).map(record => ({ id: String(record.header.id), data: record.data as Record<string, any> }))
				return {
					target: target.data as Record<string, any>,
					orders: all.filter(item => item.data.layerId === target.data.layerId).map(item => ({ primitiveId: item.id, layer: item.data.layerId, sourceOrder: item.data.order })).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId))),
					pouredRecords: snapshotEffectiveSourceRecords(doc, 'POURED'),
				}
			}
			const names = ['net', 'layer', 'pourName', 'pourPriority', 'lineWidth'] as const
			const sourceField: Record<(typeof names)[number], string> = { net: 'netName', layer: 'layerId', pourName: 'name', pourPriority: 'order', lineWidth: 'width' }
			const sourceValue = (data: Record<string, any>, key: (typeof names)[number]) => data[sourceField[key]]
			const equivalent = (key: (typeof names)[number], actual: unknown, expected: unknown) => key === 'net' || key === 'pourName' ? actual === expected : typeof actual === 'number' && actual === expected
			const requested = Object.fromEntries(names.filter(key => property[key] != null).map(key => [key, property[key]]))
			let previousSource: Awaited<ReturnType<typeof readSource>> | undefined
			const sourceOrders: { before: Array<Record<string, unknown>>, after?: Array<Record<string, unknown>> } = { before: [] }
			const attemptedFields: Array<string> = []
			const noOpFields: Array<string> = []
			const verifiedFields: Array<string> = []
			const readback: Record<string, unknown> = {}
			let apiPriority: number | undefined
			let lastSource: Record<string, any> = {}
			let readbackStatus: 'current' | 'lastKnown' = 'current'
			const refreshVerifiedFields = (data: Record<string, any>) => {
				verifiedFields.splice(0, verifiedFields.length, ...attemptedFields.filter(field => equivalent(field as (typeof names)[number], sourceValue(data, field as (typeof names)[number]), requested[field])))
			}
			const remainingFields = () => names.filter(key => property[key] != null && !attemptedFields.includes(key) && !noOpFields.includes(key))
			const failPartial = (message: string, details: Record<string, unknown>, original?: unknown): never => {
				const error = original instanceof Error ? original : new Error(message)
				const priorCause = (error as any).cause
				;(error as any).cause = {
					...(priorCause !== undefined ? { priorCause } : {}),
					partial: true,
					retryable: false,
					primitiveId: pourId,
					documentUuid: focus.uuid,
					requested,
					attemptedFields: [...attemptedFields],
					verifiedFields: [...verifiedFields],
					unverifiedFields: attemptedFields.filter(field => !verifiedFields.includes(field)),
					notAttemptedFields: remainingFields(),
					noOpFields: [...noOpFields],
					readback: { ...readback },
					readbackStatus,
					sourceOrdersStatus: readbackStatus,
					sourceOrders: { ...sourceOrders },
					...details,
				}
				if (!original)
					error.message = message
				throw error
			}
			const before = await readSource() // 前置失败不会标记 partial
			previousSource = before
			sourceOrders.before = before.orders
			lastSource = before.target
			let livePour: any
			const readLivePour = async () => {
				if (livePour)
					return livePour
				await assertSameFocus()
				livePour = await awaitSdk(`读取铺铜 ${pourId} 当前属性`, () => eda.pcb_PrimitivePour.get(pourId))
				await assertSameFocus()
				if (!livePour)
					throw new Error(`无法读取铺铜 ${pourId} 的当前属性，已在写入前拒绝修改`)
				return livePour
			}
			if (property.net != null) {
				const netObject = await readLivePour()
				if (!netObject || typeof netObject.getState_Net !== 'function')
					throw new Error(`铺铜 ${pourId} 缺少网络状态读取接口，已在写入前拒绝修改`)
				const sourceNet = sourceValue(before.target, 'net')
				const sdkNet = netObject.getState_Net()
				if (typeof sourceNet !== 'string' || typeof sdkNet !== 'string' || sourceNet !== sdkNet)
					throw new Error(`铺铜 ${pourId} 网络源码与当前 API 读回不一致，已在写入前拒绝请求（source=${String(sourceNet)}, API=${String(sdkNet)}）`)
				if (sdkNet !== property.net)
					throw new Error(`已有铺铜改网已停用（当前=${sdkNet}, 请求=${property.net}）；创建铺铜时可指定网络`)
				noOpFields.push('net')
				readback.net = sdkNet
			}
			if (property.pourName != null) {
				const nameObject = await readLivePour()
				if (typeof nameObject.getState_PourName !== 'function')
					throw new Error(`铺铜 ${pourId} 缺少名称状态读取接口，已在写入前拒绝修改`)
				const sourceName = sourceValue(before.target, 'pourName')
				const sdkName = nameObject.getState_PourName()
				if (typeof sourceName !== 'string' || typeof sdkName !== 'string' || sourceName !== sdkName)
					throw new Error(`铺铜 ${pourId} 名称源码与当前 API 读回不一致，已在写入前拒绝请求（source=${String(sourceName)}, API=${String(sdkName)}）`)
				if (sdkName !== property.pourName)
					throw new Error(`已有铺铜改名已停用（当前=${sdkName}, 请求=${property.pourName}）`)
				noOpFields.push('pourName')
				readback.pourName = sdkName
			}
			for (const key of names) {
				if (property[key] == null || noOpFields.includes(key))
					continue
				try { await assertSameFocus() }
				catch (error) {
					readbackStatus = 'lastKnown'
					if (attemptedFields.length)
						failPartial(`铺铜 ${pourId} 字段 ${key} 写入前文档焦点已变化，已停止后续字段`, { readError: String((error as any)?.message ?? error) })
					throw error
				}
				if (remaining() <= 0) {
					const error = budgetError(`铺铜 ${pourId} 字段 ${key} 写入前检查`)
					readbackStatus = 'lastKnown'
					if (attemptedFields.length)
						failPartial(error.message, { readError: error.message })
					throw error
				}
				const stepBefore = previousSource!
				let writeResult: unknown
				let writeError: unknown
				try {
					writeResult = await awaitSdk(`修改铺铜 ${pourId} ${key}`, () => {
						attemptedFields.push(key)
						readbackStatus = 'lastKnown'
						verifiedFields.length = 0
						return eda.pcb_PrimitivePour.modify(pourId, { [key]: property[key] } as any)
					})
					if (!writeResult)
						writeError = new Error('modify 返回空值或失败值')
				}
				catch (error) { writeError = error }
				if (remaining() <= 0) {
					const error = writeError instanceof Error ? writeError : budgetError(`铺铜 ${pourId} 字段 ${key} 写入`)
					if (attemptedFields.length)
						failPartial(`铺铜 ${pourId} 字段 ${key} 写入超出时间预算，结果未知；已停止后续读取和写入`, { writeError: String((writeError as any)?.message ?? writeError ?? 'modify 已返回') }, error)
					throw error
				}
				let after: Awaited<ReturnType<typeof readSource>> | undefined
				let readError: unknown
				try { after = await readSource() }
				catch (error) { readError = error }
				if (readError) {
					verifiedFields.length = 0
					readbackStatus = 'lastKnown'
					failPartial(`铺铜 ${pourId} 字段 ${key} 写后源码读回不可用：${(readError as any)?.message ?? String(readError)}`, { writeError: writeError ? String((writeError as any)?.message ?? writeError) : undefined, readError: String((readError as any)?.message ?? readError) }, writeError)
				}
				if (after) {
					readbackStatus = 'current'
					sourceOrders.after = after.orders
					lastSource = after.target
					for (const field of names)
						readback[field] = sourceValue(after.target, field) ?? null
					const sameLayerChanged = key !== 'pourPriority' && key !== 'layer' && JSON.stringify(stepBefore.orders) !== JSON.stringify(after.orders)
					refreshVerifiedFields(after.target)
					const pouredRecordsChange = diffSourceRecordSnapshots(stepBefore.pouredRecords, after.pouredRecords)
					if (pouredRecordsChange.added.length || pouredRecordsChange.removed.length || pouredRecordsChange.changed.length)
						failPartial(`铺铜 ${pourId} 属性修改同时新增、删除或修改了有效 POURED 填充记录，已停止后续字段`, { pouredRecordsChange })
					if (writeError)
						failPartial(`铺铜 ${pourId} 字段 ${key} 修改失败或返回空值，已停止后续字段`, { writeError: String((writeError as any)?.message ?? writeError) }, writeError)
					if (!equivalent(key, sourceValue(after.target, key), property[key])) {
						const mismatch = { field: key, requested: property[key], actual: sourceValue(after.target, key) }
						const message = key === 'pourPriority'
							? `铺铜 ${pourId} 目标排序未达成（请求 priority=${property[key]}, source order=${sourceValue(after.target, key)}）；宿主排序参数可能不等于 source order，请检查后决定是否再次操作`
							: `铺铜 ${pourId} 字段 ${key} 源码读回不匹配（请求=${JSON.stringify(property[key])}, source=${JSON.stringify(sourceValue(after.target, key))}）`
						failPartial(message, { sourceMismatch: mismatch })
					}
					if (sameLayerChanged)
						failPartial(`铺铜 ${pourId} 字段 ${key} 修改同时改变了同层铺铜 source order，已停止后续字段`, { sourceOrderChanged: true })
					for (const field of names) {
						if (field !== key && sourceValue(after.target, field) !== sourceValue(stepBefore.target, field))
							failPartial(`铺铜 ${pourId} 字段 ${key} 修改同时改变了其他字段 ${field}，已停止后续字段`, { unintendedFieldChange: { field, before: sourceValue(stepBefore.target, field), after: sourceValue(after.target, field) } })
					}
					previousSource = after
				}
			}
			try {
				await assertSameFocus()
				const pours = await awaitSdk('读取 API 铺铜优先级', () => eda.pcb_PrimitivePour.getAll(undefined, undefined))
				await assertSameFocus()
				const back = (pours ?? []).find((p: any) => safeState<string>(p, 'getState_PrimitiveId') === pourId)
				apiPriority = back ? safeState<number>(back, 'getState_PourPriority') : undefined
			}
			catch (error) {
				if (remaining() <= 0)
					failPartial(`铺铜 ${pourId} API 优先级辅助读回超出时间预算，停止并标记部分结果`, { readError: String((error as any)?.message ?? error) })
				/* API 优先级是辅助信息，源码 order 为验收依据 */
			}
			return {
				modified: attemptedFields.length > 0,
				...(noOpFields.length ? { noOpFields: [...noOpFields] } : {}),
				readback: { ...readback, verified: true },
				...(property.pourPriority != null ? { apiPriority, sourceOrder: sourceValue(lastSource, 'pourPriority') } : {}),
				sourceOrders,
			}
		},
	},
	{
		name: 'pcb.rebuildPour',
		summary: '重建铺铜填充（0.10.43，GPT PCB电源铺铜反馈 R1）——官方 rebuildCopperRegion(s) 封装；只触发重建并读回，不保存、不切层',
		params: [
			{ name: 'primitiveId', type: 'string', description: '铺铜边框图元 ID（pcb.listPours 查）；留空=重建全板全部铺铜' },
		],
		returns: '{ status: completed|no-fill|failed|timeout, primitiveId?, net?, layer?, fillBefore, fillAfter, rebuiltFills?, error? }——completed 仅表示重建调用成功且合法读回含填充，不证明保存或板级制造状态；写入超时/拒绝会以 error.cause.partial=true 返回并停止宏（超时≠取消）',
		example: { cmd: 'pcb.rebuildPour', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			// 官方语义（pro-api-types 实锤）：
			//  · pourCopper 只创建「覆铜边框」，不保证同步生成「覆铜填充」——填充由 rebuildCopperRegion(s) 生成；
			//  · 单框重建 pour.rebuildCopperRegion() @beta，官方示例注明「当前版本在纯 API 创建的覆铜上重建可能报内部错误」——如实透传；
			//  · 整板重建 eda.pcb_PrimitivePour.rebuildCopperRegions(ids?) @alpha，不传 ID 重建全部，返回填充图元数组；
			//  · 填充读回：pour.getCopperRegion() 返回 IPCB_PrimitivePoured|undefined（含 getState_PourFills 填充区域列表）。
			const fillInfo = (poured: any) => ({
				fillPrimitiveId: poured ? safeState<string>(poured, 'getState_PrimitiveId') : undefined,
				fillRegions: poured ? (safeState<Array<unknown>>(poured, 'getState_PourFills') ?? []).length : 0,
			})
			const validatePoured = (poured: any, label: string): void => {
				if (poured === undefined)
					return
				const id = safeState<unknown>(poured, 'getState_PrimitiveId')
				const fills = safeState<unknown>(poured, 'getState_PourFills')
				if (typeof id !== 'string' || !id || !Array.isArray(fills))
					throw new Error(`${label}返回了非法填充图元结构`)
			}
			const validatePouredList = (items: any, label: string): Array<any> => {
				if (!Array.isArray(items))
					throw new Error(`${label}没有返回有效数组`)
				for (const item of items) {
					if (item === undefined || item === null)
						throw new Error(`${label}包含空填充图元`)
					validatePoured(item, label)
				}
				return items
			}
			const writeOutcomeError = (label: string, error: unknown, status: 'failed' | 'timeout', details: Record<string, unknown> = {}) => {
				const message = error instanceof Error ? error.message : String(error)
				const result = { status, ...details, error: message, note: '写入结果未确认；超时不代表官方调用已取消，先只读复核' }
				return new Error(`${label}结果未确认：${message}`, {
					cause: { partial: true, retryable: false, phase: label, operationError: message, result },
				})
			}
			const REBUILD_TIMEOUT_MS = 240000 // 扩展指令总预算 300s，重建本体留 240s，余量给读回
			const FILL_READ_TIMEOUT_MS = 20000
			const MAX_TIMER_MS = 2147483647
			const requestedTimeout = params._timeoutMs == null ? REBUILD_TIMEOUT_MS : Number(params._timeoutMs)
			if (!Number.isFinite(requestedTimeout) || requestedTimeout > MAX_TIMER_MS)
				throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`)
			const rebuildBudgetMs = Math.min(REBUILD_TIMEOUT_MS, Math.max(1000, requestedTimeout))
			const rebuildDeadline = performance.now() + rebuildBudgetMs
			const remainingRebuildMs = (label: string, details: Record<string, unknown> = {}): number => {
				const remaining = rebuildDeadline - performance.now()
				if (remaining <= 0)
					throw writeOutcomeError(label, new Error(`${label}超时（共享重建预算已耗尽）`), 'timeout', details)
				return remaining
			}

			if (params.primitiveId) {
				const pourId = String(params.primitiveId)
				const pour = await eda.pcb_PrimitivePour.get(pourId).catch(() => undefined)
				if (!pour)
					throw new Error(`铺铜 ${pourId} 不存在（用 pcb.listPours 核对 primitiveId）`)
				const identity = {
					primitiveId: pourId,
					net: safeState<string>(pour, 'getState_Net'),
					layer: safeState<number>(pour, 'getState_Layer'),
				}
				const before = await withTimeout(pour.getCopperRegion(), FILL_READ_TIMEOUT_MS, 'getCopperRegion(before)')
				validatePoured(before, 'getCopperRegion(before)')
				let rebuildResult: any
				try {
					const remaining = remainingRebuildMs('rebuildCopperRegion', { ...identity, fillBefore: fillInfo(before) })
					rebuildResult = await withTimeout(pour.rebuildCopperRegion(), remaining, 'rebuildCopperRegion')
					remainingRebuildMs('rebuildCopperRegion', { ...identity, fillBefore: fillInfo(before) })
				}
				catch (err: any) {
					const message = String(err?.message ?? err)
					throw writeOutcomeError('rebuildCopperRegion', err, /超时/.test(message) ? 'timeout' : 'failed', { ...identity, fillBefore: fillInfo(before) })
				}
				let after: any
				try {
					after = await withTimeout(pour.getCopperRegion(), FILL_READ_TIMEOUT_MS, 'getCopperRegion(after)')
					validatePoured(after, 'getCopperRegion(after)')
					remainingRebuildMs('getCopperRegion(after)', { ...identity, fillBefore: fillInfo(before) })
				}
				catch (err) {
					throw writeOutcomeError('getCopperRegion(after)', err, 'failed', { ...identity, fillBefore: fillInfo(before) })
				}
				const fillAfter = fillInfo(after)
				if (after && fillAfter.fillRegions > 0)
					return { status: 'completed', ...identity, fillBefore: fillInfo(before), fillAfter, rebuiltReturned: rebuildResult != null, freshnessVerified: false }
				return { status: 'no-fill', ...identity, fillBefore: fillInfo(before), fillAfter, note: '官方调用未报错但未生成填充图元——可能需在界面手动重建（设计→覆铜），或以只读指令复核' }
			}

			// 全板重建
			const beforeAll = validatePouredList(await eda.pcb_PrimitivePoured.getAll(), 'getAll(before)')
			let rebuilt: any
			let fallbackLoop = false
			const allPours = await eda.pcb_PrimitivePour.getAll()
			if (!Array.isArray(allPours))
				throw new Error('getAll(pours)没有返回有效数组，已拒绝重建')
			for (const pour of allPours) {
				const id = safeState<unknown>(pour, 'getState_PrimitiveId')
				if (typeof id !== 'string' || !id)
					throw new Error('getAll(pours)包含非法铺铜图元，已拒绝重建')
			}
			try {
				// 0.10.45：@alpha 静态 rebuildCopperRegions 在 EDA 4.1.60 运行时不存在（装机实测 "not a function"）——
				// 退化为逐框 rebuildCopperRegion 循环，行为等价于界面"重建全部覆铜"。
				if (typeof (eda.pcb_PrimitivePour as any).rebuildCopperRegions === 'function') {
					const remaining = remainingRebuildMs('rebuildCopperRegions', { fillCountBefore: beforeAll.length, mode: 'static' })
					rebuilt = await withTimeout((eda.pcb_PrimitivePour as any).rebuildCopperRegions(), remaining, 'rebuildCopperRegions')
					remainingRebuildMs('rebuildCopperRegions', { fillCountBefore: beforeAll.length, mode: 'static' })
					if (!Array.isArray(rebuilt))
						throw new Error('rebuildCopperRegions没有返回有效数组')
					validatePouredList(rebuilt, 'rebuildCopperRegions')
				}
				else {
					fallbackLoop = true
					const results: Array<any> = []
					for (const p of allPours ?? []) {
						const pid = safeState<string>(p, 'getState_PrimitiveId')
						if (!pid)
							continue
						try {
							const label = `rebuildCopperRegion(${pid})`
							const remaining = remainingRebuildMs(label, { pourId: pid, mode: 'per-pour-loop', fillCountBefore: beforeAll.length })
							const r = await withTimeout((p as any).rebuildCopperRegion(), remaining, label)
							remainingRebuildMs(label, { pourId: pid, mode: 'per-pour-loop', fillCountBefore: beforeAll.length })
							validatePoured(r, `rebuildCopperRegion(${pid})`)
							if (r)
								results.push(r)
						}
						catch (e: any) {
							const message = String(e?.message ?? e)
							throw writeOutcomeError(`rebuildCopperRegion(${pid})`, e, /超时/.test(message) ? 'timeout' : 'failed', { pourId: pid, mode: 'per-pour-loop', fillCountBefore: beforeAll.length })
						}
					}
					rebuilt = results
				}
			}
			catch (err: any) {
				if (err?.cause?.partial === true)
					throw err
				const message = String(err?.message ?? err)
				throw writeOutcomeError('rebuildCopperRegions', err, /超时/.test(message) ? 'timeout' : 'failed', { fillCountBefore: beforeAll.length, ...(fallbackLoop ? { mode: 'per-pour-loop' } : {}) })
			}
			let afterAll: Array<any>
			try {
				afterAll = validatePouredList(await eda.pcb_PrimitivePoured.getAll(), 'getAll(after)')
				remainingRebuildMs('getAll(after)', { fillCountBefore: beforeAll.length, mode: fallbackLoop ? 'per-pour-loop' : 'static' })
			}
			catch (err) {
				throw writeOutcomeError('getAll(after)', err, 'failed', { fillCountBefore: beforeAll.length, mode: fallbackLoop ? 'per-pour-loop' : 'static' })
			}
			const status = rebuilt.length && afterAll.length ? 'completed' : 'no-fill'
			return {
				status,
				fillCountBefore: beforeAll.length,
				fillCountAfter: afterAll.length,
				rebuiltFills: Array.isArray(rebuilt) ? rebuilt.length : 0,
				pourCount: (allPours ?? []).length,
				...(fallbackLoop ? { mode: 'per-pour-loop' } : {}),
				freshnessVerified: false,
			}
		},
	},
	{
		name: 'pcb.listStrings',
		summary: '列出 PCB 文字（丝印等，可按层过滤）',
		params: [
			{ name: 'layer', type: 'string', description: '层过滤：top-silk | bottom-silk | top | bottom | 数字层 ID，留空为全部' },
		],
		returns: '[{ primitiveId, layer, x, y, text, fontSize, rotation, mirror, locked }]',
		example: { cmd: 'pcb.listStrings', params: { layer: 'top-silk' } },
		handler: async (params) => {
			const layer = params.layer != null ? resolveLayerEx(params.layer as string | number, 3) : undefined
			const strings = await eda.pcb_PrimitiveString.getAll(layer as any)
			return (strings ?? []).map(s => ({
				primitiveId: safeState<string>(s, 'getState_PrimitiveId'),
				layer: safeState<number>(s, 'getState_Layer'),
				x: safeState<number>(s, 'getState_X'),
				y: safeState<number>(s, 'getState_Y'),
				text: safeState<string>(s, 'getState_Text'),
				fontSize: safeState<number>(s, 'getState_FontSize'),
				rotation: safeState<number>(s, 'getState_Rotation'),
				mirror: safeState<boolean>(s, 'getState_Mirror'),
				locked: safeState<boolean>(s, 'getState_PrimitiveLock'),
			}))
		},
	},
	{
		name: 'pcb.placeString',
		summary: '在 PCB 放置文字（板名/版本号/注释，默认顶层丝印）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（mil）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y（mil）' },
			{ name: 'text', type: 'string', required: true, description: '文字内容' },
			{ name: 'layer', type: 'string', description: '层：top-silk（默认）| bottom-silk | top | bottom | document(13) | outline(11) | mechanical(14) | inner1..32 | custom1..200 | 数字层 ID（含 "13" 数字字符串）；不认识的层名会报错，不会静默回退' },
			{ name: 'fontSize', type: 'number', description: '字高（mil），默认 50' },
			{ name: 'lineWidth', type: 'number', description: '笔画线宽（mil），默认 8' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像（底层文字一般需要），默认 false' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'pcb.placeString', params: { x: 100, y: -100, text: 'STM32-V1.0' } },
		handler: async (params) => {
			if (params.x == null || params.y == null || !params.text)
				throw new Error('缺少参数 x / y / text')
			const layer = resolveLayerEx(params.layer as string | number, 3)
			const str = await eda.pcb_PrimitiveString.create(
				layer as any,
				Number(params.x),
				Number(params.y),
				String(params.text),
				'Arial',
				params.fontSize != null ? Number(params.fontSize) : 50,
				params.lineWidth != null ? Number(params.lineWidth) : 8,
				5 as any, // CENTER 对齐
				params.rotation != null ? Number(params.rotation) : 0,
				false,
				0,
				Boolean(params.mirror),
				false,
			)
			if (!str)
				throw wrapCreateError('放置文字', new Error('官方返回空'))
			return { primitiveId: safeState<string>(str, 'getState_PrimitiveId') }
		},
	},
	{
		name: 'pcb.modifyString',
		summary: '修改已有 PCB 文字（内容/位置/字号/旋转/镜像/层）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '文字图元 ID' },
			{ name: 'text', type: 'string', description: '新文字内容' },
			{ name: 'x', type: 'number', description: '新坐标 X' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'fontSize', type: 'number', description: '字高（mil）' },
			{ name: 'rotation', type: 'number', description: '旋转角度' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像' },
			{ name: 'layer', type: 'string', description: '新层：top-silk | bottom-silk | top | bottom | document(13) | outline(11) | mechanical(14) | inner1..32 | custom1..200 | 数字层 ID（含 "13" 数字字符串）；不认识的层名会报错，不会静默回退' },
		],
		returns: '{ modified }',
		example: { cmd: 'pcb.modifyString', params: { primitiveId: 'xxx', text: 'V1.1' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.text != null)
				property.text = String(params.text)
			if (params.layer != null)
				property.layer = resolveLayerEx(params.layer as string | number, 3)
			if (params.mirror != null)
				property.mirror = Boolean(params.mirror)
			for (const k of ['x', 'y', 'fontSize', 'rotation']) {
				if (params[k] != null)
					property[k] = Number(params[k])
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const strId = String(params.primitiveId)
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——内容 / 位置 / 字号 / 旋转 / 镜像 / 层各自独立步骤
			const strSteps: Array<Record<string, any>> = []
			if (property.text != null)
				strSteps.push({ text: property.text })
			if (property.x != null || property.y != null) {
				const s: Record<string, any> = {}
				if (property.x != null)
					s.x = property.x
				if (property.y != null)
					s.y = property.y
				strSteps.push(s)
			}
			if (property.fontSize != null)
				strSteps.push({ fontSize: property.fontSize })
			if (property.rotation != null)
				strSteps.push({ rotation: property.rotation })
			if (property.mirror != null)
				strSteps.push({ mirror: property.mirror })
			if (property.layer != null)
				strSteps.push({ layer: property.layer })
			const okAny = await modifyInSteps(async props => eda.pcb_PrimitiveString.modify(strId, props as any), strSteps)
			// 读回验证（0.10.24）
			await new Promise(resolve => setTimeout(resolve, 300))
			const strings = await eda.pcb_PrimitiveString.getAll(undefined).catch(() => undefined)
			const back = (strings ?? []).find((s: any) => safeState<string>(s, 'getState_PrimitiveId') === strId)
			const checks: Array<[string, string, any, 'num' | 'str' | 'bool']> = []
			if (property.text != null)
				checks.push(['text', 'getState_Text', property.text, 'str'])
			if (property.x != null)
				checks.push(['x', 'getState_X', property.x, 'num'])
			if (property.y != null)
				checks.push(['y', 'getState_Y', property.y, 'num'])
			if (property.fontSize != null)
				checks.push(['fontSize', 'getState_FontSize', property.fontSize, 'num'])
			if (property.rotation != null)
				checks.push(['rotation', 'getState_Rotation', property.rotation, 'num'])
			if (property.mirror != null)
				checks.push(['mirror', 'getState_Mirror', property.mirror, 'bool'])
			if (property.layer != null)
				checks.push(['layer', 'getState_Layer', property.layer, 'num'])
			const { readback, verified } = verifyReadback(back, checks)
			if (!verified)
				throw new Error(`文字 ${strId} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: okAny || verified, readback: { ...readback, verified } }
		},
	},
	// ---------- 自动布线回灌 + 区域/点查询 ----------
	{
		name: 'pcb.importAutoRouteSes',
			summary: '将外部 SES 布线追加到当前 PCB（传 base64 文件内容）；每个输入走线段须至少 1 mil，差集产生的新增段也须至少 1 mil。FreeRouting 状态查询只读，不会自动导入结果',
		params: [
			{ name: 'base64', type: 'string', required: true, description: 'SES 文件内容的 base64 编码' },
			{ name: 'fileName', type: 'string', description: '文件名，默认 autoroute.ses' },
			{ name: 'routeBaseline', type: 'object', description: '可选：原样传入同一 PCB 的 pcb.exportDsn 或 pcb.autoRouteGetResult 返回的 routeBaseline；用于精确消解现有 ARC 的 DSN protect wire' },
			{ name: 'viaHoleDiametersMil', type: 'object', description: '可选钻孔径映射，如 {"via0":12}（单位 mil）；这是调用方提供的数据，不是 SES 数据或制造默认值；传入后，新增过孔若仍缺少可信孔径会在任何写入前拒绝；省略此参数时保留原有后端选择和 SES 未知孔径语义；新增过孔缺少可信孔径时使用原生 SES 路径' },
		],
		returns: '{ imported, alreadyPresent, sesGeometryVerified, widthRuleCompliance, backend, created, coverage, existingArcCoverage, holeDiameterStatus, holeDiameterSources }；existingArcCoverage逐项报告精确消解的现有ARC、SES wire序号和保护段数；线宽规则状态与几何读回分别报告；widthRuleCompliance.unknowns包含对应网络/层和具体未知原因，状态与违规判据保持原样。EDA4.1.78中，NORMAL/mil/open的显式NET多行TRACK规则仅在源码、唯一简单NET selector、SDK NET绑定及全部启用SIGNAL层ID逐层一致时按层检查；DEFAULT与NET_CLASS支持已验证的单行或完整分层结构；4.1.78中已验证形态的NET SAFE+TRACK在SAFE引用结构及SDK双绑定一致时可独立确认TRACK；NET_CLASS混合仅在NET明确TRACK-only且类SDK双绑定一致时可确认；同ID严格SAFE历史可解析，其他未消解来源仍未知；SAFE间距语义、空NET类继承及双方同时混合仍未知。preferred是配置值，不证明交互落线宽度。孔径来源为调用方指定或原板读回，不代表SES自带钻孔数据',
		example: { cmd: 'pcb.importAutoRouteSes', params: { fileName: 'board.ses', base64: '...' } },
		handler: async (params) => {
			const deadline = sesCommandDeadline(params)
			if (!params.base64)
				throw new Error('缺少参数 base64（SES 文件内容的 base64 编码）')
			const encoded = String(params.base64).trim()
			if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1)
				throw new Error('base64 格式无效（请传入 SES 文件内容的标准 Base64 编码）')
			const content = decodeSesUtf8(encoded).trim()
			if (!content || !/(?:^|\s)\(session(?:\s|\))/.test(content) || !content.endsWith(')'))
				throw new Error('解码内容不是非空 SES session 文件')
			const model = parseAutoRouteSes(content)
			const hasViaHoleDiameters = Object.prototype.hasOwnProperty.call(params, 'viaHoleDiametersMil')
			if (!model.wires.length && !model.vias.length)
				throw new Error('SES 不包含可导入的走线或过孔几何')
			let sesInputSegmentIndex = 0
			for (let wireIndex = 0; wireIndex < model.wires.length; wireIndex++) {
				const wire = model.wires[wireIndex]
				for (let pointIndex = 0; pointIndex < wire.points.length - 1; pointIndex++) {
					const a = wire.points[pointIndex]
					const b = wire.points[pointIndex + 1]
					assertMinimumRouteSegmentLength({ x: a.xMil, y: a.yMil }, { x: b.xMil, y: b.yMil }, `SES 输入线段 ${sesInputSegmentIndex + 1}（wire ${wireIndex + 1}, segment ${pointIndex + 1}）`)
					sesInputSegmentIndex++
				}
			}
			const currentDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (currentDocument?.documentType !== 3 || typeof currentDocument.uuid !== 'string' || !currentDocument.uuid.trim())
				throw new Error('当前焦点不是可识别的 PCB 文档，已拒绝 SES 导入')
			const snapshot = await captureDocumentSnapshot('pcb.importAutoRouteSes', 3, currentDocument.uuid)
			if (snapshot.documentUuid !== currentDocument.uuid)
				throw new Error(`SES 导入目标文档在快照期间变化（${currentDocument.uuid} → ${snapshot.documentUuid}）`)
			await assertSnapshotFocused(snapshot)
			const before = await readRouteSnapshot(eda, () => assertSnapshotFocused(snapshot), snapshot.source)
			const sesLayerNames = new Map(before.layers.map(layer => [layer.id, layer.name === 'Top Layer' ? 'TopLayer' : layer.name === 'Bottom Layer' ? 'BottomLayer' : layer.name.replaceAll(' ', '')]))
			const effectiveSourceRecords = [...resolveRecords(parseSourceLog(before.source)).values()]
			const currentArcs = effectiveSourceRecords.filter(record => record.header.type === 'ARC' && typeof record.header.id === 'string').map(record => ({ id: record.header.id!, header: record.header, data: record.data }))
			const routeBaseline = params.routeBaseline as SesRouteBaseline | undefined
			const arcCoverage = resolveSesArcCoverage(model.wires, routeBaseline, before.documentUuid, currentArcs, sesLayerNames, before.sourceRecords)
			if (routeBaseline?.arcs.length) {
				await assertRoutingSourceStable(snapshot.documentUuid, before.source, Math.min(5000, sesRemaining(deadline)), 'ARC保护基线native DSN导出前', () => sesRemaining(deadline))
				const dsnFile = await withTimeout(Promise.resolve().then(() => eda.pcb_ManufactureData.getDsnFile('route-baseline.dsn')), sesRemaining(deadline), 'ARC保护基线native DSN导出')
				if (!dsnFile)
					throw new Error('ARC保护基线复核的native DSN导出为空，已在写入前拒绝')
				const dsnBuffer = await withTimeout(dsnFile.arrayBuffer(), sesRemaining(deadline), 'ARC保护基线native DSN读取')
				const currentDsn = new TextDecoder('utf-8', { fatal: true }).decode(dsnBuffer)
				await assertRoutingSourceStable(snapshot.documentUuid, before.source, Math.min(5000, sesRemaining(deadline)), 'ARC保护基线native DSN导出后', () => sesRemaining(deadline))
				assertSesRouteBaselineMatchesDsn(routeBaseline, before.documentUuid, before.source, currentDsn)
			}
			const sesExpected = mapSesRoutes({ ...model, wires: arcCoverage.remainingWires }, before.layers)
			const expected = hasViaHoleDiameters
				? applySesViaHoleDiameters(sesExpected, params.viaHoleDiametersMil)
				: sesExpected
			const plan = planSesImport(expected, sesSnapshot(before), 'append')
			const widthEvidence = await readRoutingWidthEvidence(before.source, {
				timeoutMs: 5000,
				remainingMs: () => sesRemaining(deadline),
				reserveMs: 5000,
				layers: before.layers.map(layer => ({ ...layer, id: layer.id, name: layer.name, type: layer.type })),
			})
			const widthRuleCompliance = widthEvidence.snapshot
				? checkSesWidthRules(widthEvidence.snapshot, plan.deltaLines)
				: { status: 'unknown' as const, violations: [], unknowns: [...widthEvidence.unknowns, 'PCB 源码不可用，SES 线宽规则无法比较'] }
			await assertRoutingSourceStable(snapshot.documentUuid, before.source, 5000, 'SES 线宽规则检查', () => sesRemaining(deadline))
			if (widthRuleCompliance.violations.length > 0)
				throw new Error(`SES 线宽超出当前 EDA 规则范围，已在写入前拒绝：${JSON.stringify(widthRuleCompliance.violations)}`, { cause: { widthRuleCompliance } })
			for (let i = 0; i < plan.deltaLines.length; i++) {
				const line = plan.deltaLines[i]
				assertMinimumRouteSegmentLength(line.a, line.b, `SES 差集新增线段 ${i + 1}`)
			}
			if (hasViaHoleDiameters) {
				const missingHole = plan.deltaVias.find(via => !Number.isFinite(via.holeDiameterMil) || via.holeDiameterMil! <= 0)
				if (missingHole)
					throw new Error(`显式 viaHoleDiametersMil 模式下新增过孔缺少可信孔径：padstack=${missingHole.padstackName ?? '<unknown>'}`)
			}
			if (plan.alreadyPresent) {
				const beforeCheck = verifySesImport(plan, sesSnapshot(before))
				if (!beforeCheck.verified)
					throw new Error(`已存在 SES 几何读回不匹配：${JSON.stringify(beforeCheck.differences)}`)
				await assertSesSnapshotWithinBudget(deadline, snapshot)
				return { imported: false, alreadyPresent: true, sesGeometryVerified: true, widthRuleCompliance: { ...widthRuleCompliance, checkedLines: plan.deltaLines.length }, coverage: beforeCheck.coverage, existingArcCoverage: arcCoverage.existingArcCoverage, holeDiameterStatus: beforeCheck.coverage.holeDiameterStatus, holeDiameterSources: beforeCheck.coverage.holeDiameterSources }
			}
			const delta: SesRouteExpected = { ...expected, lines: plan.deltaLines, vias: plan.deltaVias }
			const subset = serializeSesSubset(content, delta)
			const fileName = params.fileName ? String(params.fileName) : 'autoroute.ses'
			const file = new File([subset], fileName)
			const sesDiagnostic = createSesDiagnostic('pcb.importAutoRouteSes', snapshot.documentUuid)
			sesDiagnostic.expectedGeometry = { lines: plan.targetLines, vias: plan.targetVias }
			sesDiagnostic.deltaGeometry = { lines: plan.deltaLines, vias: plan.deltaVias }
			const applyContext = createSesRouteApplyContext({ api: eda, snapshot, before, plan, deletedArcIds: [], file, timeoutMs: sesRemaining(deadline), manualAppendViaFirst: true, onStage: stage => { sesDiagnostic.phase = stage } })
			syncSesApplyDiagnostic(sesDiagnostic, applyContext)
			let verification
			try {
				await attachSesInputDiagnostic(sesDiagnostic, file)
				verification = await withDocumentRecovery(snapshot, async (write) => {
					try {
						await applyContext.focusGuard()
						const result = await applyContext.apply(write)
						syncSesApplyDiagnostic(sesDiagnostic, applyContext)
						return result.result
					}
					catch (error) {
						syncSesApplyDiagnostic(sesDiagnostic, applyContext)
						await captureSesDiagnosticEvidence(sesDiagnostic, 'beforeRecovery', snapshot)
						await persistSesDiagnostic(sesDiagnostic, 'beforeRecovery')
						throw error
					}
				}, { recoveryHook: applyContext.recover, focusGuard: applyContext.focusGuard })
			}
			catch (error) {
				syncSesApplyDiagnostic(sesDiagnostic, applyContext)
				await captureSesDiagnosticEvidence(sesDiagnostic, 'afterRecovery', snapshot)
				const diagnostic = await persistSesDiagnostic(sesDiagnostic, 'afterRecovery')
				throw withSesDiagnostic(error, diagnostic)
			}
			return {
				imported: true,
				alreadyPresent: false,
				sesGeometryVerified: true,
				widthRuleCompliance: { ...widthRuleCompliance, checkedLines: plan.deltaLines.length },
				backend: applyContext.backend,
				created: { lines: plan.deltaLines.length, vias: plan.deltaVias.length },
				coverage: verification.coverage,
				existingArcCoverage: arcCoverage.existingArcCoverage,
				holeDiameterStatus: verification.coverage.holeDiameterStatus,
				holeDiameterSources: verification.coverage.holeDiameterSources,
			}
		},
	},
	{
		name: 'pcb.getPrimitivesInRegion',
		summary: '查询指定矩形区域内的 PCB 图元（布局避障、布线规划的感知基础；返回 id+类型，可再用 pcb.select 选中细看）',
		params: [
			{ name: 'left', type: 'number', required: true, description: '区域左边界（mil）' },
			{ name: 'right', type: 'number', required: true, description: '区域右边界' },
			{ name: 'top', type: 'number', required: true, description: '区域上边界' },
			{ name: 'bottom', type: 'number', required: true, description: '区域下边界' },
		],
		returns: '[{ primitiveId, primitiveType }]',
		example: { cmd: 'pcb.getPrimitivesInRegion', params: { left: 0, right: 500, top: 0, bottom: -500 } },
		handler: async (params) => {
			for (const k of ['left', 'right', 'top', 'bottom']) {
				if (params[k] == null)
					throw new Error(`缺少参数 ${k}`)
			}
			const left = parseFiniteNumber(params.left, 'left')
			const right = parseFiniteNumber(params.right, 'right')
			const top = parseFiniteNumber(params.top, 'top')
			const bottom = parseFiniteNumber(params.bottom, 'bottom')
			const prims = await eda.pcb_Document.getPrimitivesInRegion(
				left, right, top, bottom,
			)
			return (prims ?? []).map(p => ({
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}))
		},
	},
	{
		name: 'pcb.getPrimitiveAtPoint',
		summary: '查询指定坐标处的 PCB 图元（返回 id+类型）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（mil）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y（mil）' },
		],
		returns: '{ primitiveId, primitiveType } 或 null',
		example: { cmd: 'pcb.getPrimitiveAtPoint', params: { x: 1250, y: -800 } },
		handler: async (params) => {
			if (params.x == null || params.y == null)
				throw new Error('缺少参数 x / y')
			const x = parseFiniteNumber(params.x, 'x')
			const y = parseFiniteNumber(params.y, 'y')
			const p = await eda.pcb_Document.getPrimitiveAtPoint(x, y)
			if (!p)
				return null
			return {
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}
		},
	},
	// ---------- 层叠管理（多层板）与自定义层 ----------
	{
		name: 'pcb.listStackingConfigs',
		summary: '列出全部物理层叠配置（含当前生效与默认配置名）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [],
		returns: '{ configs, current, default }',
		example: { cmd: 'pcb.listStackingConfigs' },
		handler: async () => {
			requireEda42('pcb.listStackingConfigs')
			const configs = await eda.pcb_Layer.getAllPhysicalStackingConfigurations()
			let current: string | undefined
			let dflt: string | undefined
			try {
				current = await eda.pcb_Layer.getCurrentPhysicalStackingConfigurationName()
			}
			catch { /* 忽略 */ }
			try {
				dflt = await eda.pcb_Layer.getDefaultPhysicalStackingConfigurationName()
			}
			catch { /* 忽略 */ }
			return { configs: configs ?? [], current, default: dflt }
		},
	},
	{
		name: 'pcb.getStackingConfig',
		summary: '读取指定层叠配置的完整定义（不传 name 时读当前配置）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'name', type: 'string', description: '配置名，留空读当前生效配置' },
		],
		returns: '层叠配置对象（可直接改完传给 pcb.applyStackingConfig）',
		example: { cmd: 'pcb.getStackingConfig' },
		handler: async (params) => {
			requireEda42('pcb.getStackingConfig')
			if (params.name)
				return await eda.pcb_Layer.getPhysicalStackingConfiguration(String(params.name))
			return await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration()
		},
	},
	{
		name: 'pcb.applyStackingConfig',
		summary: '把层叠配置对象应用到当前 PCB（先读配置再修改）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'configuration', type: 'object', required: true, description: '层叠配置对象（IPC​​B_PhysicalStackingConfiguration 结构）' },
		],
		returns: '{ applied }',
		example: { cmd: 'pcb.applyStackingConfig', params: { configuration: {} } },
		handler: async (params) => {
			requireEda42('pcb.applyStackingConfig')
			if (!params.configuration || typeof params.configuration !== 'object')
				throw new Error('缺少参数 configuration（层叠配置对象，先 pcb.getStackingConfig 读回再改）')
			const applied = await eda.pcb_Layer.overwriteCurrentPhysicalStackingConfiguration(params.configuration as any)
			return { applied: Boolean(applied) }
		},
	},
	{
		name: 'pcb.saveStackingConfig',
		summary: '把层叠配置对象另存为命名配置；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'configuration', type: 'object', required: true, description: '层叠配置对象' },
			{ name: 'name', type: 'string', required: true, description: '保存为的配置名' },
			{ name: 'allowOverwrite', type: 'boolean', description: '允许覆盖同名配置，默认 false' },
		],
		returns: '{ saved }',
		example: { cmd: 'pcb.saveStackingConfig', params: { name: '4层-1.6mm', configuration: {} } },
		handler: async (params) => {
			requireEda42('pcb.saveStackingConfig')
			if (!params.configuration || !params.name)
				throw new Error('缺少参数 configuration / name')
			const saved = await eda.pcb_Layer.savePhysicalStackingConfiguration(
				params.configuration as any,
				String(params.name),
				undefined,
				params.allowOverwrite != null ? Boolean(params.allowOverwrite) : undefined,
			)
			return { saved: Boolean(saved) }
		},
	},
	{
		name: 'pcb.renameStackingConfig',
		summary: '重命名层叠配置；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'oldName', type: 'string', required: true, description: '原配置名' },
			{ name: 'newName', type: 'string', required: true, description: '新配置名' },
		],
		returns: '{ renamed }',
		example: { cmd: 'pcb.renameStackingConfig', params: { oldName: 'a', newName: 'b' } },
		handler: async (params) => {
			requireEda42('pcb.renameStackingConfig')
			if (!params.oldName || !params.newName)
				throw new Error('缺少参数 oldName / newName')
			const renamed = await eda.pcb_Layer.renamePhysicalStackingConfiguration(String(params.oldName), String(params.newName))
			return { renamed: Boolean(renamed) }
		},
	},
	{
		name: 'pcb.deleteStackingConfig',
		summary: '删除层叠配置；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'name', type: 'string', required: true, description: '配置名' },
		],
		returns: '{ deleted }',
		example: { cmd: 'pcb.deleteStackingConfig', params: { name: 'a' } },
		handler: async (params) => {
			requireEda42('pcb.deleteStackingConfig')
			if (!params.name)
				throw new Error('缺少参数 name')
			const deleted = await eda.pcb_Layer.deletePhysicalStackingConfiguration(String(params.name))
			return { deleted: Boolean(deleted) }
		},
	},
	{
		name: 'pcb.setDefaultStackingConfig',
		summary: '把指定层叠配置设为默认；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'name', type: 'string', required: true, description: '配置名' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.setDefaultStackingConfig', params: { name: '4层-1.6mm' } },
		handler: async (params) => {
			requireEda42('pcb.setDefaultStackingConfig')
			if (!params.name)
				throw new Error('缺少参数 name')
			const done = await eda.pcb_Layer.setAsDefaultPhysicalStackingConfiguration(String(params.name))
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.addCustomLayer',
		summary: '新增自定义层（返回新层 ID，CUSTOM_1=71 起）',
		params: [],
		returns: '{ layer }（新层 ID）',
		example: { cmd: 'pcb.addCustomLayer' },
		handler: async () => {
			const layer = await eda.pcb_Layer.addCustomLayer()
			return { layer }
		},
	},
	{
		name: 'pcb.removeCustomLayer',
		summary: '删除自定义层（只能删 CUSTOM 层，custom1=71 起）',
		params: [
			{ name: 'layer', type: 'string', required: true, description: 'custom1..20 或数字层 ID（71 起）' },
		],
		returns: '{ removed }',
		example: { cmd: 'pcb.removeCustomLayer', params: { layer: 'custom1' } },
		handler: async (params) => {
			if (params.layer == null)
				throw new Error('缺少参数 layer')
			const removed = await eda.pcb_Layer.removeLayer(resolveLayerEx(params.layer as string | number, 71) as any)
			return { removed: Boolean(removed) }
		},
	},
	{
		name: 'pcb.modifyLayer',
		summary: '修改层属性（改名/类型/颜色/透明度）',
		params: [
			{ name: 'layer', type: 'string', required: true, description: 'top | bottom | inner1..30 | custom1..20 | 数字层 ID' },
			{ name: 'name', type: 'string', description: '新层名' },
			{ name: 'type', type: 'string', description: '层类型：signal | internal（内电层）' },
			{ name: 'color', type: 'string', description: '层颜色（如 #FF0000）' },
			{ name: 'transparency', type: 'number', description: '透明度' },
		],
		returns: '{ modified }',
		example: { cmd: 'pcb.modifyLayer', params: { layer: 'inner1', name: 'GND', type: 'internal' } },
		handler: async (params) => {
			if (params.layer == null)
				throw new Error('缺少参数 layer')
			const property: Record<string, any> = {}
			if (params.name != null)
				property.name = String(params.name)
			if (params.type != null) {
				// 0.10.65 修复：显式白名单——旧版任意非 internal 字符串都静默映射 SIGNAL，
				// 与本文件「不认识的值绝不静默回退」原则（resolveLayer/resolveLayerEx）矛盾，错拼会静默改错层类型
				const t = String(params.type).toLowerCase()
				if (t === 'internal')
					property.type = 'INTERNAL_ELECTRICAL'
				else if (t === 'signal')
					property.type = 'SIGNAL'
				else
					throw new Error(`未知层类型「${params.type}」（只支持 signal | internal）——不认识的值绝不静默回退，请修正后重试`)
			}
			if (params.color != null)
				property.color = String(params.color)
			if (params.transparency != null)
				property.transparency = Number(params.transparency)
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性（name / type / color / transparency）')
			const modified = await eda.pcb_Layer.modifyLayer(
				resolveLayerEx(params.layer as string | number, 1) as any,
				property as any,
			)
			return { modified: Boolean(modified) }
		},
	},
	{
		name: 'pcb.setPcbType',
		summary: '设置板子类型（刚性板 NORMAL / 柔性板 FPC）',
		params: [
			{ name: 'pcbType', type: 'string', required: true, description: 'normal | fpc' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.setPcbType', params: { pcbType: 'normal' } },
		handler: async (params) => {
			if (!params.pcbType)
				throw new Error('缺少参数 pcbType（normal | fpc）')
			const pcbType = String(params.pcbType).trim().toLowerCase()
			if (pcbType !== 'normal' && pcbType !== 'fpc')
				throw new Error(`无效 pcbType：${String(params.pcbType)}（仅支持 normal | fpc）`)
			const sdkType: EPCB_PcbPlateType = pcbType === 'fpc' ? 2 : 1
			const done = await eda.pcb_Layer.setPcbType(sdkType)
			if (done !== true)
				throw new Error(`设置板子类型失败：官方接口返回 ${String(done)}`)
			return { done: true }
		},
	},
	// ---------- 等长组 + 实时 DRC ----------
	{
		name: 'pcb.createEqualLengthGroup',
		summary: '创建等长网络组（高速信号等长布线前置）',
		params: [
			{ name: 'name', type: 'string', required: true, description: '等长组名称' },
			{ name: 'nets', type: 'string[]', required: true, description: '加入组的网络名列表' },
			{ name: 'color', type: 'string', description: '组颜色（如 #FF0000）' },
		],
		returns: '{ created }',
		example: { cmd: 'pcb.createEqualLengthGroup', params: { name: 'DDR-D0-D7', nets: ['D0', 'D1'] } },
		handler: async (params) => {
			if (!params.name || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 name / nets')
			const created = await eda.pcb_Drc.createEqualLengthNetGroup(
				String(params.name),
				params.nets.map(String),
				params.color ? parsePcbColor(params.color) : undefined as any,
			)
			if (created !== true)
				throw new Error(`创建等长网络组失败：官方接口返回 ${String(created)}`)
			return { created: true }
		},
	},
	{
		name: 'pcb.listEqualLengthGroups',
		summary: '列出全部等长网络组',
		params: [],
		returns: '等长组列表',
		example: { cmd: 'pcb.listEqualLengthGroups' },
		handler: async () => {
			return await eda.pcb_Drc.getAllEqualLengthNetGroups()
		},
	},
	{
		name: 'pcb.renameEqualLengthGroup',
		summary: '重命名等长网络组',
		params: [
			{ name: 'oldName', type: 'string', required: true, description: '原组名' },
			{ name: 'newName', type: 'string', required: true, description: '新组名' },
		],
		returns: '{ renamed }',
		example: { cmd: 'pcb.renameEqualLengthGroup', params: { oldName: 'a', newName: 'b' } },
		handler: async (params) => {
			if (!params.oldName || !params.newName)
				throw new Error('缺少参数 oldName / newName')
			const renamed = await eda.pcb_Drc.modifyEqualLengthNetGroupName(String(params.oldName), String(params.newName))
			return { renamed: Boolean(renamed) }
		},
	},
	{
		name: 'pcb.deleteEqualLengthGroup',
		summary: '删除等长网络组',
		params: [
			{ name: 'name', type: 'string', required: true, description: '组名' },
		],
		returns: '{ deleted }',
		example: { cmd: 'pcb.deleteEqualLengthGroup', params: { name: 'a' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const deleted = await eda.pcb_Drc.deleteEqualLengthNetGroup(String(params.name))
			return { deleted: Boolean(deleted) }
		},
	},
	{
		name: 'pcb.addNetToEqualLengthGroup',
		summary: '把网络加入等长组',
		params: [
			{ name: 'name', type: 'string', required: true, description: '组名' },
			{ name: 'nets', type: 'string[]', required: true, description: '网络名列表' },
		],
		returns: '{ added }',
		example: { cmd: 'pcb.addNetToEqualLengthGroup', params: { name: 'DDR', nets: ['D2'] } },
		handler: async (params) => {
			if (!params.name || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 name / nets')
			const added = await eda.pcb_Drc.addNetToEqualLengthNetGroup(String(params.name), params.nets.map(String))
			return { added: Boolean(added) }
		},
	},
	{
		name: 'pcb.removeNetFromEqualLengthGroup',
		summary: '把网络移出等长组',
		params: [
			{ name: 'name', type: 'string', required: true, description: '组名' },
			{ name: 'nets', type: 'string[]', required: true, description: '网络名列表' },
		],
		returns: '{ removed }',
		example: { cmd: 'pcb.removeNetFromEqualLengthGroup', params: { name: 'DDR', nets: ['D2'] } },
		handler: async (params) => {
			if (!params.name || !Array.isArray(params.nets) || !params.nets.length)
				throw new Error('缺少参数 name / nets')
			const removed = await eda.pcb_Drc.removeNetFromEqualLengthNetGroup(String(params.name), params.nets.map(String))
			return { removed: Boolean(removed) }
		},
	},
	{
		name: 'pcb.startRealTimeDrc',
		summary: '开启实时 DRC（官方 beta）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [],
		returns: '{ done }',
		example: { cmd: 'pcb.startRealTimeDrc' },
		handler: async () => {
			requireEda42('pcb.startRealTimeDrc')
			const done = await eda.pcb_Drc.startRealTimeDrc()
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.stopRealTimeDrc',
		summary: '关闭实时 DRC；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [],
		returns: '{ done }',
		example: { cmd: 'pcb.stopRealTimeDrc' },
		handler: async () => {
			requireEda42('pcb.stopRealTimeDrc')
			const done = await eda.pcb_Drc.stopRealTimeDrc()
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.getRealTimeDrcStatus',
		summary: '查询实时 DRC 开关状态；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [],
		returns: '{ enabled }',
		example: { cmd: 'pcb.getRealTimeDrcStatus' },
		handler: async () => {
			requireEda42('pcb.getRealTimeDrcStatus')
			const enabled = await eda.pcb_Drc.getRealTimeDrcStatus()
			return { enabled: Boolean(enabled) }
		},
	},
	// ---------- 自动布线（FreeRouting 闭环）----------
	{
		name: 'pcb.setNetLock',
		summary: '锁定/解锁指定网络的全部走线、过孔、圆弧（0.10.0 起）。自动布线状态查询不会回灌；外部 SES 导入采用追加模式并保留现有图元。锁定仍可用于其他清理操作中的网络保护',
		params: [
			{ name: 'net', type: 'string', description: '网络名（与 nets 二选一）' },
			{ name: 'nets', type: 'string[]', description: '网络名数组（批量）' },
			{ name: 'locked', type: 'boolean', description: 'true=锁定（默认），false=解锁' },
		],
		returns: '{ locked, lines, vias, arcs, failed }',
		example: { cmd: 'pcb.setNetLock', params: { nets: ['VIN', 'VOUT', 'GND'], locked: true } },
		handler: async (params) => {
			const nets: Array<string> = params.net
				? [String(params.net)]
				: Array.isArray(params.nets) ? (params.nets as Array<string>).map(String) : []
			if (!nets.length)
				throw new Error('缺少参数 net 或 nets')
			const netSet = new Set(nets)
			const locked = params.locked !== false
			let lines = 0, vias = 0, arcs = 0
			const failed: Array<string> = []
			// getAll(net) 过滤参数实测不可靠，全量取回手动过滤
			const lineList = (await eda.pcb_PrimitiveLine.getAll()) ?? []
			for (const l of lineList) {
				if (!netSet.has(safeState<string>(l, 'getState_Net') ?? ''))
					continue
				const id = safeState<string>(l, 'getState_PrimitiveId')
				if (!id)
					continue
				try {
					if (await eda.pcb_PrimitiveLine.modify(id, { primitiveLock: locked } as any))
						lines += 1
					else
						failed.push(`line:${id}`)
				}
				catch { failed.push(`line:${id}`) }
			}
			const viaList = (await eda.pcb_PrimitiveVia.getAll()) ?? []
			for (const v of viaList) {
				if (!netSet.has(safeState<string>(v, 'getState_Net') ?? ''))
					continue
				const id = safeState<string>(v, 'getState_PrimitiveId')
				if (!id)
					continue
				try {
					if (await eda.pcb_PrimitiveVia.modify(id, { primitiveLock: locked } as any))
						vias += 1
					else
						failed.push(`via:${id}`)
				}
				catch { failed.push(`via:${id}`) }
			}
			try {
				const arcList = (await (eda.pcb_PrimitiveArc as any).getAll()) ?? []
				for (const a of arcList) {
					if (!netSet.has(safeState<string>(a, 'getState_Net') ?? ''))
						continue
					const id = safeState<string>(a, 'getState_PrimitiveId')
					if (!id)
						continue
					try {
						if (await (eda.pcb_PrimitiveArc as any).modify(id, { primitiveLock: locked }))
							arcs += 1
						else
							failed.push(`arc:${id}`)
					}
					catch { failed.push(`arc:${id}`) }
				}
			}
			catch {
				// 圆弧接口不可用则跳过
			}
			return { locked, lines, vias, arcs, ...(failed.length ? { failed } : {}) }
		},
	},
	{
		name: 'pcb.autoRouteStart',
		summary: '【宏】向本机 http://127.0.0.1:37864/v1 的 FreeRouting REST API 提交布线请求；DSN线宽差异默认只报告，applyLayerWidthRules:true时显式补写已确认的DEFAULT层rule与网络class层宽，转换内容在dsnConversion逐项披露。不会修改EDA规则或SES，约束仍不完整。须先启动含 API 服务的发行包；仅有 CLI 可执行文件不等于服务已运行。本插件不自带启动脚本，官方独立集成的脚本见 https://github.com/easyeda/eext-freerouting-intergration/tree/main/scripts 。启动请求返回不证明已开始布线；必须保留返回的 jobId，完成后依次调用 pcb.autoRouteGetResult 取回 SES、再显式调用 pcb.importAutoRouteSes 导入；用 pcb.autoRouteStatus 查询状态，不自动导入',
		params: [
			{ name: 'maxPasses', type: 'number', description: '最大布线轮数，默认 50' },
			{ name: 'viaCosts', type: 'number', description: '过孔成本权重（越高越少过孔），默认 50' },
			{ name: 'maxThreads', type: 'number', description: '并行线程数，默认 4' },
			{ name: 'automaticNeckdown', type: 'boolean', description: '是否允许 FreeRouting 在窄焊盘处自动缩小走线宽度；默认 false。表示提交的设置，不代表服务器读回已验证' },
			{ name: 'applyLayerWidthRules', type: 'boolean', description: '可选：仅当源码稳定且逐层preferred线宽已知时，将确认的DEFAULT层rule与class layer_rule写入本次DSN；默认false，不修改EDA规则或SES' },
			{ name: 'skipDrc', type: 'boolean', description: '兼容参数；自动回灌停用期间不会自动运行 DRC' },
		],
		returns: '{ jobId, outcome: "start-request-submitted", routingSettings: { automaticNeckdown, readbackVerified: false }, widthRuleComparison, dsnConversion: { changed, changes, warnings, limitations, slotClearance? }, routingConstraintsComplete:false, stateVerified: false, note }；线宽差异默认只报告；applyLayerWidthRules:true时显式补写已确认的DSN DEFAULT与class层宽，并在dsnConversion逐项披露。不会修改EDA规则或SES；布线约束仍不完整。EDA4.1.78中，NORMAL/mil/open的显式NET多行TRACK规则仅在源码、唯一简单NET selector、SDK NET绑定及全部启用SIGNAL层ID逐层一致时按层确认；层范围不同时网络对照的layers列出各层结果，聚合项不提供单层范围。DEFAULT、NET与NET_CLASS多行规则可在完整逐层证据满足时按层确认；4.1.78中已验证形态的NET SAFE+TRACK可在SAFE引用结构及SDK双绑定一致时独立确认TRACK，同原始SAFE ID的严格ticket历史可消解到唯一最新实体，未消解删除或冲突仍未知；NET_CLASS混合在NET明确TRACK-only或自身SAFE／TRACK均经唯一SDK确认时可独立确认TRACK，显式NET优先；空NET继承仍未知。无structure base但完整默认层覆盖时可比较，转换为缺失层写明确preferred，非法base不作缺省。槽孔仅在原默认SAFE profile及已核对TRACK-only类结构、有效PAD_NET或独立NORMAL焊盘网络覆盖下补偿，不解释新的SAFE间距语义。preferred是配置值，不证明交互落线宽度。routingSettings表示提交值，不代表服务器读回已验证；/start响应不确定时抛出partial=true,retryable=false和jobId；只能查状态或取消，不要重提',
		example: { cmd: 'pcb.autoRouteStart', params: { maxPasses: 50 } },
		handler: async (params) => {
			if (params.applyLayerWidthRules !== undefined && typeof params.applyLayerWidthRules !== 'boolean')
				throw new Error('applyLayerWidthRules 必须是布尔值')
			const applyLayerWidthRulesRequested = params.applyLayerWidthRules === true
			if (params.automaticNeckdown !== undefined && typeof params.automaticNeckdown !== 'boolean')
				throw new Error('automaticNeckdown 必须是布尔值')
			if (params.skipDrc !== undefined && typeof params.skipDrc !== 'boolean')
				throw new Error('skipDrc 必须是布尔值')
			const maxPasses = params.maxPasses == null ? 50 : Number(params.maxPasses)
			if (!Number.isFinite(maxPasses) || !Number.isInteger(maxPasses) || maxPasses <= 0)
				throw new Error('maxPasses 必须是大于 0 的有限整数')
			if (currentRouteJobId) {
				const previousJobId = currentRouteJobId
				let previousStatus: { id?: unknown, state?: unknown }
				try {
					previousStatus = await frRequest<{ id?: unknown, state?: unknown }>('GET', `/jobs/${encodeURIComponent(previousJobId)}`)
				}
				catch (error) {
					throw new Error(`已有布线任务槽（jobId=${previousJobId}），内部状态读取失败；未提交新任务：${String((error as any)?.message ?? error)}`)
				}
				if (previousStatus?.id !== previousJobId || !isTerminalRouteState(previousStatus?.state))
					throw new Error(`已有布线任务在进行或状态未确认（jobId=${previousJobId}，state=${String(previousStatus?.state ?? 'UNKNOWN')}），未提交新任务；先查询或停止`)
				releaseCurrentRouteJob(previousJobId)
			}
			const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focus?.documentType !== 3 || typeof focus.uuid !== 'string' || !focus.uuid.trim())
				throw new Error('启动自动布线前必须先激活一个有效 PCB 文档')
			const routeDocumentUuid = focus.uuid
			let routeDocumentSource: string | undefined
			let routeSnapshotWarning: string | undefined
			try {
				const value = await eda.sys_FileManager.getDocumentSource()
				if (typeof value === 'string') routeDocumentSource = value
				else routeSnapshotWarning = 'SDK 未返回 PCB 源码快照'
			}
			catch (error) { routeSnapshotWarning = `读取 PCB 源码快照失败：${String((error as any)?.message ?? error)}` }
			if (applyLayerWidthRulesRequested && routeDocumentSource === undefined)
				throw new Error('启用applyLayerWidthRules时必须能读取当前PCB源码快照')
			// 健康检查
			try {
				await frRequest('GET', '/system/status')
			}
			catch {
				throw new Error('FreeRouting REST API 服务未运行（http://127.0.0.1:37864/v1）。本插件不自带启动脚本；请按所用发行包的 API 服务说明启动。仅 CLI 模式请用 exportDsn → 外部 CLI → importAutoRouteSes；API 配置与官方集成脚本见 https://github.com/easyeda/eext-freerouting-intergration/tree/main/scripts')
			}
			const dsnFile = await eda.pcb_ManufactureData.getDsnFile('design.dsn')
			if (!dsnFile)
				throw new Error('DSN 导出失败：请确认已激活 PCB 文档')
			const focusAfterDsn = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focusAfterDsn?.documentType !== 3 || focusAfterDsn.uuid !== routeDocumentUuid)
				throw new Error(`导出 DSN 期间 PCB 焦点已变化（原文档=${routeDocumentUuid}，当前=${focusAfterDsn?.uuid ?? '未知'}），已拒绝提交布线任务`)
			let sourceAfterDsn: string | undefined
			if (routeDocumentSource !== undefined) {
				try { sourceAfterDsn = await eda.sys_FileManager.getDocumentSource() }
				catch (error) { routeSnapshotWarning = `导出 DSN 后复核源码快照失败：${String((error as any)?.message ?? error)}` }
			}
			const routeExportSnapshotComparison = routeDocumentSource === undefined || sourceAfterDsn === undefined
				? undefined
				: comparePcbSourceSnapshots(routeDocumentSource, sourceAfterDsn)
			if (routeDocumentSource !== undefined && sourceAfterDsn !== undefined && !routeExportSnapshotComparison?.matches)
				throw new Error(`导出 DSN 期间 PCB 源码快照已变化：${routeExportSnapshotComparison?.reason ?? '无法比较'}，已拒绝提交布线任务`)
			if (sourceAfterDsn === undefined)
				routeDocumentSource = undefined
			const dsnRepair = repairDsnClassNetReferences(new TextDecoder('utf-8', { fatal: true }).decode(await dsnFile.arrayBuffer()))
			let dsnPrepared = routeDocumentSource !== undefined
				? await prepareDsnWithPouredPlanes(eda, dsnRepair.text, routeDocumentUuid, routeDocumentSource)
				: { ...dsnRepair, warnings: [...dsnRepair.warnings, `${routeSnapshotWarning ?? '源码快照不可用'}，保留原 DSN 平面内容`], limitations: [...dsnRepair.limitations, '源码快照不可用时不补写内层平面'] }
			const focusAfterPreparation = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focusAfterPreparation?.documentType !== 3 || focusAfterPreparation.uuid !== routeDocumentUuid)
				throw new Error(`读取 DSN 实填充期间 PCB 焦点已变化（原文档=${routeDocumentUuid}，当前=${focusAfterPreparation?.uuid ?? '未知'}），已拒绝提交布线任务`)
			let sourceAfterPreparation: string | undefined
			if (routeDocumentSource !== undefined) {
				try { sourceAfterPreparation = await eda.sys_FileManager.getDocumentSource() }
				catch (error) { routeSnapshotWarning = `准备 DSN 后复核源码快照失败：${String((error as any)?.message ?? error)}` }
			}
			const routePreparationSnapshotComparison = routeDocumentSource === undefined || sourceAfterPreparation === undefined
				? undefined
				: comparePcbSourceSnapshots(routeDocumentSource, sourceAfterPreparation)
			if (routeDocumentSource !== undefined && sourceAfterPreparation !== undefined && !routePreparationSnapshotComparison?.matches)
				throw new Error(`读取 DSN 实填充期间 PCB 源码快照已变化：${routePreparationSnapshotComparison?.reason ?? '无法比较'}，已拒绝提交布线任务`)
			if (sourceAfterPreparation === undefined && routeDocumentSource !== undefined)
				dsnPrepared = { ...dsnRepair, warnings: [...dsnRepair.warnings, `${routeSnapshotWarning ?? '实填充读回后无法复核源码快照'}，保留原 DSN 平面内容`], limitations: [...dsnRepair.limitations, '源码快照无法复核时不补写内层平面'] }
			let slotPreparationError: string | undefined
			if (routeDocumentSource !== undefined && sourceAfterPreparation !== undefined && routePreparationSnapshotComparison?.matches) {
				try { dsnPrepared = await prepareDsnWithSlotClearances(eda, dsnPrepared, routeDocumentUuid, routeDocumentSource) }
				catch (error) {
					slotPreparationError = `槽孔补偿失败：${String((error as any)?.message ?? error)}`
				}
			}
			else
				dsnPrepared = { ...dsnPrepared, warnings: [...dsnPrepared.warnings, '槽孔补偿未运行：源码快照不可用或不稳定'], limitations: [...dsnPrepared.limitations, '槽孔补偿要求可复核的稳定 PCB 源码快照'] }
			const sourceAfterSlotPreparation = routeDocumentSource !== undefined ? await eda.sys_FileManager.getDocumentSource().catch((error: unknown) => { routeSnapshotWarning = `槽孔补偿后复核源码快照失败：${String((error as any)?.message ?? error)}`; return undefined }) : undefined
			const slotSnapshotComparison = routeDocumentSource === undefined || sourceAfterSlotPreparation === undefined ? undefined : comparePcbSourceSnapshots(routeDocumentSource, sourceAfterSlotPreparation)
			const focusAfterSlotPreparation = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focusAfterSlotPreparation?.documentType !== 3 || focusAfterSlotPreparation.uuid !== routeDocumentUuid)
				throw new Error(`槽孔准备期间 PCB 焦点已变化（原文档=${routeDocumentUuid}，当前=${focusAfterSlotPreparation?.uuid ?? '未知'}），已拒绝提交布线任务`)
			if (routeDocumentUuid && routeDocumentSource !== undefined && sourceAfterSlotPreparation !== undefined && !slotSnapshotComparison?.matches)
				throw new Error(`槽孔准备期间 PCB 源码快照已变化：${slotSnapshotComparison?.reason ?? '无法比较'}，已拒绝提交布线任务`)
			if (routeDocumentSource !== undefined && sourceAfterSlotPreparation === undefined) {
				const diagnostics = dsnPrepared
				dsnPrepared = { ...dsnRepair, warnings: [...new Set([...dsnRepair.warnings, ...diagnostics.warnings, ...(routeSnapshotWarning ? [routeSnapshotWarning] : []), ...(slotPreparationError ? [slotPreparationError] : []), '槽孔准备后无法复核源码快照，保留原 DSN'])], limitations: [...new Set([...dsnRepair.limitations, ...diagnostics.limitations, '源码快照无法复核时不提交平面或槽孔增强 DSN'])] }
			}
			if (slotPreparationError) {
				const diagnostics = dsnPrepared
				dsnPrepared = { ...dsnRepair, warnings: [...new Set([...diagnostics.warnings, slotPreparationError])], limitations: [...new Set([...diagnostics.limitations, '槽孔增强异常时保留原 DSN'])] }
			}
			const widthEvidence = await readRoutingWidthEvidence(sourceAfterSlotPreparation, { timeoutMs: 5000, readLayers: true })
			try { await assertRoutingSourceStable(routeDocumentUuid, sourceAfterSlotPreparation, 5000, '自动布线线宽规则读取') }
			catch (error) { throw new Error(`自动布线线宽规则读取后无法确认 PCB 焦点或源码稳定，已拒绝提交任务：${String((error as any)?.message ?? error)}`) }
			if (applyLayerWidthRulesRequested && (routeDocumentSource === undefined || sourceAfterDsn === undefined || !routeExportSnapshotComparison?.matches
				|| sourceAfterPreparation === undefined || !routePreparationSnapshotComparison?.matches
				|| sourceAfterSlotPreparation === undefined || !slotSnapshotComparison?.matches || !widthEvidence.snapshot))
				throw new Error('启用applyLayerWidthRules时，PCB源码/焦点/逐层线宽证据必须从DSN导出到转换完成保持已确认')
			let finalDsnPrepared = dsnPrepared
			if (applyLayerWidthRulesRequested) {
				const layerPrepared = applyDsnLayerWidthRules(widthEvidence.snapshot!, dsnPrepared.text)
				finalDsnPrepared = {
					...dsnPrepared,
					...layerPrepared,
					originalText: dsnPrepared.originalText,
					changed: dsnPrepared.changed || layerPrepared.changed,
					changes: [...dsnPrepared.changes, ...layerPrepared.changes],
					warnings: [...dsnPrepared.warnings, ...layerPrepared.warnings],
					limitations: [...dsnPrepared.limitations, ...layerPrepared.limitations],
					...(dsnPrepared.slotClearance ? { slotClearance: dsnPrepared.slotClearance } : {}),
				}
			}
			const widthRuleComparison = comparePreparedDsnWidth(widthEvidence.snapshot, finalDsnPrepared.text, widthEvidence.unknowns)
			let routeBaseline: SesRouteBaseline | undefined
			if (sourceAfterSlotPreparation !== undefined) {
				try { routeBaseline = buildSesRouteBaseline(routeDocumentUuid, sourceAfterSlotPreparation, finalDsnPrepared.text) }
				catch (error) {
					routeBaseline = { format: 'ai-command-engine-route-baseline/v1', version: 1, documentUuid: routeDocumentUuid, status: 'incomplete', arcs: [], protectedWires: [], issues: [String(error)] }
				}
			}
			if (applyLayerWidthRulesRequested)
				await assertRoutingSourceStable(routeDocumentUuid, sourceAfterSlotPreparation, 5000, '自动布线分层线宽转换')
			const dsnBase64 = await blobToBase64(new Blob([finalDsnPrepared.text], { type: dsnFile.type }))
			const session = await frRequest<{ id: string }>('POST', '/sessions/create')
			const job = await frRequest<{ id: string }>('POST', '/jobs/enqueue', { session_id: session.id, name: dsnFile.name.replace(/\.dsn$/i, ''), priority: 'NORMAL' })
			if (typeof job?.id !== 'string' || !job.id.trim())
				throw new Error('FreeRouting 创建任务未返回有效 jobId，无法绑定 PCB 文档')
			routeJobDocumentUuids.set(job.id, routeDocumentUuid)
			const settings: Record<string, unknown> = {
				max_passes: maxPasses,
				via_costs: params.viaCosts != null ? Number(params.viaCosts) : 50,
				max_threads: params.maxThreads != null ? Number(params.maxThreads) : 4,
				improvement_threshold: 0,
				trace_pull_tight_accuracy: 500,
				start_ripup_costs: 100,
				automatic_neckdown: params.automaticNeckdown === true,
				allowed_via_types: true,
			}
			await frRequest('POST', `/jobs/${job.id}/settings`, settings)
			await frRequest('POST', `/jobs/${job.id}/input`, { filename: dsnFile.name, data: dsnBase64 })
			if (routeBaseline) routeJobBaselines.set(job.id, routeBaseline)
			currentRouteJobId = job.id
			try {
				await frRequest('PUT', `/jobs/${job.id}/start`)
			}
			catch (error) {
				throw new Error(`FreeRouting 启动请求结果未知（jobId=${job.id}）；服务端可能已接受请求，只能用 pcb.autoRouteStatus 查询或 pcb.autoRouteStop 取消，不要重提`, {
					cause: { partial: true, retryable: false, jobId: job.id, outcome: 'start-request-unknown', startRequestSubmitted: 'unknown', operationError: String((error as any)?.message ?? error) },
				})
			}
			return {
				jobId: job.id,
				outcome: 'start-request-submitted',
				routingSettings: { automaticNeckdown: settings.automatic_neckdown, readbackVerified: false },
				widthRuleComparison,
				dsnConversion: {
					changed: dsnRepair.changed || dsnPrepared.changed || finalDsnPrepared.changed,
					warnings: [...dsnRepair.warnings, ...finalDsnPrepared.warnings],
					limitations: [...dsnRepair.limitations, ...finalDsnPrepared.limitations],
					...(finalDsnPrepared.slotClearance ? { slotClearance: finalDsnPrepared.slotClearance } : {}),
					...(applyLayerWidthRulesRequested ? { changes: [...dsnRepair.changes, ...finalDsnPrepared.changes] } : {}),
				},
				routingConstraintsComplete: false,
				stateVerified: false,
				note: '启动请求已提交，尚未确认任务正在布线；请保留 jobId，用 pcb.autoRouteStatus 查询任务实际状态（状态查询只读），完成后调用 pcb.autoRouteGetResult 取回 SES，再按需显式调用 pcb.importAutoRouteSes 导入；pcb.autoRouteStop 可停止任务，不要重复提交',
			}
		},
	},
	{
		name: 'pcb.autoRouteStatus',
		summary: '只查询 FreeRouting 自动布线任务状态；COMPLETED 仅返回完成状态，不读取布线输出、不自动导入、不修改 PCB。请保留返回的 jobId，完成后调用 pcb.autoRouteGetResult 取回 SES，再按需显式调用 pcb.importAutoRouteSes 导入',
		params: [
			{ name: 'jobId', type: 'string', description: '任务 ID（留空取最近启动的任务）；请保留本指令返回的 jobId，以便完成后调用 pcb.autoRouteGetResult 取回 SES' },
			{ name: 'noImport', type: 'boolean', description: '兼容参数，仅接受布尔值；当前状态查询始终不自动回灌' },
		],
		returns: '{ jobId, state, stage, currentPass, statistics?, imported:false, autoImportEnabled:false, note? }；本指令只查询状态，不获取输出或写入 PCB',
		example: { cmd: 'pcb.autoRouteStatus' },
		handler: async (params) => {
			sesCommandDeadline(params)
			if (params.noImport !== undefined && typeof params.noImport !== 'boolean')
				throw new Error('noImport 必须是布尔值')
			const jobId = params.jobId ? String(params.jobId) : currentRouteJobId
			if (!jobId)
				throw new Error('没有进行中的布线任务（先 pcb.autoRouteStart）')
			const status = await frRequest<{
				state: string, stage?: string, current_pass?: number,
				input?: { statistics?: Record<string, any> }, output?: { statistics?: Record<string, any> },
			}>('GET', `/jobs/${jobId}`)
			const base = {
				jobId,
				state: status.state,
				stage: status.stage,
				currentPass: status.current_pass,
				statistics: status.output?.statistics,
				imported: false,
				autoImportEnabled: false,
			}
			if (isTerminalRouteState(status.state))
				releaseCurrentRouteJob(jobId)
			if (status.state === 'COMPLETED') {
				return { ...base, note: '自动回灌已停用。状态查询不会获取布线输出或修改 PCB；请保留 jobId 并调用 pcb.autoRouteGetResult 取回 SES，如需导入再显式调用 pcb.importAutoRouteSes（追加模式）' }
			}
			return base
		},
	},
	{
		name: 'pcb.autoRouteGetResult',
		summary: '仅取回已完成 FreeRouting 任务的 SES 文件，不导入、不清线、不保存 PCB，也不运行 DRC。取回结果不代表已布通或 DRC 通过；需导入时另行显式调用 pcb.importAutoRouteSes',
		params: [
			{ name: 'jobId', type: 'string', required: true, description: 'pcb.autoRouteStart 返回的非空任务 ID；必须由调用方保留，不能依赖当前任务槽（完成状态查询后会清空）' },
		],
		returns: '{ jobId, state, fileName?, base64?, documentUuid, documentUuidStatus, routeBaseline?, fetched, sesSummary?, statistics?, imported:false, autoImportEnabled:false, scope }；只有状态为 COMPLETED 才读取并返回 SES；同一进程中有可用基线时随结果返回routeBaseline供显式传给pcb.importAutoRouteSes；尚未完成时 fetched:false；documentUuid 无本地任务绑定时明确为 "unknown"；读取输出不会验证布通、线宽规则或 DRC',
		example: { cmd: 'pcb.autoRouteGetResult', params: { jobId: '保留的任务ID' } },
		handler: async (params) => {
			if (typeof params.jobId !== 'string' || !params.jobId.trim())
				throw new Error('jobId 必须是非空字符串（使用 pcb.autoRouteStart 返回的任务 ID）');
			const jobId = params.jobId;
			const deadline = sesCommandDeadline(params);
			const readRequest = async <T>(path: string, phase: string): Promise<T> => {
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					throw new Error(`pcb.autoRouteGetResult ${phase}前总读取预算已耗尽，PCB 未修改`);
				return await withTimeout(frRequest<T>('GET', path), remaining, `pcb.autoRouteGetResult ${phase}`);
			};
			const status = await readRequest<{ id?: unknown; state?: unknown }>(`/jobs/${encodeURIComponent(jobId)}`, '查询状态');
			if (!status || typeof status !== 'object' || Array.isArray(status) || status.id !== jobId)
				throw new Error(`FreeRouting 状态响应 id 与请求不匹配（请求=${jobId}，读回=${String(status?.id)}）`);
			if (typeof status.state !== 'string' || !status.state.trim())
				throw new Error('FreeRouting 状态响应缺少有效 state');
			const state = status.state;
			if (isTerminalRouteState(state))
				releaseCurrentRouteJob(jobId)
			const documentUuid = routeJobDocumentUuids.get(jobId);
			const routeBaseline = routeJobBaselines.get(jobId);
			const binding = { documentUuid: documentUuid ?? 'unknown', documentUuidStatus: documentUuid ? 'known' as const : 'unknown' as const, ...(routeBaseline ? { routeBaseline } : {}) };
			if (state !== 'COMPLETED') {
				return {
					jobId,
					state: state || 'UNKNOWN',
					...binding,
					fetched: false,
					imported: false,
					autoImportEnabled: false,
					saved: false,
					sourceStabilityVerified: false,
					scope: { outputRead: false, imported: false, pcbModified: false, saved: false, drcRun: false, sourceStabilityVerified: false },
					note: '任务尚未确认完成，未读取输出；请保留 jobId 后再查询。此查询不会导入或修改 PCB',
				};
			}
			const output = await readRequest<{ job_id?: unknown; data?: unknown; filename?: unknown; format?: unknown; size?: unknown; crc32?: unknown; statistics?: unknown }>(`/jobs/${encodeURIComponent(jobId)}/output`, '读取 SES 输出');
			if (!output || typeof output !== 'object' || Array.isArray(output))
				throw new Error('FreeRouting 输出响应不是对象');
			if (output.job_id !== jobId)
				throw new Error(`FreeRouting 输出 job_id 与请求不匹配或缺失（请求=${jobId}，读回=${String(output.job_id)}）`);
			if (output.format !== 'SES')
				throw new Error(`FreeRouting 输出 format 必须为 SES，实际=${String(output.format)}`);
			if (typeof output.filename !== 'string' || !output.filename.trim() || output.filename !== output.filename.trim() || /[\\/:]/.test(output.filename) || output.filename === '.' || output.filename === '..' || [...output.filename].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7F))
				throw new Error('FreeRouting 输出 filename 必须是非空普通文件名，不能包含路径');
			if (typeof output.data !== 'string')
				throw new Error('FreeRouting 输出缺少 Base64 字段 data');
			const base64 = output.data;
			if (!base64 || base64.length % 4 !== 0 || !/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i.test(base64))
				throw new Error('FreeRouting 输出 data 不是有效的非空 Base64');
			let binary: string;
			try {
				binary = atob(base64);
			}
			catch (error) { throw new Error(`FreeRouting 输出 data Base64 解码失败：${String((error as any)?.message ?? error)}`); }
			if (!binary.length || btoa(binary) !== base64)
				throw new Error('FreeRouting 输出 data 不是标准规范 Base64');
			const sesText = decodeSesUtf8(base64).trim();
			if (!sesText || !/(?:^|\s)\(session(?:\s|\))/.test(sesText) || !sesText.endsWith(')'))
				throw new Error('FreeRouting 输出解码内容不是有效 SES session 文件');
			const ses = parseAutoRouteSes(sesText);
			const decodedSize = binary.length;
			let sizeVerified = false;
			if (output.size !== undefined && output.size !== null) {
				if (typeof output.size !== 'number' || !Number.isSafeInteger(output.size) || output.size < 0 || output.size !== decodedSize)
					throw new Error(`FreeRouting 输出 size 与解码字节数不匹配（size=${String(output.size)}，actual=${decodedSize}）`);
				sizeVerified = true;
			}
			releaseCurrentRouteJob(jobId)
			return {
				jobId,
				state,
				fileName: output.filename,
				base64,
				...binding,
				fetched: true,
				sesSummary: { wires: ses.wires.length, vias: ses.vias.length },
				outputMetadata: { format: output.format, ...(output.size !== undefined && output.size !== null ? { size: output.size } : {}), sizeVerified, ...(output.crc32 !== undefined ? { crc32: output.crc32 } : {}), crc32Verified: false },
				...(output.statistics && typeof output.statistics === 'object' && !Array.isArray(output.statistics) ? { statistics: output.statistics } : {}),
				imported: false,
				autoImportEnabled: false,
				saved: false,
				sourceStabilityVerified: false,
				scope: { outputRead: true, imported: false, pcbModified: false, saved: false, drcRun: false, sourceStabilityVerified: false },
				note: '已取回并验证 SES 文件编码与格式；未检查布通、短段、层映射、孔径、线宽规则或 DRC，未导入、修改或保存 PCB。CRC32 仅作为服务端元数据返回，未独立校验。如需导入，请显式调用 pcb.importAutoRouteSes',
			};
		},
	},
	{
		name: 'pcb.autoRouteStop',
		summary: '停止进行中的 FreeRouting 任务；此命令不会导入 SES 或修改 PCB',
		params: [
			{ name: 'jobId', type: 'string', description: '任务 ID（留空取最近启动的任务）' },
		],
		returns: '{ cancelled, jobId }',
		example: { cmd: 'pcb.autoRouteStop' },
		handler: async (params) => {
			const jobId = params.jobId ? String(params.jobId) : currentRouteJobId
			if (!jobId)
				throw new Error('没有进行中的布线任务')
			const status = await frRequest<{ state?: string }>('GET', `/jobs/${jobId}`)
			const state = String(status?.state ?? '').trim().toUpperCase()
			if (isTerminalRouteState(state))
				releaseCurrentRouteJob(jobId)
			if (state === 'COMPLETED') {
				return { cancelled: false, jobId, state, note: '任务已结束，无需取消' }
			}
			if (isTerminalRouteState(state)) {
				return { cancelled: false, jobId, state, note: '任务已结束，无需取消' }
			}
			if (state !== 'RUNNING' && state !== 'READY_TO_START' && state !== 'QUEUED')
				return { cancelled: false, jobId, state: state || undefined, outcome: 'cancel-not-sent', note: '任务状态未知或不支持取消；未发送取消请求，请先查询任务状态' }
			await frRequest('PUT', `/jobs/${jobId}/cancel`)
			let afterCancel: { state?: string }
			try {
				afterCancel = await frRequest<{ state?: string }>('GET', `/jobs/${jobId}`)
			}
			catch (error) {
				return {
					cancelled: false,
					jobId,
					outcome: 'cancel-request-unknown',
					note: `取消请求已接受，但无法确认任务状态；请用 pcb.autoRouteStatus 查询后再决定下一步（${String((error as any)?.message ?? error)}）`,
				}
			}
			const afterState = String(afterCancel?.state ?? '').trim().toUpperCase()
			if (isTerminalRouteState(afterState)) {
				releaseCurrentRouteJob(jobId)
				if (afterState !== 'CANCELLED' && afterState !== 'CANCELED')
					return { cancelled: false, jobId, state: afterState, note: '任务已结束，无需取消' }
				return { cancelled: true, jobId, state: afterState }
			}
			return {
				cancelled: false,
				jobId,
				state: afterState || undefined,
				outcome: afterState === 'RUNNING' || afterState === 'READY_TO_START' || afterState === 'QUEUED' ? 'cancel-request-pending' : 'cancel-request-unknown',
				note: afterState
					? `取消请求已接受，但尚未观察到 CANCELLED 状态（当前：${afterState}）；任务 ID 已保留，请稍后查询状态`
					: '取消请求已接受，但返回状态为空；任务 ID 已保留，请查询状态',
			}
		},
	},
]
