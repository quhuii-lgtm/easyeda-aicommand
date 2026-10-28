type SesNode = string | SesNode[]
type SesToken = { kind: 'open' | 'close' | 'value', value?: string }

export interface SesResolution {
	unit: 'mil' | 'inch' | 'mm'
	ticksPerUnit: number
}

export interface SesPadstack {
	name: string
	shapesByLayer: Array<{ kind: 'circle', layerName: string, diameterMil: number, offsetXMil: number, offsetYMil: number }>
	holeDiameterMil: null
	holeDiameterStatus: 'not-provided-by-ses'
}

export interface SesPlacement {
	componentId: string
	placeId: string
	xMil: number
	yMil: number
	side: 'front' | 'back'
	rotation: number
}

export interface SesWire {
	net: string
	layerName: string
	widthMil: number
	points: Array<{ xMil: number, yMil: number }>
	type?: string
	wireIndex?: number
	pathIndex?: number
}

export interface SesVia {
	net: string
	padstackName: string
	xMil: number
	yMil: number
}

export interface SesExpectedModel {
	resolution: SesResolution
	placementResolution: SesResolution
	wires: SesWire[]
	vias: SesVia[]
	padstacks: SesPadstack[]
	placements: SesPlacement[]
	unsupported: []
}

export interface SesLayer { id: number, name: string, type: string, layerStatus?: unknown }
export interface SesRoutePoint { x: number, y: number }
export interface SesRouteLine { id?: string, net: string, layer: number, widthMil: number, a: SesRoutePoint, b: SesRoutePoint, locked?: boolean }
export interface SesRouteVia { id?: string, net: string, x: number, y: number, diameterMil: number, holeDiameterMil?: number, holeDiameterSource?: 'caller-specified' | 'existing-board-readback', viaType?: 'through' | 0 | 1 | 2, locked?: boolean, padstackName?: string }
export interface SesRouteExpected {
	lines: SesRouteLine[]
	vias: SesRouteVia[]
	/** Verified SES layer names keyed by current PCB layer ID. */
	sesLayerNamesById?: Record<number, string>
	coordinateMapping: 'easyeda-pro-4.1.78-direct-xy'
	toleranceMil: 0.001
	toleranceScope: 'current mil/1000 fixture'
	holeDiameterStatus: 'not-specified-by-ses'
}
export interface SesRouteSnapshot { documentUuid: string, lines: SesRouteLine[], vias: SesRouteVia[], source?: string }
export interface SesImportPlan {
	mode: 'append' | 'replace-unlocked'
	expected: SesRouteExpected
	before: SesRouteSnapshot
	retainedLines: SesRouteLine[]
	retainedVias: SesRouteVia[]
	deltaLines: SesRouteLine[]
	deltaVias: SesRouteVia[]
	deleteLines: SesRouteLine[]
	deleteVias: SesRouteVia[]
	targetLines: SesRouteLine[]
	targetVias: SesRouteVia[]
	alreadyPresent: boolean
	toleranceMil: 0.001
	lineToleranceCapMil: 0.001
	lineToleranceUsedMil: number
}
export interface SesImportVerification {
	verified: boolean
	differences: Array<Record<string, unknown>>
	coverage: { toleranceMil: 0.001, lineToleranceCapMil: 0.001, lineToleranceUsedMil: number, lineGroupCount: number, expectedLineLengthMil: number, actualLineLengthMil: number, holeDiameterVerified: boolean, holeDiameterStatus: 'partially-specified' | 'not-specified-by-ses', holeDiameterSources: Array<'caller-specified' | 'existing-board-readback'> }
}

function tokenize(source: string): SesToken[] {
	const tokens: SesToken[] = []
	for (let i = 0; i < source.length;) {
		const char = source[i]
		if (/\s/.test(char)) {
			i++
			continue
		}
		if (char === ';') {
			while (i < source.length && source[i] !== '\n') i++
			continue
		}
		if (char === '(' || char === ')') {
			tokens.push({ kind: char === '(' ? 'open' : 'close' })
			i++
			continue
		}
		if (char === '"') {
			let value = ''
			let closed = false
			i++
			while (i < source.length) {
				const current = source[i++]
				if (current === '"') {
					closed = true
					break
				}
				if (current === '\\') {
					if (i >= source.length)
						throw new Error('SES 字符串转义不完整')
					const escaped = source[i++]
					value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped
				}
				else {
					value += current
				}
			}
			if (!closed)
				throw new Error('SES 字符串未闭合')
			tokens.push({ kind: 'value', value })
			continue
		}
		const start = i
		while (i < source.length && !/[\s()]/.test(source[i])) i++
		if (start === i)
			throw new Error(`SES 在偏移 ${i} 有无法识别的字符`)
		tokens.push({ kind: 'value', value: source.slice(start, i) })
	}
	return tokens
}

function parseExpressions(tokens: SesToken[]): SesNode[] {
	let index = 0
	const parseOne = (): SesNode => {
		const token = tokens[index]
		if (token?.kind !== 'open') {
			if (token === undefined || token.kind === 'close')
				throw new Error('SES 表达式结构不完整')
			index++
			return token.value ?? ''
		}
		index++
		const node: SesNode[] = []
		while (tokens[index]?.kind !== 'close') {
			if (tokens[index] === undefined)
				throw new Error('SES 列表未闭合')
			node.push(parseOne())
		}
		index++
		return node
	}
	const roots: SesNode[] = []
	while (index < tokens.length)
		roots.push(parseOne())
	return roots
}

function list(node: SesNode, context: string): SesNode[] {
	if (!Array.isArray(node))
		throw new Error(`${context} 必须是 S 表达式列表`)
	return node
}

function head(node: SesNode, context: string): string {
	const value = list(node, context)[0]
	if (typeof value !== 'string')
		throw new Error(`${context} 缺少名称`)
	return value
}

function childrenNamed(node: SesNode, name: string): SesNode[][] {
	return list(node, name).slice(1).filter((item): item is SesNode[] => Array.isArray(item) && item[0] === name)
}

function namedChildren(node: SesNode, context: string): SesNode[][] {
	return list(node, context).slice(1).filter((item): item is SesNode[] => Array.isArray(item))
}

function requireListChildren(node: SesNode, startIndex: number, context: string): void {
	for (const item of list(node, context).slice(startIndex)) {
		if (!Array.isArray(item))
			throw new Error(`${context} 包含不支持的标量字段 ${item}`)
	}
}

function scalar(value: SesNode | undefined, context: string): string {
	if (typeof value !== 'string')
		throw new Error(`${context} 缺少标量值`)
	return value
}

function numberValue(value: SesNode | undefined, context: string): number {
	const raw = scalar(value, context)
	const number = Number(raw)
	if (!Number.isFinite(number))
		throw new Error(`${context} 必须是有限数字`)
	return number
}

function readResolution(node: SesNode, context: string): SesResolution {
	const fields = list(node, context)
	if (fields.length !== 3 || fields[0] !== 'resolution')
		throw new Error(`${context} 格式应为 (resolution unit ticksPerUnit)`)
	const unit = scalar(fields[1], `${context} unit`)
	if (unit !== 'mil' && unit !== 'inch' && unit !== 'mm')
		throw new Error(`${context} 不支持单位 ${unit}`)
	const ticksPerUnit = numberValue(fields[2], `${context} ticksPerUnit`)
	if (ticksPerUnit <= 0)
		throw new Error(`${context} ticksPerUnit 必须大于 0`)
	return { unit, ticksPerUnit }
}

function toMil(value: number, resolution: SesResolution): number {
	const unitToMil = resolution.unit === 'mil' ? 1 : resolution.unit === 'inch' ? 1000 : 1000 / 25.4
	const result = value / resolution.ticksPerUnit * unitToMil
	if (!Number.isFinite(result))
		throw new Error('SES 坐标或尺寸换算结果不是有限数字')
	return result
}

function onlyMetadata(children: SesNode[][], parent: string, allowed: string[]): void {
	for (const child of children) {
		const name = head(child, parent)
		if (!allowed.includes(name))
			throw new Error(`${parent} 包含不支持的几何/结构 ${name}`)
	}
}

function readPadstacks(libraryOut: SesNode, resolution: SesResolution): SesPadstack[] {
	const seen = new Map<string, string>()
	const output = new Map<string, SesPadstack>()
	requireListChildren(libraryOut, 1, 'library_out')
	for (const child of namedChildren(libraryOut, 'library_out')) {
		if (head(child, 'library_out') !== 'padstack')
			throw new Error(`library_out 包含不支持的几何 ${head(child, 'library_out')}`)
		const fields = list(child, 'padstack')
		const name = scalar(fields[1], 'padstack name')
		if (fields.length < 2)
			throw new Error('padstack 缺少名称')
		const shapes: SesPadstack['shapesByLayer'] = []
		for (const shapeNode of fields.slice(2)) {
			const shape = list(shapeNode, 'padstack shape')
			if (shape[0] !== 'shape' || shape.length !== 2)
				throw new Error(`padstack ${name} 包含不支持的结构或几何`)
			const circle = list(shape[1], `padstack ${name} shape`)
			if (circle[0] !== 'circle' || circle.length !== 5)
				throw new Error(`padstack ${name} 包含不支持的几何 ${String(circle[0])}`)
			const layerName = scalar(circle[1], `padstack ${name} layer`)
			const diameter = numberValue(circle[2], `padstack ${name} diameter`)
			if (diameter <= 0)
				throw new Error(`padstack ${name} 的圆直径必须大于 0`)
			shapes.push({
				kind: 'circle',
				layerName,
				diameterMil: toMil(diameter, resolution),
				offsetXMil: toMil(numberValue(circle[3], `padstack ${name} offsetX`), resolution),
				offsetYMil: toMil(numberValue(circle[4], `padstack ${name} offsetY`), resolution),
			})
		}
		if (!shapes.length)
			throw new Error(`padstack ${name} 没有 shape`)
		const padstack: SesPadstack = { name, shapesByLayer: shapes, holeDiameterMil: null, holeDiameterStatus: 'not-provided-by-ses' }
		const fingerprint = JSON.stringify(padstack)
		const prior = seen.get(name)
		if (prior !== undefined && prior !== fingerprint)
			throw new Error(`padstack ${name} 重复定义冲突`)
		seen.set(name, fingerprint)
		output.set(name, padstack)
	}
	return [...output.values()]
}

function readPlacements(section: SesNode): { resolution: SesResolution, placements: SesPlacement[] } {
	requireListChildren(section, 1, 'placement')
	const children = namedChildren(section, 'placement')
	let resolution: SesResolution | undefined
	const placements: SesPlacement[] = []
	for (const child of children) {
		if (head(child, 'placement') === 'resolution') {
			if (resolution)
				throw new Error('placement 重复定义 resolution')
			resolution = readResolution(child, 'placement resolution')
		}
	}
	if (!resolution)
		throw new Error('SES placement 缺少 resolution')
	for (const child of children) {
		const name = head(child, 'placement')
		if (name === 'component') {
			const fields = list(child, 'placement component')
			const componentId = scalar(fields[1], 'placement component id')
			if (fields.length < 2)
				throw new Error('placement component 缺少 id')
			requireListChildren(child, 2, `component ${componentId}`)
			onlyMetadata(namedChildren(child, `component ${componentId}`), `component ${componentId}`, ['place'])
			const places = childrenNamed(child, 'place')
			if (!places.length)
				throw new Error(`component ${componentId} 缺少 place 元数据`)
			for (const placeNode of places) {
				const place = list(placeNode, `component ${componentId} place`)
				if (place.length !== 6)
					throw new Error(`component ${componentId} place 缺少 id/x/y/side/rotation 字段`)
				const placeId = scalar(place[1], `component ${componentId} place id`)
				const xMil = toMil(numberValue(place[2], `component ${componentId} place x`), resolution)
				const yMil = toMil(numberValue(place[3], `component ${componentId} place y`), resolution)
				const side = scalar(place[4], `component ${componentId} place side`)
				if (side !== 'front' && side !== 'back')
					throw new Error(`component ${componentId} 不支持 placement side ${side}`)
				const rotation = numberValue(place[5], `component ${componentId} place rotation`)
				placements.push({ componentId, placeId, xMil, yMil, side, rotation })
			}
		}
		else if (name !== 'resolution' && name !== 'was_is') {
			throw new Error(`placement 包含不支持的结构 ${name}`)
		}
	}
	return { resolution, placements }
}

function readRoutes(section: SesNode, placementResolution: SesResolution, placements: SesPlacement[]): SesExpectedModel {
	requireListChildren(section, 1, 'routes')
	let resolution: SesResolution | undefined
	let libraryOut: SesNode | undefined
	let networkOut: SesNode | undefined
	for (const child of namedChildren(section, 'routes')) {
		const name = head(child, 'routes')
		if (name === 'resolution') {
			if (resolution)
				throw new Error('routes 重复定义 resolution')
			resolution = readResolution(child, 'routes resolution')
		}
		else if (name === 'library_out') {
			if (libraryOut)
				throw new Error('routes 重复定义 library_out')
			libraryOut = child
		}
		else if (name === 'network_out') {
			if (networkOut)
				throw new Error('routes 重复定义 network_out')
			networkOut = child
		}
		else if (name !== 'parser') {
			throw new Error(`routes 包含不支持的几何/结构 ${name}`)
		}
	}
	if (!resolution)
		throw new Error('SES routes 缺少 resolution')
	if (!libraryOut)
		throw new Error('SES routes 缺少 library_out')
	if (!networkOut)
		throw new Error('SES routes 缺少 network_out')
	const padstacks = readPadstacks(libraryOut, resolution)
	const padstackNames = new Set(padstacks.map(p => p.name))
	const wires: SesWire[] = []
	const vias: SesVia[] = []
	let wireIndex = 0
	requireListChildren(networkOut, 1, 'network_out')
	for (const netNode of namedChildren(networkOut, 'network_out')) {
		if (head(netNode, 'network_out') !== 'net')
			throw new Error(`network_out 包含不支持的结构 ${head(netNode, 'network_out')}`)
		const netFields = list(netNode, 'network_out net')
		const net = scalar(netFields[1], 'network_out net name')
		requireListChildren(netNode, 2, `net ${net}`)
		for (const itemNode of netFields.slice(2)) {
			const itemName = head(itemNode, `net ${net}`)
			const item = list(itemNode, `net ${net} ${itemName}`)
			if (itemName === 'wire') {
				requireListChildren(itemNode, 1, `net ${net} wire`)
				const paths = childrenNamed(itemNode, 'path')
				const wireTypes = childrenNamed(itemNode, 'type')
				if (wireTypes.length > 1 || wireTypes.some(type => type.length !== 2 || typeof type[1] !== 'string'))
					throw new Error(`net ${net} wire type 元数据重复或无效`)
				const wireType = wireTypes.length ? scalar(wireTypes[0][1], `net ${net} wire type`) : undefined
				if (!paths.length)
					throw new Error(`net ${net} wire 缺少 path 几何`)
				onlyMetadata(namedChildren(itemNode, `net ${net} wire`), `net ${net} wire`, ['path', 'type'])
				for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
					const pathNode = paths[pathIndex]
					const path = list(pathNode, `net ${net} path`)
					if (path.length < 6 || (path.length - 3) % 2 !== 0)
						throw new Error(`net ${net} path 坐标必须至少包含两个完整点`)
					const layerName = scalar(path[1], `net ${net} path layer`)
					const width = numberValue(path[2], `net ${net} path width`)
					if (width <= 0)
						throw new Error(`net ${net} path width 必须大于 0`)
					const coords = path.slice(3).map((value, index) => numberValue(value, `net ${net} path coordinate ${index + 1}`))
					const points: SesWire['points'] = []
					for (let i = 0; i < coords.length; i += 2)
						points.push({ xMil: toMil(coords[i], resolution), yMil: toMil(coords[i + 1], resolution) })
					wires.push({ net, layerName, widthMil: toMil(width, resolution), points, ...(wireType ? { type: wireType } : {}), wireIndex, pathIndex })
				}
				wireIndex++
			}
			else if (itemName === 'via') {
				if (item.length !== 4 && item.length !== 5)
					throw new Error(`net ${net} via 字段不完整或包含不支持的结构`)
				requireListChildren(itemNode, 4, `net ${net} via`)
				const padstackName = scalar(item[1], `net ${net} via padstack`)
				if (!padstackNames.has(padstackName))
					throw new Error(`net ${net} via 引用了未定义 padstack ${padstackName}`)
				vias.push({
					net,
					padstackName,
					xMil: toMil(numberValue(item[2], `net ${net} via x`), resolution),
					yMil: toMil(numberValue(item[3], `net ${net} via y`), resolution),
				})
				for (const nested of item.slice(4)) {
					const metadata = list(nested, `net ${net} via metadata`)
					if (metadata[0] !== 'type' || metadata.length !== 2 || typeof metadata[1] !== 'string')
						throw new Error(`net ${net} via 包含不支持的几何/结构`)
				}
			}
			else if (itemName === 'type') {
				if (item.length !== 2 || typeof item[1] !== 'string')
					throw new Error(`net ${net} type 元数据格式无效`)
			}
			else {
				throw new Error(`net ${net} 包含不支持的 routes 几何 ${itemName}`)
			}
		}
	}
	return { resolution, placementResolution, wires, vias, padstacks, placements, unsupported: [] }
}

/** Parse SES into a pure expected-geometry model. This function never accesses EDA APIs. */
export function parseAutoRouteSes(source: string): SesExpectedModel {
	if (typeof source !== 'string' || !source.trim())
		throw new Error('SES 内容为空')
	const roots = parseExpressions(tokenize(source))
	if (roots.length !== 1)
		throw new Error(`SES 必须恰有一个根表达式（实际 ${roots.length}）`)
	const root = roots[0]
	if (head(root, 'SES root') !== 'session')
		throw new Error('SES 根表达式必须是 session')
	let placementSection: SesNode | undefined
	let routesSection: SesNode | undefined
	requireListChildren(root, 2, 'session')
	for (const child of namedChildren(root, 'session')) {
		const name = head(child, 'session')
		if (name === 'placement') {
			if (placementSection)
				throw new Error('SES 重复定义 placement')
			placementSection = child
		}
		else if (name === 'routes') {
			if (routesSection)
				throw new Error('SES 重复定义 routes')
			routesSection = child
		}
		else if (!['base_design', 'was_is'].includes(name)) {
			throw new Error(`session 包含不支持的几何/结构 ${name}`)
		}
	}
	if (!placementSection)
		throw new Error('SES 缺少 placement')
	if (!routesSection)
		throw new Error('SES 缺少 routes')
	const placement = readPlacements(placementSection)
	return readRoutes(routesSection, placement.resolution, placement.placements)
}

const ROUTE_TOLERANCE_MIL = 0.001 as const

function layerIdForSesName(name: string, layers: SesLayer[]): number {
	const alias = name === 'TopLayer' ? 'Top Layer' : name === 'BottomLayer' ? 'Bottom Layer' : name
	const matches = layers.filter(layer => layer.name === name || layer.name === alias)
	if (matches.length !== 1)
		throw new Error(`SES 层 ${name} 未能唯一映射到当前 PCB 层`)
	const layer = matches[0]
	if (String(layer.type).toUpperCase() !== 'SIGNAL')
		throw new Error(`SES 层 ${name} 映射到的 PCB 层 ${layer.name} 不是 SIGNAL 铜层`)
	if (isInnerSesLayer(name) && layer.layerStatus !== 1)
		throw new Error(`SES 内层 ${name} 对应的 PCB 层 ${layer.id} 未确认启用（layerStatus=${String(layer.layerStatus)}）`)
	return layer.id
}

function isInnerSesLayer(name: string): boolean {
	return /^Inner[1-9]\d*$/.test(name)
}

/** Convert supported SES layer names and padstacks into explicitly mapped SDK route geometry. */
export function mapSesRoutes(model: SesExpectedModel, layers: SesLayer[]): SesRouteExpected {
	const lines: SesRouteLine[] = []
	const sesLayerNamesById: Record<number, string> = {}
	const rememberLayer = (name: string): number => {
		if (!['TopLayer', 'Top Layer', 'BottomLayer', 'Bottom Layer'].includes(name) && !isInnerSesLayer(name))
			throw new Error(`SES 层名 ${name} 当前不支持`)
		const id = layerIdForSesName(name, layers)
		const prior = sesLayerNamesById[id]
		if (prior !== undefined && prior !== name)
			throw new Error(`多个 SES 层名映射到同一 PCB 层 ID ${id}（${prior} / ${name}）`)
		sesLayerNamesById[id] = name
		return id
	}
	for (const wire of model.wires) {
		const layer = rememberLayer(wire.layerName)
		for (let i = 1; i < wire.points.length; i++) {
			const previous = wire.points[i - 1]
			const current = wire.points[i]
			const line: SesRouteLine = {
				net: wire.net,
				layer,
				widthMil: wire.widthMil,
				a: { x: previous.xMil, y: previous.yMil },
				b: { x: current.xMil, y: current.yMil },
			}
			if (![line.a.x, line.a.y, line.b.x, line.b.y].every(Number.isFinite))
				throw new Error(`SES wire ${wire.net} 含非有限坐标`)
			if (line.a.x === line.b.x && line.a.y === line.b.y)
				throw new Error(`SES wire ${wire.net} 含零长线`)
			lines.push(line)
		}
	}
	const padstacks = new Map(model.padstacks.map(padstack => [padstack.name, padstack]))
	const vias: SesRouteVia[] = model.vias.map((via) => {
		const padstack = padstacks.get(via.padstackName)
		if (!padstack)
			throw new Error(`SES via 引用了未定义 padstack ${via.padstackName}`)
		const shapeByLayer = new Map<string, typeof padstack.shapesByLayer[number]>()
		const shapeById = new Map<number, typeof padstack.shapesByLayer[number]>()
		for (const shape of padstack.shapesByLayer) {
			if (!['TopLayer', 'BottomLayer'].includes(shape.layerName) && !isInnerSesLayer(shape.layerName))
				throw new Error(`padstack ${padstack.name} 的跨层形状 ${shape.layerName} 当前不支持`)
			if (shapeByLayer.has(shape.layerName))
				throw new Error(`padstack ${padstack.name} 在 ${shape.layerName} 重复定义形状`)
			if (Math.abs(shape.offsetXMil) > ROUTE_TOLERANCE_MIL || Math.abs(shape.offsetYMil) > ROUTE_TOLERANCE_MIL)
				throw new Error(`padstack ${padstack.name} 当前不支持偏心形状`)
			const layerId = rememberLayer(shape.layerName)
			if (shapeById.has(layerId))
				throw new Error(`padstack ${padstack.name} 的多个形状映射到同一 PCB 层 ID ${layerId}`)
			shapeByLayer.set(shape.layerName, shape)
			shapeById.set(layerId, shape)
		}
		const top = shapeByLayer.get('TopLayer')
		const bottom = shapeByLayer.get('BottomLayer')
		if (!top || !bottom)
			throw new Error(`padstack ${padstack.name} 不是当前支持的 TopLayer/BottomLayer 通孔形状`)
		if ([...shapeByLayer.values()].some(shape => Math.abs(top.diameterMil - shape.diameterMil) > ROUTE_TOLERANCE_MIL))
			throw new Error(`padstack ${padstack.name} 各层圆直径不一致`)
		return { net: via.net, x: via.xMil, y: via.yMil, diameterMil: top.diameterMil, viaType: 'through', padstackName: via.padstackName }
	})
	return {
		lines,
		vias,
		sesLayerNamesById,
		coordinateMapping: 'easyeda-pro-4.1.78-direct-xy',
		toleranceMil: ROUTE_TOLERANCE_MIL,
		toleranceScope: 'current mil/1000 fixture',
		holeDiameterStatus: 'not-specified-by-ses',
	}
}

/** Add caller-provided drill expectations without attributing them to the SES file. */
export function applySesViaHoleDiameters(expected: SesRouteExpected, input: unknown): SesRouteExpected {
	if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
		throw new Error('viaHoleDiametersMil 必须是普通对象')
	const values = input as Record<string, unknown>
	const viasByPadstack = new Map<string, SesRouteVia[]>()
	for (const via of expected.vias) {
		if (!via.padstackName)
			throw new Error('SES via 缺少 padstackName，无法套用 viaHoleDiametersMil')
		const vias = viasByPadstack.get(via.padstackName) ?? []
		vias.push(via)
		viasByPadstack.set(via.padstackName, vias)
	}
	for (const [padstackName, holeDiameterMil] of Object.entries(values)) {
		const vias = viasByPadstack.get(padstackName)
		if (!vias)
			throw new Error(`viaHoleDiametersMil 包含未知或未使用的 padstack ${padstackName}`)
		if (typeof holeDiameterMil !== 'number' || !Number.isFinite(holeDiameterMil) || holeDiameterMil <= 0)
			throw new Error(`viaHoleDiametersMil.${padstackName} 必须是大于 0 的有限数值`)
		if (vias.some(via => holeDiameterMil >= via.diameterMil))
			throw new Error(`viaHoleDiametersMil.${padstackName} 必须小于对应 padstack 铜径`)
	}
	return {
		...expected,
		vias: expected.vias.map(via => {
			const holeDiameterMil = via.padstackName ? values[via.padstackName] : undefined
			return typeof holeDiameterMil === 'number'
				? { ...via, holeDiameterMil, holeDiameterSource: 'caller-specified' as const }
				: via
		}),
	}
}

interface LineFrame { ux: number, uy: number, offset: number, t0: number, t1: number, length: number }
function lineFrame(line: SesRouteLine): LineFrame {
	if (![line.a.x, line.a.y, line.b.x, line.b.y].every(Number.isFinite))
		throw new Error('SDK route line coordinates must be finite numbers')
	let dx = line.b.x - line.a.x
	let dy = line.b.y - line.a.y
	const length = Math.hypot(dx, dy)
	if (length === 0)
		throw new Error('SDK route line length is zero')
	let ux = dx / length
	let uy = dy / length
	if (ux < -1e-12 || (Math.abs(ux) <= 1e-12 && uy < 0)) {
		dx = -dx
		dy = -dy
		ux = dx / length
		uy = dy / length
	}
	const tA = line.a.x * ux + line.a.y * uy
	const tB = line.b.x * ux + line.b.y * uy
	return { ux, uy, offset: -uy * line.a.x + ux * line.a.y, t0: Math.min(tA, tB), t1: Math.max(tA, tB), length }
}

function lineTolerance(lines: SesRouteLine[]): number {
	const lengths = lines.map(line => lineFrame(line).length)
	return Math.min(ROUTE_TOLERANCE_MIL, ...lengths.map(length => length / 4))
}

function lineAttributesEqual(a: SesRouteLine, b: SesRouteLine): boolean {
	return a.net === b.net && a.layer === b.layer && Math.abs(a.widthMil - b.widthMil) <= ROUTE_TOLERANCE_MIL
}

function sameSupport(a: SesRouteLine, b: SesRouteLine, toleranceMil: number): boolean {
	const fa = lineFrame(a)
	const perpendicularDistance = (point: SesRoutePoint) => Math.abs(-fa.uy * point.x + fa.ux * point.y - fa.offset)
	return perpendicularDistance(b.a) <= toleranceMil
		&& perpendicularDistance(b.b) <= toleranceMil
}

function intervalOnFrame(line: SesRouteLine, frame: LineFrame): [number, number] {
	const ta = line.a.x * frame.ux + line.a.y * frame.uy
	const tb = line.b.x * frame.ux + line.b.y * frame.uy
	return [Math.min(ta, tb), Math.max(ta, tb)]
}

function overlapOf(a: SesRouteLine, b: SesRouteLine): [number, number] | undefined {
	const frame = lineFrame(a)
	const [a0, a1] = intervalOnFrame(a, frame)
	const [b0, b1] = intervalOnFrame(b, frame)
	const start = Math.max(a0, b0)
	const end = Math.min(a1, b1)
	return end - start > 0 ? [start, end] : undefined
}

function pointAt(frame: LineFrame, t: number): SesRoutePoint {
	return { x: frame.ux * t - frame.uy * frame.offset, y: frame.uy * t + frame.ux * frame.offset }
}

function numericEndpointError(line: SesRouteLine): number {
	const scale = Math.max(1, Math.abs(line.a.x), Math.abs(line.a.y), Math.abs(line.b.x), Math.abs(line.b.y))
	return Math.min(ROUTE_TOLERANCE_MIL, Number.EPSILON * scale * 64)
}

function subtractLine(line: SesRouteLine, blockers: SesRouteLine[], mode: 'append' | 'replace-unlocked', toleranceMil: number): SesRouteLine[] {
	const frame = lineFrame(line)
	const coverage: Array<[number, number]> = []
	for (const blocker of blockers) {
		if (line.layer !== blocker.layer)
			continue
		if (!sameSupport(line, blocker, toleranceMil))
			continue
		const overlap = overlapOf(line, blocker)
		if (!overlap)
			continue
		if (!lineAttributesEqual(line, blocker))
			throw new Error(`${mode} SES 路径与现有不同网络/层/线宽图元共线重叠：SES=${JSON.stringify(line)} existing=${JSON.stringify(blocker)}`)
		coverage.push(overlap)
	}
	if (coverage.length === 0)
		return [line]
	coverage.sort((a, b) => a[0] - b[0])
	const merged: Array<[number, number]> = []
	for (const interval of coverage) {
		const previous = merged.at(-1)
		if (previous && interval[0] <= previous[1] + toleranceMil)
			previous[1] = Math.max(previous[1], interval[1])
		else
			merged.push([...interval])
	}
	const remaining: Array<[number, number]> = []
	let cursor = frame.t0
	const endpointError = Math.min(numericEndpointError(line), toleranceMil)
	for (const [start, end] of merged) {
		const snappedStart = Math.abs(start - frame.t0) <= endpointError ? frame.t0 : start
		const snappedEnd = Math.abs(end - frame.t1) <= endpointError ? frame.t1 : end
		if (snappedStart > cursor)
			remaining.push([cursor, snappedStart])
		cursor = Math.max(cursor, snappedEnd)
	}
	if (frame.t1 > cursor)
		remaining.push([cursor, frame.t1])
	if (remaining.length === 1 && Math.abs(remaining[0][0] - frame.t0) <= endpointError && Math.abs(remaining[0][1] - frame.t1) <= endpointError)
		return [line]
	return remaining.map(([start, end]) => ({ ...line, a: pointAt(frame, start), b: pointAt(frame, end) }))
}

function assertNoExpectedLineDuplicates(lines: SesRouteLine[]): void {
	const toleranceMil = lineTolerance(lines)
	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			if (lineAttributesEqual(lines[i], lines[j]) && sameSupport(lines[i], lines[j], toleranceMil) && overlapOf(lines[i], lines[j]))
				throw new Error(`SES 预期包含重叠重复导线：${JSON.stringify(lines[i])} / ${JSON.stringify(lines[j])}`)
		}
	}
}

function sameViaLocation(a: SesRouteVia, b: SesRouteVia): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= ROUTE_TOLERANCE_MIL
}

function sameViaGeometry(a: SesRouteVia, b: SesRouteVia): boolean {
	return a.net === b.net && sameViaLocation(a, b)
		&& Math.abs(a.diameterMil - b.diameterMil) <= ROUTE_TOLERANCE_MIL
		&& (a.viaType === undefined || b.viaType === undefined || normalizeViaType(a.viaType) === normalizeViaType(b.viaType))
}

function normalizeViaType(value: NonNullable<SesRouteVia['viaType']>): string {
	if (value === 0 || value === 'through')
		return 'through'
	return `sdk:${value}`
}

function prepareDeltaVias(expected: SesRouteVia[], blockers: SesRouteVia[], prior: SesRouteVia[], mode: 'append' | 'replace-unlocked'): SesRouteVia[] {
	for (let i = 0; i < expected.length; i++) {
		for (let j = i + 1; j < expected.length; j++) {
			if (sameViaLocation(expected[i], expected[j]))
				throw new Error(`SES 预期包含同位置重复/冲突过孔：${JSON.stringify(expected[i])} / ${JSON.stringify(expected[j])}`)
		}
	}
	const delta: SesRouteVia[] = []
	for (const via of expected) {
		const priorAtGeometry = prior.filter(item => sameViaGeometry(via, item))
		if (via.holeDiameterSource === 'caller-specified' && priorAtGeometry.some(item =>
			item.holeDiameterMil === undefined
			|| !Number.isFinite(item.holeDiameterMil)
			|| Math.abs(item.holeDiameterMil - via.holeDiameterMil!) > ROUTE_TOLERANCE_MIL,
		))
			throw new Error(`${mode} SES 显式指定的过孔孔径与现有同位置过孔孔径不一致或不可读：${JSON.stringify(via)} / ${JSON.stringify(priorAtGeometry)}`)
		const atLocation = blockers.filter(item => sameViaLocation(via, item))
		if (atLocation.some(item => !sameViaGeometry(via, item)))
			throw new Error(`${mode} SES 过孔与现有同位置过孔网络/外径/类型冲突：${JSON.stringify(via)} / ${JSON.stringify(atLocation)}`)
		if (atLocation.length) {
			if (atLocation.length > 1)
				throw new Error(`现有同位置重复过孔无法安全作为单一匹配：${JSON.stringify(atLocation)}`)
			continue
		}
		const old = prior.find(item => sameViaGeometry(via, item))
		delta.push(via.holeDiameterSource === 'caller-specified'
			? { ...via }
			: old?.holeDiameterMil === undefined
				? { ...via }
				: { ...via, holeDiameterMil: old.holeDiameterMil, holeDiameterSource: 'existing-board-readback' })
	}
	return delta
}

/** Make an append or replace-unlocked plan without touching EDA or mutating snapshots. */
export function planSesImport(expected: SesRouteExpected, before: SesRouteSnapshot, mode: 'append' | 'replace-unlocked'): SesImportPlan {
	assertNoExpectedLineDuplicates(expected.lines)
	const retainedLines = mode === 'append' ? [...before.lines] : before.lines.filter(line => line.locked === true)
	const retainedVias = mode === 'append' ? [...before.vias] : before.vias.filter(via => via.locked === true)
	const deleteLines = mode === 'append' ? [] : before.lines.filter(line => line.locked !== true)
	const deleteVias = mode === 'append' ? [] : before.vias.filter(via => via.locked !== true)
	const lineToleranceUsedMil = lineTolerance([...expected.lines, ...retainedLines])
	const deltaLines = expected.lines.flatMap(line => subtractLine(line, retainedLines, mode, lineToleranceUsedMil))
	const routeVias = prepareDeltaVias(expected.vias, retainedVias, before.vias, mode)
	const deltaVias = routeVias
	const targetLines = [...retainedLines, ...deltaLines]
	const targetVias = [...retainedVias, ...deltaVias]
	return {
		mode,
		expected,
		before,
		retainedLines,
		retainedVias,
		deltaLines,
		deltaVias,
		deleteLines,
		deleteVias,
		targetLines,
		targetVias,
		alreadyPresent: deltaLines.length === 0 && deltaVias.length === 0 && deleteLines.length === 0 && deleteVias.length === 0,
		toleranceMil: ROUTE_TOLERANCE_MIL,
		lineToleranceCapMil: ROUTE_TOLERANCE_MIL,
		lineToleranceUsedMil,
	}
}

function compareLineCoverage(expected: SesRouteLine[], actual: SesRouteLine[]): { differences: Array<Record<string, unknown>>, groupCount: number, expectedLength: number, actualLength: number, lineToleranceUsedMil: number } {
	const toleranceMil = lineTolerance([...expected, ...actual])
	const groups: Array<{ expected: SesRouteLine[], actual: SesRouteLine[], representative: SesRouteLine }> = []
	for (const [line, source] of [...expected.map(line => [line, 'expected'] as const), ...actual.map(line => [line, 'actual'] as const)]) {
		// Group by electrical identity and geometry first. Width is checked separately
		// so a width-only readback change is diagnosed as such, never as missing copper.
		const group = groups.find(item => item.representative.net === line.net && item.representative.layer === line.layer && sameSupport(item.representative, line, toleranceMil))
		if (group)
			group[source].push(line)
		else
			groups.push({ expected: source === 'expected' ? [line] : [], actual: source === 'actual' ? [line] : [], representative: line })
	}
	const differences: Array<Record<string, unknown>> = []
	for (const group of groups) {
		const e = group.expected
		const a = group.actual
		const representative = group.representative
		const frame = lineFrame(representative)
		const eIntervals = e.map(line => intervalOnFrame(line, frame))
		const aIntervals = a.map(line => intervalOnFrame(line, frame))
		const boundaries = [...eIntervals, ...aIntervals].flatMap(item => item).sort((x, y) => x - y)
		const compact: number[] = []
		let anchor = Number.NaN
		for (const point of boundaries) {
			if (!compact.length || point - anchor > toleranceMil) {
				compact.push(point)
				anchor = point
			}
		}
		for (let i = 1; i < compact.length; i++) {
			const start = compact[i - 1]
			const end = compact[i]
			if (end - start <= 0)
				continue
			const middle = (start + end) / 2
			const expectedAt = e.filter((_, index) => middle > eIntervals[index][0] && middle < eIntervals[index][1])
			const actualAt = a.filter((_, index) => middle > aIntervals[index][0] && middle < aIntervals[index][1])
			const expectedCount = expectedAt.length
			const actualCount = actualAt.length
			if (expectedCount !== actualCount)
				differences.push({ code: actualCount < expectedCount ? 'lineCoverageMissing' : 'lineCoverageUnexpected', net: representative.net, layer: representative.layer, widthMil: representative.widthMil, from: pointAt(frame, start), to: pointAt(frame, end), expectedMultiplicity: expectedCount, actualMultiplicity: actualCount })
			else if (expectedCount > 0) {
				const unmatchedExpected = [...expectedAt]
				const unmatchedActual = [...actualAt]
				// Match exact-width pairs first, then pair the remaining geometry so a
				// width-only difference gets a useful expected/actual diagnostic.
				for (let i = unmatchedExpected.length - 1; i >= 0; i--) {
					const match = unmatchedActual.findIndex(line => Math.abs(line.widthMil - unmatchedExpected[i].widthMil) <= ROUTE_TOLERANCE_MIL)
					if (match >= 0) {
						unmatchedExpected.splice(i, 1)
						unmatchedActual.splice(match, 1)
					}
				}
				while (unmatchedExpected.length && unmatchedActual.length) {
					let expectedIndex = 0
					let actualIndex = 0
					let smallestDifference = Number.POSITIVE_INFINITY
					for (let ei = 0; ei < unmatchedExpected.length; ei++) {
						for (let ai = 0; ai < unmatchedActual.length; ai++) {
							const delta = Math.abs(unmatchedExpected[ei].widthMil - unmatchedActual[ai].widthMil)
							if (delta < smallestDifference) {
								smallestDifference = delta
								expectedIndex = ei
								actualIndex = ai
							}
						}
					}
					const expectedLine = unmatchedExpected.splice(expectedIndex, 1)[0]
					const actualLine = unmatchedActual.splice(actualIndex, 1)[0]
					const differenceMil = actualLine.widthMil - expectedLine.widthMil
					if (Math.abs(differenceMil) > ROUTE_TOLERANCE_MIL)
						differences.push({ code: 'lineWidthMismatch', net: representative.net, layer: representative.layer, from: pointAt(frame, start), to: pointAt(frame, end), expectedWidthMil: expectedLine.widthMil, actualWidthMil: actualLine.widthMil, differenceMil, expectedLineId: expectedLine.id ?? null, actualLineId: actualLine.id ?? null })
				}
			}
		}
	}
	return {
		differences,
		groupCount: groups.length,
		expectedLength: expected.reduce((sum, item) => sum + lineFrame(item).length, 0),
		actualLength: actual.reduce((sum, item) => sum + lineFrame(item).length, 0),
		lineToleranceUsedMil: toleranceMil,
	}
}

function compareViaMultiset(expected: SesRouteVia[], actual: SesRouteVia[]): Array<Record<string, unknown>> {
	const unused = new Set(actual.map((_, index) => index))
	const differences: Array<Record<string, unknown>> = []
	for (const item of expected) {
		const candidates = [...unused].filter(index => sameViaLocation(item, actual[index]))
		const match = candidates.find(index => sameViaGeometry(item, actual[index]))
		if (match === undefined) {
			differences.push({ code: candidates.length ? 'viaAttributeMismatch' : 'viaMissing', expected: item, actualAtLocation: candidates.map(index => actual[index]) })
			continue
		}
		unused.delete(match)
		if (item.holeDiameterMil !== undefined && (!Number.isFinite(actual[match].holeDiameterMil) || Math.abs(actual[match].holeDiameterMil! - item.holeDiameterMil) > ROUTE_TOLERANCE_MIL))
			differences.push({ code: 'viaHoleDiameterChanged', expectedMil: item.holeDiameterMil, actualMil: actual[match].holeDiameterMil, expectedVia: item, actualVia: actual[match] })
	}
	for (const index of unused)
		differences.push({ code: 'viaUnexpectedOrDuplicate', actual: actual[index] })
	return differences
}

/** Compare readback against the plan target, including line multiplicity and via hole preservation. */
export function verifySesImport(plan: SesImportPlan, after: SesRouteSnapshot): SesImportVerification {
	const differences: Array<Record<string, unknown>> = []
	if (plan.before.documentUuid !== after.documentUuid)
		differences.push({ code: 'documentUuidMismatch', expected: plan.before.documentUuid, actual: after.documentUuid })
	const lineCheck = compareLineCoverage(plan.targetLines, after.lines)
	differences.push(...lineCheck.differences)
	differences.push(...compareViaMultiset(plan.targetVias, after.vias))
	const holeDiameterVerified = plan.targetVias.some(via => via.holeDiameterMil !== undefined)
	const holeDiameterSources = new Set<'caller-specified' | 'existing-board-readback'>()
	for (const via of plan.expected.vias) {
		if (via.holeDiameterSource === 'caller-specified')
			holeDiameterSources.add('caller-specified')
	}
	for (const via of plan.targetVias) {
		if (via.holeDiameterMil !== undefined)
			holeDiameterSources.add(via.holeDiameterSource ?? 'existing-board-readback')
	}
	return {
		verified: differences.length === 0,
		differences,
		coverage: {
			toleranceMil: ROUTE_TOLERANCE_MIL,
			lineToleranceCapMil: ROUTE_TOLERANCE_MIL,
			lineToleranceUsedMil: lineCheck.lineToleranceUsedMil,
			lineGroupCount: lineCheck.groupCount,
			expectedLineLengthMil: lineCheck.expectedLength,
			actualLineLengthMil: lineCheck.actualLength,
			holeDiameterVerified,
			holeDiameterStatus: holeDiameterVerified ? 'partially-specified' : 'not-specified-by-ses',
			holeDiameterSources: [...holeDiameterSources],
		},
	}
}

function quoteSesValue(value: string): string {
	if (!value.length || /[\s();"\\]/.test(value))
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
	return value
}

function printSes(node: SesNode, depth = 0): string {
	if (!Array.isArray(node))
		return quoteSesValue(node)
	const indent = '  '.repeat(depth)
	if (node[0] === 'path' && node.length >= 5 && node.length % 2 === 1) {
		const prefix = node.slice(0, 3).map(item => printSes(item, depth)).join(' ')
		const pointLines: string[] = []
		for (let i = 3; i + 1 < node.length; i += 2)
			pointLines.push(`${'  '.repeat(depth + 1)}${printSes(node[i], depth + 1)} ${printSes(node[i + 1], depth + 1)}`)
		return `(${prefix}\n${pointLines.join('\n')}\n${indent})`
	}
	const firstChildIndex = node.findIndex(Array.isArray)
	if (firstChildIndex < 0)
		return `(${node.map(item => printSes(item, depth)).join(' ')})`
	const prefix = node.slice(0, firstChildIndex).map(item => printSes(item, depth)).join(' ')
	const children = node.slice(firstChildIndex).map(item => `${'  '.repeat(depth + 1)}${printSes(item, depth + 1)}`)
	return `(${prefix}\n${children.join('\n')}\n${indent})`
}

function formatSesNumber(value: number): string {
	if (!Number.isFinite(value))
		throw new Error('SES 序列化收到非有限数值')
	return Number(value.toPrecision(12)).toString()
}

function fromMil(value: number, resolution: SesResolution): number {
	const milToUnit = resolution.unit === 'mil' ? 1 : resolution.unit === 'inch' ? 1 / 1000 : 25.4 / 1000
	return value * milToUnit * resolution.ticksPerUnit
}

function routeLayerName(layer: number, sesLayerNamesById?: Record<number, string>): string {
	if (sesLayerNamesById !== undefined) {
		const name = sesLayerNamesById[layer]
		if (!name || (!['TopLayer', 'Top Layer', 'BottomLayer', 'Bottom Layer'].includes(name) && !isInnerSesLayer(name)))
			throw new Error(`SES 子集序列化缺少已验证的 PCB 层 ID ${layer} 映射`)
		if (name === 'TopLayer' || name === 'Top Layer')
			return 'TopLayer'
		if (name === 'BottomLayer' || name === 'Bottom Layer')
			return 'BottomLayer'
		return name
	}
	if (layer === 1)
		return 'TopLayer'
	if (layer === 2)
		return 'BottomLayer'
	throw new Error(`SES 子集序列化不支持 PCB 层 ID ${layer}`)
}

/**
 * Serialize a delta SES using the source tree as the base. Only network_out net
 * wire/via geometry is replaced; placement, library padstacks and other metadata
 * are retained. Empty deltas are valid and emit no route geometry.
 */
export function serializeSesSubset(source: string, delta: SesRouteExpected): string {
	const originalModel = parseAutoRouteSes(source)
	const roots = parseExpressions(tokenize(source))
	const root = roots[0]
	const routes = namedChildren(root, 'session').find(child => head(child, 'session') === 'routes')
	if (!routes)
		throw new Error('SES 子集序列化缺少 routes')
	const networkOut = namedChildren(routes, 'routes').find(child => head(child, 'routes') === 'network_out')
	if (!networkOut)
		throw new Error('SES 子集序列化缺少 network_out')
	const generated = new Map<string, SesNode[][]>()
	const forNet = (net: string) => {
		const list = generated.get(net) ?? []
		generated.set(net, list)
		return list
	}
	for (const line of delta.lines) {
		const layer = routeLayerName(line.layer, delta.sesLayerNamesById)
		const rawWidth = formatSesNumber(fromMil(line.widthMil, originalModel.resolution))
		const rawPoints = [line.a, line.b].flatMap(point => [
			formatSesNumber(fromMil(point.x, originalModel.resolution)),
			formatSesNumber(fromMil(point.y, originalModel.resolution)),
		])
		forNet(line.net).push(['wire', ['path', layer, rawWidth, ...rawPoints]])
	}
	for (const via of delta.vias) {
		if (!via.padstackName || !originalModel.padstacks.some(padstack => padstack.name === via.padstackName))
			throw new Error(`SES 子集序列化找不到 via padstack ${via.padstackName}`)
		forNet(via.net).push([
			'via', via.padstackName,
			formatSesNumber(fromMil(via.x, originalModel.resolution)),
			formatSesNumber(fromMil(via.y, originalModel.resolution)),
		])
	}
	const fields = list(networkOut, 'network_out')
	const existingNets = new Map<string, SesNode[]>()
	for (const child of fields.slice(1)) {
		if (!Array.isArray(child) || child[0] !== 'net')
			continue
		const name = scalar(child[1], 'network_out net name')
		const metadata = child.slice(2).filter((item) => {
			if (!Array.isArray(item))
				throw new Error(`network_out net ${name} 含未知标量字段 ${item}`)
			return item[0] !== 'wire' && item[0] !== 'via'
		})
		existingNets.set(name, ['net', name, ...metadata])
	}
	const replacementNets: SesNode[] = []
	for (const [name, routesForNet] of generated) {
		const existing = existingNets.get(name)
		replacementNets.push([...(existing ?? ['net', name]), ...routesForNet])
	}
	for (const [name, prior] of existingNets) {
		if (!generated.has(name) && prior.length > 2)
			replacementNets.push(prior)
	}
	const preservedNetworkFields = fields.slice(1).filter(item => !Array.isArray(item) || item[0] !== 'net')
	const replacement: SesNode[] = ['network_out', ...preservedNetworkFields, ...replacementNets]
	const index = list(routes, 'routes').findIndex(child => child === networkOut)
	if (index < 0)
		throw new Error('SES 子集序列化无法定位 network_out 节点')
	list(routes, 'routes')[index] = replacement
	return `${printSes(root)}\n`
}
