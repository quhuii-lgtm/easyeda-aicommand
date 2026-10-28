export type DsnPadPhysicalShape = { padType: 'RECT' | 'OVAL' | 'ELLIPSE'; widthMil: number; heightMil: number; radiusMil?: number }
export type DsnPadPhysicalIdentity = { componentId: string; localPadId: string }
export type DsnPadPhysicalCandidate = DsnPadPhysicalIdentity & { centerMil: [number, number]; rotationDegrees: number; shape: DsnPadPhysicalShape }
export type DsnPadPhysicalFace =
	| { state: 'selected'; shape: DsnPadPhysicalShape; sourceIdentity: DsnPadPhysicalIdentity; dsn: { method: 'native-dsn-outer-shape-selection'; evidence: 'dsn-export-derived'; image: 'u1'; pinName: string; padstackName: string; layer: 'TopLayer' | 'BottomLayer'; shapeKind: 'circle' | 'polygon'; shapeOrdinal: number; pattern: 'circle' | 'rect-four-corner' | 'oval-half-circle-n12' | 'oval-half-circle-n13'; quantization: { gridMil: 0.01; halfStepMil: 0.005 }; hostCad?: string; hostVersion?: string } }
	| { state: 'unknown'; reason: string }
export interface DsnPadPhysicalSelection { sourceIdentity: DsnPadPhysicalIdentity; top: DsnPadPhysicalFace; bottom: DsnPadPhysicalFace; rawQueryFailure?: Record<string, unknown> }
export interface DsnPadPhysicalViewReport { complete: boolean; selections: DsnPadPhysicalSelection[]; unknowns: Array<{ sourceIdentity?: DsnPadPhysicalIdentity; reason: string }> }

type Atom = { kind: 'atom'; value: string }
type List = { kind: 'list'; items: Node[] }
type Node = Atom | List
type DsnShape = { layer: string; kind: 'circle' | 'polygon' | 'unknown'; values: number[]; ordinal: number }
type Pin = { instanceId: string; stackName: string; x: number; y: number }
type DsnMetadata = { hostCad?: string; hostVersion?: string }
const canonicalLocalPadId = /^e[1-9]\d*$/u
const isAtom = (node: Node | undefined, value?: string): node is Atom => !!node && node.kind === 'atom' && (value === undefined || node.value === value)
const isList = (node: Node | undefined, name?: string): node is List => !!node && node.kind === 'list' && (name === undefined || isAtom(node.items[0], name))
const children = (node: List, name: string): List[] => node.items.slice(1).filter((item): item is List => isList(item, name))
const number = (node: Node | undefined): number | undefined => isAtom(node) && node.value.trim() !== '' && Number.isFinite(Number(node.value)) ? Number(node.value) : undefined
const finitePair = (items: Node[], offset: number): [number, number] | undefined => {
	const x = number(items[offset]); const y = number(items[offset + 1]);
	return x !== undefined && y !== undefined ? [x, y] : undefined
}
function parseSexpr(source: string): Node[] {
	const roots: Node[] = []; const stack: List[] = []
	for (let i = 0; i < source.length;) {
		const ch = source[i]
		if (/\s/u.test(ch)) { i++; continue }
		if (ch === ';' || (ch === '#' && (i === 0 || /\s/u.test(source[i - 1])))) { while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++; continue }
		if (ch === '(') { const list: List = { kind: 'list', items: [] }; (stack.at(-1)?.items ?? roots).push(list); stack.push(list); i++; continue }
		if (ch === ')') { if (!stack.pop()) throw new Error('unmatched right parenthesis'); i++; continue }
		let value = ''
		if (ch === '"' || ch === "'") {
			const quote = ch; i++; let closed = false
			while (i < source.length) { const next = source[i++]; if (next === quote) { closed = true; break } if (next === '\\') { if (i >= source.length) break; value += source[i++] } else value += next }
			if (!closed) throw new Error('unterminated string')
		}
		else { const start = i; while (i < source.length && !/[\s()]/u.test(source[i])) i++; value = source.slice(start, i) }
		(stack.at(-1)?.items ?? roots).push({ kind: 'atom', value })
	}
	if (stack.length) throw new Error('unclosed list')
	return roots
}
function parseDsn(source: string): { pinByName: Map<string, Pin[]>; padstackByName: Map<string, DsnShape[][]>; metadata: DsnMetadata } {
	const roots = parseSexpr(source); const pcbs = roots.filter(item => isList(item, 'PCB'))
	if (pcbs.length !== 1) throw new Error('expected exactly one top-level PCB')
	const pcb = pcbs[0]; const placements = children(pcb, 'placement'); const libraries = children(pcb, 'library'); const resolutions = children(pcb, 'resolution'); const units = children(pcb, 'unit')
	if (placements.length !== 1 || libraries.length !== 1 || resolutions.length !== 1 || units.length > 1) throw new Error('placement/library/resolution missing or repeated')
	if (!isAtom(resolutions[0].items[1], 'mil') || !(number(resolutions[0].items[2])! > 0) || resolutions[0].items.length !== 3 || (units.length === 1 && (!isAtom(units[0].items[1], 'mil') || units[0].items.length !== 2))) throw new Error('only positive mil resolution and mil unit are supported')
	const components = children(placements[0], 'component'); const images = children(libraries[0], 'image')
	if (components.length !== 1 || images.length !== 1 || !isAtom(components[0].items[1], 'u1') || !isAtom(images[0].items[1], 'u1')) throw new Error('only one image u1 and one placement component u1 are supported')
	const placeScopes = children(components[0], 'place')
	if (placeScopes.length !== 1) throw new Error('placement u1 must have exactly one place scope')
	const place = placeScopes[0]
	if (place.items.length !== 6 || !isAtom(place.items[1], 'u1') || number(place.items[2]) !== 0 || number(place.items[3]) !== 0 || !isAtom(place.items[4], 'front') || number(place.items[5]) !== 0) throw new Error('only placement u1 front 0 at x=0,y=0 with no pin rotations is supported')
	const parserScopes = children(pcb, 'parser')
	const metadata: DsnMetadata = {}
	if (parserScopes.length === 1) {
		for (const key of ['host_cad', 'host_version'] as const) {
			const entries = children(parserScopes[0], key)
			if (entries.length === 1 && isAtom(entries[0].items[1])) metadata[key === 'host_cad' ? 'hostCad' : 'hostVersion'] = entries[0].items[1].value
		}
	}
	const pinByName = new Map<string, Pin[]>()
	for (const pinNode of children(images[0], 'pin')) {
		if (pinNode.items.length !== 5 || !isAtom(pinNode.items[1]) || !isAtom(pinNode.items[2])) throw new Error('image u1 pin has unsupported fields')
		const x = number(pinNode.items[3]); const y = number(pinNode.items[4]); if (x === undefined || y === undefined) throw new Error('image pin coordinate is invalid')
		const pin = { stackName: pinNode.items[1].value, instanceId: pinNode.items[2].value, x, y }
		pinByName.set(pin.instanceId, [...(pinByName.get(pin.instanceId) ?? []), pin])
	}
	const padstackByName = new Map<string, DsnShape[][]>()
	for (const stackNode of children(libraries[0], 'padstack')) {
		if (!isAtom(stackNode.items[1])) throw new Error('padstack missing name')
		const parsed: DsnShape[] = []
		for (const shapeNode of children(stackNode, 'shape')) {
			if (shapeNode.items.length !== 2 || !isList(shapeNode.items[1])) throw new Error('shape contains unsupported fields')
			const shape = shapeNode.items[1]
			if (!isAtom(shape.items[1])) throw new Error('shape has no layer')
			if (shape.items[1].value !== 'TopLayer' && shape.items[1].value !== 'BottomLayer') { parsed.push({ layer: shape.items[1].value, kind: 'unknown', values: [], ordinal: parsed.length }); continue }
			if (isAtom(shape.items[0], 'circle')) {
				if (!isAtom(shape.items[1])) throw new Error('circle has no layer')
				const d = number(shape.items[2]); const center = shape.items.length === 5 ? finitePair(shape.items, 3) : shape.items.length === 3 ? [0, 0] as [number, number] : undefined
				if (d === undefined || d <= 0 || !center) throw new Error('circle supports positive diameter and optional center only')
				parsed.push({ layer: shape.items[1].value, kind: 'circle', values: [d, ...center], ordinal: parsed.length })
			}
			else if (isAtom(shape.items[0], 'polygon')) {
				if (!isAtom(shape.items[1])) throw new Error('polygon has no layer')
				const width = number(shape.items[2]); const coordinates = shape.items.slice(3)
				if (width === undefined || coordinates.length < 6 || coordinates.length % 2 !== 0) throw new Error('polygon requires aperture and coordinate pairs')
				const values = coordinates.map(number)
				if (values.some(value => value === undefined)) throw new Error('polygon has non-finite coordinate')
				parsed.push({ layer: shape.items[1].value, kind: 'polygon', values: [width, ...values as number[]], ordinal: parsed.length })
			}
			else throw new Error('unsupported padstack shape kind')
		}
		padstackByName.set(stackNode.items[1].value, [...(padstackByName.get(stackNode.items[1].value) ?? []), parsed])
	}
	return { pinByName, padstackByName, metadata }
}
function expectedPolygons(shape: DsnPadPhysicalShape, rotationDegrees: number): Array<[number, number]>[] | undefined {
	if (![shape.widthMil, shape.heightMil, shape.radiusMil ?? 0, rotationDegrees].every(Number.isFinite) || shape.widthMil <= 0 || shape.heightMil <= 0) return undefined
	if (shape.padType === 'RECT') {
		if ((shape.radiusMil ?? 0) !== 0) return undefined
		return [[[ -shape.widthMil / 2, -shape.heightMil / 2], [-shape.widthMil / 2, shape.heightMil / 2], [shape.widthMil / 2, shape.heightMil / 2], [shape.widthMil / 2, -shape.heightMil / 2]].map(point => rotatePoint(point as [number, number], rotationDegrees))]
	}
	if (shape.padType !== 'OVAL') return undefined
	const long = Math.max(shape.widthMil, shape.heightMil); const short = Math.min(shape.widthMil, shape.heightMil); const radius = short / 2; const axis = (long - short) / 2; const vertical = shape.heightMil > shape.widthMil
	const output: Array<[number, number]>[] = []
	for (const intervals of [12, 13] as const) {
		const points: Array<[number, number]> = []
		for (let index = 0; index <= intervals; index++) { const angle = (-90 + index * 180 / intervals) * Math.PI / 180; points.push([axis + radius * Math.cos(angle), radius * Math.sin(angle)]) }
		for (let index = 0; index <= intervals; index++) { const angle = (90 + index * 180 / intervals) * Math.PI / 180; points.push([-axis + radius * Math.cos(angle), radius * Math.sin(angle)]) }
		output.push(points.map(point => rotatePoint(vertical ? [-point[1], point[0]] as [number, number] : point, rotationDegrees)))
	}
	return output
}
function rotatePoint(point: [number, number], degrees: number): [number, number] {
	const angle = degrees * Math.PI / 180; const x = point[0] * Math.cos(angle) - point[1] * Math.sin(angle); const y = point[0] * Math.sin(angle) + point[1] * Math.cos(angle)
	return [x, y]
}
const roundGrid = (value: number) => Math.round(value * 100) / 100
const almostGrid = (a: number, b: number) => Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
const withinGridHalfStep = (actual: number, expected: number) => Math.abs(actual - expected) <= 0.005 + 8 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected))
const isOnDsnGrid = (value: number) => almostGrid(value, roundGrid(value))
function normalizePolygon(points: Array<[number, number]>): Array<[number, number]> {
	const compact: Array<[number, number]> = []
	for (const point of points) if (!compact.length || !almostGrid(compact.at(-1)![0], point[0]) || !almostGrid(compact.at(-1)![1], point[1])) compact.push(point)
	if (compact.length > 1 && almostGrid(compact[0][0], compact.at(-1)![0]) && almostGrid(compact[0][1], compact.at(-1)![1])) compact.pop()
	return compact
}
function sameCycle(actual: Array<[number, number]>, expected: Array<[number, number]>): boolean {
	if (actual.length !== expected.length || actual.length < 3) return false
	if (!actual.flat().every(isOnDsnGrid)) return false
	const matches = (offset: number, direction: 1 | -1) => actual.every((point, index) => {
		const other = expected[(offset + direction * index + expected.length) % expected.length]
		return withinGridHalfStep(point[0], other[0]) && withinGridHalfStep(point[1], other[1])
	})
	return expected.some((_, offset) => matches(offset, 1) || matches(offset, -1))
}
function facePattern(shape: DsnShape, candidate: DsnPadPhysicalCandidate): 'circle' | 'rect-four-corner' | 'oval-half-circle-n12' | 'oval-half-circle-n13' | undefined {
	if (shape.kind === 'circle') {
		if (!isOnDsnGrid(shape.values[0]) || shape.values[1] !== 0 || shape.values[2] !== 0 || candidate.shape.padType !== 'ELLIPSE') return undefined
		const diameter = candidate.shape.widthMil
		return withinGridHalfStep(shape.values[0], diameter) ? 'circle' : undefined
	}
	if (!isOnDsnGrid(shape.values[0]) || shape.values[0] !== 0.1) return undefined
	const points = normalizePolygon(Array.from({ length: (shape.values.length - 1) / 2 }, (_, index) => [shape.values[1 + index * 2], shape.values[2 + index * 2]] as [number, number]))
	const expected = expectedPolygons(candidate.shape, candidate.rotationDegrees)
	if (!expected) return undefined
	const matched = expected.findIndex(sequence => sameCycle(points, normalizePolygon(sequence)))
	if (matched < 0) return undefined
	return candidate.shape.padType === 'RECT' ? 'rect-four-corner' : matched === 0 ? 'oval-half-circle-n12' : 'oval-half-circle-n13'
}
function sameShape(a: DsnPadPhysicalShape, b: DsnPadPhysicalShape): boolean {
	return a.padType === b.padType && a.widthMil === b.widthMil && a.heightMil === b.heightMil && (a.radiusMil ?? 0) === (b.radiusMil ?? 0)
}
function canonicalIdentity(identity: DsnPadPhysicalIdentity): string | undefined {
	if (typeof identity.componentId !== 'string' || !identity.componentId || typeof identity.localPadId !== 'string' || !canonicalLocalPadId.test(identity.localPadId)) return undefined
	return JSON.stringify([identity.componentId, identity.localPadId])
}
export function selectDsnPadPhysicalViews(args: { dsnText: string; candidates: DsnPadPhysicalCandidate[]; identityUniverse?: DsnPadPhysicalIdentity[] }): DsnPadPhysicalViewReport {
	const unknowns: DsnPadPhysicalViewReport['unknowns'] = []; const selections: DsnPadPhysicalSelection[] = []
	const identities = args.identityUniverse ?? args.candidates
	const identityByAlias = new Map<string, DsnPadPhysicalIdentity[]>()
	const seenIdentities = new Set<string>()
	for (const identity of identities) {
		const key = canonicalIdentity(identity); if (!key) { unknowns.push({ sourceIdentity: identity, reason: 'source PAD identity is not canonical eN or has no component ID' }); continue }
		if (seenIdentities.has(key)) continue
		seenIdentities.add(key)
		const alias = `${identity.componentId}${identity.localPadId.slice(1)}`
		identityByAlias.set(alias, [...(identityByAlias.get(alias) ?? []), identity])
	}
	let parsed: ReturnType<typeof parseDsn>
	try { parsed = parseDsn(args.dsnText) }
	catch (error) { const reason = `DSN outer-pad parse failed: ${error instanceof Error ? error.message : String(error)}`; return { complete: false, selections: identities.map(sourceIdentity => ({ sourceIdentity, top: { state: 'unknown', reason }, bottom: { state: 'unknown', reason } })), unknowns: [...unknowns, { reason }] } }
	const identityMap = new Map<string, DsnPadPhysicalCandidate[]>()
	for (const candidate of args.candidates) {
		const key = canonicalIdentity(candidate)
		if (!key) { unknowns.push({ sourceIdentity: candidate, reason: 'candidate PAD identity is not canonical eN or has no component ID' }); continue }
		identityMap.set(key, [...(identityMap.get(key) ?? []), candidate])
	}
	for (const identity of identities) {
		const key = canonicalIdentity(identity); if (!key) continue
		const alias = `${identity.componentId}${identity.localPadId.slice(1)}`; const collision = identityByAlias.get(alias) ?? []
		const instanceId = alias; const pins = parsed.pinByName.get(instanceId) ?? []
		const reason = (text: string): DsnPadPhysicalFace => ({ state: 'unknown', reason: text })
		if (collision.length !== 1) { selections.push({ sourceIdentity: identity, top: reason('DSN identity alias collides across full component/local PAD identities'), bottom: reason('DSN identity alias collides across full component/local PAD identities') }); continue }
		if (pins.length !== 1) { selections.push({ sourceIdentity: identity, top: reason(`DSN image u1 must contain exactly one pin instance ${instanceId}`), bottom: reason(`DSN image u1 must contain exactly one pin instance ${instanceId}`) }); continue }
		const pin = pins[0]
		const stackName = pin.stackName
		const candidateSet = identityMap.get(key) ?? []; const validCandidates = candidateSet.filter(candidate => [candidate.centerMil?.[0], candidate.centerMil?.[1], candidate.rotationDegrees].every(Number.isFinite))
		if (!validCandidates.length) { selections.push({ sourceIdentity: identity, top: reason('source PAD has no valid full-precision shape candidate'), bottom: reason('source PAD has no valid full-precision shape candidate') }); continue }
		const centers = new Set(validCandidates.map(candidate => JSON.stringify(candidate.centerMil)))
		const rotations = new Set(validCandidates.map(candidate => candidate.rotationDegrees))
		if (centers.size !== 1 || rotations.size !== 1) { selections.push({ sourceIdentity: identity, top: reason('source PAD candidate centers or runtime rotations conflict'), bottom: reason('source PAD candidate centers or runtime rotations conflict') }); continue }
		const [centerX, centerY] = validCandidates[0].centerMil
		if (!isOnDsnGrid(pin.x) || !isOnDsnGrid(pin.y) || Math.abs(pin.x - centerX) > 0.005 + 8 * Number.EPSILON * Math.max(1, Math.abs(pin.x), Math.abs(centerX)) || Math.abs(pin.y - centerY) > 0.005 + 8 * Number.EPSILON * Math.max(1, Math.abs(pin.y), Math.abs(centerY))) {
			selections.push({ sourceIdentity: identity, top: reason('DSN image pin center differs from runtime center by more than half of the 0.01 mil grid'), bottom: reason('DSN image pin center differs from runtime center by more than half of the 0.01 mil grid') }); continue
		}
		const stacks = parsed.padstackByName.get(stackName) ?? []
		if (stacks.length !== 1) { selections.push({ sourceIdentity: identity, top: reason('DSN padstack definition is missing or duplicated'), bottom: reason('DSN padstack definition is missing or duplicated') }); continue }
		const stack = stacks[0]
		const selectFace = (layer: 'TopLayer' | 'BottomLayer'): DsnPadPhysicalFace => {
			const shapes = stack.filter(shape => shape.layer === layer)
			if (shapes.length !== 1) return reason(`DSN padstack must define exactly one ${layer} shape`)
			if (shapes[0].kind === 'unknown') return reason(`DSN ${layer} shape kind is unsupported`)
			const matches = validCandidates.flatMap(candidate => { const pattern = facePattern(shapes[0], candidate); return pattern ? [{ candidate, pattern }] : [] })
			const exactShapes = [...new Map(matches.map(match => [JSON.stringify([match.candidate.shape.padType, match.candidate.shape.widthMil, match.candidate.shape.heightMil, match.candidate.shape.radiusMil ?? 0]), match])).values()]
			if (exactShapes.length !== 1) return reason(exactShapes.length === 0 ? `DSN ${layer} shape does not match any complete source shape candidate` : `DSN ${layer} quantization matches multiple distinct exact source geometries`)
			const selected = exactShapes[0]
			return { state: 'selected', shape: selected.candidate.shape, sourceIdentity: { componentId: identity.componentId, localPadId: identity.localPadId }, dsn: { method: 'native-dsn-outer-shape-selection', evidence: 'dsn-export-derived', image: 'u1', pinName: instanceId, padstackName: stackName, layer, shapeKind: shapes[0].kind, shapeOrdinal: shapes[0].ordinal, pattern: selected.pattern, quantization: { gridMil: 0.01, halfStepMil: 0.005 }, ...parsed.metadata } }
		}
		selections.push({ sourceIdentity: identity, top: selectFace('TopLayer'), bottom: selectFace('BottomLayer') })
	}
	const complete = selections.every(item => item.top.state === 'selected' && item.bottom.state === 'selected') && unknowns.length === 0
	for (const item of selections) for (const face of [item.top, item.bottom]) if (face.state === 'unknown') unknowns.push({ sourceIdentity: item.sourceIdentity, reason: face.reason })
	return { complete, selections, unknowns }
}
