import { curveFromEndpoints } from './arcTuneGeometry'
import { parseSourceLog, resolveRecords, type ISourceRecord } from './sourcelog'

export interface RouteBaselineWire {
	arcId: string
	dsnWireIndex: number
	net: string
	layerName: string
	widthMil: number
	points: Array<{ xMil: number, yMil: number }>
}

export interface SesRouteBaseline {
	format: 'ai-command-engine-route-baseline/v1'
	version: 1
	documentUuid: string
	status: 'complete' | 'incomplete'
	arcs: Array<{ id: string, header: unknown, data: unknown }>
	protectedWires: RouteBaselineWire[]
	issues: string[]
}

export interface SesBaselineCurrentRecord { type: string, id: string, data: unknown, header?: unknown }

export interface SesArcWire {
	net: string
	layerName: string
	widthMil: number
	points: Array<{ xMil: number, yMil: number }>
	type?: string
	wireIndex?: number
	pathIndex?: number
}

type DsnNode = string | DsnNode[]
type DsnWire = { index: number, net: string, layerName: string, widthMil: number, points: Array<{ xMil: number, yMil: number }>, type?: string }

function lex(source: string): string[] {
	const tokens: string[] = []
	for (let i = 0; i < source.length;) {
		const char = source[i]
		if (/\s/.test(char)) { i++; continue }
		if (char === ';' || (char === '#' && (i === 0 || /\s/.test(source[i - 1])))) {
			while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++
			continue
		}
		if (char === '(' || char === ')') { tokens.push(char); i++; continue }
		const quoteDeclaration = char === '"' && /\(\s*string_quote\s*$/.test(source.slice(Math.max(0, i - 32), i))
		if ((char === '"' || char === "'") && !quoteDeclaration) {
			const quote = char
			let value = ''
			let closed = false
			i++
			while (i < source.length) {
				const next = source[i++]
				if (next === quote) { closed = true; break }
				if (next === '\\' && i < source.length) value += source[i++]
				else value += next
			}
			if (!closed) throw new Error('DSN string 未闭合')
			tokens.push(value)
			continue
		}
		const start = i
		while (i < source.length && !/[\s()]/.test(source[i])) i++
		tokens.push(source.slice(start, i))
	}
	return tokens
}

function dsnTree(source: string): DsnNode[] {
	const roots: DsnNode[] = []
	const stack: DsnNode[][] = []
	for (const token of lex(source)) {
		if (token === '(') {
			const node: DsnNode[] = []
			if (stack.length) stack.at(-1)!.push(node)
			else roots.push(node)
			stack.push(node)
		}
		else if (token === ')') {
			if (!stack.pop()) throw new Error('DSN 有未配对右括号')
		}
		else if (stack.length) stack.at(-1)!.push(token)
		else roots.push(token)
	}
	if (stack.length) throw new Error('DSN 有未闭合列表')
	return roots
}

function children(node: DsnNode, name: string): DsnNode[][] {
	if (!Array.isArray(node)) return []
	return node.slice(1).filter((item): item is DsnNode[] => Array.isArray(item) && item[0] === name)
}

function allNodes(node: DsnNode, name: string): DsnNode[][] {
	if (!Array.isArray(node)) return []
	const output: DsnNode[][] = []
	if (node[0] === name) output.push(node)
	for (const item of node.slice(1)) output.push(...allNodes(item, name))
	return output
}

function parseDsnProtectedWires(source: string): DsnWire[] {
	const roots = dsnTree(source)
	const pcbRoots = roots.filter((node): node is DsnNode[] => Array.isArray(node) && node[0] === 'PCB')
	if (pcbRoots.length !== 1) throw new Error(`DSN 必须恰有一个 PCB 根节点（实际 ${pcbRoots.length}）`)
	const wiring = allNodes(pcbRoots[0], 'wiring')
	if (wiring.length !== 1) throw new Error(`DSN 必须恰有一个 wiring 节点（实际 ${wiring.length}）`)
	const wires: DsnWire[] = []
	for (const wireNode of allNodes(wiring[0], 'wire')) {
		const nets = children(wireNode, 'net')
		const paths = children(wireNode, 'path')
		const types = children(wireNode, 'type')
		if (nets.length !== 1 || nets[0].length !== 2 || typeof nets[0][1] !== 'string' || !nets[0][1])
			throw new Error('DSN protect wire 必须有唯一有效的 net 元数据')
		const net = nets[0][1]
		if (types.length > 1 || types.some(type => type.length !== 2 || typeof type[1] !== 'string'))
			throw new Error('DSN wire type 元数据重复或无效')
		const type = types[0]?.[1] as string | undefined
		for (const path of paths) {
			if (path.length < 7 || (path.length - 3) % 2 !== 0 || typeof path[1] !== 'string')
				throw new Error('DSN wire path 字段无效')
			const widthMil = Number(path[2])
			const coordinates = path.slice(3).map(Number)
			if (!Number.isFinite(widthMil) || widthMil <= 0 || coordinates.some(value => !Number.isFinite(value)))
				throw new Error('DSN wire path 含无效宽度或坐标')
			const points = []
			for (let index = 0; index < coordinates.length; index += 2)
				points.push({ xMil: coordinates[index], yMil: coordinates[index + 1] })
			wires.push({ index: wires.length, net, layerName: path[1], widthMil, points, ...(type ? { type } : {}) })
		}
	}
	return wires
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
	return JSON.stringify(value) ?? 'undefined'
}

function normalizeArcIdentity(record: { id: string, header: unknown, data: unknown }): { id: string, header: Record<string, unknown>, data: unknown } | undefined {
	if (typeof record.id !== 'string' || !record.id.trim() || !record.header || typeof record.header !== 'object' || Array.isArray(record.header))
		return undefined
	const header = record.header as Record<string, unknown>
	if (header.type !== 'ARC' || header.id !== record.id)
		return undefined
	const { ticket: _ticket, ...stableHeader } = header
	return { id: record.id, header: stableHeader, data: record.data }
}

function sameArcIdentity(a: { id: string, header: unknown, data: unknown }, b: { id: string, header: unknown, data: unknown }): boolean {
	const normalizedA = normalizeArcIdentity(a)
	const normalizedB = normalizeArcIdentity(b)
	return normalizedA !== undefined && normalizedB !== undefined && stable(normalizedA) === stable(normalizedB)
}

function finiteRecord(record: ISourceRecord): record is ISourceRecord<Record<string, any>> {
	const data = record.data as any
	return record.header.type === 'ARC' && typeof record.header.id === 'string' && record.header.id.length > 0
		&& data && data.arcType === 'DOT' && typeof data.netName === 'string' && Number.isInteger(data.layerId)
		&& [data.width, data.startX, data.startY, data.endX, data.endY, data.angle].every((value: unknown) => typeof value === 'number' && Number.isFinite(value))
		&& data.width > 0 && (data.startX !== data.endX || data.startY !== data.endY) && data.angle !== 0 && Math.abs(data.angle) < 360
}

function layerName(layerType: unknown): string | undefined {
	if (layerType === 'TOP') return 'TopLayer'
	if (layerType === 'BOTTOM') return 'BottomLayer'
	if (typeof layerType === 'string' && /^INNER_?\d+$/i.test(layerType)) return `Inner${layerType.match(/\d+/)![0]}`
	return undefined
}

function near(a: number, b: number, tolerance: number): boolean {
	return Math.abs(a - b) <= tolerance
}

function followsArc(wire: DsnWire | SesArcWire, arc: Record<string, any>, expectedLayerName: string, endpointTolerance: number): boolean {
	if (wire.type !== 'protect' || wire.net !== arc.netName || wire.layerName !== expectedLayerName || wire.widthMil !== arc.width || wire.points.length < 3)
		return false
	let curve
	try { curve = curveFromEndpoints([arc.startX, arc.startY], [arc.endX, arc.endY], arc.angle) }
	catch { return false }
	const starts = near(wire.points[0].xMil, curve.a[0], endpointTolerance) && near(wire.points[0].yMil, curve.a[1], endpointTolerance)
		&& near(wire.points.at(-1)!.xMil, curve.b[0], endpointTolerance) && near(wire.points.at(-1)!.yMil, curve.b[1], endpointTolerance)
	const reversed = near(wire.points[0].xMil, curve.b[0], endpointTolerance) && near(wire.points[0].yMil, curve.b[1], endpointTolerance)
		&& near(wire.points.at(-1)!.xMil, curve.a[0], endpointTolerance) && near(wire.points.at(-1)!.yMil, curve.a[1], endpointTolerance)
	if (!starts && !reversed) return false
	const quantizationTolerance = Math.SQRT2 * endpointTolerance + 1e-9
	const angularTolerance = endpointTolerance / curve.radius * 180 / Math.PI + 1e-9
	const orderedPoints = reversed ? [...wire.points].reverse() : wire.points
	let previousProgress = 0
	for (const point of orderedPoints) {
		if (Math.abs(Math.hypot(point.xMil - curve.center[0], point.yMil - curve.center[1]) - curve.radius) > quantizationTolerance)
			return false
		let progress = (Math.atan2(point.yMil - curve.center[1], point.xMil - curve.center[0]) - Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0])) * 180 / Math.PI
		if (curve.sweepDegrees > 0) while (progress < -1e-8) progress += 360
		else while (progress > 1e-8) progress -= 360
		if (curve.sweepDegrees > 0 ? progress < -angularTolerance || progress > curve.sweepDegrees + angularTolerance : progress > angularTolerance || progress < curve.sweepDegrees - angularTolerance)
			return false
		if (curve.sweepDegrees > 0 ? progress < previousProgress - angularTolerance : progress > previousProgress + angularTolerance) return false
		previousProgress = progress
	}
	return true
}

/** Capture exact source ARC records and their complete, actual DSN protect wires. */
export function buildSesRouteBaseline(documentUuid: string, source: string, dsnText: string): SesRouteBaseline {
	const issues: string[] = []
	const document = parseSourceLog(source)
	if (document.docType !== 'PCB' || document.uuid !== documentUuid) issues.push('PCB源码DOCHEAD与当前文档UUID不一致')
	const records = [...resolveRecords(document).values()]
	const layerNames = new Map<number, string>()
	for (const record of records.filter(item => item.header.type === 'LAYER')) {
		const data = record.data as any
		if (Number.isInteger(data?.layerId)) {
			const name = layerName(data.layerType)
			if (name) layerNames.set(data.layerId, name)
		}
	}
	const routingTypes = new Set(['ARC', 'LINE', 'TRACK', 'VIA'])
	const arcRecords = records.filter(finiteRecord).filter(record => layerNames.has((record.data as any).layerId)).map(record => ({ id: record.header.id!, header: record.header, data: record.data }))
	for (const arc of arcRecords) {
		const sameIdRecords = records.filter(record => record.header.id === arc.id && routingTypes.has(record.header.type))
		if (sameIdRecords.length !== 1) issues.push(`ARC ${arc.id} 在有效路由源码中存在重复ID`)
	}
	let dsnWires: DsnWire[] = []
	try { dsnWires = parseDsnProtectedWires(dsnText) }
	catch (error) { issues.push(`实际DSN保护wire解析失败：${error instanceof Error ? error.message : String(error)}`) }
	const protectedWires: RouteBaselineWire[] = []
	const claimed = new Set<number>()
	for (const arc of arcRecords) {
		const data = arc.data as Record<string, any>
		const expectedLayerName = layerNames.get(data.layerId)
		if (!expectedLayerName) {
			issues.push(`ARC ${arc.id} 无法从有效源码层记录映射到DSN层`)
			continue
		}
		const matches = dsnWires.filter(wire => followsArc(wire, data, expectedLayerName, 0.005000001))
		if (matches.length !== 1 || claimed.has(matches[0]?.index ?? -1)) {
			issues.push(`ARC ${arc.id} 对应实际DSN保护wire数量为 ${matches.length}，或与另一ARC重复关联`)
			continue
		}
		const wire = matches[0]
		claimed.add(wire.index)
		protectedWires.push({ arcId: arc.id, dsnWireIndex: wire.index, net: wire.net, layerName: wire.layerName, widthMil: wire.widthMil, points: wire.points })
	}
	return { format: 'ai-command-engine-route-baseline/v1', version: 1, documentUuid, status: issues.length ? 'incomplete' : 'complete', arcs: arcRecords, protectedWires, issues }
}

function exactPoints(a: Array<{ xMil: number, yMil: number }>, b: Array<{ xMil: number, yMil: number }>): boolean {
	if (a.length !== b.length) return false
	const direct = a.every((point, index) => point.xMil === b[index].xMil && point.yMil === b[index].yMil)
	return direct || a.every((point, index) => point.xMil === b[a.length - 1 - index].xMil && point.yMil === b[a.length - 1 - index].yMil)
}

function exactPointDirection(a: Array<{ xMil: number, yMil: number }>, b: Array<{ xMil: number, yMil: number }>): 'same' | 'reverse' | undefined {
	if (a.length !== b.length) return undefined
	if (a.every((point, index) => point.xMil === b[index].xMil && point.yMil === b[index].yMil)) return 'same'
	if (a.every((point, index) => point.xMil === b[a.length - 1 - index].xMil && point.yMil === b[a.length - 1 - index].yMil)) return 'reverse'
	return undefined
}

function sameEndpoints(a: Array<{ xMil: number, yMil: number }>, b: Array<{ xMil: number, yMil: number }>): boolean {
	if (a.length < 2 || b.length < 2) return false
	const same = (x: { xMil: number, yMil: number }, y: { xMil: number, yMil: number }) => x.xMil === y.xMil && x.yMil === y.yMil
	return same(a[0], b[0]) && same(a.at(-1)!, b.at(-1)!) || same(a[0], b.at(-1)!) && same(a.at(-1)!, b[0])
}

function sameWireAttributes(wire: SesArcWire, baseline: RouteBaselineWire): boolean {
	return wire.type === 'protect' && wire.net === baseline.net && wire.layerName === baseline.layerName && wire.widthMil === baseline.widthMil
}

function contiguousSubpath(candidate: SesArcWire, baseline: RouteBaselineWire): boolean {
	if (candidate.points.length < 2 || candidate.points.length >= baseline.points.length) return false
	const eq = (a: { xMil: number, yMil: number }, b: { xMil: number, yMil: number }) => a.xMil === b.xMil && a.yMil === b.yMil
	for (const path of [baseline.points, [...baseline.points].reverse()]) {
		for (let start = 0; start + candidate.points.length <= path.length; start++)
			if (candidate.points.every((point, index) => eq(point, path[start + index]))) return true
	}
	return false
}

export interface SesArcCoverageResult {
	remainingWires: SesArcWire[]
	existingArcCoverage: Array<{ status: 'verified', arcId: string, dsnWireIndex: number, sesWireIndex: number, segmentCount: number, direction: 'same' | 'reverse' }>
	consumedWireIndices: number[]
}

/** Re-export the native DSN and require the caller's baseline to match its actual complete ARC wires. */
export function assertSesRouteBaselineMatchesDsn(routeBaseline: SesRouteBaseline, documentUuid: string, source: string, dsnText: string): void {
	if (routeBaseline.documentUuid !== documentUuid)
		throw new Error('routeBaseline documentUuid 与当前PCB不匹配')
	const current = buildSesRouteBaseline(documentUuid, source, dsnText)
	if (current.status !== 'complete')
		throw new Error(`当前PCB原生DSN无法完整关联ARC保护wire：${current.issues.join('；')}`)
	const withoutWireIndices = (wires: RouteBaselineWire[]) => wires.map(({ dsnWireIndex: _dsnWireIndex, ...wire }) => wire)
	if (routeBaseline.status !== 'complete' || current.arcs.length !== routeBaseline.arcs.length
		|| current.arcs.some((arc, index) => !sameArcIdentity(arc, routeBaseline.arcs[index]))
		|| stable(withoutWireIndices(current.protectedWires)) !== stable(withoutWireIndices(routeBaseline.protectedWires)))
		throw new Error('routeBaseline与当前PCB重新导出的native DSN完整ARC保护wire不匹配')
}

/** Resolve only complete exact protect wires proven by the export baseline before route flattening. */
export function resolveSesArcCoverage(wires: SesArcWire[], routeBaseline: SesRouteBaseline | undefined, documentUuid: string, currentArcs: Array<{ id: string, header?: unknown, data: unknown }>, layerNames: Map<number, string>, currentSourceRecords: SesBaselineCurrentRecord[] = currentArcs.map(arc => ({ type: 'ARC', id: arc.id, data: arc.data, ...(arc.header === undefined ? {} : { header: arc.header }) }))): SesArcCoverageResult {
	if (!routeBaseline) {
		for (const arc of currentArcs) {
			const data = arc.data as Record<string, any>
			const name = layerNames.get(data?.layerId)
			if (name && wires.some(wire => followsArc(wire, data, name, 0.005000001)))
				throw new Error(`SES 包含疑似既有ARC ${arc.id} 的protect保护链，但未提供导出DSN routeBaseline；已在写入前拒绝`)
		}
		return { remainingWires: wires, existingArcCoverage: [], consumedWireIndices: [] }
	}
	if (routeBaseline.format !== 'ai-command-engine-route-baseline/v1' || routeBaseline.version !== 1 || routeBaseline.documentUuid !== documentUuid)
		throw new Error('routeBaseline 格式、版本或documentUuid与当前PCB不匹配')
	if (routeBaseline.status !== 'complete')
		throw new Error(`routeBaseline不完整，无法安全消解ARC保护wire：${routeBaseline.issues.join('；')}`)
	const current = new Map(currentArcs.map(arc => [arc.id, { ...(arc.header === undefined ? {} : { header: arc.header }), data: arc.data }]))
	const routeTypes = new Set(['ARC', 'LINE', 'TRACK', 'VIA'])
	const baselineArcIds = new Set<string>()
	const baselineDsnWireIndices = new Set<number>()
	if (routeBaseline.arcs.length !== routeBaseline.protectedWires.length)
		throw new Error('routeBaseline中的ARC记录与保护wire未形成完整一对一关联')
	for (const arc of routeBaseline.arcs) {
		if (!arc.id || baselineArcIds.has(arc.id))
			throw new Error(`routeBaseline中的ARC ID缺失或重复：${arc.id}`)
		baselineArcIds.add(arc.id)
		const currentArc = current.get(arc.id)
		if (!currentArc || !sameArcIdentity({ id: arc.id, header: currentArc.header, data: currentArc.data }, arc))
			throw new Error(`routeBaseline中的ARC ${arc.id}源码记录已变化或缺失，拒绝去重`)
		if (currentSourceRecords.filter(record => record.id === arc.id && routeTypes.has(record.type)).length !== 1)
			throw new Error(`routeBaseline中的ARC ${arc.id} 在当前有效路由源码中存在重复ID，拒绝去重`)
	}
	for (const wire of routeBaseline.protectedWires) {
		const arc = routeBaseline.arcs.find(item => item.id === wire.arcId)
		const data = arc?.data as Record<string, any> | undefined
		const expectedLayerName = data && layerNames.get(data.layerId)
		if (!arc || !Number.isInteger(wire.dsnWireIndex) || wire.dsnWireIndex < 0 || baselineDsnWireIndices.has(wire.dsnWireIndex)
			|| typeof wire.net !== 'string' || typeof wire.layerName !== 'string' || typeof wire.widthMil !== 'number' || !Number.isFinite(wire.widthMil) || wire.widthMil <= 0
			|| !Array.isArray(wire.points) || wire.points.length < 3 || wire.points.some(point => !point || !Number.isFinite(point.xMil) || !Number.isFinite(point.yMil))
			|| !expectedLayerName || wire.layerName !== expectedLayerName
			|| !followsArc({ ...wire, type: 'protect' }, data ?? {}, expectedLayerName ?? '', 0.005000001))
			throw new Error(`routeBaseline中的ARC ${wire.arcId} 保护wire缺失、重复或与有效ARC几何不符`)
		baselineDsnWireIndices.add(wire.dsnWireIndex)
	}
	for (const arcId of baselineArcIds) {
		if (routeBaseline.protectedWires.filter(wire => wire.arcId === arcId).length !== 1)
			throw new Error(`routeBaseline中的ARC ${arcId} 必须且只能关联一条保护wire`)
	}
	if (routeBaseline.protectedWires.some(wire => !baselineArcIds.has(wire.arcId)))
		throw new Error('routeBaseline保护wire引用了基线ARC集合之外的ID')
	const consumed = new Set<number>()
	const existingArcCoverage: SesArcCoverageResult['existingArcCoverage'] = []
	for (const baseline of routeBaseline.protectedWires) {
		const exact = wires.filter(wire => sameWireAttributes(wire, baseline) && exactPoints(wire.points, baseline.points))
		if (exact.length !== 1)
			throw new Error(`ARC ${baseline.arcId} 的SES保护wire必须完整且唯一匹配routeBaseline（实际 ${exact.length}）`)
		const wire = exact[0]
		const index = wire.wireIndex
		if (typeof index !== 'number' || !Number.isInteger(index) || consumed.has(index))
			throw new Error(`ARC ${baseline.arcId} 的SES wire index缺失或重复`)
		if (wires.filter(candidate => candidate.wireIndex === index).length !== 1)
			throw new Error(`ARC ${baseline.arcId} 的SES wire包含多个path，当前不支持混合消解，已在写入前拒绝`)
		const changed = wires.filter(candidate => candidate !== wire && (sameEndpoints(candidate.points, baseline.points) || contiguousSubpath(candidate, baseline)))
		if (changed.length)
			throw new Error(`ARC ${baseline.arcId} 存在改动、拆分或重复SES保护wire，拒绝差集导入`)
		consumed.add(index)
		existingArcCoverage.push({ status: 'verified', arcId: baseline.arcId, dsnWireIndex: baseline.dsnWireIndex, sesWireIndex: index, segmentCount: wire.points.length - 1, direction: exactPointDirection(wire.points, baseline.points)! })
	}
	for (const arc of currentArcs) {
		if (routeBaseline.arcs.some(item => item.id === arc.id)) continue
		const data = arc.data as Record<string, any>
		const name = layerNames.get(data?.layerId)
		if (name && wires.some(wire => followsArc(wire, data, name, 0.005000001)))
			throw new Error(`SES 包含未纳入routeBaseline的既有ARC ${arc.id} protect链，拒绝按新增LINE导入`)
	}
	return { remainingWires: wires.filter(wire => !consumed.has(wire.wireIndex!)), existingArcCoverage, consumedWireIndices: [...consumed] }
}
