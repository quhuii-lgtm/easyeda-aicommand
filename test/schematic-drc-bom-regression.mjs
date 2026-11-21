import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `export { schematicCommands } from '../src/commands/schematic.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-drc-bom-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { schematicCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const runDrc = schematicCommands.find(item => item.name === 'schematic.runDrc').handler
const detailed = schematicCommands.find(item => item.name === 'schematic.runDrcDetailed').handler
const exportBom = schematicCommands.find(item => item.name === 'schematic.exportBom').handler
const listAssemblyVariants = schematicCommands.find(item => item.name === 'schematic.listAssemblyVariants').handler

let drcResponses = []
let bomArgs
let bomFile
globalThis.eda = {
	sch_Drc: { check: async () => drcResponses.shift() },
	sch_ManufactureData: { getBomFile: async (...args) => { bomArgs = args; return bomFile } },
}

const violation = { type: 'warn', rule: 'CHECKFLOATPIN', primitives: [{ primitiveId: 'r1', name: '1' }] }
drcResponses = [[violation], [violation]]
assert.deepEqual((await detailed({})).violations[0].primitives, violation.primitives)
drcResponses = [[{ type: 'warn', count: 1 }], [{ type: 'warn', count: 2 }]]
const aggregate = await detailed({})
assert.equal(aggregate.aggregated, true)
assert.equal(aggregate.totalCount, 2)
assert.match(aggregate.note, /聚合结构/)
assert.match(aggregate.note, /首次与复跑数量不同/)
drcResponses = [[], []]
assert.equal((await detailed({})).passed, true)
for (const invalid of [false, undefined, { type: 'warn', count: 2 }, [null], [{ type: 'warn' }]]) {
	drcResponses = [invalid]
	await assert.rejects(detailed({}), /不可判定/)
	drcResponses = [invalid]
	await assert.rejects(runDrc({}), /不可判定/)
}
drcResponses = [[violation], [violation]]
assert.equal((await runDrc({})).passed, false)

const nativeText = 'No.\tQuantity\tDesignator\r\n1\t5\tR1,R2,R3,R4,R5\r\n'
bomFile = new File([Buffer.from([0xFF, 0xFE]), Buffer.from(nativeText, 'utf16le')], 'native.csv')
const csv = await exportBom({ fileType: 'csv', fileName: 'bom.csv' })
assert.deepEqual(bomArgs.slice(0, 2), ['bom', 'csv'])
assert.equal(csv.fileName, 'native.tsv')
assert.equal(csv.nativeFileName, 'native.csv')
assert.equal(csv.format, 'tsv')
assert.equal(csv.encoding, 'utf-16le')
assert.equal(csv.delimiter, '\t')
assert.equal(csv.mimeType, 'text/tab-separated-values; charset=utf-16le')
assert.equal(Buffer.from(csv.base64, 'base64').compare(Buffer.from(await bomFile.arrayBuffer())), 0)

bomFile = new File([Buffer.from('Name,Quantity\nR1,1\n', 'utf8')], 'plain.csv')
const noBom = await exportBom({ fileType: 'csv' })
assert.equal(noBom.format, 'csv')
assert.equal(noBom.encoding, 'unconfirmed')
assert.equal(noBom.mimeType, 'text/csv')

bomFile = new File([Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00])], 'native.xlsx')
const xlsx = await exportBom({ fileType: 'xlsx', fileName: 'bom.xlsx' })
assert.deepEqual(bomArgs.slice(0, 2), ['bom', 'xlsx'])
assert.equal(xlsx.format, 'xlsx')
assert.equal(xlsx.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
assert.equal(Buffer.from(xlsx.base64, 'base64').compare(Buffer.from(await bomFile.arrayBuffer())), 0)
await assert.rejects(exportBom({ fileType: 'CSV' }), /仅支持/)
assert.equal(bomArgs.length, 2, 'ordinary BOM export keeps the existing SDK invocation')
await assert.rejects(exportBom({ assemblyVariant: 'PERF' }), /没有提供装配变体列表/)
const perf = { text: 'PERF', value: 'perf-id' }
const cost = { text: 'COST', value: 'cost-id' }
let variants = [perf, cost]
globalThis.eda.sch_ManufactureData.getAssemblyVariantsConfigs = async () => variants
assert.deepEqual(await listAssemblyVariants({}), [perf, cost])
assert.deepEqual((await exportBom({ assemblyVariant: 'PERF' })).assemblyVariant, perf)
assert.deepEqual(bomArgs, [undefined, 'xlsx', undefined, undefined, undefined, undefined, undefined, perf])
assert.deepEqual((await exportBom({ assemblyVariant: 'cost-id' })).assemblyVariant, cost)
const confirmedArgs = bomArgs
await assert.rejects(exportBom({ assemblyVariant: 'unconfigured' }), /未找到/)
variants = [perf, { text: 'PERF', value: 'another-perf-id' }]
await assert.rejects(exportBom({ assemblyVariant: 'PERF' }), /有多条匹配/)
await assert.rejects(exportBom({ assemblyVariant: 'perf-id' }, {
	assertDocumentTarget: async () => { throw new Error('wrong page') },
}), /wrong page/)
assert.equal(bomArgs, confirmedArgs, 'unresolved variant/target does not send a default export')

console.log('PASS schematic DRC unknown-result guard and BOM native format metadata')
