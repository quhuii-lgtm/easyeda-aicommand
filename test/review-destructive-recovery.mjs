import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pcbBundle = 'test/.review-destructive-recovery-pcb.mjs'
const schematicBundle = 'test/.review-destructive-recovery-schematic.mjs'
const sesBundle = 'test/.review-destructive-recovery-ses.mjs'
const realSes = readFileSync(resolve('test/fixtures/auto-route-real-v223.ses'), 'utf8')
try {
await Promise.all([
	build({ entryPoints: ['src/commands/pcb.ts'], outfile: pcbBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
	build({ entryPoints: ['src/commands/schematic.ts'], outfile: schematicBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
	build({ stdin: { contents: "export { parseAutoRouteSes, mapSesRoutes } from '../src/engine/autoRouteSes.ts'", resolveDir: resolve('test'), sourcefile: 'review-destructive-recovery-ses.ts' }, outfile: sesBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
])
const { pcbCommands } = await import(pathToFileURL(resolve(pcbBundle)).href)
const { schematicCommands } = await import(pathToFileURL(resolve(schematicBundle)).href)
const { parseAutoRouteSes, mapSesRoutes } = await import(pathToFileURL(resolve(sesBundle)).href)
const sesExpected = mapSesRoutes(parseAutoRouteSes(realSes), [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }])

const pcbStatus = pcbCommands.find(c => c.name === 'pcb.autoRouteStatus').handler
const pcbStart = pcbCommands.find(c => c.name === 'pcb.autoRouteStart').handler
const pcbStop = pcbCommands.find(c => c.name === 'pcb.autoRouteStop').handler
const dedupe = schematicCommands.find(c => c.name === 'schematic.dedupeWireNets').handler
async function freshPcbStatus(caseName) {
	const module = await import(`${pathToFileURL(resolve(pcbBundle)).href}?case=${encodeURIComponent(caseName)}`)
	return module.pcbCommands.find(c => c.name === 'pcb.autoRouteStatus').handler
}
async function freshPcbStart(caseName) {
	const module = await import(`${pathToFileURL(resolve(pcbBundle)).href}?case=${encodeURIComponent(caseName)}`)
	return module.pcbCommands.find(c => c.name === 'pcb.autoRouteStart').handler
}
async function freshDedupe(caseName) {
	const module = await import(`${pathToFileURL(resolve(schematicBundle)).href}?case=${encodeURIComponent(caseName)}`)
	return module.schematicCommands.find(c => c.name === 'schematic.dedupeWireNets').handler
}
const sourceFor = (uuid, extra = '') => `{"type":"DOCHEAD","id":"head"}||{"docType":"${uuid.startsWith('pcb') ? 'PCB' : 'SCH_PAGE'}","uuid":"${uuid}"}|\n${extra}`
const mutatedSource = uuid => sourceFor(uuid, '{"type":"NET","ticket":1,"id":"partial"}||{"name":"partial-net"}|\n')
let checks = 0
function check(condition, label) {
	assert.ok(condition, label)
	checks++
	console.log(`PASS  ${label}`)
}
async function expectReject(fn, label) {
	try { await fn() }
	catch (error) { check(true, label); return error }
	assert.fail(label)
}
function assertAutoRouteQueryOnly(result, jobId, label) {
	check(result.state === 'COMPLETED' && result.jobId === jobId, `R2 ${label}返回明确任务状态`)
	check(result.imported === false && result.autoImportEnabled === false, `R2 ${label}报告自动回灌已停用`)
	check(typeof result.note === 'string' && /停用|关闭|仅查询|不自动回灌/.test(result.note), `R2 ${label}包含停用说明`)
}

function makeStorage(options = {}) {
	const values = new Map()
	return {
		getExtensionUserConfig(key) {
			if (options.storageReadThrows)
				throw new Error('storage read failed')
			return values.get(key)
		},
		async setExtensionUserConfig(key, value) {
			if (options.storageWriteThrows)
				throw new Error('storage write failed')
			if (options.storageWriteFalse)
				return false
			values.set(key, value)
			return true
		},
		values,
	}
}

function makePcb(options = {}) {
	const uuid = options.uuid ?? `pcb-${Math.random().toString(36).slice(2)}`
	let focus = { documentType: 3, uuid }
	let focusCalls = 0
	let jobCounter = 0
	let restoreCalls = 0
	const events = []
	const storage = makeStorage(options)
	const state = {
		lines: [], vias: [], arcs: [], nextLine: 0,
	}
	if (options.realRoutes) {
		state.arcs.push({ id: 'old-arc', net: 'OLD_NET', layer: 1, widthMil: 8, start: { x: 10, y: 10 }, end: { x: 20, y: 10 }, angle: 90, locked: false, sourceData: { keep: 'old arc' } })
	}
	const routeRecordData = item => item.sourceData ?? { net: item.net, geometry: item }
	const pcbSource = () => {
		const rows = [
			{ type: 'DOCHEAD', id: 'head', data: { docType: 'PCB', uuid } },
			{ type: 'POURED', id: 'poured-1', data: { layer: 1, net: 'GND', polygon: [0, 0, 50, 0, 50, 50, 0, 50] } },
			...state.lines.map(item => ({ type: 'LINE', id: item.id, data: routeRecordData(item) })),
			...state.vias.map(item => ({ type: 'VIA', id: item.id, data: routeRecordData(item) })),
			...state.arcs.map(item => ({ type: 'ARC', id: item.id, data: routeRecordData(item) })),
		]
		return rows.map((row, index) => `${JSON.stringify({ type: row.type, ...(row.id ? { id: row.id } : {}), ticket: index + 1 })}||${JSON.stringify(row.data)}`).join('|\n')
	}
	const initialSource = options.initialSource ?? pcbSource()
	let currentSource = initialSource
	let releaseOutput
	const outputGate = options.waitOutput ? new Promise(resolve => { releaseOutput = resolve }) : Promise.resolve()
	const touch = () => { currentSource = mutatedSource(uuid) }
	const getters = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
	const lineObject = item => ({ ...getters({ PrimitiveId: item.id, Net: item.net, Layer: item.layer, LineWidth: item.widthMil, StartX: item.a.x, StartY: item.a.y, EndX: item.b.x, EndY: item.b.y, PrimitiveLock: Boolean(item.locked) }) })
	const viaObject = item => ({ ...getters({ PrimitiveId: item.id, Net: item.net, X: item.x, Y: item.y, Diameter: item.diameterMil, HoleDiameter: item.holeDiameterMil, ViaType: item.viaType === 'through' ? 0 : item.viaType ?? 0, PrimitiveLock: Boolean(item.locked) }) })
	const arcObject = item => ({ ...getters({ PrimitiveId: item.id, Net: item.net, Layer: item.layer, LineWidth: item.widthMil, StartX: item.start.x, StartY: item.start.y, EndX: item.end.x, EndY: item.end.y, ArcAngle: item.angle, PrimitiveLock: Boolean(item.locked) }) })
	const eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => {
			focusCalls++
			if (options.switchFocusOnGetCall === focusCalls)
				return { documentType: 3, uuid: `${uuid}-other` }
			return focus
		} },
		sys_Storage: storage,
		sys_FileManager: {
			getDocumentSource: async () => {
				if (options.sourceThrows && restoreCalls === 0)
					throw new Error('source read failed')
				return currentSource
			},
			setDocumentSource: async (source) => {
				restoreCalls++
				if (options.restoreMode === 'undefined')
					throw undefined
				if (options.restoreMode === 'throw')
					throw new Error('restore threw')
				if (options.restoreMode === 'false')
					return false
				if (options.restoreMode === 'focus')
					return true
				currentSource = options.restoreMode === 'wrong' ? sourceFor(`${uuid}-wrong`) : options.restoreMode === 'empty' ? '' : source
				return true
			},
		},
		sys_ClientUrl: { request: async (_url, _method) => {
			const isOutput = _url.endsWith('/output')
			if (isOutput) {
				events.push('output-start')
				if (options.waitOutput)
					await outputGate
			}
			const payload = _url.endsWith('/sessions/create')
				? { id: `session-${uuid}` }
					: _url.endsWith('/jobs/enqueue')
						? { id: `job-${uuid}-${++jobCounter}` }
					: isOutput
						? { data: Buffer.from(realSes, 'utf8').toString('base64'), filename: 'autoroute.ses' }
						: _url.endsWith('/system/status')
							? { status: 'ok' }
							: { state: 'COMPLETED', stage: 'done', output: { statistics: {} } }
			return {
				ok: true,
				json: async () => payload,
				text: async () => '',
			}
		} },
		pcb_ManufactureData: { getDsnFile: async () => new File(['dsn'], 'design.dsn') },
		pcb_Layer: { getAllLayers: async () => [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }] },
		pcb_Document: {
			startCalculatingRatline: async () => { events.push('ratline') },
			importAutoRouteSesFile: async () => {
				events.push('import')
				if (options.shiftFocusOnImport)
					focus = { documentType: 3, uuid: `${uuid}-other` }
				if (options.realRoutes) {
					if (options.importMode === 'false-no-touch') return false
					if (options.importMode === 'throw' || options.importMode === 'false') {
						touch()
						if (options.importMode === 'throw') throw new Error('import threw after partial change')
						return false
					}
					state.lines.push(...sesExpected.lines.map((item, index) => ({ ...item, id: `ses-line-${index + 1}`, locked: false })))
					state.vias.push(...sesExpected.vias.map((item, index) => ({ ...item, id: `ses-via-${index + 1}`, viaType: item.viaType ?? 0, locked: false })))
					currentSource = pcbSource()
				}
				else if (options.importMode === 'false-no-touch')
					return false
				else
					touch()
				if (options.importMode === 'throw')
					throw new Error('import threw after partial change')
				if (options.importMode === 'false')
					return false
				return true
			},
		},
		pcb_PrimitiveLine: {
			getAll: async () => state.lines.map(lineObject),
			getAllPrimitiveId: async () => state.lines.map(item => item.id),
			get: async id => state.lines.some(item => item.id === id) ? lineObject(state.lines.find(item => item.id === id)) : undefined,
			delete: async ids => { events.push(`delete-line:${ids.join(',')}`); touch(); state.lines = state.lines.filter(item => !ids.includes(item.id)); return true },
		},
		pcb_PrimitiveArc: {
			getAll: async () => state.arcs.map(arcObject),
			getAllPrimitiveId: async () => {
				if (options.arcThrows)
					throw new Error('arc enumeration failed')
				return ['old-arc']
			},
			delete: async ids => {
				events.push(`delete-arc:${ids.join(',')}`)
				if (options.arcMode === 'throw')
					throw new Error('arc delete threw after partial change')
				if (options.arcMode === 'false')
					return false
				state.arcs = state.arcs.filter(item => !ids.includes(item.id))
				currentSource = pcbSource()
				return true
			},
		},
		pcb_PrimitiveVia: {
			getAll: async () => state.vias.map(viaObject),
			getAllPrimitiveId: async () => state.vias.map(item => item.id),
			get: async id => state.vias.some(item => item.id === id) ? viaObject(state.vias.find(item => item.id === id)) : undefined,
			delete: async ids => { events.push(`delete-via:${ids.join(',')}`); touch(); state.vias = state.vias.filter(item => !ids.includes(item.id)); return true },
		},
		pcb_Drc: { check: async () => {
			events.push('drc')
			if (options.drcThrows)
				throw new Error('DRC failed')
			return []
		} },
	}
	return { eda, events, storage, initialSource, releaseOutput, state, get source() { return currentSource }, get restoreCalls() { return restoreCalls }, setImportMode: value => { options.importMode = value }, focusBack: () => { focus = { documentType: 3, uuid } } }
}

function makeSchematic(options = {}) {
	const uuid = options.uuid ?? `sch-${Math.random().toString(36).slice(2)}`
	let focus = { documentType: 1, uuid }
	let focusCalls = 0
	let restoreCalls = 0
	let createCount = 0
	const events = []
	const storage = makeStorage(options)
	const oldWires = (options.wireLines ?? [options.diagonalOnly ? [0, 0, 10, 10] : [0, 0, 10, 0, 20, 0]]).map((line, index) => ({
		id: index === 0 ? 'old-wire' : `old-wire-${index + 1}`,
		line,
		net: undefined,
		color: '#000000',
		lineWidth: 6,
		lineType: 0,
		getState_PrimitiveId() { return this.id },
		getState_Line() { return this.line },
		getState_Net() { return this.net },
		getState_Color() { return this.color },
		getState_LineWidth() { return this.lineWidth },
		getState_LineType() { return this.lineType },
	}))
	let wires = options.duplicate === false ? [] : oldWires
	const sourceFromWires = values => {
		const rows = []
		let ticket = 1
		for (const wire of values) {
			rows.push(`${JSON.stringify({ type: 'WIRE', id: wire.id, ticket: ticket++ })}||${JSON.stringify({ line: wire.line })}|`)
			for (let index = 0; index + 3 < wire.line.length; index += 2) {
				const [startX, startY, endX, endY] = wire.line.slice(index, index + 4)
				if (options.omitCreatedLines && String(wire.id).startsWith('new-wire-')) continue
				const lineStyle = options.sourceLineStyles?.[wire.id]?.[index / 2] ?? { color: wire.color, width: wire.lineWidth, type: wire.lineType }
				rows.push(`${JSON.stringify({ type: 'LINE', id: `line-${wire.id}-${index / 2}`, ticket: ticket++ })}||${JSON.stringify({ lineGroup: wire.id, startX, startY: -startY, endX, endY: -endY, strokeColor: lineStyle.color, strokeWidth: lineStyle.width, strokeStyle: ({ 0: 'SOLID', 1: 'SHORT_DASH', 2: 'DOT' })[lineStyle.type] ?? null })}|`)
			}
			const attrs = String(wire.id).startsWith('new-wire-')
				? options.createdNetAttrs ?? [{ key: 'Name', value: wire.net }]
				: options.netAttrsByWire?.[wire.id] ?? options.netAttrs ?? [{ key: 'NET', value: 'N1' }, { key: 'NET', value: 'N1' }]
			for (const [index, attr] of attrs.entries())
				rows.push(`${JSON.stringify({ type: 'ATTR', id: `attr-${wire.id}-${index}`, ticket: ticket++ })}||${JSON.stringify({ parentId: wire.id, key: attr.key, value: attr.value })}|`)
		}
		return sourceFor(uuid, rows.join('\n'))
	}
	const initialSource = sourceFromWires(wires)
	let currentSource = options.initialSource ?? initialSource
	const resetSource = source => {
		currentSource = source
		if (source === initialSource)
			wires = options.duplicate === false ? [] : oldWires
	}
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => {
			focusCalls++
			if (options.switchFocusOnGetCall === focusCalls) {
				focus = { documentType: 1, uuid: `${uuid}-other` }
				if (options.switchSourceWithFocus)
					currentSource = sourceFor(focus.uuid)
			}
			return focus
		} },
		sys_Storage: storage,
		sys_FileManager: {
			getDocumentSource: async () => {
				if (options.sourceThrows && restoreCalls === 0)
					throw new Error('source read failed')
				return currentSource
			},
			setDocumentSource: async (source) => {
				restoreCalls++
				if (options.restoreMode === 'undefined')
					throw undefined
				if (options.restoreMode === 'throw')
					throw new Error('restore threw')
				if (options.restoreMode === 'false')
					return false
				if (options.restoreMode === 'focus')
					return true
				resetSource(options.restoreMode === 'wrong' ? sourceFor(`${uuid}-wrong`) : options.restoreMode === 'empty' ? '' : source)
				return true
			},
		},
		sch_PrimitiveWire: {
			getAll: async () => {
				if (options.switchFocusOnFinalRead && createCount > 0) {
					focus = { documentType: 1, uuid: `${uuid}-other` }
					return []
				}
				if (options.emptyFinalRead && createCount > 0)
					return []
				return wires
			},
			delete: async ids => {
				events.push(`delete:${(Array.isArray(ids) ? ids : [ids]).map(x => typeof x === 'string' ? x : x?.getState_PrimitiveId?.()).join(',')}`)
				if (options.deleteMode === 'throw')
					{ currentSource = mutatedSource(uuid); throw new Error('wire delete threw after partial change') }
				if (options.deleteMode === 'false')
					return false
				const remove = new Set((Array.isArray(ids) ? ids : [ids]).map(x => typeof x === 'string' ? x : x?.getState_PrimitiveId?.()))
				wires = wires.filter(w => !remove.has(w.id))
				currentSource = sourceFromWires(wires)
				return true
			},
			create: async (line, net, color = '#000000', lineWidth = 6, lineType = 0) => {
				createCount++
				events.push(`create:${createCount}`)
				events.push(`create-line:${JSON.stringify(line)}:net=${net}`)
				if (options.createMode === 'throw' && createCount === 2)
					{ currentSource = mutatedSource(uuid); throw new Error('second create threw after merge') }
				if (options.createMode === 'empty' && createCount === 2)
					return undefined
				const id = options.missingCreatedId && createCount === 1 ? '' : `new-wire-${createCount}`
				const wire = { id, line, net: Object.hasOwn(options, 'createdNet') ? options.createdNet : net, color, lineWidth, lineType,
					getState_PrimitiveId() { return this.id }, getState_Line() { return this.line }, getState_Net() { return this.net },
					getState_Color() { return this.color }, getState_LineWidth() { return this.lineWidth }, getState_LineType() { return this.lineType },
				}
				wires.push(wire)
				currentSource = sourceFromWires(wires)
				return wire
			},
			get: async id => {
				events.push(`get:${id}`)
				if (options.switchFocusOnGet)
					focus = { documentType: 1, uuid: `${uuid}-other` }
				if (options.getMode === 'throw')
					throw new Error('wire get failed')
				if (options.getMode === 'missing')
					return undefined
				return wires.find(w => w.getState_PrimitiveId() === id)
			},
			modify: async id => {
				events.push(`modify:${id}`)
				if (options.modifyMode === 'throw')
					throw new Error('wire naming threw')
				if (options.modifyMode === 'false')
					return undefined
				return wires.find(w => w.getState_PrimitiveId() === id)
			},
		},
		sch_PrimitiveAttribute: { getAll: async id => {
			events.push(`attributes:${id}`)
			if (options.attributeReadThrows)
				throw new Error('attribute read failed')
			if (String(id).startsWith('new-wire-') && options.readbackAttributeReadThrows)
				throw new Error('readback attribute read failed')
			const created = String(id).startsWith('new-wire-')
			const createdWire = created ? wires.find(w => w.getState_PrimitiveId() === id) : undefined
			const attrs = created
				? options.createdNetAttrs ?? [{ key: 'Name', value: createdWire?.getState_Net() }]
				: options.netAttrsByWire?.[id] ?? options.netAttrs ?? [{ key: 'NET', value: 'N1' }, { key: 'NET', value: 'N1' }]
			return attrs.map(attr => ({
				getState_Key: () => {
					if (attr.keyReadThrows)
						throw new Error('attribute key read failed')
					return attr.key
				},
				getState_Value: () => {
					if (attr.valueReadThrows)
						throw new Error('attribute value read failed')
					return attr.value
				},
			}))
		} },
	}
	return { eda, events, storage, initialSource, get source() { return currentSource }, get restoreCalls() { return restoreCalls }, get createCount() { return createCount } }
}

{
	const sch = makeSchematic({ sourceLineStyles: { 'old-wire': [{ color: '#000000', width: 6, type: 0 }, { color: '#FF0000', width: 6, type: 0 }] } }); globalThis.eda = sch.eda
	const error = await expectReject(() => dedupe(), 'R3 混合线型写前拒绝')
	assert.equal(sch.events.some(event => event.startsWith('delete:') || event.startsWith('create:')), false, 'mixed source styles are rejected before destructive writes')
	assert.match(error.message, /混合颜色\/线宽\/线型/)
}

{
	const sch = makeSchematic({ wireLines: [[0, 0, 10, 10]] }); globalThis.eda = sch.eda
	const error = await expectReject(() => dedupe(), 'R3 真实斜 LINE 写前拒绝')
	assert.match(error.message, /真实斜 LINE/)
	assert.equal(sch.events.some(event => event.startsWith('delete:') || event.startsWith('create:')), false)
}

async function runPcb(options = {}) {
	const mock = makePcb(options)
	globalThis.eda = mock.eda
	const result = await pcbStatus({ jobId: options.jobId ?? `job-${Math.random().toString(36).slice(2)}` })
	return { ...mock, result }
}
async function runDedupe(options = {}) {
	const mock = makeSchematic(options)
	globalThis.eda = mock.eda
	const result = await dedupe()
	return { ...mock, result }
}

// Empty or failed source snapshots must stop before either command mutates the page.
for (const [label, opts] of [['empty', { initialSource: '' }], ['throw', { sourceThrows: true }]]) {
	const pcb = makePcb(opts); globalThis.eda = pcb.eda
	const result = await pcbStatus({ jobId: `pcb-snapshot-${label}`, noImport: false })
	assertAutoRouteQueryOnly(result, `pcb-snapshot-${label}`, `${label}源码查询`)
	check(!pcb.events.some(e => e === 'output-start' || e.startsWith('delete-') || e === 'import') && pcb.restoreCalls === 0, `R2 ${label}状态查询不读取输出、不读写板级源码`)
	const sch = makeSchematic(opts); globalThis.eda = sch.eda
	await expectReject(() => dedupe(), `R3 快照${label}时拒绝并保持零删除/创建`)
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), `R3 快照${label}不调用破坏接口`)
}

// Dedupe must recognize both supported wire network-attribute names and reject ambiguity before writes.
for (const [label, netAttrs] of [
	['Name+Name', [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'Name', value: 'RECOVERY_A' }]],
	['NET+Name', [{ key: 'NET', value: 'RECOVERY_A' }, { key: 'Name', value: 'RECOVERY_A' }]],
]) {
	const sch = await runDedupe({ netAttrs })
	check(sch.result.dupWires === 1 && sch.events.some(e => e === 'delete:old-wire'), `R3 ${label}同名属性识别重复导线`)
}
{
	const attrs = [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'Name', value: 'RECOVERY_A' }]
	for (const [label, line] of [['straight', [0, 0, 20, 0]], ['L', [0, 0, 10, 0, 10, 10]]]) {
		const sch = await runDedupe({ netAttrs: attrs, wireLines: [line] })
		check(sch.result.rebuilt === 1 && sch.result.renamed === 0, `R3 ${label}按原导线一次带名重建`)
		const expectedCreate = label === 'straight'
			? 'create-line:[0,0,20,0]:net=RECOVERY_A'
			: 'create-line:[0,0,10,0,10,0,10,10]:net=RECOVERY_A'
		check(sch.events.filter(e => e.startsWith('create:')).length === 1 && sch.events.includes(expectedCreate), `R3 ${label}单次create保留目标网络与线段`)
		check(sch.events.includes('get:new-wire-1') && sch.events.includes('attributes:new-wire-1'), `R3 ${label}按create返回ID立即读回线与属性`)
	}
}
{
	const sch = await runDedupe({ wireLines: [[0, 0, 10, 0], [100, 0, 110, 0]] })
	check(sch.result.dupWires === 2 && sch.result.rebuilt === 2, 'R3 同网但断开的两根原导线分别计数重建')
	check(sch.events.filter(e => e.startsWith('create:')).length === 2
		&& sch.events.includes('create-line:[0,0,10,0]:net=N1')
		&& sch.events.includes('create-line:[100,0,110,0]:net=N1'), 'R3 同网断线不合并为一根导线')
}
for (const [label, options, expectedValues] of [
	['conflict', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'Name', value: 'RECOVERY_B' }] }, 'values=["RECOVERY_A","RECOVERY_B"]'],
	['case-conflict', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'Name', value: 'recovery_a' }] }, 'values=["RECOVERY_A","recovery_a"]'],
	['whitespace-conflict', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'Name', value: ' RECOVERY_A' }] }, 'values=["RECOVERY_A"," RECOVERY_A"]'],
	['empty', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'NET', value: '' }] }, 'values=["RECOVERY_A",""]'],
	['attribute-read', { attributeReadThrows: true }, 'values=[]'],
	['key-read', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A', keyReadThrows: true }, { key: 'Name', value: 'RECOVERY_A' }] }, 'values=[]'],
	['value-read', { netAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'NET', value: 'RECOVERY_A', valueReadThrows: true }] }, 'values=["RECOVERY_A"]'],
]) {
	const sch = makeSchematic(options); globalThis.eda = sch.eda
	const error = await expectReject(() => dedupe(), `R3 ${label}属性拒绝并在删除前停止`)
	check(error.message.includes('old-wire') && error.message.includes(expectedValues), `R3 ${label}错误含导线ID和原始属性值`)
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), `R3 ${label}拒绝时零删除/创建`)
}

// Moving focus between snapshot and first write must never target the other page.
{
	const pcb = makePcb({ switchFocusOnGetCall: 6 }); globalThis.eda = pcb.eda
	const result = await pcbStatus({ jobId: 'pcb-focus-before-write', noImport: true })
	assertAutoRouteQueryOnly(result, 'pcb-focus-before-write', '状态查询不依赖焦点')
	check(!pcb.events.some(e => e === 'output-start' || e.startsWith('delete-') || e === 'import') && pcb.restoreCalls === 0, 'R2 状态查询零 SES 输出、板级读取与写入')
	const sch = makeSchematic({ switchFocusOnGetCall: 2 }); globalThis.eda = sch.eda
	await expectReject(() => dedupe(), 'R3 枚举期间焦点变化被拒绝')
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), 'R3 写前换焦点时零删除/创建')
}

// Arc enumeration failure is a preflight error, never an empty-list fallback.
{
	const pcb = makePcb({ arcThrows: true }); globalThis.eda = pcb.eda
	const result = await pcbStatus({ jobId: 'pcb-arc-enum-fails', noImport: false })
	assertAutoRouteQueryOnly(result, 'pcb-arc-enum-fails', '状态查询不枚举圆弧')
	check(!pcb.events.some(e => e === 'output-start' || e.startsWith('delete-') || e === 'import') && pcb.restoreCalls === 0, 'R2 圆弧接口异常不影响只读任务状态')
}

// NoImport is accepted for compatibility; all values perform identical status-only queries.
for (const [label, noImport] of [['omitted', undefined], ['true', true], ['false', false]]) {
	const pcb = makePcb({ uuid: `pcb-no-import-${label}` }); globalThis.eda = pcb.eda
	const start = await freshPcbStart(`no-import-${label}`), status = await freshPcbStatus(`no-import-${label}`)
	const jobId = (await start({ skipDrc: true })).jobId
	const eventsBefore = pcb.events.length
	const result = await status({ jobId, ...(noImport === undefined ? {} : { noImport }) })
	assertAutoRouteQueryOnly(result, jobId, `noImport=${String(noImport)}`)
	check(!pcb.events.slice(eventsBefore).some(event => event === 'output-start' || event === 'import' || event.startsWith('delete-') || event === 'drc'), `R2 noImport=${String(noImport)}不取输出、不写入、不运行DRC`)
	check(pcb.restoreCalls === 0 && pcb.source === pcb.initialSource, `R2 noImport=${String(noImport)}不改写源码`)
	const repeated = await status({ jobId })
	assertAutoRouteQueryOnly(repeated, jobId, `noImport=${String(noImport)}显式重复查询`)
}

// COMPLETED releases the matching default slot without consuming explicit lookup of that job.
{
	const pcb = makePcb({ uuid: 'pcb-default-slot-status' }); globalThis.eda = pcb.eda
	const start = await freshPcbStart('default-slot-status'), status = await freshPcbStatus('default-slot-status')
	const first = await start({ skipDrc: true })
	assertAutoRouteQueryOnly(await status({ noImport: true }), first.jobId, '默认job完成查询')
	const second = await start({ skipDrc: true })
	check(second.jobId !== first.jobId, 'R2 COMPLETED 查询释放默认 job slot')
	assertAutoRouteQueryOnly(await status({ jobId: first.jobId, noImport: false }), first.jobId, 'slot释放后显式旧job查询')
	check(pcb.restoreCalls === 0 && pcb.source === pcb.initialSource && !pcb.events.some(event => event === 'output-start' || event === 'import' || event.startsWith('delete-') || event === 'drc'), 'R2 默认与显式查询均无板级副作用')
}

for (const [label, opts] of [
	['second-create-empty', { createMode: 'empty' }],
	['second-create-throw', { createMode: 'throw' }],
	['missing-created-id', { missingCreatedId: true }],
	['delete-false', { deleteMode: 'false' }],
	['delete-throw', { deleteMode: 'throw' }],
]) {
	// Two original wires ensure second-create failure occurs after one replacement was created.
	if (label.startsWith('second-create-')) {
		const twoWireMock = makeSchematic({ ...opts, wireLines: [[0, 0, 10, 0], [100, 0, 110, 0]] })
		globalThis.eda = twoWireMock.eda
		const error = await expectReject(() => dedupe(), `R3 ${label}恢复后明确报错`)
		check(error.cause?.restored === true && error.cause?.retryable === true, `R3 ${label}错误含 restored/retryable`)
		check(twoWireMock.source === twoWireMock.initialSource, `R3 ${label}整页源码精确恢复`)
		check(twoWireMock.events.filter(e => e.startsWith('delete:')).length === 1 && !twoWireMock.events.some(e => e.startsWith('delete:new-wire')), `R3 ${label}不按新ID逐条回滚`)
		continue
	}
	const sch = makeSchematic(opts); globalThis.eda = sch.eda
	const error = await expectReject(() => dedupe(), `R3 ${label}恢复后明确报错`)
	check(error.cause?.restored === true && error.cause?.retryable === true, `R3 ${label}错误含 restored/retryable`)
	check(sch.source === sch.initialSource, `R3 ${label}整页源码精确恢复`)
	check(sch.events.filter(e => e.startsWith('delete:')).length === 1 && !sch.events.some(e => e.startsWith('delete:new-wire')), `R3 ${label}不按新ID逐条回滚`)
}

// The selected page must still match the page whose duplicate wires were inspected.
{
	const sch = makeSchematic({ switchFocusOnGetCall: 3, switchSourceWithFocus: true })
	globalThis.eda = sch.eda
	await expectReject(() => dedupe(), 'R3 快照页与候选导线页不一致时拒绝')
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), 'R3 快照页变化时零删除/创建')
}

// Any create-ID readback mismatch must enter the full-document recovery path.
for (const [label, opts, causeKey] of [
	['missing-wire', { getMode: 'missing' }, 'restored'],
	['wire-read-throws', { getMode: 'throw' }, 'restored'],
	['focus-change', { switchFocusOnGet: true }, 'partial'],
	['wrong-net', { createdNet: 'RECOVERY_B' }, 'restored'],
	['object-without-line-readback', { omitCreatedLines: true }, 'restored'],
	['attribute-read-throws', { readbackAttributeReadThrows: true }, 'restored'],
	['missing-network-attribute', { createdNetAttrs: [] }, 'restored'],
	['duplicate-network-attributes', { createdNetAttrs: [{ key: 'Name', value: 'RECOVERY_A' }, { key: 'NET', value: 'RECOVERY_A' }] }, 'restored'],
	['wrong-network-attribute', { createdNetAttrs: [{ key: 'Name', value: 'RECOVERY_B' }] }, 'restored'],
]) {
	const sch = makeSchematic(opts)
	globalThis.eda = sch.eda
	const error = await expectReject(() => dedupe(), `R3 创建后读回${label}被拒绝成功`)
	check(causeKey === 'restored' ? error.cause?.restored === true : error.cause?.partial === true, `R3 创建后读回${label}进入恢复结果`)
	check(sch.source === sch.initialSource || error.cause?.recovery?.source === sch.initialSource, `R3 创建后读回${label}恢复原文或附原文凭据`)
}

// Inability to map any straight segment is rejected before deleting the original wire.
{
	const sch = makeSchematic({ diagonalOnly: true }); globalThis.eda = sch.eda
	await expectReject(() => dedupe(), 'R3 零可重建线段被拒绝')
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), 'R3 零线段候选保留原图')
}

// Schematic restoration failure variants preserve the original source in error.cause.
for (const mode of ['false', 'throw', 'undefined', 'wrong', 'empty', 'focus']) {
	const sch = makeSchematic({
		createMode: 'empty', restoreMode: mode,
		wireLines: [[0, 0, 10, 0], [100, 0, 110, 0]],
	})
	if (mode === 'focus') {
		const originalCreate = sch.eda.sch_PrimitiveWire.create
		sch.eda.sch_PrimitiveWire.create = async (...args) => {
			const result = await originalCreate(...args)
			// Force the next focused write/read check to observe the other page.
			sch.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ documentType: 1, uuid: 'other-page' })
			return result
		}
	}
	globalThis.eda = sch.eda
	const isolatedDedupe = await freshDedupe(`restore-${mode}`)
	const error = await expectReject(() => isolatedDedupe(), `R3 恢复${mode}返回 partial`)
	check(error.cause?.partial === true && error.cause?.restored === false && error.cause?.retryable === false, `R3 恢复${mode}标记 partial`)
	check(error.cause?.recovery?.documentUuid && error.cause?.recovery?.storageKey && error.cause?.recovery?.source === sch.initialSource, `R3 恢复${mode}附完整凭据`)
}

console.log(`\n${checks} 项通过`)
}
finally {
	await Promise.all([rm(resolve(pcbBundle), { force: true }), rm(resolve(schematicBundle), { force: true }), rm(resolve(sesBundle), { force: true })])
}
