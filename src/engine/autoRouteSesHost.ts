import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'

export interface HostRouteLine {
	id: string
	net: string
	layer: number
	widthMil: number
	a: { x: number, y: number }
	b: { x: number, y: number }
	locked: boolean
}

export interface HostRouteVia {
	id: string
	net: string
	x: number
	y: number
	diameterMil: number
	holeDiameterMil?: number
	viaType: 0 | 1 | 2
	locked: boolean
	padstackName?: string
}

export interface HostRouteArc {
	id: string
	net: string
	layer: number
	widthMil: number
	start: { x: number, y: number }
	end: { x: number, y: number }
	angle: number
	locked: boolean
}

export interface HostSourceRecord {
	type: string
	id: string
	data: unknown
}

export interface HostRouteSnapshot {
	documentUuid: string
	lines: HostRouteLine[]
	vias: HostRouteVia[]
	arcs: HostRouteArc[]
	layers: Array<{ id: number, name: string, type: string, layerStatus?: unknown }>
	source: string
	sourceRecords: HostSourceRecord[]
}

function state<T>(item: any, method: string, id: string): T {
	const getter = item?.[method]
	if (typeof getter !== 'function')
		throw new Error(`PCB ${id} 读回缺少 ${method}`)
	return getter.call(item) as T
}

function finite(value: unknown, field: string, id: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`PCB ${id} 的 ${field} 读回不是有限数`)
	return value
}

function primitiveId(value: unknown, primitive: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`PCB ${primitive} 读回缺少有效 primitive ID`)
	return value
}

function netName(value: unknown, id: string): string {
	if (typeof value !== 'string')
		throw new Error(`PCB ${id} 读回网络名不可判定`)
	return value
}

function lockState(value: unknown, id: string): boolean {
	if (typeof value !== 'boolean')
		throw new Error(`PCB ${id} 读回锁定状态不可判定`)
	return value
}

function recordsFromSource(source: string): { documentUuid: string, records: HostSourceRecord[] } {
	const document = parseSourceLog(source)
	const resolved = resolveRecords(document)
	const records = Array.from(resolved.values())
		.filter(record => record.header.type !== 'DOCHEAD')
		.map((record) => {
			if (typeof record.header.id !== 'string' || !record.header.id.trim())
				throw new Error(`源码 ${record.header.type} 记录缺少有效字符串 ID`)
			return { type: record.header.type, id: record.header.id, data: record.data }
		})
	return { documentUuid: document.uuid, records }
}

/** Read the semantic SDK route objects and effective source records, checking focus after every awaited host read. */
export async function readRouteSnapshot(
	api: any,
	assertFocused: () => Promise<void>,
	sourceOverride?: string,
): Promise<HostRouteSnapshot> {
	const read = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
		await assertFocused()
		const value = await action()
		await assertFocused()
		if (value === undefined || value === null)
			throw new Error(`PCB ${label} 读回为空`)
		return value
	}

	const rawLines = await read('走线', () => api.pcb_PrimitiveLine.getAll())
	const rawVias = await read('过孔', () => api.pcb_PrimitiveVia.getAll())
	const rawArcs = await read('圆弧', () => api.pcb_PrimitiveArc.getAll())
	const rawLayers = await read('图层', () => api.pcb_Layer.getAllLayers())
	if (!Array.isArray(rawLines) || !Array.isArray(rawVias) || !Array.isArray(rawArcs) || !Array.isArray(rawLayers))
		throw new Error('PCB 路由或图层 API 未返回完整数组')
	const layers = rawLayers.map((layer: any) => {
		const id = finite(layer?.id, 'layer.id', '图层')
		if (typeof layer?.name !== 'string' || !layer.name.trim() || typeof layer?.type !== 'string' || !layer.type.trim())
			throw new Error(`PCB 图层 ${id} 读回缺少有效 name/type`)
		return { id, name: layer.name, type: layer.type, ...(Object.prototype.hasOwnProperty.call(layer, 'layerStatus') ? { layerStatus: layer.layerStatus } : {}) }
	})
	const layerById = new Map(layers.map(layer => [layer.id, layer]))

	const lines = rawLines.flatMap((item: any) => {
		const id = primitiveId(state(item, 'getState_PrimitiveId', '走线'), '走线')
		const layerId = finite(state(item, 'getState_Layer', id), 'layer', id)
		const layer = layerById.get(layerId)
		if (!layer)
			throw new Error(`PCB 走线 ${id} 的 layer=${layerId} 无法在图层表中判定`)
		if (layer.type.toUpperCase() !== 'SIGNAL')
			return []
		return [{
			id,
			net: netName(state(item, 'getState_Net', id), id),
			layer: layerId,
			widthMil: finite(state(item, 'getState_LineWidth', id), 'lineWidth', id),
			a: { x: finite(state(item, 'getState_StartX', id), 'startX', id), y: finite(state(item, 'getState_StartY', id), 'startY', id) },
			b: { x: finite(state(item, 'getState_EndX', id), 'endX', id), y: finite(state(item, 'getState_EndY', id), 'endY', id) },
			locked: lockState(state(item, 'getState_PrimitiveLock', id), id),
		}]
	})
	const vias = rawVias.map((item: any) => {
		const id = primitiveId(state(item, 'getState_PrimitiveId', '过孔'), '过孔')
		const viaType = finite(state(item, 'getState_ViaType', id), 'viaType', id)
		if (![0, 1, 2].includes(viaType))
			throw new Error(`PCB 过孔 ${id} 读回了不支持的 viaType=${viaType}`)
		const rawHoleDiameter = state<unknown>(item, 'getState_HoleDiameter', id)
		const holeDiameterMil = rawHoleDiameter == null ? undefined : finite(rawHoleDiameter, 'holeDiameter', id)
		return {
			id,
			net: netName(state(item, 'getState_Net', id), id),
			x: finite(state(item, 'getState_X', id), 'x', id),
			y: finite(state(item, 'getState_Y', id), 'y', id),
			diameterMil: finite(state(item, 'getState_Diameter', id), 'diameter', id),
			...(holeDiameterMil === undefined ? {} : { holeDiameterMil }),
			viaType: viaType as 0 | 1 | 2,
			locked: lockState(state(item, 'getState_PrimitiveLock', id), id),
		}
	})
	const arcs = rawArcs.flatMap((item: any) => {
		const id = primitiveId(state(item, 'getState_PrimitiveId', '圆弧'), '圆弧')
		const layerId = finite(state(item, 'getState_Layer', id), 'layer', id)
		const layer = layerById.get(layerId)
		if (!layer)
			throw new Error(`PCB 圆弧 ${id} 的 layer=${layerId} 无法在图层表中判定`)
		if (layer.type.toUpperCase() !== 'SIGNAL')
			return []
		return [{
			id,
			net: netName(state(item, 'getState_Net', id), id),
			layer: layerId,
			widthMil: finite(state(item, 'getState_LineWidth', id), 'lineWidth', id),
			start: { x: finite(state(item, 'getState_StartX', id), 'startX', id), y: finite(state(item, 'getState_StartY', id), 'startY', id) },
			end: { x: finite(state(item, 'getState_EndX', id), 'endX', id), y: finite(state(item, 'getState_EndY', id), 'endY', id) },
			angle: finite(state(item, 'getState_ArcAngle', id), 'arcAngle', id),
			locked: lockState(state(item, 'getState_PrimitiveLock', id), id),
		}]
	})
	const source = sourceOverride ?? await read('文档源码', () => api.sys_FileManager.getDocumentSource())
	if (typeof source !== 'string' || !source.trim())
		throw new Error('PCB 文档源码读回为空')
	const parsed = recordsFromSource(source)
	const focus = await read<any>('文档焦点', () => api.dmt_SelectControl.getCurrentDocumentInfo())
	if (focus?.documentType !== 3 || focus.uuid !== parsed.documentUuid)
		throw new Error(`PCB 源码 UUID 与当前焦点不一致（source=${parsed.documentUuid}, focus=${focus?.uuid ?? 'unknown'}）`)
	return { documentUuid: parsed.documentUuid, lines, vias, arcs, layers, source, sourceRecords: parsed.records }
}

function stable(value: any): string {
	if (Array.isArray(value))
		return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
	return JSON.stringify(value)
}

/** Compare effective source records, allowing only explicitly planned route deletions/additions. */
export function verifySourceChanges(
	before: HostRouteSnapshot,
	after: HostRouteSnapshot,
	allowedDeleted: Array<{ type: string, id: string }>,
	allowedAdded: Array<{ type: string, id: string }>,
): { verified: boolean, differences: Array<Record<string, unknown>> } {
	const key = (record: Pick<HostSourceRecord, 'type' | 'id'>) => `${record.type}\0${record.id}`
	const oldRecords = new Map(before.sourceRecords.map(record => [key(record), record]))
	const newRecords = new Map(after.sourceRecords.map(record => [key(record), record]))
	const deleted = new Set(allowedDeleted.map(key))
	const added = new Set(allowedAdded.map(key))
	const differences: Array<Record<string, unknown>> = []
	for (const identity of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
		const oldRecord = oldRecords.get(identity)
		const newRecord = newRecords.get(identity)
		if (!oldRecord && newRecord && added.has(identity))
			continue
		if (oldRecord && !newRecord && deleted.has(identity))
			continue
		if (!oldRecord || !newRecord || stable(oldRecord.data) !== stable(newRecord.data))
			differences.push({ identity, before: oldRecord?.data ?? null, after: newRecord?.data ?? null })
	}
	return { verified: differences.length === 0, differences }
}
