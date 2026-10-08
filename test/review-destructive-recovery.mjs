import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const pcbBundle = 'test/.review-destructive-recovery-pcb.mjs'
const schematicBundle = 'test/.review-destructive-recovery-schematic.mjs'
try {
await Promise.all([
	build({ entryPoints: ['src/commands/pcb.ts'], outfile: pcbBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
	build({ entryPoints: ['src/commands/schematic.ts'], outfile: schematicBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
])
const { pcbCommands } = await import(pathToFileURL(resolve(pcbBundle)).href)
const { schematicCommands } = await import(pathToFileURL(resolve(schematicBundle)).href)

const pcbStatus = pcbCommands.find(c => c.name === 'pcb.autoRouteStatus').handler
const dedupe = schematicCommands.find(c => c.name === 'schematic.dedupeWireNets').handler
async function freshPcbStatus(caseName) {
	const module = await import(`${pathToFileURL(resolve(pcbBundle)).href}?case=${encodeURIComponent(caseName)}`)
	return module.pcbCommands.find(c => c.name === 'pcb.autoRouteStatus').handler
}
async function freshDedupe(caseName) {
	const module = await import(`${pathToFileURL(resolve(schematicBundle)).href}?case=${encodeURIComponent(caseName)}`)
	return module.schematicCommands.find(c => c.name === 'schematic.dedupeWireNets').handler
}
const sourceFor = (uuid, extra = '') => `{"type":"DOCHEAD","id":"head"}||{"docType":"${uuid.startsWith('pcb') ? 'PCB' : 'SCH'}","uuid":"${uuid}"}|\n${extra}`
const mutatedSource = uuid => sourceFor(uuid, '{"type":"NET","id":"partial"}||{}|\n')
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
	const initialSource = sourceFor(uuid)
	let currentSource = options.initialSource ?? initialSource
	let focus = { documentType: 3, uuid }
	let focusCalls = 0
	let restoreCalls = 0
	const events = []
	const storage = makeStorage(options)
	let releaseOutput
	const outputGate = options.waitOutput ? new Promise(resolve => { releaseOutput = resolve }) : Promise.resolve()
	const touch = () => { currentSource = mutatedSource(uuid) }
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
			return {
				ok: true,
				json: async () => isOutput
					? { data: btoa('(session pcb\n  (base_design demo))'), filename: 'autoroute.ses' }
					: { state: 'COMPLETED', stage: 'done', output: { statistics: {} } },
				text: async () => '',
			}
		} },
		pcb_Document: {
			startCalculatingRatline: async () => { events.push('ratline') },
			importAutoRouteSesFile: async () => {
				events.push('import')
				touch()
				if (options.shiftFocusOnImport)
					focus = { documentType: 3, uuid: `${uuid}-other` }
				if (options.importMode === 'throw')
					throw new Error('import threw after partial change')
				if (options.importMode === 'false')
					return false
				return true
			},
		},
		pcb_PrimitiveLine: {
			getAllPrimitiveId: async () => ['old-line'],
			delete: async ids => { events.push(`delete-line:${ids.join(',')}`); touch(); return true },
		},
		pcb_PrimitiveArc: {
			getAllPrimitiveId: async () => {
				if (options.arcThrows)
					throw new Error('arc enumeration failed')
				return ['old-arc']
			},
			delete: async ids => {
				events.push(`delete-arc:${ids.join(',')}`)
				touch()
				if (options.arcMode === 'throw')
					throw new Error('arc delete threw after partial change')
				if (options.arcMode === 'false')
					return false
				return true
			},
		},
		pcb_PrimitiveVia: {
			getAllPrimitiveId: async () => ['old-via'],
			delete: async ids => { events.push(`delete-via:${ids.join(',')}`); touch(); return true },
		},
		pcb_Drc: { check: async () => {
			events.push('drc')
			if (options.drcThrows)
				throw new Error('DRC failed')
			return []
		} },
	}
	return { eda, events, storage, initialSource, releaseOutput, get source() { return currentSource }, get restoreCalls() { return restoreCalls } }
}

function makeSchematic(options = {}) {
	const uuid = options.uuid ?? `sch-${Math.random().toString(36).slice(2)}`
	const initialSource = sourceFor(uuid)
	let currentSource = options.initialSource ?? initialSource
	let focus = { documentType: 1, uuid }
	let focusCalls = 0
	let restoreCalls = 0
	let createCount = 0
	const events = []
	const storage = makeStorage(options)
	const oldWires = (options.wireLines ?? [options.diagonalOnly ? [0, 0, 10, 10] : [0, 0, 10, 0, 20, 0]]).map((line, index) => ({
		getState_PrimitiveId: () => index === 0 ? 'old-wire' : `old-wire-${index + 1}`,
		getState_Line: () => line,
		getState_Net: () => undefined,
	}))
	let wires = options.duplicate === false ? [] : oldWires
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
				currentSource = mutatedSource(uuid)
				if (options.deleteMode === 'throw')
					throw new Error('wire delete threw after partial change')
				if (options.deleteMode === 'false')
					return false
				wires = []
				return true
			},
			create: async (line, net) => {
				createCount++
				events.push(`create:${createCount}`)
				events.push(`create-line:${JSON.stringify(line)}:net=${net}`)
				currentSource = mutatedSource(uuid)
				if (options.createMode === 'throw' && createCount === 2)
					throw new Error('second create threw after merge')
				if (options.createMode === 'empty' && createCount === 2)
					return undefined
				const id = options.missingCreatedId && createCount === 1 ? '' : `new-wire-${createCount}`
				const wire = {
					getState_PrimitiveId: () => id,
					getState_Line: () => line,
					getState_Net: () => Object.hasOwn(options, 'createdNet') ? options.createdNet : net,
				}
				wires.push(wire)
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
	await expectReject(() => pcbStatus({ jobId: `pcb-snapshot-${label}` }), `R2 快照${label}时拒绝并保持零删除/导入`)
	check(!pcb.events.some(e => e.startsWith('delete-') || e === 'import'), `R2 快照${label}不调用破坏接口`)
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
			? 'create-line:[[0,0,20,0]]:net=RECOVERY_A'
			: 'create-line:[[0,0,10,0],[10,0,10,10]]:net=RECOVERY_A'
		check(sch.events.filter(e => e.startsWith('create:')).length === 1 && sch.events.includes(expectedCreate), `R3 ${label}单次create保留目标网络与线段`)
		check(sch.events.includes('get:new-wire-1') && sch.events.includes('attributes:new-wire-1'), `R3 ${label}按create返回ID立即读回线与属性`)
	}
}
{
	const sch = await runDedupe({ wireLines: [[0, 0, 10, 0], [100, 0, 110, 0]] })
	check(sch.result.dupWires === 2 && sch.result.rebuilt === 2, 'R3 同网但断开的两根原导线分别计数重建')
	check(sch.events.filter(e => e.startsWith('create:')).length === 2
		&& sch.events.includes('create-line:[[0,0,10,0]]:net=N1')
		&& sch.events.includes('create-line:[[100,0,110,0]]:net=N1'), 'R3 同网断线不合并为一根导线')
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
	await expectReject(() => pcbStatus({ jobId: 'pcb-focus-before-write' }), 'R2 写前焦点变化被拒绝')
	check(!pcb.events.some(e => e.startsWith('delete-') || e === 'import'), 'R2 写前换焦点时零删除/导入')
	const sch = makeSchematic({ switchFocusOnGetCall: 2 }); globalThis.eda = sch.eda
	await expectReject(() => dedupe(), 'R3 枚举期间焦点变化被拒绝')
	check(!sch.events.some(e => e.startsWith('delete:') || e.startsWith('create:')), 'R3 写前换焦点时零删除/创建')
}

// Arc enumeration failure is a preflight error, never an empty-list fallback.
{
	const pcb = makePcb({ arcThrows: true }); globalThis.eda = pcb.eda
	await expectReject(() => pcbStatus({ jobId: 'pcb-arc-enum-fails' }), 'R2 圆弧枚举失败向上报告')
	check(!pcb.events.some(e => e.startsWith('delete-') || e === 'import'), 'R2 圆弧枚举失败时零删除/导入')
}

// Every partial clear, failed import, and schematic rebuild failure restores the whole source.
for (const [label, opts] of [
	['arc-false', { arcMode: 'false' }],
	['arc-throw', { arcMode: 'throw' }],
	['import-false', { importMode: 'false' }],
	['import-throw', { importMode: 'throw' }],
]) {
	const pcb = makePcb(opts); globalThis.eda = pcb.eda
	const error = await expectReject(() => pcbStatus({ jobId: `pcb-${label}` }), `R2 ${label}恢复后仍明确报错`)
	check(error.cause?.restored === true && error.cause?.retryable === true, `R2 ${label}错误含 restored/retryable`)
	check(pcb.source === pcb.initialSource, `R2 ${label}整页源码精确恢复`)
}

// A safely restored job can be retried; a committed job never clears twice, even if DRC throws.
{
	const jobId = 'pcb-retry-after-restore'
	const mock = makePcb({ importMode: 'false', jobId }); globalThis.eda = mock.eda
	const first = await expectReject(() => pcbStatus({ jobId }), 'R2 回灌失败恢复后保留业务失败')
	check(first.cause?.restored === true, 'R2 同一job恢复成功可重试')
	mock.eda.pcb_Document.importAutoRouteSesFile = async () => { mock.events.push('import'); return true }
	const second = await pcbStatus({ jobId })
	check(second.imported === true, 'R2 恢复后的同一job重试成功')
}
{
	const jobId = 'pcb-applied-once'
	const mock = makePcb({ drcThrows: true }); globalThis.eda = mock.eda
	const first = await pcbStatus({ jobId })
	check(first.imported === true && mock.events.filter(e => e === 'import').length === 1, 'R2 DRC异常不撤销成功导入')
	const second = await pcbStatus({ jobId })
	check(second.imported === false && mock.events.filter(e => e.startsWith('delete-') || e === 'import').length === 4, 'R2 成功任务重复查询不再清线或导入')
}

// A completed job is reserved synchronously before the output request can await.
{
	const isolatedPcbStatus = await freshPcbStatus('concurrent-status')
	const mock = makePcb({ waitOutput: true, uuid: 'pcb-parallel-status' })
	globalThis.eda = mock.eda
	const first = isolatedPcbStatus({ jobId: 'pcb-parallel-job' })
	while (!mock.events.includes('output-start'))
		await new Promise(resolve => setImmediate(resolve))
	await expectReject(() => isolatedPcbStatus({ jobId: 'pcb-parallel-job' }), 'R2 同job并发状态查询被 applying 拒绝')
	check(mock.storage.values.size === 0 && !mock.events.some(e => e.startsWith('delete-') || e === 'import'), 'R2 并发第二次查询零新增快照/删除/导入')
	mock.releaseOutput()
	const result = await first
	check(result.imported === true && mock.events.filter(e => e === 'import').length === 1, 'R2 并发查询最终只成功导入一次')
}

// Failed restore variants must expose the complete recovery credential and never delete new IDs.
for (const mode of ['false', 'throw', 'undefined', 'wrong', 'empty', 'focus']) {
	const pcb = makePcb({ importMode: 'false', restoreMode: mode, shiftFocusOnImport: mode === 'focus' })
	globalThis.eda = pcb.eda
	const isolatedPcbStatus = await freshPcbStatus(`restore-${mode}`)
	const error = await expectReject(() => isolatedPcbStatus({ jobId: `pcb-restore-${mode}` }), `R2 恢复${mode}返回 partial`)
	check(error.cause?.partial === true && error.cause?.restored === false && error.cause?.retryable === false, `R2 恢复${mode}标记 partial`)
	check(error.cause?.recovery?.documentUuid && error.cause?.recovery?.storageKey && error.cause?.recovery?.source === pcb.initialSource, `R2 恢复${mode}附完整凭据`)
	const eventCount = pcb.events.filter(e => e.startsWith('delete-') || e === 'import').length
	await expectReject(() => isolatedPcbStatus({ jobId: `pcb-restore-${mode}` }), `R2 恢复${mode}后阻止同job再次清线`)
	check(pcb.events.filter(e => e.startsWith('delete-') || e === 'import').length === eventCount, `R2 恢复${mode}不重复写入`)
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
	await Promise.all([rm(resolve(pcbBundle), { force: true }), rm(resolve(schematicBundle), { force: true })])
}
