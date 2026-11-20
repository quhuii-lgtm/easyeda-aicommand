import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const result = await build({
	entryPoints: ['src/commands/copperKeepouts.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
const { copperKeepoutCommands } = await import(moduleUrl)
const planCommand = copperKeepoutCommands.find(command => command.name === 'pcb.planCopperKeepouts')
const applyCommand = copperKeepoutCommands.find(command => command.name === 'pcb.applyCopperKeepouts')
assert.ok(planCommand && applyCommand)

const uuid = 'test-pcb-keepouts'
const context = {
	documentTarget: { documentType: 3, uuid, tabId: 1 },
	async assertDocumentTarget() {},
}
const pathFor = (x, y, width, height) => [x, y, 'L', x + width, y, 'L', x + width, y + height, 'L', x, y + height, 'L', x, y]

function serialize(record) {
	return `${JSON.stringify(record.header)}||${JSON.stringify(record.data)}`
}

function makeBoard(nets = ['3V3', 'GND']) {
	let source = serialize({
		header: { type: 'DOCHEAD', id: 'HEAD', ticket: 1 },
		data: { docType: 'PCB', uuid, client: 'test', version: '1' },
	})
	const pours = []
	for (let index = 0; index < nets.length; index++) {
		const net = nets[index]
		const id = `pour-${index}`
		const path = pathFor(index * 400, 0, 20, 8.6) // 200 x 86 mil
		pours.push({ id, net, path, layer: index === 0 ? 1 : 2 })
		source += `|\n${serialize({ header: { type: 'POUR', id, ticket: index + 2 }, data: { netName: net, layerId: index === 0 ? 1 : 2, path, pourType: { pourType: 'SOLID', fineness: 5 } } })}`
		source += `|\n${serialize({ header: { type: 'POURED', id: JSON.stringify(['POURED', id]), ticket: index + 20 }, data: { pourFill: [{ id: `fill-${index}`, fill: true, strokeWidth: 0, path }] } })}`
	}
	const poursById = new Map(pours.map(pour => [pour.id, pour]))
	const regions = new Map()
	let createCount = 0
	let failCreateAt = -1
	let getAllCount = 0
	let changeOnGetAll = -1

	function sourceRecordForRegion(item) {
		return { header: { type: 'REGION', id: item.id, ticket: 100 + createCount }, data: { layerId: item.layer, path: item.path, ruleType: item.ruleType, primitiveLock: item.primitiveLock } }
	}

	function regionObject(item) {
		return {
			getState_PrimitiveId: () => item.id,
			getState_Layer: () => item.layer,
			getState_RuleType: () => item.ruleType,
			getState_LineWidth: () => item.lineWidth ?? 1,
			getState_ComplexPolygon: () => ({ getSource: () => item.path }),
			getState_PrimitiveLock: () => item.primitiveLock,
		}
	}

	const sdk = {
		sys_FileManager: { async getDocumentSource() { return source } },
		pcb_Layer: { async getAllLayers() { return [{ id: 1 }, { id: 2 }] } },
		pcb_MathPolygon: { createPolygon(polygonSource) { return { getSource: () => polygonSource } } },
		pcb_PrimitivePour: {
			async get(id) {
				const pour = poursById.get(id)
				if (!pour) return undefined
				return {
					getState_PrimitiveId: () => id,
					getState_Net: () => pour.net,
					getState_Layer: () => pour.layer,
					getState_ComplexPolygon: () => ({ getSource: () => pour.path }),
				}
			},
		},
		pcb_PrimitivePoured: {
			async getAll() {
				return pours.map((pour, index) => ({
					getState_PourPrimitiveId: () => pour.id,
					getState_PourFills: () => [{ id: `fill-${index}`, fill: true, lineWidth: 0, path: { getSource: () => pour.path } }],
				}))
			},
		},
		pcb_PrimitiveRegion: {
			async getAll() {
				getAllCount++
				const result = [...regions.values()].map(regionObject)
				if (getAllCount === changeOnGetAll)
					source += `|\n${serialize({ header: { type: 'ATTR', id: `race-${getAllCount}`, ticket: 300 + getAllCount }, data: { key: 'note', value: 'raced' } })}`
				return result
			},
			async get(id) { const item = regions.get(id); return item ? regionObject(item) : undefined },
			async create(layer, polygon, ruleType, _name, _lineWidth, primitiveLock) {
				createCount++
				if (createCount === failCreateAt) throw new Error('injected create failure')
				const id = `region-${createCount}`
				const item = { id, layer, path: polygon.getSource(), ruleType, primitiveLock, lineWidth: 1 }
				regions.set(id, item)
				source += `|\n${serialize(sourceRecordForRegion(item))}`
				return regionObject(item)
			},
		},
	}
	globalThis.eda = sdk
	return {
		regions,
		activate() { globalThis.eda = sdk },
		get createCount() { return createCount },
		set failCreateAt(value) { failCreateAt = value },
		changeDuringGetAll(call) { changeOnGetAll = call },
		appendChange() { source += `|\n${serialize({ header: { type: 'ATTR', id: 'change', ticket: 200 }, data: { key: 'note', value: 'changed' } })}` },
	}
}

async function testPlanStaleDuplicateAndPartial() {
	const board = makeBoard()
	board.activate()
	const params = { nets: ['3V3', 'GND'], maxStripWidthMil: 105, marginMil: 6 }
	const preview = await planCommand.handler(params, context)
	assert.equal(preview.regions.length, 2)
	assert.deepEqual(preview.regions.map(region => region.layer), [1, 2])
	assert.ok(preview.regions.every(region => region.widthMil === 86 && region.lengthMil === 200))
	assert.ok(preview.regions.every(region => Array.isArray(region.polygonSource)))

	board.appendChange()
	await assert.rejects(applyCommand.handler({ ...params, planId: preview.planId }, context), /计划已过期/)
	assert.equal(board.createCount, 0, 'stale preview must not write')

	const raceBoard = makeBoard()
	raceBoard.activate()
	const racePreview = await planCommand.handler(params, context)
	// getAll #1 belongs to preview; #2 to apply's replan; #3 is the final
	// duplicate check immediately before first write.
	raceBoard.changeDuringGetAll(3)
	await assert.rejects(applyCommand.handler({ ...params, planId: racePreview.planId }, context), /发生变化/)
	assert.equal(raceBoard.createCount, 0, 'revision change during duplicate read must not write')

	board.activate()
	const freshPreview = await planCommand.handler(params, context)
	const applied = await applyCommand.handler({ ...params, planId: freshPreview.planId }, context)
	assert.equal(applied.created.length, 2)
	assert.equal(applied.reused.length, 0)
	assert.ok(applied.created.every(item => item.readbackVerified))

	const repeatPreview = await planCommand.handler(params, context)
	assert.ok(repeatPreview.regions.every(region => region.action === 'reuse'))
	const repeated = await applyCommand.handler({ ...params, planId: repeatPreview.planId }, context)
	assert.equal(repeated.created.length, 0)
	assert.equal(repeated.reused.length, 2)
	assert.equal(board.createCount, 2, 'exact same geometry must be reused')

	const partialBoard = makeBoard()
	partialBoard.activate()
	partialBoard.failCreateAt = 2
	const partialPreview = await planCommand.handler(params, context)
	await assert.rejects(applyCommand.handler({ ...params, planId: partialPreview.planId }, context), error => {
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.created?.length, 1)
		return true
	})
	assert.equal(partialBoard.createCount, 2)
}

await testPlanStaleDuplicateAndPartial()
console.log('PASS copper keepout preview, stale rejection, exact reuse, and partial failure')
