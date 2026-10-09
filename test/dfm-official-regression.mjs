import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)
function loadTs(file) {
  const absolute = resolve(root, file)
  const compiled = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const localRequire = id => id.startsWith('.') ? loadTs(resolve(dirname(absolute).slice(root.length + 1), id.endsWith('.ts') ? id : `${id}.ts`)) : nodeRequire(id)
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports)
  return module.exports
}
const { runOfficialDfm, UPSTREAM_INFO, DFM_COVERAGE } = loadTs('src/dfm/official.ts')
let checks = 0
async function check(name, fn) { await fn(); checks++; console.log(`ok ${checks} - ${name}`) }

function physSource(ids = [1, 2, 15, 16], thicknesses = {}) {
  return ids.map((id) => `${JSON.stringify({ type: 'LAYER_PHYS', id: JSON.stringify(['LAYER_PHYS', id]) })}||${JSON.stringify({ material: 'Copper', thickness: thicknesses[id] ?? (id < 15 ? 2.756 : 1.378) })}|`).join('\n')
}
const defaultPhys = physSource()
function makeSdk({ source = defaultPhys, sourceError, sourceErrorAfterReads, layerCount = 4, layerRows, nets = [], netRead, pads = [], lines = [], lineIds, padIds, outline = false, primitiveGetAllResult } = {}) {
  let sourceReads = 0
  const base = {
    sys_Unit: { mmToMil: mm => mm * 39.37007874, milToMm: mil => mil / 39.37007874 },
    sys_FileManager: { getDocumentSource: async () => { sourceReads++; if (sourceError || (sourceErrorAfterReads !== undefined && sourceReads > sourceErrorAfterReads)) throw sourceError ?? new Error('source denied after required read'); return source } },
    pcb_Layer: { getTheNumberOfCopperLayers: async () => layerCount, getAllLayers: async () => layerRows ?? [
      { id: 1, type: 'SIGNAL', layerStatus: 1 }, { id: 15, type: 'PLANE', layerStatus: 1 },
      { id: 16, type: 'SIGNAL', layerStatus: 2 }, { id: 2, type: 'SIGNAL', layerStatus: 1 },
    ] },
    pcb_Net: { getAllNetsName: async () => nets, getAllPrimitivesByNet: async name => { if (netRead) return netRead(name); return pads } },
  }
  return new Proxy(base, { get(target, key) {
    if (key in target) return target[key]
    if (key === 'pcb_Primitive') return { getPrimitivesBBox: async () => ({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }) }
    if (String(key).startsWith('pcb_Primitive')) return {
      getAll: async (_filter, layer) => {
        if (primitiveGetAllResult !== undefined && String(key) === 'pcb_PrimitiveLine' && layer === undefined) return typeof primitiveGetAllResult === 'function' ? primitiveGetAllResult() : primitiveGetAllResult
        if (String(key) === 'pcb_PrimitivePolyline' && layer === 11 && outline) return [{ id: 'outline' }]
        if (String(key) === 'pcb_PrimitivePad') return pads
        if (String(key) === 'pcb_PrimitiveLine') return lines
        return []
      },
      getAllPrimitiveId: async () => String(key) === 'pcb_PrimitiveLine' ? lineIds ?? lines.map((line, i) => line.getState_PrimitiveId?.() ?? `l${i}`) : padIds ?? pads.map((pad, i) => pad.getState_PrimitiveId?.() ?? `p${i}`),
    }
    return {}
  } })
}
const requiredPcbInputs = { outerCopperOz: 2, innerCopperOz: 1 }
function runPcb(sdk, inputs = {}) { return runOfficialDfm('pcb', { ...requiredPcbInputs, ...inputs }, sdk) }
function pad(id, x, { shape = [0, 10, 10], net = 'GND', layer = 1 } = {}) {
  return { getState_PrimitiveId: () => id, getState_X: () => x, getState_Y: () => 0, getState_Layer: () => layer, getState_Net: () => net, getState_Pad: () => shape, getState_Rotation: () => 0 }
}
function trace(id, layer, widthMm, { x1 = 0, y1 = 0, x2 = 100, y2 = 0, net = '' } = {}) {
  const mil = value => value * 39.37007874
  return { getState_PrimitiveId: () => id, getState_Layer: () => layer, getState_LineWidth: () => mil(widthMm), getState_StartX: () => mil(x1), getState_StartY: () => mil(y1), getState_EndX: () => mil(x2), getState_EndY: () => mil(y2), getState_Net: () => net }
}
function lineIds(line, primitiveId, backupId) {
  line.getState_PrimitiveId = () => primitiveId
  line.getPrimitiveId = () => backupId
  return line
}

await check('接口和结果项固定为 PCB18 / SMT7 / spacing1', async () => {
  const sdk = makeSdk()
  const [pcb, smt, spacing] = await Promise.all([
    runPcb(sdk), runOfficialDfm('smt', {}, sdk), runOfficialDfm('spacing', {}, sdk),
  ])
  assert.equal(pcb.expectedCount, 18); assert.equal(pcb.results.length, 18)
  assert.equal(smt.expectedCount, 7); assert.equal(smt.results.length, 7)
  assert.equal(spacing.expectedCount, 1); assert.equal(spacing.results.length, 1)
  assert.equal(pcb.passed, false, 'no-outline fallback and missing geometry must not become a full pass')
})

await check('并行调用材料和板厚互不串值', async () => {
  const sdk = makeSdk()
  const [fr4, copper] = await Promise.all([
    runPcb(sdk, { material: 'FR4', thickness: 1.6 }),
    runPcb(sdk, { material: '铜基板', thickness: 2 }),
  ])
  assert.equal(fr4.results[0].actualValue, 'FR4')
  assert.equal(copper.results[0].actualValue, '铜基板')
  assert.equal(fr4.results[3].actualValue, '1.6mm')
  assert.equal(copper.results[3].actualValue, '2mm')
})

await check('PCB 核心入口拒绝缺失或不支持的下单铜厚参数', async () => {
  const sdk = makeSdk()
  await assert.rejects(runOfficialDfm('pcb', { outerCopperOz: 2 }, sdk), /innerCopperOz/)
  await assert.rejects(runOfficialDfm('pcb', { outerCopperOz: 3, innerCopperOz: 1 }, sdk), /outerCopperOz/)
  await assert.rejects(runOfficialDfm('pcb', { outerCopperOz: Number.NaN, innerCopperOz: 1 }, sdk), /outerCopperOz/)
  await assert.rejects(runOfficialDfm('pcb', { outerCopperOz: 2, innerCopperOz: 2 }, sdk), /innerCopperOz/)
  assert.equal((await runOfficialDfm('spacing', {}, sdk)).complete, true)
})

await check('SMT 首次多引脚焊盘预取拒绝不会空数组假通过', async () => {
  const sdk = makeSdk()
  sdk.pcb_PrimitiveComponent = { getAll: async () => { throw new Error('prefetch denied') } }
  const result = await runOfficialDfm('smt', {}, sdk)
  assert.equal(result.results.length, 7)
  assert.equal(result.complete, false); assert.equal(result.passed, false)
  assert.ok(result.issues.some(issue => issue.code === 'smt_prefetch_failed'))
  assert.ok(result.results.slice(5).every(item => item.result === 'warning'))
})

await check('PCB 源读取拒绝或为空会报告不完整', async () => {
  const baseline = await runPcb(makeSdk({ outline: true }))
  const failed = await runPcb(makeSdk({ sourceError: new Error('source denied'), outline: true }))
  const empty = await runPcb(makeSdk({ source: '', outline: true }))
  assert.ok(failed.issues.some(issue => issue.code === 'sdk_read_failed' && issue.message.includes('getDocumentSource')))
  assert.deepEqual(empty.issues, baseline.issues)
  assert.equal(failed.reportedCopper.status, 'unavailable')
  assert.equal(empty.reportedCopper.status, 'unavailable')
})

await check('仅可选图纸铜厚源读取拒绝不增全局issue，必要读取成功', async () => {
  const baseline = await runPcb(makeSdk({ outline: true }))
  const optionalDenied = await runPcb(makeSdk({ sourceErrorAfterReads: 1, outline: true }))
  assert.deepEqual(optionalDenied.issues, baseline.issues)
  assert.equal(optionalDenied.complete, baseline.complete)
  assert.ok(!optionalDenied.issues.some(issue => issue.code === 'sdk_read_failed' && issue.message.includes('getDocumentSource')))
  assert.equal(optionalDenied.reportedCopper.status, 'unavailable')
  assert.ok(optionalDenied.reportedCopper.messages.some(message => message.includes('source denied')))
})

await check('四层板缺 LAYER_PHYS 只影响图纸铜厚对照，不影响必要检查issues', async () => {
  const result = await runPcb(makeSdk({ source: '' , layerCount: 4 }))
  assert.equal(result.reportedCopper.status, 'unavailable')
  assert.ok(!result.issues.some(issue => issue.code.startsWith('layer_phys')))
})

await check('完整板框下，未用铜层不计入设计层数且 SHOW/HIDDEN SIGNAL/PLANE 可通过源核对', async () => {
  const layerRows = [
    { id: 1, type: 'SIGNAL', layerStatus: 1 }, { id: 15, type: 'PLANE', layerStatus: 1 },
    { id: 16, type: 'SIGNAL', layerStatus: 2 }, { id: 2, type: 'SIGNAL', layerStatus: 1 },
    { id: 17, type: 'PLANE', layerStatus: 0 },
  ]
  const result = await runPcb(makeSdk({ layerRows, layerCount: 4, outline: true }))
  assert.ok(!result.issues.some(issue => issue.code === 'design_copper_layer_count_mismatch'))
  assert.equal(result.reportedCopper.status, 'available')
  assert.equal(result.reportedCopper.matchesTarget, true)
})

await check('完整板框下，外层底铜旁证缺失只在reportedCopper说明', async () => {
  const result = await runPcb(makeSdk({ source: physSource([1, 15, 16]), outline: true }))
  assert.equal(result.reportedCopper.status, 'partial')
  assert.equal(result.reportedCopper.matchesTarget, null)
  assert.ok(result.reportedCopper.messages.some(message => message.includes('2')))
  assert.ok(!result.issues.some(issue => issue.code.includes('layer_phys')))
})

await check('完整板框下，PLANE 内层旁证缺失只在reportedCopper说明', async () => {
  const result = await runPcb(makeSdk({ source: physSource([1, 2, 16]), outline: true }))
  assert.equal(result.reportedCopper.status, 'partial')
  assert.equal(result.reportedCopper.matchesTarget, null)
  assert.ok(result.reportedCopper.messages.some(message => message.includes('15')))
})

await check('完整板框下，图纸铜厚旁证无效只在reportedCopper说明', async () => {
  const result = await runPcb(makeSdk({ source: physSource([1, 2, 15, 16], { 2: 0, 15: 'bad' }), outline: true }))
  assert.equal(result.reportedCopper.status, 'partial')
  assert.equal(result.reportedCopper.matchesTarget, null)
  assert.ok(result.reportedCopper.messages.some(message => message.includes('2')))
  assert.ok(result.reportedCopper.messages.some(message => message.includes('15')))
  assert.ok(!result.issues.some(issue => issue.code.includes('layer_phys')))
})

await check('四层板0.12mm线宽按逐层下单铜厚与设计层数分档', async () => {
  const outerOnly = trace('outer-2oz', 1, 0.12)
  const inner = trace('inner-1oz', 15, 0.12)
  const result = await runPcb(makeSdk({ lines: [outerOnly, inner], outline: true }))
  const width = result.results[11]
  assert.equal(width.result, 'error')
  assert.deepEqual(width.violations.map(item => item.id), ['outer-2oz'])
  assert.ok(width.standardValue.includes('外层2oz最小0.15mm'))
  assert.ok(width.standardValue.includes('内层1oz最小0.09mm'))
  assert.ok(width.standardValue.includes('设计4层'))
  assert.equal(result.results[4].actualValue, '下单外层2oz')
  assert.equal(result.results[4].result, 'success')
  assert.equal(result.results[5].actualValue, '下单内层1oz')
  assert.equal(result.results[5].result, 'success')
})

await check('混合丝印/外层/内层线宽定位按原始列表对齐并保留备用ID', async () => {
  const silk = lineIds(trace('silk', 3, 0.01), 'prim-silk', 'backup-silk')
  const outer = lineIds(trace('outer', 1, 0.12), 'prim-outer', 'backup-outer')
  const inner = lineIds(trace('inner', 15, 0.08), 'prim-inner', 'backup-inner')
  const result = await runPcb(makeSdk({ lines: [silk, outer, inner], lineIds: ['loc-silk', 'loc-outer'], outline: true }))
  assert.deepEqual(result.results[11].violations.map(item => item.id), ['loc-outer', 'backup-inner'])
})

await check('四层板0.12mm线距外层按0.15报错、内层按0.09通过', async () => {
  const lines = [
    trace('outer-a', 1, 0.04, { x2: 1 }), trace('outer-b', 1, 0.04, { y1: 0.16, y2: 0.16, x2: 1 }),
    trace('inner-a', 15, 0.04, { x2: 1 }), trace('inner-b', 15, 0.04, { y1: 0.16, y2: 0.16, x2: 1 }),
  ]
  const result = await runPcb(makeSdk({ lines, outline: true }))
  const spacing = result.results[12]
  assert.equal(spacing.result, 'error')
  assert.deepEqual(spacing.violations.map(item => item.id), ['outer-a'])
  assert.ok(spacing.standardValue.includes('外层2oz最小0.15mm'))
  assert.ok(spacing.standardValue.includes('内层1oz最小0.09mm'))
})

await check('混合丝印/外层/内层线距定位按原始列表对齐并保留备用ID', async () => {
  const silk = lineIds(trace('silk', 3, 0.01), 'prim-silk', 'backup-silk')
  const outerA = lineIds(trace('outer-a', 1, 0.04, { x2: 1 }), 'prim-outer-a', 'backup-outer-a')
  const outerB = lineIds(trace('outer-b', 1, 0.04, { y1: 0.16, y2: 0.16, x2: 1 }), 'prim-outer-b', 'backup-outer-b')
  const innerA = lineIds(trace('inner-a', 15, 0.04, { y1: 1, y2: 1, x2: 1 }), 'prim-inner-a', 'backup-inner-a')
  const innerB = lineIds(trace('inner-b', 15, 0.04, { y1: 1.09, y2: 1.09, x2: 1 }), 'prim-inner-b', 'backup-inner-b')
  const result = await runPcb(makeSdk({ lines: [silk, outerA, outerB, innerA, innerB], lineIds: ['loc-silk', 'loc-outer-a'], outline: true }))
  assert.deepEqual(result.results[12].violations.map(item => item.id), ['loc-outer-a', 'backup-inner-a'])
})

await check('图纸铜厚全0.5oz或无LAYER_PHYS不改变同一线图的项12/13阈值与违规', async () => {
  const lines = [
    trace('outer-width', 1, 0.12), trace('inner-width', 15, 0.12),
    trace('outer-a', 1, 0.04, { x2: 1 }), trace('outer-b', 1, 0.04, { y1: 0.16, y2: 0.16, x2: 1 }),
    trace('inner-a', 15, 0.04, { x2: 1 }), trace('inner-b', 15, 0.04, { y1: 0.16, y2: 0.16, x2: 1 }),
  ]
  const baseline = await runPcb(makeSdk({ lines, outline: true }))
  const halfOz = await runPcb(makeSdk({ source: physSource([1, 2, 15, 16], { 1: 0.689, 2: 0.689, 15: 0.689, 16: 0.689 }), lines, outline: true }))
  const noPhys = await runPcb(makeSdk({ source: '', lines, outline: true }))
  for (const result of [halfOz, noPhys]) {
    for (const itemNumber of [11, 12]) {
      assert.equal(result.results[itemNumber].standardValue, baseline.results[itemNumber].standardValue)
      assert.deepEqual(result.results[itemNumber].violations, baseline.results[itemNumber].violations)
    }
    assert.deepEqual(result.issues, baseline.issues)
    assert.equal(result.complete, baseline.complete)
  }
  assert.equal(halfOz.reportedCopper.matchesTarget, false)
  assert.equal(noPhys.reportedCopper.status, 'unavailable')
})

await check('双层板0.12mm外线宽按下单1oz/2oz分别取0.10/0.16', async () => {
  const layerRows = [{ id: 1, type: 'SIGNAL', layerStatus: 1 }, { id: 2, type: 'SIGNAL', layerStatus: 1 }]
  const sdk = makeSdk({ source: physSource([1, 2]), layerRows, layerCount: 2, lines: [trace('outer', 1, 0.12)], outline: true })
  const thick = await runPcb(sdk, { outerCopperOz: 2 })
  const thin = await runPcb(sdk, { outerCopperOz: 1 })
  assert.equal(thick.results[11].result, 'error')
  assert.ok(thick.results[11].standardValue.includes('外层2oz最小0.16mm'))
  assert.equal(thin.results[11].result, 'success')
  assert.ok(thin.results[11].standardValue.includes('外层1oz最小0.1mm'))
  assert.equal(thick.results[5].actualValue, '无内层')
  assert.equal(thick.results[5].standardValue, '不适用')
})

await check('四层板仅外层有走线仍按设计四层档，未知设计层数不落入双层档', async () => {
  const outerOnly = await runPcb(makeSdk({ lines: [trace('outer', 1, 0.12)], outline: true }))
  assert.equal(outerOnly.results[11].result, 'error')
  assert.ok(outerOnly.results[11].standardValue.includes('设计4层'))
  const unknownCount = await runPcb(makeSdk({ layerCount: Number.NaN, lines: [trace('outer', 1, 0.12)], outline: true }))
  assert.equal(unknownCount.results[11].result, 'error')
  assert.ok(unknownCount.results[11].standardValue.includes('设计4层'))
  assert.ok(unknownCount.issues.some(issue => issue.code === 'design_copper_layer_count_unavailable' && issue.item === 12))
})

await check('非铜层 Line 被跳过，缺失或未启用铜层身份则记 issue', async () => {
  const layerRows = [
    { id: 1, type: 'SIGNAL', layerStatus: 1 }, { id: 15, type: 'PLANE', layerStatus: 1 },
    { id: 16, type: 'SIGNAL', layerStatus: 2 }, { id: 2, type: 'SIGNAL', layerStatus: 1 },
    { id: 3, type: 'SILKSCREEN', layerStatus: 1 }, { id: 11, type: 'BOARD_OUTLINE', layerStatus: 1 },
  ]
  const nonCopper = await runPcb(makeSdk({ layerRows, lines: [trace('silkscreen-line', 3, 0.01)], outline: true }))
  assert.equal(nonCopper.results[11].result, 'success')
  assert.deepEqual(nonCopper.results[11].violations, [])
  const disabledRows = layerRows.map(row => row.id === 15 ? { ...row, layerStatus: 0 } : row)
  const disabled = await runPcb(makeSdk({ layerRows: disabledRows, lines: [trace('disabled-inner', 15, 0.01)], outline: true }))
  assert.ok(disabled.issues.some(issue => issue.code === 'line_copper_layer_unverified' && issue.message.includes('15')))
  assert.equal(disabled.complete, false)
  const missingLayer = trace('unknown-layer', 1, 0.01)
  missingLayer.getState_Layer = () => undefined
  const unknown = await runPcb(makeSdk({ lines: [missingLayer], outline: true }))
  assert.ok(unknown.issues.some(issue => issue.code === 'line_layer_identity_unknown' && issue.item === 12))
  const unsupported = await runPcb(makeSdk({ lines: [trace('zero-layer', 0, 0.01), trace('unknown-layer-999', 999, 0.01)], outline: true }))
  assert.ok(unsupported.issues.some(issue => issue.code === 'line_layer_identity_unknown' && issue.message.includes('0')))
  assert.ok(unsupported.issues.some(issue => issue.code === 'line_layer_identity_unknown' && issue.message.includes('999')))
})

await check('HDI 的2oz外层不受支持会由项5报告，图纸目标差异只进reportedCopper', async () => {
  const source = physSource([1, 2, 15, 16], { 1: 1.378, 2: 1.378, 15: 0.689, 16: 0.689 })
  const result = await runPcb(makeSdk({ source, outline: true }), { material: 'HDI板' })
  assert.equal(result.results[4].result, 'error')
  assert.equal(result.reportedCopper.matchesTarget, false)
  assert.equal(result.reportedCopper.differences.length, 4)
  const baseline = await runPcb(makeSdk({ outline: true }))
  assert.equal(result.complete, baseline.complete)
  assert.deepEqual(result.issues, baseline.issues)
})

await check('完整板框下 getAll 返回 null 或 undefined 会记 issue 并按读取失败处理', async () => {
  for (const invalid of [null, () => undefined]) {
    const result = await runPcb(makeSdk({ outline: true, primitiveGetAllResult: invalid }))
    assert.equal(result.complete, false)
    assert.ok(result.issues.some(issue => issue.code === 'sdk_read_invalid_result' && issue.message.includes('pcb_PrimitiveLine.getAll')))
  }
})

await check('有效同网间距能完整通过', async () => {
  const p1 = pad('p1', 0), p2 = pad('p2', 100)
  const result = await runOfficialDfm('spacing', {}, makeSdk({ pads: [p1, p2] }))
  assert.equal(result.results[0].result, 'success')
  assert.equal(result.complete, true); assert.equal(result.passed, true)
})
await check('同网距离的网络部分失败被保留为 issue', async () => {
  const p1 = pad('p1', 0)
  const sdk = makeSdk({ nets: ['GND', 'VCC'], pads: [p1], netRead: async name => { if (name === 'VCC') throw new Error('net read'); return [p1] } })
  const result = await runOfficialDfm('spacing', {}, sdk)
  assert.equal(result.complete, false)
  assert.ok(result.issues.some(issue => issue.code === 'network_partial_failure'))
})

await check('PCB 网络列表部分失败及 pad 尺寸缺失进入 issues', async () => {
  const incompletePad = pad('p-incomplete', 10, { shape: null })
  const sdk = makeSdk({ nets: ['GND', 'VCC'], pads: [incompletePad], netRead: async name => { if (name === 'VCC') throw new Error('partial net'); return [incompletePad] } })
  const result = await runPcb(sdk)
  assert.equal(result.results.length, 18)
  assert.ok(result.issues.some(issue => issue.code === 'network_partial_failure' && issue.item === 14))
  assert.ok(result.issues.some(issue => issue.code === 'pad_shape_missing' && issue.item === 14))
  assert.equal(result.complete, false)
})
await check('焊盘缺少尺寸或网络不会当作无适用焊盘通过', async () => {
  const sdk = makeSdk({ pads: [pad('missing-size', 0, { shape: null }), pad('missing-net', 20, { net: '' })] })
  const result = await runOfficialDfm('spacing', {}, sdk)
  assert.equal(result.complete, false)
  assert.ok(result.issues.some(issue => issue.code === 'pad_shape_missing'))
  assert.ok(result.issues.some(issue => issue.code === 'pad_net_missing'))
})

await check('无板框时全图元包围盒回退被标记', async () => {
  const result = await runPcb(makeSdk({ outline: false }))
  assert.ok(result.issues.some(issue => issue.code === 'board_outline_inferred'))
  assert.equal(result.complete, false)
})

await check('异网 Line 与 pad 接触时沿用上游相接网络推断并跳过线距', async () => {
  const p = pad('p1', 0, { shape: ['RECT', 10, 10], net: '' })
  const line = { getState_PrimitiveId: () => 'l1', getState_Net: () => 'VCC', getState_Layer: () => 1, getState_LineWidth: () => 2, getState_StartX: () => -20, getState_StartY: () => 0, getState_EndX: () => 20, getState_EndY: () => 0 }
  const sdk = makeSdk({ pads: [p] })
  sdk.pcb_PrimitiveLine = { getAll: async () => [line] }
  const result = await runPcb(sdk)
  assert.equal(result.results[13].result, 'success')
  assert.deepEqual(result.results[13].violations, [])
  assert.ok(DFM_COVERAGE[0].includes('接触'))
})

await check('长圆焊盘焊环沿最大轴近似，保留窄轴漏检边界', async () => {
  const oval = pad('oval1', 0, { shape: ['OVAL', 31.496, 78.740], net: 'GND' })
  oval.getState_Hole = () => ['CIRCLE', 23.622]
  oval.getState_Metallization = () => true
  const result = await runPcb(makeSdk({ pads: [oval] }))
  assert.equal(result.results[14].result, 'success')
  assert.equal(result.results[14].actualValue, '最小0.700mm')
  assert.ok(DFM_COVERAGE[1].includes('最大轴'))
})

await check('方焊盘按内接圆近似可能漏掉角部间距违规', async () => {
  const square = pad('square', 0, { shape: ['RECT', 43.307, 43.307] })
  const corner = pad('corner', 27.559, { shape: ['ELLIPSE', 7.874, 7.874] })
  corner.getState_Y = () => 27.559
  const result = await runOfficialDfm('spacing', { minSpacingMm: 0.2 }, makeSdk({ pads: [square, corner] }))
  assert.equal(result.results[0].result, 'success', '现有内接圆近似在角部会漏报，此用例锁定上游行为')
  assert.equal(result.results[0].violations?.length, 0)
  assert.ok(DFM_COVERAGE[2].includes('内接圆'))
})
await check('同网焊盘接触或重叠仍按上游几何算法报错，覆盖说明不扩展算法', async () => {
  const p1 = pad('p1', 0), p2 = pad('p2', 6)
  const result = await runOfficialDfm('spacing', { minSpacingMm: 0.1 }, makeSdk({ nets: ['GND'], pads: [p1, p2] }))
  assert.equal(result.results[0].result, 'error')
  assert.ok(DFM_COVERAGE.some(item => item.includes('不含接触')))
  assert.equal(UPSTREAM_INFO.repository, 'https://github.com/easyeda/eext-jlc-order-dfm-checker')
})

await check('工艺标准表与上游文件字节哈希一致', async () => {
  const target = await readFile(resolve(root, 'src/dfm/vendor/standards.ts'))
  assert.equal(createHash('sha256').update(target).digest('hex'), 'a659e5604c5cb93e5b411ffe1969a85b1bb0839954aa967915231dfcbbacd354')
  assert.equal(UPSTREAM_INFO.commit, 'afd538786d510f537ad4fa47c6329e6a99dc7625')
})

console.log(`1..${checks}`)








