import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
import { installVirtualClock } from './virtual-clock.mjs'

const root = resolve(import.meta.dirname, '..')
const beforeSource = readFileSync(resolve(root, 'test/fixtures/drawwire-named-t-before.sourcelog'), 'utf8')
const afterSource = readFileSync(resolve(root, 'test/fixtures/drawwire-named-t-after.sourcelog'), 'utf8')
const beforeModel = JSON.parse(readFileSync(resolve(root, 'test/fixtures/drawwire-named-t-before-model.json'), 'utf8'))
const afterModel = JSON.parse(readFileSync(resolve(root, 'test/fixtures/drawwire-named-t-after-model.json'), 'utf8'))
const request = { points: [[300, 200], [300, 300]], net: 'ACE_BUS', color: '#FF0000', lineType: 'solid', _timeoutMs: 5000 }
const built = buildSync({
  stdin: { contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand }`, resolveDir: resolve(root, 'test'), sourcefile: 'schematic-drawwire-named-t-entry.ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { schematicCommands, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWire = schematicCommands.find(item => item.name === 'schematic.drawWire').handler

function parseRows(source) {
  return source.split(/\r?\n/).filter(row => row.includes('||')).map(row => {
    const [headerRaw, dataRaw] = row.split('||')
    return { header: JSON.parse(headerRaw.replace(/\|+$/, '')), data: JSON.parse(dataRaw.split('|')[0]) }
  })
}
function renderRows(rows) { return rows.map(row => `${JSON.stringify(row.header)}||${JSON.stringify(row.data)}|`).join('\n') }
function mutateRows(source, mutate) {
  const rows = parseRows(source).map(row => mutate(structuredClone(row)) ?? row)
  return renderRows(rows)
}
function makeHarness({ mutateBeforeSource, mutateSource, mutateModel, includeCrossingLine = false } = {}) {
  const crossingWire = { primitiveId: 'wire-crossing', net: '', line: [300, 150, 300, 250], lineWidth: null, color: '#FF0000', lineType: 0 }
  const addCrossingSource = source => `${source}\n{"type":"WIRE","ticket":100,"id":"wire-crossing"}||{"zIndex":100}|\n{"type":"LINE","ticket":101,"id":"line-crossing"}||{"fillColor":null,"fillStyle":null,"strokeColor":"#FF0000","strokeStyle":"SOLID","strokeWidth":null,"startX":300,"startY":-150,"endX":300,"endY":-250,"lineGroup":"wire-crossing"}|`
  const originalSource = mutateBeforeSource ? mutateBeforeSource(beforeSource) : beforeSource
  const initialSource = includeCrossingLine ? addCrossingSource(originalSource) : originalSource
  const initialModel = includeCrossingLine ? [...structuredClone(beforeModel), structuredClone(crossingWire)] : structuredClone(beforeModel)
  let currentSource = initialSource
  let currentModel = initialModel
  let createCalls = 0
  const focusUuid = parseRows(initialSource).find(row => row.header.type === 'DOCHEAD')?.data?.uuid
  const wrapWire = wire => ({
    getState_PrimitiveId: () => wire.primitiveId,
    getState_Net: () => wire.net,
    getState_Line: () => wire.line,
    getState_Color: () => wire.color ?? '#FF0000',
    getState_LineWidth: () => wire.lineWidth ?? null,
    getState_LineType: () => wire.lineType ?? 0,
  })
  globalThis.eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: focusUuid }) },
    sys_FileManager: { getDocumentSource: async () => currentSource },
    sch_PrimitiveAttribute: {
      getAll: async () => parseRows(currentSource).filter(row => row.header.type === 'ATTR').map(row => ({
        getState_Key: () => row.data.key,
        getState_Value: () => row.data.value,
      })),
    },
    sch_PrimitiveWire: {
      getAll: async () => currentModel.map(wrapWire),
      create: async () => {
        createCalls++
        const resultingSource = includeCrossingLine ? addCrossingSource(afterSource) : afterSource
        const resultingModel = includeCrossingLine ? [...structuredClone(afterModel), structuredClone(crossingWire)] : structuredClone(afterModel)
        currentSource = mutateSource ? mutateSource(resultingSource) : resultingSource
        currentModel = mutateModel ? mutateModel(resultingModel) : resultingModel
        return wrapWire(currentModel[0])
      },
    },
  }
  return { run: params => drawWire(params), get createCalls() { return createCalls } }
}
async function runVirtual(fn) {
  const clock = installVirtualClock()
  try { return await fn(clock) }
  finally { clock.restore() }
}
async function captureError(fn, label) {
  try { await fn() } catch (error) { return error }
  assert.fail(`expected a partial-write error: ${label}`)
}

// Paired 4.1.78 host readbacks: one named vertical branch ends at the interior of the old horizontal LINE.
{
  const h = makeHarness()
  const result = await runVirtual(() => h.run(request))
  assert.equal(h.createCalls, 1)
  assert.deepEqual(result.primitiveIds, ['e659935fc45752a1'])
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.reused, ['e659935fc45752a1'])
  assert.deepEqual(result.drawingOrderChanges, [
    { id: '4a90ac35267901ee', before: 5, after: 9, wireId: 'e659935fc45752a1' },
    { id: 'c105ff0f2d01a2fb', before: 4, after: 8, wireId: 'e659935fc45752a1' },
  ])
}

const negativeCases = [
  ['wrong NET zIndex', source => mutateRows(source, row => row.header.type === 'ATTR' && row.data.key === 'NET' && row.data.parentId === 'e659935fc45752a1' ? { ...row, data: { ...row.data, zIndex: 10 } } : row)],
  ['NET field other than zIndex changed', source => mutateRows(source, row => row.header.type === 'ATTR' && row.data.key === 'NET' && row.data.parentId === 'e659935fc45752a1' ? { ...row, data: { ...row.data, x: 301 } } : row)],
  ['old LINE ID lost', source => mutateRows(source, row => row.header.type === 'LINE' && row.header.id === '368be38b8798c2e1' ? { ...row, header: { ...row.header, id: 'replacement-line-id' } } : row)],
  ['duplicate target segment', source => `${source}\n${JSON.stringify({ type: 'LINE', ticket: 42, id: 'extra-duplicate' })}||${JSON.stringify({ ...parseRows(source).find(row => row.header.type === 'LINE' && row.data.startX === 300 && row.data.endX === 300).data, lineGroup: 'e659935fc45752a1' })}|`],
  ['old second LINE changed', source => mutateRows(source, row => row.header.type === 'LINE' && row.header.id === '368be38b8798c2e1' ? { ...row, data: { ...row.data, startX: 399 } } : row)],
  ['non-target record changed', source => mutateRows(source, row => row.header.type === 'ATTR' && row.data.key === '@Project Name' ? { ...row, data: { ...row.data, value: 'changed' } } : row)],
  ['target WIRE changed', source => mutateRows(source, row => row.header.type === 'WIRE' && row.header.id === 'e659935fc45752a1' ? { ...row, data: { ...row.data, zIndex: 2 } } : row)],
]
for (const [label, mutateSource] of negativeCases) {
  const h = makeHarness({ mutateSource })
  const error = await captureError(() => runVirtual(() => h.run(request)), label)
  assert.equal(h.createCalls, 1, `${label}: one attempted write`)
  assert.equal(error.cause?.partial, true, `${label}: unsafe after-state is partial`)
}

for (const [label, mutateBeforeSource] of [
  ['before second LINE has an extra non-coordinate field', source => mutateRows(source, row => row.header.type === 'LINE' && row.header.id === 'c5ffa302b1579e83' ? { ...row, data: { ...row.data, extraBeforeOnly: true } } : row)],
  ['before second LINE has an extra header field', source => mutateRows(source, row => row.header.type === 'LINE' && row.header.id === 'c5ffa302b1579e83' ? { ...row, header: { ...row.header, extraBeforeOnly: true } } : row)],
  ['before second LINE has a different fillStyle', source => mutateRows(source, row => row.header.type === 'LINE' && row.header.id === 'c5ffa302b1579e83' ? { ...row, data: { ...row.data, fillStyle: 'DASHED' } } : row)],
]) {
  const h = makeHarness({ mutateBeforeSource })
  const error = await captureError(() => runVirtual(() => h.run(request)), label)
  assert.equal(h.createCalls, 1, `${label}: one attempted write`)
  assert.equal(error.cause?.partial, true, `${label}: non-template baseline must be rejected`)
}

{
  const h = makeHarness({ includeCrossingLine: true })
  const error = await captureError(() => runVirtual(() => h.run(request)), 'requested branch intersects a non-target LINE')
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}

// The exception is limited to the exact one-branch orientation: the same path reversed is rejected.
{
  const h = makeHarness()
  const error = await captureError(() => runVirtual(() => h.run({ ...request, points: [[300, 300], [300, 200]] })), 'reversed SDK direction')
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}

console.log('schematic drawWire named T-host regression passed')
