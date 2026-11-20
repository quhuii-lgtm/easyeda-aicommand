import type { ICommandContext, ICommandDef } from '../engine/types'
import { beginTask, failTask, finishTask } from '../engine/tasks'
import { compareDocumentSources } from '../engine/documentRecovery'
import { readRouteSnapshot } from '../engine/autoRouteSesHost'
import { checkSesWidthRules, buildRoutingWidthSnapshot } from '../engine/routingWidthRules'
import { getBridgeInstanceId } from '../bridge/client'
import { kiRoutingRequest } from '../bridge/kirouting'
import { collectKiRoutingInput, type KiRoutingInput, type KiRoutingTarget } from '../pcb/kiroutingInput'
import { executeCommand } from '../engine/registry'
import { parseAutoRouteSes, mapSesRoutes } from '../engine/autoRouteSes'
import { findShortRouteSegments, MIN_ROUTE_SEGMENT_LENGTH_MIL } from '../engine/routeSegmentRules'

type JobBinding = { operationId: string, jobId?: string, target: KiRoutingTarget, input?: KiRoutingInput }
const jobsByOperation = new Map<string, JobBinding>()
const jobsByJob = new Map<string, JobBinding>()
const importedOperations = new Set<string>()

function fail(message: string, cause?: unknown): never { throw new Error(message, cause === undefined ? undefined : { cause }) }
function requireString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`)
	return value.trim()
}
function rejectUnknown(params: Record<string, any>, allowed: string[]): void {
	for (const key of Object.keys(params)) if (!allowed.includes(key) && !key.startsWith('__') && !['instanceId', '_timeoutMs'].includes(key)) throw new Error(`未知参数: ${key}`)
}
async function assertTarget(ctx: ICommandContext): Promise<{ target: KiRoutingTarget, source: string }> {
	ctx.stopSignal?.assertActive()
	if (!ctx.documentTarget || !ctx.assertDocumentTarget) throw new Error('KiRouting 必须由注册表在当前 PCB 文档目标下执行')
	await ctx.assertDocumentTarget!()
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	await ctx.assertDocumentTarget()
	if (doc?.documentType !== 3 || doc.uuid !== ctx.documentTarget.uuid) throw new Error('KiRouting 当前目标不是原注册表绑定的 PCB')
	const projectUuid = String(ctx.documentTarget.parentProjectUuid ?? '')
	const tabId = String(ctx.documentTarget.tabId ?? doc.tabId ?? '')
	if (!projectUuid || !tabId) throw new Error('KiRouting 缺少明确的工程 UUID 或页签身份，拒绝提交')
	const source = await eda.sys_FileManager.getDocumentSource()
	await ctx.assertDocumentTarget()
	if (typeof source !== 'string' || !source.trim()) throw new Error('KiRouting 无法读取目标 PCB 源码')
	return { target: { instanceId: getBridgeInstanceId(), projectUuid, documentUuid: ctx.documentTarget.uuid, tabId }, source }
}
function assertBinding(binding: JobBinding | undefined, target: KiRoutingTarget): JobBinding {
	if (!binding) throw new Error('此运行时没有该 KiRouting 任务的目标绑定；请提供本目标创建的 operationId 并先查询状态，不能猜取其他任务')
	if (binding.target.projectUuid !== target.projectUuid || binding.target.documentUuid !== target.documentUuid || binding.target.tabId !== target.tabId || binding.target.instanceId !== target.instanceId)
		throw new Error('KiRouting 任务与当前实例/工程/PCB/页签不一致，拒绝访问')
	return binding
}
function getBinding(params: Record<string, any>, target: KiRoutingTarget): JobBinding {
	const operationId = typeof params.operationId === 'string' ? params.operationId : undefined
	const jobId = typeof params.jobId === 'string' ? params.jobId : undefined
	if (!operationId && !jobId) throw new Error('必须提供 operationId 或 jobId，不按最近任务猜测')
	const binding = (operationId ? jobsByOperation.get(operationId) : undefined) ?? (jobId ? jobsByJob.get(jobId) : undefined)
	if (operationId && binding && binding.operationId !== operationId) throw new Error('operationId 与 jobId 指向不同任务')
	if (jobId && binding?.jobId && binding.jobId !== jobId) throw new Error('jobId 与已绑定 operationId 不符')
	if (binding) return assertBinding(binding, target)
	// Recovery after a response loss or extension reload remains target-scoped by sending the
	// caller's explicit operation/job identity and current project/document/tab to the backend.
	return { operationId: operationId ?? '', jobId, target }
}
async function callBackend<T = any>(action: 'info' | 'install' | 'start' | 'status' | 'stop' | 'result' | 'list', params: Record<string, unknown>, ctx?: ICommandContext): Promise<T> {
	let response: Awaited<ReturnType<typeof kiRoutingRequest<T>>>
	try { response = await kiRoutingRequest<T>(action, params) }
	catch (error) {
		if (action === 'start' || action === 'install') throw new Error(`KiRouting ${action} 传输调用异常；服务端是否已创建任务未知`, { cause: { partial: true, operationId: params.operationId, outcome: 'unknown', reason: String((error as any)?.message ?? error) } })
		throw error
	}
	try {
		ctx?.stopSignal?.assertActive()
		if (ctx?.assertDocumentTarget) await ctx.assertDocumentTarget()
	}
	catch (error) {
		if (action === 'start' || action === 'install') throw new Error(`KiRouting ${action} 请求后目标守卫失败；服务端是否已创建任务未知`, { cause: { partial: true, operationId: params.operationId, outcome: 'unknown', reason: String((error as any)?.message ?? error) } })
		throw error
	}
	if (!response.ok) {
		const error: any = new Error(response.error?.message ?? `KiRouting ${action} 请求失败`, response.error ? { cause: response.error } : undefined)
		error.details = response.error
		throw error
	}
	return response.data as T
}
function backendUnavailable(data: any): boolean { return Boolean(data?.setupRequired || data?.runtimeReady === false || data?.available === false) }
async function infoHandler(params: Record<string, any>, ctx?: ICommandContext) {
	rejectUnknown(params, [])
	const data = await callBackend<any>('info', {}, ctx)
	return { ...data, setupRequired: backendUnavailable(data), note: backendUnavailable(data) ? 'KiRouting 运行环境未就绪；请按代理返回的状态完成环境配置，再重新查询' : undefined }
}
async function installHandler(params: Record<string, any>, ctx?: ICommandContext) {
	rejectUnknown(params, ['confirmed'])
	if (params.confirmed !== true) throw new Error('安装需要明确传 confirmed:true')
	const data = await callBackend<any>('install', { confirmed: true }, ctx)
	return { engine: 'kirouting', type: 'install', ...data, note: '安装任务由本地代理执行；此响应不表示运行时已就绪，请再查询 pcb.kiRoutingInfo' }
}
async function startHandler(params: Record<string, any>, ctx?: ICommandContext) {
	rejectUnknown(params, ['operationId', 'settings'])
	if (!ctx) throw new Error('KiRouting start 缺少命令上下文')
	const operationId = requireString(params.operationId, 'operationId')
	const prior = jobsByOperation.get(operationId)
	if (prior) {
		const { target } = await assertTarget(ctx)
		assertBinding(prior, target)
		return statusLike('status', { operationId }, ctx)
	}
	const settings = params.settings
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings 必须是对象')
	if (!['single', 'differential', 'length-match', 'fanout'].includes(settings.mode)) throw new Error('settings.mode 必须明确选择 single/differential/length-match/fanout，不会静默改用其他模式')
	if (settings.keep_input_copper !== true) throw new Error('KiRouting 必须显式传 keep_input_copper:true')
	const { target } = await assertTarget(ctx)
	const capability = await callBackend<any>('info', {}, ctx)
	if (backendUnavailable(capability)) return { setupRequired: true, runtimeReady: false, operationId, target, capability }
	const supportedModes = Array.isArray(capability?.supportedModes) ? capability.supportedModes : []
	if (!supportedModes.includes(settings.mode)) throw new Error(`KiRouting 后端当前未声明支持 mode=${settings.mode}；可用模式：${supportedModes.join(', ') || '未声明'}`)
	const modeSchema = capability?.modeInputSchema?.[settings.mode] ?? capability?.settingsFields?.[settings.mode]
	const fields = Array.isArray(modeSchema) ? modeSchema : Array.isArray(modeSchema?.fields) ? modeSchema.fields : undefined
	if (!fields) throw new Error(`KiRouting info 未提供 mode=${settings.mode} 的输入 schema，拒绝猜测参数`)
	const allowed = new Set([...fields.map((field: any) => String(field?.key ?? field?.name ?? '')), 'mode', 'keep_input_copper'])
	for (const key of Object.keys(settings)) if (!allowed.has(key)) throw new Error(`settings.${settings.mode} 未声明参数 ${key}`)
	for (const field of fields) {
		const key = String(field?.key ?? field?.name ?? '')
		if (!key) continue
		const value = settings[key]
		if (field?.required === true && (value === undefined || value === null || value === '')) throw new Error(`settings.${settings.mode} 缺少必填参数 ${key}`)
		if (value === undefined || value === null) continue
		const type = String(field?.type ?? '').toLowerCase()
		if (['array', 'string[]', 'array<string>'].includes(type) && (!Array.isArray(value) || (type !== 'array' && !value.every((item: unknown) => typeof item === 'string')))) throw new Error(`settings.${settings.mode}.${key} 类型不符合 ${type}`)
		if (['number', 'integer'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))) throw new Error(`settings.${settings.mode}.${key} 类型不符合 ${type}`)
		if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`settings.${settings.mode}.${key} 必须是 boolean`)
		if (type === 'string' && typeof value !== 'string') throw new Error(`settings.${settings.mode}.${key} 必须是 string`)
		if (Array.isArray(field?.options)) {
			const options = new Set(field.options.map((option: any) => option && typeof option === 'object' ? option.value : option))
			for (const item of Array.isArray(value) ? value : [value]) if (!options.has(item)) throw new Error(`settings.${settings.mode}.${key} 包含 schema 未声明选项 ${String(item)}`)
		}
	}
	const effectiveSettings = { ...settings }
	const input = await collectKiRoutingInput(eda, ctx, target)
	if (input.coverage.unsupported.length) throw new Error(`KiRouting 输入覆盖不完整，拒绝提交：${input.coverage.unsupported.join('; ')}`)
	const { task, existing } = beginTask('pcb.kiRoutingStart', { operationId, target, inputDigest: input.inputDigest, settings: effectiveSettings }, t => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress }))
	if (existing) return { taskId: task.id, alreadyRunning: true, state: task.state, progress: task.progress }
	const binding: JobBinding = { operationId, target, input }
	jobsByOperation.set(operationId, binding)
	try {
		await ctx.assertDocumentTarget!()
		const data = await callBackend<any>('start', { operationId, target, input, settings: { ...effectiveSettings, ruleEvidence: input.ruleEvidence } }, ctx)
		if (data?.setupRequired) { finishTask(task, data); return data }
		const jobId = typeof data?.jobId === 'string' ? data.jobId : undefined
		binding.jobId = jobId
		if (jobId) jobsByJob.set(jobId, binding)
		const result = { engine: 'kirouting', operationId, jobId, target, state: data?.state ?? 'submitted', inputDigest: input.inputDigest, format: 'kirouting-json', imported: false, inputCoverage: input.coverage, settings: effectiveSettings, ...data }
		finishTask(task, result)
		return result
	}
	catch (error) {
		failTask(task, error)
		if ((error as any)?.cause?.partial === true) throw new Error((error as Error).message, { cause: { partial: true, source: 'kirouting-start', operationId, outcome: 'unknown', details: (error as any).cause } })
		throw error
	}
}
async function statusLike(action: 'status' | 'stop' | 'result', params: Record<string, any>, ctx?: ICommandContext) {
	rejectUnknown(params, ['operationId', 'jobId', 'kind'])
	if (!ctx) throw new Error(`KiRouting ${action} 缺少命令上下文`)
	const { target } = await assertTarget(ctx)
	if (action === 'status' && params.kind === 'install') {
		const jobId = requireString(params.jobId, 'jobId')
		const data = await callBackend<any>('status', { jobId, type: 'install', target }, ctx)
		return { engine: 'kirouting', type: 'install', jobId, target, ...data }
	}
	if (params.kind !== undefined) throw new Error('kind 只允许在 pcb.kiRoutingStatus 中使用 kind:install')
	const binding = getBinding(params, target)
	const data = await callBackend<any>(action, { ...(binding.operationId ? { operationId: binding.operationId } : {}), jobId: params.jobId ?? binding.jobId, target }, ctx)
	if (typeof data?.operationId === 'string') binding.operationId = data.operationId
	if (typeof data?.jobId === 'string') { binding.jobId = data.jobId; jobsByJob.set(data.jobId, binding) }
	if (binding.operationId) jobsByOperation.set(binding.operationId, binding)
	return action === 'result'
		? { engine: 'kirouting', operationId: binding.operationId, jobId: binding.jobId, target, format: data?.format ?? 'kirouting-json', imported: false, ...data }
		: { engine: 'kirouting', operationId: binding.operationId, jobId: binding.jobId, target, state: data?.state ?? 'unknown', ...data }
}
function fmtNum(value: number): string { return Number.isFinite(value) ? String(value) : fail('KiRouting 输出包含非有限数字') }
function quote(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"` }
function hasKnownToleranceFailure(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasKnownToleranceFailure)
	return Object.entries(value as Record<string, unknown>).some(([key, item]) => key === 'withinTolerance' && item === false || hasKnownToleranceFailure(item))
}
function resultToSes(result: any, layerMap: Map<number, string>, outerSpan: [number, number]): { ses: string, holes: Record<string, number> } {
	if (result?.schemaVersion !== 1 || result?.units !== 'mil' || !Array.isArray(result.lines) || !Array.isArray(result.vias)) throw new Error('KiRouting 结果 schemaVersion/units/lines/vias 无效')
	const sesLayerName = (id: number): string | undefined => layerMap.has(id) ? id === 1 ? 'TopLayer' : id === 2 ? 'BottomLayer' : layerMap.get(id) : undefined
	const nets = new Map<string, string[]>()
	for (const [i, line] of result.lines.entries()) {
		const net = requireString(line?.net, `lines[${i}].net`)
		const layer = sesLayerName(Number(line?.layer))
		if (!layer) throw new Error(`KiRouting 结果线段 ${i + 1} 指向未知或未启用 SIGNAL 层 ${String(line?.layer)}`)
		const width = Number(line?.widthMil)
		if (!Number.isFinite(width) || width <= 0) throw new Error(`KiRouting 结果线段 ${i + 1} 线宽无效`)
		const a = { x: Number(line?.a?.x), y: Number(line?.a?.y) }, b = { x: Number(line?.b?.x), y: Number(line?.b?.y) }
		if (![a.x, a.y, b.x, b.y].every(Number.isFinite) || (a.x === b.x && a.y === b.y)) throw new Error(`KiRouting 结果线段 ${i + 1} 坐标无效或零长`)
		const list = nets.get(net) ?? []
		list.push(`(wire (path ${quote(layer)} ${fmtNum(width)} ${fmtNum(a.x)} ${fmtNum(a.y)} ${fmtNum(b.x)} ${fmtNum(b.y)}))`)
		nets.set(net, list)
	}
	const holes: Record<string, number> = {}
	const padstacks = new Map<string, { name: string, diameter: number, hole: number }>()
	for (const [i, via] of result.vias.entries()) {
		const net = requireString(via?.net, `vias[${i}].net`)
		const diameter = Number(via?.diameterMil), hole = Number(via?.holeDiameterMil)
		if (![diameter, hole].every(Number.isFinite) || diameter <= 0 || hole <= 0 || hole >= diameter) throw new Error(`KiRouting 结果过孔 ${i + 1} 孔径或焊盘直径无效`)
		const viaType = String(via?.viaType ?? via?.via_type ?? 'through').toLowerCase()
		if (!['through', 'thru', 'through-hole', 'thru-hole'].includes(viaType)) throw new Error(`KiRouting 结果过孔 ${i + 1} 类型 ${viaType} 不是当前导入链可验证的通孔`)
		for (const key of ['viaSpan', 'via_span']) {
			if (!Object.prototype.hasOwnProperty.call(via, key)) continue
			const span = via[key]
			if (!Array.isArray(span) || span.length !== 2 || span[0] !== outerSpan[0] || span[1] !== outerSpan[1]) throw new Error(`KiRouting 结果过孔 ${i + 1} 跨层 ${JSON.stringify(span)} 不能证明为当前板层栈的全层通孔`)
		}
		if ((Object.prototype.hasOwnProperty.call(via, 'startLayer') || Object.prototype.hasOwnProperty.call(via, 'endLayer')) && (via.startLayer !== outerSpan[0] || via.endLayer !== outerSpan[1])) throw new Error(`KiRouting 结果过孔 ${i + 1} 起止层不能证明为当前板层栈的全层通孔`)
		const x = Number(via?.x), y = Number(via?.y)
		if (![x, y].every(Number.isFinite)) throw new Error(`KiRouting 结果过孔 ${i + 1} 坐标无效`)
		const key = `${diameter.toPrecision(12)}:${hole.toPrecision(12)}`
		let padstack = padstacks.get(key)?.name
		if (!padstack) { padstack = `ki_via_${padstacks.size}`; padstacks.set(key, { name: padstack, diameter, hole }); holes[padstack] = hole }
		const list = nets.get(net) ?? []
		list.push(`(via ${padstack} ${fmtNum(x)} ${fmtNum(y)})`)
		nets.set(net, list)
	}
	if (!nets.size) throw new Error('KiRouting 结果没有新增线段或过孔')
	const padstackSexpr = [...padstacks.values()].map(({ diameter, name }) => {
		const topName = sesLayerName(outerSpan[0]), bottomName = sesLayerName(outerSpan[1])
		if (typeof topName !== 'string' || !topName.trim() || typeof bottomName !== 'string' || !bottomName.trim()) throw new Error('KiRouting 过孔缺少已启用顶层／底层名称')
		// Use exactly the same names as wires; mixing "Top Layer" with TopLayer
		// causes the strict SES mapper to see duplicate aliases for one layer.
		return `(padstack ${name} (shape (circle ${quote(topName)} ${fmtNum(diameter)} 0 0)) (shape (circle ${quote(bottomName)} ${fmtNum(diameter)} 0 0)))`
	}).join(' ')
	const netSexpr = [...nets].map(([net, routes]) => `(net ${quote(net)} ${routes.join(' ')})`).join(' ')
	const ses = `(session (placement (resolution mil 1)) (routes (resolution mil 1) (library_out ${padstackSexpr}) (network_out ${netSexpr})))`
	const parsed = parseAutoRouteSes(ses)
	if (parsed.wires.length !== result.lines.length || parsed.vias.length !== result.vias.length) throw new Error('KiRouting→SES转换读回数量不匹配')
	return { ses, holes }
}
function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let binary = ''
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
	return btoa(binary)
}
async function importHandler(params: Record<string, any>, ctx?: ICommandContext) {
	rejectUnknown(params, ['operationId', 'jobId', 'dryRun'])
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 必须是 boolean')
	const dryRun = params.dryRun !== false
	if (!ctx) throw new Error('KiRouting import 缺少命令上下文')
	const { target } = await assertTarget(ctx)
	const binding = getBinding(params, target)
	if (!binding.input) throw new Error('恢复到新的扩展运行时后缺少本地基线源码，状态可以查询但不能安全导入；请重新采集并提交新操作')
	if (importedOperations.has(binding.operationId)) throw new Error('该 KiRouting operationId 已导入；若需重新布线，请创建新的 operationId')
	const job = await callBackend<any>('result', { operationId: binding.operationId, jobId: params.jobId ?? binding.jobId, target }, ctx)
	if (job?.state && !['completed', 'COMPLETED', 'done'].includes(job.state)) throw new Error(`KiRouting job 尚未完成（state=${job.state}）`)
	const result = job?.result ?? job
	const modeMetrics = result?.modeMetrics ?? job?.modeMetrics ?? null
	if (hasKnownToleranceFailure(modeMetrics)) throw new Error('KiRouting modeMetrics 明确报告未达到长度/匹配容差；保留原始指标供查看，拒绝导入')
	if (job?.format && job.format !== 'kirouting-json') throw new Error(`KiRouting 返回了不支持的结果格式 ${job.format}`)
	if (result?.target?.documentUuid !== target.documentUuid || result?.target?.projectUuid !== target.projectUuid || (result?.target?.tabId && result.target.tabId !== target.tabId)) throw new Error('KiRouting 结果目标工程/PCB/页签与当前目标不一致')
	if (result?.inputDigest !== binding.input.inputDigest) throw new Error('KiRouting 结果 inputDigest 与提交输入不匹配')
	if (result?.existingCopperPreserved !== true || !Array.isArray(result.removedInputCopper) || result.removedInputCopper.length !== 0) throw new Error('KiRouting 未确认保留输入铜或报告移除输入铜，拒绝导入')
	if (result?.coverage?.complete !== true || (Array.isArray(result.coverage?.unsupported) && result.coverage.unsupported.length)) throw new Error('KiRouting 结果覆盖不完整，拒绝导入')
	const current = await readRouteSnapshot(eda, () => ctx.assertDocumentTarget!())
	const baseline = compareDocumentSources(binding.input.baseline.source, current.source)
	if (!baseline.equal) throw new Error(`KiRouting 任务期间 PCB 源码发生变化，拒绝导入：${baseline.difference ?? '来源不匹配'}`)
	const inputNets = new Set(binding.input.nets.map(net => net.name))
	for (const route of [...(result.lines ?? []), ...(result.vias ?? [])]) if (!inputNets.has(route?.net)) throw new Error(`KiRouting 结果包含输入中不存在的网络 ${String(route?.net)}`)
	const signalLayers = current.layers.filter(layer => layer.type.toUpperCase() === 'SIGNAL')
	const activeSignalLayers = signalLayers.filter(layer => layer.layerStatus === undefined || layer.layerStatus === 1)
	const layers = new Map<number, string>(activeSignalLayers.map(layer => [Number(layer.id), String(layer.name)]))
	// Canonical top/bottom IDs are 1/2. SDK enumeration also contains inactive
	// inner layers, so its first/last elements do not describe a through via.
	if (!layers.has(1) || !layers.has(2)) throw new Error('KiRouting 导入无法确认已启用的顶层和底层铜层')
	const outerSpan: [number, number] = [1, 2]
	const converted = resultToSes(result, layers, outerSpan)
	const sesExpected = mapSesRoutes(parseAutoRouteSes(converted.ses), current.layers)
	for (const line of sesExpected.lines) {
		if (!inputNets.has(line.net)) throw new Error(`SES 转换结果出现输入中不存在的网络 ${line.net}`)
	}
	const shortSegments = findShortRouteSegments(sesExpected.lines)
	if (shortSegments.length) {
		const shortest = Math.min(...shortSegments.map(segment => segment.lengthMil))
		throw new Error(`KiRouting SES 预检发现 ${shortSegments.length} 条短线段，最短 ${shortest} mil；低于已有导入下限 ${MIN_ROUTE_SEGMENT_LENGTH_MIL} mil，结果未写入`, { cause: { shortSegments } })
	}
	const sdkNetRules = await eda.pcb_Drc.getNetRules()
	const config = await buildRoutingWidthSnapshot({ source: current.source, layers: current.layers, netRules: sdkNetRules, editorVersion: String(eda.sys_Environment.getEditorCurrentVersion?.() ?? '') })
	await ctx.assertDocumentTarget!()
	const widthCheck = checkSesWidthRules(config, sesExpected.lines, binding.input.routing_net_aliases, sdkNetRules)
	if (widthCheck.status !== 'compliant') throw new Error(`KiRouting 新路线无法按当前 EDA 规则确认：${JSON.stringify(widthCheck)}`)
	const preview = { operationId: binding.operationId, jobId: binding.jobId, target, inputDigest: result.inputDigest, counts: { lines: sesExpected.lines.length, vias: sesExpected.vias.length }, widths: widthCheck, ruleStatus: config.globalStatus, modeMetrics, statistics: result.statistics, existingCopperPreserved: true, removedInputCopper: [], drc: 'not-run', persistence: 'not-verified' }
	if (dryRun) return { dryRun: true, preview, note: '只读预检；确认后传 dryRun:false 才复用 SES 追加导入，既有线路保留，未运行整板 DRC' }
	const { task, existing } = beginTask('pcb.importKiRoutingResult', { operationId: binding.operationId, target, inputDigest: result.inputDigest }, t => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress }))
	if (existing) return { taskId: task.id, alreadyRunning: true, state: task.state, progress: task.progress }
	try {
		await ctx.assertDocumentTarget!()
		const currentAgain = await eda.sys_FileManager.getDocumentSource()
		await ctx.assertDocumentTarget!()
		if (typeof currentAgain !== 'string') throw new Error('KiRouting 执行前无法读取有效源码基线，拒绝写入')
		if (!compareDocumentSources(binding.input.baseline.source, currentAgain).equal) throw new Error('KiRouting 执行前 PCB 源码基线已变化，拒绝写入')
		const imported = await executeCommand({ cmd: 'pcb.importAutoRouteSes', params: { fileName: `kirouting-${binding.operationId}.ses`, base64: base64Utf8(converted.ses), viaHoleDiametersMil: converted.holes, __docUuid: target.documentUuid, __tabId: target.tabId, __projectUuid: target.projectUuid } }, ctx)
		if (!imported.ok) {
			const error = new Error(imported.error.message)
			if ((imported.error as any).cause?.partial === true) throw new Error(error.message, { cause: { partial: true, source: 'kirouting-ses-import', operationId: binding.operationId, cause: (imported.error as any).cause } })
			throw error
		}
		const data = { imported: true, dryRun: false, operationId: binding.operationId, jobId: binding.jobId, target, format: 'kirouting-json', convertedTransport: 'SES', modeMetrics, sesGeometryVerified: (imported.data as any)?.sesGeometryVerified ?? false, importResult: imported.data, drc: 'not-run', persistence: 'not-verified', note: 'KiRouting canonical JSON 已转换为 SES 并复用现有 append 导入器；结果的坐标/规则读回语义由 SES 导入器返回，KiRouting 原始输出仍以 kirouting-json 为准' }
		importedOperations.add(binding.operationId)
		finishTask(task, data)
		return data
	}
	catch (error) {
		failTask(task, error)
		if ((error as any)?.cause?.partial) throw error
		throw error
	}
}

function def(name: string, summary: string, params: ICommandDef['params'], returns: string, handler: ICommandDef['handler']): ICommandDef { return { name, summary, params, returns, handler } }
export const kiRoutingCommands: ICommandDef[] = [
	def('pcb.kiRoutingInfo', '查询 KiRouting 本地运行环境和支持能力', [], '{ supportedModes, runtimeReady, setupRequired, python, install }', infoHandler),
	def('pcb.kiRoutingInstall', '按用户明确确认安装 KiRouting 本地运行环境', [{ name: 'confirmed', type: 'boolean', required: true, description: '必须明确为 true 才提交本地安装任务' }], '{ installJob, state }', installHandler),
	def('pcb.exportKiRouting', '只读采集当前 PCB 实际网络、器件、焊盘、板框、布线障碍与规则；不启动路由', [], '{ schemaVersion:1, units:"mil", target, inputDigest, board, components, nets:[{name,pads}], unconnected_pads, existing_tracks, existing_vias, existing_arcs, existing_copper_obstacles, choices:{nets,differentialPairs,lengthMatchGroups,components}, ruleEvidence, routing_net_aliases, baseline, coverage }；routing_net_aliases 证明原始几何网名与规则网名的对应，不改写网络名；焊盘保留 SDK 原始 shape；RECT 的 cornerRadiusMil 是明确的物理半径，cornerRadiusSource 标明已核对的半短边百分比换算；简单直线 POLYGON 的 polygon.coordinateSpace 为 global-mil，点已包含旋转，不再次旋转。coverage.complete 只表示已支持几何的采集完整性，routingConstraintsComplete 始终 false，不代表全部规则、DRC 或制造通过；unsupported 逐项列未覆盖对象，不能静默忽略后提交', async (_p, ctx) => {
		if (!ctx) throw new Error('KiRouting 输入导出缺少命令上下文')
		const { target } = await assertTarget(ctx)
		return collectKiRoutingInput(eda, ctx, target)
	}),
	def('pcb.kiRoutingList', '列出当前工程/PCB/页签下 KiRouting 任务，供丢失回包后恢复', [], '{ jobs:[{operationId,jobId,state,target}] }', async (_p, ctx) => {
		if (!ctx) throw new Error('KiRouting list 缺少命令上下文')
		const { target } = await assertTarget(ctx)
		const data = await callBackend<any>('list', { target }, ctx)
		const jobs = Array.isArray(data?.jobs) ? data.jobs.filter((job: any) => job?.target?.instanceId === target.instanceId && job?.target?.projectUuid === target.projectUuid && job?.target?.documentUuid === target.documentUuid && job?.target?.tabId === target.tabId) : []
		return { engine: 'kirouting', target, jobs, note: '只返回当前目标身份完全匹配的任务' }
	}),
	def('pcb.kiRoutingStart', '采集并提交当前 PCB 的 KiRouting 自动布线任务，不写 PCB', [
		{ name: 'operationId', type: 'string', required: true, description: '调用方生成并持久保存的本次唯一操作 ID；回包不确定时用同 ID 查状态，不重发新 ID' },
		{ name: 'settings', type: 'object', required: true, description: '必须显式指定 mode 和 keep_input_copper:true；其余字段按 pcb.kiRoutingInfo 返回的该模式 schema 填写' },
	], '{ engine, operationId, jobId, target, state, inputDigest, inputCoverage, imported:false }', startHandler),
	def('pcb.kiRoutingStatus', '按当前目标和明确 operationId/jobId 查询 KiRouting 状态', [{ name: 'operationId', type: 'string', description: '已提交任务的 operationId' }, { name: 'jobId', type: 'string', description: '已提交任务的 jobId' }, { name: 'kind', type: 'string', description: 'install 用于查询明确的环境安装任务，需同时传 jobId' }], '{ engine, operationId, jobId, target, state, routingOutcome? }；completed 表示计算结束，routingOutcome 的 partial 表示仍有未完成网络，constraints-not-met 表示已知约束未满足，generated 也不代表 EDA 导入或 DRC 通过。继续用 pcb.kiRoutingGetResult 查看统计和逐组指标', (p, c) => statusLike('status', p, c)),
	def('pcb.kiRoutingStop', '按当前目标停止指定 KiRouting 任务', [{ name: 'operationId', type: 'string', description: '已提交任务的 operationId' }, { name: 'jobId', type: 'string', description: '已提交任务的 jobId' }], '{ engine, operationId, jobId, target, state }', (p, c) => statusLike('stop', p, c)),
	def('pcb.kiRoutingGetResult', '取回指定 KiRouting 任务的 JSON 路由结果，不修改 PCB', [{ name: 'operationId', type: 'string', description: '已提交任务的 operationId' }, { name: 'jobId', type: 'string', description: '已提交任务的 jobId' }], '{ format:"kirouting-json", result }', (p, c) => statusLike('result', p, c)),
	def('pcb.importKiRoutingResult', '预检或显式导入当前目标绑定的 KiRouting 结果；默认只读预检', [
		{ name: 'operationId', type: 'string', required: true, description: '已提交任务的 operationId' },
		{ name: 'jobId', type: 'string', description: '已提交任务的 jobId' },
		{ name: 'dryRun', type: 'boolean', description: '默认 true，只做完整导入预检；明确 false 才通过现有 SES append 导入器写入' },
	], '{ dryRun, preview?, imported, importResult?, drc, persistence }；沿用 SES 每段至少 1 mil 的既有要求；短段在预检及真实导入前拒绝，错误含数量和最短长度，cause.shortSegments 含序号、网络、图层、端点和长度，未修改结果或 PCB', importHandler),
]
