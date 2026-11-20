import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import JSZip from 'jszip'

const compiled = await build({
  stdin: { contents: "export { pcbCommands } from './src/commands/pcb'; export { readTable } from './src/pcb/manufacturingPreflight'; export { registerCommand, executeCommand } from './src/engine/registry';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { pcbCommands, readTable, registerCommand, executeCommand } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
for (const def of pcbCommands.filter(def => ['pcb.modifyLine', 'pcb.exportGerber', 'pcb.preflightAssembly', 'pcb.inspectManufacturingPackage', 'pcb.exportPickPlace'].includes(def.name))) registerCommand(def)

const board = project => ({ uuid: 'same-pcb', parentProjectUuid: project, tabId: 'same-pcb@' + project, documentType: 3 })
const line = (id, endX, startX = 0, net = 'TEST', width = 8) => ({
  getState_PrimitiveId: () => id, getState_Net: () => net, getState_Layer: () => 1,
  getState_StartX: () => startX, getState_StartY: () => 0, getState_EndX: () => endX, getState_EndY: () => 0, getState_LineWidth: () => width,
})
let focus = board('A'), rows = [line('old', 10)], writes = 0, changeFocus = false
const otherBoardRows = [line('old', 40), line('other', 50, 40)]
globalThis.eda = {
  dmt_SelectControl: { getCurrentDocumentInfo: async () => focus },
  pcb_PrimitiveLine: {
    getAll: async () => focus.parentProjectUuid === 'A' ? rows : otherBoardRows,
    modify: async (_id, props) => {
      writes++
      if (changeFocus) focus = board('B')
      else if (props.endX === 15) rows = [line('stub', 5), line('replacement', 15, 5)]
      else if (props.endX === 20) rows = [line('neighbor', 30)]
      else if (props.net) rows = [line('old', 10, 0, props.net)]
      else if (props.lineWidth === 9) rows = [line('old', 10, 0, 'TEST', 9)]
      else if (props.lineWidth === 10) rows = [line('old', 5, 0, 'TEST', 10), line('tail', 10, 5)]
      else if (props.lineWidth === 11) return new Promise(() => {})
      else rows = [line('old', props.endX)]
    },
  },
}
const run = (cmd, params) => executeCommand({ cmd, params })
const guarded = { __docUuid: 'same-pcb', __projectUuid: 'A', __tabId: 'same-pcb@A', primitiveId: 'old' }
assert.equal((await run('pcb.modifyLine', { ...guarded, __projectUuid: 'B', endX: 10 })).ok, false)
assert.equal(writes, 0)
const normal = await run('pcb.modifyLine', { ...guarded, endX: 12 })
assert.equal(normal.ok, true)
assert.equal(normal.data.readback.endX, 12)
const partial = await run('pcb.modifyLine', { ...guarded, endX: 15, lineWidth: 9 })
assert.equal(partial.ok, false)
assert.equal(partial.error.cause.status, 'partial')
assert.deepEqual(partial.error.cause.mapping.candidateIds.sort(), ['replacement', 'stub'])
assert.deepEqual(partial.error.cause.changes.removed.map(row => row.id), ['old'])
assert.equal(writes, 2)
rows = [line('old', 10)]
changeFocus = true
const switched = await run('pcb.modifyLine', { ...guarded, endX: 16, lineWidth: 9 })
assert.equal(switched.ok, false)
assert.equal(switched.error.cause.status, 'unknown')
assert.equal(writes, 3)
assert.deepEqual(otherBoardRows.map(row => row.getState_EndX()), [40, 50])
focus = board('A')
changeFocus = false
rows = [line('old', 10), line('neighbor', 30, 20)]
const merged = await run('pcb.modifyLine', { ...guarded, endX: 20 })
assert.equal(merged.ok, false)
assert.deepEqual(merged.error.cause.mapping.candidateIds, ['neighbor'])
assert.deepEqual(merged.error.cause.changes.changed.map(row => row.id), ['neighbor'])
assert.equal(merged.error.cause.changes.removed[0].id, 'old')
rows = [line('old', 10)]
const reverted = await run('pcb.modifyLine', { ...guarded, net: 'NEW', lineWidth: 9 })
assert.equal(reverted.ok, false)
assert.equal(reverted.error.cause.changes.completedSteps, 1)
assert.equal(reverted.error.cause.changes.changed[0].net, 'TEST')
rows = [line('old', 10)]
const splitWithOriginalId = await run('pcb.modifyLine', { ...guarded, lineWidth: 10 })
assert.equal(splitWithOriginalId.ok, false)
assert.deepEqual(splitWithOriginalId.error.cause.mapping.candidateIds.sort(), ['old', 'tail'])
rows = [line('old', 10)]
const timeout = await run('pcb.modifyLine', { ...guarded, net: 'NEW', lineWidth: 11, _timeoutMs: 1000 })
assert.equal(timeout.ok, false)
assert.equal(timeout.error.cause.status, 'unknown')
assert.equal(timeout.error.cause.retryable, false)
// Either the geometry budget or the outer command deadline can expire first.
const observedBeforeTimeout = timeout.error.cause.lastObservedChanges ?? timeout.error.cause.changes
assert.equal(observedBeforeTimeout.completedSteps, 1)
assert.equal(observedBeforeTimeout.latestReadback, false)
assert.equal(observedBeforeTimeout.changed[0].net, 'NEW')

const tsv = text => Buffer.from('\uFEFF' + text, 'utf16le').toString('base64')
const bom = tsv('Quantity\tDesignator\tFootprint\r\n2\tR1,J2\tF\r\n')
const placement = tsv('Designator\tFootprint\tSMD\r\nR1\tF\tYes\r\nJ2\tF\tYes\r\n')
const sample = { bomBase64: bom, placementBase64: placement, assignments: { R1: 'smt', J2: 'manual' } }
const preliminary = await run('pcb.preflightAssembly', sample)
assert.equal(preliminary.ok, true)
assert.deepEqual(preliminary.data.smtDesignators, ['R1'])
assert.match(preliminary.data.bom.tsv, /"1"\t"R1"\t"F"/)
const incomplete = await run('pcb.preflightAssembly', { ...sample, assignments: { R1: 'smt' } })
assert.deepEqual(incomplete.data.unassigned, ['J2'])
assert.equal(incomplete.data.bom, null)

for (const [secondX, count] of [[3, 2], [1, null], [1.5, null]]) {
  const zip = new JSZip()
  zip.file('top.GTP', '%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,1.0*%\n%LPD*%\nD10*\nX100000Y100000D03*\nX' + Math.round(secondX * 1e5) + 'Y100000D03*\nM02*')
  const result = await run('pcb.preflightAssembly', {
    ...sample, gerberBase64: await zip.generateAsync({ type: 'base64' }),
    pasteRegions: [{ designator: 'J2', side: 'top', minX: 0, minY: 0, maxX: 5, maxY: 2 }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.paste.regions[0].openingCount, count)
  assert.equal(result.data.paste.regions[0].flashCentersMm.length, 2)
}

if (process.argv[2]) {
  const parent = process.argv[2]
  const cp64 = path.join(parent, 'M-20261118-CP64-制造文件复核')
  const cp63 = path.join(parent, 'M-20261118-CP63-丝印归位')
  const read = async (dir, file) => (await fs.readFile(path.join(dir, file))).toString('base64')
  const bomBase64 = await read(cp64, 'M-CP63-BOM-本地复核.tsv')
  const placementBase64 = await read(cp64, 'M-CP63-贴片坐标-本地复核.tsv')
  const gerberBase64 = await read(cp63, 'M-CP63-Gerber-local-review.zip')
  const [, ...placements] = readTable(placementBase64).rows
  const [head, ...material] = readTable(bomBase64).rows
  const supplierParts = new Map(material.flatMap(row => row[head.indexOf('Designator')].split(',').map(ref => [ref, row[head.indexOf('Supplier Part')]])))
  const assignments = Object.fromEntries(placements.map(row => [row[0], /^(?:J\d+|JP1)$/.test(row[0]) ? 'manual' : row[10] === 'T' && row[12] === 'Yes' && /^C\d+$/.test(supplierParts.get(row[0]) ?? '') ? 'smt' : 'omit']))
  const assembly = await run('pcb.preflightAssembly', {
    bomBase64, placementBase64, assignments, gerberBase64,
    // CP63 measured aperture envelope ends at 7.65 mm. The adjacent
    // independent paste region starts at 7.665 mm.
    pasteRegions: [{ designator: 'J2', side: 'top', minX: 0, maxX: 7.657, minY: 144, maxY: 161 }],
  })
  assert.equal(assembly.ok, true, JSON.stringify(assembly.error))
  const expected = readTable(await read(cp64, 'M-CP64-经济型SMT-坐标.tsv')).rows.slice(1).map(row => row[0]).sort()
  assert.equal(expected.length, 136)
  assert.equal(assembly.data.complete, true)
  assert.deepEqual(assembly.data.smtDesignators, expected)
  assert.equal(assembly.data.bom.designatorCount, 136)
  assert.equal(assembly.data.placement.designatorCount, 136)
  assert.equal(assembly.data.paste.regions[0].openingCount, 9, JSON.stringify(assembly.data.paste))
  const inspected = await run('pcb.inspectManufacturingPackage', { base64: gerberBase64 })
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error))
  assert.equal(inspected.data.drill.uniquePositions, 316)
  assert.equal(inspected.data.drill.overlaps[0].count, 251)
  assert.equal(inspected.data.outline.status, 'closed')
  assert.ok(Math.abs(inspected.data.outline.width - 84.5) < 1e-8 && Math.abs(inspected.data.outline.height - 52.5) < 1e-8)
  const selectedFiles = JSON.parse(await fs.readFile(path.join(cp64, 'fabrication-layer-list.json'), 'utf8'))
  const selected = await run('pcb.inspectManufacturingPackage', { base64: gerberBase64, selectedFiles, includeSelectedArchive: true })
  assert.equal(selected.ok, true, JSON.stringify(selected.error))
  const originalZip = await JSZip.loadAsync(gerberBase64, { base64: true })
  const selectionZip = await JSZip.loadAsync(selected.data.selectedArchiveBase64, { base64: true })
  assert.equal(selectedFiles.length, 11)
  assert.deepEqual(Object.values(selectionZip.files).filter(file => !file.dir).map(file => file.name).sort(), [...selectedFiles].sort())
  for (const name of selectedFiles) assert.deepEqual(await selectionZip.file(name).async('uint8array'), await originalZip.file(name).async('uint8array'))
  globalThis.eda.pcb_ManufactureData = {
    getPickAndPlaceFile: async () => new File([Buffer.from(placementBase64, 'base64')], 'placement', { type: 'text/csv' }),
    getGerberFile: async (...args) => {
      assert.deepEqual(args[5], [{ layerId: 1, isMirror: false }])
      return new File([Buffer.from(gerberBase64, 'base64')], 'original.zip')
    },
  }
  globalThis.eda.pcb_Layer = { getAllLayers: async () => [{ id: 1 }] }
  const exported = await run('pcb.exportPickPlace', {})
  assert.equal(exported.ok, true, JSON.stringify(exported.error))
  assert.equal(exported.data.fileName, 'placement.tsv')
  assert.equal(exported.data.encoding, 'utf-16le')
  assert.equal(exported.data.delimiter, '\t')
  assert.equal(exported.data.base64, placementBase64)
  const gerber = await run('pcb.exportGerber', { layerIds: [1] })
  assert.equal(gerber.ok, true, JSON.stringify(gerber.error))
  assert.ok(gerber.data.files.some(file => file.layer === 'GDL' && file.role === 'reference'))
  console.log('PASS CP64 assembly 136/136, J2 paste 9, outline 84.5 × 52.5 mm, unique drills 316, shared drills 251, selected entries 11')
}
console.log('PASS isolated command fixtures: target, line split, interruption, and assembly')
