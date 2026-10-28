import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `export { pcbCommands } from '../src/commands/pcb.ts'; export { dfmCommands } from '../src/commands/dfm.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-drc-result-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { pcbCommands, dfmCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const runDrc = pcbCommands.find(item => item.name === 'pcb.runDrc').handler
const detailed = pcbCommands.find(item => item.name === 'pcb.runDrcDetailed').handler

let result
let editorVersion = '4.1.78'
globalThis.eda = {
	pcb_Drc: { check: async () => result },
	sys_Environment: { getEditorCurrentVersion: () => editorVersion },
}
result = []
assert.equal((await runDrc({})).passed, true)
assert.equal((await detailed({})).passed, true)
result = [{ name: 'Connection Error', list: [{ name: 'GND', list: [{ errorType: 'CONNECT', objs: ['pad-1'] }] }] }]
assert.equal((await runDrc({})).passed, false)
assert.equal((await detailed({})).totalCount, 1)
for (const invalid of [false, undefined, null, { name: 'Connection Error' }]) {
	result = invalid
	await assert.rejects(runDrc({}), /结果不可判定/)
	await assert.rejects(detailed({}), /结果不可判定/)
}

result = [{ name: 'Connection Error', list: [{ name: '+5V', list: [
	{ errorType: 'CONNECT', objs: ['pad-r2-2'], pos: { x: 92.966, y: 30 } },
	{ errorType: 'CONNECT', objs: ['pad-r1-2'], pos: { x: 22.966, y: 30 } },
] }] }]
const host41 = await detailed({})
assert.deepEqual(host41.violations.map(item => ({
	primitiveId: item.primitiveId,
	x: item.x,
	y: item.y,
	xMil: item.xMil,
	yMil: item.yMil,
	rawCoordinateUnit: item.rawCoordinateUnit,
	coordinateUnit: item.coordinateUnit,
})), [
	{ primitiveId: 'pad-r2-2', x: 92.966, y: 30, xMil: 929.66, yMil: 300, rawCoordinateUnit: '10mil', coordinateUnit: 'mil' },
	{ primitiveId: 'pad-r1-2', x: 22.966, y: 30, xMil: 229.66, yMil: 300, rawCoordinateUnit: '10mil', coordinateUnit: 'mil' },
])
editorVersion = '4.2.0'
const unknownHost = await detailed({})
assert.equal(unknownHost.violations[0].x, 92.966, 'keep raw DRC coordinates unchanged on an unverified host')
assert.equal(unknownHost.violations[0].rawCoordinateUnit, 'unknown')
assert.equal(Object.hasOwn(unknownHost.violations[0], 'xMil'), false, 'never apply the 4.1.78 conversion to an unverified version')

for (const command of dfmCommands) {
	const required = command.params.filter(param => param.required).map(param => param.name)
	for (const name of required)
		assert.ok(Object.hasOwn(command.example.params, name), `${command.name} example lacks ${name}`)
}
console.log('PASS PCB DRC rejects unknown results and DFM examples include required inputs')
