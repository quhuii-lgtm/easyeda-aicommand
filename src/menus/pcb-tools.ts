import { getBridgeInstanceId } from '../bridge/client'
import { getProxyUrl } from '../bridge/proxy-endpoint'
import { frRequest } from '../bridge/freerouting'

type MenuAction = 'group' | 'route-start' | 'route-status' | 'route-stop' | 'route-fetch' | 'route-import'
type Target = { uuid: string, tabId: string, name: string }
type CommandReply = { ok: boolean, cmd?: string, data?: any, error?: { message?: string, cause?: any } }
type RouteSession = { jobId?: string, ses?: any, unknownStart?: boolean, state?: string }

const routeSessions = new Map<string, RouteSession>()
let activeAction: MenuAction | null = null
const uncertainBoards = new Map<string, string>()
const keyOf = (target: Target): string => `${target.tabId}::${target.uuid}`

function message(content: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(content, title)
}

function confirm(content: string, title: string, yes: string): Promise<boolean> {
	return new Promise(resolve => eda.sys_Dialog.showConfirmationMessage(content, title, yes, '取消', resolve))
}

function input(content: string, title: string, value: string, props: { min?: number, max?: number, step?: number, placeholder?: string } = {}): Promise<string | undefined> {
	return new Promise(resolve => eda.sys_Dialog.showInputDialog(content, '', title, 'number', value, props, (answer: unknown) => resolve(answer == null || answer === '' ? undefined : String(answer))))
}

async function currentTarget(): Promise<Target> {
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (doc?.documentType !== 3 || typeof doc.uuid !== 'string' || !doc.uuid.trim() || typeof (doc as any).tabId !== 'string' || !(doc as any).tabId.trim())
		throw new Error('请先激活目标 PCB 标签页；菜单要求有效 PCB UUID 和 tabId')
	const project: any = await eda.dmt_Project.getCurrentProjectInfo()
	const boards = Array.isArray(project?.data) ? project.data : []
	const board = boards.find((item: any) => item?.pcb?.uuid === doc.uuid)
	return { uuid: doc.uuid, tabId: (doc as any).tabId, name: String(board?.pcb?.name ?? board?.name ?? doc.uuid) }
}

function menuParams(target: Target, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...extra, __docUuid: target.uuid, __tabId: target.tabId }
}

async function command(target: Target, cmd: string, params: Record<string, unknown>, timeoutMs = 300000): Promise<CommandReply> {
	const url = getProxyUrl('/command')
	if (!url)
		throw new Error('本窗口没有连接到兼容的本地代理；请先等待桥接连接后重试')
	const instanceId = getBridgeInstanceId()
	if (!instanceId.trim())
		throw new Error('本窗口 instanceId 无效，已停止请求')
	const request = async (): Promise<CommandReply> => {
		const response = await eda.sys_ClientUrl.request(url, 'POST', JSON.stringify({ instanceId, cmd, params: menuParams(target, params) }), { headers: { 'Content-Type': 'application/json' } })
		const text = await response.text()
		if (!response.ok)
			throw new Error(`${cmd} HTTP ${response.status}；未确认指令结果，不能盲目重发`)
		const result = JSON.parse(text) as CommandReply
		if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
			throw new Error(`${cmd} 返回格式无法确认；不要重复提交`)
		if (isWrite && !result.ok && (result.error as any)?.cause?.partial === true)
			uncertainBoards.set(keyOf(target), cmd)
		return result
	}
	const isWrite = cmd === 'pcb.autoRouteStart' || cmd === 'pcb.autoRouteStop' || cmd === 'pcb.importAutoRouteSes'
		|| (cmd === 'pcb.groupBySchematicRegions' && params.dryRun === false)
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([request(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`等待 ${cmd} 返回超过 ${timeoutMs}ms；该请求可能仍在执行，不能重发`)), timeoutMs) })])
	}
	catch (error) {
		if (isWrite)
			uncertainBoards.set(keyOf(target), cmd)
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
	const previous = routeSessions.get(keyOf(target))
	if (previous?.unknownStart || uncertainBoards.get(keyOf(target)) === 'pcb.autoRouteStart')
		throw new Error('上一启动结果未知；先查询状态恢复 jobId，不要重新启动')
	if (previous?.jobId && previous.state && !['COMPLETED', 'CANCELLED', 'FAILED', 'ERROR'].includes(previous.state))
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
	const response = await command(target, 'pcb.autoRouteStart', { maxPasses }, 300000)
	if (!response.ok) {
		const jobId = typeof response.error?.cause?.jobId === 'string' ? response.error.cause.jobId : undefined
		if (jobId)
			routeSessions.set(keyOf(target), { jobId })
		else if ((response.error as any)?.cause?.outcome === 'start-request-unknown')
			routeSessions.set(keyOf(target), { unknownStart: true })
		throw Object.assign(new Error(response.error?.message ?? '自动布线启动失败'), { cause: response.error?.cause })
	}
	const data = response.data
	routeSessions.set(keyOf(target), { jobId: String(data.jobId), state: 'SUBMITTED' })
	const warnings = [...(data.dsnConversion?.warnings ?? []), ...(data.dsnConversion?.limitations ?? [])]
	message(`启动请求已提交，尚未确认 FreeRouting 已开始。\nPCB：${target.name}（${target.uuid}）\n任务 ID：${data.jobId}\n最大迭代数：${maxPasses}\n规则完整性：${data.routingConstraintsComplete ? '完整' : '不完整'}\n线宽比对：${data.widthRuleComparison?.status ?? '未报告'}，未知项 ${data.widthRuleComparison?.unknowns?.length ?? '未报告'}\nDSN提示：${warnings.slice(0, 6).join('\n') || '无'}\n请用“查询自动布线状态…”查看任务；完成后先取回 SES，再显式导入。不会自动导入。`, '自动布线已提交')
}

function getSession(target: Target): RouteSession {
	const session = routeSessions.get(keyOf(target))
	if (!session?.jobId)
		throw new Error(`当前 PCB 标签页没有本菜单启动的任务记录。目标：${target.name}（${target.uuid}，tabId=${target.tabId}）；不要猜测或重用其他 PCB 的 jobId`)
	return session
}

async function routeStatus(): Promise<void> {
	const target = await currentTarget()
	const session = getSession(target)
	const data = requireSuccess(await command(target, 'pcb.autoRouteStatus', { jobId: session.jobId }))
	if (typeof data.jobId === 'string' && data.jobId) {
		routeSessions.set(keyOf(target), { ...session, jobId: data.jobId, state: data.state, unknownStart: false })
		if (['pcb.autoRouteStart', 'pcb.autoRouteStop'].includes(uncertainBoards.get(keyOf(target)) ?? ''))
			uncertainBoards.delete(keyOf(target))
	}
	message(`PCB：${target.name}\n任务：${data.jobId}\n状态：${data.state}${data.stage ? ` / ${data.stage}` : ''}${data.currentPass != null ? `\n迭代：${data.currentPass}` : ''}\n状态查询不读取 SES，也不修改 PCB。${data.state === 'COMPLETED' ? '\n下一步可选择“取回已完成 SES…”。' : ''}`, '自动布线状态')
}

async function routeStop(): Promise<void> {
	const target = await currentTarget()
	const session = getSession(target)
	const accepted = await confirm(`目标 PCB：${target.name}\n任务 ID：${session.jobId}\n确认向 FreeRouting 发送停止请求？`, '停止自动布线', '停止任务')
	if (!accepted)
		return
	const data = requireSuccess(await command(target, 'pcb.autoRouteStop', { jobId: session.jobId }))
	if (data.state && uncertainBoards.get(keyOf(target)) === 'pcb.autoRouteStop')
		uncertainBoards.delete(keyOf(target))
	message(`任务：${data.jobId}\n停止请求结果：${data.cancelled ? '已取消' : data.outcome ?? '未取消'}\n状态：${data.state ?? '未知'}${data.note ? `\n${data.note}` : ''}`, '自动布线停止结果')
}

async function routeFetch(): Promise<void> {
	const target = await currentTarget()
	const session = getSession(target)
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
	const session = getSession(target)
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
	routeSessions.set(keyOf(target), { jobId: session.jobId, ses: undefined })
	message(`导入结果：${data.imported ? '已导入' : '未导入'}\n新增几何：${JSON.stringify(data.created ?? {})}\n已存在路线：${data.alreadyPresent ?? '?'}\n几何读回：${data.sesGeometryVerified === true ? '通过' : data.sesGeometryVerified === false ? '未通过' : '未知'}\n线宽合规：${data.widthRuleCompliance?.status ?? '未知'}；违规 ${data.widthRuleCompliance?.violations?.length ?? '?'}，未知项 ${data.widthRuleCompliance?.unknowns?.length ?? '?'}\n导入不等于 DRC 通过。`, 'SES 导入结果')
}

const actions: Record<MenuAction, () => Promise<void>> = {
	group: groupComponents,
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
