/**
 * PCB 类指令
 *
 * 注意：PCB 坐标默认单位为 mil（与 PCB 编辑器内部一致，界面显示 mm 时注意换算，1mm ≈ 39.37mil）
 */
import type { ICommandDef } from '../engine/types'
import { assertSnapshotFocused, captureDocumentSnapshot, withDocumentRecovery } from '../engine/documentRecovery'
import { widthForCurrent } from '../knowledge/rules'
import { blobToBase64, fileToResult } from './util'
import { beginTask, failTask, finishTask, taskProgress } from '../engine/tasks'
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'

/** 0.10.42：给无保护 await 加超时（官方偶发永不 resolve，曾致整批删除挂死 300s 无结果） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时（>${ms / 1000}s，官方无响应）`)), ms)),
	])
}

// ---------- FreeRouting 自动布线（REST 客户端 + 任务状态） ----------
const FR_API_BASE = 'http://127.0.0.1:37864/v1'
let currentRouteJobId: string | undefined
/** 已完成回灌消费（或回灌已作废）的任务集合（0.10.65）：COMPLETED 任务的清线+导入只执行一次，
 *  任一步抛错也不允许重复轮询再进清线分支（旧版会叠加删除未锁定走线/重复导入） */
const consumedRouteJobs = new Set<string>()
const routeJobRecoveryState = new Map<string, 'applying' | 'applied' | 'recoveryRequired'>()
let routeSkipDrc = false

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
	if (typeof layer === 'number' && Number.isFinite(layer))
		return layer
	const s = String(layer ?? '').trim().toLowerCase()
	if (s === '')
		return 1
	if (s === 'bottom' || s === 'b')
		return 2
	if (s === 'top' || s === 't')
		return 1
	if (/^\d+$/.test(s))
		return Number(s)
	throw new Error(`不认识的层 "${layer}"——0.10.39 起不再静默回退到顶层。合法取值：${LAYER_HELP}`)
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
		'top': 1, 'bottom': 2,
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
			return { modified: okAny || verified, primitiveId, ...(checks.length ? { readback: { ...readback, verified } } : {}) }
		},
	},
	{
		name: 'pcb.routeTrack',
		summary: 'PCB 走线（折线，自动拆成线段）；可按载流自动计算线宽。分段写入部分失败时返回 partial 证据并停止后续段；失败段可能已生效，先核对现场再处理',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名（须已存在于 PCB，可用 pcb.listNets 查看）' },
			{ name: 'points', type: 'number[][]', required: true, description: '折点坐标 [[x1,y1],[x2,y2],...]' },
			{ name: 'layer', type: 'string', description: 'top | bottom，默认 top' },
			{ name: 'width', type: 'number', description: '线宽（与 currentA 二选一）' },
			{ name: 'currentA', type: 'number', description: '载流（安培），由知识库自动换算线宽' },
		],
		returns: '{ segmentIds, width }；分段失败时 error.cause={partial:true,retryable:false,segmentIds,failedSegmentIndex,failedSegmentAttempted,unprocessedSegments,phase,operationError}',
		example: { cmd: 'pcb.routeTrack', params: { net: 'VCC', points: [[100, 100], [500, 100]], width: 12 } },
		handler: async (params) => {
			const monotonicStart = performance.now()
			const MAX_TIMER_MS = 2147483647
			const requestedTimeout = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedTimeout) || requestedTimeout > MAX_TIMER_MS)
				throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`)
			const budgetMs = Math.max(1000, requestedTimeout)
			const deadline = monotonicStart + budgetMs
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
			let width = params.width != null ? Number(params.width) : undefined
			if (width != null && (!Number.isFinite(width) || width <= 0))
				throw new Error('width 必须是大于 0 的有限数值')
			if (width == null && params.currentA != null && (!Number.isFinite(Number(params.currentA)) || Number(params.currentA) <= 0))
				throw new Error('currentA 必须是大于 0 的有限数值')
			const layer = resolveLayer(params.layer) as any
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
			if (width == null && params.currentA != null) {
				const hit = widthForCurrent(Number(params.currentA))
				if (!hit)
					throw new Error(`载流 ${params.currentA}A 超出知识库线宽表范围，请显式指定 width`)
				width = hit.widthMil
			}

			const points = params.points as Array<Array<number>>
			const segmentIds: string[] = []
			const failPartial = (segmentIndex: number, error: unknown, attempted = true): never => {
				const operationError = error instanceof Error ? error.message : String(error)
				const cause = {
					partial: true,
					retryable: false,
					segmentIds: [...segmentIds],
					failedSegmentIndex: segmentIndex,
					failedSegmentAttempted: attempted,
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
				try {
					let timer: ReturnType<typeof setTimeout> | undefined
					try {
						line = await Promise.race([
							eda.pcb_PrimitiveLine.create(String(params.net), layer, Number(x1), Number(y1), Number(x2), Number(y2), width),
							new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`第 ${i + 1} 段创建超时（共享预算已耗尽）`)), left) }),
						])
					}
					finally {
						if (timer !== undefined)
							clearTimeout(timer)
					}
				}
				catch (err) {
					failPartial(i + 1, wrapCreateError(`第 ${i + 1} 段走线创建`, err))
				}
				if (!line)
					failPartial(i + 1, new Error('官方返回空'))
				const id = safeState<unknown>(line, 'getState_PrimitiveId')
				if (typeof id !== 'string' || !id)
					failPartial(i + 1, new Error('官方返回对象缺少有效线段 ID'))
				segmentIds.push(id as string)
				if (remaining() <= 0)
					failPartial(i + 1, new Error('创建调用完成时共享预算已耗尽'))
			}
			return { segmentIds, width }
		},
	},
	{
		name: 'pcb.placeVia',
		summary: '放置过孔',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名（须已存在于 PCB）' },
			{ name: 'x', type: 'number', required: true, description: '坐标 X' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
			{ name: 'holeDiameter', type: 'number', required: true, description: '孔径' },
			{ name: 'diameter', type: 'number', required: true, description: '外径' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'pcb.placeVia', params: { net: 'GND', x: 100, y: 100, holeDiameter: 12, diameter: 24 } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			await ensureNetExists(String(params.net))
			let via: any
			try {
				via = await eda.pcb_PrimitiveVia.create(
					String(params.net),
					Number(params.x),
					Number(params.y),
					Number(params.holeDiameter),
					Number(params.diameter),
				)
			}
			catch (err) {
				throw wrapCreateError('过孔创建', err)
			}
			if (!via)
				throw new Error('过孔创建失败（官方返回空）')
			return { primitiveId: safeState<string>(via, 'getState_PrimitiveId') }
		},
	},
	{
		name: 'pcb.pourCopper',
		summary: '矩形铺铜（GND 平面等）',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名，通常为 GND（须已存在于 PCB）' },
			{ name: 'layer', type: 'string', description: 'top | bottom，默认 top' },
			{ name: 'x', type: 'number', required: true, description: '矩形左下角 X' },
			{ name: 'y', type: 'number', required: true, description: '矩形左下角 Y' },
			{ name: 'width', type: 'number', required: true, description: '矩形宽度' },
			{ name: 'height', type: 'number', required: true, description: '矩形高度' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'pcb.pourCopper', params: { net: 'GND', layer: 'bottom', x: 0, y: 0, width: 2000, height: 1500 } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			await ensureNetExists(String(params.net))
			// 官方 'R' 矩形的 (x,y) 是**左上角**（画布 +Y 向上，矩形向下延伸），
			// 本指令对外约定 (x,y) 为**左下角**，此处换算：官方y = 左下角y + height
			// （0.10.65 修复：此前未换算，铺铜整体偏移一个板高——与 drawOutline 同一约定）
			const polygon = eda.pcb_MathPolygon.createPolygon([
				'R',
				Number(params.x), Number(params.y) + Number(params.height),
				Number(params.width), Number(params.height),
				0, 0,
			])
			const layer = resolveLayer(params.layer) as any
			let pour: any
			try {
				pour = await eda.pcb_PrimitivePour.create(String(params.net), layer, polygon as any)
			}
			catch (err) {
				throw wrapCreateError('铺铜创建', err)
			}
			if (!pour)
				throw new Error('铺铜创建失败（官方返回空）')
			return { primitiveId: safeState<string>(pour, 'getState_PrimitiveId') }
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
			const list = Array.isArray(violations) ? violations : []
			return { passed: list.length === 0, violations: list }
		},
	},
	{
		name: 'pcb.runDrcDetailed',
		summary: '运行 PCB DRC 并返回逐条违规明细（0.10.23，P08 探针结论：官方 eda.pcb_Drc.check(strict, ui, includeVerboseError=true) 详细模式返回 Array<any> 全部违规项含描述——pro-api-types 6452-6486 行实锤；与 pcb.runDrc 同源，但本指令对每项做归一化（type/rule/message 尽量提取）并按级别聚合计数）',
		params: [],
		returns: '{ passed, totalCount, fatalCount, warnCount, violations: [逐条明细] }（0.10.25 起按实测树形结构拍平：官方返回 [{name:类别, list:[{name:网络, list:[叶]}]}]，叶提取 type/rule/ruleName/errorType/message/net/primitiveId(s)/objectType/objectName/x/y/layerIds，raw 保留原始叶兜底）',
		example: { cmd: 'pcb.runDrcDetailed' },
		handler: async () => {
			const violations = await eda.pcb_Drc.check(true, false, true)
			const list = Array.isArray(violations) ? violations : []
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
					...(pos.x != null ? { x: Number(pos.x) } : {}),
					...(pos.y != null ? { y: Number(pos.y) } : {}),
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
		summary: '从原理图导入变更到 PCB（注意：会弹出确认对话框，需要用户在 EDA 中点击应用；原理图有致命 DRC 错误时会静默返回 false，先跑 schematic.runDrc）',
		params: [
			{ name: 'schematicUuid', type: 'string', description: '原理图 UUID，默认同 Board 关联的原理图' },
		],
		returns: '{ imported }（false 表示失败或该 PCB 未关联原理图）',
		example: { cmd: 'pcb.importChanges' },
		handler: async (params) => {
			const imported = await eda.pcb_Document.importChanges(
				params.schematicUuid ? String(params.schematicUuid) : undefined,
			)
			return { imported, note: '若弹出导入变更对话框，需要用户在 EDA 中点击应用' }
		},
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
		summary: '删除 PCB 图元（器件 / 走线 / 过孔 / 铺铜 / 板框(Region) / 文字等，按 primitiveId，可批量）；先识别类型再删，删后读回验证，杜绝假成功。0.10.23 加固（与 schematic.delete 同套机制）：逐项 8s 超时熔断、连续 3 失败熔断整批、batchSize 分批（默认 10，批间停 300ms）、全局时间预算 100s（耗尽停开新项、累积结果照常返回）、unprocessed 清单可续删',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '要删除的图元 ID 列表' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 10：每批之间停 300ms 并记录分批进度。大批删除建议保持默认多次调用，不要一次调大硬跑' },
		],
		returns: '{ taskId, deleted: [...], failed: [...], deletedBy: { id: type }, reconciled?, sessionHealth?, batches?, unprocessed?, failedNote? }（taskId 可配合 task.get 在客户端超时后查进度/补取结果——0.10.42 起同参数任务在跑时重发只回进度不重复执行；unprocessed 为熔断/预算退出时未轮到的 ID，再次调用接着删；0.10.25 起整批结束后终扫对账：报失败但实际已被后台删除的项挪入 deleted 并在 reconciled 注明；0.10.27 起出现过 reconciled/failed 时追加会话健康探针 sessionHealth: ok|degraded|inconclusive，degraded 建议只读复核后再决定是否不保存重开页面，inconclusive 为探针未得出可信结论（不采信）；0.10.40 起探针加固：焦点复核+3 次重试+创建/删除读回，删除异常时报 probeResidue 残留探针 ID）',
		example: { cmd: 'pcb.delete', params: { primitiveIds: ['xxx', 'yyy'] } },
		handler: async (params, ctx) => {
			const ids = Array.isArray(params.primitiveIds)
				? params.primitiveIds.map(String)
				: [String(params.primitiveIds)]
			if (!ids.length)
				throw new Error('primitiveIds 不能为空')
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
				for (const kind of kinds) {
					try {
						if ((await kind.list()).includes(id))
							return kind
					}
					catch {
						// 查询失败则尝试下一种类型
					}
				}
				return undefined
			}
			const deleted: Array<string> = []
			const failed: Array<string> = []
			const deletedBy: Record<string, string> = {}
			// 0.10.23 加固（照抄 pruneFloatingLabels 0.10.12 / schematic.delete 0.10.23 成熟机制）：
			//  ① 逐项 8s Promise.race 超时熔断；② 连续 3 项失败熔断整批；
			//  ③ 分批执行（batchSize 默认 10，批间停 300ms），unprocessed 可再次调用续删；
			//  ④ 全局时间预算 100s，耗尽即停开新项，已累积结果照常返回；
			//  ⑤ 每项成败一律以删后读回为准，不信 delete 布尔返回值（原有机制保留）。
			const PER_ITEM_TIMEOUT_MS = 8000
			const MAX_CONSECUTIVE_FAILS = 3
			const GLOBAL_BUDGET_MS = 100000 // 扩展侧该指令超时已放宽到 140s，留 40s 余量给收尾与传输
			const batchSize = Math.max(1, Number(params.batchSize) || 10)
			const startedAt = Date.now()
			const batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> = []
			const attempted = new Set<string>()
			const diagnostics: Array<string> = []
			const failReason = new Map<string, string>() // 0.10.41：记录每项失败原因，终扫对账排除「从不存在」的 ID
			let consecutiveFails = 0
			let circuitBroken = false
			let budgetExhausted = false
			const deleteOne = async (id: string): Promise<void> => {
				const kind = await detectType(id)
				if (!kind)
					throw new Error('图元不存在或类型暂不支持（各类型清单均未命中）')
				await kind.del([id])
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
					throw new Error('删后读回验证仍在（假成功）')
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
						consecutiveFails = 0
					}
					catch (e: any) {
						failReason.set(id, String(e?.message ?? e))
						failed.push(id)
						bFailed++
						consecutiveFails++
						diagnostics.push(`${id}: ${String(e?.message ?? e)}`)
						if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
							circuitBroken = true
							diagnostics.push(`⚠️ 连续 ${MAX_CONSECUTIVE_FAILS} 项失败（均以读回确认为准），熔断整批——会话可能已损坏，建议【不保存重开页面】后再分批重试`)
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
					// 0.10.42：终扫枚举整体 20s 超时（旧版无保护，官方挂起时整批无返回）
					await withTimeout(Promise.all(kinds.map(async (k) => {
						try {
							for (const id of await k.list())
								alive.add(id)
						}
						catch { /* 单类清单失败不阻断 */ }
					})), 20000, '终扫枚举')
					for (const id of [...failed]) {
						if ((failReason.get(id) ?? '').includes('不存在'))
							continue // 0.10.41：从不存在的 ID 不参与对账（终扫必然查不到会误挪 deleted），保持 failed
						if (!alive.has(id)) {
							failed.splice(failed.indexOf(id), 1)
							deleted.push(id)
							reconciled.push({ id, note: '超时返回但后台已删除，经终扫确认' })
						}
					}
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
		returns: '焊盘列表 [{ padNumber, net, x, y, layer, rotation, shape }]（shape 为官方形状数组，如 ["RECT",90,60] / ["ELLIPSE",60,60]，可直接得焊盘宽高）',
		example: { cmd: 'pcb.getComponentPads', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			if (!pads?.length)
				throw new Error('未找到该器件的焊盘（请先激活对应 PCB）')
			return pads.map(p => ({
				padNumber: safeState<string>(p, 'getState_PadNumber'),
				net: safeState<string>(p, 'getState_Net'),
				x: safeState<number>(p, 'getState_X'),
				y: safeState<number>(p, 'getState_Y'),
				layer: safeState<number>(p, 'getState_Layer'),
				rotation: safeState<number>(p, 'getState_Rotation'),
				shape: safeState<Array<unknown>>(p, 'getState_Pad'),
			}))
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
		returns: '{ complete, components: [{ designator, layer, bbox:{x1,y1,x2,y2,w,h} }], overlaps: [{ a, b, overlapX, overlapY }], violations: [{ a, b, gap }], skippedNoPads?, skippedUnsupported? }',
		example: { cmd: 'pcb.checkPlacement', params: { minClearance: 20, margin: 15 } },
		handler: async (params) => {
			const minClearance = params.minClearance != null ? Number(params.minClearance) : 0
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
			const fileType = (params.fileType === 'xlsx' ? 'xlsx' : 'csv') as 'xlsx' | 'csv'
			const unit = (String(params.unit ?? 'mm').toLowerCase() === 'mil' ? 'MIL' : 'MILLIMETER') as any
			const file = await eda.pcb_ManufactureData.getPickAndPlaceFile(
				params.fileName ? String(params.fileName) : undefined,
				fileType,
				params.unit != null ? unit : undefined,
			)
			const result = await fileToResult(file, `pick-and-place.${fileType}`)
			if (!result)
				throw new Error('贴片坐标导出失败：官方返回空（请确认已激活 PCB 文档）')
			return result
		},
	},
	{
		name: 'pcb.exportDsn',
		summary: '导出 Specctra DSN 文件（外部自动布线工作流第一步：官方 pcb.autoRouting 被 @alpha 锁定，替代路线为 导出 dsn → 外部布线器 → 官方 importAutoRouteSesFile 导回）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 board' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'pcb.exportDsn' },
		handler: async (params) => {
			const file = await eda.pcb_ManufactureData.getDsnFile(
				params.fileName ? String(params.fileName) : undefined,
			)
			const result = await fileToResult(file, 'board.dsn')
			if (!result)
				throw new Error('DSN 导出失败：官方返回空（请确认已激活 PCB 文档）')
			return result
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
			if (!result)
				throw new Error('PCB 网表导出失败：官方返回空')
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
				params.color ? String(params.color) as any : undefined as any,
			)
			return { created: Boolean(created) }
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
			{ name: 'net', type: 'string', required: true, description: '网络名' },
		],
		returns: '图元列表',
		example: { cmd: 'pcb.getNetPrimitives', params: { net: 'GND' } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			return await eda.pcb_Net.getAllPrimitivesByNet(String(params.net))
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
		summary: '查询当前激活层',
		params: [],
		returns: '当前层信息',
		example: { cmd: 'pcb.getCurrentLayer' },
		handler: async () => {
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
			{ name: 'count', type: 'number', required: true, description: '铜层数，如 2 或 4' },
		],
		returns: '{ set }',
		example: { cmd: 'pcb.setCopperLayers', params: { count: 2 } },
		handler: async (params) => {
			if (params.count == null)
				throw new Error('缺少参数 count')
			const set = await eda.pcb_Layer.setTheNumberOfCopperLayers(Number(params.count) as any)
			return { set: Boolean(set) }
		},
	},
	{
		name: 'pcb.setLayerVisible',
		summary: '设置层显示/隐藏',
		params: [
			{ name: 'layers', type: 'Array<string|number>', required: true, description: '层列表（top/bottom 或层 ID）' },
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
			{ name: 'layers', type: 'Array<string|number>', required: true, description: '层列表（top/bottom 或层 ID）' },
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
		returns: '[{ primitiveId, net, layer, pourName, pourPriority, lineWidth, fillMethod, locked, filled?: boolean|null, fillStatus?: filled|empty|unknown, fillReadError?, fillPrimitiveId?, fillRegions? }]',
		example: { cmd: 'pcb.listPours', params: { net: 'GND', withFill: true } },
		handler: async (params) => {
			const readFillWithTimeout = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => { clearTimeout(timer); reject(new Error('getCopperRegion超时（>20s，官方无响应）')) }, 20000)
				void promise.then(
					value => { clearTimeout(timer); resolve(value) },
					error => { clearTimeout(timer); reject(error) },
				)
			})
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
						}
						else {
							const fillRegion = region as any
							if (typeof fillRegion !== 'object' || typeof fillRegion.getState_PrimitiveId !== 'function' || typeof fillRegion.getState_PourFills !== 'function')
								throw new Error('填充对象缺少必要读回方法')
							const id = fillRegion.getState_PrimitiveId()
							const fills = fillRegion.getState_PourFills()
							if (typeof id !== 'string' || !id || !Array.isArray(fills) || fills.some((fill: unknown) => fill == null || typeof fill !== 'object'))
								throw new Error('填充对象 ID 或填充区域结构无效')
							item.fillPrimitiveId = id
							item.fillRegions = fills.length
							item.filled = fills.length > 0
							item.fillStatus = fills.length > 0 ? 'filled' : 'empty'
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
		summary: '修改已有铺铜（网络/层/名称/优先级/线宽）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '铺铜图元 ID' },
			{ name: 'net', type: 'string', description: '新网络名' },
			{ name: 'layer', type: 'string | number', description: `新层：${LAYER_HELP}` },
			{ name: 'pourName', type: 'string', description: '铺铜名称' },
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
				return { target: target.data as Record<string, any>, orders: all.filter(item => item.data.layerId === target.data.layerId).map(item => ({ primitiveId: item.id, layer: item.data.layerId, sourceOrder: item.data.order })).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId))) }
			}
			const names = ['net', 'layer', 'pourName', 'pourPriority', 'lineWidth'] as const
			const sourceField: Record<(typeof names)[number], string> = { net: 'netName', layer: 'layerId', pourName: 'name', pourPriority: 'order', lineWidth: 'width' }
			const sourceValue = (data: Record<string, any>, key: (typeof names)[number]) => data[sourceField[key]]
			const equivalent = (key: (typeof names)[number], actual: unknown, expected: unknown) => key === 'net' || key === 'pourName' ? actual === expected : typeof actual === 'number' && actual === expected
			const requested = Object.fromEntries(names.filter(key => property[key] != null).map(key => [key, property[key]]))
			let previousSource: Awaited<ReturnType<typeof readSource>> | undefined
			const sourceOrders: { before: Array<Record<string, unknown>>, after?: Array<Record<string, unknown>> } = { before: [] }
			const attemptedFields: Array<string> = []
			const verifiedFields: Array<string> = []
			const readback: Record<string, unknown> = {}
			let apiPriority: number | undefined
			let lastSource: Record<string, any> = {}
			let readbackStatus: 'current' | 'lastKnown' = 'current'
			const refreshVerifiedFields = (data: Record<string, any>) => {
				verifiedFields.splice(0, verifiedFields.length, ...attemptedFields.filter(field => equivalent(field as (typeof names)[number], sourceValue(data, field as (typeof names)[number]), requested[field])))
			}
			const remainingFields = () => names.filter(key => property[key] != null && !attemptedFields.includes(key))
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
			for (const key of names) {
				if (property[key] == null)
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
				modified: true,
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
		summary: '导入外部布线器的 SES 结果文件（自动布线最后一步：pcb.exportDsn 导出 → 外部布线器布线 → 本指令回灌；传 base64 文件内容）',
		params: [
			{ name: 'base64', type: 'string', required: true, description: 'SES 文件内容的 base64 编码' },
			{ name: 'fileName', type: 'string', description: '文件名，默认 autoroute.ses' },
		],
		returns: '{ imported }',
		example: { cmd: 'pcb.importAutoRouteSes', params: { fileName: 'board.ses', base64: '...' } },
		handler: async (params) => {
			if (!params.base64)
				throw new Error('缺少参数 base64（SES 文件内容的 base64 编码）')
			const bin = atob(String(params.base64))
			const u8 = new Uint8Array(bin.length)
			for (let i = 0; i < bin.length; i++)
				u8[i] = bin.charCodeAt(i)
			const file = new File([u8], params.fileName ? String(params.fileName) : 'autoroute.ses')
			const imported = await eda.pcb_Document.importAutoRouteSesFile(file)
			return { imported: Boolean(imported) }
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
			const prims = await eda.pcb_Document.getPrimitivesInRegion(
				Number(params.left), Number(params.right), Number(params.top), Number(params.bottom),
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
			const p = await eda.pcb_Document.getPrimitiveAtPoint(Number(params.x), Number(params.y))
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
		summary: '列出全部物理层叠配置（含当前生效与默认配置名；多层板层叠设置的入口）',
		params: [],
		returns: '{ configs, current, default }',
		example: { cmd: 'pcb.listStackingConfigs' },
		handler: async () => {
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
		summary: '读取指定层叠配置的完整定义（层顺序/厚度/介质等；不传 name 时读当前生效配置）',
		params: [
			{ name: 'name', type: 'string', description: '配置名，留空读当前生效配置' },
		],
		returns: '层叠配置对象（可直接改完传给 pcb.applyStackingConfig）',
		example: { cmd: 'pcb.getStackingConfig' },
		handler: async (params) => {
			if (params.name)
				return await eda.pcb_Layer.getPhysicalStackingConfiguration(String(params.name))
			return await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration()
		},
	},
	{
		name: 'pcb.applyStackingConfig',
		summary: '把层叠配置对象应用到当前 PCB（典型用法：pcb.getStackingConfig 读回 → 修改 → 本指令写回）',
		params: [
			{ name: 'configuration', type: 'object', required: true, description: '层叠配置对象（IPC​​B_PhysicalStackingConfiguration 结构）' },
		],
		returns: '{ applied }',
		example: { cmd: 'pcb.applyStackingConfig', params: { configuration: {} } },
		handler: async (params) => {
			if (!params.configuration || typeof params.configuration !== 'object')
				throw new Error('缺少参数 configuration（层叠配置对象，先 pcb.getStackingConfig 读回再改）')
			const applied = await eda.pcb_Layer.overwriteCurrentPhysicalStackingConfiguration(params.configuration as any)
			return { applied: Boolean(applied) }
		},
	},
	{
		name: 'pcb.saveStackingConfig',
		summary: '把层叠配置对象另存为命名配置',
		params: [
			{ name: 'configuration', type: 'object', required: true, description: '层叠配置对象' },
			{ name: 'name', type: 'string', required: true, description: '保存为的配置名' },
			{ name: 'allowOverwrite', type: 'boolean', description: '允许覆盖同名配置，默认 false' },
		],
		returns: '{ saved }',
		example: { cmd: 'pcb.saveStackingConfig', params: { name: '4层-1.6mm', configuration: {} } },
		handler: async (params) => {
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
		summary: '重命名层叠配置',
		params: [
			{ name: 'oldName', type: 'string', required: true, description: '原配置名' },
			{ name: 'newName', type: 'string', required: true, description: '新配置名' },
		],
		returns: '{ renamed }',
		example: { cmd: 'pcb.renameStackingConfig', params: { oldName: 'a', newName: 'b' } },
		handler: async (params) => {
			if (!params.oldName || !params.newName)
				throw new Error('缺少参数 oldName / newName')
			const renamed = await eda.pcb_Layer.renamePhysicalStackingConfiguration(String(params.oldName), String(params.newName))
			return { renamed: Boolean(renamed) }
		},
	},
	{
		name: 'pcb.deleteStackingConfig',
		summary: '删除层叠配置',
		params: [
			{ name: 'name', type: 'string', required: true, description: '配置名' },
		],
		returns: '{ deleted }',
		example: { cmd: 'pcb.deleteStackingConfig', params: { name: 'a' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const deleted = await eda.pcb_Layer.deletePhysicalStackingConfiguration(String(params.name))
			return { deleted: Boolean(deleted) }
		},
	},
	{
		name: 'pcb.setDefaultStackingConfig',
		summary: '把指定层叠配置设为默认',
		params: [
			{ name: 'name', type: 'string', required: true, description: '配置名' },
		],
		returns: '{ done }',
		example: { cmd: 'pcb.setDefaultStackingConfig', params: { name: '4层-1.6mm' } },
		handler: async (params) => {
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
			const t = /fpc/i.test(String(params.pcbType)) ? 'FPC' : 'NORMAL'
			const done = await eda.pcb_Layer.setPcbType(t as any)
			return { done: Boolean(done) }
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
				params.color ? String(params.color) as any : undefined as any,
			)
			return { created: Boolean(created) }
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
		summary: '开启实时 DRC（布线时即时报违规；高速/高密度板建议开）。⚠️ 官方 @beta 接口，需要 EDA v4.2+，低版本调用返回 done:false',
		params: [],
		returns: '{ done }',
		example: { cmd: 'pcb.startRealTimeDrc' },
		handler: async () => {
			const done = await eda.pcb_Drc.startRealTimeDrc()
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.stopRealTimeDrc',
		summary: '关闭实时 DRC（需要 EDA v4.2+）',
		params: [],
		returns: '{ done }',
		example: { cmd: 'pcb.stopRealTimeDrc' },
		handler: async () => {
			const done = await eda.pcb_Drc.stopRealTimeDrc()
			return { done: Boolean(done) }
		},
	},
	{
		name: 'pcb.getRealTimeDrcStatus',
		summary: '查询实时 DRC 开关状态（需要 EDA v4.2+；低版本/不在 PCB 时恒返回 enabled:false）',
		params: [],
		returns: '{ enabled }',
		example: { cmd: 'pcb.getRealTimeDrcStatus' },
		handler: async () => {
			const enabled = await eda.pcb_Drc.getRealTimeDrcStatus()
			return { enabled: Boolean(enabled) }
		},
	},
	// ---------- 自动布线（FreeRouting 闭环）----------
	{
		name: 'pcb.setNetLock',
		summary: '锁定/解锁指定网络的全部走线、过孔、圆弧（0.10.0 起）。⚠️ 自动布线前必用：pcb.autoRouteStart 回灌结果时会清掉所有【未锁定】的走线/过孔——电源等手工布好的网络必须先锁定',
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
		summary: '【宏】启动 FreeRouting 自动布线（0.10.0 起；需本地 FreeRouting 服务运行：bridge/start-freerouting.bat 或官方脚本，端口 37864）。流程：导出 DSN → 创建会话 → 上传 → 启动。⚠️ 回灌会清除全部未锁定线段、圆弧与过孔：电源主路径必须先 pcb.setNetLock 锁定！启动后用 pcb.autoRouteStatus 轮询，完成自动回灌+DRC',
		params: [
			{ name: 'maxPasses', type: 'number', description: '最大布线轮数，默认 50' },
			{ name: 'viaCosts', type: 'number', description: '过孔成本权重（越高越少过孔），默认 50' },
			{ name: 'maxThreads', type: 'number', description: '并行线程数，默认 4' },
			{ name: 'skipDrc', type: 'boolean', description: '回灌后跳过自动 DRC，默认 false' },
		],
		returns: '{ jobId, state, note }',
		example: { cmd: 'pcb.autoRouteStart', params: { maxPasses: 50 } },
		handler: async (params) => {
			if (currentRouteJobId)
				throw new Error(`已有布线任务在进行（jobId=${currentRouteJobId}），先 autoRouteStatus 查进度或 autoRouteStop 停止`)
			// 健康检查
			try {
				await frRequest('GET', '/system/status')
			}
			catch {
				throw new Error('FreeRouting 服务未运行（http://127.0.0.1:37864）。请先启动 FreeRouting（V2.2.3+，无 GUI API 模式；可用官方启动脚本或 bridge/start-freerouting.bat）')
			}
			const dsnFile = await eda.pcb_ManufactureData.getDsnFile('design.dsn')
			if (!dsnFile)
				throw new Error('DSN 导出失败：请确认已激活 PCB 文档')
			const dsnBase64 = await blobToBase64(dsnFile)
			const session = await frRequest<{ id: string }>('POST', '/sessions/create')
			const job = await frRequest<{ id: string }>('POST', '/jobs/enqueue', { session_id: session.id, name: dsnFile.name.replace(/\.dsn$/i, ''), priority: 'NORMAL' })
			const settings: Record<string, unknown> = {
				max_passes: params.maxPasses != null ? Number(params.maxPasses) : 50,
				via_costs: params.viaCosts != null ? Number(params.viaCosts) : 50,
				max_threads: params.maxThreads != null ? Number(params.maxThreads) : 4,
				improvement_threshold: 0,
				trace_pull_tight_accuracy: 500,
				start_ripup_costs: 100,
				automatic_neckdown: true,
				allowed_via_types: true,
			}
			await frRequest('POST', `/jobs/${job.id}/settings`, settings)
			await frRequest('POST', `/jobs/${job.id}/input`, { filename: dsnFile.name, data: dsnBase64 })
			await frRequest('PUT', `/jobs/${job.id}/start`)
			currentRouteJobId = job.id
			routeSkipDrc = Boolean(params.skipDrc)
			return {
				jobId: job.id,
				state: 'RUNNING',
				note: '布线已启动；完成回灌会清除全部未锁定线段、圆弧与过孔。用 pcb.autoRouteStatus 轮询（完成会自动回灌结果并跑 DRC）；pcb.autoRouteStop 可随时停止',
			}
		},
	},
	{
		name: 'pcb.autoRouteStatus',
		summary: '查询自动布线进度；任务 COMPLETED 时自动回灌 SES 结果（清除全部未锁定线段、圆弧与过孔后导入）并可选自动 DRC，返回布线统计',
		params: [
			{ name: 'jobId', type: 'string', description: '任务 ID（留空取最近启动的任务）' },
			{ name: 'noImport', type: 'boolean', description: '完成时不自动回灌（只查状态），默认 false' },
		],
		returns: '{ state, stage, currentPass, statistics?, imported?, drc? }',
		example: { cmd: 'pcb.autoRouteStatus' },
		handler: async (params) => {
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
			}
			if (status.state !== 'COMPLETED' || params.noImport)
				return base
			const unresolvedJob = [...routeJobRecoveryState].find(([, state]) => state === 'recoveryRequired')
			if (unresolvedJob)
				throw new Error(`任务 ${unresolvedJob[0]} 的原文档恢复未确认；已拒绝新的清线或导入`, {
					cause: { partial: true, restored: false, retryable: false },
				})
			const routeState = routeJobRecoveryState.get(jobId)
			if (routeState === 'recoveryRequired')
				throw new Error(`任务 ${jobId} 的原文档恢复未确认；已拒绝再次清线或导入`, {
					cause: { partial: true, restored: false, retryable: false },
				})
			if (routeState === 'applying')
				throw new Error(`任务 ${jobId} 的回灌仍在执行，已拒绝重入`)
			if (routeState === 'applied' || consumedRouteJobs.has(jobId))
				return { ...base, imported: false, note: '该任务已成功回灌，不会重复清线或导入；如需重新布线请先 pcb.autoRouteStart' }
			// 同步占用完成任务，再开始任何可能挂起的输出或快照读取，防止并发查询双清线。
			routeJobRecoveryState.set(jobId, 'applying')
			let routeMayHaveWritten = false
			try {
			// 先验证输出格式，再枚举目标图元、落快照，之后才开始修改。
			const output = await frRequest<{ data: string, filename?: string }>('GET', `/jobs/${jobId}/output`)
			if (!output?.data)
				throw new Error('布线完成但结果为空')
			let bin: string
			try { bin = atob(output.data) }
			catch (error) { throw new Error(`布线输出不是有效 Base64 SES：${error instanceof Error ? error.message : String(error)}`) }
			if (!bin.trim() || !bin.includes('(session'))
				throw new Error('布线输出不是非空 SES session 文件')
			const u8 = new Uint8Array(bin.length)
			for (let i = 0; i < bin.length; i++)
				u8[i] = bin.charCodeAt(i)
			const sesFile = new File([u8], output.filename || 'autoroute.ses')

			const snapshot = await captureDocumentSnapshot('pcb.autoRouteStatus', 3)
			await assertSnapshotFocused(snapshot)
			const unlockedLines = await eda.pcb_PrimitiveLine.getAllPrimitiveId(undefined, undefined, false)
			if (!Array.isArray(unlockedLines))
				throw new Error('无法完整枚举未锁定走线，已拒绝清线')
			await assertSnapshotFocused(snapshot)
			const unlockedVias = await eda.pcb_PrimitiveVia.getAllPrimitiveId(undefined, false)
			if (!Array.isArray(unlockedVias))
				throw new Error('无法完整枚举未锁定过孔，已拒绝清线')
			await assertSnapshotFocused(snapshot)
			const unlockedArcs = await (eda.pcb_PrimitiveArc as any).getAllPrimitiveId(undefined, undefined, false)
			if (!Array.isArray(unlockedArcs))
				throw new Error('无法完整枚举未锁定圆弧，已拒绝清线')

			let cleared: { lines: number, vias: number, arcs: number }
			cleared = await withDocumentRecovery(snapshot, async (write) => {
				const markMayWrite = () => { routeMayHaveWritten = true }
				await write(() => eda.pcb_Document.startCalculatingRatline(), markMayWrite)
				if (unlockedLines.length && await write(() => eda.pcb_PrimitiveLine.delete(unlockedLines), markMayWrite) !== true)
					throw new Error('删除未锁定走线返回 false')
				if (unlockedArcs.length && await write(() => (eda.pcb_PrimitiveArc as any).delete(unlockedArcs), markMayWrite) !== true)
					throw new Error('删除未锁定圆弧返回 false')
				if (unlockedVias.length && await write(() => eda.pcb_PrimitiveVia.delete(unlockedVias), markMayWrite) !== true)
					throw new Error('删除未锁定过孔返回 false')
				const imported = await write(() => eda.pcb_Document.importAutoRouteSesFile(sesFile), markMayWrite)
				if (imported !== true)
					throw new Error('SES 导入返回 false')
				return { lines: unlockedLines.length, vias: unlockedVias.length, arcs: unlockedArcs.length }
			})
			routeJobRecoveryState.set(jobId, 'applied')
			consumedRouteJobs.add(jobId)
			if (currentRouteJobId === jobId)
				currentRouteJobId = undefined
			let drc: Record<string, unknown> | undefined
			if (!routeSkipDrc) {
				try {
					const errors = await eda.pcb_Drc.check(true, true, false)
					const groups = Array.isArray(errors) ? errors : []
					drc = { totalCount: groups.reduce((s: number, e: any) => s + (typeof e?.count === 'number' ? e.count : 1), 0), groups }
				}
				catch { /* DRC 失败不阻断 */ }
			}
			return {
				...base,
				imported: true,
				cleared,
				...(drc ? { drc } : {}),
			}
			}
			catch (error) {
				const cause = (error as any)?.cause
				if (cause?.partial === true && cause?.restored === false || (routeMayHaveWritten && cause?.restored !== true))
					routeJobRecoveryState.set(jobId, 'recoveryRequired')
				else
					routeJobRecoveryState.delete(jobId)
				throw error
			}
		},
	},
	{
		name: 'pcb.autoRouteStop',
		summary: '停止进行中的自动布线任务（保留当前已回灌的部分）',
		params: [
			{ name: 'jobId', type: 'string', description: '任务 ID（留空取最近启动的任务）' },
		],
		returns: '{ cancelled, jobId }',
		example: { cmd: 'pcb.autoRouteStop' },
		handler: async (params) => {
			const jobId = params.jobId ? String(params.jobId) : currentRouteJobId
			if (!jobId)
				throw new Error('没有进行中的布线任务')
			await frRequest('PUT', `/jobs/${jobId}/cancel`)
			if (jobId === currentRouteJobId)
				currentRouteJobId = undefined
			return { cancelled: true, jobId }
		},
	},
]
