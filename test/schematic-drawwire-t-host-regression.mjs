import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
import { installVirtualClock } from './virtual-clock.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/drawwire-t-host-0.20.53-fixture.json'), 'utf8'))
const fixture054 = JSON.parse(readFileSync(resolve(root, 'test/fixtures/drawwire-t-host-0.20.54-fixture.json'), 'utf8'))
// The SDK getter resolved null from the default source LINE style in the accepted host path;
// listWires omits lineType, so this is an explicit derived getter value, not a listWires field.
for (const item of [fixture, fixture054]) {
  for (const model of [item.beforeModel, item.afterModel])
    for (const wire of model) wire.derivedLineType = null
}
const built = buildSync({
  stdin: { contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand }`, resolveDir: resolve(root, 'test'), sourcefile: 'schematic-drawwire-t-host-entry.ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { schematicCommands, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWire = schematicCommands.find(item => item.name === 'schematic.drawWire').handler
async function loadFrozenDrawWire(file, sourcefile) {
  const baselineFile = resolve(root, file)
  const baselineSource = readFileSync(baselineFile, 'utf8').replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (_match, quote, specifier) => {
    const absolute = resolve(root, 'src/commands', specifier).replaceAll('\\', '/')
    return `from ${quote}${absolute}${quote}`
  })
  const baselineBuilt = buildSync({
    stdin: { contents: baselineSource, resolveDir: resolve(root, 'test'), sourcefile, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
  })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(baselineBuilt.outputFiles[0].text).toString('base64')}`)
  return mod.schematicCommands.find(item => item.name === 'schematic.drawWire').handler
}
const baselineDrawWire = await loadFrozenDrawWire('test/fixtures/regression-baselines/schematic-v053-host-recheck.ts', 'schematic-v053-host-recheck.ts')
const baseline054DrawWire = await loadFrozenDrawWire('test/fixtures/regression-baselines/schematic-v054-host-recheck.ts', 'schematic-v054-host-recheck.ts')

function transformSource(source, mutate) {
  return source.split(/\r?\n/).map(row => {
    if (!row.includes('||')) return row
    const [headerRaw, dataRaw] = row.split('||')
    const header = JSON.parse(headerRaw.replace(/\|+$/, ''))
    const data = JSON.parse(dataRaw.split('|')[0])
    const mutated = mutate({ type: header.type, id: header.id, header, data })
    if (mutated === undefined) return ''
    const next = mutated ?? { header, data }
    return `${JSON.stringify(next.header)}||${JSON.stringify(next.data)}|`
  }).join('\n')
}
function sourceRows(source) {
  return source.split(/\r?\n/).filter(row => row.includes('||')).map(row => {
    const [headerRaw, dataRaw] = row.split('||')
    return { header: JSON.parse(headerRaw.replace(/\|+$/, '')), data: JSON.parse(dataRaw.split('|')[0]) }
  })
}
function translateTargetSource(source, dx, dy) {
  return transformSource(source, row => {
    const data = { ...row.data }
    if (row.type === 'LINE' && data.lineGroup === '5e3cd439d885acd8') {
      for (const field of ['startX', 'endX']) data[field] += dx
      for (const field of ['startY', 'endY']) data[field] -= dy
    }
    if (row.type === 'ATTR' && data.parentId === '5e3cd439d885acd8' && data.key === 'NET') {
      data.x += dx
      data.y -= dy
    }
    return { ...row, data }
  })
}
function withRemoteWire(source, { x1 = 600, y = 500, x2 = 700 } = {}) {
  return `${source}\n{"type":"WIRE","ticket":100,"id":"wire-remote"}||{"zIndex":100}|\n{"type":"LINE","ticket":101,"id":"line-remote"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":${x1},"startY":${-y},"endX":${x2},"endY":${-y},"lineGroup":"wire-remote"}|`
}
function makeHarness({ harnessFixture = fixture, mutateAfter, retainOldNet = false, mode = 'normal', lineTypeBehavior = 'model', beforeSource = harnessFixture.beforeSource, beforeModel = harnessFixture.beforeModel, afterSource = harnessFixture.afterSource, afterModel = harnessFixture.afterModel } = {}) {
  let currentSource = beforeSource
  let currentModel = structuredClone(beforeModel)
  let createCalls = 0
  let afterCaptures = 0
  const wrapWire = wire => ({
    getState_PrimitiveId: () => wire.primitiveId,
    getState_Net: () => wire.net,
    getState_Line: () => wire.line,
    getState_Color: () => wire.color ?? null,
    getState_LineWidth: () => wire.lineWidth,
    getState_LineType: () => {
      if (lineTypeBehavior === 'throw') throw new Error('injected lineType getter failure')
      if (lineTypeBehavior === 'undefined') return undefined
      if (lineTypeBehavior === 'zero') return 0
      return Object.hasOwn(wire, 'derivedLineType') ? wire.derivedLineType : wire.lineType
    },
  })
  const focusUuid = sourceRows(beforeSource).find(row => row.header.type === 'DOCHEAD')?.data?.uuid
  globalThis.eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: focusUuid }) },
    sys_FileManager: { getDocumentSource: async () => currentSource },
    sch_PrimitiveAttribute: { getAll: async () => [] },
    sch_PrimitiveWire: {
      getAll: async () => currentModel.map(wrapWire),
      create: async () => {
        createCalls++
        if (mode === 'reject') throw new Error('injected create failure')
        currentSource = afterSource
        currentModel = structuredClone(afterModel)
        if (mutateAfter) currentSource = transformSource(currentSource, row => mutateAfter(row))
        if (retainOldNet) {
          const oldNet = sourceRows(harnessFixture.beforeSource).find(row => row.header.type === 'ATTR' && row.data?.key === 'NET')
          currentSource += `\n${JSON.stringify(oldNet.header)}||${JSON.stringify(oldNet.data)}|`
        }
        return wrapWire(currentModel[0])
      },
    },
  }
  return {
    get createCalls() { return createCalls },
    get afterCaptures() { return afterCaptures },
    run: async (params, handler = drawWire) => handler(params),
    get source() { return currentSource },
    get rows() { return sourceRows(currentSource) },
  }
}
async function runVirtual(fn) {
  const clock = installVirtualClock()
  try { return await fn(clock) }
  finally { clock.restore() }
}
async function captureError(fn, label = 'scenario') {
  try { await fn() } catch (error) { return error }
  assert.fail(`expected drawWire failure: ${label}`)
}

// Current handler must accept only the host-proven default unnamed one-WIRE T split.
{
  const original = makeHarness()
  const baselineError = await captureError(() => runVirtual(() => original.run(fixture.params, baselineDrawWire)), 'pre-fix 0.20.53 host sample')
  assert.equal(baselineError.cause?.partial, true, 'the frozen pre-fix source reproduces the reported T false partial')

  const h = makeHarness()
  const result = await runVirtual(() => h.run(fixture.params))
  assert.equal(h.createCalls, 1)
  assert.deepEqual(result.primitiveIds, ['5e3cd439d885acd8'])
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.reused, ['5e3cd439d885acd8'])
  assert.deepEqual(result.drawingOrderChanges, [{ id: 'cf2bea5710d92e2e', before: 3, after: 7, wireId: '5e3cd439d885acd8' }])
}

// 0.20.54 host evidence proves the default getter value is null even though listWires omits it.
{
  const original = makeHarness({ harnessFixture: fixture054 })
  const baselineError = await captureError(() => runVirtual(() => original.run(fixture054.params, baseline054DrawWire)), 'pre-fix 0.20.54 host sample')
  assert.equal(baselineError.cause?.partial, true, 'the frozen 0.20.54 source reproduces its T false partial')

  const h = makeHarness({ harnessFixture: fixture054 })
  const result = await runVirtual(() => h.run(fixture054.params))
  const wireId = fixture054.beforeModel[0].primitiveId
  const relevance = sourceRows(fixture054.beforeSource).find(row => row.header.type === 'ATTR' && row.data?.key === 'Relevance' && row.data?.parentId === wireId)
  assert.equal(h.createCalls, 1)
  assert.deepEqual(result.primitiveIds, [wireId])
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.reused, [wireId])
  assert.deepEqual(result.drawingOrderChanges, [{ id: relevance.header.id, before: 3, after: 7, wireId }])
}

for (const lineTypeBehavior of ['zero', 'undefined', 'throw']) {
  const h = makeHarness({ harnessFixture: fixture054, lineTypeBehavior })
  const error = await captureError(() => runVirtual(() => h.run(fixture054.params)), `lineType getter ${lineTypeBehavior}`)
  assert.equal(h.createCalls, 1, `${lineTypeBehavior}: exactly one write attempt`)
  assert.equal(error.cause?.partial, true, `${lineTypeBehavior}: no false success`)
}

// The narrow host pattern is coordinate-relative and can coexist with a distant unchanged WIRE.
{
  const dx = -437, dy = 263
  const beforeSource = translateTargetSource(fixture.beforeSource, dx, dy)
  const afterSource = translateTargetSource(fixture.afterSource, dx, dy)
  const beforeModel = structuredClone(fixture.beforeModel).map(wire => ({ ...wire, line: wire.line.map((value, index) => value + (index % 2 === 0 ? dx : dy)) }))
  const afterModel = structuredClone(fixture.afterModel).map(wire => ({ ...wire, line: wire.line.map((value, index) => value + (index % 2 === 0 ? dx : dy)) }))
  const params = structuredClone(fixture.params)
  params.points = params.points.map(point => [point[0] + dx, point[1] + dy])
  const h = makeHarness({ beforeSource: withRemoteWire(beforeSource), afterSource: withRemoteWire(afterSource), beforeModel: [...beforeModel, { primitiveId: 'wire-remote', net: '', line: [600, 500, 700, 500], color: null, lineWidth: null, lineType: 0 }], afterModel: [...afterModel, { primitiveId: 'wire-remote', net: '', line: [600, 500, 700, 500], color: null, lineWidth: null, lineType: 0 }] })
  const result = await runVirtual(() => h.run(params))
  assert.deepEqual(result.drawingOrderChanges, [{ id: 'cf2bea5710d92e2e', before: 3, after: 7, wireId: '5e3cd439d885acd8' }])
}

// A new single wire remains created, and a final read-only verification does not add reuse evidence.
{
  const empty = `{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","uuid":"7197e2247844c833"}|`
  const rows = [
    [`{"type":"DOCHEAD","ticket":1}`, `{"docType":"SCH_PAGE","uuid":"7197e2247844c833"}`],
    [`{"type":"WIRE","ticket":2,"id":"wire-new"}`, `{"zIndex":1}`],
    [`{"type":"LINE","ticket":3,"id":"line-new"}`, `{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":160,"startY":-150,"endX":160,"endY":-210,"lineGroup":"wire-new"}`],
    [`{"type":"ATTR","ticket":4,"id":"attr-rel"}`, `{"key":"Relevance","value":"[]","parentId":"wire-new","zIndex":2}`],
    [`{"type":"ATTR","ticket":5,"id":"attr-net"}`, `{"key":"NET","value":"","parentId":"wire-new","x":160,"y":-180,"rotation":null,"zIndex":3}`],
  ].map(([header, data]) => `${header}||${data}|`).join('\n')
  const model = [{ primitiveId: 'wire-new', net: '', line: [160, 150, 160, 210], color: null, lineWidth: null, lineType: null }]
  const h = makeHarness({ beforeSource: empty, beforeModel: [], afterSource: rows, afterModel: model })
  const result = await runVirtual(() => h.run({ points: [[160, 150], [160, 210]], _timeoutMs: 1000 }))
  assert.deepEqual(result.created, ['wire-new'])
  assert.deepEqual(result.reused, [])
}

// Negative fixtures must not enter the T exception. Virtual time exhausts the unchanged total operation budget.
const negativeMutations = [
  ['missing LINE', row => row.type === 'LINE' && row.id === '9b499a884b60b49c' ? undefined : row],
  ['offset branch geometry', row => row.type === 'LINE' && row.id === 'dcbe17ae4698f14a' ? { ...row, data: { ...row.data, endX: row.data.endX + 1 } } : row],
  ['changed default style', row => row.type === 'LINE' && row.id === 'dcbe17ae4698f14a' ? { ...row, data: { ...row.data, strokeWidth: 1 } } : row],
  ['added LINE extra field', row => row.type === 'LINE' && row.id === 'dcbe17ae4698f14a' ? { ...row, data: { ...row.data, locked: true } } : row],
  ['new LINE custom header', row => row.type === 'LINE' && row.id === 'dcbe17ae4698f14a' ? { ...row, header: { ...row.header, custom: true } } : row],
  ['retained ID becomes vertical', row => row.type === 'LINE' && row.id === '90d03d1300967b33' ? { ...row, header: { ...row.header, id: 'line-replacement' } } : row.type === 'LINE' && row.id === 'dcbe17ae4698f14a' ? { ...row, header: { ...row.header, id: '90d03d1300967b33' } } : row],
  ['Relevance zIndex 6', row => row.type === 'ATTR' && row.data?.key === 'Relevance' ? { ...row, data: { ...row.data, zIndex: 6 } } : row],
  ['Relevance value changed', row => row.type === 'ATTR' && row.data?.key === 'Relevance' ? { ...row, data: { ...row.data, value: 'bad' } } : row],
  ['Relevance custom header', row => row.type === 'ATTR' && row.data?.key === 'Relevance' ? { ...row, header: { ...row.header, custom: true } } : row],
  ['new NET custom header', row => row.type === 'ATTR' && row.data?.key === 'NET' ? { ...row, header: { ...row.header, custom: true } } : row],
  ['NET not at branch midpoint', row => row.type === 'ATTR' && row.data?.key === 'NET' ? { ...row, data: { ...row.data, x: 161 } } : row],
  ['NET non-empty', row => row.type === 'ATTR' && row.data?.key === 'NET' ? { ...row, data: { ...row.data, value: 'SIG' } } : row],
  ['non-target TEXT/ATTR change', row => row.type === 'ATTR' && row.data?.key === 'Company' ? { ...row, data: { ...row.data, value: 'changed' } } : row],
]
for (const [label, mutateAfter] of negativeMutations) {
  const h = makeHarness({ mutateAfter })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)), label)
  assert.equal(h.createCalls, 1, `${label}: no write retry`)
  assert.equal(error.cause?.partial, true, `${label}: explicit partial result`)
}
{
  const h = makeHarness({ retainOldNet: true })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)))
  assert.equal(h.createCalls, 1, 'old NET retained: no write retry')
  assert.equal(error.cause?.partial, true)
}
for (const [label, changeOldNet] of [
  ['old NET off source line', data => ({ ...data, y: -151 })],
  ['old NET outside old segment', data => ({ ...data, x: 99 })],
  ['old NET non-finite coordinate', data => ({ ...data, x: null })],
]) {
  const beforeSource = transformSource(fixture.beforeSource, row => row.type === 'ATTR' && row.data?.key === 'NET' ? { ...row, data: changeOldNet(row.data) } : row)
  const h = makeHarness({ beforeSource })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)), label)
  assert.equal(error.cause?.partial, true, `${label}: must not enter the exception`)
}
{
  const beforeSource = withRemoteWire(fixture.beforeSource)
  const afterSource = withRemoteWire(fixture.afterSource, { x2: 701 })
  const beforeModel = [...structuredClone(fixture.beforeModel), { primitiveId: 'wire-remote', net: '', line: [600, 500, 700, 500], color: null, lineWidth: null, lineType: 0 }]
  const afterModel = [...structuredClone(fixture.afterModel), { primitiveId: 'wire-remote', net: '', line: [600, 500, 701, 500], color: null, lineWidth: null, lineType: 0 }]
  const h = makeHarness({ beforeSource, afterSource, beforeModel, afterModel })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)), 'changed distant wire must not be accepted')
  assert.equal(error.cause?.partial, true)
}
{
  const branchCrossing = `{"type":"WIRE","ticket":100,"id":"wire-cross"}||{"zIndex":100}|\n{"type":"LINE","ticket":101,"id":"line-cross"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":130,"startY":-180,"endX":180,"endY":-180,"lineGroup":"wire-cross"}|`
  const beforeSource = `${fixture.beforeSource}\n${branchCrossing}`
  const afterSource = `${fixture.afterSource}\n${branchCrossing}`
  const crossing = { primitiveId: 'wire-cross', net: '', line: [130, 180, 180, 180], color: null, lineWidth: null, lineType: 0 }
  const h = makeHarness({ beforeSource, afterSource, beforeModel: [...structuredClone(fixture.beforeModel), crossing], afterModel: [...structuredClone(fixture.afterModel), crossing] })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)), 'branch contacting another wire must not enter exception')
  assert.equal(error.cause?.partial, true)
}
{
  const h = makeHarness({ mode: 'reject' })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)))
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}
{
  const h = makeHarness()
  const error = await captureError(() => runVirtual(() => h.run({ ...fixture.params, net: 'SIG' })), 'named T must not enter exception')
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}
{
  const beforeSource = transformSource(fixture.beforeSource, row => row.type === 'LINE' && row.id === '90d03d1300967b33' ? { ...row, data: { ...row.data, endX: 160 } } : row)
  const secondLine = `{"type":"LINE","ticket":39,"id":"old-line-second"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":160,"startY":-150,"endX":220,"endY":-150,"lineGroup":"5e3cd439d885acd8"}|`
  const beforeModel = [{ ...fixture.beforeModel[0], line: [100, 150, 160, 150, 160, 150, 220, 150] }]
  const h = makeHarness({ beforeSource: `${beforeSource}\n${secondLine}`, beforeModel })
  const error = await captureError(() => runVirtual(() => h.run(fixture.params)), 'existing multi-LINE WIRE must not enter exception')
  assert.equal(h.createCalls, 1)
  assert.equal(error.cause?.partial, true)
}

console.log('schematic-drawwire-t-host-regression: PASS')
