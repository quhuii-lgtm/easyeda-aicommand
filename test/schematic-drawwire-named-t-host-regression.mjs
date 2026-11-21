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
function makeHarness({ mutateBeforeSource, mutateSource, mutateModel, includeCrossingLine = false, additionalWires = [] } = {}) {
  const crossingWire = { primitiveId: 'wire-crossing', net: '', line: [300, 150, 300, 250], lineWidth: null, color: '#FF0000', lineType: 0 }
  const addCrossingSource = source => `${source}\n{"type":"WIRE","ticket":100,"id":"wire-crossing"}||{"zIndex":100}|\n{"type":"LINE","ticket":101,"id":"line-crossing"}||{"fillColor":null,"fillStyle":null,"strokeColor":"#FF0000","strokeStyle":"SOLID","strokeWidth":null,"startX":300,"startY":-150,"endX":300,"endY":-250,"lineGroup":"wire-crossing"}|`
  const originalSource = mutateBeforeSource ? mutateBeforeSource(beforeSource) : beforeSource
  const addAdditionalSources = source => additionalWires.reduce((text, wire, index) => {
    const y1 = -wire.line[1], y2 = -wire.line[3], base = 200 + index * 4
    return `${text}\n{"type":"WIRE","ticket":${base},"id":"${wire.primitiveId}"}||${JSON.stringify({ zIndex: base })}|\n{"type":"LINE","ticket":${base + 1},"id":"line-${wire.primitiveId}"}||${JSON.stringify({ fillColor: null, fillStyle: null, strokeColor: wire.color ?? '#FF0000', strokeStyle: 'SOLID', strokeWidth: null, startX: wire.line[0], startY: y1, endX: wire.line[2], endY: y2, lineGroup: wire.primitiveId })}|\n{"type":"ATTR","ticket":${base + 2},"id":"attr-${wire.primitiveId}"}||${JSON.stringify({ parentId: wire.primitiveId, key: 'NET', value: wire.net })}|\n{"type":"ATTR","ticket":${base + 3},"id":"relevance-${wire.primitiveId}"}||${JSON.stringify({ parentId: wire.primitiveId, key: 'Relevance', value: '[]' })}|`
  }, source)
  const initialSourceBase = includeCrossingLine ? addCrossingSource(originalSource) : originalSource
  const initialSource = addAdditionalSources(initialSourceBase)
  const initialModel = [
    ...(includeCrossingLine ? [...structuredClone(beforeModel), structuredClone(crossingWire)] : structuredClone(beforeModel)),
    ...structuredClone(additionalWires),
  ]
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
        const resultingSourceBase = includeCrossingLine ? addCrossingSource(afterSource) : afterSource
        const resultingSource = addAdditionalSources(resultingSourceBase)
        const resultingModel = [
          ...(includeCrossingLine ? [...structuredClone(afterModel), structuredClone(crossingWire)] : structuredClone(afterModel)),
          ...structuredClone(additionalWires),
        ]
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

// Explicit names and unnamed geometry must not join distinct networks at endpoint/T contacts.
// A true interior cross remains the host's non-contact case and must not be broadly blocked.
for (const net of ['ACE_BUS', undefined]) {
  const foreignEndpoint = { primitiveId: 'wire-foreign-endpoint', net: 'OTHER_BUS', line: [250, 300, 350, 300], color: '#FF0000' }
  const h = makeHarness({ additionalWires: [foreignEndpoint] })
  const error = await captureError(() => runVirtual(() => h.run({ ...request, net })), `foreign network endpoint rejected (request net=${net ?? 'unnamed'})`)
  assert.equal(h.createCalls, 0, 'foreign network endpoint must be rejected before any create')
  assert.match(error.message, /different networks|different net|不同网络|不同网络/, 'error identifies network collision')
}
{
  const foreignInteriorCross = { primitiveId: 'wire-foreign-cross', net: 'OTHER_BUS', line: [250, 250, 350, 250], color: '#FF0000' }
  const h = makeHarness({ additionalWires: [foreignInteriorCross] })
  await runVirtual(() => h.run(request))
  assert.equal(h.createCalls, 1, 'pure interior cross is not classified as electrical contact')
}

// The exception is limited to the exact one-branch orientation: the same path reversed is rejected.
{
  const h = makeHarness()
  const error = await captureError(() => runVirtual(() => h.run({ ...request, points: [[300, 300], [300, 200]] })), 'reversed SDK direction')
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}

console.log('schematic drawWire named T-host regression passed')
