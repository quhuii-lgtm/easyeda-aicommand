/**
 * 原理图类指令
 *
 * 注意：原理图坐标单位为 10mil
 */
import type { ICommandDef } from '../engine/types'
import { fileToResult } from './util'
import { beginTask, failTask, finishTask, taskProgress } from '../engine/tasks'
import { serializeErrorDetail } from '../engine/registry'
import { diag } from '../engine/diag'

/** 0.10.42：给无保护 await 加超时（官方偶发永不 resolve，曾致整批删除挂死 300s 无结果） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时（>${ms / 1000}s，官方无响应）`)), ms)),
	])
}

/** 防御性读取图元状态方法（不同图元类型支持的方法不同） */
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
 * 0.10.48（GPT KIMI-EDA-20261002-07 R2）：官方 create 拒绝（throw "create failed!" 等）时标注失败阶段。
 * 前缀 [阶段] 到 message，原始错误挂 cause，原始堆栈追加在包装堆栈之后——registry 统一回传 name+stack。
 */
function stageError(stage: string, err: unknown): Error {
	const orig = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
	const wrapped = new Error(`[${stage}] ${orig.message}`)
	wrapped.name = orig.name
	;(wrapped as any).cause = err
	;(wrapped as any).stage = stage
	if (orig.stack)
		wrapped.stack = `${wrapped.stack}\n--- 原始堆栈 ---\n${orig.stack}`
	return wrapped
}
async function withStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn()
	}
	catch (err) {
		throw stageError(stage, err)
	}
}

/**
 * 检查网络名是否已存在于当前图页（命名导线或网络标签）。
 * 智能命名用：同一网络只命名一次，其余段画无名，
 * 避免段合并后 NET 属性叠加产生"导线有多个网络名"警告（官方 modify 删不掉重复属性）。
 */
async function netExistsOnPage(net: string): Promise<boolean> {
	try {
		// 注意：getAll(net) 的过滤参数在运行时不可靠（实测返回空），
		// 必须全量取回后按 getState_Net() 手动过滤
		const wires = await eda.sch_PrimitiveWire.getAll()
		for (const w of wires ?? []) {
			if (safeState<string>(w, 'getState_Net') === net)
				return true
		}
	}
	catch {
		// 查询失败按不存在处理，退化为直接命名
	}
	try {
		const attrs = await eda.sch_PrimitiveAttribute.getAll()
		for (const a of attrs ?? []) {
			const key = safeState<string>(a, 'getState_Key') ?? ''
			if (key.includes('NET') && safeState<string>(a, 'getState_Value') === net)
				return true
		}
	}
	catch {
		// 同上
	}
	return false
}

/**
 * 把折点序列拆成简单两点段：去零长、去重（归一方向）、跳过非水平/垂直段。
 * 官方一次创建多分支折线会被拒（返回空），逐段创建则由官方自动合并相连段；
 * 斜线段多为官方折线数据里 T 形分支编码的伪段（端点必被正交段连通），安全跳过。
 */
function splitToSimpleSegments(pts: Array<[number, number]>): {
	segments: Array<[number, number, number, number]>
	skippedDiagonal: number
} {
	const seen = new Set<string>()
	const segments: Array<[number, number, number, number]> = []
	let skippedDiagonal = 0
	for (let i = 0; i + 1 < pts.length; i++) {
		const [x1, y1] = pts[i]
		const [x2, y2] = pts[i + 1]
		if (x1 === x2 && y1 === y2)
			continue
		if (x1 !== x2 && y1 !== y2) {
			skippedDiagonal += 1
			continue
		}
		const key = `${Math.min(x1, x2)},${Math.min(y1, y2)},${Math.max(x1, x2)},${Math.max(y1, y2)}`
		if (seen.has(key))
			continue
		seen.add(key)
		segments.push([x1, y1, x2, y2])
	}
	return { segments, skippedDiagonal }
}

/** 解析 "U1.5" 或 {designator, pin} 为引脚世界坐标（含器件锚点、引脚朝向和长度，用于短桩方向；noConnected 为 NC 未连接标识） */
async function resolvePinPoint(ref: string): Promise<{ x: number, y: number, compX: number, compY: number, designator: string, pin: string, rot: number, pinLen: number, noConnected: boolean }> {
	const m = /^([A-Za-z]+\d+)\.(.+)$/.exec(ref.trim())
	if (!m)
		throw new Error(`引脚引用格式错误："${ref}"（应为 "位号.引脚号"，如 U1.5）`)
	const [, designator, pin] = m
	const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
	const comp = comps.find(c => safeState<string>(c, 'getState_Designator') === designator)
	if (!comp)
		throw new Error(`找不到器件 ${designator}（用 schematic.listComponents 查位号）`)
	const primitiveId = safeState<string>(comp, 'getState_PrimitiveId')
	const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(primitiveId))
	const hit = (pins ?? []).find(p => String(p.getState_PinNumber?.()) === pin)
	if (!hit)
		throw new Error(`${designator} 没有引脚 ${pin}（用 schematic.listPins 查引脚号）`)
	return {
		x: hit.getState_X?.() ?? 0,
		y: hit.getState_Y?.() ?? 0,
		compX: safeState<number>(comp, 'getState_X') ?? 0,
		compY: safeState<number>(comp, 'getState_Y') ?? 0,
		designator,
		pin,
		rot: hit.getState_Rotation?.() ?? 0,
		pinLen: hit.getState_PinLength?.() ?? 10,
		noConnected: Boolean(hit.getState_NoConnected?.()),
	}
}

/** NC（未连接）引脚预检：官方禁止在 NC 引脚上接线（create 直接抛原始错误），提前给出中文提示 */
function assertPinConnectable(p: { designator: string, pin: string, noConnected: boolean }): void {
	if (p.noConnected)
		throw new Error(`引脚 ${p.designator}.${p.pin} 为 NC 未连接引脚，官方禁止接线。请改用有电气连接的引脚，或先在器件属性中取消该引脚的 NC 标识`)
}

/** 收集当前页全部器件引脚坐标（短桩防撞用） */
async function collectAllPinPoints(): Promise<Array<{ x: number, y: number }>> {
	const pts: Array<{ x: number, y: number }> = []
	const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
	for (const c of comps) {
		const id = safeState<string>(c, 'getState_PrimitiveId')
		if (!id)
			continue
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)
		for (const p of pins ?? []) {
			const x = p.getState_X?.()
			const y = p.getState_Y?.()
			if (x != null && y != null)
				pts.push({ x, y })
		}
	}
	return pts
}

/** 共线重叠检测（水平/垂直段） */
function segCollinearOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
	if (a[1] === a[3] && b[1] === b[3] && a[1] === b[1])
		return Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2])) < Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]))
	if (a[0] === a[2] && b[0] === b[2] && a[0] === b[0])
		return Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3])) < Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]))
	return false
}

/** 现有导线的全部正交段（错层/防撞查询用） */
async function collectWireSegs(): Promise<Array<[number, number, number, number]>> {
	const segs: Array<[number, number, number, number]> = []
	const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
	for (const w of wires) {
		const line = safeState<Array<number>>(w, 'getState_Line') ?? []
		for (let i = 0; i + 1 < line.length; i += 2) {
			const x2 = line[i + 2] ?? line[i]
			const y2 = line[i + 3] ?? line[i + 1]
			segs.push([line[i], line[i + 1], x2, y2])
		}
	}
	return segs
}

/** 查询某个坐标点已被哪些网络的导线占用（点在导线任意段上即算占用；无名导线记为 "(无名)"） */
async function findWireNetsAtPoint(x: number, y: number): Promise<Array<string>> {
	const nets = new Set<string>()
	const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
	for (const w of wires) {
		const line = safeState<Array<number>>(w, 'getState_Line') ?? []
		let hit = false
		for (let i = 0; i + 1 < line.length && !hit; i += 2) {
			const x1 = line[i]
			const y1 = line[i + 1]
			const x2 = line[i + 2] ?? x1
			const y2 = line[i + 3] ?? y1
			if (x1 === x2 && x === x1 && y >= Math.min(y1, y2) && y <= Math.max(y1, y2))
				hit = true
			else if (y1 === y2 && y === y1 && x >= Math.min(x1, x2) && x <= Math.max(x1, x2))
				hit = true
		}
	if (hit)
			nets.add(safeState<string>(w, 'getState_Net') || '(无名)')
	}
	return [...nets]
}

/**
 * 网表 JSON 里取器件位号：实测官方 getNetlistFile 导出的 components 以 "gge1" 这类 uuid 为键，
 * 位号在 c.props.Designator（不在顶层 designator）——0.10.9 之前三处审计都取错键导致 "gge1.1" 式 key 全对不上。
 */
function netlistRefOf(c: any, key: string): string {
	return String(c?.designator ?? c?.props?.Designator ?? c?.props?.designator ?? c?.refDes ?? c?.name ?? key)
}

/** 网表 pinInfoMap 的引脚号：键一般是引脚号字符串，稳妥起见优先取条目内 number 字段 */
function netlistPinOf(pinKey: string, info: any): string {
	return String(info?.number ?? info?.pin ?? pinKey)
}

/** 点到线段距离（0.10.26：labelWire 短桩全程避引脚用——0.10.24 终验实锤只查端点会让短桩横穿第三方引脚中段） */
function pointToSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1
	const dy = y2 - y1
	if (dx === 0 && dy === 0)
		return Math.hypot(px - x1, py - y1)
	const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 导出当前页「位号.引脚号 → 网络名」映射（0.10.19 autoLayout 用，与 batchWire 审计同款逻辑）：
 * 位号键在 c.props.Designator，引脚号优先 pinInfoMap 条目 number 字段。失败返回 undefined。
 */
async function exportSchematicPinNetMap(): Promise<Map<string, string> | undefined> {
	try {
		const file = await eda.sch_ManufactureData.getNetlistFile()
		if (!file)
			return undefined
		const data = JSON.parse(await (file as File).text())
		const comps = data.components ?? {}
		const entries: Array<[string, any]> = Array.isArray(comps)
			? comps.map((c: any) => [c?.uuid ?? c?.id ?? '?', c])
			: Object.entries(comps)
		const map = new Map<string, string>()
		for (const [key, c] of entries) {
			const ref = netlistRefOf(c, key)
			const pim = c?.pinInfoMap ?? c?.pins ?? {}
			const pe: Array<[string, any]> = Array.isArray(pim)
				? pim.map((p: any, idx: number) => [String(p?.pin ?? idx), p])
				: Object.entries(pim)
			for (const [pin, info] of pe) {
				const n = info?.net ?? info?.netName
				if (n)
					map.set(`${ref}.${netlistPinOf(pin, info)}`, String(n))
			}
		}
		return map
	}
	catch {
		return undefined
	}
}

/**
 * 文本网表（PADS 格式）解析「位号.引脚号 → 网络名」映射（0.10.45，GPT KIMI-EDA-20261002-05）：
 * PADS 文本结构为 `*SIGNAL* <网名>` 行后跟 `R1.1 R2.1` 成员行——实测 4.1.60 可用。
 * 官方 sch_Netlist.getNetlist 在 JLCEDA/EasyEDA 格式上有宿主级缺陷（JLCEDA 挂起>120s / EasyEDA 返空，
 * 你方现场 JLCEDA 报 "i is not iterable"），故回退路径只用已实测可用的格式。
 */
async function pinNetMapFromPadsText(): Promise<Map<string, string> | undefined> {
	try {
		const text = await withTimeout(eda.sch_Netlist.getNetlist('PADS' as any), 45000, 'getNetlist(PADS)')
		if (typeof text !== 'string' || !text.includes('*SIGNAL*'))
			return undefined
		const map = new Map<string, string>()
		let net: string | undefined
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim()
			const sig = /^\*SIGNAL\*\s+(.+)$/.exec(line)
			if (sig) {
				net = sig[1].trim()
				continue
			}
			if (!net || line.startsWith('*') || !line)
				continue
			for (const token of line.split(/\s+/)) {
				const m = /^(.+?)\.(\d+)$/.exec(token)
				if (m)
					map.set(`${m[1]}.${m[2]}`, net)
			}
		}
		return map.size ? map : undefined
	}
	catch {
		return undefined
	}
}

/**
 * 带回退的「位号.引脚号 → 网络名」映射（0.10.45）：
 * 首选 getNetlistFile（JSON，信息最全），官方返空/抛错（如器件缺封装——04 实测因果）时
 * 回退 sch_Netlist.getNetlist('PADS') 文本解析（官方 @deprecated 但可用、与前者独立实现）。
 * 两条都失败才返回 undefined。batchWire 终审 / repairNet / autoLayout 共用，保证缺封装工程上
 * 接线工具的占用预检与最终审计仍有已验证的网表读取路径（GPT -05 诉求）。
 */
async function pinNetMapRobust(): Promise<Map<string, string> | undefined> {
	return await exportSchematicPinNetMap() ?? await pinNetMapFromPadsText()
}

/** 电源网基名（buildBlock/autoLayout 共享）：0.10.18 起允许全大写后缀（VDD_T/VOUT_5V），小写后缀视为信号不误判 */
const POWER_BASE_RE = /^(GND|AGND|DGND|PGND|VCC|VDD|VDDIO|VIN|VOUT|3V3|3\.3V|5V|12V|24V|VBAT|VBUS)$/i
function isPowerNetName(name: string): boolean {
	return POWER_BASE_RE.test(String(name).replace(/(_[A-Z0-9]+)+$/, ''))
}

/**
 * 通用源码扫描（0.10.17 fixNetLabels 用）：枚举全部网络标签类 ATTR（key 为 NET/Name/_NETLABEL_），
 * 附旋转角度与归属（parentId：导线 ID 或 $$root 浮空），并解析 LINE 记录给出所属导线几何（源码坐标系，Y 与 API 相反）。
 * ⚠️ 探针实锤：镜像标志 isMirror 只存在于 COMPONENT 记录，ATTR（标签）记录里没有 mirror 字段——
 * 标签"镜像反字"在源码里只能以 rotation 异常（90/180/270）形式观察到。
 */
async function scanNetLabelAttrsFromSource(): Promise<{
	labels: Array<{ primitiveId: string, net: string, x?: number, y?: number, rotation?: number, parentId?: string }>
	wireLines: Map<string, Array<[number, number, number, number]>>
}> {
	const source = await eda.sys_FileManager.getDocumentSource()
	if (!source)
		throw new Error('读取文档源码失败（请确认有原理图页处于激活状态）')
	const labels: Array<{ primitiveId: string, net: string, x?: number, y?: number, rotation?: number, parentId?: string }> = []
	const wireLines = new Map<string, Array<[number, number, number, number]>>()
	const tokens = String(source).split(/[|\n]+/)
	let pendingAttrId: string | undefined
	for (const tok of tokens) {
		if (!tok.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(tok)
		}
		catch {
			continue
		}
		if (rec.type === 'ATTR' && rec.id) {
			pendingAttrId = String(rec.id)
			continue
		}
		if (pendingAttrId && /^(NET|Name|_NETLABEL_)$/i.test(String(rec.key ?? ''))) {
			labels.push({
				primitiveId: pendingAttrId,
				net: String(rec.value ?? ''),
				x: typeof rec.x === 'number' ? rec.x : undefined,
				y: typeof rec.y === 'number' ? rec.y : undefined,
				rotation: typeof rec.rotation === 'number' ? rec.rotation : undefined,
				parentId: rec.parentId != null ? String(rec.parentId) : undefined,
			})
		}
		pendingAttrId = undefined
		// 导线几何在独立 LINE 记录里（lineGroup = 导线 ID，源码坐标）
		if (rec.type === undefined && typeof rec.startX === 'number' && rec.lineGroup) {
			const g = String(rec.lineGroup)
			const arr = wireLines.get(g) ?? []
			arr.push([Number(rec.startX), Number(rec.startY), Number(rec.endX), Number(rec.endY)])
			wireLines.set(g, arr)
		}
	}
	return { labels, wireLines }
}

/**
 * 枚举浮空网络标签（官方 sch_PrimitiveAttribute.getAll 不枚举 parentId=$$root 的浮空标签，API 盲区）。
 * 绕行：读文档源码（sys_FileManager.getDocumentSource），解析 ATTR 记录中 key=_NETLABEL_ 且 parentId=$$root 的项。
 */
async function scanFloatingNetLabels(): Promise<Array<{ primitiveId: string, net: string, x?: number, y?: number }>> {
	const source = await eda.sys_FileManager.getDocumentSource()
	if (!source)
		throw new Error('读取文档源码失败（请确认有原理图页处于激活状态）')
	const out: Array<{ primitiveId: string, net: string, x?: number, y?: number }> = []
	// 源码是按 | 分隔的 JSON 片段流，ATTR 记录为 {head}||{body} 两段
	const tokens = String(source).split(/[|\n]+/)
	let pendingAttrId: string | undefined
	for (const tok of tokens) {
		if (!tok.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(tok)
		}
		catch {
			continue
		}
		if (rec.type === 'ATTR' && rec.id) {
			pendingAttrId = String(rec.id)
			continue
		}
		if (pendingAttrId && rec.key === '_NETLABEL_' && rec.parentId === '$$root') {
			out.push({
				primitiveId: pendingAttrId,
				net: String(rec.value ?? ''),
				x: typeof rec.x === 'number' ? rec.x : undefined,
				y: typeof rec.y === 'number' ? rec.y : undefined,
			})
		}
		pendingAttrId = undefined
	}
	return out
}

/**
 * 收集全部网络标签（附着 + 浮空）——listNetLabels 与 structuralAudit 共用。
 * 0.10.60 从 listNetLabels handler 原样抽出，行为不变。
 */
async function collectNetLabels(netFilter?: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = []
	const seen = new Set<string>()
	// ① 附着标签：逐导线取属性（getAll(parentId) 按父图元过滤是可靠的，与 getAll(net) 不同）
	const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
	for (const w of wires) {
		const wireId = safeState<string>(w, 'getState_PrimitiveId')
		if (!wireId)
			continue
		let attrs: Array<any> = []
		try {
			attrs = (await eda.sch_PrimitiveAttribute.getAll(wireId)) ?? []
		}
		catch {
			continue
		}
		for (const a of attrs) {
			const key = safeState<string>(a, 'getState_Key') ?? ''
			if (!/^(NET|Name)$/i.test(key))
				continue
			const value = safeState<string>(a, 'getState_Value') ?? ''
			if (!value || (netFilter && value !== netFilter))
				continue
			const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
			seen.add(id)
			out.push({
				primitiveId: id,
				net: value,
				x: safeState<number>(a, 'getState_X'),
				y: safeState<number>(a, 'getState_Y'),
				color: safeState<string>(a, 'getState_Color'),
				rotation: safeState<number>(a, 'getState_Rotation'),
				mirror: safeState<boolean>(a, 'getState_Mirror'),
				attached: true,
				wireId,
			})
		}
	}
	// ② 浮空标签：官方 getAll 不枚举 parentId=$$root 的属性（盲区），走文档源码扫描
	try {
		const floats = await scanFloatingNetLabels()
		for (const f of floats) {
			if (!f.net || (netFilter && f.net !== netFilter) || seen.has(f.primitiveId))
				continue
			out.push({
				primitiveId: f.primitiveId,
				net: f.net,
				x: f.x,
				y: f.y,
				color: undefined,
				attached: false,
			})
		}
	}
	catch {
		// 文档源码读取失败不阻断，附着列表已返回
	}
	return out
}

import { runStructuralAudit } from './schematicAuditEngine'
import type { IAuditWire, IAuditLabel, IAuditComp, IAuditCompPins, IAuditRect } from './schematicAuditEngine'

/**
 * 从文档源码原文中切除指定浮空 ATTR 记录（{type:ATTR,id}头段 + 紧随的 _NETLABEL_ 体段）。
 * 字节级手术：只删除命中段的原文区间（连同其前驱分隔符），其余字节原样保留——
 * 不做 split+rejoin 重组，避免分隔符归一化导致 setDocumentSource 判格式错误拒写（0.10.9 教训）。
 */
function stripFloatingAttrsFromSource(source: string, ids: Set<string>): { text: string, removed: number } {
	const isSep = (ch: string) => ch === '|' || ch === '\n' || ch === '\r'
	// 切分段，记录每段区间（含前驱分隔符起点）
	const parts: Array<{ sepStart: number, start: number, end: number, text: string }> = []
	let i = 0
	const n = source.length
	while (i < n) {
		const sepStart = i
		while (i < n && isSep(source[i]))
			i++
		const start = i
		while (i < n && !isSep(source[i]))
			i++
		if (i > start)
			parts.push({ sepStart, start, end: i, text: source.slice(start, i) })
	}
	// 命中段删除区间：[前驱分隔符起点, 段尾)；首段无前驱分隔符时吃后续分隔符
	const ranges: Array<[number, number]> = []
	for (let k = 0; k < parts.length; k++) {
		const t = parts[k].text
		if (!t.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(t)
		}
		catch {
			continue
		}
		if (rec.type !== 'ATTR' || !ids.has(String(rec.id ?? '')))
			continue
		// 体段必须是紧随其后的 _NETLABEL_ / parentId=$$root 记录，确认后才切除（防误删）
		const next = k + 1 < parts.length ? parts[k + 1].text : ''
		let body: any
		try {
			body = next.startsWith('{') ? JSON.parse(next) : undefined
		}
		catch {
			body = undefined
		}
		if (body && body.key === '_NETLABEL_' && body.parentId === '$$root') {
			for (const idx of [k, k + 1]) {
				const p = parts[idx]
				// 首段（sepStart===0 即源从头开始）没有前驱分隔符可吃，改为吃后续分隔符
				if (p.sepStart === 0 && p.start === 0) {
					let e = p.end
					while (e < n && isSep(source[e]))
						e++
					ranges.push([0, e])
				}
				else
					ranges.push([p.sepStart, p.end])
			}
		}
	}
	if (!ranges.length)
		return { text: source, removed: 0 }
	ranges.sort((a, b) => a[0] - b[0])
	let text = ''
	let cursor = 0
	for (const [s, e] of ranges) {
		if (s < cursor)
			continue
		text += source.slice(cursor, s)
		cursor = e
	}
	text += source.slice(cursor)
	return { text, removed: ranges.length / 2 }
}

/**
 * 删除浮空标签（parentId=$$root 的官方枚举盲区图元）。
 * 官方实锤（pro-api-types 类型注释）：属性图元不支持删除——
 * SCH_PrimitiveAttribute.delete 标注 @internal「属性图元不支持删除，本接口调用将不会有任何效果」，
 * ISCH_PrimitiveAttribute 实例上根本没有 delete 方法。故通道①②只是无害兜底，诊断里注明官方实锤。
 * 0.10.11 顺序调整（0.10.10 事故：通道③源码改写被官方运行时校验判"数据格式不对"弹窗拒绝，工程靠未保存幸免）：
 *  主通道 ④ 借尸还魂：建临时短导线 → modify 改浮标 parentId 挂上去 → 删导线级联带走 → 源码重扫读回验证；
 *          任一步失败回滚临时导线并如实报 diagnostics；删导线后【必须】以源码重扫为准（画布显示可能滞后）。
 *  末通道 ③ 文档源码改写【默认禁用】：仅显式 allowSourceRewrite:true 才执行（最后手段，执行时带醒目 warning）。
 * 每通道后都用文档源码读回判定，返回真实 deleted / failed / 逐通道诊断。
 */
async function deleteFloatingLabels(ids: Array<string>, opts?: { allowSourceRewrite?: boolean, batchSize?: number }): Promise<{ deleted: Array<string>, failed: Array<string>, method?: string, diagnostics?: Array<string>, warning?: string, batches?: Array<{ batch: number, attempted: number, deleted: number, failed: number }>, unprocessed?: Array<string> }> {
	const alive = async (): Promise<Set<string>> => new Set((await scanFloatingNetLabels()).map(f => String(f.primitiveId)))
	const diagnostics: Array<string> = []
	let remaining = await alive()
	let method: string | undefined
	// 通道①：实例 delete()（官方实例无此方法，仅兜底；get 对盲区 ID 也可能返回空）
	const ch1 = ids.filter(id => remaining.has(id))
	if (ch1.length) {
		let got = 0
		for (const id of ch1) {
			try {
				const attr = await eda.sch_PrimitiveAttribute.get(id)
				if (attr) {
					got++
					if (typeof (attr as any).delete === 'function')
						await (attr as any).delete()
				}
			}
			catch { /* 单个失败交给下一通道 */ }
		}
		remaining = await alive()
		diagnostics.push(`通道①实例delete: get命中${got}/${ch1.length}（官方标注属性图元不支持删除，预期无效）`)
		if (!ids.some(id => remaining.has(id)))
			method = 'instanceDelete'
	}
	// 通道②：类级 delete（官方 @internal 注释明确"不会有任何效果"，兜底再试一次）
	const ch2 = ids.filter(id => remaining.has(id))
	if (ch2.length) {
		try {
			const r = await (eda.sch_PrimitiveAttribute as any).delete(ch2)
			diagnostics.push(`通道②类级delete: 返回 ${JSON.stringify(r)}（官方注释：属性图元不支持删除，调用无任何效果）`)
		}
		catch (e: any) {
			diagnostics.push(`通道②类级delete: 抛错 ${String(e?.message ?? e)}`)
		}
		remaining = await alive()
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'classDelete'
	}
	// 通道④（主通道）：借尸还魂——建临时短导线 → modify 改 parentId 挂上去 → 删导线级联带走 → 源码重扫验证
	// 0.10.12 加固（0.10.11 实测：真删 8 个后第 9 个起指令整体超时、会话创建类 API 全线失效，且超时丢 diagnostics）：
	//  ① 每条包 8s 超时熔断，单条超时标记 failed 立即跳下一条，不拖死整指令；
	//  ② 连续 3 条失败熔断整批（会话多半已损坏），返回明确提示不保存重开；
	//  ③ 分批执行（batchSize 默认 5，批间停 300ms），返回分批进度，大批浮标可多次调用；
	//  ④ 全局时间预算：临近扩展侧指令超时即停止开新条，累积结果照常返回（部分结果不丢）；
	//  ⑤ 回滚顺序修正：删临时导线失败先把浮标 parentId 改回 $$root 还原，再重试删导线，
	//     避免留下"持属性无名导线"孤儿（0.10.11 实测遗留 67cd6f589fe4410b 删不掉）。
	// 0.10.13 修正（0.10.12 终验发现）：
	//  ⑥ 成败判定一律以【每条走完后源码重扫读回】为准，不再信 modify/delete 返回值——
	//     官方 modify parentId 有"返回 falsy 但实际生效"的假失败行为（0.10.12 实测 4/4 报"被拒"，
	//     读回却已删 3 个），误报 failed 还会误触发熔断；读回显示已删即记成功、不计连续失败。
	//  ⑦ 回滚删临时导线若也失败，diagnostics 明确记录导线 ID+坐标（不再静默吞掉）。
	//  ⑧ 浮标缺坐标时不往 (0,0) 画线，直接 failed 注明"源码未解析到坐标"。
	const PER_ITEM_TIMEOUT_MS = 8000
	const MAX_CONSECUTIVE_FAILS = 3
	const GLOBAL_BUDGET_MS = 100000 // 扩展侧该指令超时已放宽到 140s，留 40s 余量给收尾与传输
	const batchSize = Math.max(1, Number(opts?.batchSize) || 5)
	const startedAt = Date.now()
	const batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> = []
	const attempted = new Set<string>()
	const ch4 = ids.filter(id => remaining.has(id))
	if (ch4.length) {
		const floats = await scanFloatingNetLabels()
		let consecutiveFails = 0
		let circuitBroken = false
		let budgetExhausted = false
		// 单条源码重扫：该浮标是否还浮着（每条成败的唯一判定依据，不信任何接口返回值——官方假失败前科）
		const stillFloats = async (id: string): Promise<boolean> =>
			(await scanFloatingNetLabels()).some(f => String(f.primitiveId) === id)
		// 单条借尸还魂流程（尽力而为，报错不直接定生死，由走完后的源码重扫判定）
		const reborrowOne = async (id: string): Promise<void> => {
			const f = floats.find(fl => String(fl.primitiveId) === id)
			if (!f)
				throw new Error('源码扫描中找不到该浮标（可能已被前序步骤删除）')
			// 缺坐标兜底：不往 (0,0) 画临时导线
			if (f.x == null || f.y == null)
				throw new Error('源码未解析到坐标，无法定位画临时导线')
			// 浮标坐标是源码坐标系（Y 轴与 API 相反），临时导线画在其 API 等价位置
			const ax = f.x
			const ay = -f.y
			let tmpWireId: string | undefined
			const wire = await eda.sch_PrimitiveWire.create([ax, ay, ax + 20, ay])
			tmpWireId = wire ? safeState<string>(wire, 'getState_PrimitiveId') : undefined
			if (!tmpWireId)
				throw new Error('临时导线 create 返回空（会话创建功能可能已损坏）')
			try {
				// ⚠️ 官方假失败前科：modify 可能返回 falsy 但实际已生效（0.10.12 实测 4/4"被拒"读回却已删），
				// 故此处不再因 falsy 抛错回滚——继续删导线，最终生死由走完后源码重扫判定
				const mod = await eda.sch_PrimitiveAttribute.modify(id, { parentId: tmpWireId } as any)
				if (!mod)
					diagnostics.push(`通道④借尸还魂: modify parentId 返回 falsy（${id}），按假失败处理继续删线，以源码重扫为准`)
				// 删临时导线，期望属性级联删除；画布显示可能滞后，成败以删后源码重扫为准
				await eda.sch_PrimitiveWire.delete([tmpWireId])
				tmpWireId = undefined // 已成功删除，无需回滚
			}
			finally {
				if (tmpWireId) {
					// 回滚顺序修正：先把浮标 parentId 改回 $$root 还原（避免"持属性的无名导线"删不掉），再删临时导线
					try { await eda.sch_PrimitiveAttribute.modify(id, { parentId: '$$root' } as any) }
					catch { /* 忽略 */ }
					try {
						await eda.sch_PrimitiveWire.delete([tmpWireId])
					}
					catch (e: any) {
						// 回滚删线也失败：明确记录，不再静默吞掉（可能留下持属性孤儿线，需手动框选删除）
						diagnostics.push(`通道④借尸还魂: ⚠️ 回滚删临时导线也失败（导线ID ${tmpWireId}，坐标 [${ax},${ay}]-[${ax + 20},${ay}]，${id}）：${String(e?.message ?? e)}——该线可能已持属性删不掉，请在 EDA 里按坐标手动框选删除`)
					}
				}
			}
		}
		for (let bi = 0; bi < ch4.length; bi += batchSize) {
			if (circuitBroken || budgetExhausted)
				break
			if (bi > 0)
				await new Promise(resolve => setTimeout(resolve, 300)) // 批间停顿，给官方编辑器喘息
			const batch = ch4.slice(bi, bi + batchSize)
			let bDeleted = 0
			let bFailed = 0
			for (const id of batch) {
				if (circuitBroken)
					break
				if (Date.now() - startedAt > GLOBAL_BUDGET_MS) {
					budgetExhausted = true
					diagnostics.push(`通道④借尸还魂: 全局时间预算耗尽（>${GLOBAL_BUDGET_MS / 1000}s），停止开新条，已累积结果照常返回；剩余浮标请再次调用本指令`)
					break
				}
				attempted.add(id)
				let itemError: string | undefined
				try {
					await Promise.race([
						reborrowOne(id),
						new Promise((_, reject) => setTimeout(() => reject(new Error(`单条超时（>${PER_ITEM_TIMEOUT_MS / 1000}s，疑似官方弹模态框或卡绘制模式）`)), PER_ITEM_TIMEOUT_MS)),
					])
				}
				catch (e: any) {
					itemError = String(e?.message ?? e)
				}
				// 成败唯一判定：每条走完后源码重扫读回（官方 modify/delete 返回值不可信——假失败前科）
				let gone = false
				try {
					gone = !(await stillFloats(id))
				}
				catch {
					gone = false
				}
				if (gone) {
					consecutiveFails = 0 // 读回已删即成功，不计入连续失败（防熔断误触发）
					bDeleted++
					if (itemError)
						diagnostics.push(`通道④借尸还魂: 接口报错「${itemError}」但源码重扫确认已删除（${id}）——官方假失败，记成功`)
				}
				else {
					bFailed++
					consecutiveFails++
					diagnostics.push(`通道④借尸还魂: 失败 ${itemError ? `${itemError}，` : ''}源码重扫确认仍在（${id}），已按序回滚（先还原 parentId 再删临时导线）`)
					if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
						circuitBroken = true
						diagnostics.push(`通道④借尸还魂: ⚠️ 连续 ${MAX_CONSECUTIVE_FAILS} 条失败（均以源码重扫确认为准），熔断整批——会话创建功能可能已损坏（0.10.11 实测超时后创建类 API 全线失效且不自愈），建议【不保存重开页面】后再分批重试`)
					}
				}
			}
			batches.push({ batch: batches.length + 1, attempted: batch.length, deleted: bDeleted, failed: bFailed })
		}
		remaining = await alive()
		diagnostics.push(`通道④借尸还魂: 源码重扫读回剩余 ${ids.filter(id => remaining.has(id)).length}/${ch4.length}`)
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'reparentThenDeleteWire'
	}
	// 通道③（⚠️ 默认禁用，最后手段）：文档源码改写——0.10.10 实机事故：离线字节级切除验证正确，
	// 但官方对 setDocumentSource 写回有运行时格式校验，写回被判"数据格式不对"弹窗拒绝（离线验证通过 ≠ 运行时安全）。
	// 仅显式 allowSourceRewrite:true 才执行，且操作前必须确保工程已保存。
	const allowSourceRewrite = Boolean(opts?.allowSourceRewrite)
	const ch3 = ids.filter(id => remaining.has(id))
	let warning: string | undefined
	if (ch3.length && !allowSourceRewrite)
		diagnostics.push(`通道③源码改写: 已跳过（默认禁用；0.10.10 曾被官方运行时判"数据格式不对"，确需执行请显式传 allowSourceRewrite:true 并确保工程已保存）`)
	if (ch3.length && allowSourceRewrite) {
		warning = '⚠️ 源码改写曾被官方运行时校验判"数据格式不对"（0.10.10 实机事故），属最后手段——操作前请确保工程已保存，随时做好不保存关页丢弃的准备'
		try {
			const source = await eda.sys_FileManager.getDocumentSource()
			if (source) {
				const { text, removed } = stripFloatingAttrsFromSource(String(source), new Set(ch3))
				if (removed > 0) {
					const writeBack = await eda.sys_FileManager.setDocumentSource(text)
					diagnostics.push(`通道③源码改写(显式允许): 切除${removed}条记录，setDocumentSource 返回 ${JSON.stringify(writeBack)}`)
				}
				else
					diagnostics.push('通道③源码改写(显式允许): 源码中未匹配到目标 ATTR 记录（0 切除）')
			}
			else
				diagnostics.push('通道③源码改写(显式允许): getDocumentSource 返回空')
		}
		catch (e: any) {
			diagnostics.push(`通道③源码改写(显式允许): 抛错 ${String(e?.message ?? e)}`)
		}
		remaining = await alive()
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'documentSourceRewrite'
	}
	const deleted = ids.filter(id => !remaining.has(id))
	const failed = ids.filter(id => remaining.has(id))
	// 分批熔断/时间预算提前退出时，未轮到的浮标单独列出（仍在 failed 中），方便再次调用接着删
	const unprocessed = ids.filter(id => remaining.has(id) && !attempted.has(id))
	return { deleted, failed, method, diagnostics, warning, ...(batches.length ? { batches } : {}), ...(unprocessed.length ? { unprocessed } : {}) }
}

/**
 * 估算网络标签文字宽度（0.10.18 首版，0.10.21 三样本再标定）：默认字体下 ≈ 4.4 单位/字符 + 5 单位边距。
 * 标定样本（exportPng 像素测量，1.955px/单位）：GND(3)=17.4、STATUS_LED(10)=46、USART2_RTS(9)=47.1——
 * 数字/下划线比字母略宽，4.1 系数对混合长网名低估 ~5 单位，故提到 4.4（宁高估：桩长/越位都留得起余量）。
 * 用途：① labelWire 桩长自适应（桩长=max(20, width+14)）；② fixNetLabels 导线越位几何测量（文字右缘=锚点+width）。
 * ⚠️ 0.10.20 实锤：附着看锚点不看右缘，【不要】再用它做锚点偏移放置（0.10.18 偏移策略电气不成立已回滚）。
 * ⚠️ 用户改过 fontSize 会失准；非 ASCII 字符按 2 个字符宽估。
 */
function estimateLabelWidth(net: string): number {
	let units = 0
	for (const ch of String(net))
		units += ch.charCodeAt(0) > 127 ? 2 : 1
	return Math.ceil(4.4 * units + 5)
}

/**
 * 设置网络标签文字方向（0.10.16）：官方 createNetLabel(x, y, net) 无方向参数（标签默认锚点在左、文字向右伸展），
 * 但 sch_PrimitiveAttribute.modify(id, { rotation }) 支持旋转（pro-api-types 实锤），getState_Rotation 可读回。
 * ⚠️ 官方 modify 有假失败前科（返回 falsy 但实际生效）——成败一律以读回 rotation 为准，不信返回值。
 * ⚠️ 0.10.18 修复假成功：rotation=0 时原来直接返回 0 什么都没改（fixNetLabels 原地转正因此假成功）——
 *    现在 0 也走 modify + 读回验证。另：rotation 180 = 上下颠倒反字（装机目测实锤），正常标签一律 rotation 0。
 * 返回实际读回的旋转值；读回不匹配返回 undefined。
 */
async function applyLabelRotation(labelId: string, rotation: number): Promise<number | undefined> {
	if (!labelId)
		return undefined
	try {
		await eda.sch_PrimitiveAttribute.modify(labelId, { rotation } as any)
	}
	catch { /* 假失败不轻信，读回为准 */ }
	try {
		const back = await eda.sch_PrimitiveAttribute.get(labelId)
		const actual = back ? safeState<number>(back, 'getState_Rotation') : undefined
		if (actual != null && Math.abs(((actual - rotation) % 360 + 360) % 360) < 0.5)
			return actual
		return undefined // 读回不符：判失败（假失败防御）
	}
	catch {
		return undefined
	}
}

/**
 * 官方 createNetLabel 偶发"返回空但实际已创建"（假失败）：微偏重试前必须先确认锚点处是否已有该网名标签。
 * 0.10.10 根因修复（双标签真正源头）：
 *  - 附着检查【不能】按导线 getState_Net 预过滤——假失败标签已挂上导线，但导线网络名传播是异步的，
 *    创建后立刻查导线还没改名 → 预过滤把目标导线整根跳过 → 误判没创建 → ±2 重试画出第二个浮标。
 *    改为枚举全部导线的 NET/Name 属性，按属性值+坐标匹配（属性随创建即时可查）。
 *  - 假失败标签的可枚举性也有延迟，找不到时等 300ms 再查，共 3 轮。
 *  - 浮空比对保留 Y 符号翻转：文档源码 Y 轴与 API 相反（API y=-600 ↔ 源码 y=+600）。
 */
async function findGhostNetLabel(net: string, x: number, y: number): Promise<{ id: string, attached: boolean } | undefined> {
	for (let pass = 0; pass < 3; pass++) {
		if (pass > 0)
			await new Promise(resolve => setTimeout(resolve, 300))
		// ① 已附着标签：枚举全部导线的属性，按属性值+坐标匹配（不按导线网名预过滤，防异步传播竞态）
		try {
			const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
			for (const w of wires) {
				const wireId = safeState<string>(w, 'getState_PrimitiveId')
				if (!wireId)
					continue
				const attrs = (await eda.sch_PrimitiveAttribute.getAll(wireId).catch(() => [])) ?? []
				for (const a of attrs) {
					const key = safeState<string>(a, 'getState_Key') ?? ''
					if (!/^(NET|Name)$/i.test(key) || safeState<string>(a, 'getState_Value') !== net)
						continue
					const ax = safeState<number>(a, 'getState_X')
					const ay = safeState<number>(a, 'getState_Y')
					const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
					if (ax == null || ay == null || (Math.abs(ax - x) <= 3 && Math.abs(ay - y) <= 3))
						return { id, attached: true }
				}
			}
		}
		catch { /* 忽略 */ }
		// ② 浮空标签：文档源码扫描（源码 Y 轴与 API 相反，比对时翻转）
		try {
			const floats = await scanFloatingNetLabels()
			const hit = floats.find(f =>
				f.net === net
				&& Math.abs((f.x ?? 1e9) - x) <= 3
				&& Math.abs((f.y ?? 1e9) + y) <= 3)
			if (hit)
				return { id: hit.primitiveId, attached: false }
		}
		catch {
			return undefined
		}
	}
	return undefined
}

export const schematicCommands: Array<ICommandDef> = [
	{
		name: 'schematic.listRects',
		summary: '列出当前图页全部矩形（功能区块框）——确认分区大小、排查重叠用。⚠️ 坐标系 +Y 向上：官方"左上点"是世界坐标 (minX, maxY)，即 y 是矩形上沿；返回的 span 是归一化的世界坐标包围盒（x1,y1 左下角 / x2,y2 右上角），布局计算一律用 span',
		params: [],
		returns: '[{ primitiveId, x, y, width, height, span: { x1, y1, x2, y2 }, color }]（x,y 为官方左上点原始值；span.y1=下沿=y-height，span.y2=上沿=y）',
		example: { cmd: 'schematic.listRects' },
		handler: async () => {
			const rects = await eda.sch_PrimitiveRectangle.getAll()
			return (rects ?? []).map(r => {
				const x = safeState<number>(r, 'getState_TopLeftX')
				const y = safeState<number>(r, 'getState_TopLeftY')
				const width = safeState<number>(r, 'getState_Width')
				const height = safeState<number>(r, 'getState_Height')
				return {
					primitiveId: safeState<string>(r, 'getState_PrimitiveId'),
					x, y, width, height,
					// +Y 向上：左上点 y 是上沿（最大值），下沿 = y - height
					span: (x != null && y != null && width != null && height != null)
						? { x1: x, y1: y - height, x2: x + width, y2: y }
						: undefined,
					color: safeState<string>(r, 'getState_Color'),
				}
			})
		},
	},
	{
		name: 'schematic.modifyRect',
		summary: '修改矩形（功能区块框）的位置/尺寸/样式',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '矩形图元 ID' },
			{ name: 'x', type: 'number', description: '左上角 X' },
			{ name: 'y', type: 'number', description: '左上角 Y（+Y 向上世界坐标，即矩形上沿，矩形向下延伸 height）' },
			{ name: 'width', type: 'number', description: '宽度' },
			{ name: 'height', type: 'number', description: '高度' },
			{ name: 'color', type: 'string', description: '边框颜色' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed' },
		],
		returns: '{ primitiveId, modified }',
		example: { cmd: 'schematic.modifyRect', params: { primitiveId: 'xxx', width: 450 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const property: Record<string, any> = {}
			if (params.x != null)
				property.topLeftX = Number(params.x)
			if (params.y != null)
				property.topLeftY = Number(params.y)
			if (params.width != null)
				property.width = Number(params.width)
			if (params.height != null)
				property.height = Number(params.height)
			if (params.color != null)
				property.color = String(params.color)
			if (params.lineType != null)
				property.lineType = (lineTypeMap[String(params.lineType)] ?? 0) as any
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（x / y / width / height / color / lineType）')
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——按类别拆步：位置 / 尺寸 / 样式
			const rectSteps: Array<{ props: Record<string, any>, checks: Array<[string, string, number]> }> = []
			const posProps: Record<string, any> = {}
			const posChecks: Array<[string, string, number]> = []
			if (property.topLeftX != null) {
				posProps.topLeftX = property.topLeftX
				posChecks.push(['x', 'getState_TopLeftX', property.topLeftX])
			}
			if (property.topLeftY != null) {
				posProps.topLeftY = property.topLeftY
				posChecks.push(['y', 'getState_TopLeftY', property.topLeftY])
			}
			if (Object.keys(posProps).length)
				rectSteps.push({ props: posProps, checks: posChecks })
			const sizeProps: Record<string, any> = {}
			const sizeChecks: Array<[string, string, number]> = []
			if (property.width != null) {
				sizeProps.width = property.width
				sizeChecks.push(['width', 'getState_Width', property.width])
			}
			if (property.height != null) {
				sizeProps.height = property.height
				sizeChecks.push(['height', 'getState_Height', property.height])
			}
			if (Object.keys(sizeProps).length)
				rectSteps.push({ props: sizeProps, checks: sizeChecks })
			const styleProps: Record<string, any> = {}
			if (property.color != null)
				styleProps.color = property.color
			if (property.lineType != null)
				styleProps.lineType = property.lineType
			if (Object.keys(styleProps).length)
				rectSteps.push({ props: styleProps, checks: [] })
			// 逐步执行 + 每步读回（用该步返回对象读状态，数值字段逐一核对；假失败前科不信 falsy，无读回字段可核时才采信返回值）
			const readback: Record<string, unknown> = {}
			let verified = true
			let lastRect: any
			for (const step of rectSteps) {
				let rect: any
				try {
					rect = await eda.sch_PrimitiveRectangle.modify(String(params.primitiveId), step.props as any)
				}
				catch { /* 读回为准 */ }
				if (rect)
					lastRect = rect
				const back = rect ?? lastRect
				if (!back) {
					if (step.checks.length)
						verified = false
					continue
				}
				for (const [field, getter, want] of step.checks) {
					const actual = safeState<number>(back, getter)
					readback[field] = actual ?? null
					if (actual == null || Math.abs(actual - want) > 0.5)
						verified = false
				}
			}
			if (!lastRect)
				throw new Error('矩形修改失败（图元不存在或不是矩形）')
			return { primitiveId: safeState<string>(lastRect, 'getState_PrimitiveId'), modified: true, ...(Object.keys(readback).length ? { readback: { ...readback, verified } } : {}), ...(!verified ? { note: '读回数值与目标不符（官方 modify 假成功嫌疑），请用 schematic.listRects 复核后重试' } : {}) }
		},
	},
	{
		name: 'schematic.checkRectOverlap',
		summary: '检查全部矩形（功能区块框）两两之间是否重叠——分区布局自查用。坐标系 +Y 向上，内部按归一化世界坐标包围盒计算（上沿=y、下沿=y-height）；返回每个矩形的实际包围盒供核对，结果不可信时请先对比 rects 字段与源数据',
		params: [],
		returns: '{ rectCount, rects: [{ id, span }], overlaps: [{ a, b, area: { x1, y1, x2, y2 } }] }（无重叠时 overlaps 为空）',
		example: { cmd: 'schematic.checkRectOverlap' },
		handler: async () => {
			const rects = await eda.sch_PrimitiveRectangle.getAll()
			// +Y 向上：官方左上点 y 是上沿（最大值），下沿 = y - height
			const list = (rects ?? []).map(r => {
				const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
				const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
				const w = safeState<number>(r, 'getState_Width') ?? 0
				const h = safeState<number>(r, 'getState_Height') ?? 0
				return {
					id: safeState<string>(r, 'getState_PrimitiveId') ?? '?',
					span: { x1: x, y1: y - h, x2: x + w, y2: y },
				}
			})
			const overlaps: Array<Record<string, unknown>> = []
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					const a = list[i].span
					const b = list[j].span
					const x1 = Math.max(a.x1, b.x1)
					const y1 = Math.max(a.y1, b.y1)
					const x2 = Math.min(a.x2, b.x2)
					const y2 = Math.min(a.y2, b.y2)
					if (x2 > x1 && y2 > y1)
						overlaps.push({ a: list[i].id, b: list[j].id, area: { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 } })
				}
			}
			return { rectCount: list.length, rects: list, overlaps }
		},
	},
	{
		name: 'schematic.structuralAudit',
		summary: '【只读·结构验收】默认当前页：一次调用完成整页结构+排版审计：并查集把物理相接导线段编成树（0.10.63 空间哈希加速），用官方解析 net 字段对账（非几何猜测）。覆盖：异网桥接/短路（标签挂错网 blocking）、不同网名共线重叠（blocking）、重复位号（blocking）、浮空标签、引脚穿线、孤立线树、内部十字交叉（候选，供目检）、功能区框重叠、器件出区（无位号图框自动跳过）、器件相碰（引脚云近似，candidate）。allPages:true 时自动逐页切换审计全部分原理图页并汇总（九页验收一次调用）。只读不改图',
		params: [
			{ name: 'ncExempt', type: 'string[]', description: '豁免名单（NC/预留引脚），如 ["U2.2","U2.7"]——名单内引脚不报穿线候选' },
			{ name: 'deviceMargin', type: 'number', description: '器件相碰筛选的引脚云外扩 mil 数，默认 10（引脚云不重叠则本体几乎不可能相碰；云重叠只说明靠得近，结论标 candidate 待目检）' },
			{ name: 'allPages', type: 'boolean', description: 'true=自动逐页切换审计工程内全部分原理图页并汇总（大工程可用 _timeoutMs 延长总熔断）' },
		],
		returns: '单页：{ stats, summary, blockingCount, issues, warning? }。allPages：{ pages: [{ pageUuid, pageName, stats, summary, blockingCount, issues, warning? }], pageCount, totalBlocking, overallSummary }。blocking=0 不代表整图电气验收通过：本指令证明结构合法，不证明设计意图（关键网络仍按项目契约对账）',
		example: { cmd: 'schematic.structuralAudit', params: { ncExempt: ['U2.2', 'U2.7'] } },
		handler: async (params) => {
			const ncExempt = new Set(Array.isArray(params.ncExempt) ? params.ncExempt.map(String) : [])
			const deviceMargin = params.deviceMargin != null ? Math.max(0, Number(params.deviceMargin)) : 10

			// ①~④ 采集+分析当前激活页（全部只读）
			const auditCurrentPage = async () => {
				// ① 采集（全部只读）
				const rawWires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const wires: Array<IAuditWire> = rawWires.map(w => ({
					primitiveId: safeState<string>(w, 'getState_PrimitiveId') ?? '?',
					net: safeState<string>(w, 'getState_Net') ?? '',
					line: safeState<Array<number>>(w, 'getState_Line') ?? [],
				}))
				const rawLabels = await collectNetLabels(undefined)
				const labels: Array<IAuditLabel> = rawLabels.map(l => ({
					primitiveId: String(l.primitiveId ?? '?'),
					net: String(l.net ?? ''),
					x: l.x != null ? Number(l.x) : undefined,
					y: l.y != null ? Number(l.y) : undefined,
					attached: l.attached !== false,
					wireId: l.wireId != null ? String(l.wireId) : undefined,
				}))
				const rawComps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) ?? []
				const comps: Array<IAuditComp> = rawComps.map(c => ({
					primitiveId: safeState<string>(c, 'getState_PrimitiveId') ?? '?',
					designator: safeState<string>(c, 'getState_Designator') ?? undefined,
					x: safeState<number>(c, 'getState_X') ?? undefined,
					y: safeState<number>(c, 'getState_Y') ?? undefined,
				}))
				// ② 引脚逐器件读取（单条 15s 熔断；属性读取失败的器件跳过并记录）
				// 注意：必须按器件（primitiveId）逐条成条目，不能按位号索引——
				// 真实页面常有一批位号未规范化（全是 "R?"），Record 按位号做 key 会互相覆盖丢引脚
				const compPins: Array<IAuditCompPins> = []
				const pinReadFailed: Array<string> = []
				for (const c of comps) {
					try {
						const pins = await withTimeout(eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId), 15000, `listPins(${c.designator ?? c.primitiveId})`)
						compPins.push({
							primitiveId: c.primitiveId,
							designator: c.designator,
							pins: (pins ?? []).map(p => ({
								pinNumber: p.getState_PinNumber != null ? String(p.getState_PinNumber()) : undefined,
								pinName: p.getState_PinName != null ? String(p.getState_PinName()) : undefined,
								x: Number(p.getState_X?.() ?? NaN),
								y: Number(p.getState_Y?.() ?? NaN),
							})).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
						})
					}
					catch {
						pinReadFailed.push(c.designator ?? c.primitiveId)
					}
				}
				// ③ 功能区框
				const rawRects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				const rects: Array<IAuditRect> = rawRects.map(r => {
					const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
					const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
					const w = safeState<number>(r, 'getState_Width') ?? 0
					const h = safeState<number>(r, 'getState_Height') ?? 0
					return { id: safeState<string>(r, 'getState_PrimitiveId') ?? '?', span: { x1: x, y1: y - h, x2: x + w, y2: y } }
				})

				// ④ 分析
				const { issues, stats } = runStructuralAudit({ wires, labels, comps, compPins, rects, ncExempt, deviceMargin })
				const summary: Record<string, number> = {}
				for (const it of issues) {
					const key = `${it.rule}[${it.type}]`
					summary[key] = (summary[key] ?? 0) + 1
				}
				const blockingCount = issues.filter(i => i.type === 'blocking').length
				return {
					stats,
					summary,
					blockingCount,
					issues,
					...(pinReadFailed.length ? { warning: `引脚读取失败 ${pinReadFailed.length} 个器件（${pinReadFailed.slice(0, 5).join(',')}${pinReadFailed.length > 5 ? '…' : ''}），这些器件未参与引脚相关检查` } : {}),
				}
			}

			// 单页模式
			if (params.allPages !== true)
				return await auditCurrentPage()

			// allPages 模式（0.10.63）：从工程文档树收集全部分原理图页，逐页激活+审计+汇总
			const info: any = await eda.dmt_Project.getCurrentProjectInfo()
			if (!info)
				throw new Error('当前没有打开的工程，无法 allPages 审计')
			const pages: Array<{ pageUuid: string, pageName: string }> = []
			const walk = (node: any) => {
				if (!node || typeof node !== 'object')
					return
				if (Array.isArray(node.page) && (node.itemType === 'Schematic' || node.schematic))
					for (const p of node.page)
						pages.push({ pageUuid: String(p.uuid), pageName: String(p.name ?? p.uuid) })
				for (const v of Object.values(node)) {
					if (v && typeof v === 'object') {
						if (Array.isArray(v)) {
							for (const it of v)
								walk(it)
						}
						else
							walk(v)
					}
				}
			}
			walk(info.data ?? info)
			if (!pages.length)
				throw new Error('工程文档树中未找到原理图页（结构异常，可先 project.getInfo 人工确认）')
			const pageResults: Array<any> = []
			for (const pg of pages) {
				// 与 editor.openDocument 同路径：openDocument 返回 tabId，再显式激活一次
				const tabId = await eda.dmt_EditorControl.openDocument(pg.pageUuid).catch(() => null)
				if (!tabId) {
					// 0.10.65 修复：openDocument 失败必须跳过本页——此前照跑当前激活页，
					// 审计结果被记到目标页名下（张冠李戴且无提示）
					pageResults.push({ pageUuid: pg.pageUuid, pageName: pg.pageName, error: 'openDocument 失败，本页未审计', blockingCount: 0, summary: {}, issues: [] })
					continue
				}
				try {
					await eda.dmt_EditorControl.activateDocument(tabId)
				}
				catch {
					// 激活失败不阻断
				}
				await new Promise(resolve => setTimeout(resolve, 400))
				const r = await auditCurrentPage()
				pageResults.push({ pageUuid: pg.pageUuid, pageName: pg.pageName, ...r })
			}
			const overallSummary: Record<string, number> = {}
			let totalBlocking = 0
			for (const r of pageResults) {
				totalBlocking += r.blockingCount
				for (const [k, v] of Object.entries(r.summary))
					overallSummary[k] = (overallSummary[k] ?? 0) + Number(v)
			}
			return { pages: pageResults, pageCount: pageResults.length, totalBlocking, overallSummary }
		},
	},
	{
		name: 'schematic.placeRegion',
		summary: '绘制功能区：矩形框 + 区标题文本一步完成（如「① 输入区（4-32V）」）。坐标 +Y 向上：x,y 是框左上角（y 为上沿），标题自动放在框内左上；返回 span 供后续布局/重叠计算',
		params: [
			{ name: 'x', type: 'number', required: true, description: '框左上角 X（10mil）' },
			{ name: 'y', type: 'number', required: true, description: '框上沿 Y（10mil，+Y 向上世界坐标）' },
			{ name: 'width', type: 'number', required: true, description: '宽度（10mil）' },
			{ name: 'height', type: 'number', required: true, description: '高度（10mil）' },
			{ name: 'title', type: 'string', required: true, description: '区标题，如「① 输入区」' },
			{ name: 'color', type: 'string', description: '边框颜色，如 #8888FF' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed（默认 dashed）' },
			{ name: 'fontSize', type: 'number', description: '标题字号，默认 12' },
		],
		returns: '{ rectId, textId, span }',
		example: { cmd: 'schematic.placeRegion', params: { x: 60, y: 650, width: 400, height: 300, title: '① 输入区（4-32V）' } },
		handler: async (params) => {
			if ([params.x, params.y, params.width, params.height].some(v => v == null) || !params.title)
				throw new Error('缺少参数 x / y / width / height / title')
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const rect = await eda.sch_PrimitiveRectangle.create(
				Number(params.x), Number(params.y),
				Number(params.width), Number(params.height),
				undefined, undefined,
				params.color ? String(params.color) : undefined,
				undefined, undefined,
				(params.lineType != null ? (lineTypeMap[String(params.lineType)] ?? 1) : 1) as any,
				undefined,
			)
			if (!rect)
				throw new Error('矩形创建失败（可能当前打开的不是原理图）')
			const rectId = safeState<string>(rect, 'getState_PrimitiveId')
			// 标题放框内左上：左缩进 10、上沿下移 30（文本锚点在文字左下）
			const text = await eda.sch_PrimitiveText.create(
				Number(params.x) + 10, Number(params.y) - 30,
				String(params.title),
				undefined, undefined, undefined,
				params.fontSize != null ? Number(params.fontSize) : 12,
				true,
			)
			const textId = text ? safeState<string>(text, 'getState_PrimitiveId') : undefined
			return {
				rectId,
				textId,
				span: {
					x1: Number(params.x), y1: Number(params.y) - Number(params.height),
					x2: Number(params.x) + Number(params.width), y2: Number(params.y),
				},
				...(textId ? {} : { note: '标题文本创建失败，仅矩形已放置' }),
			}
		},
	},

	{
		name: 'schematic.getPageInfo',
		summary: '获取原理图图页信息（含图框尺寸：titleBlockData 的 Width/Height，单位 10mil）',
		params: [
			{ name: 'pageUuid', type: 'string', description: '图页 UUID（也接受别名 uuid）；留空取工程树中第一个图页（⚠️ 不是焦点页，多图页工程务必显式传）' },
		],
		returns: '{ name, size, width, height }（width/height 单位 10mil，A4 为 1170×825）',
		example: { cmd: 'schematic.getPageInfo' },
		handler: async (params) => {
			let pageUuid = params.pageUuid ? String(params.pageUuid) : params.uuid ? String(params.uuid) : undefined
			if (!pageUuid) {
				const info = await eda.dmt_Project.getCurrentProjectInfo()
				if (!info)
					throw new Error('当前没有打开的工程')
				const findPage = (node: any): string | undefined => {
					if (node?.itemType === 'Schematic Page')
						return node.uuid
					for (const key of ['data', 'schematic', 'page', 'pcb', 'panel']) {
						const child = node?.[key]
						if (Array.isArray(child)) {
							for (const item of child) {
								const hit = findPage(item)
								if (hit)
									return hit
							}
						}
						else if (child && typeof child === 'object') {
							const hit = findPage(child)
							if (hit)
								return hit
						}
					}
					return undefined
				}
				pageUuid = findPage(info)
				if (!pageUuid)
					throw new Error('工程中未找到原理图图页')
			}
			const page = await eda.dmt_Schematic.getSchematicPageInfo(pageUuid)
			if (!page)
				throw new Error(`图页不存在: ${pageUuid}`)
			const tb = page.titleBlockData ?? {}
			return {
				uuid: page.uuid,
				name: page.name,
				size: tb['Size']?.value ?? tb['Page Size']?.value,
				width: tb['Width']?.value,
				height: tb['Height']?.value,
			}
		},
	},
	{
		name: 'schematic.connectPin',
		summary: '将器件引脚接入指定网络：画一条从引脚尖端外 30 到引脚原点的命名导线（端点对原点即连通；不要探入本体侧，会产生 T 形结点红点）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'pin', type: 'string', required: true, description: '引脚编号或引脚名（支持前缀匹配，如 VDD、PA13）' },
			{ name: 'net', type: 'string', required: true, description: '网络名（GND/3V3/5V 等任意网络名均直接作为导线网络）' },
		],
		returns: '{ primitiveId, net, pinNumber, from, to }',
		example: { cmd: 'schematic.connectPin', params: { primitiveId: 'xxx', pin: 'VDD', net: '3V3' } },
		handler: async (params) => {
			if (!params.primitiveId || !params.pin || !params.net)
				throw new Error('缺少参数 primitiveId / pin / net')
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			if (!pins?.length)
				throw new Error('未找到该器件的引脚（请先激活对应原理图图页）')
			const key = String(params.pin)
			const pin = pins.find(p => p.getState_PinNumber?.() === key || p.getState_PinName?.() === key)
				?? pins.find(p => (p.getState_PinName?.() ?? '').startsWith(key))
			if (!pin)
				throw new Error(`引脚 ${key} 不存在，可用 listPins 查看`)

			// getState_X/Y 是引脚原点（电气端点），引脚线段沿旋转方向延伸 pinLength。
			// 实测规则（v0.7.7 起）：导线端点精确落在引脚原点即连通；
			// 探入本体侧会让端点落在引脚线中段，产生 T 形结点红点 + "单网络"警告。
			// 因此画一条从「引脚尖端外 30」到原点的导线，并直接命名网络。
			const rot = pin.getState_Rotation?.() ?? 0
			const len = pin.getState_PinLength?.() ?? 10
			const rad = (rot * Math.PI) / 180
			const dx = Math.cos(rad)
			const dy = Math.sin(rad)
			const x = pin.getState_X()
			const y = pin.getState_Y()
			const x1 = Math.round(x + dx * (len + 30))
			const y1 = Math.round(y + dy * (len + 30))
			const x2 = Math.round(x)
			const y2 = Math.round(y)

			const net = String(params.net)
			// 智能命名：该网络已在页面存在（命名导线或网络标签）则画无名短桩，
			// 避免合并后 NET 属性叠加产生"导线有多个网络名"警告
			const shouldName = !(await netExistsOnPage(net))
			const wire = await withStage('drawWire:wire.create', () => eda.sch_PrimitiveWire.create([x1, y1, x2, y2], shouldName ? net : undefined))
			if (!wire)
				throw new Error('导线创建失败')
			return {
				primitiveId: safeState<string>(wire, 'getState_PrimitiveId'),
				net,
				named: shouldName,
				pinNumber: pin.getState_PinNumber?.(),
				from: { x: x1, y: y1 },
				to: { x: x2, y: y2 },
			}
		},
	},
	{
		name: 'schematic.labelWire',
		summary: '【推荐·语义化】标签连接：把【1 个引脚】接入指定网络——自动画短桩（沿引脚朝向外，0.10.21 起默认长 60 容纳长网名，stubLen 可覆盖，防撞自动换向）+ 放网络标签（自带同名防呆+附着验证）。0.10.20 起标签 rotation 恒 0、锚点恒在桩末端（全方向一致）——决定性实验实锤：附着判定看锚点（锚点必须落在导线上，离线外 5 单位即浮标），rotation 0 文字自锚点右伸；0.10.18 的锚点偏移策略电气不成立已回滚。⚠️ 只接 1 个引脚且必须带名字；两个引脚互连请用 schematic.linkWire',
		params: [
			{ name: 'pin', type: 'string', required: true, description: '引脚引用 "位号.引脚号"，如 U1.7、R2.1' },
			{ name: 'net', type: 'string', required: true, description: '网络名（必须）' },
			{ name: 'color', type: 'string', description: '标签颜色，如 #FF0000' },
			{ name: 'stubLen', type: 'number', description: '短桩长度（默认 60，能容纳长网名文字右伸不压器件；显式指定时最小钳 20）' },
			{ name: 'force', type: 'boolean', description: '引脚已被其他网络占用时仍强行连接（合并网络，慎用）' },
		],
		returns: '{ pin, net, stub, stubLen, labelId, labelPos, placement, attached } 或 { alreadyConnected: true }',
		example: { cmd: 'schematic.labelWire', params: { pin: 'U1.7', net: '3V3' } },
		handler: async (params) => {
			if (!params.pin || !params.net)
				throw new Error('缺少参数 pin / net')
			const net = String(params.net)
			const p = await resolvePinPoint(String(params.pin))
			assertPinConnectable(p)
			// 占用预检：引脚若已被导线占用——同名则直接复用，异名则拒绝（继续画会串网）
			if (!params.force) {
				const occupied = await findWireNetsAtPoint(p.x, p.y)
				if (occupied.length) {
					if (occupied.every(n => n === net))
						return { pin: `${p.designator}.${p.pin}`, net, alreadyConnected: true, note: '引脚已在目标网络中，未重复画桩' }
					throw new Error(`引脚 ${p.designator}.${p.pin} 已接入网络 ${occupied.join('、')}，与目标 ${net} 冲突，继续会串网。请先删该引脚上的现有导线（schematic.listWires 查 → schematic.delete 删），或确认要合并网络时加 force:true`)
				}
			}
			const existingSegs = await collectWireSegs()
			// 短桩候选方向：沿引脚朝向（尖端向外）、上、下、反向
			const rad = (p.rot * Math.PI) / 180
			const outX = Math.cos(rad)
			const outY = Math.sin(rad)
			// 0.10.21 桩长：统一默认 60（用户决策：不按网名长度自适应，长短不一难看；60 能容纳 STATUS_LED 级
			// 长名文字右伸 46+余量不压器件，全方向一致）；stubLen 参数可显式覆盖（最小钳 20）
			const STUB = Math.max(20, params.stubLen != null ? Number(params.stubLen) : 60)
			const allPinPts = await collectAllPinPoints()
			const candidates: Array<[number, number]> = [
				[Math.round(outX), Math.round(outY)],
				[0, 1], [0, -1],
				[-Math.round(outX), -Math.round(outY)],
			]
			let chosen: [number, number, number, number] | undefined
			for (const [ux, uy] of candidates) {
				if (ux === 0 && uy === 0)
					continue
				const ex = p.x + ux * STUB
				const ey = p.y + uy * STUB
				const seg: [number, number, number, number] = [p.x, p.y, ex, ey]
				// 0.10.26 修复（0.10.24 终验实锤：FB 短桩横穿 R1.2 引脚中段致串网）——
				// 引脚避让从「只查桩末端」改为「整段路径 8 单位内有任何引脚（含中段）就换方向」
				const hitsPin = allPinPts.some(q =>
					!(q.x === p.x && q.y === p.y) && pointToSegDist(q.x, q.y, p.x, p.y, ex, ey) < 8)
				if (hitsPin)
					continue
				if (existingSegs.some(s => segCollinearOverlap(seg, s)))
					continue
				chosen = seg
				break
			}
			if (!chosen)
				throw new Error(`${p.designator}.${p.pin} 四个方向的短桩都与相邻图元/引脚冲突（整段 8 单位避让），请先挪开相邻器件或手动 drawWire`)
			const [sx1, sy1, ex, ey] = chosen
			const stub = await withStage('labelWire:wire.create', () => eda.sch_PrimitiveWire.create([sx1, sy1, ex, ey]))
			if (!stub)
				throw new Error('短桩导线创建失败（可能当前打开的不是原理图）')
			// 标签落点（0.10.20 锚点语义实锤后回归最简）：rotation 恒 0、锚点 = 桩末端（全方向一致）。
			// 决定性实验结论（TPS5450 页实测矩阵）：① 附着判定看锚点——锚点必须落在导线上
			// （端点/中段均附着，离线外 5 单位即浮标）；② rotation 0 文字从锚点向右伸展（锚点=文字左缘）。
			// 因此 0.10.18 的「锚点左移文字宽度、右缘对齐」电气上不成立（锚点离线即浮标，验收 2/2 复现超时）；
			// 官方标准形态就是「锚点压桩末端、文字右伸」（12路 人工页标签全是这个形态）。
			const bx = ex
			const by = ey
			const placement = '锚点在桩末端（rotation 0，文字自锚点右伸；0.10.20 锚点语义实锤：附着看锚点，锚点必须在导线上）'
			// 标签放落点（±2 自动微偏；返回空时先查是否假失败已创建，防双份）
			let labelId: string | undefined
			for (const [ddx, ddy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
				const lbl = await withStage('labelWire:createNetLabel', () => (eda.sch_PrimitiveAttribute as any).createNetLabel(bx + ddx, by + ddy, net))
				if (lbl) {
					labelId = safeState<string>(lbl, 'getState_PrimitiveId')
					break
				}
				const ghost = await findGhostNetLabel(net, bx + ddx, by + ddy)
				if (ghost) {
					labelId = ghost.id
					break
				}
			}
			if (!labelId) {
				// 原则：插件不擅自修复/回滚——短桩保留，如实报告，由操作者决定删不删
				return {
					pin: `${p.designator}.${p.pin}`,
					net,
					stub: { x1: sx1, y1: sy1, x2: ex, y2: ey },
					stubId: safeState<string>(stub, 'getState_PrimitiveId'),
					stubLen: STUB,
					labelId: undefined,
					attached: false,
					warning: '网络标签创建失败（±2 微偏均被拒）。短桩已保留未回滚：要继续可手动 placeNetLabel 补标签；要放弃请用 schematic.delete 删除 stubId',
				}
			}
			if (params.color) {
				try {
					await eda.sch_PrimitiveAttribute.modify(labelId, { color: String(params.color) } as any)
				}
				catch { /* 着色失败不阻断 */ }
			}
			// 附着验证：桩末端附近导线应已归入该网络（批处理场景由 batchWire 统一审计，跳过逐条等待）。
			// 0.10.20：附着不上时快速失败（最多 2 次 500ms 重试，≈1.5s 内返回 attached:false），
			// 不再 6 次轮询到 25s 代理超时（0.10.19 验收缺陷：偏移锚点不附着时指令整体超时且报误导文案）
			let attached: boolean | undefined
			if (params.skipAttachVerify) {
				attached = undefined
			}
			else {
				await new Promise(resolve => setTimeout(resolve, 500))
				attached = false
				for (let attempt = 0; attempt < 2 && !attached; attempt++) {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					for (let i = 0; i + 1 < line.length; i += 2) {
						const x1 = line[i]
						const y1 = line[i + 1]
						const x2 = line[i + 2] ?? x1
						const y2 = line[i + 3] ?? y1
						const ddx = Math.max(Math.min(x1, x2) - ex, 0, ex - Math.max(x1, x2))
						const ddy = Math.max(Math.min(y1, y2) - ey, 0, ey - Math.max(y1, y2))
						if (Math.hypot(ddx, ddy) <= 5) {
							attached = true
							break
						}
					}
					if (attached)
						break
				}
					if (!attached)
						await new Promise(resolve => setTimeout(resolve, 500))
				}
			}
			return {
				pin: `${p.designator}.${p.pin}`,
				net,
				stub: { x1: sx1, y1: sy1, x2: ex, y2: ey },
				stubLen: STUB,
				labelId,
				labelPos: { x: bx, y: by },
				placement,
				attached,
				...(attached === false ? { note: '附着验证未通过（标签可能浮空）——请用 schematic.listNetLabels 复核；确认浮空用 schematic.pruneFloatingLabels 清理后重放，短桩可 schematic.delete 删除' } : {}),
			}
		},
	},
	{
		name: 'schematic.linkWire',
		summary: '【推荐·语义化】导线连接：用无名导线把【正好 2 个引脚】物理连通——自动 U 形正交走线（先下折再横走，横腿深度自动避开现有导线防共线合并）。⚠️ 必须正好 2 个引脚且不允许带网络名；接网络请用 schematic.labelWire',
		params: [
			{ name: 'pins', type: 'string[]', required: true, description: '正好两个引脚引用 ["U1.7","C1.1"]' },
			{ name: 'color', type: 'string', description: '导线颜色' },
			{ name: 'jogDir', type: 'string', description: '横腿方向 down | up（默认 down；引脚同列时左右错层用 left | right）' },
			{ name: 'force', type: 'boolean', description: '引脚已被占用时仍强行连接（合并网络，慎用）' },
		],
		returns: '{ pins, route: [[x,y],...], segments, wireIds } 或 { alreadyConnected: true }',
		example: { cmd: 'schematic.linkWire', params: { pins: ['U1.7', 'C1.1'] } },
		handler: async (params) => {
			if (!Array.isArray(params.pins) || params.pins.length !== 2)
				throw new Error('linkWire 必须正好给 2 个引脚（pins: ["U1.7","C1.1"]）；接网络用 schematic.labelWire，多点网络逐对连接或改用标签')
			const a = await resolvePinPoint(String(params.pins[0]))
			const b = await resolvePinPoint(String(params.pins[1]))
			assertPinConnectable(a)
			assertPinConnectable(b)
			// 占用预检：两引脚已在同一网络→直接复用；分属不同网络/单侧被占→拒绝（直连会短接网络）
			if (!params.force) {
				const aNets = await findWireNetsAtPoint(a.x, a.y)
				const bNets = await findWireNetsAtPoint(b.x, b.y)
				const common = aNets.filter(n => bNets.includes(n))
				if (common.length)
					return { pins: [`${a.designator}.${a.pin}`, `${b.designator}.${b.pin}`], alreadyConnected: true, net: common[0], note: '两引脚已在同一网络，无需连线' }
				if (aNets.length || bNets.length)
					throw new Error(`引脚已被占用：${a.designator}.${a.pin}→${aNets.join('、') || '空'}，${b.designator}.${b.pin}→${bNets.join('、') || '空'}。直接连线会把不同网络短接；确认要合并请加 force:true，否则先删现有导线`)
			}
			const existing = await collectWireSegs()
			// 0.10.27：link 直连同样做整段引脚避让（0.10.26 装机复测实锤：FBA link 横腿 (580,560)→(625,560)
			// 穿过 RV1.2 引脚把它并入无名网——0.10.26 只修了 labelWire 短桩，link 路径没修）。
			// 候选路径逐段查全页引脚（两端点引脚除外），所有候选都穿引脚则抛特定错误（autoLayout 据此降级为两端 label）
			const allPinPts = await collectAllPinPoints()
			const endKeys = new Set([`${a.x},${a.y}`, `${b.x},${b.y}`])
			const segHitsPin = (x1: number, y1: number, x2: number, y2: number): boolean =>
				allPinPts.some(q => !endKeys.has(`${q.x},${q.y}`) && pointToSegDist(q.x, q.y, x1, y1, x2, y2) < 8)
			const routeHitsPin = (r: Array<[number, number]>): boolean => {
				for (let i = 0; i + 1 < r.length; i++) {
					if (segHitsPin(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]))
						return true
				}
				return false
			}
			const jogDown = String(params.jogDir ?? 'down') !== 'up'
			// 选横腿深度：从 30 起每次加深 15，直到横腿不与任何现有导线共线重叠且全路径不穿引脚（最多试 8 层）
			let route: Array<[number, number]> | undefined
			if (Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) > 1) {
				for (let k = 0; k < 8 && !route; k++) {
					const jogY = jogDown
						? Math.min(a.y, b.y) - 30 - k * 15
						: Math.max(a.y, b.y) + 30 + k * 15
					const hSeg: [number, number, number, number] = [a.x, jogY, b.x, jogY]
					const candidate: Array<[number, number]> = [[a.x, a.y], [a.x, jogY], [b.x, jogY], [b.x, b.y]]
					if (!existing.some(s => segCollinearOverlap(hSeg, s)) && !routeHitsPin(candidate))
						route = candidate
				}
			}
			else if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) > 1) {
				for (let k = 0; k < 8 && !route; k++) {
					const jogX = jogDown
						? Math.min(a.x, b.x) - 30 - k * 15
						: Math.max(a.x, b.x) + 30 + k * 15
					const vSeg: [number, number, number, number] = [jogX, a.y, jogX, b.y]
					const candidate: Array<[number, number]> = [[a.x, a.y], [jogX, a.y], [jogX, b.y], [b.x, b.y]]
					if (!existing.some(s => segCollinearOverlap(vSeg, s)) && !routeHitsPin(candidate))
						route = candidate
				}
			}
			else {
				// 不同行也不同列：L 形两个变体（水平腿在 a 行 / 在 b 行），优先不共线且不穿引脚的
				const viaA: Array<[number, number]> = [[a.x, a.y], [b.x, a.y], [b.x, b.y]]
				const viaB: Array<[number, number]> = [[a.x, a.y], [a.x, b.y], [b.x, b.y]]
				const okA = !existing.some(s => segCollinearOverlap([a.x, a.y, b.x, a.y], s)) && !routeHitsPin(viaA)
				const okB = !existing.some(s => segCollinearOverlap([a.x, a.y, a.x, b.y], s)) && !routeHitsPin(viaB)
				route = okA ? viaA : okB ? viaB : undefined
			}
			if (!route)
				throw new Error('找不到不共线且不穿引脚的走线路径（U 形已试 8 层 + L 形两变体，全档位都穿引脚或不共线无解），请人工布线；autoLayout 场景会自动降级为两端 label 短桩（PIN_CROSSING_FALLBACK）')
			const wireColor = params.color != null ? String(params.color) : undefined
			const wireIds: Array<string> = []
			const { segments } = splitToSimpleSegments(route as Array<[number, number]>)
			for (const [x1, y1, x2, y2] of segments) {
				const wire = await withStage('linkWire:wire.create', () => eda.sch_PrimitiveWire.create([x1, y1, x2, y2], undefined, wireColor as any))
				if (!wire)
					throw new Error(`走线段 (${x1},${y1})→(${x2},${y2}) 创建失败`)
				const id = safeState<string>(wire, 'getState_PrimitiveId')
				if (id)
					wireIds.push(id)
			}
			return {
				pins: [`${a.designator}.${a.pin}`, `${b.designator}.${b.pin}`],
				route,
				segments: wireIds.length,
				wireIds,
			}
		},
	},
	{
		name: 'schematic.batchWire',
		summary: '【推荐·批量】一次提交一批接线项（label 标签接网 / link 两脚直连），逐条执行逐条收错，最后只做一次网表统一审计——比逐条 labelWire/linkWire 快得多（省去每条 500ms×6 的附着等待）。⚠️ 只报告不自动修复：audit 失败的项由操作者决定处置',
		params: [
			{ name: 'items', type: 'array', required: true, description: '接线项数组：[{type:"label", pin:"U1.7", net:"VOUT", color?}, {type:"link", pins:["U1.7","C1.1"], color?, jogDir?}]' },
			{ name: 'continueOnError', type: 'boolean', description: '单项失败是否继续执行后续项，默认 true' },
			{ name: 'skipAudit', type: 'boolean', description: '跳过最后的网表统一审计（只要执行结果），默认 false' },
		],
		returns: '{ items: [{item, ok, data|error}], audit: [{item, pass, detail}], summary: {total, ok, failed, auditFailed} }',
		example: { cmd: 'schematic.batchWire', params: { items: [{ type: 'label', pin: 'U1.7', net: 'VOUT' }, { type: 'link', pins: ['R1.1', 'C1.1'] }] } },
		handler: async (params, ctx) => {
			if (!Array.isArray(params.items) || !params.items.length)
				throw new Error('缺少参数 items（非空数组）')
			const continueOnError = params.continueOnError !== false
			const labelCmd = schematicCommands.find(c => c.name === 'schematic.labelWire')
			const linkCmd = schematicCommands.find(c => c.name === 'schematic.linkWire')
			if (!labelCmd || !linkCmd)
				throw new Error('内部错误：labelWire/linkWire 未注册')

			// 0.10.49：注册长任务——逐条进度心跳重置代理/扩展超时（批量接线 48 项约 60s+，
			// 客户端超时后同参数重发只回进度不重复执行）；心跳经 ctx.onProgress 发给代理
			const { task, existing } = beginTask('schematic.batchWire',
				{ items: params.items, continueOnError, skipAudit: params.skipAudit === true },
				ctx && ((t) => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress })))
			if (existing) {
				return {
					taskId: task.id,
					alreadyRunning: true,
					state: task.state,
					progress: task.progress,
					note: '相同批量接线任务仍在后台执行——这是实时进度，稍后重发或 task.get 取结果即可，不要改参数重发',
				}
			}

			try {
			const results: Array<any> = []
			for (let i = 0; i < params.items.length; i++) {
				const item = params.items[i] ?? {}
				const type = String(item.type ?? '')
				try {
					let data: any
					if (type === 'label') {
						if (!item.pin || !item.net)
							throw new Error('label 项缺少 pin / net')
						data = await labelCmd.handler({ pin: item.pin, net: item.net, color: item.color, skipAttachVerify: true }, ctx)
					}
					else if (type === 'link') {
						if (!Array.isArray(item.pins))
							throw new Error('link 项缺少 pins 数组')
						data = await linkCmd.handler({ pins: item.pins, color: item.color, jogDir: item.jogDir, force: item.force }, ctx)
					}
					else
						throw new Error(`未知 type "${type}"，只支持 label | link`)
					results.push({ index: i, item, ok: true, data })
				}
				catch (e: any) {
					// 0.10.51：失败项保留完整诊断——error 保持字符串兼容旧调用方（含 0.10.48 的
					// [阶段] 前缀），另附 message/name/stack/cause（GPT KIMI-EDA-20261002-07 指出：
					// 此处只 String(message) 绕过了 registry.errorResult 的堆栈透传，批量路径丢失诊断）
					const detail = serializeErrorDetail(e)
					results.push({ index: i, item, ok: false, error: detail.message, ...detail })
					if (!continueOnError)
						break
				}
				taskProgress(task, {
					stage: 'items',
					done: results.length,
					total: params.items.length,
					ok: results.filter(r => r.ok).length,
					failed: results.filter(r => !r.ok).length,
					last: { type: item.type, pin: item.pin, pins: item.pins, net: item.net },
				})
			}

			// 统一审计：一次网表导出，逐条核对
			const audit: Array<any> = []
			if (!params.skipAudit) {
				taskProgress(task, { stage: 'audit', done: results.length, total: params.items.length })
				// getNetlistFile 大批量改动后会导出缓存旧快照（误报 pass:false），
				// 参考 runDrc 双跑取稳定值的做法：审计未全过时等 800ms 重导，最多 5 次，取最后一次结果。
				// 0.10.45：换用 pinNetMapRobust——getNetlistFile 返空（如缺封装，04 实测因果）时
				// 自动回退 PADS 文本网表解析，缺封装工程上终审不再整体失效（GPT KIMI-EDA-20261002-05）。
				const exportPinNetMap = (): Promise<Map<string, string> | undefined> => pinNetMapRobust()
				const auditWith = (pinNetMap: Map<string, string> | undefined): Array<any> => results.filter(r => r.ok).map((r) => {
					if (!pinNetMap)
						return { index: r.index, item: r.item, pass: undefined, detail: '网表导出失败，未能审计' }
					if (String(r.item.type) === 'label') {
						const actual = pinNetMap.get(String(r.item.pin))
						const pass = actual === String(r.item.net)
						return {
							index: r.index,
							item: r.item,
							pass,
							detail: pass ? '已入网' : `引脚实际网络为 ${actual ?? '(悬空/未入网)'}，期望 ${r.item.net}——标签可能未附着，可用 schematic.listNetLabels 复核或 schematic.repairNet 修复`,
						}
					}
					const [pa, pb] = (r.item.pins as Array<string>).map(String)
					const na = pinNetMap.get(pa)
					const nb = pinNetMap.get(pb)
					const pass = na != null && na === nb
					return {
						index: r.index,
						item: r.item,
						pass,
						detail: pass ? `两脚同网 ${na}` : `两脚网络不一致：${pa}→${na ?? '(空)'}，${pb}→${nb ?? '(空)'}`,
					}
				})
				let pinNetMap = await exportPinNetMap()
				let lastAudit = auditWith(pinNetMap)
				for (let retry = 0; retry < 5 && lastAudit.some(a => a.pass === false); retry++) {
					await new Promise(resolve => setTimeout(resolve, 800))
					pinNetMap = await exportPinNetMap()
					lastAudit = auditWith(pinNetMap)
				}
				audit.push(...lastAudit)
			}

			// 0.10.24（P01 关联加固）：批量命名偶发失效（空网名）必须进 failed 清单——
			// 网表审计 pass:false 的项即使执行阶段 ok:true 也改写为失败（带实际网名），不允许静默进成功计数
			for (const a of audit) {
				if (a.pass !== false)
					continue
				const r = results.find(x => x.index === a.index)
				if (r && r.ok) {
					r.ok = false
					r.error = `网表审计未通过：${a.detail}`
					r.auditFailed = true
					delete r.data
				}
			}

			const failed = results.filter(r => !r.ok).length
			const auditFailed = audit.filter(a => a.pass === false).length
			const batchResult = {
				items: results,
				audit,
				summary: { total: results.length, ok: results.length - failed, failed, auditFailed },
				...(failed || auditFailed ? { note: '存在失败/审计未通过项，插件不自动修复——请按 audit.detail 逐条处置后重跑失败项' } : {}),
			}
			finishTask(task, batchResult.summary)
			return { taskId: task.id, ...batchResult }
			}
			catch (e) {
				failTask(task, e)
				throw e
			}
		},
	},
	{
		name: 'schematic.listPins',
		summary: '列出器件全部引脚（编号、名称、坐标）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
		],
		returns: '引脚列表 [{ pinNumber, pinName, x, y }]',
		example: { cmd: 'schematic.listPins', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			return (pins ?? []).map(p => ({
				pinNumber: p.getState_PinNumber?.(),
				pinName: p.getState_PinName?.(),
				x: p.getState_X?.(),
				y: p.getState_Y?.(),
			}))
		},
	},
	{
		name: 'schematic.listComponents',
		summary: '列出当前原理图图页的全部器件',
		params: [
			{ name: 'allPages', type: 'boolean', description: '是否包含所有图页，默认 false（仅当前图页）' },
		],
		returns: '器件列表 [{ primitiveId, designator, name, x, y, rotation }]',
		example: { cmd: 'schematic.listComponents' },
		handler: async (params) => {
			const components = await eda.sch_PrimitiveComponent.getAll(undefined, Boolean(params.allPages))
			return (components ?? []).map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				name: safeState<string>(c, 'getState_Name'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
				rotation: safeState<number>(c, 'getState_Rotation'),
			}))
		},
	},
	{
		name: 'schematic.placeDevice',
		summary: '按立创编号或器件 uuid 在原理图放置器件',
		params: [
			{ name: 'lcscId', type: 'string', description: '立创编号，如 C25804（与 deviceUuid 二选一）' },
			{ name: 'deviceUuid', type: 'string', description: '器件 UUID（需同时给 libraryUuid）' },
			{ name: 'libraryUuid', type: 'string', description: '器件所在库 UUID' },
			{ name: 'x', type: 'number', required: true, description: '坐标 X（单位 10mil；A4 图框有效范围约 0–1170，建议 100–1000）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y（单位 10mil；A4 图框有效范围约 0–830，建议 100–700）' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像，默认 false' },
		],
		returns: '{ primitiveId, designator }',
		example: { cmd: 'schematic.placeDevice', params: { lcscId: 'C25804', x: 300, y: 300 } },
		handler: async (params) => {
			if (params.x == null || params.y == null)
				throw new Error('缺少坐标参数 x / y')

			let deviceRef: { libraryUuid: string, uuid: string } | undefined
			if (params.lcscId) {
				const items = await eda.lib_Device.getByLcscIds([String(params.lcscId)])
				if (!items?.[0])
					throw new Error(`未找到立创编号为 ${params.lcscId} 的器件`)
				deviceRef = { libraryUuid: items[0].libraryUuid, uuid: items[0].uuid }
			}
			else if (params.deviceUuid && params.libraryUuid) {
				deviceRef = { libraryUuid: String(params.libraryUuid), uuid: String(params.deviceUuid) }
			}
			else {
				throw new Error('需要提供 lcscId，或 deviceUuid + libraryUuid')
			}

			const component = await eda.sch_PrimitiveComponent.create(
				deviceRef,
				Number(params.x),
				Number(params.y),
				params.subPartName ? String(params.subPartName) : undefined,
				params.rotation != null ? Number(params.rotation) : undefined,
				params.mirror != null ? Boolean(params.mirror) : undefined,
				params.addIntoBom != null ? Boolean(params.addIntoBom) : true,
				params.addIntoPcb != null ? Boolean(params.addIntoPcb) : true,
			)
			if (!component)
				throw new Error('器件放置失败（可能当前打开的不是原理图）')
			return {
				primitiveId: safeState<string>(component, 'getState_PrimitiveId'),
				designator: safeState<string>(component, 'getState_Designator'),
			}
		},
	},
	{
		name: 'schematic.drawWire',
		summary: '在原理图绘制导线。内部自动拆成简单两点段（多分支折线/重复段/斜线伪段都不会失败）；智能命名：同一网络在页面只命名一次，其余段自动无名（从源头避免"多个网络名"警告）',
		params: [
			{ name: 'points', type: 'number[][]', required: true, description: '折点坐标 [[x1,y1],[x2,y2],...]（单位 10mil）' },
			{ name: 'net', type: 'string', description: '网络名，留空则自动；若该网络已存在则自动画无名段' },
			{ name: 'color', type: 'string', description: '导线颜色，如 #FF0000（0.9.8 起）' },
			{ name: 'lineWidth', type: 'number', description: '线宽（0.9.8 起）' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed | dotted（0.9.8 起）' },
		],
		returns: '{ primitiveIds, segments, named, net?, skippedDiagonal? }',
		example: { cmd: 'schematic.drawWire', params: { points: [[300, 300], [400, 300]], net: 'VCC' } },
		handler: async (params) => {
			if (!Array.isArray(params.points) || params.points.length < 2)
				throw new Error('points 至少需要两个点')
			// 兼容 [{x,y},...] 对象形式，统一归一为 [[x,y],...]
			const pts = (params.points as Array<any>).map(p =>
				Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.y)]) as Array<[number, number]>
			if (pts.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
				throw new Error('points 格式应为 [[x1,y1],[x2,y2],...] 或 [{x,y},...]')
			const net = params.net ? String(params.net) : undefined
			const wireColor = params.color != null ? String(params.color) : undefined
			const wireWidth = params.lineWidth != null ? Number(params.lineWidth) : undefined
			const wireTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const wireType = params.lineType != null ? (wireTypeMap[String(params.lineType)] ?? 0) : undefined
			// 智能命名：网络已存在（命名导线或网络标签）则画无名段
			let nameNext = net ? !(await netExistsOnPage(net)) : false
			const { segments, skippedDiagonal } = splitToSimpleSegments(pts)
			if (!segments.length)
				throw new Error('没有可绘制的有效线段（全部为重复/零长/斜线段）')
			const primitiveIds: Array<string | undefined> = []
			let didName = false
			for (let i = 0; i < segments.length; i++) {
				const [x1, y1, x2, y2] = segments[i]
				const wire = await eda.sch_PrimitiveWire.create(
					[x1, y1, x2, y2],
					nameNext ? net : undefined,
					wireColor as any,
					wireWidth as any,
					wireType as any,
				)
				if (!wire)
					throw new Error(`第 ${i + 1} 段导线创建失败（可能当前打开的不是原理图）`)
				primitiveIds.push(safeState<string>(wire, 'getState_PrimitiveId'))
				if (nameNext)
					didName = true
				nameNext = false // 命名只用于第一段，其余段无名
			}
			// 读回验证（0.10.23：官方 create 返回值不可信——命名段读回真实 NET，带不上名如实报，杜绝"报成功实际无名"）
			let readback: { namedWireId?: string, net?: string, verified: boolean } | undefined
			if (didName && net) {
				const namedId = primitiveIds[0]
				await new Promise(resolve => setTimeout(resolve, 300))
				try {
					const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
					const found = wires.find(w => safeState<string>(w, 'getState_PrimitiveId') === namedId)
					const actual = found ? safeState<string>(found, 'getState_Net') : undefined
					readback = { namedWireId: namedId, net: actual ?? null as any, verified: actual === net }
				}
				catch {
					readback = { namedWireId: namedId, net: null as any, verified: false }
				}
			}
			return {
				primitiveIds,
				segments: primitiveIds.length,
				named: didName,
				...(net ? { net } : {}),
				...(readback ? { readback, ...(readback.verified ? {} : { note: `命名段读回网名「${readback.net ?? '(读取失败)'}」与目标「${net}」不符——导线已画出但可能没带上名，请用 schematic.listWires 复核后用 setWireNet 补名` }) } : {}),
				// 0.10.26（0.10.24 终验实锤）：官方对命名导线会在导线中点自动落一个 NET 属性标签——
				// 它与 placeNetLabel 的标签是两套，同网并存即重复（DRC "多个网络名"类警告），且属性标签删不掉
				...(didName && readback?.verified ? { namingNote: `命名导线已自动在导线中点落一个网络标签（NET 属性）。⚠️ 该标签是导线持有的属性，官方不支持单独删除（只能删整根导线重画）；请不要再对该网络 placeNetLabel 补标签，否则标签重复。需要标签收尾的场景建议：drawWire 不传 net（画无名线）+ placeNetLabel 放标签` } : {}),
				...(skippedDiagonal ? { skippedDiagonal } : {}),
			}
		},
	},
	{
		name: 'schematic.setWireNet',
		summary: '修改导线网络名；也用于清理"导线有多个同名网络名"的 DRC 警告（命名短桩与母排合并后同名冗余）。0.10.23 起：modify 后强制读回验证（官方返回值不可信，0.10.22 曾假成功——回显目标网名但保存后实际为空），读回不符判失败并如实返回实际网名',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '导线图元 ID' },
			{ name: 'net', type: 'string', required: true, description: '目标网络名' },
		],
		returns: '{ primitiveId, net, readback: { net, verified } }（verified=false 时报错并带实际网名）',
		example: { cmd: 'schematic.setWireNet', params: { primitiveId: 'xxx', net: 'VIN' } },
		handler: async (params) => {
			if (!params.primitiveId || !params.net)
				throw new Error('缺少参数 primitiveId / net')
			const wireId = String(params.primitiveId)
			const targetNet = String(params.net)
			const wire = await eda.sch_PrimitiveWire.modify(wireId, { net: targetNet })
			if (!wire)
				throw new Error('导线修改失败（图元不存在或不是导线）')
			// 官方返回值不可信（0.10.22 GPT 现场：modify 回显成功但保存后网名实际为空、网表仍在旧网），
			// 成败以读回为准：等官方缓存刷新后全量枚举导线，读该导线真实 NET
			const readbackNet = async (): Promise<string | undefined> => {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const found = wires.find(w => safeState<string>(w, 'getState_PrimitiveId') === wireId)
				return found ? safeState<string>(found, 'getState_Net') : undefined
			}
			let actual: string | undefined
			for (const waitMs of [300, 500, 800]) {
				await new Promise(resolve => setTimeout(resolve, waitMs))
				try {
					actual = await readbackNet()
				}
				catch {
					actual = undefined
				}
				if (actual === targetNet)
					break
			}
			if (actual == null)
				throw new Error(`导线 ${wireId} 读回失败：全量枚举中找不到该导线（可能已不存在），modify 结果未采信`)
			if (actual !== targetNet)
				throw new Error(`导线 ${wireId} 网络名修改未生效：读回实际为「${actual || '(空)'}」，目标「${targetNet}」——官方 modify 假成功（0.10.22 前科），请重试或删线重画`)
			return { primitiveId: wireId, net: targetNet, readback: { net: actual, verified: true } }
		},
	},
	{
		name: 'schematic.modifyWire',
		summary: '修改导线颜色/线宽/线型/网络名（0.9.8 起；按网名批量改色也可以——传 net 过滤 + color 即可，如把 3V3 全部导线标红）',
		params: [
			{ name: 'primitiveId', type: 'string', description: '导线图元 ID（单根修改；与 net 过滤二选一）' },
			{ name: 'net', type: 'string', description: '按当前网络名过滤批量修改（与 primitiveId 二选一）' },
			{ name: 'color', type: 'string', description: '导线颜色，如 #FF0000' },
			{ name: 'lineWidth', type: 'number', description: '线宽' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed | dotted' },
			{ name: 'newNet', type: 'string', description: '改网络名（单根修改时可用）' },
		],
		returns: '{ modified: [成功 ID], failed: [失败 ID] }',
		example: { cmd: 'schematic.modifyWire', params: { net: '3V3', color: '#FF0000' } },
		handler: async (params) => {
			const property: Record<string, unknown> = {}
			if (params.color != null)
				property.color = String(params.color)
			if (params.lineWidth != null)
				property.lineWidth = Number(params.lineWidth)
			if (params.lineType != null) {
				const m: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
				property.lineType = m[String(params.lineType)] ?? 0
			}
			if (params.newNet != null)
				property.net = String(params.newNet)
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（color / lineWidth / lineType / newNet）')
			let ids: Array<string> = []
			if (params.primitiveId) {
				ids = [String(params.primitiveId)]
			}
			else if (params.net) {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				ids = wires
					.filter(w => safeState<string>(w, 'getState_Net') === String(params.net))
					.map(w => safeState<string>(w, 'getState_PrimitiveId'))
					.filter(Boolean) as Array<string>
				if (!ids.length)
					throw new Error(`没有找到网络 ${params.net} 的导线`)
			}
			else {
				throw new Error('缺少参数 primitiveId 或 net（二选一）')
			}
			const modified: Array<string> = []
			const failedIds: Array<string> = []
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——样式（颜色/线宽/线型）与改名（net）分步执行
			const wireSteps: Array<Record<string, unknown>> = []
			const styleProps: Record<string, unknown> = {}
			for (const k of ['color', 'lineWidth', 'lineType']) {
				if (property[k] != null)
					styleProps[k] = property[k]
			}
			if (Object.keys(styleProps).length)
				wireSteps.push(styleProps)
			if (property.net != null)
				wireSteps.push({ net: property.net })
			for (const id of ids) {
				let okAny = false
				let threw = false
				for (const stepProps of wireSteps) {
					try {
						if (await eda.sch_PrimitiveWire.modify(id, stepProps as any))
							okAny = true
					}
					catch {
						threw = true
					}
				}
				if (okAny || !threw)
					modified.push(id)
				else
					failedIds.push(id)
			}
			// 读回验证（0.10.23：官方 modify 假成功前科——返回非空但保存后没生效，成败以读回为准）。
			// 只验证能可靠读回的字段：newNet → getState_Net
			const readback: Array<{ id: string, net?: string, verified: boolean }> = []
			if (property.net != null && modified.length) {
				await new Promise(resolve => setTimeout(resolve, 400))
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const id of [...modified]) {
					const found = wires.find(w => safeState<string>(w, 'getState_PrimitiveId') === id)
					const actualNet = found ? safeState<string>(found, 'getState_Net') : undefined
					const ok = actualNet != null && actualNet === property.net
					readback.push({ id, net: actualNet ?? null as any, verified: ok })
					if (!ok) {
						modified.splice(modified.indexOf(id), 1)
						failedIds.push(id)
					}
				}
			}
			return { modified, failed: failedIds, ...(readback.length ? { readback } : {}) }
		},
	},
	{
		name: 'schematic.dedupeWireNets',
		summary: '一键清理"导线有多个网络名: X、X、X"警告（v2 重建法：NET 属性重复的导线拆段→无名重画→统一命名单一名称；官方 modify(net) 无法删除重复属性，唯一有效手段）',
		params: [],
		returns: '{ dupWires, rebuilt, renamed, skippedDiagonal, failed? }',
		example: { cmd: 'schematic.dedupeWireNets' },
		handler: async () => {
			const wires = await eda.sch_PrimitiveWire.getAll()
			// 1. 找出 NET 属性重复的导线（每根导线正常只应有 1 个 NET 属性）
			const dup: Array<{ id: string, net: string, line: Array<number> }> = []
			for (const w of wires ?? []) {
				const id = w.getState_PrimitiveId?.()
				const line = w.getState_Line?.()
				if (!id || !line)
					continue
				const attrs = await eda.sch_PrimitiveAttribute.getAll(id)
				const netAttrs = (attrs ?? []).filter(a => a.getState_Key?.() === 'NET')
				if (netAttrs.length > 1) {
					dup.push({
						id,
						net: netAttrs[0].getState_Value?.() ?? w.getState_Net?.() ?? '',
						line: line as Array<number>,
					})
				}
			}
			if (!dup.length)
				return { dupWires: 0, rebuilt: 0, renamed: 0, skippedDiagonal: 0 }
			// 2. 折线拆成简单段（去重归一；跳过非水平/垂直的 T 形分支编码伪段）
			let skippedDiagonal = 0
			const segsByNet = new Map<string, Array<[number, number, number, number]>>()
			for (const w of dup) {
				const pts: Array<[number, number]> = []
				for (let i = 0; i + 1 < w.line.length; i += 2)
					pts.push([Number(w.line[i]), Number(w.line[i + 1])])
				const norm = new Set<string>()
				const list = segsByNet.get(w.net) ?? []
				for (let i = 0; i + 1 < pts.length; i++) {
					const [x1, y1] = pts[i]
					const [x2, y2] = pts[i + 1]
					if (x1 === x2 && y1 === y2)
						continue
					if (x1 !== x2 && y1 !== y2) {
						skippedDiagonal += 1
						continue // 分支编码伪段：两端点必被正交段连通
					}
					const key = `${Math.min(x1, x2)},${Math.min(y1, y2)},${Math.max(x1, x2)},${Math.max(y1, y2)}`
					if (norm.has(key))
						continue
					norm.add(key)
					list.push([x1, y1, x2, y2])
				}
				segsByNet.set(w.net, list)
			}
			// 3. 删除重复导线
			await eda.sch_PrimitiveWire.delete(dup.map(w => w.id))
			// 4. 无名重画（官方会自动把相连段合并成新导线）
			let rebuilt = 0
			const failedSegs: Array<Array<number>> = []
			for (const segs of segsByNet.values()) {
				for (const [x1, y1, x2, y2] of segs) {
					const wire = await eda.sch_PrimitiveWire.create([x1, y1, x2, y2])
					if (wire)
						rebuilt += 1
					else
						failedSegs.push([x1, y1, x2, y2])
				}
			}
			// 5. 按几何归属给无名新导线命名（点集唯一命中某网络才命名）
			const netPts = new Map<string, Set<string>>()
			for (const [net, segs] of segsByNet) {
				const s = netPts.get(net) ?? new Set<string>()
				for (const [x1, y1, x2, y2] of segs) {
					s.add(`${x1},${y1}`)
					s.add(`${x2},${y2}`)
				}
				netPts.set(net, s)
			}
			let renamed = 0
			const unnamedLeft: Array<string> = []
			const after = await eda.sch_PrimitiveWire.getAll()
			for (const w of after ?? []) {
				if (w.getState_Net?.())
					continue
				const line = w.getState_Line?.() ?? []
				const pts = new Set<string>()
				for (let i = 0; i + 1 < line.length; i += 2)
					pts.add(`${line[i]},${line[i + 1]}`)
				const hits = [...netPts.entries()].filter(([, s]) =>
					[...pts].every(p => s.has(p)))
				if (hits.length === 1 && pts.size) {
					const id = w.getState_PrimitiveId?.()
					if (id && await eda.sch_PrimitiveWire.modify(id, { net: hits[0][0] }))
						renamed += 1
				}
				else if (pts.size) {
					unnamedLeft.push(w.getState_PrimitiveId?.() ?? '?')
				}
			}
			return {
				dupWires: dup.length,
				rebuilt,
				renamed,
				skippedDiagonal,
				...(failedSegs.length ? { failedSegs } : {}),
				...(unnamedLeft.length ? { unnamedLeft } : {}),
			}
		},
	},
	{
		name: 'schematic.repairNet',
		summary: '碎网修复宏（一条命令完成审计→补标签→前后对比）：人工拖动网络标签等原因导致网络断裂后用它收尾。流程：① adoptWireIds 先把无名残线归入网络；② 找出"属于该网络但没有名字属性"的导线并自动补网络标签（自动 ±2 微偏+附着验证）；③ 网表前后成员对比。顽固的重复属性导线请先用 dedupeWireNets 或删线重画',
		params: [
			{ name: 'net', type: 'string', required: true, description: '要修复的网络名，如 VOUT' },
			{ name: 'adoptWireIds', type: 'string[]', description: '先把这些无名导线命名归入该网络（等价逐条 setWireNet），再补标签' },
			{ name: 'dryRun', type: 'boolean', description: '只审计不改动，默认 false' },
		],
		returns: '{ before: { members, count }, after: { members, count }, wiresOfNet, labelsBefore, floatingLabels, adopted, placedLabels, failedLabels, repaired }（repaired=true 表示成员数有增长或持平且已无无名导线）',
		example: { cmd: 'schematic.repairNet', params: { net: 'VOUT' } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			const net = String(params.net)
			const dryRun = Boolean(params.dryRun)

			// --- 网表成员审计（0.10.45 起带回退：getNetlistFile 返空时自动用 PADS 文本网表，GPT -05） ---
			const getNetMembers = async (): Promise<Array<string>> => {
				const map = await pinNetMapRobust()
				if (!map)
					throw new Error('网表读取失败：getNetlistFile 与 PADS 文本回退均不可用（如器件缺封装——04 实测因果；可先 schematic.runDrcDetailed 查致命项）')
				return [...map].filter(([, n]) => n === net).map(([refPin]) => refPin).sort()
			}

			// --- 网络标签盘点（附着 + 浮空） ---
			const scanLabels = async () => {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const labels: Array<{ primitiveId: string, wireId: string, x?: number, y?: number }> = []
				const floating: Array<{ primitiveId: string, x?: number, y?: number }> = []
				const wireIds = new Set<string>()
				for (const w of wires) {
					const wid = safeState<string>(w, 'getState_PrimitiveId')
					if (wid)
						wireIds.add(wid)
				}
				for (const w of wires) {
					const wid = safeState<string>(w, 'getState_PrimitiveId')
					if (!wid)
						continue
					let attrs: Array<any> = []
					try {
						attrs = (await eda.sch_PrimitiveAttribute.getAll(wid)) ?? []
					}
					catch {
						continue
					}
					for (const a of attrs) {
						const key = safeState<string>(a, 'getState_Key') ?? ''
						if (!/^(NET|Name)$/i.test(key))
							continue
						if (safeState<string>(a, 'getState_Value') !== net)
							continue
						labels.push({
							primitiveId: safeState<string>(a, 'getState_PrimitiveId') ?? '',
							wireId: wid,
							x: safeState<number>(a, 'getState_X'),
							y: safeState<number>(a, 'getState_Y'),
						})
					}
				}
				// 浮空标签：父图元不是导线的同名属性
				try {
					const all = (await eda.sch_PrimitiveAttribute.getAll()) ?? []
					const attachedIds = new Set(labels.map(l => l.primitiveId))
					for (const a of all) {
						const key = safeState<string>(a, 'getState_Key') ?? ''
						if (!/^(NET|Name)$/i.test(key))
							continue
						const value = safeState<string>(a, 'getState_Value') ?? ''
						if (value !== net)
							continue
						const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
						if (attachedIds.has(id))
							continue
						const parent = safeState<string>(a, 'getState_ParentPrimitiveId')
						if (parent && wireIds.has(parent))
							continue
						floating.push({
							primitiveId: id,
							x: safeState<number>(a, 'getState_X'),
							y: safeState<number>(a, 'getState_Y'),
						})
					}
				}
				catch {
					// 浮空扫描失败不阻断主流程
				}
				return { labels, floating }
			}

			// --- 属于该网络的导线及其名字属性状态 ---
			const scanWires = async () => {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const named: Array<{ id: string, line: Array<number>, hasNameAttr: boolean }> = []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const id = safeState<string>(w, 'getState_PrimitiveId')
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					if (!id)
						continue
					let hasNameAttr = false
					try {
						const attrs = (await eda.sch_PrimitiveAttribute.getAll(id)) ?? []
						hasNameAttr = attrs.some(a =>
							/^(NET|Name)$/i.test(safeState<string>(a, 'getState_Key') ?? '')
							&& safeState<string>(a, 'getState_Value') === net)
					}
					catch {
						// 属性读取失败按有名字处理，避免误补重复标签
						hasNameAttr = true
					}
					named.push({ id, line, hasNameAttr })
				}
				return named
			}

			const before = await getNetMembers()

			// ① 收养无名残线
			const adopted: Array<string> = []
			const adoptFailed: Array<string> = []
			if (!dryRun && Array.isArray(params.adoptWireIds)) {
				for (const wid of params.adoptWireIds) {
					try {
						if (await eda.sch_PrimitiveWire.modify(String(wid), { net }))
							adopted.push(String(wid))
						else
							adoptFailed.push(String(wid))
					}
					catch {
						adoptFailed.push(String(wid))
					}
				}
			}

			// ② 给缺名字属性的导线补标签
			const wires = await scanWires()
			const missing = wires.filter(w => !w.hasNameAttr)
			const placedLabels: Array<{ wireId: string, x: number, y: number }> = []
			const failedLabels: Array<{ wireId: string, x: number, y: number, reason: string }> = []
			if (!dryRun) {
				for (const w of missing) {
					// 锚点取第一段中点（placeNetLabel 同款 ±2 自动微偏）
					const line = w.line
					if (line.length < 2)
						continue
					const mx = line.length >= 4 ? Math.round((line[0] + line[2]) / 2) : line[0]
					const my = line.length >= 4 ? Math.round((line[1] + line[3]) / 2) : line[1]
					let ok = false
					let lastErr = ''
					for (const [dx, dy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
						try {
							const label = await (eda.sch_PrimitiveAttribute as any).createNetLabel(mx + dx, my + dy, net)
							if (label) {
								ok = true
								break
							}
						}
						catch (e: any) {
							lastErr = e?.message ?? String(e)
						}
					}
					if (ok)
						placedLabels.push({ wireId: w.id, x: mx, y: my })
					else
						failedLabels.push({ wireId: w.id, x: mx, y: my, reason: lastErr || '官方返回空（±2 微偏均被拒）' })
				}
				// 等官方合并/附着计算稳定
				if (placedLabels.length)
					await new Promise(resolve => setTimeout(resolve, 800))
			}

			const { labels, floating } = await scanLabels()
			const after = dryRun ? before : await getNetMembers()
			return {
				before: { members: before, count: before.length },
				after: { members: after, count: after.length },
				wiresOfNet: wires.length,
				wiresMissingName: missing.map(w => w.id),
				labelsBefore: labels.length,
				floatingLabels: floating,
				adopted,
				...(adoptFailed.length ? { adoptFailed } : {}),
				placedLabels,
				failedLabels,
				dryRun,
				repaired: !dryRun && after.length >= before.length && missing.length === placedLabels.length,
			}
		},
	},
	{
		name: 'schematic.getComponentsInRect',
		summary: '查询落在指定矩形（功能区块框）内的器件——按区框批量选择/搬移/核对分区归属用。锚点判定：器件原点 (x,y) 落在 span 内即计入',
		params: [
			{ name: 'rectId', type: 'string', description: '区框矩形图元 ID（与显式 span 二选一）' },
			{ name: 'x1', type: 'number', description: 'span 左下 X（10mil，+Y 向上世界坐标）' },
			{ name: 'y1', type: 'number', description: 'span 左下 Y' },
			{ name: 'x2', type: 'number', description: 'span 右上 X' },
			{ name: 'y2', type: 'number', description: 'span 右上 Y' },
			{ name: 'margin', type: 'number', description: 'span 四向外扩余量（10mil，默认 0）' },
		],
		returns: '{ span, count, components: [{ primitiveId, designator, name, x, y, rotation }] }',
		example: { cmd: 'schematic.getComponentsInRect', params: { rectId: 'xxx' } },
		handler: async (params) => {
			let span: { x1: number, y1: number, x2: number, y2: number } | undefined
			if (params.rectId) {
				const rects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				for (const r of rects) {
					if (safeState<string>(r, 'getState_PrimitiveId') !== String(params.rectId))
						continue
					const x = safeState<number>(r, 'getState_TopLeftX')
					const y = safeState<number>(r, 'getState_TopLeftY')
					const w = safeState<number>(r, 'getState_Width')
					const h = safeState<number>(r, 'getState_Height')
					if (x == null || y == null || w == null || h == null)
						throw new Error('矩形几何数据读取失败')
					// +Y 向上：左上点 y 是上沿，下沿 = y - height
					span = { x1: x, y1: y - h, x2: x + w, y2: y }
					break
				}
				if (!span)
					throw new Error(`未找到矩形 ${params.rectId}（用 schematic.listRects 查 ID）`)
			}
			else if (params.x1 != null && params.y1 != null && params.x2 != null && params.y2 != null) {
				span = {
					x1: Math.min(Number(params.x1), Number(params.x2)),
					y1: Math.min(Number(params.y1), Number(params.y2)),
					x2: Math.max(Number(params.x1), Number(params.x2)),
					y2: Math.max(Number(params.y1), Number(params.y2)),
				}
			}
			else {
				throw new Error('缺少参数：给 rectId 或显式 span（x1/y1/x2/y2）')
			}
			const margin = params.margin != null ? Number(params.margin) : 0
			span = { x1: span.x1 - margin, y1: span.y1 - margin, x2: span.x2 + margin, y2: span.y2 + margin }
			const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
			const inside = comps.map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				name: safeState<string>(c, 'getState_Name'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
				rotation: safeState<number>(c, 'getState_Rotation'),
			})).filter(c =>
				typeof c.x === 'number' && typeof c.y === 'number'
				&& c.x >= span!.x1 && c.x <= span!.x2 && c.y >= span!.y1 && c.y <= span!.y2)
			return { span, count: inside.length, components: inside }
		},
	},
	{
		name: 'schematic.buildBlock',
		summary: '【宏】按 AI 提供的器件清单+连接表自动生成一个功能区电路：自动平铺区框（默认从 0,0 起排，间隙 5）→ 行列排布器件 → 按 nets 连线 → 网表+DRC 自查。0.10.14 起连线层切换到 batchWire 语义化引擎（labelWire 短桩+标签带假失败 ghost 检查/占用预检/NC 预检，linkWire U 形防共线动态错层，batchWire 逐条收错+一次网表统一审计），0.9.x 自绘连线逻辑已删除。布局模板为 cw32-style（器件横距 60、行距 90、短桩长 20、标题在框底居中字号 20、区框默认黑色虚线可用 color/lineType 自定义）',
		params: [
			{ name: 'components', type: 'array', required: true, description: '器件清单 [{ ref, lcscId?, deviceUuid?, libraryUuid?, rotation?, mirror? }]，ref 是连接表里引用的名字（如 U1/C1），nets 里的引脚按 "ref.引脚号" 引用' },
			{ name: 'nets', type: 'array', required: true, description: '连接表 [{ name, pins: ["U1.7","C1.1"], style?: "wire"|"label", color?: "#FF0000" }]。style 缺省自动：2 个引脚 wire 直连，≥3 个或电源类网络（GND/VCC/VDD/VIN/VOUT/3V3/5V 等）label 短桩+标签；color 会同时作用于导线和标签' },
			{ name: 'region', type: 'object', description: '区框 { x, y, width, height, title, color, lineType }（x,y 为左下角；color 默认黑色 #000000，lineType 默认 dashed 虚线）。留空则自动估算尺寸并从 (0,0) 起自动平铺到页面空位' },
			{ name: 'title', type: 'string', description: '区标题（region 留空时用它）' },
			{ name: 'color', type: 'string', description: '区框颜色（region 留空时用它），默认 #000000 黑色' },
			{ name: 'skipAudit', type: 'boolean', description: '跳过收尾网表/DRC 自查（默认 false）' },
		],
		returns: '{ region: { rectId, span }, placed: [{ ref, primitiveId, designator, x, y }], nets: [{ name, style, wired?/labeled?, ok?, error?/incomplete?, missing? }], drc, wireAudit, failed }（网表审计由 batchWire 统一完成，明细在 wireAudit）',
		example: { cmd: 'schematic.buildBlock', params: { title: '电源滤波', components: [{ ref: 'C1', lcscId: 'C23138' }], nets: [{ name: 'VDD', pins: ['C1.1'] }, { name: 'GND', pins: ['C1.2'] }] } },
		handler: async (params) => {
			if (!Array.isArray(params.components) || !params.components.length)
				throw new Error('缺少参数 components（器件清单数组）')
			if (!Array.isArray(params.nets))
				throw new Error('缺少参数 nets（连接表数组，可为空数组）')

			// ---------- ① 区框：显式或自动平铺 ----------
			const n = params.components.length
			const estW = Math.max(170, Math.ceil(Math.sqrt(n * 1.6)) * 60 + 60)
			const estH = Math.max(150, Math.ceil(n / Math.max(1, Math.floor(estW / 60))) * 90 + 70)
			const rg = params.region as Record<string, unknown> | undefined
			let rx = rg?.x != null ? Number(rg.x) : undefined
			let ry = rg?.y != null ? Number(rg.y) : undefined
			const rw = rg?.width != null ? Number(rg.width) : estW
			const rh = rg?.height != null ? Number(rg.height) : estH
			const title = String(rg?.title ?? params.title ?? '功能区')
			// 自动平铺：从 (0,0) 起扫描现有矩形找空位（行优先，行内贴最右，间隙 5）
			if (rx == null || ry == null) {
				const rects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				const spans = rects.map(r => {
					const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
					const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
					const w = safeState<number>(r, 'getState_Width') ?? 0
					const h = safeState<number>(r, 'getState_Height') ?? 0
					return { x1: x, y1: y - h, x2: x + w, y2: y }
				})
				const PAGE_W = 1170
				let placed = false
				let bandY = 0
				for (let guard = 0; guard < 20 && !placed; guard++) {
					const band = spans.filter(s => s.y1 < bandY + rh && s.y2 > bandY).sort((a, b) => a.x1 - b.x1)
					let cursor = 0
					for (const s of band) {
						if (s.x1 - cursor >= rw) {
							rx = cursor; ry = bandY; placed = true; break
						}
						cursor = Math.max(cursor, s.x2 + 5)
					}
					if (!placed && cursor + rw <= PAGE_W) {
						rx = cursor; ry = bandY; placed = true
					}
					if (!placed)
						bandY = Math.max(...band.map(s => s.y2), bandY) + 5
				}
				if (!placed)
					throw new Error('页面内找不到足够空位放置区框，请显式传 region')
			}
			const span = { x1: rx!, y1: ry!, x2: rx! + rw, y2: ry! + rh }

			// 画区框（cw32-style：虚线框 + 框底居中标题字号 20；颜色默认黑色，可自定义）
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const regionColor = String(rg?.color ?? params.color ?? '#000000')
			const regionLineType = (lineTypeMap[String(rg?.lineType ?? 'dashed')] ?? 1) as any
			const rect = await eda.sch_PrimitiveRectangle.create(rx!, ry! + rh, rw, rh, undefined, undefined, regionColor, undefined, undefined, regionLineType, undefined)
			if (!rect)
				throw new Error('区框矩形创建失败（可能当前打开的不是原理图）')
			const rectId = safeState<string>(rect, 'getState_PrimitiveId')
			let titleW = 0
			for (const ch of title)
				titleW += /[⺀-鿿　-〿＀-￯]/.test(ch) ? 20 : 11
			await eda.sch_PrimitiveText.create(
				Math.round(span.x1 + (rw - titleW) / 2), span.y1 + 5,
				title, undefined, undefined, undefined, 20, true,
			)

			// ---------- ② 行列排布放器件 ----------
			const innerX = span.x1 + 40
			const innerRight = span.x2 - 20
			const colStep = 60
			const rowStep = 90
			let cx = innerX
			let cy = span.y2 - 50
			const placed: Array<{ ref: string, primitiveId?: string, designator?: string, x: number, y: number, error?: string, designatorNote?: string }> = []
			for (const comp of params.components as Array<Record<string, unknown>>) {
				const ref = String(comp.ref ?? '')
				if (!ref) {
					placed.push({ ref: '?', x: 0, y: 0, error: '缺少 ref' })
					continue
				}
				let deviceRef: { libraryUuid: string, uuid: string } | undefined
				if (comp.lcscId) {
					const items = await eda.lib_Device.getByLcscIds([String(comp.lcscId)])
					if (!items?.[0]) {
						placed.push({ ref, x: 0, y: 0, error: `未找到立创编号 ${comp.lcscId}` })
						continue
					}
					deviceRef = { libraryUuid: items[0].libraryUuid, uuid: items[0].uuid }
				}
				else if (comp.deviceUuid && comp.libraryUuid) {
					deviceRef = { libraryUuid: String(comp.libraryUuid), uuid: String(comp.deviceUuid) }
				}
				else {
					placed.push({ ref, x: 0, y: 0, error: '需要 lcscId 或 deviceUuid+libraryUuid' })
					continue
				}
				const created = await eda.sch_PrimitiveComponent.create(
					deviceRef, cx, cy, undefined,
					comp.rotation != null ? Number(comp.rotation) : undefined,
					comp.mirror != null ? Boolean(comp.mirror) : undefined,
					true, true,
				)
				if (!created) {
					placed.push({ ref, x: cx, y: cy, error: '官方返回空' })
					continue
				}
				const newId = safeState<string>(created, 'getState_PrimitiveId')
				// 位号落地（0.10.17 缺陷修复）：lcscId 放置后位号是占位符 "R?"/"C?"，
				// 连线引擎按位号解析引脚会得到 "R?.2" 被格式校验拒绝——放置后立刻把用户 ref 落为真实位号。
				// 官方 modify 有假失败前科：改完读回 getState_Designator 验证，失败如实记录（连线改用读回值）。
				let actualDesignator = safeState<string>(created, 'getState_Designator')
				let designatorNote: string | undefined
				if (newId && actualDesignator !== ref) {
					try {
						const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(newId)
						const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
						const desAttr = (attrs ?? []).find(a => safeState<string>(a, 'getState_Key') === 'Designator')
						const desAttrId = desAttr ? safeState<string>(desAttr, 'getState_PrimitiveId') : undefined
						if (desAttrId) {
							await eda.sch_PrimitiveAttribute.modify(desAttrId, { value: ref })
							// 读回验证（不信 modify 返回值）
							const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
							const me = comps.find(c => safeState<string>(c, 'getState_PrimitiveId') === newId)
							const readBack = me ? safeState<string>(me, 'getState_Designator') : undefined
							if (readBack === ref)
								actualDesignator = ref
							else
								designatorNote = `位号改写读回为 ${readBack ?? '(读不到)'}，期望 ${ref}——官方假失败或位号冲突，连线将按读回位号进行`
						}
						else
							designatorNote = '器件上没有 Designator 属性图元，位号未改写'
					}
					catch (e: any) {
						designatorNote = `位号改写抛错 ${String(e?.message ?? e)}`
					}
				}
				placed.push({
					ref,
					primitiveId: newId,
					designator: actualDesignator,
					x: cx, y: cy,
					...(designatorNote ? { designatorNote } : {}),
				})
				cx += colStep
				if (cx > innerRight) {
					cx = innerX
					cy -= rowStep
				}
			}

			// ---------- ③ （0.10.14 起删除）引脚坐标读回已由 labelWire/linkWire 内部的 resolvePinPoint 按位号实时解析 ----------

			// ---------- ④ 按连接表连线（0.10.14 起切换到 batchWire 语义化引擎）----------
			// 0.9.x 时代的自绘连线层（自画 U 形导线/自放标签/stubSegs 防撞登记/横腿按序号错层）已删除——
			// labelWire/linkWire 内部已有更新且实测打磨过的防护，对照 0.9.9 三类共线陷阱：
			//  ① 相邻器件短桩同间隙共线重叠 → labelWire 短桩四方向防撞（背离本体→上→下→反向），
			//     桩终点 8 单位内有其他引脚或与现有导线共线即换向，另有 findWireNetsAtPoint 占用预检；
			//  ② 同行引脚共线被直线/L 走线穿过 → linkWire 一律 U 形绕行；
			//  ③ 多网络横腿同深度共线 → linkWire 横腿深度从 30 起每次 +15 试 8 层动态避让现有导线。
			// 另免费获得：createNetLabel 假失败 ghost 双路检查、NC 引脚预检（逐条收错不中断）、一次网表统一审计。
			// 电源网判定（0.10.18 起允许全大写后缀；0.10.19 起抽到模块级 isPowerNetName 共享）
			const isPowerNet = isPowerNetName
			// 用户 ref → 实际位号映射（labelWire/linkWire 按位号在页面解析引脚）
			const designatorOf = new Map<string, string>()
			for (const p of placed) {
				if (p.primitiveId)
					designatorOf.set(p.ref, p.designator ?? p.ref)
			}
			const resolveRef = (pinRef: string): string => {
				const dot = pinRef.indexOf('.')
				if (dot < 0)
					return pinRef
				const ref = pinRef.slice(0, dot)
				return `${designatorOf.get(ref) ?? ref}${pinRef.slice(dot)}`
			}
			const netResults: Array<Record<string, unknown>> = []
			const failed: Array<Record<string, unknown>> = []
			const batchItems: Array<Record<string, unknown>> = []
			const netItemIdx: Array<Array<number>> = [] // netResults[i] 对应的 batchItems 下标
			for (const netSpec of params.nets as Array<Record<string, unknown>>) {
				const netName = String(netSpec.name ?? '')
				const pinRefs = Array.isArray(netSpec.pins) ? (netSpec.pins as Array<string>).map(String) : []
				if (!netName || pinRefs.length < 1)
					continue
				// 放置失败/缺 ref 的引脚记 missing，不进接线项
				const missing = pinRefs.filter((pr) => {
					const dot = pr.indexOf('.')
					return dot < 0 || !designatorOf.has(pr.slice(0, dot))
				})
				const okRefs = pinRefs.filter(pr => !missing.includes(pr)).map(resolveRef)
				const style = netSpec.style != null
					? String(netSpec.style)
					: (okRefs.length <= 2 && !isPowerNet(netName) ? 'wire' : 'label')
				const netColor = netSpec.color != null ? String(netSpec.color) : undefined
				const idxs: Array<number> = []
				if (style === 'wire' && okRefs.length === 2) {
					idxs.push(batchItems.length)
					batchItems.push({ type: 'link', pins: okRefs, ...(netColor ? { color: netColor } : {}) })
				}
				else {
					// ≥3 引脚 / 电源类 / 显式 label：每引脚一个 label 项（短桩+标签）
					for (const pr of okRefs) {
						idxs.push(batchItems.length)
						batchItems.push({ type: 'label', pin: pr, net: netName, ...(netColor ? { color: netColor } : {}) })
					}
				}
				netResults.push({
					name: netName,
					style,
					...(style === 'wire' && okRefs.length === 2 ? { wired: okRefs } : { labeled: okRefs }),
					...(netColor ? { color: netColor } : {}),
					...(missing.length ? { missing } : {}),
				})
				netItemIdx.push(idxs)
				if (!okRefs.length)
					failed.push({ net: netName, reason: '全部引脚引用都无法解析（器件放置失败或缺 ref）' })
			}
			// 统一交给 batchWire 执行+审计（逐条收错不中断；NC 引脚被 assertPinConnectable 逐条拒，汇总进 failed）
			let wireAudit: Array<any> = []
			if (batchItems.length) {
				const batchCmd = schematicCommands.find(c => c.name === 'schematic.batchWire')
				if (!batchCmd)
					throw new Error('内部错误：batchWire 未注册')
				const br = await batchCmd.handler({
					items: batchItems,
					continueOnError: true,
					skipAudit: Boolean(params.skipAudit),
				}) as any
				wireAudit = br?.audit ?? []
				// 汇总回 nets 结构（保持对外兼容：name/style/wired/labeled/missing + 结果）
				const itemResults: Array<any> = br?.items ?? []
				for (let i = 0; i < netResults.length; i++) {
					const nr = netResults[i]
					const idxs = netItemIdx[i]
					const itemErrs = idxs.map(ix => itemResults[ix]).filter(r => r && !r.ok)
					const audits = idxs.map(ix => wireAudit.find((a: any) => a.index === ix)).filter(Boolean)
					const auditBad = audits.filter((a: any) => a.pass === false)
					if (itemErrs.length) {
						nr.ok = false
						nr.error = itemErrs.map((r: any) => r.error).join('；')
						for (const r of itemErrs) {
							const it = r.item ?? {}
							failed.push({ net: nr.name, ...(it.pin ? { pin: it.pin } : it.pins ? { pins: it.pins } : {}), reason: r.error })
						}
					}
					else if (auditBad.length) {
						nr.ok = false
						nr.incomplete = auditBad.map((a: any) => a.detail).join('；')
					}
					else if (audits.some((a: any) => a.pass === undefined)) {
						nr.ok = undefined // 审计未能执行（skipAudit 或网表导出失败）
					}
					else if (idxs.length)
						nr.ok = true
				}
			}

			// ---------- ⑤ 收尾自查：DRC 聚合（网表审计已由 batchWire 统一完成）----------
			let audit: Record<string, unknown> | undefined
			if (!params.skipAudit) {
				try {
					const drcRaw = await eda.sch_Drc.check(true, false, true)
					const drcGroups = Array.isArray(drcRaw) ? drcRaw : []
					const drcTotal = drcGroups.reduce((s: number, e: any) => s + (typeof e?.count === 'number' ? e.count : 1), 0)
					audit = {
						drc: { totalCount: drcTotal, groups: drcGroups, note: '明细见 EDA 输出面板' },
						wireAudit, // batchWire 统一网表审计明细（逐条 pass/detail）
					}
				}
				catch (e: any) {
					audit = { auditError: e?.message ?? String(e), wireAudit }
				}
			}

			return {
				region: { rectId, span, title },
				placed,
				refMap: Object.fromEntries([...designatorOf.entries()]), // 用户 ref → 实际位号（连线按此解析）
				nets: netResults,
				...(failed.length ? { failed } : {}),
				...(audit ?? {}),
			}
		},
	},
	{
		name: 'schematic.setPinNoConnect',
		summary: '给器件引脚打/取消非连接标识（X 标记），用于声明引脚有意悬空，消除悬空引脚 DRC 提示',
		params: [
			{ name: 'componentId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'pinNumbers', type: 'array', required: true, description: '引脚编号数组，如 ["3","4","10"]' },
			{ name: 'noConnected', type: 'boolean', description: 'true=打 X（默认），false=取消 X' },
		],
		returns: '{ done: [成功引脚], failed: [未找到引脚] }',
		example: { cmd: 'schematic.setPinNoConnect', params: { componentId: 'xxx', pinNumbers: ['3', '4'] } },
		handler: async (params) => {
			if (!params.componentId)
				throw new Error('缺少参数 componentId')
			if (!Array.isArray(params.pinNumbers) || !params.pinNumbers.length)
				throw new Error('缺少参数 pinNumbers（数组）')
			const noConnected = params.noConnected !== false
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.componentId))
			if (!pins?.length)
				throw new Error('未找到该器件的引脚（请确认已激活原理图图页）')
			const wanted = new Set(params.pinNumbers.map(String))
			const done: Array<string> = []
			const failed: Array<string> = []
			for (const num of wanted) {
				const pin = pins.find(p => String(p.getState_PinNumber?.()) === num)
				if (!pin) {
					failed.push(num)
					continue
				}
				const result = await (eda.sch_PrimitivePin as any).modify(pin, { noConnected })
				if (result === false)
					failed.push(num)
				else
					done.push(num)
			}
			return { done, failed }
		},
	},
	{
		name: 'schematic.getSelection',
		summary: '获取原理图当前选中的图元',
		params: [],
		returns: '选中图元的 primitiveId 列表',
		example: { cmd: 'schematic.getSelection' },
		handler: async () => {
			return await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId()
		},
	},
	{
		name: 'schematic.autoRoute',
		summary: '原理图自动连线（官方引擎，可指定器件 uuid 集合）',
		params: [
			{ name: 'uuids', type: 'string[]', description: '参与连线的器件 uuid，留空为全部' },
		],
		returns: '官方自动连线结果',
		example: { cmd: 'schematic.autoRoute', params: {} },
		handler: async (params) => {
			return await eda.sch_Document.autoRouting(
				params.uuids ? { uuids: params.uuids as Array<string> } : undefined,
			)
		},
	},
	{
		name: 'schematic.save',
		summary: '保存当前原理图',
		params: [],
		returns: '是否保存成功',
		example: { cmd: 'schematic.save' },
		handler: async () => {
			return { saved: await eda.sch_Document.save() }
		},
	},
	{
		name: 'schematic.getAttributes',
		summary: '读取器件/图元的全部属性（位号 Designator、封装、值等）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
		],
		returns: '[{ primitiveId, key, value }]',
		example: { cmd: 'schematic.getAttributes', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			const compId = String(params.primitiveId)
			const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(compId)
			const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
			return (attrs ?? []).map(a => ({
				primitiveId: safeState<string>(a, 'getState_PrimitiveId'),
				key: safeState<string>(a, 'getState_Key'),
				value: safeState<string>(a, 'getState_Value'),
			}))
		},
	},
	{
		name: 'schematic.setAttribute',
		summary: '修改器件属性（如把位号从 R? 改成 R4：key=Designator）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'key', type: 'string', required: true, description: '属性名，如 Designator / Value / Footprint' },
			{ name: 'value', type: 'string', required: true, description: '新属性值' },
		],
		returns: '{ key, value }',
		example: { cmd: 'schematic.setAttribute', params: { primitiveId: 'xxx', key: 'Designator', value: 'R4' } },
		handler: async (params) => {
			const compId = String(params.primitiveId)
			const key = String(params.key)
			const value = String(params.value)
			const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(compId)
			const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
			const target = (attrs ?? []).find(a => safeState<string>(a, 'getState_Key') === key)
			if (!target)
				throw new Error(`器件 ${compId} 上没有属性 ${key}`)
			const attrId = safeState<string>(target, 'getState_PrimitiveId')
			if (!attrId)
				throw new Error('读取属性图元 ID 失败')
			await eda.sch_PrimitiveAttribute.modify(attrId, { value })
			// 读回验证（官方 modify 假成功前科，0.10.23：成败以读回为准）
			await new Promise(resolve => setTimeout(resolve, 300))
			const back = await eda.sch_PrimitiveAttribute.get(attrId)
			const actual = back ? safeState<string>(back as any, 'getState_Value') : undefined
			const verified = actual != null && actual === value
			if (!verified)
				throw new Error(`属性 ${key} 修改未生效：读回实际为「${actual ?? '(读取失败)'}」，目标「${value}」——官方 modify 假成功，请重试`)
			return { key, value, readback: { value: actual, verified } }
		},
	},
	{
		name: 'schematic.moveComponent',
		summary: '移动 / 旋转 / 镜像原理图器件',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'x', type: 'number', description: '新坐标 X（单位 10mil）' },
			{ name: 'y', type: 'number', description: '新坐标 Y（单位 10mil）' },
			{ name: 'rotation', type: 'number', description: '旋转角度（0/90/180/270）' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像' },
		],
		returns: '{ modified }',
		example: { cmd: 'schematic.moveComponent', params: { primitiveId: 'xxx', x: 400, y: 300, rotation: 90 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.x != null)
				property.x = Number(params.x)
			if (params.y != null)
				property.y = Number(params.y)
			if (params.rotation != null)
				property.rotation = Number(params.rotation)
			if (params.mirror != null)
				property.mirror = Boolean(params.mirror)
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性（x / y / rotation / mirror）')
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——位置 / 旋转 / 镜像各自独立步骤
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
			if (property.mirror != null)
				compSteps.push({ mirror: property.mirror })
			let result: any
			for (const stepProps of compSteps) {
				try {
					const r = await eda.sch_PrimitiveComponent.modify(String(params.primitiveId), stepProps as any)
					if (r)
						result = r
				}
				catch { /* 假失败不轻信，读回为准 */ }
			}
			// 读回验证（0.10.23：官方返回值不可信，能读回的字段逐一核对，读回不符如实报）
			const readback: Record<string, unknown> = {}
			let verified = true
			if (result) {
				await new Promise(resolve => setTimeout(resolve, 300))
				try {
					const back = await eda.sch_PrimitiveComponent.get(String(params.primitiveId))
					if (back) {
						const checks: Array<[string, string, number]> = []
						if (property.x != null)
							checks.push(['x', 'getState_X', property.x])
						if (property.y != null)
							checks.push(['y', 'getState_Y', property.y])
						if (property.rotation != null)
							checks.push(['rotation', 'getState_Rotation', property.rotation])
						for (const [field, getter, want] of checks) {
							const actual = safeState<number>(back as any, getter)
							readback[field] = actual ?? null
							if (actual == null || Math.abs(actual - want) > 0.5)
								verified = false
						}
					}
					else {
						verified = false
					}
				}
				catch {
					verified = false
				}
			}
			if (result && !verified)
				throw new Error(`器件 ${params.primitiveId} 移动/旋转读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: Boolean(result), ...(Object.keys(readback).length ? { readback: { ...readback, verified } } : {}) }
		},
	},
	{
		name: 'schematic.delete',
		summary: '删除原理图图元（器件 / 导线 / 文本 / 网络标签等属性，按 primitiveId，可批量）；先识别类型再删，删后读回验证，杜绝假成功。0.10.23 加固（GPT 现场：34 组删除首步 25s 超时假失败、后台继续删 3 分钟、2 个目标被越过残留）：逐项 8s 超时熔断、连续 3 失败熔断整批、batchSize 分批（默认 10，批间停 300ms）、全局时间预算 100s（耗尽停开新项、累积结果照常返回）、unprocessed 清单可续删',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '要删除的图元 ID 列表（也兼容单数 primitiveId，自动转数组）' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 10：每批之间停 300ms 并记录分批进度。大批删除建议保持默认多次调用，不要一次调大硬跑' },
		],
		returns: '{ taskId, deleted: [...], failed: [...], deletedBy: { id: type }, reconciled?, sessionHealth?, batches?, unprocessed?, failedNote? }（taskId 可配合 task.get 在客户端超时后查进度/补取结果——0.10.42 起同参数任务在跑时重发只回进度不重复执行；unprocessed 为熔断/预算退出时未轮到的 ID，再次调用接着删；0.10.25 起整批结束后终扫对账：报失败但实际已被后台删除的项挪入 deleted 并在 reconciled 注明，终扫仍存在的 failed 附 failedNote 续删提示；0.10.27 起出现过 reconciled/failed 时追加会话健康探针 sessionHealth: ok|degraded|inconclusive，degraded 建议只读复核后再决定是否不保存重开页面，inconclusive 为探针未得出可信结论（不采信）；0.10.40 起探针加固：焦点复核+3 次重试+创建/删除读回，删除异常时报 probeResidue 残留探针 ID）',
		example: { cmd: 'schematic.delete', params: { primitiveIds: ['xxx', 'yyy'] } },
		handler: async (params, ctx) => {
			// 兼容单数 primitiveId（自动转数组）
			const raw = params.primitiveIds ?? params.primitiveId
			const ids = Array.isArray(raw)
				? raw.map(String)
				: raw != null ? [String(raw)] : []
			if (!ids.length)
				throw new Error('缺少参数 primitiveIds（数组）或 primitiveId（单个 ID）')
			// 0.10.42 任务登记（KIMI-EDA-20261002-03）：客户端超时后可凭 taskId 查实时进度/补取结果；
			// 相同 ID 清单的任务仍在跑时直接返回现有进度，不重复执行（防盲重发）
			// 0.10.49：onUpdate 心跳——任务进度每次更新都推给代理，重置其超时计时器
			const { task, existing } = beginTask('schematic.delete', { primitiveIds: [...ids].sort() },
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
			// 官方 delete 对不匹配的 ID 也可能返回 true（假成功），
			// 必须先按 getAllPrimitiveId 成员判定识别真实类型，删后再次读回验证
			const kinds: Array<{
				type: string
				list: () => Promise<Array<string>>
				del: (list: Array<string>) => Promise<boolean>
			}> = [
				{ type: 'component', list: () => eda.sch_PrimitiveComponent.getAllPrimitiveId(), del: list => eda.sch_PrimitiveComponent.delete(list) },
				{ type: 'wire', list: () => eda.sch_PrimitiveWire.getAllPrimitiveId(), del: list => eda.sch_PrimitiveWire.delete(list) },
				// 文本：类级 delete 实测不持久（0.10.53 对照实验：删→save(saved:true)→关开重读 TEXT 复活，同批导线删除正常持久）——
				// 0.10.54 改实例级 get+delete() 后实测仍复活（t_text_fix_verify.json）——两条官方路径都不落盘，根因在宿主文档模型。
				// 0.10.55：两条路都试且全程诊断（通道A实例级/通道B类级，每步模型读回），结果进 lane-log 供根因定位
				{ type: 'text', list: () => eda.sch_PrimitiveText.getAllPrimitiveId(), del: async (list) => {
					let any = false
					for (const id of list) {
						let channel = 'none'
						// 通道A：实例级 get + delete()
						try {
							const inst = await eda.sch_PrimitiveText.get(id)
							if (inst && typeof (inst as any).delete === 'function') {
								await (inst as any).delete()
								channel = 'instance'
							}
							else
								diag('schematic.delete', 'text-delete', `${id} 通道A: get 到实例但无 delete 方法`)
						}
						catch (e) {
							diag('schematic.delete', 'text-delete', `${id} 通道A实例级抛错: ${String((e as any)?.message ?? e)}`)
						}
						// 通道A 模型读回
						let gone = false
						try {
							gone = !(await eda.sch_PrimitiveText.getAllPrimitiveId()).includes(id)
						}
						catch { /* 读回失败按未知处理 */ }
						diag('schematic.delete', 'text-delete', `${id} 通道A(${channel}) 后模型读回: ${gone ? '已消失' : '仍在'}`)
						// 通道B：类级 delete([id])
						if (!gone) {
							try {
								if (await eda.sch_PrimitiveText.delete([id]))
									channel = 'class'
								diag('schematic.delete', 'text-delete', `${id} 通道B类级 delete 返回 ${channel === 'class'}`)
							}
							catch (e) {
								diag('schematic.delete', 'text-delete', `${id} 通道B类级抛错: ${String((e as any)?.message ?? e)}`)
							}
						}
						if (channel !== 'none')
							any = true
					}
					return any
				} },
				{ type: 'rectangle', list: () => eda.sch_PrimitiveRectangle.getAllPrimitiveId(), del: list => eda.sch_PrimitiveRectangle.delete(list) },
				// 属性（网络标签等）：官方没有类级 delete，必须 get 到实例后调实例方法 delete()
				{ type: 'attribute', list: () => eda.sch_PrimitiveAttribute.getAllPrimitiveId(), del: async (list) => {
					let any = false
					for (const id of list) {
						try {
							const attr = await eda.sch_PrimitiveAttribute.get(id)
							if (attr && typeof (attr as any).delete === 'function') {
								(attr as any).delete()
								any = true
							}
						}
						catch { /* 单个失败继续 */ }
					}
					return any
				} },
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
			let floatDiag: Array<string> | undefined
			// 0.10.23 加固（照抄 pruneFloatingLabels 0.10.12 成熟机制）：
			//  ① 逐项 8s Promise.race 超时熔断——官方 API 偶尔永不 resolve（模态框/卡绘制），超时不拖死整批；
			//  ② 连续 3 项失败熔断整批（会话多半已损坏）；
			//  ③ 分批执行（batchSize 默认 10，批间停 300ms），返回分批进度，unprocessed 可再次调用续删；
			//  ④ 全局时间预算 100s：耗尽即停开新项，已累积结果照常返回（部分结果不丢）；
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
			diag('schematic.delete', 'delete-start', `total=${ids.length}`)
			// 单项删除全流程（类型识别 → 删除 → 读回验证），包 8s 超时熔断
			const deleteOne = async (id: string): Promise<void> => {
				let kind = await detectType(id)
				if (!kind) {
					// 浮空标签盲区补检：getAllPrimitiveId 各类清单都不含 parentId=$$root 的浮标，走源码扫描判定 + 浮标专用删除通道
					let isFloat = false
					try {
						isFloat = (await scanFloatingNetLabels()).some(f => String(f.primitiveId) === id)
					}
					catch { /* 扫描失败按未识别处理 */ }
					if (isFloat) {
						const r = await deleteFloatingLabels([id])
						if (r.deleted.length) {
							deletedBy[id] = 'floatingAttribute'
							return
						}
						floatDiag = r.diagnostics
						throw new Error('浮空标签删除通道未生效（读回仍在）')
					}
					throw new Error('图元不存在或类型暂不支持（各类型清单均未命中）')
				}
				await kind.del([id])
				// 删后读回验证（官方查询有缓存，递增等待重试；delete 布尔值不可信）
				let stillThere = true
				for (const waitMs of [400, 600, 1000]) {
					await new Promise(resolve => setTimeout(resolve, waitMs))
					stillThere = Boolean(await detectType(id))
					if (!stillThere)
						break
				}
				if (stillThere) {
					// 0.10.26（终验实锤：drawWire 命名自动落的 NET 属性标签删不掉，用户误以为 delete 失灵）——属性类给明确处置指引
					if (kind.type === 'attribute')
						throw new Error('属性图元官方不支持单独删除（pro-api-types 标注 @internal，导线持有的 NET/Name 属性随父导线存亡）——要消除这个标签请删整根父导线后重画（drawWire 不传 net 画无名线 + 需要时 placeNetLabel 补标签）')
					throw new Error('删后读回验证仍在（假成功）')
				}
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
					let itemError: string | undefined
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
						itemError = String(e?.message ?? e)
						failReason.set(id, itemError)
						diag('schematic.delete', 'item-failed', `${id}: ${itemError}`)
						failed.push(id)
						bFailed++
						consecutiveFails++
						diagnostics.push(`${id}: ${itemError}`)
						if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
							circuitBroken = true
							diagnostics.push(`⚠️ 连续 ${MAX_CONSECUTIVE_FAILS} 项失败（均以读回确认为准），熔断整批——会话可能已损坏，建议【不保存重开页面】后再分批重试`)
						}
					}
				}
				batches.push({ batch: batches.length + 1, attempted: batch.length, deleted: bDeleted, failed: bFailed })
				taskProgress(task, { stage: 'deleting', batches: [...batches], deleted: [...deleted], failed: [...failed], remaining: ids.length - attempted.size })
				diag('schematic.delete', 'batch-done', `第${batches.length}批 尝试${batch.length} 成${bDeleted} 败${bFailed} 熔断=${circuitBroken} 预算尽=${budgetExhausted}`)
			}
			const unprocessed = ids.filter(id => !attempted.has(id))
			// 0.10.25 终扫对账（0.10.24 装机实锤：4 个报「超时失败」的导线实际被官方后台删掉了——
			// 官方 delete 假超时/后台继续删，failed 口径偏保守）。整批结束（含熔断/预算耗尽路径）后
			// 重新全量枚举一次：已不存在的「失败」项挪到 deleted 并注明；仍存在的保留 failed 附 resumeNote
			// 0.10.41 口径修复：失败原因是「图元不存在/类型不支持」的 ID 从不存在，终扫必然查不到——
			// 不能当成「后台已删」对账进 deleted（0.10.40 装机实测：假 ID 被误挪），保持 failed 原样
			const reconciled: Array<{ id: string, note: string }> = []
			if (failed.length) {
				try {
					taskProgress(task, { stage: 'final-sweep' })
					diag('schematic.delete', 'final-sweep-start', `failed=${failed.length}`)
					await new Promise(resolve => setTimeout(resolve, 1500)) // 给后台删除一点落地时间
					const alive = new Set<string>()
					// 0.10.42：终扫枚举整体 20s 超时（旧版无保护，官方挂起时整批无返回）
					await withTimeout(Promise.all(kinds.map(async (k) => {
						try {
							for (const id of await k.list())
								alive.add(id)
						}
						catch { /* 单类清单失败不阻断 */ }
					})), 20000, '终扫枚举')
					// 浮空标签不在任何类清单里，需源码扫描补判（否则会误判浮标「已删」）
					let floatIds = new Set<string>()
					try {
						floatIds = new Set((await withTimeout(scanFloatingNetLabels(), 15000, '浮标源码扫描')).map(f => String(f.primitiveId)))
					}
					catch { /* 扫描失败按无浮标处理 */ }
					for (const id of [...failed]) {
						if ((failReason.get(id) ?? '').includes('不存在'))
							continue // 从不存在的 ID 不参与对账，保持 failed
						if (!alive.has(id) && !floatIds.has(id)) {
							failed.splice(failed.indexOf(id), 1)
							deleted.push(id)
							reconciled.push({ id, note: '超时返回但后台已删除，经终扫确认' })
						}
					}
					if (reconciled.length)
						diagnostics.push(`终扫对账：${reconciled.length} 个原报失败的 ID 已确认被后台删除（挪入 deleted）：${reconciled.map(r => r.id).join('、')}`)
				}
				catch { /* 终扫失败保持保守口径（failed 原样） */ }
			}
			// 0.10.52（KIMI-EDA-20261003-09）：终扫对账后刷新进度——此前 progress 停留在
			// final-sweep 前最后一帧 deleting，对账挪入 deleted 的进度不可见，调用方只见旧数
			taskProgress(task, { stage: 'final-sweep-done', deleted: deleted.length, failed: failed.length, reconciled: reconciled.length })
			diag('schematic.delete', 'final-sweep-done', `deleted=${deleted.length} failed=${failed.length} reconciled=${reconciled.length}`)
			// 0.10.27 会话健康探针 / 0.10.40 加固（GPT KIMI-EDA-20261002-02：单次 create 被官方 reject「create failed!」
			// 即判 degraded 过重——主机忙/模态框等瞬态也会失败，误报会逼调用方停摆）。加固：
			// ① 焦点文档复核：焦点不在原理图页时探针结果不可信 → inconclusive，不误报 degraded
			// ② create 最多 3 次重试（间隔 2s，多组候选坐标），全部失败才判 degraded
			// ③ 创建后读回验证（防假成功），删除后也读回；删除失败报 probeResidue 供定点清理
			// 0.10.52（KIMI-EDA-20261003-09）再加固：
			// ④ 假成功分支的清理 delete 补墙钟保护（原裸 await，官方挂起时永久停在本阶段）
			// ⑤ 探针清理有上限（最多 3 次删除+读回），仍残留则结构化返回 probeResidueDetail
			// ⑥ 各阶段/候选坐标/探针 ID/清理尝试 全部经 diag() 写代理 lane-log，可离线对账
			let sessionHealth: 'ok' | 'degraded' | 'inconclusive' | undefined
			let probeResidue: string | undefined
			let probeResidueDetail: { id: string, cleanupAttempts: number, lastError: string } | undefined
			if (reconciled.length || failed.length) {
				try {
					taskProgress(task, { stage: 'health-probe' })
					diag('schematic.delete', 'health-probe-start', `reconciled=${reconciled.length} failed=${failed.length}`)
					const doc = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined), 5000, '焦点文档查询')
					if (doc?.documentType !== 1) {
						sessionHealth = 'inconclusive'
						diagnostics.push(`会话健康探针未执行：焦点文档不是原理图（documentType=${doc?.documentType ?? '无焦点'}），探针结果不可信未采信——请激活原理图页后用只读指令（schematic.listWires 等）复核写通道`)
					}
					else {
						const candidates: number[][] = [[0, 0, 10, 0], [500, 500, 510, 500], [2000, 2000, 2010, 2000]]
						let pid: string | undefined
						let probeErr = ''
						for (let attempt = 0; attempt < candidates.length && !pid; attempt++) {
							if (attempt)
								await new Promise(resolve => setTimeout(resolve, 2000))
							diag('schematic.delete', 'probe-create-attempt', `第${attempt + 1}次 候选=${JSON.stringify(candidates[attempt])}`)
							try {
								const probeWire = await Promise.race([
									eda.sch_PrimitiveWire.create(candidates[attempt]),
									new Promise((_, reject) => setTimeout(() => reject(new Error('探针创建超时 10s')), 10000)),
								]) as any
								const got = safeState<string>(probeWire, 'getState_PrimitiveId')
								if (!got)
									throw new Error('探针创建未返回图元 ID')
								await new Promise(resolve => setTimeout(resolve, 400))
								const allIds = await withTimeout(eda.sch_PrimitiveWire.getAllPrimitiveId().catch(() => undefined), 10000, '探针读回') as any
								if (Array.isArray(allIds) && !allIds.map(String).includes(got)) {
									// 0.10.52：假成功分支的清理补墙钟保护（原裸 await 无超时，官方挂起时
									// 整个 health-probe 阶段永久卡住——现场 task35/36 实测卡 4 分钟+）
									try {
										await withTimeout(eda.sch_PrimitiveWire.delete([got]), 10000, '探针假成功清理')
										diag('schematic.delete', 'probe-fake-success-cleaned', `候选${attempt + 1} 假成功已清理 ${got}`)
									}
									catch (cleanErr: any) {
										diag('schematic.delete', 'probe-fake-success-cleanup-failed', `候选${attempt + 1} id=${got} 错误=${cleanErr instanceof Error ? cleanErr.message : JSON.stringify(cleanErr)}`)
									}
									throw new Error('探针创建读回不存在（假成功）')
								}
								pid = got
								diag('schematic.delete', 'probe-created', `候选${attempt + 1} id=${pid}`)
							}
							catch (e: any) {
								probeErr = e instanceof Error ? e.message : JSON.stringify(e)
								diag('schematic.delete', 'probe-create-failed', `候选${attempt + 1} 错误=${probeErr}`)
							}
						}
						if (!pid) {
							sessionHealth = 'degraded'
							diagnostics.push(`🛑 会话健康探针失败：创建阶段 3 次重试均失败（最后错误：${probeErr}）——读通道正常而创建持续失败才算写通道劣化，建议先只读复核（listWires/listNetLabels）再决定是否【不保存重开页面】`)
						}
						else {
							// 0.10.52：清理有上限（3 次删除+读回），每次都有墙钟保护；仍残留则结构化上报
							let cleanupAttempts = 0
							let lastCleanupErr = ''
							while (cleanupAttempts < 3) {
								cleanupAttempts++
								try {
									diag('schematic.delete', 'probe-cleanup-attempt', `第${cleanupAttempts}次 id=${pid}`)
									await withTimeout(eda.sch_PrimitiveWire.delete([pid]), 10000, `探针导线删除(第${cleanupAttempts}次)`)
									await new Promise(resolve => setTimeout(resolve, 400))
									const left = await withTimeout(eda.sch_PrimitiveWire.getAllPrimitiveId().catch(() => undefined), 10000, '探针读回') as any
									if (!Array.isArray(left) || !left.map(String).includes(pid)) {
										sessionHealth = 'ok'
										diag('schematic.delete', 'probe-cleaned', `第${cleanupAttempts}次清理成功 id=${pid}`)
										break
									}
									lastCleanupErr = `第${cleanupAttempts}次删除后读回仍存在`
								}
								catch (e: any) {
									lastCleanupErr = e instanceof Error ? e.message : JSON.stringify(e)
								}
							}
							if (sessionHealth !== 'ok') {
								sessionHealth = 'degraded'
								probeResidue = pid
								probeResidueDetail = { id: pid, cleanupAttempts, lastError: lastCleanupErr }
								diagnostics.push(`🛑 会话健康探针失败：探针导线 ${cleanupAttempts} 次清理后仍残留（最后错误：${lastCleanupErr}）——残留无名探针短线 ${pid}，会话恢复后用 schematic.delete 定点删除（返回里 probeResidue/probeResidueDetail 已结构化给出）`)
							}
						}
					}
					diag('schematic.delete', 'health-probe-done', `sessionHealth=${sessionHealth}${probeResidue ? ` residue=${probeResidue}` : ''}`)
				}
				catch (e: any) {
					sessionHealth = 'inconclusive'
					diagnostics.push(`会话健康探针自身异常（${e instanceof Error ? e.message : JSON.stringify(e)}），不采信也不影响删除结果`)
				}
			}
			if (!deleted.length)
				throw new Error(`删除失败：${ids.join(', ')}（图元不存在、被锁定或类型暂不支持；已读回验证）${floatDiag?.length ? `。浮标删除通道诊断：${floatDiag.join('；')}` : ''}${diagnostics.length ? `。逐项诊断：${diagnostics.join('；')}` : ''}`)
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
				...(probeResidueDetail ? { probeResidueDetail } : {}),
				...(batches.length > 1 ? { batches } : {}),
				...(unprocessed.length ? {
					unprocessed,
					resumeNote: `有 ${unprocessed.length} 个图元因熔断/时间预算未轮到处理——确认 EDA 会话健康后再次调用本指令即可接着删（已删的不会重复）`,
				} : {}),
				...(failed.length ? {
					failedNote: `${failed.length} 个图元经终扫确认仍存在（真失败，非后台已删）——确认会话健康后再次调用本指令续删：${failed.join('、')}`,
				} : {}),
				...(diagnostics.length ? { diagnostics } : {}),
				...(floatDiag?.length ? { floatDiagnostics: floatDiag } : {}),
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
		name: 'schematic.deleteTextViaSource',
		summary: '【实验性·TEXT 专项】文档源码 append-only 墓碑删除 TEXT。背景：官方 PrimitiveText 类级/实例级 delete 都不落盘（0.10.53/0.10.54 双路实测：删→save→关开重读必复活，同页导线删除正常），本指令绕开官方删除 API，直接往文档变更日志追加删除墓碑（空 data 记录，重放时 ticket 大的赢）。append-only 纪律：不改旧行、ticket 从 max+1 递增',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '要删除的 TEXT 图元 ID 列表（单数 primitiveId 亦可）' },
			{ name: 'save', type: 'boolean', description: '墓碑写入并读回验证后是否 save，默认 true' },
		],
		returns: '{ tombstoned: [...], skipped: [...], steps: [...] }',
		example: { cmd: 'schematic.deleteTextViaSource', params: { primitiveIds: ['xxx'] } },
		handler: async (params) => {
			const raw = params.primitiveIds ?? params.primitiveId
			const ids = Array.isArray(raw) ? raw.map(String) : raw != null ? [String(raw)] : []
			if (!ids.length)
				throw new Error('缺少参数 primitiveIds（数组）或 primitiveId（单个 ID）')
			const steps: Array<string> = []
			const source = await eda.sys_FileManager.getDocumentSource()
			if (!source)
				throw new Error('getDocumentSource 返回空（需先打开目标文档页签）')
			const src = String(source)
			// 现有 TEXT 记录里有的才需要墓碑；同时取全局 max ticket
			const maxTicket = Math.max(0, ...Array.from(src.matchAll(/"ticket":(\d+)/g)).map(m => Number(m[1]) || 0))
			const tombstoned: Array<string> = []
			const skipped: Array<string> = []
			let ticket = maxTicket
			const lines: Array<string> = []
			for (const id of ids) {
				const live = new RegExp(`\\{"type":"TEXT","ticket":\\d+,"id":"${id}"\\}\\|\\|`).test(src)
				if (!live) {
					skipped.push(id)
					steps.push(`${id}: 源码日志中无现存 TEXT 记录（可能已删或从未存在），跳过`)
					continue
				}
				ticket += 1
				lines.push(`${JSON.stringify({ type: 'TEXT', ticket, id })}||${JSON.stringify('')}`)
				tombstoned.push(id)
				steps.push(`${id}: 追加墓碑 ticket=${ticket}`)
			}
			if (!lines.length)
				return { tombstoned, skipped, steps, note: '没有需要墓碑的 TEXT' }
			const body = src.trimEnd()
			const sep = body.endsWith('|') ? '' : '|'
			const patched = `${body}${sep}\n${lines.join('|\n')}`
			const writeBack = await eda.sys_FileManager.setDocumentSource(patched)
			steps.push(`setDocumentSource 返回 ${JSON.stringify(writeBack)}`)
			if (writeBack === false)
				throw new Error('setDocumentSource 返回 false（官方运行时校验拒绝）——文档未改动')
			// 回读验证：墓碑在日志里
			const back = String(await eda.sys_FileManager.getDocumentSource())
			for (const id of tombstoned) {
				const ok = new RegExp(`\\{"type":"TEXT","ticket":\\d+,"id":"${id}"\\}\\|\\|""`).test(back)
				steps.push(`${id}: 墓碑读回${ok ? '确认' : '缺失！'}`)
			}
			// 模型读回：官方枚举里还看不看得见（判断 setDocumentSource 是否触发模型重解析）
			let modelGone: Record<string, boolean> = {}
			try {
				const liveIds = await eda.sch_PrimitiveText.getAllPrimitiveId()
				for (const id of tombstoned)
					modelGone[id] = !liveIds.includes(id)
			}
			catch {
				steps.push('模型枚举读回失败')
			}
			let saved: boolean | undefined
			if (params.save !== false) {
				try {
					saved = Boolean(await eda.sch_Document.save())
					steps.push(`save 返回 ${saved}`)
				}
				catch (e) {
					steps.push(`save 抛错 ${String((e as any)?.message ?? e)}`)
				}
			}
			return { tombstoned, skipped, steps, modelGone, saved }
		},
	},
	{
		name: 'schematic.placeNetLabel',
		summary: '在导线旁边放置网络标签（信号网络收尾用），放置后自动验证电气附着（附着的可靠位置是导线自由端/短桩末端）。注意：标签是贴在导线【边上】而不是压在线上——锚点坐标取导线线段上的点，文字本体自动让开；直接压线体会被官方拒绝',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名，如 NRST、SWDIO' },
			{ name: 'x', type: 'number', required: true, description: '锚点 X（导线线段上的点）' },
			{ name: 'y', type: 'number', required: true, description: '锚点 Y' },
			{ name: 'noVerify', type: 'boolean', description: '跳过附着验证（默认 false）' },
			{ name: 'force', type: 'boolean', description: '跳过"附近导线已同名"防呆检查（默认 false；0.10.0 起同名重复放置会被拒绝）' },
			{ name: 'rotation', type: 'number', description: '标签文字方向（0.10.16）：0=文字向右（默认）、180=向左、90=向上、270=向下。引脚朝左的器件短桩标签应传 180 让文字朝外；设置后读回验证，失败在返回里注明' },
		],
		returns: '{ primitiveId, attached }（attached=false 时标签已自动删除并报错）',
		example: { cmd: 'schematic.placeNetLabel', params: { net: 'NRST', x: 464, y: 455 } },
		handler: async (params) => {
			if (!params.net || params.x == null || params.y == null)
				throw new Error('缺少参数 net / x / y')
			const net = String(params.net)
			const ax = Number(params.x)
			const ay = Number(params.y)
			const wantRotation = params.rotation != null ? ((Number(params.rotation) % 360) + 360) % 360 : 0
			// 前置防呆（0.10.0）：锚点附近导线已带同名网络名（导线命名属性或已附着的同名标签）时拒绝再放——
			// 同一导线挂两个同名属性会产生"导线有多个网络名"警告，且导线持有的属性官方接口删不掉，
			// 只能删线重画（GPT 实测翻车：短桩已有 STATUS_LED 又放同名标签，删除命令全部无效）
			if (!params.force) {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					for (let i = 0; i + 1 < line.length; i += 2) {
						const x1 = line[i]
						const y1 = line[i + 1]
						const x2 = line[i + 2] ?? x1
						const y2 = line[i + 3] ?? y1
						const ddx = Math.max(Math.min(x1, x2) - ax, 0, ax - Math.max(x1, x2))
						const ddy = Math.max(Math.min(y1, y2) - ay, 0, ay - Math.max(y1, y2))
						if (Math.hypot(ddx, ddy) <= 8) {
							const wid = safeState<string>(w, 'getState_PrimitiveId')
							throw new Error(`锚点附近导线（${wid}）已命名为 ${net}，无需再放标签——重复放置会产生"多个网络名"警告且无法删除。确要放请加 force:true`)
						}
					}
				}
			}
			// 官方签名是 createNetLabel(x, y, net)，参数顺序与直觉相反，别搞错。
			// 实测锚点正好压在线体上常被拒绝，偏移 ±2 却能成功且电气附着正常——自动微偏重试
			let label: any
			let usedX = ax
			let usedY = ay
			for (const [dx, dy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
				label = await withStage('placeNetLabel:createNetLabel', () => (eda.sch_PrimitiveAttribute as any).createNetLabel(ax + dx, ay + dy, net))
				if (label) {
					usedX = ax + dx
					usedY = ay + dy
					break
				}
				// 源头防双份：返回空不代表没创建（官方偶发假失败），确认锚点处真的没标签才换下一个偏移
				const ghost = await findGhostNetLabel(net, ax + dx, ay + dy)
				if (ghost) {
					const ghostRotation = wantRotation ? await applyLabelRotation(ghost.id, wantRotation) : undefined
					return { primitiveId: ghost.id, attached: ghost.attached, ...(wantRotation ? { labelRotation: ghostRotation } : {}), note: '官方创建接口返回空但标签实际已生成（假失败），已直接采用该标签' }
				}
			}
			if (!label)
				throw new Error('网络标签创建失败：官方返回空（已自动尝试 ±2 微偏）。标签要贴在导线边上而不是压在线上，可把锚点偏移 2~5 个单位再试')
			const labelId = safeState<string>(label, 'getState_PrimitiveId')
			// 文字方向（0.10.16）：modify rotation + 读回验证（官方假失败前科，成败以读回为准）
			const labelRotation = labelId && wantRotation ? await applyLabelRotation(labelId, wantRotation) : undefined
			const rotationResult = wantRotation
				? { labelRotation, ...(labelRotation == null ? { rotationNote: `标签旋转 ${wantRotation}° 设置失败（读回不匹配），文字仍为默认朝右` } : {}) }
				: {}
			if (params.noVerify)
				return { primitiveId: labelId, attached: undefined, ...rotationResult }
			// 附着验证：锚点附近（±5 单位）存在网络变为该名的导线即视为附着。
			// 实测锚点稍微偏离线体能创建成功但电气上不附着（网表丢名），
			// 且 moveLabel 不会重算附着，必须放置时验证
			const checkAttached = async (): Promise<boolean> => {
				// getAll(net) 过滤参数运行时不可靠，全量取回后手动过滤
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					for (let i = 0; i + 3 < line.length + 1 && i + 1 < line.length; i += 2) {
						const x1 = line[i]
						const y1 = line[i + 1]
						const x2 = line[i + 2] ?? x1
						const y2 = line[i + 3] ?? y1
						// 点到（水平/垂直）线段距离
						const dx = Math.max(Math.min(x1, x2) - ax, 0, ax - Math.max(x1, x2))
						const dy = Math.max(Math.min(y1, y2) - ay, 0, ay - Math.max(y1, y2))
						if (Math.hypot(dx, dy) <= 5)
							return true
					}
				}
				return false
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 500))
				if (await checkAttached())
					return { primitiveId: labelId, attached: true, ...rotationResult }
			}
			// 原则：插件不擅自修复/删除——标签保留，如实报告未附着，由操作者决定处置
			return {
				primitiveId: labelId,
				attached: false,
				...rotationResult,
				warning: `标签未电气附着（锚点 ${ax},${ay} 附近没有可归入 ${net} 的导线）。标签已保留未删除：可用 schematic.moveLabel 挪到导线自由端，或 schematic.delete 删除`,
			}
		},
	},
	{
		name: 'schematic.listNetLabels',
		summary: '列出全部网络标签（导线 NET/Name 属性 + 浮空标签），含附着状态与颜色——0.10.46 起查标签一律用本指令（listLabels 已删：它不返回导线网络属性，实测 891 条里无 NET 键），排查"网络标签没有连接导线"类 DRC 信息、按网名查标签残留时用',
		params: [
			{ name: 'net', type: 'string', description: '按网络名过滤，留空为全部' },
		],
		returns: '[{ primitiveId, net, x, y, color, rotation?, attached, wireId }]（attached=false 即浮空标签，DRC 会报"没有连接导线或总线"；rotation 为标签文字方向角度，0=文字向右 180=向左）',
		example: { cmd: 'schematic.listNetLabels', params: { net: 'GND' } },
		handler: async (params) => {
			return collectNetLabels(params.net ? String(params.net) : undefined)
		},
	},
	{
		name: 'schematic.pruneFloatingLabels',
		summary: '【宏】一键清理浮空网络标签：扫描全页 attached=false 的标签（附着失败残留、导线被删后留下的孤儿标签，DRC"网络标签没有连接导线或总线"的来源），dryRun 预览（含每个浮标的世界坐标，方便手动框选兜底）或直接删除。删除主通道为「借尸还魂」（建临时导线→modify 浮标 parentId 挂上去→删导线级联带走→源码重扫验证）。0.10.12 加固：每条 8s 超时熔断（单条超时标记 failed 跳下一条）、连续 3 条失败熔断整批（提示会话可能已损坏、不保存重开页面）、分批执行（batchSize 默认 5、批间停 300ms、返回分批进度，大批浮标多次调用接着删）、全局时间预算耗尽即停且累积 diagnostics 不丢、回滚顺序修正（删临时导线失败先把 parentId 改回 $$root 再重试删线，避免留下删不掉的"持属性无名导线"孤儿）。⚠️ 文档源码改写通道默认禁用（0.10.10 曾被官方运行时判"数据格式不对"），仅显式 allowSourceRewrite:true 才执行且属最后手段；全失败时返回 manualDelete 世界坐标清单供手动框选删除',
		params: [
			{ name: 'dryRun', type: 'boolean', description: '只列出浮空标签不删除（默认 false 直接删）；返回每个浮标的世界坐标（Y 已翻转为 API 坐标），方便手动框选删除兜底' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 5：每批之间停 300ms 并记录分批进度。大批浮标建议保持默认多次调用，不要一次调大硬跑（0.10.11 实测连续高频创建临时导线会拖垮编辑器会话）' },
			{ name: 'allowSourceRewrite', type: 'boolean', description: '⚠️ 最后手段：允许「文档源码改写」删除通道（默认 false 禁用）。0.10.10 实机事故：该通道曾被官方运行时校验判"数据格式不对"弹窗拒绝——仅在借尸还魂通道失败且工程已保存时才显式传 true' },
		],
		returns: '{ floating: [{ primitiveId, net, x, y, worldX, worldY }], deleted, failed, unprocessed?, batches?, method, diagnostics, warning?, dryRun }（全失败时附 manualDelete 手动框选指引；unprocessed 为熔断/预算退出时未轮到的浮标，再次调用接着删）',
		example: { cmd: 'schematic.pruneFloatingLabels', params: { dryRun: true } },
		handler: async (params) => {
			const dryRun = Boolean(params.dryRun)
			const allowSourceRewrite = Boolean(params.allowSourceRewrite)
			const batchSize = Math.max(1, Number(params.batchSize) || 5)
			// 浮空标签是官方枚举盲区（getAll 不返回 parentId=$$root 的属性），走文档源码扫描
			const floatingRaw = await scanFloatingNetLabels()
			// 每个浮标附世界坐标（源码 Y 轴与 API 相反，翻转后即为界面/框选坐标），dryRun 也返回方便手动框选兜底
			const floating = floatingRaw.map(f => ({
				...f,
				worldX: f.x,
				worldY: f.y != null ? -f.y : undefined,
			}))
			let deleted: Array<string> = []
			let failed: Array<string> = []
			let method: string | undefined
			let diagnostics: Array<string> | undefined
			let warning: string | undefined
			let batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> | undefined
			let unprocessed: Array<string> | undefined
			if (!dryRun && floatingRaw.length) {
				const r = await deleteFloatingLabels(floatingRaw.map(f => String(f.primitiveId)), { allowSourceRewrite, batchSize })
				deleted = r.deleted
				failed = r.failed
				method = r.method
				diagnostics = r.diagnostics
				warning = r.warning
				batches = r.batches
				unprocessed = r.unprocessed
			}
			// 手动删除指引：源码 Y 轴与 API/界面相反，框选坐标要翻转 Y
			const failedSet = new Set(failed)
			const manualDelete = failed.length
				? floating.filter(f => failedSet.has(String(f.primitiveId))).map(f => ({
					primitiveId: f.primitiveId,
					net: f.net,
					worldX: f.worldX,
					worldY: f.worldY,
				}))
				: undefined
			return {
				floating,
				deleted,
				failed,
				dryRun,
				...(method ? { method } : {}),
				...(diagnostics?.length ? { diagnostics } : {}),
				...(warning ? { warning } : {}),
				...(batches?.length ? { batches } : {}),
				...(unprocessed?.length ? {
					unprocessed,
					resumeNote: `有 ${unprocessed.length} 个浮标因熔断/时间预算未轮到处理——确认 EDA 会话健康后再次调用本指令即可接着删（已删的不会重复）`,
				} : {}),
				...(manualDelete ? {
					manualDelete,
					note: `有 ${failed.length} 个浮标所有删除通道均无效（已读回验证）。官方实锤：属性图元 delete 接口标注"不会有任何效果"（pro-api-types @internal），父图元是 $$root 又无父可删。请在 EDA 里按 manualDelete 的世界坐标（Y 已翻转）框选手动删除；或不保存工程直接关页丢弃`,
				} : {}),
			}
		},
	},
	{
		name: 'schematic.fixNetLabels',
		summary: '【宏·全科体检】一条命令修复全部网络标签问题（0.10.17，替代 fixMirroredLabels）：① 浮空标签（没附着导线）→ 走浮标删除通道清除；② 重复标签（同一短桩/导线上同网名 >1 个，或同网名锚点间距 <10）→ 保留位置正确的一个，其余清除；③ 方向/反字（rotation 命中 angle，默认 180——⚠️ 镜像标志不入源码，只能按旋转角识别）→ 原地 rotation→0 读回验证，改不动走「删短桩级联→labelWire 重放（自动朝外）」；④ 位置不对（锚点距所属导线本体 >20=不在线上、电气虚附着；或导线越位=导线越过 rotation 0 标签文字右缘 5~40 且戳出端点悬空无引脚，0.10.18 新增）→ moveLabel 挪到导线端点/外端（右缘对齐），挪不动走删重放兜底。dryRun 默认 true 只出分类体检报告（符合不越权原则），人工/AI 确认后 dryRun:false 真修，逐条收错。修完自动 pruneFloatingLabels dryRun 复核剩余',
		params: [
			{ name: 'dryRun', type: 'boolean', description: '只扫描出分类体检报告（默认 true）；false 才真修' },
			{ name: 'angle', type: 'number', description: '方向嫌疑旋转角（默认 180；竖排侧字传 90/270）。⚠️ 0.10.16 起 labelWire 合法使用 180 朝外，修复前请人工核对清单' },
			{ name: 'net', type: 'string', description: '只处理指定网络的标签' },
		],
		returns: '{ floating, duplicates, rotationSuspects, misplaced（dryRun 体检四类清单，每条带 id/net/世界坐标/问题/建议）, fixed, pruned, failed, remaining, dryRun }',
		example: { cmd: 'schematic.fixNetLabels', params: { dryRun: true } },
		handler: async (params) => {
			const dryRun = params.dryRun !== false
			const angle = ((Number(params.angle ?? 180) % 360) + 360) % 360
			const netFilter = params.net != null ? String(params.net) : undefined
			const { labels, wireLines } = await scanNetLabelAttrsFromSource()
			// 统一转世界坐标（源码 Y 与 API 相反，翻转）
			interface Item { id: string, net: string, wx?: number, wy?: number, rotation?: number, attached: boolean, wireId?: string }
			const items: Array<Item> = labels
				.filter(l => !netFilter || l.net === netFilter)
				.map(l => ({
					id: l.primitiveId,
					net: l.net,
					wx: l.x,
					wy: l.y != null ? -l.y : undefined,
					rotation: l.rotation,
					attached: l.parentId != null && l.parentId !== '$$root',
					wireId: l.parentId != null && l.parentId !== '$$root' ? l.parentId : undefined,
				}))
			const card = (it: Item, issue: string, suggestion: string) => ({
				primitiveId: it.id, net: it.net, worldX: it.wx, worldY: it.wy,
				...(it.rotation != null ? { rotation: it.rotation } : {}),
				attached: it.attached, ...(it.wireId ? { wireId: it.wireId } : {}),
				issue, suggestion,
			})
			// ---------- 分类体检 ----------
			// ① 浮空
			const floatingItems = items.filter(i => !i.attached)
			const floating = floatingItems.map(i => card(i, '浮空标签：未附着任何导线（DRC"网络标签没有连接导线或总线"来源）', '真修时走浮标删除通道清除（孤儿不重放）'))
			const floatingIds = new Set(floatingItems.map(i => i.id))
			// 附着标签的导线几何（源码系），端点判定用
			const wireEnds = (wireId?: string): Array<[number, number]> => {
				const segs = wireId ? (wireLines.get(wireId) ?? []) : []
				const ends: Array<[number, number]> = []
				for (const [x1, y1, x2, y2] of segs) {
					ends.push([x1, y1], [x2, y2])
				}
				return ends
			}
			const distToEnds = (it: Item): number => {
				if (it.wx == null || it.wy == null)
					return Infinity
				const sx = it.wx
				const sy = -it.wy // 回源码系
				const ends = wireEnds(it.wireId)
				return ends.length ? Math.min(...ends.map(([ex, ey]) => Math.hypot(ex - sx, ey - sy))) : Infinity
			}
			// 锚点到所属导线线段的最短距离（源码系）。⚠️ 不能用端点距离判位置：
			// 每条导线自带网名显示 ATTR（key=NET）通常挂线中间，端点距离会把它们全误判成位置异常
			const distToWire = (it: Item): number => {
				if (it.wx == null || it.wy == null)
					return 0 // 无坐标无法判定，不误报
				const sx = it.wx
				const sy = -it.wy
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				if (!segs.length)
					return 0
				const pseg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
					const dx = x2 - x1
					const dy = y2 - y1
					if (dx === 0 && dy === 0)
						return Math.hypot(px - x1, py - y1)
					const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
					return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
				}
				return Math.min(...segs.map(([x1, y1, x2, y2]) => pseg(sx, sy, x1, y1, x2, y2)))
			}
			// ④b 导线越位（0.10.18 新增，0.10.20 按锚点语义修订）：rotation 0 标签附着在水平导线上，
			// 文字右缘 = 锚点 x + 文字宽度；导线越过右缘向外戳出 >5 即越位嫌疑（纯外观缺陷，电气不影响——附着看锚点）。
			// 防误报两道闸：① 越位量 ≤40（超过 40 的是导线自带网名显示挂线头、长线右延属正常，不算）；
			// ② 越位端点若有器件引脚（延伸是 functional 连线）不算越位——只有悬空戳出的线头才算。
			// 返回越位量（>0 表示越位），0 表示不越位/不适用。修复目标锚点 x = 导线外端 − 文字宽度。
			const overhangInfo = (it: Item): { amount: number, endX: number, endY: number } | undefined => {
				if (!it.attached || it.wx == null || it.wy == null)
					return undefined
				const rot = ((it.rotation ?? 0) % 360 + 360) % 360
				if (rot !== 0)
					return undefined // 方向异常标签归方向类处理
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				const horiz = segs.filter(([x1, y1, x2, y2]) => y1 === y2 && x1 !== x2)
				if (!horiz.length)
					return undefined
				const sx = it.wx // 源码系 x 与世界系同向（只 Y 翻转）
				const wireMaxX = Math.max(...horiz.map(([x1, , x2]) => Math.max(x1, x2)))
				const amount = wireMaxX - (sx + estimateLabelWidth(it.net))
				if (amount <= 5 || amount > 40)
					return undefined
				return { amount, endX: wireMaxX, endY: horiz[0][1] } // endY 源码系
			}
			// 越位端点是否落在器件引脚上（有引脚=功能性延伸，不是线头越位）
			const pinAtCache = new Map<string, boolean>()
			const pinAt = async (sx: number, sy: number): Promise<boolean> => {
				if (!pinAtCache.size) {
					const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
					for (const c of comps) {
						const cid = safeState<string>(c, 'getState_PrimitiveId')
						if (!cid)
							continue
						for (const pin of (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cid)) ?? []) {
							const px = pin.getState_X?.()
							const py = pin.getState_Y?.()
							if (px != null && py != null)
								pinAtCache.set(`${Math.round(px)},${Math.round(-py)}`, true) // 世界系→源码系 Y 翻转
						}
					}
				}
				for (const key of pinAtCache.keys()) {
					const [px, py] = key.split(',').map(Number)
					if (Math.hypot(px - sx, py - sy) <= 8)
						return true
				}
				return false
			}
			const overhangSuspectIds = new Set<string>()
			for (const it of items) {
				const oh = overhangInfo(it)
				if (oh && !(await pinAt(oh.endX, oh.endY)))
					overhangSuspectIds.add(it.id)
			}
			const isMisplaced = (it: Item): boolean =>
				it.attached && !dupIds.has(it.id) && (distToWire(it) > 20 || overhangSuspectIds.has(it.id))
			// ② 重复：同一导线上同网名 >1 个；或同网名锚点间距 <10（世界系）
			const dupIds = new Set<string>()
			const byWireNet = new Map<string, Array<Item>>()
			for (const it of items.filter(i => i.attached)) {
				const k = `${it.wireId}|${it.net}`
				const arr = byWireNet.get(k) ?? []
				arr.push(it)
				byWireNet.set(k, arr)
			}
			for (const arr of byWireNet.values()) {
				if (arr.length > 1) {
					// 保留离导线端点最近的一个，其余标重复
					const sorted = [...arr].sort((a, b) => distToEnds(a) - distToEnds(b))
					for (const it of sorted.slice(1))
						dupIds.add(it.id)
				}
			}
			const attachedNonDup = items.filter(i => i.attached && !dupIds.has(i.id))
			for (let i = 0; i < attachedNonDup.length; i++) {
				for (let j = i + 1; j < attachedNonDup.length; j++) {
					const a = attachedNonDup[i]
					const b = attachedNonDup[j]
					if (a.net !== b.net || a.wx == null || b.wx == null || a.wy == null || b.wy == null)
						continue
					if (Math.hypot(a.wx - b.wx, a.wy - b.wy) < 10) {
						// 间距过近视为重复：保留离各自导线端点更近的
							dupIds.add((distToEnds(a) <= distToEnds(b) ? b : a).id)
					}
				}
			}
			const duplicates = items.filter(i => dupIds.has(i.id)).map(i => card(i, '重复标签：同一导线/同网名间距 <10 有多个', '真修时清除多余者（短桩场景删桩重放一个）'))
			// ③ 方向/反字嫌疑
			const rotationSuspects = items
				.filter(i => i.rotation != null && ((i.rotation % 360) + 360) % 360 === angle)
				.map(i => card(i, `方向嫌疑：rotation=${angle}（可能是镜像/旋转导致的反字侧字；也可能是 labelWire 合法朝外，请人工核对）`, '真修时原地转正 rotation→0（读回验证），改不动删桩重放'))
			// ④ 位置不对：锚点距所属导线本体 >20（不在线上），或导线越位（越过 rotation 0 标签文字右缘 5~40 且端点悬空无引脚）
			const misplaced = items
				.filter(i => isMisplaced(i))
				.map(i => overhangSuspectIds.has(i.id)
					? card(i, `导线越位：导线越过标签文字右缘向外戳出 ${Math.round(overhangInfo(i)?.amount ?? 0)}（端点悬空无引脚；戳出的线头露在文字外，属外观缺陷）`, '真修时把标签沿导线平移到导线外端（右缘对齐端点），moveLabel 读回验证，失败删桩重放')
					: card(i, '位置异常：锚点距所属导线 >20（不在线上，可能电气虚附着）', '真修时 moveLabel 挪到最近导线端点，挪不动删桩重放'))
			if (dryRun) {
				return {
					floating, duplicates, rotationSuspects, misplaced,
					dryRun: true,
					total: floating.length + duplicates.length + rotationSuspects.length + misplaced.length,
					note: '体检报告（未动任何图元）。确认分类无误后 dryRun:false 真修；可用 net 参数缩小范围。⚠️ 镜像标志不入源码，方向类按旋转角识别，rotationSuspects 里可能含 labelWire 合法朝外标签，请核对',
				}
			}
			// ---------- 真修 ----------
			const fixed: Array<string> = []
			const pruned: Array<string> = []
			const failed: Array<Record<string, unknown>> = []
			const handled = new Set<string>()
			const replayedWires = new Set<string>()
			// 删桩重放兜底（共享）：删导线级联删标签 → 远端引脚 labelWire 重放；找不到引脚 placeNetLabel 原地重放
			const replay = async (it: Item): Promise<void> => {
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				if (!segs.length)
					throw new Error('源码中找不到所属导线几何，无法重放')
				const ax = it.wx ?? 0
				const ay = it.wy ?? 0
				// 归属引脚 = 导线端点中离标签锚点较远的那个（源码→世界系 Y 翻转后匹配）
				const ends: Array<[number, number]> = []
				for (const [x1, y1, x2, y2] of segs)
					ends.push([x1, -y1], [x2, -y2])
				ends.sort((p, q) => Math.hypot(q[0] - ax, q[1] - ay) - Math.hypot(p[0] - ax, p[1] - ay))
				const [px, py] = ends[0]
				let pinRef: string | undefined
				const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
				for (const c of comps) {
					const des = safeState<string>(c, 'getState_Designator')
					const cid = safeState<string>(c, 'getState_PrimitiveId')
					if (!des || !cid)
						continue
					for (const pin of (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cid)) ?? []) {
						const ppx = pin.getState_X?.()
						const ppy = pin.getState_Y?.()
						if (ppx != null && ppy != null && Math.hypot(ppx - px, ppy - py) <= 8) {
							pinRef = `${des}.${pin.getState_PinNumber?.()}`
							break
						}
					}
					if (pinRef)
						break
				}
				if (!replayedWires.has(String(it.wireId))) {
					// 0.10.65 修复：改走 schematic.delete 受保护通道（逐项超时熔断+删后读回+终扫对账）。
					// 此前裸调官方 sch_PrimitiveWire.delete：官方假失败时旧线残留，随后 labelWire/placeNetLabel
					// 会在同一根线上再放一个标签——亲手制造"一根线多个网络名"（正是本指令要修的病）；
					// 官方挂起则整条指令无墙钟保护。
					// 复审补强（0.10.65）：replayedWires 登记必须在删除确认之后——登记在前时，
					// 删除未确认的后续重复项会跳过删除分支直接放标签，在残留旧线上叠标签。
					const delCmd = schematicCommands.find(c => c.name === 'schematic.delete')
					if (!delCmd)
						throw new Error('内部错误：schematic.delete 未注册')
					const dr: any = await delCmd.handler({ primitiveIds: [String(it.wireId)] })
					const gone = Array.isArray(dr?.deleted) && dr.deleted.map(String).includes(String(it.wireId))
					if (!gone) {
						// 0.10.65 三审修复：早退必须抛错而非 return——调用方 catch 会记 failItem，
						// return 会导致该标签同时进 failed 和 fixed 两个清单（fixed 虚增）
						throw new Error(`所属导线 ${it.wireId} 受保护删除未确认（deleted 清单无它），跳过重放防止同一根线叠两个标签`)
					}
					replayedWires.add(String(it.wireId))
				}
				if (pinRef) {
					const labelCmd = schematicCommands.find(c => c.name === 'schematic.labelWire')
					if (!labelCmd)
						throw new Error('内部错误：labelWire 未注册')
					await labelCmd.handler({ pin: pinRef, net: it.net })
				}
				else {
					const placeCmd = schematicCommands.find(c => c.name === 'schematic.placeNetLabel')
					if (!placeCmd)
						throw new Error('内部错误：placeNetLabel 未注册')
					await placeCmd.handler({ net: it.net, x: ax, y: ay, rotation: 0, force: true })
				}
			}
			const failItem = (it: Item, reason: string) =>
				failed.push({ primitiveId: it.id, net: it.net, worldX: it.wx, worldY: it.wy, reason })
			// ① 浮空 → 浮标删除通道清除（不重放）
			if (floatingItems.length) {
				const r = await deleteFloatingLabels(floatingItems.map(i => i.id))
				pruned.push(...r.deleted)
				for (const fid of r.failed) {
					const it = floatingItems.find(i => i.id === fid)!
					failItem(it, '浮空标签删除失败（所有通道无效），请按坐标手动框选删除')
				}
				floatingItems.forEach(i => handled.add(i.id))
			}
			// ② 重复 → 多余者在短桩上则删桩重放一个；长导线上的重复标签官方删不掉，如实报手工
			for (const it of items.filter(i => dupIds.has(i.id))) {
				if (handled.has(it.id))
					continue
				try {
					const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
					const totalLen = segs.reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0)
					if (totalLen > 40)
						throw new Error('重复标签挂在长导线上（属性图元官方删不掉），需删线重画——请按坐标人工处置')
					await replay(it)
					fixed.push(it.id)
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ③ 方向/反字 → 原地转正读回验证，失败删桩重放
			for (const it of items.filter(i => i.rotation != null && ((i.rotation % 360) + 360) % 360 === angle)) {
				if (handled.has(it.id))
					continue
				try {
					const back = await applyLabelRotation(it.id, 0)
					if (back === 0)
						fixed.push(it.id)
					else if (it.attached) {
						await replay(it)
						fixed.push(it.id)
					}
					else
						throw new Error('原地转正读回不匹配且为浮空标签（已在浮空类处理或未清除）')
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ④ 位置不对/导线越位 → moveLabel 挪到目标点（越位：导线外端−文字宽度，右缘对齐；离线：最近端点），读回验证，失败删桩重放
			for (const it of items.filter(i => isMisplaced(i))) {
				if (handled.has(it.id))
					continue
				try {
					const sx = it.wx ?? 0
					const sy = -(it.wy ?? 0)
					let tx: number
					let ty: number
					if (overhangSuspectIds.has(it.id)) {
						// 越位修复：锚点沿导线平移到导线外端 − 文字宽度（源码系 x 与世界系同向）
						const oh = overhangInfo(it)
						if (!oh)
							throw new Error('越位信息缺失')
						tx = oh.endX - estimateLabelWidth(it.net)
						ty = it.wy ?? 0
					}
					else {
						// 最近端点（源码系 → 世界系）
						const ends = wireEnds(it.wireId)
						if (!ends.length)
							throw new Error('找不到所属导线端点')
						ends.sort((p, q) => Math.hypot(p[0] - sx, p[1] - sy) - Math.hypot(q[0] - sx, q[1] - sy))
						tx = ends[0][0]
						ty = -ends[0][1]
					}
					const mv = await eda.sch_PrimitiveAttribute.modify(it.id, { x: tx, y: ty })
					// 读回验证（假失败前科：不信返回值）
					const back = await eda.sch_PrimitiveAttribute.get(it.id)
					const bx = back ? safeState<number>(back, 'getState_X') : undefined
					const by = back ? safeState<number>(back, 'getState_Y') : undefined
					if (mv && bx != null && by != null && Math.hypot(bx - tx, by - ty) <= 2)
						fixed.push(it.id)
					else {
						await replay(it)
						fixed.push(it.id)
					}
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ---------- 复核：浮标 dryRun 重扫 ----------
			let remaining: Record<string, unknown> | undefined
			try {
				const pruneCmd = schematicCommands.find(c => c.name === 'schematic.pruneFloatingLabels')
				const pr = pruneCmd ? (await pruneCmd.handler({ dryRun: true })) as any : undefined
				remaining = { floatingLeft: pr?.floating?.length ?? 0, failedLeft: failed.length }
			}
			catch {
				remaining = { floatingLeft: '复核失败', failedLeft: failed.length }
			}
			return {
				floating, duplicates, rotationSuspects, misplaced,
				dryRun: false,
				fixed,
				pruned,
				...(failed.length ? { failed } : {}),
				remaining,
				note: `已修 ${fixed.length} 个（原地转正/挪动/删桩重放），清除浮空与多余 ${pruned.length} 个${failed.length ? `，失败 ${failed.length} 个（见 failed 明细）` : ''}。剩余浮标 ${remaining?.floatingLeft ?? '?'} 个。请目测画布确认文字恢复正字、位置正确`,
			}
		},
	},
	{
		name: 'schematic.autoLayout',
		summary: '【宏·原理图自动整理】把已放好网络（标签/导线）的一批器件重新排整齐并重建连线（0.10.19）：designators 或 region 二选一框定器件 → 网表导出连接表（NC/悬空自动跳过）→ 按网络聚类贪心排序 + cw32 模板行列排（横距 60 行距 90）→ 移动器件（官方 modify x/y，读回验证）→ rewire：删旧短桩导线（级联删标签）+ 清浮标 → 连接表转 batchWire（0.10.26 起 link 直连先于 label 短桩建，避免短桩先建占用引脚致 link 被拒；0.10.27 起删线前识别导线携带的外部引脚（带 1 个外部引脚的线删后自动补网重建、穿 ≥3 引脚的复杂长线保留不删进 skippedWires），link 因整段穿第三方引脚失败时自动降级两端 label 短桩（fallbacks）；未恢复的失败项在 rewireFailed/warning 里明列，插件不擅自恢复原连接）重建 → DRC 聚合。⚠️ 探针实锤：官方移动器件导线/标签不橡皮筋跟随，rewire 必须全量重建。dryRun 默认 true 只出排布方案+连接表预览，确认后 dryRun:false 才动画布',
		params: [
			{ name: 'designators', type: 'array', description: '器件位号清单，如 ["U1","C1","C2"]（与 region 二选一）' },
			{ name: 'region', type: 'object', description: '框选范围 {x, y, width, height}，范围内器件全部参与（与 designators 二选一）' },
			{ name: 'template', type: 'object', description: '排列模板 { colGap=60, rowGap=90, maxCols=ceil(sqrt(n)), origin=排序后第一个器件的当前位置 }' },
			{ name: 'rewire', type: 'boolean', description: '重排后重建连线（默认 true）；false 只移动器件' },
			{ name: 'dryRun', type: 'boolean', description: '只出排布方案与连接表预览（默认 true），false 才真移动+重建连线' },
		],
		returns: '{ dryRun, plan: [{designator, from, to}], connections: [{net, pins, style}], moved?, moveFailed?, rewired?: batchWire 结果, deletedWires?, prunedLabels?, drc?, failed? }',
		example: { cmd: 'schematic.autoLayout', params: { designators: ['U1', 'C1', 'C2'], dryRun: true } },
		handler: async (params) => {
			const dryRun = params.dryRun !== false
			const rewire = params.rewire !== false
			// ---------- ① 收集目标器件 ----------
			const all = (await eda.sch_PrimitiveComponent.getAll()) ?? []
			const comps = all.map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
			})).filter(c => c.primitiveId && c.designator && c.x != null && c.y != null)
				.filter(c => !/^DRAWING|DRAW/i.test(String(c.designator))) // 排除图框器件
			let targets: typeof comps = []
			if (Array.isArray(params.designators) && params.designators.length) {
				const want = params.designators.map(String)
				targets = comps.filter(c => want.includes(String(c.designator)))
				const missing = want.filter(d => !targets.some(t => t.designator === d))
				if (missing.length)
					throw new Error(`找不到器件：${missing.join('、')}（用 schematic.listComponents 查位号）`)
			}
			else if (params.region && params.region.x != null) {
				const r = params.region
				const rx2 = Number(r.x) + Number(r.width ?? 0)
				const ry2 = Number(r.y) + Number(r.height ?? 0)
				targets = comps.filter(c =>
					Math.min(Number(r.x), rx2) <= Number(c.x) && Number(c.x) <= Math.max(Number(r.x), rx2)
					&& Math.min(Number(r.y), ry2) <= Number(c.y) && Number(c.y) <= Math.max(Number(r.y), ry2))
				if (!targets.length)
					throw new Error('region 范围内没有器件')
			}
			else
				throw new Error('需要 designators 数组或 region 对象（二选一）')
			const targetSet = new Set(targets.map(t => String(t.designator)))
			// ---------- ② 连接表（网表导出；NC/悬空引脚无网络自动跳过） ----------
			const pinNetMap = await pinNetMapRobust()
			if (!pinNetMap)
				throw new Error('网表导出失败（请确认原理图页处于激活状态）')
			const netToPins = new Map<string, Array<string>>()
			for (const [ref, net] of pinNetMap) {
				const arr = netToPins.get(net) ?? []
				arr.push(ref)
				netToPins.set(net, arr)
			}
			// 只保留触及目标器件的网络，但网络内引脚保留全集（link 重建需要外部另一端）
			const involved = [...netToPins.entries()].filter(([, pins]) =>
				pins.some(r => targetSet.has(r.split('.')[0])))
			if (!involved.length)
				throw new Error(`目标器件 ${[...targetSet].join('、')} 没有任何已入网引脚（网络关系不存在，无法用 autoLayout；请先接线或用 buildBlock 生成）`)
			// ---------- ③ 排布：网络聚类贪心排序 + 行列网格 ----------
			const compNets = new Map<string, Set<string>>()
			for (const t of targets)
				compNets.set(String(t.designator), new Set())
			for (const [net, pins] of involved)
				for (const r of pins) {
					const des = r.split('.')[0]
					if (targetSet.has(des))
						compNets.get(des)!.add(net)
				}
			const natural = (a: string, b: string) =>
				a.replace(/(\d+)/, m => m.padStart(6, '0')).localeCompare(b.replace(/(\d+)/, m => m.padStart(6, '0')))
			const remaining = [...targets].sort((a, b) => natural(String(a.designator), String(b.designator)))
			const order: typeof targets = []
			const placedNets = new Set<string>()
			while (remaining.length) {
				let bestIdx = 0
				let bestScore = -1
				for (let i = 0; i < remaining.length; i++) {
					const cn = compNets.get(String(remaining[i].designator))!
					const score = order.length
						? [...cn].filter(n => placedNets.has(n)).length
						: cn.size // 第一个：连接最多的器件
					if (score > bestScore) {
						bestScore = score
						bestIdx = i
					}
				}
				const [pick] = remaining.splice(bestIdx, 1)
				order.push(pick)
				for (const n of compNets.get(String(pick.designator))!)
					placedNets.add(n)
			}
			const tpl = params.template ?? {}
			const colGap = Number(tpl.colGap ?? 60)
			const rowGap = Number(tpl.rowGap ?? 90)
			const maxCols = Math.max(1, Number(tpl.maxCols ?? Math.ceil(Math.sqrt(order.length))))
			const origin = (tpl.origin && tpl.origin.x != null)
				? { x: Number(tpl.origin.x), y: Number(tpl.origin.y) }
				: { x: Number(order[0].x), y: Number(order[0].y) } // 缺省从排序后第一个器件的当前位置起排
			const plan = order.map((t, i) => ({
				designator: String(t.designator),
				primitiveId: String(t.primitiveId),
				from: { x: t.x, y: t.y },
				to: { x: origin.x + (i % maxCols) * colGap, y: origin.y - Math.floor(i / maxCols) * rowGap },
			}))
			const connections = involved.map(([net, pins]) => ({
				net,
				pins: pins.sort(),
				style: pins.length === 2 && !isPowerNetName(net) ? 'link' : 'label',
				targetPins: pins.filter(r => targetSet.has(r.split('.')[0])),
			}))
			if (dryRun) {
				return {
					dryRun: true,
					plan,
					connections,
					note: `排布方案（未动画布）：${order.length} 个器件按网络聚类排序后行列排（横距 ${colGap} 行距 ${rowGap} 每行 ${maxCols} 个，原点 ${origin.x},${origin.y}）。rewire=${rewire}：真跑时先删旧短桩导线（级联删标签）再按连接表 batchWire 重建。确认后 dryRun:false 执行`,
				}
			}
			// ---------- ④ 移动前记录旧引脚坐标（rewire 清理用；移动后引脚坐标就变） ----------
			const oldPinPts: Array<{ ref: string, x: number, y: number }> = []
			const involvedPinRefs = new Set<string>()
			for (const [, pins] of involved)
				for (const r of pins)
					involvedPinRefs.add(r)
			for (const t of targets) {
				const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(t.primitiveId))) ?? []
				for (const p of pins) {
					const pn = String(p.getState_PinNumber?.() ?? '')
					if (!involvedPinRefs.has(`${t.designator}.${pn}`))
						continue // NC/悬空引脚不在连接表，跳过
					const px = p.getState_X?.()
					const py = p.getState_Y?.()
					if (px != null && py != null)
						oldPinPts.push({ ref: `${t.designator}.${pn}`, x: px, y: py })
				}
			}
			// ---------- ⑤ 移动器件（读回验证，假失败前科不信返回值） ----------
			const moved: Array<Record<string, unknown>> = []
			const moveFailed: Array<Record<string, unknown>> = []
			for (const item of plan) {
				try {
					await eda.sch_PrimitiveComponent.modify(item.primitiveId, { x: item.to.x, y: item.to.y } as any)
					const back = (await eda.sch_PrimitiveComponent.getAll()) ?? []
					const hit = back.find(c => safeState<string>(c, 'getState_PrimitiveId') === item.primitiveId)
					const bx = hit ? safeState<number>(hit, 'getState_X') : undefined
					const by = hit ? safeState<number>(hit, 'getState_Y') : undefined
					if (bx != null && by != null && Math.hypot(bx - Number(item.to.x), by - Number(item.to.y)) <= 2)
						moved.push({ designator: item.designator, from: item.from, to: item.to })
					else
						moveFailed.push({ designator: item.designator, to: item.to, reason: `移动读回不匹配（读回 ${bx},${by}）` })
				}
				catch (e: any) {
					moveFailed.push({ designator: item.designator, to: item.to, reason: String(e?.message ?? e) })
				}
			}
			if (!rewire) {
				return { dryRun: false, moved, ...(moveFailed.length ? { moveFailed } : {}), note: '已按方案移动器件（rewire:false 未重建连线；旧导线/标签原地未动——官方移动不跟随，需要时用 rewire:true 重跑）' }
			}
			// ---------- ⑥ rewire：删碰旧引脚的导线（级联删标签）→ 清浮标 → batchWire 重建 ----------
			const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
				const dx = x2 - x1
				const dy = y2 - y1
				if (dx === 0 && dy === 0)
					return Math.hypot(px - x1, py - y1)
				const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
				return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
			}
			const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
			// 全页引脚表（0.10.27）：目标器件用移动前坐标（oldPinPts），外部器件用当前坐标——
			// 用于识别 incident 导线是否还穿着目标器件以外的引脚（删线会顺手拆掉外部引脚的连接，0.10.26 复测 R2.1/J4.1 掉网事故）
			const allPinRefs: Array<{ ref: string, x: number, y: number }> = oldPinPts.map(p => ({ ...p }))
			try {
				const allComps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
				for (const c of allComps) {
					const cdes = safeState<string>(c, 'getState_Designator')
					const cpid = safeState<string>(c, 'getState_PrimitiveId')
					if (!cdes || !cpid || targetSet.has(cdes))
						continue
					try {
						const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cpid)) ?? []
						for (const p of pins) {
							const pn = String(p.getState_PinNumber?.() ?? '')
							const px = p.getState_X?.()
							const py = p.getState_Y?.()
							if (pn && px != null && py != null)
								allPinRefs.push({ ref: `${cdes}.${pn}`, x: px, y: py })
						}
					}
					catch { /* 单个器件取引脚失败不阻断 */ }
				}
			}
			catch { /* 全页引脚表失败则退化为 0.10.26 行为（只按目标引脚判） */ }
			// 按连接表找导线所属网络（involved 的 pins 是全成员 ref 表）
			const netOfRefs = (refs: Array<string>): string => {
				let best = ''
				let bestHit = 0
				for (const [net, pins] of involved) {
					const hit = refs.filter(r => pins.includes(r)).length
					if (hit > bestHit) {
						bestHit = hit
						best = net
					}
				}
				return best
			}
			const incidentIds: Array<string> = []
			const externalRewired: Array<Record<string, unknown>> = []
			const skippedWires: Array<Record<string, unknown>> = []
			const externalLabelItems: Array<Record<string, unknown>> = []
			for (const w of wires) {
				const wid = safeState<string>(w, 'getState_PrimitiveId')
				const line = safeState<Array<number>>(w, 'getState_Line') ?? []
				if (!wid || !line.length)
					continue
				const wireRefs = new Set<string>()
				let hit = false
				for (let i = 0; i + 1 < line.length; i += 2) {
					const x1 = line[i]
					const y1 = line[i + 1]
					const x2 = line[i + 2] ?? x1
					const y2 = line[i + 3] ?? y1
					for (const pt of allPinRefs) {
						if (segDist(pt.x, pt.y, x1, y1, x2, y2) <= 3) {
							wireRefs.add(pt.ref)
							if (!hit && oldPinPts.some(o => o.ref === pt.ref))
								hit = true
						}
					}
				}
				if (!hit)
					continue
				const refs = [...wireRefs]
				const extRefs = refs.filter(r => !targetSet.has(r.split('.')[0]))
				if (!extRefs.length) {
					incidentIds.push(wid) // 纯内部线：照删
					continue
				}
				const net = netOfRefs(refs)
				if (refs.length > 2) {
					// 复杂长线（穿 ≥3 个引脚）：保留原线不删，目标侧照常重建，可能留悬线，人工复核
					skippedWires.push({ primitiveId: wid, net, pins: refs, reason: '该线穿过 3 个及以上引脚（复杂长线），保留原线未删；目标器件侧已照常重建，可能残留悬线/重复连接，请人工复核' })
					continue
				}
				// 带 1 个外部引脚的短线：照删，外部侧补 label 重建（link 网由连接表 link 项覆盖两端，无需额外项）
				const netPins = involved.find(([n]) => n === net)?.[1] ?? []
				const isLinkNet = netPins.length === 2 && !isPowerNetName(net)
				for (const r of extRefs) {
					if (!isLinkNet && netPins.includes(r))
						externalLabelItems.push({ type: 'label', pin: r, net })
				}
				externalRewired.push({ primitiveId: wid, net, externalPins: extRefs, strategy: isLinkNet ? '由连接表 link 项重建两端' : '外部引脚补 label 短桩重建' })
				incidentIds.push(wid)
			}
			const deletedWires: Array<string> = []
			const deleteFailed: Array<string> = []
			if (incidentIds.length) {
				try {
					await eda.sch_PrimitiveWire.delete(incidentIds)
					// 读回验证（不信返回值）
					const alive = new Set(((await eda.sch_PrimitiveWire.getAll()) ?? []).map(w => safeState<string>(w, 'getState_PrimitiveId')))
					for (const id of incidentIds)
						(alive.has(id) ? deleteFailed : deletedWires).push(id)
				}
				catch (e: any) {
					deleteFailed.push(...incidentIds)
				}
			}
			// 浮标清理：只清网络在连接表内且靠近旧引脚点的浮标（不碰无关浮标）
			const prunedLabels: Array<string> = []
			try {
				const floats = await scanFloatingNetLabels()
				const involvedNets = new Set(involved.map(([n]) => n))
				const victims = floats.filter(f => involvedNets.has(f.net)
					&& f.x != null && f.y != null
					&& oldPinPts.some(pt => Math.hypot((f.x ?? 0) - pt.x, -(f.y ?? 0) - pt.y) <= 60))
				if (victims.length) {
					const r = await deleteFloatingLabels(victims.map(v => v.primitiveId))
					prunedLabels.push(...r.deleted)
				}
			}
			catch { /* 浮标清理失败不阻断 */ }
			// ---------- ⑦ 连接表 → batchWire 重建（0.10.26：link 先于 label——先直连占好引脚，
			// 再画短桩，避免短桩先建横穿第三方引脚占用网络后 link 被拒断网；0.10.24 终验 FBA 断网事故） ----------
			const linkItems: Array<Record<string, unknown>> = []
			const labelItems: Array<Record<string, unknown>> = []
			for (const [net, pins] of involved) {
				if (pins.length === 2 && !isPowerNetName(net))
					linkItems.push({ type: 'link', pins: [...pins].sort() })
				else
					for (const r of pins) {
						const des = r.split('.')[0]
						if (targetSet.has(des)) // 外部引脚的标签保持不动，只重建目标器件侧
							labelItems.push({ type: 'label', pin: r, net })
					}
			}
			// 0.10.27：⑥ 识别出的外部引脚补网项并入（按 pin 去重——外部侧标签若已存在/已覆盖则不重复）
			for (const it of externalLabelItems) {
				if (!labelItems.some(x => x.pin === it.pin) && !linkItems.some(x => (x.pins as Array<string>)?.includes(it.pin as string)))
					labelItems.push(it)
			}
			const items = [...linkItems, ...labelItems]
			const batchCmd = schematicCommands.find(c => c.name === 'schematic.batchWire')
			if (!batchCmd)
				throw new Error('内部错误：batchWire 未注册')
			const wiring = items.length ? await batchCmd.handler({ items, continueOnError: true }) as any : { note: '无可重建项' }
			// 0.10.27：link 失败项降级——整段路径穿第三方引脚时 linkWire 抛 PIN_CROSSING_FALLBACK，
			// 自动改为两端 label 短桩直连再试一次；恢复的不计入 rewireFailed
			const fallbacks: Array<Record<string, unknown>> = []
			const linkFailed = Array.isArray(wiring.items)
				? wiring.items.filter((it: any) => !it.ok && it.item?.type === 'link' && Array.isArray(it.item?.pins) && it.item.pins.length === 2)
				: []
			const recoveredLinks = new Set<any>()
			if (linkFailed.length) {
				const fItems: Array<Record<string, unknown>> = []
				const fPairs: Array<{ item: any, pins: [string, string] }> = []
				for (const it of linkFailed) {
					const [pa, pb] = it.item.pins as [string, string]
					const net = involved.find(([, pins]) => pins.includes(pa) && pins.includes(pb))?.[0] ?? ''
					if (!net)
						continue
					fItems.push({ type: 'label', pin: pa, net }, { type: 'label', pin: pb, net })
					fPairs.push({ item: it, pins: [pa, pb] })
				}
				if (fItems.length) {
					const fr = await batchCmd.handler({ items: fItems, continueOnError: true }) as any
					fPairs.forEach((p, i) => {
						const ra = fr?.items?.[i * 2]
						const rb = fr?.items?.[i * 2 + 1]
						const ok = !!ra?.ok && !!rb?.ok
						fallbacks.push({ pins: p.pins, net: fItems[i * 2].net, ok, ...(ok ? {} : { error: ra?.error ?? rb?.error ?? '' }), strategy: 'link 直连失败（整段路径穿第三方引脚），降级为两端 label 短桩' })
						if (ok)
							recoveredLinks.add(p.item)
					})
				}
			}
			// 重连失败明列（不断网原则：旧导线已删，失败项的网络就是断的——必须醒目列出由操作者处置，插件不擅自恢复原连接）
			const rewiredFailed = Array.isArray(wiring.items) ? wiring.items.filter((it: any) => !it.ok && !recoveredLinks.has(it)) : []
			// ---------- ⑧ DRC 聚合 ----------
			let drc: Record<string, unknown> | undefined
			try {
				const drcCmd = schematicCommands.find(c => c.name === 'schematic.runDrc')
				const dr = drcCmd ? (await drcCmd.handler({})) as any : undefined
				drc = dr ? { fatalCount: dr.fatalCount, totalCount: dr.totalCount, passed: dr.passed } : undefined
			}
			catch {
				drc = { note: 'DRC 运行失败，请手动 schematic.runDrc 复核' }
			}
			return {
				dryRun: false,
				moved,
				...(moveFailed.length ? { moveFailed } : {}),
				deletedWires,
				...(deleteFailed.length ? { deleteFailed } : {}),
				prunedLabels,
				...(externalRewired.length ? { externalRewired } : {}),
				...(skippedWires.length ? { skippedWires } : {}),
				...(fallbacks.length ? { fallbacks } : {}),
				rewired: wiring,
				...(rewiredFailed.length ? {
					rewireFailed: rewiredFailed.map((it: any) => ({ item: it.item, error: it.error })),
					warning: `⚠️ ${rewiredFailed.length} 项重连失败（旧导线已删，对应网络当前是断开的，插件不擅自恢复原连接）：${rewiredFailed.map((it: any) => `${JSON.stringify(it.item)}（${it.error ?? ''}）`).join('；')}。请按失败项逐条人工修复（labelWire/linkWire 重发或 drawWire+placeNetLabel），修完跑 schematic.runDrc + exportNetlist 审计`,
				} : {}),
				drc,
				note: `已移动 ${moved.length}/${plan.length} 个器件，删旧导线 ${deletedWires.length} 根、清浮标 ${prunedLabels.length} 个，batchWire 重建 ${items.length} 项（link 先于 label 执行）${externalRewired.length ? `，其中 ${externalRewired.length} 根线带外部引脚已一并补网重建` : ''}${skippedWires.length ? `，${skippedWires.length} 根复杂长线保留未删（见 skippedWires，请人工复核）` : ''}${fallbacks.length ? `，${fallbacks.filter(f => f.ok).length}/${fallbacks.length} 个 link 失败项已降级 label 短桩${fallbacks.some(f => !f.ok) ? '（仍有失败的见 fallbacks）' : '恢复'}` : ''}${rewiredFailed.length ? `，其中 ${rewiredFailed.length} 项失败见 warning` : ''}。请目测画布确认排布与连线`,
			}
		},
	},
	{
		name: 'schematic.modifyNetLabel',
		summary: '修改网络标签：颜色（不同网络不同颜色，看图更直观）、位置、改名、文字方向（rotation，0.10.17 起）。可按标签 ID 精确改，或按网络名批量改（如把全部 GND 标签改成深蓝色、把某网络的标签全部扶正 rotation:0）。⚠️ 让文字朝外用 rotation（180=向左），不要用镜像 mirror——镜像会把文字翻成反字，且官方原理图属性接口不支持修改 mirror（pro-api-types 无此字段），被镜像的标签只能删了重放',
		params: [
			{ name: 'primitiveId', type: 'string', description: '标签图元 ID（与 net 二选一）' },
			{ name: 'net', type: 'string', description: '网络名：批量修改该网络的全部标签' },
			{ name: 'color', type: 'string', description: '标签颜色，如 #0000FF' },
			{ name: 'newNet', type: 'string', description: '改网络名（改 value）' },
			{ name: 'x', type: 'number', description: '新坐标 X（建议 10 的倍数）' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'rotation', type: 'number', description: '文字方向（0.10.17）：0=向右、180=向左、90/270=向上/下；批量模式同样生效（可把某网络全部标签扶正）。改完读回 getState_Rotation 验证，返回带读回值' },
			{ name: 'mirror', type: 'boolean', description: '⚠️ 官方原理图属性接口不支持 mirror（pro-api-types 无此字段/无 getState_Mirror）——传入会被拒绝并提示；镜像反字的标签请删除重放（rotation 控制方向）' },
		],
		returns: '{ modified: [...], failed: [{ id, fields: [{ field, want, actual }] }], readback?: [{ id, rotation?, x?, y?, value?, color?, ok }], mirrorNote? }（0.10.24 起多字段请求内部自动拆成 rotation/位置/改名/颜色独立步骤顺序执行+逐字段读回——官方 modify 对「位置+旋转」合并修改整体失效（P10 实锤），不要再指望一次调用多字段原子生效）',
		example: { cmd: 'schematic.modifyNetLabel', params: { net: 'GND', color: '#0000FF' } },
		handler: async (params) => {
			if (!params.primitiveId && !params.net)
				throw new Error('缺少参数 primitiveId 或 net（二选一）')
			const property: Record<string, any> = {}
			if (params.color != null)
				property.color = String(params.color)
			if (params.newNet != null)
				property.value = String(params.newNet)
			if (params.x != null)
				property.x = Number(params.x)
			if (params.y != null)
				property.y = Number(params.y)
			if (params.rotation != null)
				property.rotation = ((Number(params.rotation) % 360) + 360) % 360
			// ⚠️ 官方原理图属性 modify 签名没有 mirror 字段（pro-api-types 实锤），也不存在 getState_Mirror——
			// 镜像反字的标签本接口修不了，只能删了重放（rotation 控制文字方向）
			const mirrorRequested = params.mirror != null
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（color / newNet / x / y / rotation）；mirror 官方接口不支持，镜像标签请删除重放')
			let ids: Array<string> = []
			if (params.primitiveId) {
				ids = [String(params.primitiveId)]
			}
			else {
				// 复用 listNetLabels 的逻辑按网名收集标签 ID
				const labels = await (async (): Promise<Array<any>> => {
					const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
					const found: Array<any> = []
					for (const w of wires) {
						const wireId = safeState<string>(w, 'getState_PrimitiveId')
						if (!wireId)
							continue
						try {
							for (const a of (await eda.sch_PrimitiveAttribute.getAll(wireId)) ?? []) {
								const key = safeState<string>(a, 'getState_Key') ?? ''
								if (/^(NET|Name)$/i.test(key) && safeState<string>(a, 'getState_Value') === String(params.net))
									found.push(a)
							}
						}
						catch { /* 单线失败继续 */ }
					}
					return found
				})()
				ids = labels.map(a => safeState<string>(a, 'getState_PrimitiveId')).filter(Boolean) as Array<string>
				if (!ids.length)
					throw new Error(`未找到网络 ${params.net} 的标签（浮空标签请用 listNetLabels 查 ID 后按 primitiveId 修改）`)
			}
			// 0.10.24 原子化（P10 实锤：官方 modify 对「位置+旋转」多字段合并修改整体失效——
			// GPT 现场：传 primitiveId+x+y+rotation 返回 modified 空、failed 含原 ID、读回全旧值，
			// 拆成「只转 rotation」「只移 x/y」两个单步各自成功。结论：多字段合并修改不可信）。
			// 多字段请求在插件内部拆成独立步骤顺序执行：rotation（走 applyLabelRotation 读回验证）
			// → 位置 x/y → 改名 value → 颜色 color；每步读回，不符即从 modified 挪到 failed（带字段与实际值）
			const modified: Array<string> = []
			const failed: Array<Record<string, unknown>> = []
			const readback: Array<Record<string, unknown>> = []
			const wantRotation = property.rotation != null ? Number(property.rotation) : undefined
			const wantX = property.x != null ? Number(property.x) : undefined
			const wantY = property.y != null ? Number(property.y) : undefined
			const wantValue = property.value != null ? String(property.value) : undefined
			const wantColor = property.color != null ? String(property.color) : undefined
			for (const id of ids) {
				const entry: Record<string, unknown> = { id }
				const fieldFails: Array<Record<string, unknown>> = []
				// 步骤 1：旋转（applyLabelRotation 自带 modify+读回，读回不符返回 undefined 判失败）
				if (wantRotation != null) {
					const actual = await applyLabelRotation(id, wantRotation)
					entry.rotation = actual ?? null
					if (actual == null)
						fieldFails.push({ field: 'rotation', want: wantRotation, actual: actual ?? null })
				}
				// 步骤 2：位置（x/y 同属「位置」类别，一次 modify；改完读回坐标逐轴核对）
				if (wantX != null || wantY != null) {
					const posProps: Record<string, any> = {}
					if (wantX != null)
						posProps.x = wantX
					if (wantY != null)
						posProps.y = wantY
					try {
						await eda.sch_PrimitiveAttribute.modify(id, posProps)
					}
					catch { /* 假失败不轻信，读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualX = back ? safeState<number>(back, 'getState_X') : undefined
						const actualY = back ? safeState<number>(back, 'getState_Y') : undefined
						if (wantX != null) {
							entry.x = actualX ?? null
							if (actualX == null || Math.abs(actualX - wantX) > 0.5)
								fieldFails.push({ field: 'x', want: wantX, actual: actualX ?? null })
						}
						if (wantY != null) {
							entry.y = actualY ?? null
							if (actualY == null || Math.abs(actualY - wantY) > 0.5)
								fieldFails.push({ field: 'y', want: wantY, actual: actualY ?? null })
						}
					}
					catch {
						fieldFails.push({ field: 'position', want: posProps, actual: null, reason: '读回失败' })
					}
				}
				// 步骤 3：改名（newNet→value，0.10.23 起读回验证）
				if (wantValue != null) {
					try {
						await eda.sch_PrimitiveAttribute.modify(id, { value: wantValue })
					}
					catch { /* 读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualValue = back ? safeState<string>(back, 'getState_Value') : undefined
						entry.value = actualValue ?? null
						if (actualValue == null || actualValue !== wantValue)
							fieldFails.push({ field: 'newNet', want: wantValue, actual: actualValue ?? null })
					}
					catch {
						fieldFails.push({ field: 'newNet', want: wantValue, actual: null, reason: '读回失败' })
					}
				}
				// 步骤 4：颜色（getState_Color 可能读不出——读不出只记录不判失败，读得出严格比对）
				if (wantColor != null) {
					try {
						await eda.sch_PrimitiveAttribute.modify(id, { color: wantColor })
					}
					catch { /* 读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualColor = back ? safeState<string>(back, 'getState_Color') : undefined
						entry.color = actualColor ?? null
						if (actualColor != null && actualColor.toLowerCase() !== wantColor.toLowerCase())
							fieldFails.push({ field: 'color', want: wantColor, actual: actualColor })
					}
					catch { /* 颜色读回失败不判失败 */ }
				}
				entry.ok = fieldFails.length === 0
				readback.push(entry)
				if (fieldFails.length)
					failed.push({ id, fields: fieldFails })
				else
					modified.push(id)
			}
			if (!modified.length && failed.length)
				throw new Error(`修改失败：${JSON.stringify(failed)}（图元不存在/不是属性标签，或读回均不符）`)
			return {
				modified,
				failed,
				...(readback.length ? { readback } : {}),
				...(mirrorRequested ? { mirrorNote: '官方原理图属性接口不支持 mirror（pro-api-types 无此字段、无 getState_Mirror），mirror 参数未生效。镜像反字的标签请删除重放：文字朝外用 rotation（180=向左），不要用镜像' } : {}),
			}
		},
	},
	{
		name: 'schematic.moveLabel',
		summary: '移动网络标签 / 属性图元到指定坐标（修复「不在格点上」警告时把坐标取整到 10 的倍数；移动后需复跑 DRC 确认吸附关系没丢）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '标签图元 ID' },
			{ name: 'x', type: 'number', required: true, description: '新坐标 X（建议 10 的倍数）' },
			{ name: 'y', type: 'number', required: true, description: '新坐标 Y（建议 10 的倍数）' },
		],
		returns: '{ moved, x, y }',
		example: { cmd: 'schematic.moveLabel', params: { primitiveId: 'xxx', x: 1020, y: 540 } },
		handler: async (params) => {
			if (!params.primitiveId || params.x == null || params.y == null)
				throw new Error('缺少参数 primitiveId / x / y')
			const result = await eda.sch_PrimitiveAttribute.modify(String(params.primitiveId), {
				x: Number(params.x),
				y: Number(params.y),
			})
			if (!result)
				throw new Error(`标签 ${params.primitiveId} 移动失败（图元可能不存在）`)
			// 读回验证（0.10.23：官方 modify 假成功前科，成败以读回为准）
			await new Promise(resolve => setTimeout(resolve, 300))
			const back = await eda.sch_PrimitiveAttribute.get(String(params.primitiveId))
			const actualX = back ? safeState<number>(back as any, 'getState_X') : undefined
			const actualY = back ? safeState<number>(back as any, 'getState_Y') : undefined
			const verified = actualX != null && actualY != null
				&& Math.abs(actualX - Number(params.x)) <= 0.5 && Math.abs(actualY - Number(params.y)) <= 0.5
			if (!verified)
				throw new Error(`标签 ${params.primitiveId} 移动未生效：读回实际坐标 (${actualX ?? '?'}, ${actualY ?? '?'})，目标 (${Number(params.x)}, ${Number(params.y)})——官方 modify 假成功，请重试`)
			return { moved: true, x: Number(params.x), y: Number(params.y), readback: { x: actualX, y: actualY, verified } }
		},
	},
	{
		name: 'schematic.runDrc',
		summary: '运行原理图 DRC 检查（需先激活原理图图页）。注意：存在致命错误时 pcb.importChanges 会静默失败（返回 false 无提示），导入前必须先清到 0 致命',
		params: [],
		returns: '{ passed, totalCount, fatalCount, groups }（官方实际按类型聚合返回 {type, count}，与文档的逐条结构不符，已做兼容）',
		example: { cmd: 'schematic.runDrc' },
		handler: async () => {
			const runOnce = async (): Promise<{ passed: boolean, totalCount: number, fatalCount: number, groups: Array<any> }> => {
				let errors: any
				try {
					errors = await eda.sch_Drc.check(true, false, true)
				}
				catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					if (/doctype/i.test(msg))
						throw new Error('当前激活的不是原理图图页，无法运行原理图 DRC。请先用 editor.openDocument 激活图页')
					throw err
				}
				const groups = Array.isArray(errors) ? errors : []
				// 官方实际返回按类型聚合的 { type, count }（文档写的是逐条 ISCH_DrcError，两者都兼容）
				const countOf = (e: any) => (typeof e?.count === 'number' ? e.count : 1)
				const totalCount = groups.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const fatalCount = groups
					.filter((e: any) => /fatal/i.test(String(e?.type ?? e?.rule ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				return { passed: totalCount === 0, totalCount, fatalCount, groups }
			}
			// 大批量改动后第一次 DRC 可能是过渡态旧结果（实测相差可达 10 条），
			// 自动跑两遍取稳定值
			const first = await runOnce()
			await new Promise(resolve => setTimeout(resolve, 800))
			const second = await runOnce()
			return {
				...second,
				...(first.totalCount !== second.totalCount
					? { note: `首次结果为过渡态（${first.totalCount} 条），已自动复跑取稳定值` }
					: {}),
			}
		},
	},
	{
		name: 'schematic.runDrcDetailed',
		summary: '运行原理图 DRC 并返回逐条违规明细（0.10.23，P08 探针结论：官方 eda.sch_Drc.check(strict, ui, includeVerboseError=true) 返回 Array<ISCH_DrcError>，逐条含 type/rule/net/primitives[{name, designator, primitiveId, sheet}]——pro-api-types 25928-26005 行实锤）。⚠️ 0.10.25 定论：该明细重载 pro-api-types 标注「ADD since EDA v4.2」——EDA 4.1.60 运行时不支持逐条明细，调用参数正确也只返回聚合 {type,count}（aggregated:true），明细只能看客户端 DRC 输出面板；v4.2+ 运行时才有逐条。与 runDrc 的区别：runDrc 返回按类型聚合的 {type,count}，本指令在支持的运行时返回 violations 明细数组（primitiveId 可用于画布跳转定位）',
		params: [],
		returns: '{ passed, totalCount, fatalCount, warnCount, violations: [{ type, rule, net?, primitives: [{ name?, designator?, primitiveId, sheet? }] }], aggregated? }（若官方运行时返回聚合结构而非逐条明细，violations 原样透传并标 aggregated:true）',
		example: { cmd: 'schematic.runDrcDetailed' },
		handler: async () => {
			const runOnce = async (): Promise<{ passed: boolean, totalCount: number, fatalCount: number, warnCount: number, violations: Array<any>, aggregated: boolean }> => {
				let errors: any
				try {
					errors = await eda.sch_Drc.check(true, false, true)
				}
				catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					if (/doctype/i.test(msg))
						throw new Error('当前激活的不是原理图图页，无法运行原理图 DRC。请先用 editor.openDocument 激活图页')
					throw err
				}
				const list = Array.isArray(errors) ? errors : []
				// 官方文档承诺逐条 ISCH_DrcError（type/rule/primitives/net），运行时也可能退化为聚合 {type,count}——两种都兼容
				const aggregated = list.some((e: any) => typeof e?.count === 'number' && !e?.primitives)
				const violations = list.map((e: any) => {
					if (e && typeof e === 'object' && (e.primitives || e.rule))
						return {
							type: e.type ?? undefined,
							rule: e.rule ?? undefined,
							...(e.net != null ? { net: e.net } : {}),
							primitives: Array.isArray(e.primitives) ? e.primitives.map((p: any) => ({
								...(p?.name != null ? { name: p.name } : {}),
								...(p?.designator != null ? { designator: p.designator } : {}),
								primitiveId: p?.primitiveId,
								...(p?.sheet != null ? { sheet: p.sheet } : {}),
							})) : [],
						}
					return e
				})
				const countOf = (e: any) => (typeof e?.count === 'number' ? e.count : 1)
				const totalCount = list.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const fatalCount = list
					.filter((e: any) => /fatal/i.test(String(e?.type ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const warnCount = list
					.filter((e: any) => /warn/i.test(String(e?.type ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				return { passed: totalCount === 0, totalCount, fatalCount, warnCount, violations, aggregated }
			}
			// 与 runDrc 同理：大批量改动后第一次 DRC 可能是过渡态旧结果，自动跑两遍取稳定值
			const first = await runOnce()
			await new Promise(resolve => setTimeout(resolve, 800))
			const second = await runOnce()
			return {
				...second,
				...(second.aggregated ? { note: '官方运行时返回的是聚合结构（{type,count}），未给出逐条明细——逐条明细重载 ADD since EDA v4.2（pro-api-types 26002 行），当前 4.1.x 运行时不支持，明细只能看客户端 DRC 输出面板' } : {}),
				...(first.totalCount !== second.totalCount
					? { note: `首次结果为过渡态（${first.totalCount} 条），已自动复跑取稳定值` }
					: {}),
			}
		},
	},
	{
		name: 'schematic.listNets',
		summary: '列出原理图全部网络（原理图侧网络读回自查）',
		params: [
			{ name: 'detail', type: 'boolean', description: '是否返回每个网络的导线明细，默认 false（仅网络名列表）' },
		],
		returns: '网络名列表，或 [{ net, wires }]',
		example: { cmd: 'schematic.listNets' },
		handler: async (params) => {
			if (!params.detail)
				return await eda.sch_Net.getAllNetsName()
			return await eda.sch_Net.getAllNets()
		},
	},
	{
		name: 'schematic.listWires',
		summary: '列出原理图导线（可按网络过滤）——画完线后读回自查用',
		params: [
			{ name: 'net', type: 'string', description: '网络名过滤，留空为全部导线' },
		],
		returns: '导线列表 [{ primitiveId, net, line, lineWidth }]',
		example: { cmd: 'schematic.listWires', params: { net: 'GND' } },
		handler: async (params) => {
			// getAll(net) 的过滤参数运行时不可靠（实测返回空），全量取回后手动过滤
			const wires = await eda.sch_PrimitiveWire.getAll()
			const netFilter = params.net ? String(params.net) : undefined
			return (wires ?? [])
				.map(w => ({
					primitiveId: safeState<string>(w, 'getState_PrimitiveId'),
					net: safeState<string>(w, 'getState_Net'),
					line: safeState<Array<number>>(w, 'getState_Line'),
					lineWidth: safeState<number>(w, 'getState_LineWidth'),
				}))
				.filter(w => !netFilter || w.net === netFilter)
		},
	},
	{
		name: 'schematic.exportBom',
		summary: '导出 BOM 物料清单（返回 base64 文件数据，AI 可自行落盘；配合 smt.queryComponent 可核价下单）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 schematic-bom' },
			{ name: 'fileType', type: 'string', description: 'xlsx | csv，默认 xlsx' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'schematic.exportBom', params: { fileType: 'csv' } },
		handler: async (params) => {
			const fileType = (params.fileType === 'csv' ? 'csv' : 'xlsx') as 'xlsx' | 'csv'
			const file = await eda.sch_ManufactureData.getBomFile(
				params.fileName ? String(params.fileName) : undefined,
				fileType,
			)
			const result = await fileToResult(file, `schematic-bom.${fileType}`)
			if (!result)
				throw new Error('BOM 导出失败：官方返回空（请确认已激活原理图图页且图中有器件）')
			return result
		},
	},
	{
		name: 'schematic.exportPng',
		summary: '导出原理图 PNG 图片（返回 base64；可指定分辨率，单边最大 4096）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 schematic.png' },
			{ name: 'width', type: 'number', description: '图片宽度像素，与 height 二选一或都留空（原始分辨率）' },
			{ name: 'height', type: 'number', description: '图片高度像素' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'schematic.exportPng', params: { width: 2048 } },
		handler: async (params) => {
			const resolution: Record<string, number> = {}
			if (params.width != null)
				resolution.width = Number(params.width)
			if (params.height != null)
				resolution.height = Number(params.height)
			const file = await eda.sch_ManufactureData.getPngFile(
				params.fileName ? String(params.fileName) : undefined,
				Object.keys(resolution).length ? resolution as any : undefined,
			)
			const result = await fileToResult(file, 'schematic.png')
			if (!result)
				throw new Error('PNG 导出失败：官方返回空（请确认已激活原理图图页）')
			return result
		},
	},
	{
		name: 'schematic.exportNetlist',
		summary: '导出原理图网表文件（返回 base64；引脚编号重复等数据问题会被官方拒绝）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 netlist' },
			{ name: 'netlistType', type: 'string', description: '网表格式，如 Protel2（Altium Designer 格式），默认官方默认格式' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'schematic.exportNetlist' },
		handler: async (params) => {
			const file = await eda.sch_ManufactureData.getNetlistFile(
				params.fileName ? String(params.fileName) : undefined,
				params.netlistType ? String(params.netlistType) as any : undefined,
			)
			const result = await fileToResult(file, 'netlist.net')
			if (!result)
				throw new Error('网表导出失败：官方返回空（File|undefined 中的 undefined——官方未文档化触发条件；数据校验不满足如引脚编号重复时官方会抛错而非返空。可改用 schematic.getNetlist 直接取网表字符串做连通性审计，或 schematic.runDrcDetailed 查致命项）')
			return result
		},
	},
	{
		name: 'schematic.getNetlist',
		summary: '直接读取原理图网表字符串（0.10.44，GPT KIMI-EDA-20261002-04）——官方 sch_Netlist.getNetlist（已标 deprecated 但仍公开）的薄封装；用于 exportNetlist 返空时的连通性审计备选，只读不写',
		params: [
			{ name: 'netlistType', type: 'string', description: '网表格式：Protel2/PADS/Allegro/DISA/DSNET 实测可用（4.1.60）；JLCEDA/EasyEDA 官方实现有宿主级缺陷（JLCEDA 挂起/EasyEDA 返空），0.10.45 起直接拒绝并提示改用可用格式；默认官方默认格式' },
		],
		returns: '{ netlistType, length, netlist }',
		example: { cmd: 'schematic.getNetlist', params: { netlistType: 'Protel2' } },
		handler: async (params) => {
			// 0.10.45（GPT -05 实测）：官方 sch_Netlist.getNetlist 在 JLCEDA/EasyEDA 格式上有宿主级缺陷——
			// JLCEDA 在测试工程挂起 >120s（你方现场报 "i is not iterable"，同一代码路径不同数据形态），
			// EasyEDA 返空。前置拒绝，避免挂死扩展命令队列 300s；其余格式 45s 超时保护。
			const KNOWN_BROKEN = new Set(['jlceda', 'easyeda'])
			const rawType = params.netlistType ? String(params.netlistType) : undefined
			if (rawType && KNOWN_BROKEN.has(rawType.trim().toLowerCase()))
				throw new Error(`网表格式 "${rawType}" 的官方 getNetlist 实现存在宿主级缺陷（JLCEDA：挂起或报 "i is not iterable"；EasyEDA：返空——0.10.45 实测，EDA 4.1.60）。请改用实测可用格式：Protel2 / PADS / Allegro / DISA / DSNET`)
			const netlist = await withTimeout(
				eda.sch_Netlist.getNetlist(rawType as any),
				45000,
				`getNetlist(${rawType ?? 'default'})`,
			).catch((e: any) => {
				throw new Error(`网表读取失败：${String(e?.message ?? e)}——该格式官方实现可能不可用，请换 Protel2 / PADS / Allegro / DISA / DSNET 实测可用格式`)
			})
			if (typeof netlist !== 'string' || netlist.length === 0)
				throw new Error('网表读取失败：官方返回非字符串或空——该接口与 exportNetlist 是两条独立路径，同时失败才说明原理图数据不满足网表校验')
			return { netlistType: rawType ?? 'default', length: netlist.length, netlist }
		},
	},
	// ---------- 原理图文本 + 区域/点查询 ----------
	{
		name: 'schematic.placeText',
		summary: '在原理图放置文本（注释/版本号/说明；坐标需为 5 的倍数）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（10mil 单位）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
			{ name: 'content', type: 'string', required: true, description: '文本内容' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0' },
			{ name: 'fontSize', type: 'number', description: '字号，默认官方默认' },
			{ name: 'fontName', type: 'string', description: '字体名' },
			{ name: 'textColor', type: 'string', description: '颜色（如 #FF0000）' },
			{ name: 'bold', type: 'boolean', description: '加粗' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'schematic.placeText', params: { x: 300, y: 700, content: 'STM32 最小系统 V1.0' } },
		handler: async (params) => {
			if (params.x == null || params.y == null || !params.content)
				throw new Error('缺少参数 x / y / content')
			const text = await eda.sch_PrimitiveText.create(
				Number(params.x),
				Number(params.y),
				String(params.content),
				params.rotation != null ? Number(params.rotation) : undefined,
				params.textColor != null ? String(params.textColor) : undefined,
				params.fontName != null ? String(params.fontName) : undefined,
				params.fontSize != null ? Number(params.fontSize) : undefined,
				params.bold != null ? Boolean(params.bold) : undefined,
			)
			if (!text)
				throw new Error('文本创建失败：官方返回空')
			return { primitiveId: safeState<string>(text, 'getState_PrimitiveId') }
		},
	},
	{
		name: 'schematic.listTexts',
		summary: '列出原理图全部文本图元（含 offGrid 格点标记——0.10.46 起接替已删除的 listLabels 的"不在格点"排查能力）',
		params: [],
		returns: '[{ primitiveId, x, y, content, fontSize, rotation, offGrid }]（offGrid=true 即坐标不是 10 的倍数，DRC 会报"图元不在格点上"）',
		example: { cmd: 'schematic.listTexts' },
		handler: async () => {
			const texts = await eda.sch_PrimitiveText.getAll()
			return (texts ?? []).map(t => {
				const x = safeState<number>(t, 'getState_X')
				const y = safeState<number>(t, 'getState_Y')
				return {
					primitiveId: safeState<string>(t, 'getState_PrimitiveId'),
					x,
					y,
					content: safeState<string>(t, 'getState_Content'),
					fontSize: safeState<number>(t, 'getState_FontSize'),
					rotation: safeState<number>(t, 'getState_Rotation'),
					offGrid: (typeof x === 'number' && x % 10 !== 0) || (typeof y === 'number' && y % 10 !== 0),
				}
			})
		},
	},
	{
		name: 'schematic.modifyText',
		summary: '修改已有原理图文本（内容/位置/字号/颜色/旋转）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '文本图元 ID' },
			{ name: 'content', type: 'string', description: '新内容' },
			{ name: 'x', type: 'number', description: '新坐标 X' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'fontSize', type: 'number', description: '字号' },
			{ name: 'textColor', type: 'string', description: '颜色' },
			{ name: 'rotation', type: 'number', description: '旋转角度' },
		],
		returns: '{ modified }',
		example: { cmd: 'schematic.modifyText', params: { primitiveId: 'xxx', content: 'V1.1' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.content != null)
				property.content = String(params.content)
			if (params.textColor != null)
				property.textColor = String(params.textColor)
			for (const k of ['x', 'y', 'fontSize', 'rotation']) {
				if (params[k] != null)
					property[k] = Number(params[k])
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const tid = String(params.primitiveId)
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——按类别拆步顺序执行
			const steps: Array<Record<string, any>> = []
			if (property.content != null)
				steps.push({ content: property.content })
			if (property.x != null || property.y != null) {
				const s: Record<string, any> = {}
				if (property.x != null)
					s.x = property.x
				if (property.y != null)
					s.y = property.y
				steps.push(s)
			}
			if (property.fontSize != null)
				steps.push({ fontSize: property.fontSize })
			if (property.textColor != null)
				steps.push({ textColor: property.textColor })
			if (property.rotation != null)
				steps.push({ rotation: property.rotation })
			let anyResult = false
			for (const stepProps of steps) {
				try {
					if (await eda.sch_PrimitiveText.modify(tid, stepProps as any))
						anyResult = true
				}
				catch { /* 假失败不轻信，读回为准 */ }
			}
			// 读回验证（官方返回值不可信，成败以读回为准）
			const readback: Record<string, unknown> = {}
			let verified = anyResult
			await new Promise(resolve => setTimeout(resolve, 300))
			try {
				const back = await eda.sch_PrimitiveText.get(tid)
				if (back) {
					const checks: Array<[string, string, any]> = []
					if (property.content != null)
						checks.push(['content', 'getState_Content', property.content])
					if (property.x != null)
						checks.push(['x', 'getState_X', property.x])
					if (property.y != null)
						checks.push(['y', 'getState_Y', property.y])
					if (property.rotation != null)
						checks.push(['rotation', 'getState_Rotation', property.rotation])
					if (property.fontSize != null)
						checks.push(['fontSize', 'getState_FontSize', property.fontSize])
					for (const [field, getter, want] of checks) {
						const actual = safeState<any>(back as any, getter)
						readback[field] = actual ?? null
						if (actual == null)
							verified = false
						else if (typeof want === 'number' ? Math.abs(Number(actual) - want) > 0.5 : String(actual) !== String(want))
							verified = false
					}
				}
				else {
					verified = false
				}
			}
			catch {
				verified = false
			}
			if (!verified)
				throw new Error(`文本 ${tid} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: true, ...(Object.keys(readback).length ? { readback: { ...readback, verified } } : {}) }
		},
	},
	{
		name: 'schematic.getPrimitivesInRegion',
		summary: '查询指定矩形区域内的原理图图元（返回 id+类型；布局避障用）',
		params: [
			{ name: 'left', type: 'number', required: true, description: '区域左边界（10mil 单位）' },
			{ name: 'right', type: 'number', required: true, description: '区域右边界' },
			{ name: 'top', type: 'number', required: true, description: '区域上边界' },
			{ name: 'bottom', type: 'number', required: true, description: '区域下边界' },
		],
		returns: '[{ primitiveId, primitiveType }]',
		example: { cmd: 'schematic.getPrimitivesInRegion', params: { left: 300, right: 600, top: 300, bottom: 600 } },
		handler: async (params) => {
			for (const k of ['left', 'right', 'top', 'bottom']) {
				if (params[k] == null)
					throw new Error(`缺少参数 ${k}`)
			}
			const prims = await eda.sch_Document.getPrimitivesInRegion(
				Number(params.left), Number(params.right), Number(params.top), Number(params.bottom),
			)
			return (prims ?? []).map(p => ({
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}))
		},
	},
	{
		name: 'schematic.getPrimitiveAtPoint',
		summary: '查询指定坐标处的原理图图元（返回 id+类型）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（10mil 单位）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
		],
		returns: '{ primitiveId, primitiveType } 或 null',
		example: { cmd: 'schematic.getPrimitiveAtPoint', params: { x: 550, y: 400 } },
		handler: async (params) => {
			if (params.x == null || params.y == null)
				throw new Error('缺少参数 x / y')
			const p = await eda.sch_Document.getPrimitiveAtPoint(Number(params.x), Number(params.y))
			if (!p)
				return null
			return {
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}
		},
	},
]
