/**
 * EasyEDA 文档源码（行式 JSON 变更日志）append-only 基础设施
 *
 * 移植自官方扩展 eext-pcb-component-grouping 的 src/source/source-log.ts 模型，
 * 并补充 PCB / 原理图 / 封装的源码解析与回读比对辅助。
 *
 * ★ append-only 纪律（0.10.22 确立，违反会被客户端运行时判"数据格式不对"拒写）：
 * 1. 从不编辑/删除既有行：所有变更以新记录追加到文末；
 * 2. ticket 必须单调递增且从现有 max+1 起——同 (type,id) 旧记录靠 ticket 分新旧，
 *    ticket 小了会被旧记录压过；
 * 3. 修改图元 = 原 data 浅拷贝只覆盖要改的键，未知字段原样保留（客户端校验对缺字段敏感）；
 * 4. 移动器件坐标双字段同改：x/y/angle 与 positionX/positionY/rotation 在就一起改；
 * 5. 删除用墓碑（data: ''），不物理删行；
 * 6. 写入五步法：备份原文 → setDocumentSource → 立即回读重新解析逐值比对（容差 0.001）
 *    → 失败整份恢复 → 全过才 pcb_Document.save()。
 * 本模块是通用设施，原理图侧源码改写同样复用。
 */

// ---------- 日志格式核心（对应官方 source-log.ts） ----------

export interface ISourceHeader {
	type: string
	id?: string
	ticket?: number
	[key: string]: unknown
}

export interface ISourceRecord<T = unknown> {
	header: ISourceHeader
	data: T | ''
	raw: string
	line: number
}

export interface ISourceDocument {
	records: Array<ISourceRecord>
	docType: string
	uuid: string
	client: string
}

export interface IPendingRecord {
	header: ISourceHeader
	data: unknown | ''
}

/** 解析单行：`JSON(header) || JSON(data)`，行尾带 `|` 分隔符 */
export function parseSourceLine(line: string, lineNumber = 1): ISourceRecord | null {
	if (!line.trim())
		return null
	const separator = line.indexOf('||')
	if (separator < 0)
		throw new Error(`源码第 ${lineNumber} 行缺少 || 分隔符`)
	const header = JSON.parse(line.slice(0, separator)) as ISourceHeader
	let dataText = line.slice(separator + 2)
	if (dataText.endsWith('|'))
		dataText = dataText.slice(0, -1)
	const data = JSON.parse(dataText) as unknown
	return { header, data: data as any, raw: line, line: lineNumber }
}

/** 解析整份源码，强制校验 DOCHEAD */
export function parseSourceLog(source: string): ISourceDocument {
	const records = source.split(/\r?\n/).map((line, index) => parseSourceLine(line, index + 1)).filter((record): record is ISourceRecord => record !== null)
	const head = records.find(record => record.header.type === 'DOCHEAD')
	if (!head || typeof head.data !== 'object' || !head.data)
		throw new Error('源码缺少 DOCHEAD')
	const data = head.data as Record<string, unknown>
	if (typeof data.docType !== 'string' || typeof data.uuid !== 'string')
		throw new Error('DOCHEAD 缺少 docType/uuid')
	return { records, docType: data.docType, uuid: data.uuid, client: String(data.client ?? '') }
}

export function recordKey(record: ISourceRecord): string {
	return `${record.header.type}\u0000${String(record.header.id ?? '')}`
}

/** 日志重放：ticket 大的赢，空 data 墓碑删除 */
export function resolveRecords<T = any>(document: ISourceDocument, type?: string): Map<string, ISourceRecord<T>> {
	const resolved = new Map<string, ISourceRecord<T>>()
	for (const record of document.records) {
		if (record.header.type === 'DOCHEAD' || (type && record.header.type !== type) || record.header.id == null)
			continue
		const key = recordKey(record)
		const current = resolved.get(key)
		if (!current || Number(record.header.ticket ?? 0) >= Number(current.header.ticket ?? 0)) {
			if (record.data === '')
				resolved.delete(key)
			else
				resolved.set(key, record as ISourceRecord<T>)
		}
	}
	return resolved
}

export function getMaxTicket(document: ISourceDocument): number {
	return document.records.reduce((max, record) => Math.max(max, Number(record.header.ticket ?? 0)), 0)
}

/** 下一个可用 ticket（append-only：必须从现有 max+1 起递增） */
export function nextTicket(document: ISourceDocument): number {
	return getMaxTicket(document) + 1
}

/** 把新记录追加到源码文末（绝不改动既有行） */
export function appendRecords(source: string, records: Array<IPendingRecord>): string {
	if (records.length === 0)
		return source
	const body = source.trimEnd()
	const separator = body.endsWith('|') ? '' : '|'
	return `${body}${separator}\n${records.map(record => `${JSON.stringify(record.header)}||${JSON.stringify(record.data)}`).join('|\n')}`
}

export function effectiveRecordsByType(document: ISourceDocument, type: string): Array<ISourceRecord> {
	return Array.from(resolveRecords(document, type).values())
}

/** 对指定 id 前缀的全部现存图元生成墓碑记录（重复执行前先清场） */
export function tombstoneByPrefix(document: ISourceDocument, idPrefix: string, ticket: number): Array<IPendingRecord> {
	const pending: Array<IPendingRecord> = []
	for (const record of document.records) {
		if (record.header.id?.startsWith(idPrefix) && record.header.type !== 'DOCHEAD')
			pending.push({ header: { type: record.header.type, id: record.header.id, ticket: ++ticket }, data: '' })
	}
	return pending
}

// ---------- 通用取值辅助 ----------

function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() || fallback : fallback
}

function bool(value: unknown): boolean {
	return value === true || value === 1 || value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function dataOf(record: ISourceRecord): Record<string, unknown> {
	return record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {}
}

export interface IBBox {
	minX: number
	minY: number
	maxX: number
	maxY: number
}

// ---------- PCB 源码解析（对应官方 pcb-source.ts） ----------

export interface ISourcePcbComponent {
	id: string
	designator: string
	footprintUuid: string
	deviceUuid: string
	x: number
	y: number
	angle: number
	layerId: number
	locked: boolean
	data: Record<string, unknown>
	header: ISourceHeader
}

export interface IParsedPcbDocument {
	uuid: string
	components: Array<ISourcePcbComponent>
	records: Array<ISourceRecord>
}

function attrLookup(attrs: Record<string, unknown>, key: string): string {
	const wanted = key.toLowerCase()
	const actual = Object.keys(attrs).find(name => name.toLowerCase() === wanted)
	return actual ? str(attrs[actual]) : ''
}

export function extractPcbDocument(source: string): IParsedPcbDocument {
	const document = parseSourceLog(source)
	const attrs = new Map<string, Record<string, string>>()
	for (const record of effectiveRecordsByType(document, 'ATTR')) {
		const data = dataOf(record)
		const parentId = str(data.parentId)
		const key = str(data.key)
		if (!parentId || !key)
			continue
		if (!attrs.has(parentId))
			attrs.set(parentId, {})
		attrs.get(parentId)![key.toLowerCase()] = str(data.value)
	}
	const components = effectiveRecordsByType(document, 'COMPONENT').map((record) => {
		const data = dataOf(record)
		const id = String(record.header.id)
		const componentAttrs = attrs.get(id) ?? {}
		const embeddedAttrs = data.attrs && typeof data.attrs === 'object' && !Array.isArray(data.attrs) ? data.attrs as Record<string, unknown> : {}
		return {
			id,
			designator: componentAttrs.designator || attrLookup(embeddedAttrs, 'Designator') || str(data.designator),
			footprintUuid: componentAttrs.footprint || attrLookup(embeddedAttrs, 'Footprint') || str(data.footprintUuid),
			deviceUuid: componentAttrs.device || attrLookup(embeddedAttrs, 'Device') || str(data.deviceUuid),
			x: num(data.positionX ?? data.x),
			y: num(data.positionY ?? data.y),
			angle: num(data.rotation ?? data.angle),
			layerId: num(data.layerId),
			locked: bool(data.locked ?? data.primitiveLock ?? data.isLocked),
			data,
			header: record.header,
		}
	})
	return { uuid: document.uuid, components, records: document.records }
}

/** 移动器件：浅拷贝原 data 保留全部未知字段，坐标双字段（x/y/angle 与 positionX/positionY/rotation）同改 */
export function moveComponentData(component: ISourcePcbComponent, x: number, y: number, angle: number): Record<string, unknown> {
	const data = { ...component.data }
	if ('x' in data)
		data.x = x
	if ('y' in data)
		data.y = y
	if ('angle' in data)
		data.angle = angle
	if ('positionX' in data)
		data.positionX = x
	if ('positionY' in data)
		data.positionY = y
	if ('rotation' in data)
		data.rotation = angle
	return data
}

/** 回读比对：重新解析 written 源码，逐器件比对坐标/角度（容差 0.001），返回不符清单 */
export function verifyMovedComponents(
	writtenSource: string,
	expected: Array<{ id: string, designator: string, x: number, y: number, angle: number }>,
	tolerance = 0.001,
): { ok: boolean, mismatches: Array<{ designator: string, id: string, expected: { x: number, y: number, angle: number }, actual: { x: number, y: number, angle: number } | null }> } {
	const verified = extractPcbDocument(writtenSource)
	const mismatches: Array<{ designator: string, id: string, expected: { x: number, y: number, angle: number }, actual: { x: number, y: number, angle: number } | null }> = []
	for (const want of expected) {
		const actual = verified.components.find(component => component.id === want.id)
		if (!actual || Math.abs(actual.x - want.x) > tolerance || Math.abs(actual.y - want.y) > tolerance || Math.abs(actual.angle - want.angle) > tolerance) {
			mismatches.push({
				designator: want.designator,
				id: want.id,
				expected: { x: want.x, y: want.y, angle: want.angle },
				actual: actual ? { x: actual.x, y: actual.y, angle: actual.angle } : null,
			})
		}
	}
	return { ok: mismatches.length === 0, mismatches }
}

// ---------- 原理图区框源码解析（RECT + COMPONENT + ATTR + TEXT） ----------

export interface ISourceSchComponent {
	id: string
	designator: string
	name: string
	x: number
	y: number
	/** 位号文本锚点（归属判定优先取它，用户画框往往框住位号而非器件中心） */
	designatorX: number | null
	designatorY: number | null
}

export interface ISourceRect {
	id: string
	label: string
	bbox: IBBox
}

export interface IParsedSchPage {
	uuid: string
	rects: Array<ISourceRect>
	components: Array<ISourceSchComponent>
}

export function extractSchematicRects(source: string): IParsedSchPage {
	const document = parseSourceLog(source)
	const attrRecords = effectiveRecordsByType(document, 'ATTR')
	const attrsByParent = new Map<string, Record<string, string>>()
	for (const record of attrRecords) {
		const data = dataOf(record)
		const parentId = str(data.parentId)
		const key = str(data.key)
		if (!parentId || !key)
			continue
		if (!attrsByParent.has(parentId))
			attrsByParent.set(parentId, {})
		attrsByParent.get(parentId)![key] = str(data.value)
	}
	const rects = effectiveRecordsByType(document, 'RECT').map((record, index) => {
		const data = dataOf(record)
		const x1 = num(data.dotX1)
		const y1 = num(data.dotY1)
		const x2 = num(data.dotX2)
		const y2 = num(data.dotY2)
		return {
			id: String(record.header.id),
			label: attrsByParent.get(String(record.header.id))?.Name ?? `矩形 ${index + 1}`,
			bbox: { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) },
		}
	})
	const components = effectiveRecordsByType(document, 'COMPONENT').map((record) => {
		const data = dataOf(record)
		const id = String(record.header.id)
		const attrs = attrsByParent.get(id) ?? {}
		const designatorRecord = attrRecords.find((attr) => {
			const attrData = dataOf(attr)
			return attrData.parentId === id && attrData.key === 'Designator'
		})
		const designatorData = designatorRecord ? dataOf(designatorRecord) : {}
		return {
			id,
			designator: attrs.Designator ?? '',
			name: attrs.Device ?? attrs.Name ?? '',
			x: num(data.x ?? data.positionX),
			y: num(data.y ?? data.positionY),
			designatorX: typeof designatorData.x === 'number' ? designatorData.x : null,
			designatorY: typeof designatorData.y === 'number' ? designatorData.y : null,
		}
	})
	return { uuid: document.uuid, rects, components }
}

export function bboxContains(bbox: IBBox, x: number, y: number): boolean {
	return x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY
}

/** 从任意图元 data 收集坐标点（板框轮廓 BBox 等通用测量用） */
export function collectRecordPoints(data: Record<string, unknown>): Array<[number, number]> {
	const points: Array<[number, number]> = []
	collectPrimitiveGeometry(points, data)
	return points
}

export function bboxArea(bbox: IBBox): number {
	return (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)
}

/** 归属判定：位号文本位置优先、其次器件本体；命中多框取面积最小（嵌套归内层） */
export function findOwningRect(rects: Array<ISourceRect>, component: ISourceSchComponent): ISourceRect | undefined {
	const anchorX = component.designatorX ?? component.x
	const anchorY = component.designatorY ?? component.y
	const hits = rects
		.filter(rect => bboxContains(rect.bbox, anchorX, anchorY) || bboxContains(rect.bbox, component.x, component.y))
	.sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox))
	return hits[0]
}

// ---------- 封装源码 BBox 测量（对应官方 footprint-source.ts） ----------

function addPoint(points: Array<[number, number]>, x: unknown, y: unknown): void {
	const nx = typeof x === 'number' && Number.isFinite(x) ? x : null
	const ny = typeof y === 'number' && Number.isFinite(y) ? y : null
	if (nx !== null && ny !== null)
		points.push([nx, ny])
}

function collectNestedNumericPairs(points: Array<[number, number]>, value: unknown): void {
	if (!Array.isArray(value))
		return
	for (let index = 0; index + 1 < value.length; index += 1) {
		if (typeof value[index] === 'number' && typeof value[index + 1] === 'number')
			addPoint(points, value[index], value[index + 1])
		else
			collectNestedNumericPairs(points, value[index])
	}
}

function collectPrimitiveGeometry(points: Array<[number, number]>, data: Record<string, unknown>): void {
	addPoint(points, data.x, data.y)
	addPoint(points, data.positionX, data.positionY)
	addPoint(points, data.startX, data.startY)
	addPoint(points, data.endX, data.endY)
	addPoint(points, data.centerX, data.centerY)
	addPoint(points, data.cx, data.cy)
	if (Array.isArray(data.path)) {
		const path = data.path
		for (let index = 0; index + 1 < path.length; index += 1) {
			if (typeof path[index] === 'number' && typeof path[index + 1] === 'number')
				addPoint(points, path[index], path[index + 1])
		}
	}
	const x = typeof data.centerX === 'number' ? data.centerX : typeof data.x === 'number' ? data.x : typeof data.positionX === 'number' ? data.positionX : null
	const y = typeof data.centerY === 'number' ? data.centerY : typeof data.y === 'number' ? data.y : typeof data.positionY === 'number' ? data.positionY : null
	if (x !== null && y !== null) {
		const width = typeof data.width === 'number' ? data.width : typeof data.diameter === 'number' ? data.diameter : typeof data.radius === 'number' ? data.radius : null
		const height = typeof data.height === 'number' ? data.height : typeof data.diameter === 'number' ? data.diameter : typeof data.radius === 'number' ? data.radius : null
		if (width !== null || height !== null)
			points.push([x - (width ?? 0) / 2, y - (height ?? width ?? 0) / 2], [x + (width ?? 0) / 2, y + (height ?? width ?? 0) / 2])
	}
	collectNestedNumericPairs(points, data.defaultPad)
}

function collectArrayGeometry(points: Array<[number, number]>, value: Array<unknown>): void {
	for (const item of value) {
		if (item && typeof item === 'object' && !Array.isArray(item))
			collectPrimitiveGeometry(points, item as Record<string, unknown>)
		else if (Array.isArray(item))
			collectArrayGeometry(points, item)
	}
	const numeric = value.filter(item => typeof item === 'number' && Number.isFinite(item)) as Array<number>
	for (let index = 0; index + 1 < numeric.length; index += 2)
		addPoint(points, numeric[index], numeric[index + 1])
}

/** 封装源码 → 轮廓 BBox：收集所有记录的坐标点求包围盒 */
export function extractFootprintGeometry(documentSource: string): IBBox | null {
	const document = parseSourceLog(documentSource)
	const points: Array<[number, number]> = []
	for (const record of document.records) {
		// 0.10.30：黑名单扩到全部非几何元数据记录（官方只跳 DOCHEAD/ATTR）——0.10.29 装机实锤
		// D1（SMA 二极管）提取出 ~2048mil 虚高，污染源就是 D3_ATTRIBUTE/RULE 等记录里的数值被当成坐标对
		if (['DOCHEAD', 'ATTR', 'CANVAS', 'LAYER', 'LAYER_PHYS', 'RULE', 'RULE_SELECTOR', 'RULE_TEMPLATE', 'NET', 'PAD_NET', 'SILK_OPTS', 'ACTIVE_LAYER', 'D3_ATTRIBUTE'].includes(record.header.type))
			continue
		if (!record.data || typeof record.data !== 'object')
			continue
		if (Array.isArray(record.data))
			collectArrayGeometry(points, record.data)
		else
			collectPrimitiveGeometry(points, record.data as Record<string, unknown>)
	}
	if (points.length === 0)
		return null
	const bbox = {
		minX: Math.min(...points.map(point => point[0])),
		minY: Math.min(...points.map(point => point[1])),
		maxX: Math.max(...points.map(point => point[0])),
		maxY: Math.max(...points.map(point => point[1])),
	}
	// 0.10.30 合理性护栏：单边 >2000mil 或 <5mil 的提取结果不可信（污染或空壳），返回 null 让测量链落到下一级实量
	const w = bbox.maxX - bbox.minX
	const h = bbox.maxY - bbox.minY
	if (w > 2000 || h > 2000 || w < 5 || h < 5)
		return null
	return bbox
}

/** 封装局部 BBox 按器件 x/y/angle/是否底层镜像变换到板级坐标 */
export function transformFootprintBBox(geometry: IBBox, x: number, y: number, angle: number, mirror: boolean): IBBox {
	const radians = angle * Math.PI / 180
	const corners = [[geometry.minX, geometry.minY], [geometry.minX, geometry.maxY], [geometry.maxX, geometry.minY], [geometry.maxX, geometry.maxY]]
	const transformed = corners.map(([px, py]) => {
		const mx = mirror ? -px : px
		return [x + mx * Math.cos(radians) - py * Math.sin(radians), y + mx * Math.sin(radians) + py * Math.cos(radians)]
	})
	return {
		minX: Math.min(...transformed.map(point => point[0])),
		minY: Math.min(...transformed.map(point => point[1])),
		maxX: Math.max(...transformed.map(point => point[0])),
		maxY: Math.max(...transformed.map(point => point[1])),
	}
}

/** 通用兜底尺寸（不含项目特定特征）：按位号前缀/封装名粗估；0.10.30 连接器类从 800×800 瘦到 400×400（装机实测 J3 连接器真实 94×294，800 虚高 2~7 倍致出口闸误杀） */
export function fallbackBBox(component: ISourcePcbComponent): IBBox {
	const name = component.footprintUuid.toLowerCase()
	let width = 150
	let height = 100
	if (/^u/i.test(component.designator))
		[width, height] = [500, 400]
	else if (/conn|usb|hdmi|rj-|module/.test(name))
		[width, height] = [400, 400]
	else if (/^[rcld]/i.test(component.designator) || /0402|0603|0805/.test(name))
		[width, height] = [125, 70]
	return { minX: component.x - width / 2, minY: component.y - height / 2, maxX: component.x + width / 2, maxY: component.y + height / 2 }
}
