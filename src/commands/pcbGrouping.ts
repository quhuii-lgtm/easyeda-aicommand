/**
 * PCB 源码分组宏指令（0.10.22 新增）
 *
 * - pcb.groupBySchematicRegions：按原理图 RECT 功能区框把 PCB 器件聚合分组。
 *   全流程走文档源码 append-only 写入（移植官方 eext-pcb-component-grouping 的
 *   日志模型与五步写回管线），不用实时图元 API（官方 1.8.2 已因卡死放弃该路线）。
 *   0.10.29 起布局引擎忠实移植官方 buildPcbPatch 排布原版（0.10.26~0.10.28 自改版废弃）。
 *   与官方仅有的差异：① 排布起点平移到板框内左下角；② 出口闸——排完校验出板框即报错不写；
 *   ③ 备份改为版本化文件栈（代理落盘 backups/<工程>/<时间戳>.txt，每工程保留最近 5 份），
 *   代理不可用时回退 sys_Storage 单槽备份；④ 组名文本单行（官方为页名/框名+区框内文本多行）。
 * - pcb.sourceRollback：列出/恢复源码备份（恢复前校验 pcbUuid 匹配，恢复后回读校验）。
 *
 * 铁律：官方 API 返回值不可信，一切成败以回读源码重新解析比对为准（容差 0.001）。
 */
import type { ICommandDef } from '../engine/types'
import type {
	IBBox,
	IPendingRecord,
	ISourcePcbComponent,
	ISourceRect,
} from '../pcb/sourcelog'
import {
	appendRecords,
	collectRecordPoints,
	effectiveRecordsByType,
	extractFootprintGeometry,
	extractPcbDocument,
	extractSchematicRects,
	fallbackBBox,
	findOwningRect,
	getMaxTicket,
	moveComponentData,
	parseSourceLog,
	resolveRecords,
	tombstoneByPrefix,
	transformFootprintBBox,
	verifyMovedComponents,
} from '../pcb/sourcelog'

const GENERATED_PREFIX = 'spg_'
const DOCUMENT_LAYER = 13
const PROXY_BASE = 'http://127.0.0.1:49720'
/** 代理不可用时的兜底备份槽（单槽覆盖，同官方做法） */
const STORAGE_BACKUP_KEY = 'ai-command-engine:pcb-source-backup'

// ---------- 代理备份通道（扩展自身不能写文件，备份文件由指令代理落盘） ----------

interface IBackupMeta {
	backupId: string
	project: string
	pcbUuid: string
	createdAt: string
	size: number
	note?: string
}

async function proxyJson(path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
	const resp = await eda.sys_ClientUrl.request(
		`${PROXY_BASE}${path}`, method,
		body !== undefined ? JSON.stringify(body) : undefined,
		{ headers: { 'Content-Type': 'application/json' } },
	)
	const text = await resp.text()
	return JSON.parse(text)
}

/** 存备份：优先代理落盘（版本化，保留最近 5 份）；代理不可用时回退 sys_Storage 单槽 */
async function storeBackup(project: string, pcbUuid: string, source: string, note: string)
	: Promise<{ backupId: string, location: 'proxy' | 'storage', file?: string, pruned?: Array<string> }> {
	try {
		const result = await proxyJson('/source-backup', 'POST', { project, pcbUuid, source, note })
		if (result?.ok && result.backupId)
			return { backupId: String(result.backupId), location: 'proxy', file: result.file, pruned: result.pruned }
		throw new Error(String(result?.error ?? '代理返回异常'))
	}
	catch (err) {
		await eda.sys_Storage.setExtensionUserConfig(STORAGE_BACKUP_KEY, JSON.stringify({
			pcbUuid, source, project, createdAt: new Date().toISOString(), note,
		}))
		return {
			backupId: `storage:${STORAGE_BACKUP_KEY}`,
			location: 'storage',
			pruned: [`代理不可用（${err instanceof Error ? err.message : String(err)}），已回退 EDA 扩展存储单槽备份（只保留最近一份）`],
		}
	}
}

async function listBackups(pcbUuid?: string): Promise<{ proxy: Array<IBackupMeta>, storage: IBackupMeta | null, proxyError?: string }> {
	let proxy: Array<IBackupMeta> = []
	let proxyError: string | undefined
	try {
		const result = await proxyJson(`/source-backup/list${pcbUuid ? `?pcbUuid=${encodeURIComponent(pcbUuid)}` : ''}`, 'GET')
		if (result?.ok && Array.isArray(result.backups))
			proxy = result.backups
		else
			proxyError = String(result?.error ?? '代理返回异常')
	}
	catch (err) {
		proxyError = err instanceof Error ? err.message : String(err)
	}
	let storage: IBackupMeta | null = null
	try {
		const raw = await eda.sys_Storage.getExtensionUserConfig(STORAGE_BACKUP_KEY)
		if (raw) {
			const backup = JSON.parse(String(raw))
			if (backup?.source && (!pcbUuid || !backup.pcbUuid || backup.pcbUuid === pcbUuid)) {
				storage = {
					backupId: `storage:${STORAGE_BACKUP_KEY}`,
					project: String(backup.project ?? ''),
					pcbUuid: String(backup.pcbUuid ?? ''),
					createdAt: String(backup.createdAt ?? ''),
					size: String(backup.source).length,
					note: backup.note ? String(backup.note) : 'EDA 扩展存储单槽备份',
				}
			}
		}
	}
	catch {
		// 存储读失败按无备份处理
	}
	return { proxy, storage, ...(proxyError ? { proxyError } : {}) }
}

async function readBackup(backupId: string | undefined, pcbUuid: string)
	: Promise<{ backupId: string, pcbUuid: string, source: string, createdAt?: string }> {
	if (backupId?.startsWith('storage:')) {
		const raw = await eda.sys_Storage.getExtensionUserConfig(STORAGE_BACKUP_KEY)
		if (!raw)
			throw new Error('扩展存储中没有源码备份')
		const backup = JSON.parse(String(raw))
		if (!backup?.source)
			throw new Error('扩展存储备份内容无效')
		return { backupId, pcbUuid: String(backup.pcbUuid ?? ''), source: String(backup.source), createdAt: backup.createdAt }
	}
	let result: any
	try {
		result = await proxyJson('/source-backup/read', 'POST', backupId ? { backupId } : { pcbUuid, latest: true })
	}
	catch (err) {
		throw new Error(`读取备份失败（代理不可达？）：${err instanceof Error ? err.message : String(err)}`)
	}
	if (!result?.ok)
		throw new Error(`读取备份失败：${String(result?.error ?? '未知错误')}`)
	return { backupId: String(result.backupId), pcbUuid: String(result.pcbUuid ?? ''), source: String(result.source), createdAt: result.createdAt }
}

// ---------- 板框识别（优先从 PCB 源码层 11 记录解析，回退实时 Polyline API） ----------

function boardFromSource(records: ReturnType<typeof parseSourceLog>['records']): IBBox | null {
	const points: Array<[number, number]> = []
	for (const record of records) {
		if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))
			continue
		const data = record.data as Record<string, unknown>
		if (Number(data.layerId) !== 11)
			continue
		// 0.10.26 修复（0.10.24 终验实锤：板框解析成 (-100,-100)–(3360,3360)，与旧 autoPlace（0.10.47 已删）的
		// outline 识别 (0,-1400)–(3360,-100) 矛盾）——板框 POLY 记录的几何是 path 多边形源数组
		// （['R', x, y(上沿), w, h, ...] 带字符串标记），collectRecordPoints 把它当纯数字对顺序配对
		// 会把宽度当高度、读出交叉错位点。带字符串标记的 path 必须走多边形源语义解析
		if (Array.isArray(data.path) && data.path.some(t => typeof t === 'string')) {
			const bb = bboxFromPolygonSource(data.path as Array<unknown>)
			if (bb) {
				points.push([bb.minX, bb.minY], [bb.maxX, bb.maxY])
				continue
			}
		}
		points.push(...collectRecordPoints(data))
	}
	if (points.length < 2)
		return null
	return {
		minX: Math.min(...points.map(p => p[0])),
		minY: Math.min(...points.map(p => p[1])),
		maxX: Math.max(...points.map(p => p[0])),
		maxY: Math.max(...points.map(p => p[1])),
	}
}

function safeState<T>(obj: any, method: string): T | undefined {
	try {
		const fn = obj?.[method]
		if (typeof fn === 'function')
			return fn.call(obj) as T
	}
	catch {
		// 忽略
	}
	return undefined
}

/** 多边形源数组 → 包围盒（'R' 的 y 是上沿，向下延伸 h；坐标系 +Y 向上） */
function bboxFromPolygonSource(src: Array<unknown>): IBBox | undefined {
	if (!Array.isArray(src))
		return undefined
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
	const addPt = (x: number, y: number) => {
		if (!Number.isFinite(x) || !Number.isFinite(y))
			return
		minX = Math.min(minX, x); minY = Math.min(minY, y)
		maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
	}
	let i = 0
	while (i < src.length) {
		const tok = src[i]
		if (tok === 'R') {
			const x = Number(src[i + 1]), y = Number(src[i + 2]), w = Number(src[i + 3]), h = Number(src[i + 4])
			addPt(x, y); addPt(x + w, y - h)
			i += 7
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
			i++
			while (i < src.length && typeof src[i] !== 'string')
				i++
		}
		else {
			i++
		}
	}
	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined
}

async function resolveBoardBBox(records: ReturnType<typeof parseSourceLog>['records']): Promise<{ board: IBBox, source: string }> {
	// 0.10.26：优先实时 API（终验 2 实测正确），源码解析兜底；
	// 两者都有且不一致时采信实时 API 并在 source 里注明（源码解析曾有把 POLY path 当数字对误读的前科）
	const isOutlineLayer = (lay: unknown) =>
		lay === 11 || String(lay) === '11' || /outline/i.test(String(lay))
	let fromApi: IBBox | undefined
	try {
		const polylines = (await eda.pcb_PrimitivePolyline.getAll()) ?? []
		for (const pl of polylines) {
			if (!isOutlineLayer(safeState<unknown>(pl, 'getState_Layer')))
				continue
			const poly = safeState<unknown>(pl, 'getState_Polygon')
			const bb = bboxFromPolygonSource(safeState<Array<unknown>>(poly, 'getSource') as Array<unknown>)
			if (bb) {
				fromApi = bb
				break
			}
		}
		if (!fromApi) {
			const regions = (await (eda.pcb_PrimitiveRegion as any).getAll()) ?? []
			for (const r of regions) {
				if (!isOutlineLayer(safeState<unknown>(r, 'getState_Layer')))
					continue
				const poly = safeState<unknown>(r, 'getState_ComplexPolygon')
				if (!poly)
					continue
				const pts = await eda.pcb_MathPolygon.discretize(poly as any).catch(() => undefined)
				if (pts?.length) {
					const xs = pts.map((p: any) => Number(p.x))
					const ys = pts.map((p: any) => Number(p.y))
					fromApi = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
					break
				}
			}
		}
	}
	catch {
		// 实时 API 不可用则走源码
	}
	const fromSource = boardFromSource(records)
	const valid = (b: IBBox | null | undefined): b is IBBox => Boolean(b && b.maxX - b.minX > 1 && b.maxY - b.minY > 1)
	if (valid(fromApi)) {
		if (valid(fromSource)
			&& (Math.abs(fromSource.minX - fromApi.minX) > 2 || Math.abs(fromSource.minY - fromApi.minY) > 2
				|| Math.abs(fromSource.maxX - fromApi.maxX) > 2 || Math.abs(fromSource.maxY - fromApi.maxY) > 2))
			return { board: fromApi, source: 'outline(api-crosscheck:源码解析与实时 API 不一致，采信实时 API)' }
		return { board: fromApi, source: 'outline' }
	}
	if (valid(fromSource))
		return { board: fromSource, source: 'source' }
	throw new Error('未识别到板框（实时 Polyline/Region API 与 PCB 源码层 11 都没读到）。请先 pcb.drawOutline 画板框，或显式传 origin + boardSize 参数')
}

// ---------- 器件几何测量：封装源码 → getPrimitivesBBox 补测（分批 12） → 通用兜底 ----------
// 0.10.29：与官方 eext-pcb-component-grouping measurePcbGeometry 一致的三级链。
// 0.10.30：① 封装源码提取加非几何记录黑名单 + 合理性护栏（0.10.29 装机实锤 D1 被污染出 ~2048mil 虚高）；
// ② 每器件记录测量来源 measureSource（footprint-source / primitives-bbox / fallback），
// 返回里带 measured 标记便于诊断估算兜底失真

type MeasureSource = 'footprint-source' | 'primitives-bbox' | 'fallback'

interface IMeasureResult {
	geometry: Map<string, IBBox>
	sources: Map<string, MeasureSource>
}

async function measureGeometry(components: Array<ISourcePcbComponent>): Promise<IMeasureResult> {
	const geometry = new Map<string, IBBox>()
	const sources = new Map<string, MeasureSource>()
	const footprints = new Map<string, IBBox>()
	try {
		const fpsSources = await eda.sys_FileManager.getDocumentFootprintSources().catch(() => [] as Array<{ footprintUuid: string, documentSource: string }>)
		for (const source of fpsSources ?? []) {
			const bbox = extractFootprintGeometry(source.documentSource)
			if (!bbox)
				continue
			footprints.set(source.footprintUuid.trim().toLowerCase(), bbox)
			try {
				footprints.set(parseSourceLog(source.documentSource).uuid.trim().toLowerCase(), bbox)
			}
			catch {
				// 外部 footprintUuid 是主键
			}
		}
	}
	catch {
		// beta 接口在部分文档为空，走补测
	}
	for (const component of components) {
		const footprint = footprints.get(component.footprintUuid.trim().toLowerCase())
		if (footprint) {
			geometry.set(component.id, transformFootprintBBox(footprint, component.x, component.y, component.angle, component.layerId === 2))
			sources.set(component.id, 'footprint-source')
		}
	}
	const missing = components.filter(component => !geometry.has(component.id))
	for (let offset = 0; offset < missing.length; offset += 12) {
		const batch = missing.slice(offset, offset + 12)
		const boxes = await Promise.all(batch.map(component => eda.pcb_Primitive.getPrimitivesBBox([component.id]).catch(() => undefined)))
		for (let index = 0; index < batch.length; index++) {
			if (boxes[index]) {
				geometry.set(batch[index].id, boxes[index]!)
				sources.set(batch[index].id, 'primitives-bbox')
			}
			else {
				geometry.set(batch[index].id, fallbackBBox(batch[index]))
				sources.set(batch[index].id, 'fallback')
			}
		}
	}
	return { geometry, sources }
}

/** 0.10.30：绕锚点把 bbox 从 fromAngle 旋转到 toAngle（实测口径自检/障碍物用，不进布局算法） */
function rotateBBoxAroundAnchor(bbox: IBBox, ax: number, ay: number, fromAngle: number, toAngle: number): IBBox {
	const delta = (((toAngle - fromAngle) % 360) + 360) % 360
	if (delta === 0)
		return { ...bbox }
	if (delta === 180)
		return { minX: 2 * ax - bbox.maxX, minY: 2 * ay - bbox.maxY, maxX: 2 * ax - bbox.minX, maxY: 2 * ay - bbox.minY }
	if (delta === 90)
		return { minX: ax - (bbox.maxY - ay), minY: ay + (bbox.minX - ax), maxX: ax - (bbox.minY - ay), maxY: ay + (bbox.maxX - ax) }
	return { minX: ax + (bbox.minY - ay), minY: ay - (bbox.maxX - ax), maxX: ax + (bbox.maxY - ay), maxY: ay - (bbox.minX - ax) }
}

/**
 * 0.10.30 实测口径 bbox（checkPlacement 同款：pcb_Primitive.getPrimitivesBBox 真实焊盘包围盒）：
 * 量器件当前姿态的 bbox，绕锚点旋转到目标角度，再平移到目标位置。
 * 布局/自检/障碍物统一用它；量不到才回退布局估算盒（返回里注明口径）。
 */
async function measureActualBBoxes(items: Array<{ component: ISourcePcbComponent, targetX: number, targetY: number, targetAngle: number }>): Promise<Map<string, IBBox>> {
	const result = new Map<string, IBBox>()
	for (let offset = 0; offset < items.length; offset += 12) {
		const batch = items.slice(offset, offset + 12)
		const boxes = await Promise.all(batch.map(item => eda.pcb_Primitive.getPrimitivesBBox([item.component.id]).catch(() => undefined)))
		for (let index = 0; index < batch.length; index++) {
			const measured = boxes[index]
			if (!measured)
				continue
			const item = batch[index]
			const rotated = rotateBBoxAroundAnchor(measured, item.component.x, item.component.y, item.component.angle, item.targetAngle)
			const dx = item.targetX - item.component.x
			const dy = item.targetY - item.component.y
			result.set(item.component.id, { minX: rotated.minX + dx, minY: rotated.minY + dy, maxX: rotated.maxX + dx, maxY: rotated.maxY + dy })
		}
	}
	return result
}

// ---------- 分组与布局 ----------

function normalizedDesignator(value: string): string {
	// 多器件符号可能写作 U1A/U1B 而 PCB 里是 U1
	return value.trim().toUpperCase().replace(/([A-Z]+\d+)[A-Z]+$/, '$1')
}

function prefixOf(designator: string): string {
	return /^[A-Z]+/i.exec(designator)?.[0].toUpperCase() ?? 'OTHER'
}

function prefixRank(prefix: string): number {
	const rank = ['U', 'R', 'C', 'L', 'D', 'Q']
	const index = rank.indexOf(prefix)
	return index < 0 ? 99 : index
}

interface IPlannedPlacement {
	component: ISourcePcbComponent
	x: number
	y: number
	angle: number
	bbox: IBBox
}

interface IPlannedGroup {
	name: string
	pageName: string
	pageUuid: string
	rectId: string
	components: Array<ISourcePcbComponent>
	placements: Array<IPlannedPlacement>
	bbox: IBBox
	/** 组名文本的 Y（官方分隔线+35 位置），由 planLayoutOfficial 写入 */
	labelY?: number
	/** 0.10.30：避让不开的既有器件位号（出口闸报错时列出） */
	blockedBy?: Array<string>
	/** 0.10.30：成功避让过的既有器件位号（诊断用） */
	avoidedObstacles?: Array<string>
}

function layoutBBox(component: ISourcePcbComponent, geometry: Map<string, IBBox>): IBBox {
	return geometry.get(component.id) ?? fallbackBBox(component)
}

// ---------- 布局引擎：0.10.29 起忠实移植官方 eext-pcb-component-grouping ----------
// 来源：offline-test/ref-eext-pcb-component-grouping/src/source/source-grouping.ts 的 buildPcbPatch 排布部分。
// 0.10.26~0.10.28 三轮自改（推挤记账修复/面积最小化/顶边锚定/角度归一）全部移除——官方算法在 X86 主板
// 验证过，先求行为完全一致。与官方仅有的差异：① 排布起点从 (0,0) 平移到板框内左下角（等效整体平移，
// 不改变相对布局）；② 排完校验任何组出板框即报错不写（出口闸）；③ 官方兜底估算里的 X86 项目特定
// 封装指纹（screen/h618/hdmi/rj- 等 uuid 识别）不具通用性，未移植，用通用兜底。

/** 官方 componentLayoutBBox：器件本体 bbox + 位号丝印文本预留（与丝印随动目标位一致的占位） */
function componentLayoutBBox(component: ISourcePcbComponent, geometry: Map<string, IBBox>, attrRecords: ReturnType<typeof effectiveRecordsByType>): IBBox {
	const body = layoutBBox(component, geometry)
	const result = { ...body }
	for (const record of attrRecords) {
		const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {}
		if (data.parentId !== component.id || String(data.key ?? '').toLowerCase() !== 'designator' || !(data.valueVisible === true || data.valueVisible === 1))
			continue
		const fontSize = typeof data.fontSize === 'number' && data.fontSize > 0 ? data.fontSize : 45
		const text = String(data.value ?? component.designator)
		const textWidth = Math.max(fontSize, text.length * fontSize * 0.62)
		result.minX = Math.min(result.minX, body.minX)
		result.maxX = Math.max(result.maxX, body.minX + textWidth)
		result.maxY = Math.max(result.maxY, body.maxY + 5 + fontSize)
	}
	return result
}

/**
 * 0.10.32：R/C/L 落子强制 angle=0（见 planLayoutOfficial），布局估算盒同步归 0 姿态——
 * 把实测 bbox 四角绕器件原点 (component.x, component.y) 逆旋转 -angle 后取外接盒。
 * 否则旋转 90° 的 R 会按"横宽竖窄"算 pitch、却按 0°"竖窄横宽"落子，导致组内重叠或稀疏。
 * 非 RCL 器件保持原角落子（估算姿态=落子姿态），无需变换。丝印预留随盒一起转，与随动后姿态一致。
 */
function uprightContentBBox(component: ISourcePcbComponent, geometry: Map<string, IBBox>, attrRecords: ReturnType<typeof effectiveRecordsByType>): IBBox {
	const box = componentLayoutBBox(component, geometry, attrRecords)
	const angle = Number(component.angle) || 0
	const norm = ((angle % 360) + 360) % 360
	if (!/^[RCL]\d+/i.test(component.designator ?? '') || norm === 0)
		return box
	const rad = -angle * Math.PI / 180
	const cos = Math.cos(rad)
	const sin = Math.sin(rad)
	const cx = component.x
	const cy = component.y
	const corners: Array<[number, number]> = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]]
	const xs: Array<number> = []
	const ys: Array<number> = []
	for (const [px, py] of corners) {
		const dx = px - cx
		const dy = py - cy
		xs.push(cx + dx * cos - dy * sin)
		ys.push(cy + dx * sin + dy * cos)
	}
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/**
 * 官方布局引擎（buildPcbPatch 排布部分原逻辑，逐行对照移植）：
 * 组按估算面积升序 → 货架横排（rowLimit = max(最宽组估算宽, round(√总估算面积))，超行换行向上
 * groupY += 行高 + 组缝）；组内按位号前缀分行（行排序：行内器件数升序 → 前缀 U>R>C>L>D>Q>其他），
 * 从组底 margin 起逐行向上排；行内贪心避让（候选与已放相交则按推得短的方向推，最多 placedBoxes.length+1 轮），
 * R/C/L 强制 angle=0。常量与官方一致：componentGap=10 / rowGap=15 / margin=15 / labelHeight=70 / 组缝 120。
 * 结果写回 group.placements / group.bbox（bbox 含顶部标签区，由实际落子外扩得出，必然包住全部落子）。
 * 0.10.32 差异：① rowLimit 收紧到板框可用宽度 availWidth（组少时 √总面积≈组宽会提前换行、横向大片浪费）；
 * ② 布局估算盒经 uprightContentBBox 归 0 姿态（见上）；③ 返回 rowLimit 供出口闸报错诊断。
 */
function planLayoutOfficial(groups: Array<IPlannedGroup>, geometry: Map<string, IBBox>, attrRecords: ReturnType<typeof effectiveRecordsByType>, originX: number, originBottomY: number, groupGap: number, obstacles: Array<{ designator: string, bbox: IBBox }> = [], availWidth: number = Infinity): { rowLimit: number } {
	const componentGap = 10
	const rowGap = 15
	const margin = 15
	const labelHeight = 70
	const estimatedGroupArea = (group: IPlannedGroup): number => {
		const boxes = group.components.map(component => uprightContentBBox(component, geometry, attrRecords))
		const width = boxes.reduce((sum, box) => sum + box.maxX - box.minX + 10, 30)
		const height = Math.max(...boxes.map(box => box.maxY - box.minY), 1) + 120
		return width * height
	}
	const sortedGroups = [...groups].sort((a, b) => estimatedGroupArea(a) - estimatedGroupArea(b) || a.components.length - b.components.length || a.name.localeCompare(b.name, undefined, { numeric: true }))
	const groupSizes = sortedGroups.map((group) => {
		const byPrefix = new Map<string, Array<ISourcePcbComponent>>()
		for (const component of group.components) {
			const prefix = prefixOf(component.designator)
			if (!byPrefix.has(prefix))
				byPrefix.set(prefix, [])
			byPrefix.get(prefix)!.push(component)
		}
		const rows = Array.from(byPrefix.entries()).sort(([a], [b]) => prefixRank(a) - prefixRank(b)).map(([, items]) => {
			const boxes = items.map(item => uprightContentBBox(item, geometry, attrRecords))
			return {
				width: boxes.reduce((sum, box) => sum + box.maxX - box.minX, 0) + Math.max(0, boxes.length - 1) * 20,
				height: Math.max(...boxes.map(box => box.maxY - box.minY)),
			}
		})
		return {
			width: Math.max(...rows.map(row => row.width)) + 60,
			height: rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * 20 + 130,
		}
	})
	const totalArea = groupSizes.reduce((sum, size) => sum + size.width * size.height, 0)
	const maxGroupWidth = Math.max(...groupSizes.map(size => size.width))
	// 0.10.32：rowLimit 收紧到板框可用宽度——√总面积在组少时≈组宽，第二组刚超就换行，横向浪费且易上溢出板。
	// 保底 maxGroupWidth：板宽连最宽组都放不下时退化为官方行为（每组独占一行），由出口闸如实报错。
	const rowLimit = Math.min(Math.max(maxGroupWidth, Math.round(Math.sqrt(totalArea))), Math.max(availWidth, maxGroupWidth))
	let groupX = originX
	let groupY = originBottomY
	let shelfRowHeight = 0
	for (const group of sortedGroups) {
		const sorted = [...group.components].sort((a, b) => prefixRank(prefixOf(a.designator)) - prefixRank(prefixOf(b.designator)) || prefixOf(a.designator).localeCompare(prefixOf(b.designator)) || a.designator.localeCompare(b.designator, undefined, { numeric: true }))
		const rowMap = new Map<string, Array<ISourcePcbComponent>>()
		for (const component of sorted) {
			const prefix = prefixOf(component.designator)
			if (!rowMap.has(prefix))
				rowMap.set(prefix, [])
			rowMap.get(prefix)!.push(component)
		}
		const rows = Array.from(rowMap.entries()).sort(([a, aItems], [b, bItems]) => aItems.length - bItems.length || prefixRank(a) - prefixRank(b))
		const rowSizes = rows.map(([, items]) => {
			const boxes = items.map(component => uprightContentBBox(component, geometry, attrRecords))
			return {
				width: boxes.reduce((total, box) => total + box.maxX - box.minX, 0) + Math.max(0, boxes.length - 1) * componentGap,
				height: Math.max(...boxes.map(box => box.maxY - box.minY)),
			}
		})
		const width = Math.max(...rowSizes.map(row => row.width)) + margin * 2
		const contentHeight = rowSizes.reduce((total, row) => total + row.height, 0) + Math.max(0, rowSizes.length - 1) * rowGap
		const height = contentHeight + margin * 2 + labelHeight + 20
		// 单次落位（官方组内算法原样，仅参数化起点；组 bbox/labelY 一并算出）
		const placeGroupAt = (minX: number, minY: number): void => {
			group.placements.length = 0
			let rowTop = minY + margin
			const placedBoxes: Array<IBBox> = []
			for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
				const row = rows[rowIndex][1]
				const rowHeight = rowSizes[rowIndex].height
				let cursorX = minX + margin
				for (const component of row) {
					const content = uprightContentBBox(component, geometry, attrRecords)
					let x = cursorX - (content.minX - component.x)
					let y = rowTop - (content.minY - component.y)
					for (let pass = 0; pass < placedBoxes.length + 1; pass += 1) {
						const candidate = { minX: content.minX + x - component.x, minY: content.minY + y - component.y, maxX: content.maxX + x - component.x, maxY: content.maxY + y - component.y }
						const hit = placedBoxes.find(previous => candidate.minX < previous.maxX && candidate.maxX > previous.minX && candidate.minY < previous.maxY && candidate.maxY > previous.minY)
						if (!hit)
							break
						const pushX = hit.maxX - candidate.minX + componentGap
						const pushY = hit.maxY - candidate.minY + rowGap
						if (pushX <= pushY)
							x += pushX
						else
							y += pushY
					}
					const placed = { minX: content.minX + x - component.x, minY: content.minY + y - component.y, maxX: content.maxX + x - component.x, maxY: content.maxY + y - component.y }
					placedBoxes.push(placed)
					const angle = /^[RCL]\d+/i.test(component.designator) ? 0 : component.angle
					group.placements.push({ component, x, y, angle, bbox: placed })
					cursorX = Math.max(cursorX + content.maxX - content.minX + componentGap, placed.maxX + componentGap)
				}
				rowTop = Math.max(rowTop + rowHeight, ...placedBoxes.map(box => box.maxY)) + rowGap
			}
			// 组 bbox：官方 finalMaxX/finalMaxY 由实际落子外扩得出（含顶部标签区：分隔线 + 1 行组名文本）
			const labelWidth = Math.max(30, group.name.length * 30 * 0.62)
			const contentMaxY = Math.max(minY + margin + contentHeight, ...placedBoxes.map(box => box.maxY))
			const separatorY = contentMaxY + 20
			const finalMaxX = Math.max(minX + width, minX + margin + labelWidth, ...placedBoxes.map(box => box.maxX + margin))
			const finalMaxY = Math.max(minY + height, separatorY + 35 + 40 + margin)
			group.bbox = { minX, minY, maxX: finalMaxX, maxY: finalMaxY }
			group.labelY = separatorY + 35
		}
		// 0.10.30 既有器件避让（官方原版假设全板重排不管既有器件，装机实锤 J1×J3/J2×C6 撞机）：
		// 只动货架候选位——组 bbox 与障碍物相交则向右让开（让不开换行向上），组内算法不变
		// 0.10.32 避让循环修复（装机复测实锤：单组+21 障碍场景组被一路推过板顶误报上溢）：
		// ① 换行阈值收紧到 min(rowLimit, availWidth)——rowLimit 常远小于板可用宽，组还没碰到板右沿就被迫换行；
		// ② 换行时若本货架行还没有放成任何组（shelfRowHeight=0），至少抬升本组高度——否则 groupY 每次只 +groupGap
		//    原地踏步，组被障碍物群一路向上推（终点 y 与 origin 无关、恰在障碍群顶之上，观测"上溢量≈组全高"）。
		const hitsObstacle = (b: IBBox) => obstacles.find(o => b.minX < o.bbox.maxX && b.maxX > o.bbox.minX && b.minY < o.bbox.maxY && b.maxY > o.bbox.minY)
		const rowWidth = Math.min(rowLimit, availWidth)
		const blockers = new Set<string>()
		let placedOk = false
		for (let attempt = 0; attempt < 200 && !placedOk; attempt += 1) {
			if (groupX > originX && (groupX - originX) + width > rowWidth) {
				groupX = originX
				groupY += Math.max(shelfRowHeight, height) + groupGap
				shelfRowHeight = 0
			}
			placeGroupAt(groupX, groupY)
			const hit = hitsObstacle(group.bbox)
			if (!hit) {
				placedOk = true
				break
			}
			blockers.add(hit.designator)
			groupX = hit.bbox.maxX + groupGap // 向右让开障碍物，下轮重新校验（必要时换行）
		}
		if (!placedOk)
			group.blockedBy = [...blockers]
		else if (blockers.size)
			group.avoidedObstacles = [...blockers]
		groupX = group.bbox.maxX + groupGap
		shelfRowHeight = Math.max(shelfRowHeight, group.bbox.maxY - group.bbox.minY)
	}
	return { rowLimit }
}

/** 重叠自检（0.10.26）：全部已落子 bbox 两两相交计数，返回重叠对明细（避让失效时如实报出，不静默）。0.10.30 起可传实测焊盘口径 bbox（与 checkPlacement 同款），优先于布局估算盒 */
function countOverlapPairs(groups: Array<IPlannedGroup>, actualBoxes?: Map<string, IBBox>): Array<{ a: string, b: string, groupA: string, groupB: string }> {
	const all: Array<{ designator: string, group: string, bbox: IBBox }> = []
	for (const group of groups)
		for (const p of group.placements)
			all.push({ designator: p.component.designator, group: group.name, bbox: actualBoxes?.get(p.component.id) ?? p.bbox })
	const overlaps: Array<{ a: string, b: string, groupA: string, groupB: string }> = []
	for (let i = 0; i < all.length; i += 1) {
		for (let j = i + 1; j < all.length; j += 1) {
			const A = all[i].bbox
			const B = all[j].bbox
			if (A.minX < B.maxX && A.maxX > B.minX && A.minY < B.maxY && A.maxY > B.minY)
				overlaps.push({ a: all[i].designator, b: all[j].designator, groupA: all[i].group, groupB: all[j].group })
		}
	}
	return overlaps
}

/** 位号丝印随动：ATTR 记录里 key=designator 且可见的坐标同步改写（同官方 componentSilkRecords） */
function silkFollowRecords(source: ISourcePcbComponent, target: { x: number, y: number, angle: number, layerId: number }, body: IBBox, attrRecords: Array<ReturnType<typeof effectiveRecordsByType>[number]>): Array<IPendingRecord> {
	const result: Array<IPendingRecord> = []
	for (const record of attrRecords) {
		const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {}
		if (data.parentId !== source.id || String(data.key ?? '').toLowerCase() !== 'designator' || !(data.valueVisible === true || data.valueVisible === 1))
			continue
		const nextX = target.x + body.minX - source.x
		const nextY = target.y + body.maxY - source.y + 5
		const next: Record<string, unknown> = { ...data, parentId: source.id, layerId: 3, mirror: target.layerId === 2 }
		if ('positionX' in data)
			next.positionX = nextX
		if ('positionY' in data)
			next.positionY = nextY
		if ('x' in data)
			next.x = nextX
		if ('y' in data)
			next.y = nextY
		if ('angle' in data)
			next.angle = target.angle
		if ('rotation' in data)
			next.rotation = target.angle
		result.push({ header: { ...record.header }, data: next })
	}
	return result
}

let generatedCounter = 0
function createGeneratedId(): string {
	return `${GENERATED_PREFIX}${Date.now().toString(16)}_${(generatedCounter++).toString(16)}`
}

// ---------- 指令注册 ----------

export const pcbGroupingCommands: Array<ICommandDef> = [
	{
		name: 'pcb.groupBySchematicRegions',
		summary: '【宏·0.10.22】按原理图 RECT 功能区框把 PCB 器件聚合分组：读全部原理图页区框（pageUuid 可限定），器件按归属判定（位号文本位置优先、多框取面积最小）分组；0.10.29 起布局引擎忠实移植官方 eext-pcb-component-grouping 原版（组内前缀分行：行按器件数升序再 U>R>C>L>D>Q，从组底向上排，贪心避让 componentGap 10/rowGap 15/margin 15/标签区 70；组间货架横排 rowLimit=max(最宽组,√总估算面积) 组缝 120，从原点向右向上铺），与官方唯一差异是排完校验出板框即报错不写（出口闸，绝不静默摆出板外）。写入走文档源码 append-only 补丁（移动器件坐标双字段同改；组边框+组名文本生成 spg_ 前缀文档层图元，重复执行先墓碑清场），五步管线：版本化备份（代理落盘 backups/<工程>/<时间戳>.txt 保留最近 5 份，代理不可用回退 sys_Storage 单槽）→ setDocumentSource → 回读逐器件比对（容差 0.001）→ 失败整份恢复 → 全过才保存。dryRun 默认 true 只返回分组预览，确认后 dryRun:false 才动PCB。⚠️ 调用前焦点须在 PCB（文档守卫），执行中会短暂切换焦点读原理图页，结束后回到 PCB',
		params: [
			{ name: 'pageUuid', type: 'string', description: '只读取这一张原理图页的区框（留空为全部图页）' },
			{ name: 'dryRun', type: 'boolean', description: '默认 true：只返回分组预览（每组器件清单/计划摆放区/未分组清单），不写入' },
			{ name: 'origin', type: 'object', description: '摆放起点 {x, y}（mil，0.10.29 起为组块【左下角】——官方算法向右向上排），默认板框内左下（内缩一个 groupGap）' },
			{ name: 'boardSize', type: 'object', description: '板框识别失败时兜底 {width, height}（mil，从 origin 向右向上延伸），与 origin 一起用' },
			{ name: 'groupGap', type: 'number', description: '组间间隙（mil，默认 120，与官方一致）' },
		],
		returns: '{ board, groups: [{ name, pageName, count, designators, bbox }], moved, ungrouped, locked, backupId, backupLocation, verify, saved, dryRun }',
		example: { cmd: 'pcb.groupBySchematicRegions', params: { dryRun: true } },
		handler: async (params) => {
			const dryRun = params.dryRun !== false
			const groupGap = params.groupGap != null ? Number(params.groupGap) : 120

			// ---------- ① 定位 Board ----------
			const project = await eda.dmt_Project.getCurrentProjectInfo()
			if (!project)
				throw new Error('当前没有打开工程')
			const currentDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			const boards = (project as any).data ?? []
			const board = boards.find((item: any) => item.pcb?.uuid && item.pcb.uuid === (currentDoc as any)?.uuid)
				?? boards.find((item: any) => item.pcb?.uuid)
			if (!board?.pcb?.uuid)
				throw new Error('工程中没有可用的 PCB（请先 project.associateBoard 关联或创建 PCB）')
			const projectName = String((project as any).friendlyName ?? (project as any).name ?? 'project')

			// ---------- ② 逐页读原理图区框（openDocument→activate→getDocumentSource） ----------
			// 0.10.65 修复：读每页后校验 parsed.uuid === page.uuid（openDocument 失败/焦点漂移时
			// getDocumentSource 会静默读错文档），不符即中止；②③任一步抛错时把焦点拉回 PCB 页签
			const pages: Array<{ name: string, uuid: string, rects: Array<ISourceRect>, components: ReturnType<typeof extractSchematicRects>['components'] }> = []
			let pcbDocument: ReturnType<typeof parseSourceLog>
			let pcbSource: string
			let parsedPcb: ReturnType<typeof extractPcbDocument>
			try {
				const schPages = (board.schematic?.page ?? []).filter((page: any) => !params.pageUuid || page.uuid === String(params.pageUuid))
				if (params.pageUuid && !schPages.length)
					throw new Error(`pageUuid ${params.pageUuid} 不在当前 Board 的原理图页清单里`)
				for (const page of schPages) {
					const tab = await eda.dmt_EditorControl.openDocument(String(page.uuid))
					if (tab)
						await eda.dmt_EditorControl.activateDocument(tab as any).catch(() => false)
					const source = await eda.sys_FileManager.getDocumentSource()
					if (!source)
						throw new Error(`无法获取原理图源码：${page.name ?? page.uuid}`)
					const parsed = extractSchematicRects(source)
					if (parsed.uuid !== String(page.uuid))
						throw new Error(`原理图页源码身份不符：期望 ${page.uuid}，读到 ${parsed.uuid ?? '未知 uuid'}（页打开失败或焦点在别的文档），已中止以防止分组错页`)
					pages.push({ name: String(page.name ?? parsed.uuid), uuid: parsed.uuid, rects: parsed.rects, components: parsed.components })
				}

				// ---------- ③ 读 PCB 源码并校验身份 ----------
				const pcbTab = await eda.dmt_EditorControl.openDocument(String(board.pcb.uuid))
				if (pcbTab)
					await eda.dmt_EditorControl.activateDocument(pcbTab as any).catch(() => false)
				pcbSource = (await eda.sys_FileManager.getDocumentSource()) as string
				if (!pcbSource)
					throw new Error('无法获取 PCB 源码')
				parsedPcb = extractPcbDocument(pcbSource)
				if (parsedPcb.uuid !== board.pcb.uuid)
					throw new Error('当前 PCB 源码 uuid 与工程 PCB 不匹配，已中止（防止写错文档）')
				pcbDocument = parseSourceLog(pcbSource)
			}
			catch (err) {
				await eda.dmt_EditorControl.openDocument(String(board.pcb.uuid))
					.then((t: any) => t && eda.dmt_EditorControl.activateDocument(t as any))
					.catch(() => false)
				throw err
			}

			// ---------- ④ 分组归属（位号锚点优先、多框取面积最小） ----------
			const movable = parsedPcb.components.filter(component => component.designator)
			const claimed = new Set<string>()
			const groups: Array<IPlannedGroup> = []
			for (const page of pages) {
				for (const rect of page.rects) {
					const members: Array<ISourcePcbComponent> = []
					for (const schComp of page.components) {
						if (!schComp.designator || findOwningRect(page.rects, schComp)?.id !== rect.id)
							continue
						const wanted = normalizedDesignator(schComp.designator)
						const pcb = movable.find(component => normalizedDesignator(component.designator) === wanted)
						if (!pcb || claimed.has(pcb.id))
							continue
						if (pcb.locked)
							continue // 锁定器件不搬，列入 locked 清单
						claimed.add(pcb.id)
						members.push(pcb)
					}
					if (members.length) {
						groups.push({
							name: `${page.name}/${rect.label}`,
							pageName: page.name,
							pageUuid: page.uuid,
							rectId: rect.id,
							components: members,
							placements: [],
							bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
						})
					}
				}
			}
			const locked = movable.filter(component => component.locked && pages.some(page => page.components.some(schComp => normalizedDesignator(schComp.designator) === normalizedDesignator(component.designator)))).map(component => component.designator)
			const ungrouped = movable.filter(component => !claimed.has(component.id) && !component.locked).map(component => component.designator)
			if (!groups.length)
				throw new Error(`没有任何器件落入原理图区框（区框总数 ${pages.reduce((sum, page) => sum + page.rects.length, 0)}）。请先用 schematic.placeRegion 画功能区框，或检查原理图位号与 PCB 是否一致`)

			// ---------- ⑤ 板框与排布起点（0.10.29 起官方算法向上排：origin = 左下角起点） ----------
			let boardBox: IBBox
			let boardSrc: string
			if (params.boardSize && params.origin) {
				boardBox = {
					minX: Number((params.origin as any).x ?? 0),
					minY: Number((params.origin as any).y ?? 0),
					maxX: Number((params.origin as any).x ?? 0) + Number((params.boardSize as any).width ?? 2000),
					maxY: Number((params.origin as any).y ?? 0) + Number((params.boardSize as any).height ?? 1600),
				}
				boardSrc = 'param'
			}
			else {
				const resolved = await resolveBoardBBox(pcbDocument.records)
				boardBox = resolved.board
				boardSrc = resolved.source
			}
			const originX = params.origin ? Number((params.origin as any).x ?? 0) : boardBox.minX + groupGap
			const originBottomY = params.origin ? Number((params.origin as any).y ?? 0) : boardBox.minY + groupGap
			if (originX < boardBox.minX || originBottomY < boardBox.minY || originX >= boardBox.maxX || originBottomY >= boardBox.maxY)
				throw new Error(`摆放起点 (${originX},${originBottomY}) 不在板框内（板框 ${JSON.stringify(boardBox)}）`)

			// ---------- ⑥ 几何测量 + 官方布局（0.10.29 起忠实移植官方 buildPcbPatch 排布） ----------
			const { geometry, sources: measureSources } = await measureGeometry(parsedPcb.components)
			const attrRecords = effectiveRecordsByType(pcbDocument, 'ATTR')
			// 0.10.30 障碍物：未被任何区框认领的既有器件（含锁定与未分组）按当前姿态实测 bbox，排布时绕开
			const obstacleComponents = parsedPcb.components.filter(component => !claimed.has(component.id))
			const obstacleMeasured = await measureActualBBoxes(obstacleComponents.map(component => ({ component, targetX: component.x, targetY: component.y, targetAngle: component.angle })))
			const obstacles = obstacleComponents.map(component => ({
				designator: component.designator ?? component.id,
				bbox: obstacleMeasured.get(component.id) ?? geometry.get(component.id) ?? fallbackBBox(component),
			}))
			const layoutDiag = planLayoutOfficial(groups, geometry, attrRecords, originX, originBottomY, groupGap, obstacles, boardBox.maxX - originX)
			// 出口闸（与官方的行为差异之一）：任何组出板框即报错，绝不写入
			const overflow = groups
				.filter(group => group.bbox.maxX > boardBox.maxX || group.bbox.maxY > boardBox.maxY)
				.map(group => ({
					group: group.name,
					overRight: Math.max(0, Math.round(group.bbox.maxX - boardBox.maxX)),
					overTop: Math.max(0, Math.round(group.bbox.maxY - boardBox.maxY)),
				}))
			if (overflow.length) {
				// 0.10.32：报错附诊断——板框尺寸/可用宽度/货架行宽上限/各组估算 bbox，便于判断是板小还是排布策略问题
				const boardW = Math.round(boardBox.maxX - boardBox.minX)
				const boardH = Math.round(boardBox.maxY - boardBox.minY)
				const availW = Math.round(boardBox.maxX - originX)
				const groupSizesText = groups.map(group => `${group.name} ${Math.round(group.bbox.maxX - group.bbox.minX)}×${Math.round(group.bbox.maxY - group.bbox.minY)}`).join('、')
				throw new Error(
					`摆不下：${overflow.length} 个组超出板框（${overflow.map(item => `${item.group} 右溢 ${item.overRight}mil/上溢 ${item.overTop}mil`).join('；')}）。`
					+ `诊断：板框 ${boardW}×${boardH}mil，origin 后可用宽 ${availW}mil，货架行宽上限 ${Math.round(layoutDiag.rowLimit)}mil；各组 bbox：${groupSizesText}。`
					+ '请增大板框、减少每组器件、调小 groupGap，或改 origin；本次未写入任何改动',
				)
			}
			// 出口闸之二：200 次尝试仍绕不开既有器件的组，如实报错不写入
			const blocked = groups.filter(group => group.blockedBy?.length)
			if (blocked.length) {
				throw new Error(
					`摆不下：${blocked.length} 个组被既有器件挡住（${blocked.map(group => `${group.name} ← ${group.blockedBy!.join('、')}`).join('；')}）。`
					+ '请拆小区框、挪走挡路的既有器件，或调整 origin/groupGap；本次未写入任何改动',
				)
			}

			const groupSummaries = groups.map(group => ({
				name: group.name,
				pageName: group.pageName,
				count: group.placements.length,
				designators: group.placements.map(placement => placement.component.designator),
				bbox: group.bbox,
				...(group.avoidedObstacles?.length ? { avoidedObstacles: group.avoidedObstacles } : {}),
				// 0.10.26：预览与实跑都带逐项落子坐标（同一套布局计算），调用方可逐项比对杜绝"预览≠实跑"
				placements: group.placements.map(placement => ({
					designator: placement.component.designator,
					x: Math.round(placement.x * 1000) / 1000,
					y: Math.round(placement.y * 1000) / 1000,
					angle: placement.angle,
					// 0.10.30：测量口径逐项标记（fallback = 估算盒，宽高可能与真实封装有偏差）
					measured: measureSources.get(placement.component.id) !== 'fallback',
					measureSource: measureSources.get(placement.component.id) ?? 'fallback',
				})),
			}))
			// 0.10.30 执行后自检改实测口径：按落子坐标/角度量真实焊盘 bbox（checkPlacement 同款），量不到的回退布局估算盒
			const allPlacements = groups.flatMap(group => group.placements)
			const actualBoxes = await measureActualBBoxes(allPlacements.map(placement => ({ component: placement.component, targetX: placement.x, targetY: placement.y, targetAngle: placement.angle })))
			const overlapPairs = countOverlapPairs(groups, actualBoxes)
			const overlapReport = {
				count: overlapPairs.length,
				caliber: 'actual-pads（checkPlacement 同款焊盘口径）',
				measuredCount: actualBoxes.size,
				fallbackCount: allPlacements.length - actualBoxes.size,
				...(allPlacements.length - actualBoxes.size > 0 ? { caliberNote: `${allPlacements.length - actualBoxes.size} 个器件实测失败，回退布局估算盒参与自检` } : {}),
				...(overlapPairs.length ? { pairs: overlapPairs.slice(0, 20) } : {}),
			}

			if (dryRun) {
				return {
					dryRun: true,
					board: { ...boardBox, source: boardSrc },
					origin: { x: originX, y: originBottomY },
					groups: groupSummaries,
					moved: 0,
					ungrouped,
					overlapCheck: overlapReport,
					...(overlapPairs.length ? { warning: `⚠️ 布局自检：计划落子存在 ${overlapPairs.length} 对 bbox 重叠（overlapCheck.pairs）——正式执行前建议调大 groupGap 或拆分区框` } : {}),
					...(locked.length ? { locked, lockedNote: '这些器件已锁定，不会搬动' } : {}),
					note: '预览未写入。确认后 dryRun:false 正式执行（自动备份+回读校验+失败恢复）；placements 为计划落子坐标，实跑后将逐项与回读比对',
				}
			}

			// ---------- ⑦ 生成 append-only 补丁 ----------
			let ticket = getMaxTicket(pcbDocument)
			const pending: Array<IPendingRecord> = []
			// 重复执行先对全部 spg_* 生成物墓碑清场
			pending.push(...tombstoneByPrefix(pcbDocument, GENERATED_PREFIX, ticket))
			ticket += pending.length
			const expected: Array<{ id: string, designator: string, x: number, y: number, angle: number }> = []
			for (const group of groups) {
				for (const placement of group.placements) {
					pending.push({ header: { ...placement.component.header, ticket: ++ticket }, data: moveComponentData(placement.component, placement.x, placement.y, placement.angle) })
					for (const silk of silkFollowRecords(placement.component, { x: placement.x, y: placement.y, angle: placement.angle, layerId: placement.component.layerId }, layoutBBox(placement.component, geometry), attrRecords))
						pending.push({ header: { ...silk.header, ticket: ++ticket }, data: silk.data })
					expected.push({ id: placement.component.id, designator: placement.component.designator, x: placement.x, y: placement.y, angle: placement.angle })
				}
				// 组边框 + 组名文本（spg_ 前缀、文档层 13、zIndex -1）
				const w = group.bbox.maxX - group.bbox.minX
				const h = group.bbox.maxY - group.bbox.minY
				pending.push({
					header: { type: 'POLY', id: createGeneratedId(), ticket: ++ticket },
					data: { partitionId: '', groupId: 0, netName: '', layerId: DOCUMENT_LAYER, width: 10, path: ['R', group.bbox.minX, group.bbox.maxY, w, h, 0, 0], locked: false, zIndex: -1, polyType: 'NORMAL' },
				})
				pending.push({
					header: { type: 'STRING', id: createGeneratedId(), ticket: ++ticket },
					data: { partitionId: '', groupId: 0, layerId: DOCUMENT_LAYER, x: group.bbox.minX + 18, y: group.labelY ?? (group.bbox.maxY - 45), text: group.name, fontFamily: 'default', fontSize: 30, strokeWidth: 3, bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle: 0, reverse: false, expansion: 0, mirror: false, locked: false, zIndex: -1, specialColor: null },
				})
			}
			const patchSource = appendRecords(pcbSource, pending)

			// ---------- ⑧ 五步写回管线：备份 → 写入 → 回读 → 逐器件比对 → 全过才保存 ----------
			const backup = await storeBackup(projectName, String(board.pcb.uuid), pcbSource, `pcb.groupBySchematicRegions 写入前备份（${expected.length} 器件 / ${groups.length} 组）`)
			try {
				const writeOk = await eda.sys_FileManager.setDocumentSource(patchSource)
				if (!writeOk)
					throw new Error('setDocumentSource 返回 false（官方运行时校验拒绝）')
				const written = await eda.sys_FileManager.getDocumentSource()
				if (!written)
					throw new Error('写入后回读源码为空')
				const verify = verifyMovedComponents(written, expected, 0.001)
				if (!verify.ok) {
					throw new Error(`回读校验失败：${verify.mismatches.slice(0, 5).map(m => `${m.designator} 期望(${m.expected.x},${m.expected.y},${m.expected.angle}) 实际${m.actual ? `(${m.actual.x},${m.actual.y},${m.actual.angle})` : '不存在'}`).join('；')}${verify.mismatches.length > 5 ? ` 等 ${verify.mismatches.length} 项` : ''}`)
				}
				// 0.10.26：spg_ 生成物（组边框 POLY + 组名 STRING）也回读核销——0.10.24 终验"组边框未见"
				// 分不清是没生成还是 listLines 枚举不到（POLY 是 Polyline 不是 Line），现在直接源码核销
				const writtenDoc = parseSourceLog(written)
				const writtenEffective = resolveRecords(writtenDoc)
				const generatedAlive = [...writtenEffective.values()].filter(r => String(r.header?.id ?? '').startsWith(GENERATED_PREFIX))
				const generated = {
					borders: generatedAlive.filter(r => r.header?.type === 'POLY').length,
					labels: generatedAlive.filter(r => r.header?.type === 'STRING').length,
					expectedBorders: groups.length,
					expectedLabels: groups.length,
				}
				await eda.pcb_Document.save()
				return {
					dryRun: false,
					board: { ...boardBox, source: boardSrc },
					origin: { x: originX, y: originBottomY },
					groups: groupSummaries,
					moved: expected.length,
					ungrouped,
					generated,
					overlapCheck: overlapReport,
					...(overlapPairs.length ? { warning: `⚠️ 布局自检：实跑落子存在 ${overlapPairs.length} 对 bbox 重叠（overlapCheck.pairs）——请 pcb.checkPlacement 复核，必要时 sourceRollback 回滚后调大 groupGap 重跑` } : {}),
					...(generated.borders < groups.length || generated.labels < groups.length
						? { generatedWarning: `⚠️ spg_ 生成物核销不符：组边框 ${generated.borders}/${groups.length}、组名文本 ${generated.labels}/${groups.length}——部分生成物未写入生效（pcb.listLines 枚举不到 POLY 类边框是正常的，以本核销为准）` }
						: {}),
					...(locked.length ? { locked, lockedNote: '这些器件已锁定，未搬动' } : {}),
					backupId: backup.backupId,
					backupLocation: backup.location,
					...(backup.file ? { backupFile: backup.file } : {}),
					...(backup.pruned?.length ? { backupNote: backup.pruned } : {}),
					verify: { ok: true, checked: expected.length, tolerance: 0.001 },
					saved: true,
				}
			}
			catch (err) {
				// 任何一步失败：整份恢复原始源码
				try {
					await eda.sys_FileManager.setDocumentSource(pcbSource)
				}
				catch (restoreErr) {
					throw new Error(`${err instanceof Error ? err.message : String(err)}；且恢复原始源码也失败（${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}）——请立即用 pcb.sourceRollback 恢复备份 ${backup.backupId}，或不保存关闭文档重开`)
				}
				throw new Error(`${err instanceof Error ? err.message : String(err)}。已自动恢复原始源码（未保存），可用 pcb.sourceRollback 查看/恢复备份 ${backup.backupId}`)
			}
		},
	},
	{
		name: 'pcb.sourceRollback',
		summary: '【0.10.22】PCB 源码备份的列出与恢复：list:true 列出当前 PCB 的全部备份（代理文件栈 + EDA 扩展存储单槽）；否则恢复——默认恢复当前 PCB 最近一份，或按 backupId 指定。恢复前校验备份 pcbUuid 与当前 PCB 匹配（不匹配拒绝），恢复后回读校验 uuid 并保存。备份由 pcb.groupBySchematicRegions 等源码写入指令产生',
		params: [
			{ name: 'list', type: 'boolean', description: '只列出备份不恢复（默认 false）' },
			{ name: 'backupId', type: 'string', description: '指定备份 ID（如 "工程名/2026-09-28T09-30-00-000Z"，或 storage: 开头的扩展存储备份）；留空恢复当前 PCB 最近一份' },
		],
		returns: 'list 模式 { backups, storageBackup }；恢复模式 { restored, backupId, pcbUuid, verify, saved }',
		example: { cmd: 'pcb.sourceRollback', params: { list: true } },
		handler: async (params) => {
			const currentSource = await eda.sys_FileManager.getDocumentSource()
			if (!currentSource)
				throw new Error('无法获取当前 PCB 源码（请先激活 PCB 文档）')
			const currentUuid = parseSourceLog(currentSource).uuid

			if (params.list) {
				const { proxy, storage, proxyError } = await listBackups(currentUuid)
				return {
					pcbUuid: currentUuid,
					backups: proxy,
					...(storage ? { storageBackup: storage } : {}),
					...(proxyError ? { proxyError, note: '代理不可达，仅列出 EDA 扩展存储备份' } : {}),
					hint: '恢复：pcb.sourceRollback 不带参数（最近一份）或带 backupId',
				}
			}

			const backup = await readBackup(params.backupId ? String(params.backupId) : undefined, currentUuid)
			if (backup.pcbUuid && backup.pcbUuid !== currentUuid)
				throw new Error(`备份属于另一块 PCB（备份 ${backup.pcbUuid}，当前 ${currentUuid}），已拒绝恢复。确认要跨板恢复请先激活对应 PCB 文档`)
			if (!backup.source)
				throw new Error('备份内容为空，已中止')
			const writeOk = await eda.sys_FileManager.setDocumentSource(backup.source)
			if (!writeOk)
				throw new Error('源码恢复写入失败（setDocumentSource 返回 false），当前文档未改动')
			const restored = await eda.sys_FileManager.getDocumentSource()
			if (!restored || parseSourceLog(restored).uuid !== currentUuid)
				throw new Error('恢复后回读校验失败（uuid 不匹配或回读为空）——请不保存关闭文档重开')
			await eda.pcb_Document.save()
			return {
				restored: true,
				backupId: backup.backupId,
				pcbUuid: currentUuid,
				...(backup.createdAt ? { backupCreatedAt: backup.createdAt } : {}),
				verify: { ok: true, uuidMatched: true },
				saved: true,
			}
		},
	},
]
