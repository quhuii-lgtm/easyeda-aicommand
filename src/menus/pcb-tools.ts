import { getBridgeInstanceId } from '../bridge/client'
import { getProxyUrl } from '../bridge/proxy-endpoint'
import { frRequest } from '../bridge/freerouting'

type MenuAction = 'group' | 'mark-regions' | 'locate-region' | 'route-start' | 'route-status' | 'route-stop' | 'route-fetch' | 'route-import'
type RouteEngine = 'native' | 'freerouting' | 'kirouting'
type NativeBinding = { jobId: string, projectUuid: string, pcbUuid: string }
type Target = { uuid: string, tabId: string, name: string, projectUuid?: string }
type CommandReply = { ok: boolean, cmd?: string, data?: any, error?: { message?: string, cause?: any } }
type RouteSession = { engine: RouteEngine, target: Target, jobId?: string, operationId?: string, jobKind?: 'install', ses?: any, kiResult?: any, unknownStart?: boolean, state?: string, nativeBinding?: NativeBinding }

const routeSessions = new Map<string, RouteSession>()
let activeAction: MenuAction | null = null
let routeOperationSequence = 0
const uncertainBoards = new Map<string, string>()
const uncertainStartOperationByBoard = new Map<string, string>()
const terminalRouteStates = new Set(['completed', 'canceled', 'cancelled', 'failed', 'aborted', 'error', 'done', 'succeeded'])
const routeEnded = (state: unknown): boolean => typeof state === 'string' && terminalRouteStates.has(state.toLowerCase())
const keyOf = (target: Target): string => `${target.tabId}::${target.uuid}`

function newRouteOperationId(): string {
	routeOperationSequence += 1
	return `${Date.now().toString(36)}-${routeOperationSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

function message(content: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(content, title)
}

function confirm(content: string, title: string, yes: string): Promise<boolean> {
	return new Promise(resolve => eda.sys_Dialog.showConfirmationMessage(content, title, yes, '取消', resolve))
}

function input(content: string, title: string, value: string, props: { min?: number, max?: number, step?: number, placeholder?: string } = {}): Promise<string | undefined> {
	return new Promise(resolve => eda.sys_Dialog.showInputDialog(content, '', title, 'number', value, props, (answer: unknown) => resolve(answer == null || answer === '' ? undefined : String(answer))))
}

function select(options: Array<{ value: string, displayContent: string }>, title: string, defaultOption: string): Promise<string | undefined> {
	return new Promise(resolve => eda.sys_Dialog.showSelectDialog(options, '', '', title, defaultOption, false, value => resolve(value || undefined)))
}

async function currentTarget(): Promise<Target> {
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (doc?.documentType !== 3 || typeof doc.uuid !== 'string' || !doc.uuid.trim() || typeof (doc as any).tabId !== 'string' || !(doc as any).tabId.trim())
		throw new Error('请先激活目标 PCB 标签页；菜单要求有效 PCB UUID 和 tabId')
	const project: any = await eda.dmt_Project.getCurrentProjectInfo()
	const boards = Array.isArray(project?.data) ? project.data : []
	const board = boards.find((item: any) => item?.pcb?.uuid === doc.uuid)
	const projectUuid = typeof (doc as any).parentProjectUuid === 'string' && (doc as any).parentProjectUuid.trim() ? (doc as any).parentProjectUuid : typeof project?.uuid === 'string' && project.uuid.trim() ? project.uuid : undefined
	return { uuid: doc.uuid, tabId: (doc as any).tabId, name: String(board?.pcb?.name ?? board?.name ?? doc.uuid), ...(projectUuid ? { projectUuid } : {}) }
}

function menuParams(target: Target, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...extra, ...(target.projectUuid ? { __projectUuid: target.projectUuid } : {}), __docUuid: target.uuid, __tabId: target.tabId }
}

async function command(target: Target, cmd: string, params: Record<string, unknown>, timeoutMs = 300000): Promise<CommandReply> {
	const url = getProxyUrl('/command')
	if (!url)
		throw new Error('本窗口没有连接到兼容的本地代理；请先等待桥接连接后重试', {
			cause: { partial: false, outcome: 'not-started', requestSent: false },
		})
	const instanceId = getBridgeInstanceId()
	if (typeof instanceId !== 'string' || !instanceId.trim())
		throw new Error('本窗口 instanceId 无效，已停止请求', {
			cause: { partial: false, outcome: 'not-started', requestSent: false },
		})
	let requestSent = false
	const request = async (): Promise<CommandReply> => {
		const body = JSON.stringify({ instanceId, cmd, params: menuParams(target, params) })
		requestSent = true
		const response = await eda.sys_ClientUrl.request(url, 'POST', body, { headers: { 'Content-Type': 'application/json' } })
		const text = await response.text()
		if (!response.ok)
			throw new Error(`${cmd} HTTP ${response.status}；未确认指令结果，不能盲目重发`)
		const result = JSON.parse(text) as CommandReply
		if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
			throw new Error(`${cmd} 返回格式无法确认；不要重复提交`)
		const cause = result?.error?.cause
		if (isWrite && !result.ok && (cause?.partial === true || cause?.outcome === 'start-request-unknown')) {
			uncertainBoards.set(keyOf(target), cmd)
			if (cmd === 'pcb.autoRouteStart' && typeof params.__routeOperationId === 'string')
				uncertainStartOperationByBoard.set(keyOf(target), params.__routeOperationId)
		}
		return result
	}
	const isWrite = cmd === 'pcb.nativeAutoRouteStart' || cmd === 'pcb.nativeAutoRouteStop'
		|| cmd === 'pcb.autoRouteStart' || cmd === 'pcb.autoRouteStop' || cmd === 'pcb.importAutoRouteSes'
		|| cmd === 'pcb.kiRoutingStart' || cmd === 'pcb.kiRoutingInstall' || cmd === 'pcb.kiRoutingStop' || cmd === 'pcb.importKiRoutingResult'
		|| (cmd === 'pcb.groupBySchematicRegions' && params.dryRun === false)
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([request(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`等待 ${cmd} 返回超过 ${timeoutMs}ms；该请求可能仍在执行，不能重发`)), timeoutMs) })])
	}
	catch (error) {
		const cause = (error as any)?.cause
		const provenNotSent = requestSent === false && cause?.requestSent === false
		if (isWrite && !provenNotSent) {
			uncertainBoards.set(keyOf(target), cmd)
			if (cmd === 'pcb.autoRouteStart' && typeof params.__routeOperationId === 'string')
				uncertainStartOperationByBoard.set(keyOf(target), params.__routeOperationId)
		}
		throw error
	}
	finally {
		if (timer !== undefined)
			clearTimeout(timer)
	}
}

function requireSuccess(reply: CommandReply): any {
	if (!reply.ok)
		throw Object.assign(new Error(reply.error?.message ?? `${reply.cmd ?? '指令'}失败`), { cause: reply.error?.cause })
	return reply.data
}

function showError(title: string, error: unknown): void {
	const e = error as any
	const jobId = typeof e?.cause?.jobId === 'string' ? e.cause.jobId : undefined
	if (jobId)
		message(`启动结果未知，但已恢复任务 ID：${jobId}\n可用“查询自动布线状态…”或“停止自动布线…”继续处理；不要再次启动。\n${String(e?.message ?? error)}`, title)
	else
		message(String(e?.message ?? error), title)
}

function planFor(target: Target, preview: any): Record<string, unknown> {
	return {
		boardUuid: target.uuid,
		tabId: target.tabId,
		board: preview.board,
		origin: preview.origin,
		groups: preview.groups,
		ungrouped: preview.ungrouped,
		locked: preview.locked ?? [],
		overlapCheck: preview.overlapCheck,
	}
}

async function groupComponents(): Promise<void> {
	const target = await currentTarget()
	const preview = requireSuccess(await command(target, 'pcb.groupBySchematicRegions', { dryRun: true }, 300000))
	const plan = planFor(target, preview)
	const groups = (preview.groups ?? []).map((group: any) => `${group.name}（${group.count}）：\n  ${(group.designators ?? []).join('、')}\n  位置：${(group.placements ?? []).map((p: any) => `${p.designator}@(${p.x},${p.y})`).join('；')}`).join('\n')
	const previewText = `目标 PCB：${target.name}（${target.uuid}）\n${groups}\n\n锁定不移动：${(preview.locked ?? []).join('、') || '无'}\n未分组：${(preview.ungrouped ?? []).join('、') || '无'}\n布局重叠对数：${preview.overlapCheck?.count ?? '未知'}\n测量回退数：${preview.overlapCheck?.fallbackCount ?? '未知'}${preview.warning ? `\n警告：${preview.warning}` : ''}`
	const accepted = await confirm(`${previewText}\n\n确认后会按功能区重新布局器件：会移动器件、生成组框与名称、创建备份并保存。既有走线不会随器件移动。建议在布线前使用。`, '确认 PCB 分组布局', '确认并分组')
	if (!accepted)
		return
	const freshTarget = await currentTarget()
	if (freshTarget.uuid !== target.uuid || freshTarget.tabId !== target.tabId)
		throw new Error('当前 PCB 标签页已变化，预览作废；未执行分组')
	// A completed fresh preview is the explicit source check required before a new attempt after an unknown write.
	if (uncertainBoards.get(keyOf(target)) === 'pcb.groupBySchematicRegions')
		uncertainBoards.delete(keyOf(target))
	const result = requireSuccess(await command(target, 'pcb.groupBySchematicRegions', { dryRun: false, expectedMenuPlan: JSON.stringify(plan) }, 300000))
	message(`分组布局完成：移动 ${result.moved} 个器件，生成组框 ${result.generated?.borders ?? '?'} 个、组名 ${result.generated?.labels ?? '?'} 个。\n回读校验：${result.verify?.ok ? `通过（${result.verify.checked}）` : '未通过'}；保存：${result.saved ? '已保存' : '未确认'}。\n请注意：既有走线没有随器件移动。${result.warning ? `\n${result.warning}` : ''}`, 'PCB 功能区分组结果')
}

function formatRegionGroups(groups: any[]): string {
	return groups.map(group => {
		const members = Array.isArray(group.members) ? group.members : group.designators ?? []
		const designators = members.map((member: any) => typeof member === 'string' ? member : member?.designator ?? member?.name ?? '?')
		return `${group.name}（${group.pageName ?? '未命名页'}，${members.length} 个器件）：${designators.join('、') || '无器件'}`
	}).join('\n') || '未发现功能区'
}

async function markSchematicRegions(): Promise<void> {
	const target = await currentTarget()
	const preview = requireSuccess(await command(target, 'pcb.markSchematicRegions', { dryRun: true }))
	if (typeof preview.signature !== 'string' || !preview.signature)
		throw new Error('功能区预览没有有效签名；未执行标记')
	const groups = Array.isArray(preview.regions) ? preview.regions : []
	const unmatchedCount = groups.reduce((sum: number, group: any) => sum + (group.unmatched?.length ?? 0), 0)
	const ambiguousCount = groups.reduce((sum: number, group: any) => sum + (group.ambiguous?.length ?? 0), 0)
	const accepted = await confirm(
		`目标 PCB：${target.name}（${target.uuid}）\n功能区：${groups.length}\n${formatRegionGroups(groups)}\n未匹配：${unmatchedCount}；歧义：${ambiguousCount}\n\n确认后仅添加功能区标记/标签，不移动元件。`,
		'标记 PCB 功能区', '确认并标记')
	if (!accepted)
		return
	const freshTarget = await currentTarget()
	if (freshTarget.uuid !== target.uuid || freshTarget.tabId !== target.tabId)
		throw new Error('确认期间 PCB 标签页已变化；拒绝标记功能区')
	const result = requireSuccess(await command(target, 'pcb.markSchematicRegions', { dryRun: false, expectedSignature: preview.signature }, 300000))
	message(`功能区：${result.regions?.length ?? groups.length}\n写入标记记录：${result.written ?? 0}\n读回校验：${result.verified ? '通过' : '未通过'}；移动器件：0（此命令不移动器件）\n保存：${result.saved ? '已保存' : result.written === 0 ? '无需保存' : '未确认'}`, 'PCB 功能区标记结果')
}

async function locateSchematicRegion(): Promise<void> {
	const target = await currentTarget()
	const result = requireSuccess(await command(target, 'pcb.getSchematicRegions', {}))
	const groups = Array.isArray(result.regions) ? result.regions : []
	if (!groups.length) {
		message('当前 PCB 没有可定位的原理图功能区。', '定位 PCB 功能区')
		return
	}
	const options = groups.map((group: any) => ({
		value: String(group.regionId),
		displayContent: `${group.name}（${group.pageName ?? '未命名页'}，${group.members?.length ?? 0} 个器件）`,
	}))
	const regionId = await select(options, '选择要定位的功能区', options[0].value)
	if (!regionId)
		return
	const freshTarget = await currentTarget()
	if (freshTarget.uuid !== target.uuid || freshTarget.tabId !== target.tabId)
		throw new Error('选择期间 PCB 标签页已变化；拒绝定位功能区')
	const located = requireSuccess(await command(target, 'pcb.locateSchematicRegion', { regionId }))
	message(`功能区：${groups.find((group: any) => String(group.regionId) === regionId)?.name ?? regionId}\n成员：${located.designators?.join('、') ?? '未返回'}\n高亮选择：${located.selectedIds?.length ?? 0} 个；缩放定位：${located.zoomed ? '已完成' : '未确认'}`, '功能区定位结果')
}

const freeRoutingSetupGuide = 'https://github.com/easyeda/eext-freerouting-intergration#使用方法'
const freeRoutingAiRequest = '请按 AI Command Engine 的 PCB 指南为本机配置 FreeRouting。先检查本地 API。已安装就后台启动，缺少时从官方发布页安装。确认 127.0.0.1:37864 的 API 可用后停止，等我回到 EDA 手动启动布线。'

async function freeRoutingAvailable(): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const status = await Promise.race([
			frRequest<{ status?: unknown }>('GET', '/system/status'),
			new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2500) }),
		])
		return typeof status?.status === 'string' && /^(ok|healthy)$/i.test(status.status)
	}
	catch {
		return false
	}
	finally {
		if (timer !== undefined)
			clearTimeout(timer)
	}
}

function showFreeRoutingSetup(): void {
	eda.sys_Dialog.showConfirmationMessage(
		'未检测到可用的本机 FreeRouting API。可能尚未安装，或已安装但服务未启动。配置完成后，再点击“启动自动布线”。',
		'配置 FreeRouting 自动布线', 'AI 协助安装', '手动安装',
		useAi => {
			if (useAi) {
				eda.sys_Dialog.showInputDialog(
					'复制下方请求并发送给能在本机运行命令、已加载 AI Command Engine 配套技能的 AI。',
					'配置成功后，回到 EDA 再次点击“启动自动布线”。',
					'交给本机 AI 配置 FreeRouting', 'text', freeRoutingAiRequest, { readonly: true },
				)
				return
			}
			eda.sys_Dialog.showConfirmationMessage(
				'从 FreeRouting 官方发布页安装对应系统的版本，再按嘉立创官方说明运行对应系统的启动脚本。服务可用后回到 EDA 重试。',
				'手动配置 FreeRouting', '打开官方安装说明', '关闭',
				openGuide => { if (openGuide) eda.sys_Window.open(freeRoutingSetupGuide) },
			)
		},
	)
}

async function routeStart(): Promise<void> {
	const target = await currentTarget()
	const engine = await select([
		{ value: 'native', displayContent: '嘉立创 EDA 原生布线（默认）' },
		{ value: 'freerouting', displayContent: 'FreeRouting（可选）' },
		{ value: 'kirouting', displayContent: 'KiRouting（可选）' },
	], '选择布线引擎', 'native')
	if (!engine)
		return
	const previous = routeSessions.get(keyOf(target))
	if (engine === 'native' || previous?.engine === 'native') {
		if (previous?.unknownStart || (previous?.jobId && !routeEnded(previous.state)))
			throw new Error('当前 PCB 还有未结束或状态未确认的布线任务，请先查询状态')
	}
	if (engine === 'native')
		return routeStartNative(target)
	if (engine === 'kirouting')
		return routeStartKiRouting(target)
	if (engine === 'freerouting')
		return routeStartFreeRouting(target)
}

function nativeBindingFor(target: Target, value: any): NativeBinding | undefined {
	if (typeof value?.jobId === 'string' && value.jobId.trim() && value.projectUuid === target.projectUuid && value.pcbUuid === target.uuid && target.projectUuid)
		return { jobId: value.jobId, projectUuid: target.projectUuid, pcbUuid: target.uuid }
}

async function routeStartNative(target: Target): Promise<void> {
	if (!target.projectUuid)
		throw new Error('请先打开所属工程中的 PCB，再启动原生布线')
	const key = keyOf(target)
	if (uncertainBoards.has(key))
		throw new Error('当前 PCB 上一次操作结果未确认，请先核对板面和任务状态')
	const rawNets: unknown = requireSuccess(await command(target, 'pcb.listNets', {}, 30000))
	if (!Array.isArray(rawNets))
		throw new Error('未能读取 PCB 网络列表')
	const nets = [...new Set<string>(rawNets.filter((net): net is string => typeof net === 'string' && Boolean(net.trim())))]
	if (!nets.length)
		throw new Error('当前 PCB 没有可选的具名网络')
	const choices = nets.map(net => ({ value: net, displayContent: net }))
	const selected = await new Promise<string[]>(resolve => {
		eda.sys_Dialog.showSelectDialog(choices, '只布所选网络，保留已有线路和过孔。', '', '选择原生布线网络', [], true, values => resolve(values ?? []))
	})
	if (!selected.length)
		return
	if (selected.some(net => !nets.includes(net)))
		throw new Error('所选网络不在当前 PCB 网络列表中')
	const fresh = await currentTarget()
	if (fresh.uuid !== target.uuid || fresh.tabId !== target.tabId || fresh.projectUuid !== target.projectUuid)
		throw new Error('选择期间工程或 PCB 已变化，未启动布线')
	const previous = routeSessions.get(key)
	const session: RouteSession = { engine: 'native', target, state: 'unknown', unknownStart: true }
	routeSessions.set(key, session)
	try {
		const reply = await command(target, 'pcb.nativeAutoRouteStart', { RoutingNets: [...new Set(selected)], existingPrimitiveMode: 'keep' })
		if (!reply.ok && !reply.error?.cause?.partial && !uncertainBoards.has(key)) {
			if (previous) routeSessions.set(key, previous)
			else routeSessions.delete(key)
		}
		const data = requireSuccess(reply)
		const binding = nativeBindingFor(target, data?.binding)
		if (!binding)
			throw new Error('原生布线未返回可确认的任务编号，请先检查任务状态')
		Object.assign(session, { jobId: binding.jobId, nativeBinding: binding, state: data.state, unknownStart: false })
		message('任务 ' + binding.jobId + ' 已提交。请用“查询自动布线状态…”查看。完成后检查板面、连通性和 DRC。', '原生自动布线')
	}
	catch (error) {
		const cause = (error as any)?.cause
		if (cause?.requestSent === false) {
			if (previous) routeSessions.set(key, previous)
			else routeSessions.delete(key)
		}
		const binding = nativeBindingFor(target, cause?.jobBinding)
		if (binding)
			Object.assign(session, { jobId: binding.jobId, nativeBinding: binding, unknownStart: false })
		throw error
	}
}

async function routeNativeTask(target: Target, session: RouteSession, action: 'Status' | 'Stop' | 'Log'): Promise<void> {
	const binding = session.nativeBinding
	if (!binding)
		throw new Error('当前菜单没有收到原生任务编号。请在 EDA 原生布线界面核对当前任务和板面。')
	const key = keyOf(target)
	if (action === 'Stop') {
		if (uncertainBoards.get(key) === 'pcb.nativeAutoRouteStop')
			throw new Error('上次停止结果未确认，请先查询任务状态')
		if (!await confirm('停止当前 PCB 的原生布线任务 ' + binding.jobId + '？', '停止原生布线', '停止任务'))
			return
	}
	const data = requireSuccess(await command(target, 'pcb.nativeAutoRoute' + action, binding, 30000))
	if (!nativeBindingFor(target, data) || data.jobId !== binding.jobId)
		throw new Error('原生布线返回的任务身份不一致，请核对当前任务')
	if (action === 'Log') {
		const recent = Array.isArray(data.logs) ? data.logs.slice(-5).map((line: unknown) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') : ''
		message('任务 ' + binding.jobId + '，日志 ' + (data.count ?? 0) + ' 条。\n' + recent.slice(0, 2000), '原生布线日志')
		return
	}
	session.state = data.state
	if (data.state && data.state !== 'unknown' && (action === 'Status' || routeEnded(data.state))) {
		const uncertain = uncertainBoards.get(key)
		if (uncertain === 'pcb.nativeAutoRouteStart' || uncertain === 'pcb.nativeAutoRouteStop')
			uncertainBoards.delete(key)
	}
	const progress = typeof data.progress === 'number' ? '，进度 ' + data.progress + '%' : ''
	const note = data.note ? '\n' + data.note : ''
	message('任务 ' + binding.jobId + '，状态 ' + (data.state ?? '未知') + progress + note, action === 'Stop' ? '原生布线停止结果' : '原生布线状态')
}

async function routeStartFreeRouting(target: Target): Promise<void> {
	const previous = routeSessions.get(keyOf(target))
	if (previous?.unknownStart || uncertainBoards.get(keyOf(target)) === 'pcb.autoRouteStart')
		throw new Error('上一启动结果未知；先查询状态恢复 jobId，不要重新启动')
	if (previous?.jobId && !routeEnded(previous.state))
		throw new Error(`本 PCB 仍关联任务 ${previous.jobId}（${previous.state}）；请先查询或停止，避免重复布线`)
	if (!await freeRoutingAvailable()) {
		showFreeRoutingSetup()
		return
	}
	const text = await input(`目标 PCB：${target.name}\n最大迭代数 maxPasses（默认 50）`, '启动自动布线', '50', { min: 1, step: 1 })
	if (text === undefined)
		return
	const maxPasses = Number(text)
	if (!Number.isInteger(maxPasses) || maxPasses < 1)
		throw new Error('maxPasses 必须为正整数')
	// Persist an operation marker before the request: the proxy/HTTP reply can be
	// lost after FreeRouting accepted the start, so no jobId may reach this menu.
	const operationId = newRouteOperationId()
	routeSessions.set(keyOf(target), { engine: 'freerouting', target, unknownStart: true, operationId })
	let response: CommandReply
	try {
		response = await command(target, 'pcb.autoRouteStart', { maxPasses, __routeOperationId: operationId }, 300000)
	}
	catch (error) {
		const cause = (error as any)?.cause
		if (cause?.requestSent === false && (cause?.outcome === 'not-started' || cause?.outcome === 'not_started')) {
			const current = routeSessions.get(keyOf(target))
			if (current?.operationId === operationId) {
				if (previous)
					routeSessions.set(keyOf(target), previous)
				else
					routeSessions.delete(keyOf(target))
			}
		}
		throw error
	}
	if (!response.ok) {
		const jobId = typeof response.error?.cause?.jobId === 'string' ? response.error.cause.jobId : undefined
		const startUnknown = response.error?.cause?.partial === true || response.error?.cause?.outcome === 'start-request-unknown'
		if (jobId)
			routeSessions.set(keyOf(target), { engine: 'freerouting', target, jobId, operationId })
		else if (startUnknown)
			routeSessions.set(keyOf(target), { engine: 'freerouting', target, unknownStart: true, operationId })
		else {
			if (previous)
				routeSessions.set(keyOf(target), previous)
			else
				routeSessions.delete(keyOf(target))
		}
		throw Object.assign(new Error(response.error?.message ?? '自动布线启动失败'), { cause: response.error?.cause })
	}
	const data = response.data
	if (typeof data?.jobId !== 'string' || !data.jobId.trim()) {
		routeSessions.set(keyOf(target), { engine: 'freerouting', target, unknownStart: true, operationId })
		uncertainBoards.set(keyOf(target), 'pcb.autoRouteStart')
		uncertainStartOperationByBoard.set(keyOf(target), operationId)
		throw new Error('启动响应缺少有效 jobId；结果未知，请查询状态恢复，不要再次启动')
	}
	routeSessions.set(keyOf(target), { engine: 'freerouting', target, jobId: String(data.jobId), operationId, state: 'SUBMITTED' })
	const warnings = [...(data.dsnConversion?.warnings ?? []), ...(data.dsnConversion?.limitations ?? [])]
	message(`启动请求已提交，尚未确认 FreeRouting 已开始。\nPCB：${target.name}（${target.uuid}）\n任务 ID：${data.jobId}\n最大迭代数：${maxPasses}\n规则完整性：${data.routingConstraintsComplete ? '完整' : '不完整'}\n线宽比对：${data.widthRuleComparison?.status ?? '未报告'}，未知项 ${data.widthRuleComparison?.unknowns?.length ?? '未报告'}\nDSN提示：${warnings.slice(0, 6).join('\n') || '无'}\n请用“查询自动布线状态…”查看任务；完成后先取回 SES，再显式导入。不会自动导入。`, '自动布线已提交')
}

function assertKiTarget(data: any, target: Target): void {
	const bound = data?.target ?? data?.scope
	if (!bound) throw new Error('KiRouting 响应缺少目标绑定；拒绝缓存任务结果')
	if (bound.documentUuid !== target.uuid || bound.tabId !== target.tabId || bound.projectUuid !== target.projectUuid)
		throw new Error('KiRouting 响应的工程/PCB/页签与当前目标不一致；拒绝使用结果')
}

function displayMode(mode: string): string {
	const names: Record<string,string> = { single: '单端布线', differential: '差分布线', 'length-match': '等长布线', fanout: '密脚扇出' }
	return names[mode] ?? mode
}

function choiceRows(value: unknown): Array<{value:string;displayContent:string}> {
	if (!Array.isArray(value)) return []
	return value.flatMap((item:any) => {
		if (typeof item === 'string' || typeof item === 'number') return [{value:String(item),displayContent:String(item)}]
		if (!item || typeof item !== 'object') return []
		const choice = item.value ?? item.id ?? item.name ?? item.designator ?? item.net
		if (choice === undefined || choice === null) return []
		return [{value:String(choice),displayContent:String(item.displayContent ?? item.label ?? item.name ?? item.designator ?? item.net ?? choice)}]
	})
}

function textInput(content: string, title: string, value = ''): Promise<string | undefined> {
	return new Promise(resolve => eda.sys_Dialog.showInputDialog(content, '', title, 'text', value, {}, (answer: unknown) => resolve(answer == null ? undefined : String(answer))))
}

async function collectKiSettings(target: Target, mode: string, info: any): Promise<Record<string, unknown> | undefined> {
	const schema = info?.modeInputSchema?.[mode] ?? info?.settingsFields?.[mode]
	if (!schema || !Array.isArray(schema.fields))
		throw new Error(`KiRouting 报告支持 ${mode}，但没有提供可核对的输入字段 schema；本次不猜测网络/差分对/等长组/器件范围`)
	let choices: any = {}
	if (schema.fields.some((field:any) => field.source))
		choices = requireSuccess(await command(target, 'pcb.exportKiRouting', { mode }, 300000))?.choices ?? {}
	const settings: Record<string, unknown> = { mode }
	for (const field of schema.fields) {
		const key = String(field.key ?? '')
		if (!key) throw new Error(`KiRouting ${mode} 输入 schema 存在缺少 key 的字段`)
		const required = field.required === true
		const rows = choiceRows(field.options ?? (field.source ? choices[field.source] : undefined))
		const type = String(field.type ?? 'string')
		let answer: string | undefined
		if (type === 'boolean') {
			const value = await select([{value:'true',displayContent:'是'}, {value:'false',displayContent:'否'}], String(field.label ?? key), field.default === false ? 'false' : 'true')
			if (value === undefined) { if (required) return undefined; continue }
			settings[key] = value === 'true'; continue
		}
		if (type === 'number') {
			answer = await input(`${String(field.description ?? field.label ?? key)}${required ? '（必填）' : '（可选）'}`, String(field.label ?? key), field.default == null ? '' : String(field.default), { placeholder: field.placeholder })
			if (answer === undefined || answer.trim() === '') { if (required) return undefined; continue }
			const value = Number(answer)
			if (!Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`)
			settings[key] = value; continue
		}
		if (type === 'string' && rows.length) {
			const value = await select(rows, String(field.label ?? key), String(field.default ?? rows[0].value))
			if (value === undefined) { if (required) return undefined; continue }
			settings[key] = value; continue
		}
		const allowed = rows.map(row => row.value)
		const prompt = `${String(field.description ?? field.label ?? key)}${required ? '（必填）' : '（可选）'}${rows.length ? `\n可选值：${rows.map(row => row.displayContent).join('、')}\n请用逗号分隔选择值。` : ''}`
		answer = await textInput(prompt, String(field.label ?? key), String(field.default ?? ''))
		if (answer === undefined || answer.trim() === '') { if (required) return undefined; continue }
		if (type === 'string[]' || type === 'array') {
			let values: string[]
			try { const parsed = JSON.parse(answer); values = Array.isArray(parsed) ? parsed.map(String) : answer.split(',').map(x=>x.trim()).filter(Boolean) }
			catch { values = answer.split(',').map(x=>x.trim()).filter(Boolean) }
			if (!values.length && required) throw new Error(`${key} 至少选择一项`)
			if (allowed.length && values.some(value=>!allowed.includes(value))) throw new Error(`${key} 只能从显示的当前 PCB 选项中选择`)
			settings[key] = values; continue
		}
		if (type !== 'string') throw new Error(`KiRouting 输入字段 ${key} 使用未支持类型 ${type}；未提交任务`)
		if (allowed.length && !allowed.includes(answer)) throw new Error(`${key} 只能从显示的当前 PCB 选项中选择`)
		settings[key] = answer
	}
	// KiRouting v0.18 integration contract requires existing input copper to stay as read-only routing input.
	settings.keep_input_copper = true
	return settings
}

function showKiRoutingSetup(target: Target, info: any): void {
	const python = info?.python
	const pythonText = python?.available === false ? `未检测到可用 Python；${python?.message ?? '请按代理提供的说明准备兼容环境。'}` : ''
	const instructions = info?.manualInstructions ?? info?.install?.manualInstructions ?? info?.install?.instructions ?? info?.install?.message ?? info?.message ?? info?.note
	const details = typeof instructions === 'string' ? instructions : instructions ? JSON.stringify(instructions) : 'KiRouting 配套本地运行环境未就绪。'
	eda.sys_Dialog.showConfirmationMessage(
		`${details}\n${pythonText}\n\nAI 自动安装会提交本机配套运行环境安装任务，并显示安装状态；不会自动开始布线或修改 PCB。手动安装仅提供本地代理返回的环境说明。`,
		'配置 KiRouting 运行环境', 'AI 自动安装', '手动安装',
		(useAi:boolean) => {
			if (useAi) {
				void command(target, 'pcb.kiRoutingInstall', { confirmed: true }, 300000).then(reply => {
					const data = requireSuccess(reply), install = data.installJob ?? data
					if (typeof install.jobId !== 'string' || !install.jobId.trim()) throw new Error('安装请求已返回，但缺少可跟踪 jobId；不能宣称已安装')
					routeSessions.set(keyOf(target), { engine: 'kirouting', target, jobId: install.jobId, jobKind: 'install', state: install.state ?? 'submitted' })
					message(`KiRouting 安装任务已提交。\n安装任务：${install.jobId}\n状态：${install.state ?? '未知'}\n这只表示安装任务已提交。请用“查询自动布线状态…”查看是否完成；确认 pcb.kiRoutingInfo 返回 runtimeReady:true 后再启动。`, 'KiRouting 安装任务')
				}).catch(error => showError('KiRouting 安装失败', error))
				return
			}
			message(`${details}\n${pythonText}\n\n请按本机代理返回的手动安装说明配置 KiRouting 运行环境；安装后重新选择 KiRouting 并检查 runtimeReady。不会启动黑窗、下载软件或修改 PCB。`, 'KiRouting 手动安装说明')
		},
	)
}

async function routeStartKiRouting(target: Target): Promise<void> {
	const previous = routeSessions.get(keyOf(target))
	if (previous?.unknownStart || uncertainBoards.get(keyOf(target)) === 'pcb.kiRoutingStart')
		throw new Error('上一 KiRouting 启动结果未知；请按原 operationId 查询状态，不要再次启动')
	if (previous?.jobKind !== 'install' && previous?.jobId && !routeEnded(previous.state))
		throw new Error(`当前 PCB 的 ${previous.engine} 任务仍运行（${previous.jobId}/${previous.state}）；请先查询或停止`)
	const info = requireSuccess(await command(target, 'pcb.kiRoutingInfo', {}, 30000))
	if (info.setupRequired || info.runtimeReady !== true) { showKiRoutingSetup(target, info); return }
	const supported: string[] = Array.isArray(info.supportedModes) ? [...new Set<string>((info.supportedModes as unknown[]).filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map(x => x.trim()))] : []
	if (!supported.length) throw new Error('KiRouting runtime 已就绪，但没有返回 supportedModes；没有提交任务')
	const mode = await select(supported.map((value:string)=>({value,displayContent:displayMode(value)})), '选择 KiRouting 模式', supported[0])
	if (!mode) return
	const settings = await collectKiSettings(target, mode, info)
	if (!settings) return
	const operationId = newRouteOperationId()
	// Save the operation marker before sending: a lost reply must be recovered with this same ID.
	routeSessions.set(keyOf(target), { engine: 'kirouting', target, operationId, unknownStart: true })
	try {
		const response = await command(target, 'pcb.kiRoutingStart', { operationId, settings }, 300000)
		const data = requireSuccess(response)
		if (data.engine !== 'kirouting' || data.operationId !== operationId) throw new Error('KiRouting 启动响应的engine/operationId不匹配；启动结果未知，不要重发')
		assertKiTarget(data, target)
		if (data.setupRequired) { showKiRoutingSetup(target, info); routeSessions.set(keyOf(target), { engine:'kirouting',target,operationId,unknownStart:false,state:'setup-required' }); return }
		const session:RouteSession={engine:'kirouting',target,operationId,jobId:typeof data.jobId==='string'?data.jobId:undefined,state:String(data.state??'submitted'),unknownStart:false}
		routeSessions.set(keyOf(target),session)
		message(`KiRouting 任务已提交，尚未确认完成或导入。\n模式：${displayMode(mode)}\n工程：${target.projectUuid}\nPCB：${target.name}（${target.uuid}）\n任务：${session.jobId ?? '等待按 operationId 恢复'}\n操作 ID：${operationId}\n输入覆盖：${JSON.stringify(data.inputCoverage ?? {})}\n现有铜保留：${settings.keep_input_copper === true ? '是' : '未知'}\n请先查询状态，完成后取回 KiRouting JSON，再进行显式预检和导入。`, 'KiRouting 任务已提交')
	}
	catch (error) {
		const cause=(error as any)?.cause
		if(cause?.requestSent===false){if(previous)routeSessions.set(keyOf(target),previous);else routeSessions.delete(keyOf(target))}
		else {uncertainBoards.set(keyOf(target),'pcb.kiRoutingStart');uncertainStartOperationByBoard.set(keyOf(target),operationId)}
		throw error
	}
}

function getSession(target: Target, engine?: RouteEngine): RouteSession {
	const session = routeSessions.get(keyOf(target))
	if (!session)
		throw new Error(`当前 PCB 标签页没有本菜单启动的任务记录。目标：${target.name}（${target.uuid}，tabId=${target.tabId}）；不要猜测或重用其他 PCB 的 jobId`)
	if (session.target.uuid!==target.uuid||session.target.tabId!==target.tabId||session.target.projectUuid!==target.projectUuid)
		throw new Error('当前路由任务的PCB/工程/页签身份与焦点不一致；拒绝操作')
	if(engine&&session.engine!==engine) throw new Error(`当前任务绑定到 ${session.engine}，拒绝切换到 ${engine}`)
	return session
}

async function getOrRecoverSession(target:Target):Promise<RouteSession>{
	const current=routeSessions.get(keyOf(target))
	if(current){
		if(current.target.uuid!==target.uuid||current.target.tabId!==target.tabId||current.target.projectUuid!==target.projectUuid)throw new Error('当前路由任务的PCB/工程/页签身份与焦点不一致；拒绝操作')
		return current
	}
	const engine=await select([{value:'freerouting',displayContent:'FreeRouting'},{value:'kirouting',displayContent:'KiRouting'}],'选择要查询的布线引擎','freerouting')
	if(!engine)throw new Error('未选择布线引擎；没有发送任务请求')
	if(engine==='freerouting')throw new Error(`当前菜单没有绑定本 PCB 的 FreeRouting 任务；不会按最近任务猜测。目标：${target.name}（${target.uuid}/${target.tabId}）`)
	const listed=requireSuccess(await command(target,'pcb.kiRoutingList',{},30000))
	const jobs=Array.isArray(listed.jobs)?listed.jobs:[]
	const exact=jobs.filter((job:any)=>job?.target?.documentUuid===target.uuid&&job?.target?.tabId===target.tabId&&job?.target?.projectUuid===target.projectUuid)
	if(!exact.length)throw new Error('当前工程/PCB/页签没有可恢复的 KiRouting 任务；未查询或复用其他目标的任务')
	const options=exact.map((job:any)=>({value:String(job.operationId??job.jobId??''),displayContent:`${job.jobId??'(待分配任务ID)'} / ${job.state??'未知'} / op=${job.operationId??'未知'}`})).filter((x:any)=>x.value)
	const selected=await select(options,'选择当前目标的 KiRouting 任务',options[0]?.value??'')
	if(!selected)throw new Error('未选择KiRouting任务；没有发起后续请求')
	const job=exact.find((item:any)=>String(item.operationId??item.jobId)===selected)!
	const restored:RouteSession={engine:'kirouting',target,operationId:typeof job.operationId==='string'?job.operationId:undefined,jobId:typeof job.jobId==='string'?job.jobId:undefined,state:String(job.state??'unknown'),unknownStart:!job.jobId}
	if(!restored.operationId&&!restored.jobId)throw new Error('所选 KiRouting 任务没有 operationId 或 jobId；拒绝恢复')
	routeSessions.set(keyOf(target),restored)
	return restored
}

async function routeKiRoutingStatus(target:Target,session:RouteSession):Promise<void>{
	if(session.jobKind==='install'){
		const data=requireSuccess(await command(target,'pcb.kiRoutingStatus',{jobId:session.jobId,kind:'install'},30000))
		if(data.jobId!==session.jobId||data.type!=='install')throw new Error('KiRouting 安装状态 jobId/type 不匹配；不能宣称安装完成')
		session.state=String(data.state??'unknown')
		if(['completed','COMPLETED','done','succeeded'].includes(session.state)){
			const info=requireSuccess(await command(target,'pcb.kiRoutingInfo',{},30000))
			if(info.runtimeReady!==true)throw new Error(`安装任务完成，但 KiRouting info.runtimeReady 未确认（${info.note??'未知原因'}）`)
			routeSessions.delete(keyOf(target))
			message(`KiRouting 安装任务已完成，且 info.runtimeReady=true。\n任务：${data.jobId}\n现在可以重新启动自动布线。`, 'KiRouting 运行环境已就绪')
			return
		}
		message(`KiRouting 安装任务：${data.jobId}\n状态：${data.state??'未知'}${data.progress?`\n进度：${JSON.stringify(data.progress)}`:''}\n只有查询到 info.runtimeReady=true 才表示运行环境已就绪。`, 'KiRouting 安装状态')
		return
	}
	const params={...(session.operationId?{operationId:session.operationId}:{}),...(session.jobId?{jobId:session.jobId}:{})}
	if(!Object.keys(params).length)throw new Error('KiRouting session缺少operationId/jobId；没有发送状态查询')
	const data=requireSuccess(await command(target,'pcb.kiRoutingStatus',params,30000))
	if(data.engine!=='kirouting'||(session.operationId&&data.operationId!==session.operationId))throw new Error('KiRouting 状态响应任务身份不匹配')
	assertKiTarget(data,target)
	if(typeof data.jobId==='string')session.jobId=data.jobId
	session.state=String(data.state??'unknown');session.unknownStart=false
	uncertainBoards.delete(keyOf(target));uncertainStartOperationByBoard.delete(keyOf(target))
	message(`PCB：${target.name}\n引擎：KiRouting\n任务：${session.jobId??'未返回'}\n计算状态：${session.state}${data.routingOutcome === 'partial' ? '\n目标进度：部分完成，请取回结果查看未完成网络。' : data.routingOutcome === 'constraints-not-met' ? '\n目标进度：尚未满足约束，请取回结果查看具体指标。' : ''}\n状态查询不取回结果，也不修改 PCB。${/^(completed|done)$/i.test(session.state)?'\n下一步可取回布线结果，完成状态不代表整板验收通过。':''}`, 'KiRouting 状态')
}

async function routeStatus(): Promise<void> {
	const target = await currentTarget()
	const session = await getOrRecoverSession(target)
	if (session.engine === 'native') return routeNativeTask(target, session, 'Status')
	if(session.engine==='kirouting')return routeKiRoutingStatus(target,session)
	if (!session.jobId && !session.operationId)
		throw new Error('当前菜单运行时没有本次启动操作标记，不能安全恢复任务；请回到原操作窗口，避免误查同页旧任务')
	const recoveryParams = session.operationId ? { __routeOperationId: session.operationId } : {}
	const data = requireSuccess(await command(target, 'pcb.autoRouteStatus', { ...recoveryParams, ...(session.jobId ? { jobId: session.jobId } : {}) }))
	if (typeof data.jobId === 'string' && data.jobId) {
		routeSessions.set(keyOf(target), { ...session, jobId: data.jobId, state: data.state, unknownStart: false })
		const key = keyOf(target)
		if (uncertainBoards.get(key) === 'pcb.autoRouteStart' && uncertainStartOperationByBoard.get(key) === session.operationId) {
			uncertainBoards.delete(keyOf(target))
			uncertainStartOperationByBoard.delete(key)
		}
		else if (uncertainBoards.get(key) === 'pcb.autoRouteStop')
			uncertainBoards.delete(key)
	}
	message(`PCB：${target.name}\n任务：${data.jobId}\n状态：${data.state}${data.stage ? ` / ${data.stage}` : ''}${data.currentPass != null ? `\n迭代：${data.currentPass}` : ''}\n状态查询不读取 SES，也不修改 PCB。${data.state === 'COMPLETED' ? '\n下一步可选择“取回已完成 SES…”。' : ''}`, '自动布线状态')
}

async function routeStop(): Promise<void> {
	const target = await currentTarget()
	let session = await getOrRecoverSession(target)
	if (session.engine === 'native') return routeNativeTask(target, session, 'Stop')
	if(session.engine==='kirouting'){
		if(session.jobKind==='install')throw new Error('安装任务不通过自动布线停止入口中断；请查询安装状态或使用代理提供的安装取消方式')
		if(!session.jobId&&!session.operationId)throw new Error('KiRouting 任务缺少可核对的operationId/jobId；未发送停止请求')
		const accepted=await confirm(`目标 PCB：${target.name}\n引擎：KiRouting\n任务：${session.jobId??'等待恢复'}\n操作：${session.operationId??'未知'}\n确认向本地代理发送停止请求？`,'停止 KiRouting 自动布线','停止任务')
		if(!accepted)return
		const freshTarget=await currentTarget()
		if(freshTarget.uuid!==target.uuid||freshTarget.tabId!==target.tabId||freshTarget.projectUuid!==target.projectUuid)throw new Error('确认期间工程/PCB/页签已变化；未发送停止请求')
		const data=requireSuccess(await command(target,'pcb.kiRoutingStop',{...(session.operationId?{operationId:session.operationId}:{}),...(session.jobId?{jobId:session.jobId}:{})},30000))
		if(data.engine!=='kirouting'||(session.operationId&&data.operationId!==session.operationId)||(session.jobId&&data.jobId!==session.jobId))throw new Error('KiRouting 停止响应任务身份不匹配')
		assertKiTarget(data,target)
		session.state=String(data.state??'unknown')
		message(`引擎：KiRouting\n任务：${data.jobId??session.jobId??'未返回'}\n操作：${data.operationId??session.operationId??'未返回'}\n状态：${session.state}\n停止请求不会修改 PCB。`,'KiRouting 停止结果')
		return
	}
	if (!session.jobId) {
		if (!session.operationId)
			throw new Error('当前菜单运行时没有本次启动操作标记，未发送状态查询或停止请求')
		const recovered = requireSuccess(await command(target, 'pcb.autoRouteStatus', { __routeOperationId: session.operationId }))
		if (typeof recovered.jobId !== 'string' || !recovered.jobId)
			throw new Error('状态恢复未返回有效 jobId；没有发送停止请求')
		session = { ...session, jobId: recovered.jobId, state: recovered.state, unknownStart: false }
		routeSessions.set(keyOf(target), session)
		const key = keyOf(target)
		if (uncertainBoards.get(key) === 'pcb.autoRouteStart' && uncertainStartOperationByBoard.get(key) === session.operationId) {
			uncertainBoards.delete(key)
			uncertainStartOperationByBoard.delete(key)
		}
	}
	const accepted = await confirm(`目标 PCB：${target.name}\n任务 ID：${session.jobId}\n确认向 FreeRouting 发送停止请求？`, '停止自动布线', '停止任务')
	if (!accepted)
		return
	const freshTarget = await currentTarget()
	if (freshTarget.uuid !== target.uuid || freshTarget.tabId !== target.tabId)
		throw new Error('确认期间 PCB 标签页已变化；未发送停止请求')
	const data = requireSuccess(await command(target, 'pcb.autoRouteStop', { jobId: session.jobId, ...(session.operationId ? { __routeOperationId: session.operationId } : {}) }))
	if (data.jobId !== session.jobId)
		throw new Error('FreeRouting 停止回执任务身份不匹配，请查询当前任务状态')
	session.state = typeof data.state === 'string' && data.state ? data.state : 'unknown'
	if (routeEnded(session.state) && uncertainBoards.get(keyOf(target)) === 'pcb.autoRouteStop')
		uncertainBoards.delete(keyOf(target))
	message(`任务：${data.jobId}\n停止请求结果：${data.cancelled ? '已取消' : data.outcome ?? '未取消'}\n状态：${data.state ?? '未知'}${data.note ? `\n${data.note}` : ''}`, '自动布线停止结果')
}

function kiRoutingSummary(result: any): string {
	const counts = result.counts ?? { lines: result.lines?.length, vias: result.vias?.length }
	const rows = [`新增走线：${counts.lines ?? '未知'}；过孔：${counts.vias ?? '未知'}`]
	if (result.existingCopperPreserved !== undefined)
		rows.push(`既有线路保留：${result.existingCopperPreserved === true ? '已核对' : '未确认'}`)
	if (result.widths?.status)
		rows.push(`线宽检查：${result.widths.status === 'compliant' ? '通过' : result.widths.status}`)
	if (result.modeMetrics?.newCopperSpacingVerification?.status === 'passed')
		rows.push('新增导线／过孔之间的间距：通过；焊盘、板边与整板 DRC 仍需检查。')
	if (Number(result.statistics?.engineFailed) > 0)
		rows.push(`引擎报告仍有 ${result.statistics.engineFailed} 项未完成，需要继续布线或检查。`)
	for (const group of result.modeMetrics?.groupSkew ?? []) {
		rows.push(`等长组 ${(group.nets ?? []).join('、')}：长度差 ${typeof group.skewMil === 'number' ? group.skewMil.toFixed(3) + ' mil' : '未能计算'}，容差 ${group.toleranceMil ?? '未知'} mil，${group.withinTolerance === true ? '达标' : group.withinTolerance === false ? '未达标' : '未确认'}`)
	}
	for (const group of result.modeMetrics?.fanout ?? []) {
		rows.push(`扇出 ${group.reference ?? group.componentId}：走线 ${group.tracks ?? '?'}、过孔 ${group.vias ?? '?'}；未完成网络 ${(group.failedNets ?? []).join('、') || '引擎未报告'}`)
	}
	rows.push('整板 DRC、实际连接和保存重开仍需检查。')
	return rows.join('\n')
}

async function routeFetch(): Promise<void> {
	const target = await currentTarget()
	const session = await getOrRecoverSession(target)
	if (session.engine === 'native') return routeNativeTask(target, session, 'Log')
	if(session.engine==='kirouting'){
		if(session.jobKind==='install')throw new Error('安装任务没有路由结果可取回')
		if(!session.operationId&&!session.jobId)throw new Error('KiRouting 任务缺少operationId/jobId；未取回结果')
		const data=requireSuccess(await command(target,'pcb.kiRoutingGetResult',{...(session.operationId?{operationId:session.operationId}:{}),...(session.jobId?{jobId:session.jobId}:{})},30000))
		if(data.engine!=='kirouting'||data.format!=='kirouting-json'||(session.operationId&&data.operationId!==session.operationId))throw new Error('KiRouting 结果格式或任务身份不匹配；拒绝缓存为可导入结果')
		assertKiTarget(data,target)
		if(!/^(completed|done)$/i.test(String(data.state??''))){message(`KiRouting 任务尚未完成，未缓存可导入结果。\n任务：${data.jobId??session.jobId??'未返回'}\n状态：${data.state??'未知'}`,'KiRouting 结果尚未就绪');return}
		const result=data.result??data
		if(result.format&&result.format!=='kirouting-json')throw new Error(`KiRouting 返回了非 JSON 路由结果格式：${result.format}`)
		session.jobId=typeof data.jobId==='string'?data.jobId:session.jobId
		session.kiResult=result
		routeSessions.set(keyOf(target),session)
		message(`已取回 KiRouting 布线结果，尚未导入 PCB。\n任务：${session.jobId??'未返回'}\n${kiRoutingSummary(result)}\n可选择“预检并导入布线结果…”先做只读预检。`,'KiRouting 结果已取回')
		return
	}
	if(!session.jobId)throw new Error('FreeRouting 任务还没有恢复出 jobId；先查询状态')
	const data = requireSuccess(await command(target, 'pcb.autoRouteGetResult', { jobId: session.jobId }))
	if (!data.fetched || typeof data.base64 !== 'string') {
		message(`任务：${data.jobId}\n状态：${data.state}\n尚未取回 SES。`, '自动布线结果')
		return
	}
	if (data.state !== 'COMPLETED' || data.jobId !== session.jobId)
		throw new Error(`当前任务状态/ID 与取回请求不一致（${data.state}/${data.jobId}）；拒绝缓存 SES`)
	if (data.documentUuidStatus !== 'known' || data.documentUuid !== target.uuid || (data.routeBaseline && data.routeBaseline.documentUuid !== target.uuid)) {
		routeSessions.set(keyOf(target), { ...session, ses: undefined })
		throw new Error(`SES 已取回，但绑定文档或 ARC 基线身份不匹配/未知（任务文档=${data.documentUuid ?? '未知'}，目标=${target.uuid}）；拒绝提供显式导入按钮`)
	}
	routeSessions.set(keyOf(target), { ...session, ses: data })
	message(`已取回 SES，但尚未导入 PCB。\nPCB：${target.name}\n任务：${data.jobId}\n文档绑定：${data.documentUuidStatus} (${data.documentUuid})\n走线摘要：${JSON.stringify(data.sesSummary ?? data.statistics ?? {})}\n当前获取不证明布通、规则符合或 DRC 通过。可在核对后使用“显式导入已取回 SES…”。`, 'SES 已取回')
}

async function routeImport(): Promise<void> {
	const target = await currentTarget()
	const session = await getOrRecoverSession(target)
	if (session.engine === 'native') { message('原生布线由 EDA 写回当前 PCB。完成后请检查板面、连通性和 DRC。', '原生布线结果'); return }
	if(session.engine==='kirouting'){
		if(session.jobKind==='install')throw new Error('安装任务没有可导入结果')
		if(!session.operationId&&!session.jobId)throw new Error('KiRouting 任务缺少operationId/jobId；未导入')
		if(uncertainBoards.has(keyOf(target)))throw new Error('本 PCB 上一次写入结果未知；先核对当前 PCB，不会重试导入')
		const identity={...(session.operationId?{operationId:session.operationId}:{}),...(session.jobId?{jobId:session.jobId}:{})}
		const preview=requireSuccess(await command(target,'pcb.importKiRoutingResult',{...identity,dryRun:true},300000))
		if(preview.dryRun!==true||!preview.preview)throw new Error('KiRouting 导入预检没有返回有效 dryRun preview；未执行写入')
		const accepted=await confirm(`目标 PCB：${target.name}\n任务：${session.jobId??'未返回'}\n${kiRoutingSummary(preview.preview)}\n\n确认后追加已通过预检的走线和过孔，保留原有线路。`,'显式导入 KiRouting 结果','确认并导入')
		if(!accepted)return
		const freshTarget=await currentTarget()
		if(freshTarget.uuid!==target.uuid||freshTarget.tabId!==target.tabId||freshTarget.projectUuid!==target.projectUuid)throw new Error('预检确认期间工程/PCB/页签已变化；拒绝导入缓存结果')
		const data=requireSuccess(await command(target,'pcb.importKiRoutingResult',{...identity,dryRun:false},300000))
		if(data.imported!==true||data.operationId!==session.operationId)throw new Error('KiRouting 导入响应没有确认写入或operationId不匹配；结果需人工核对')
		session.kiResult=undefined;routeSessions.set(keyOf(target),session)
		message(`KiRouting 显式导入：${data.imported?'已导入':'未确认'}\n任务：${data.jobId??session.jobId??'未返回'}\n几何读回：${data.sesGeometryVerified===true?'通过':data.sesGeometryVerified===false?'未通过':'未知'}\n下一步：检查实际连接、运行整板 DRC，再保存并重开核对。`,'KiRouting 导入结果')
		return
	}
	if(!session.jobId)throw new Error('FreeRouting 任务还没有恢复出 jobId；先查询状态')
	const ses = session.ses
	if (!ses?.fetched || ses.state !== 'COMPLETED' || ses.jobId !== session.jobId || ses.documentUuidStatus !== 'known' || ses.documentUuid !== target.uuid || (ses.routeBaseline && ses.routeBaseline.documentUuid !== target.uuid))
		throw new Error('当前 PCB 没有已取回且匹配本标签页 UUID 的 SES/routeBaseline。请先查询状态并取回结果')
	if (uncertainBoards.has(keyOf(target)))
		throw new Error('上一次针对本 PCB 的写入结果未知；为避免重复导入，请先检查 PCB 当前路线。菜单不会自动重发')
	const accepted = await confirm(`目标 PCB：${target.name}（${target.uuid}）\n任务：${session.jobId}\nSES：${ses.fileName ?? 'autoroute.ses'}\n几何摘要：${JSON.stringify(ses.sesSummary ?? {})}\n导入会在原 PCB 上新增路线/过孔，触发既有导入保护；线宽合规和几何读回会分别报告。确认显式导入？`, '显式导入自动布线 SES', '导入 SES')
	if (!accepted)
		return
	const freshTarget = await currentTarget()
	if (freshTarget.uuid !== target.uuid || freshTarget.tabId !== target.tabId)
		throw new Error('当前 PCB 标签页已变化；拒绝导入缓存 SES')
	const data = requireSuccess(await command(target, 'pcb.importAutoRouteSes', { base64: ses.base64, fileName: ses.fileName, ...(ses.routeBaseline ? { routeBaseline: ses.routeBaseline } : {}) }, 300000))
	routeSessions.set(keyOf(target), { ...session, jobId: session.jobId, ses: undefined })
	message(`导入结果：${data.imported ? '已导入' : '未导入'}\n新增几何：${JSON.stringify(data.created ?? {})}\n已存在路线：${data.alreadyPresent ?? '?'}\n几何读回：${data.sesGeometryVerified === true ? '通过' : data.sesGeometryVerified === false ? '未通过' : '未知'}\n线宽合规：${data.widthRuleCompliance?.status ?? '未知'}；违规 ${data.widthRuleCompliance?.violations?.length ?? '?'}，未知项 ${data.widthRuleCompliance?.unknowns?.length ?? '?'}\n导入不等于 DRC 通过。`, 'SES 导入结果')
}

const actions: Record<MenuAction, () => Promise<void>> = {
	group: groupComponents,
	'mark-regions': markSchematicRegions,
	'locate-region': locateSchematicRegion,
	'route-start': routeStart,
	'route-status': routeStatus,
	'route-stop': routeStop,
	'route-fetch': routeFetch,
	'route-import': routeImport,
}

/** Owner runs all commands through its current proxy connection and the proxy's per-instance command lane. */
export function launchPcbToolsAction(action: MenuAction): void {
	if (activeAction) {
		message(`“${activeAction}”操作或对话框仍在进行中。`, 'PCB 辅助工具')
		return
	}
	activeAction = action
	void actions[action]().catch(error => showError('PCB 辅助工具', error)).finally(() => { activeAction = null })
}
