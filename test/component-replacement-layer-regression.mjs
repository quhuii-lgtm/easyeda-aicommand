import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const temp = await mkdtemp(join(tmpdir(), 'ace-replacement-layer-'))
try {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/modules/reuse/componentReplacementHost.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  const path = join(temp, 'host.mjs')
  await writeFile(path, result.outputFiles[0].contents)
  const { padHasCopperLayer, assertRouteContactInputs, assertCreatedRouteLine, actualCopperLayers, physicalCopperLayerOrder, verifyPadCopperContact, writeVerifiedLocalRoutes } = await import(pathToFileURL(path))
  assert.equal(padHasCopperLayer({ layer: 1 }, 1), true)
  assert.equal(padHasCopperLayer({ layer: 1 }, 2), false)
  assert.equal(padHasCopperLayer({ layer: 2 }, 2), true)
  assert.equal(padHasCopperLayer({ layer: 2 }, 1), false)
  assert.equal(padHasCopperLayer({ layer: 12, hole: null }, 1), false, 'native no-drill sentinel is exposed as no typed hole')
  assert.equal(padHasCopperLayer({ layer: 12, hole: ['ROUND', 0.8] }, 1), true, 'SDK ROUND hole tuple')
  assert.equal(padHasCopperLayer({ layer: 12, hole: ['SLOT', 0.5, 1.2] }, 2), true, 'SDK plated slot tuple')
  assert.equal(padHasCopperLayer({ layer: 12, hole: null }, 1), false)
  const route = { net: 'N1', layer: 'top', width: 0.2, anchor: { primitiveId: 'L1', endpoint: 'end' }, targetPadNumber: '1', points: [[0,0],[1,1]] }
  const anchor = [{ type: 'LINE', id: 'L1', data: { layerId: 1, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  const top = { number: '1', net: 'N1', layer: 1, x: 1, y: 1, rotation: 0, shape: ['RECT', 0.5, 0.5, 0], hole: null, specialPad: [] }
  const bottomSameNumber = { ...top, id: 'P2', layer: 2 }
  assert.equal(assertRouteContactInputs(route, anchor, [top, bottomSameNumber]), top, 'same pad number on both sides resolves by actual layer')
  assert.equal(assertRouteContactInputs(route, anchor, [top, { ...top, id: 'P3', x: 4, y: 4 }]), top, 'same-layer duplicate numbers resolve by physical contact')
  assert.throws(() => assertRouteContactInputs(route, [{ ...anchor[0], data: { ...anchor[0].data, layerId: 2 } }], [top]), /铜层/)
  assert.throws(() => assertRouteContactInputs(route, anchor, [{ ...top, layer: 2 }]), /铜接触/)
  const legacyCrossLayer = { ...route, layer: 'bottom' }
  const legacyAnchor = [{ type: 'LINE', id: 'L1', data: { layerId: 1, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  // Reproduce PR32-P1C's old proof: geometry and net matched, but it never compared copper layers.
  const legacyPad = { ...top, layer: 1 }
  let legacyContactVerified = false
  try {
    const a = legacyAnchor[0].data
    assert.equal(Math.hypot(legacyCrossLayer.points[0][0] - a.endX, legacyCrossLayer.points[0][1] - a.endY) <= 0.00254, true)
    assert.equal(a.netName, legacyCrossLayer.net)
    verifyPadCopperContact(legacyPad, legacyCrossLayer.points[1])
    legacyContactVerified = true
  } catch {}
  assert.equal(legacyContactVerified, true, 'old contact proof incorrectly accepts top anchor/top SMD for bottom route')
  assert.throws(() => assertRouteContactInputs(legacyCrossLayer, legacyAnchor, [legacyPad]), /铜层/)
  let rejectedCreates = 0
  await assert.rejects(() => writeVerifiedLocalRoutes([legacyCrossLayer], legacyAnchor, [legacyPad], new Set([1,2]), () => {}, async () => { rejectedCreates++; return 'unexpected' }, async () => []), /铜层/)
  assert.equal(rejectedCreates, 0, 'cross-layer route fails preflight before any line create')
  const thRoute = { ...route, layer: 'bottom' }
  const thAnchor = [{ type: 'LINE', id: 'L1', data: { layerId: 2, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  const pth = { ...top, layer: 12, hole: ['ROUND', 0.8] }
  assert.equal(assertRouteContactInputs(thRoute, thAnchor, [pth]), pth, 'verified through-hole reaches outer copper')
  assert.throws(() => assertRouteContactInputs(thRoute, thAnchor, [{ ...pth, hole: null }]), /铜接触/)
  const multilayer = actualCopperLayers([
    { type: 'LAYER', id: JSON.stringify(['LAYER',1]), data: { layerType: 'TOP' } },
    { type: 'LAYER', id: JSON.stringify(['LAYER',2]), data: { layerType: 'BOTTOM' } },
    { type: 'LAYER', id: JSON.stringify(['LAYER',15]), data: { layerType: 'INNER_1' } },
    { type: 'LAYER', id: JSON.stringify(['LAYER',3]), data: { layerType: 'TOP_SILK' } },
  ])
  assert.deepEqual([...multilayer].sort((a,b)=>a-b), [1,2,15])
  assert.equal(padHasCopperLayer(pth, 15, multilayer), true, 'through-hole reaches only layers confirmed as copper')
  assert.throws(() => assertRouteContactInputs({ ...route, layer: 3 }, [{ ...anchor[0], data: { ...anchor[0].data, layerId: 3 } }], [top], multilayer), /实际铜层/)
  const specialRoute = { ...route, points: [[0,0],[1.2,1]] }
  const specialTop = { ...top, layer: 12, hole: ['ROUND', 0.8], specialPad: [[1,1,['RECT',0.1,0.1,0]]] }
  assert.throws(() => assertRouteContactInputs(specialRoute, anchor, [specialTop]), /铜接触/, 'single-layer special shape is used instead of default shape')
  const specialBoth = { ...specialTop, specialPad: [[1,2,['RECT',0.5,0.5,0]]] }
  assert.equal(assertRouteContactInputs(specialRoute, anchor, [specialBoth]), specialBoth, 'explicit top-to-bottom shape range is supported')
  const innerRoute = { ...route, layer: 15 }
  const innerAnchor = [{ type: 'LINE', id: 'L1', data: { layerId: 15, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  const innerSpecialPth = { ...specialBoth, specialPad: [[1,2,['RECT',0.5,0.5,0]]] }
  assert.equal(assertRouteContactInputs(innerRoute, innerAnchor, [innerSpecialPth], multilayer), innerSpecialPth, 'top-to-bottom specialPad range also covers confirmed inner copper')
  const unknownRange = { ...specialTop, specialPad: [[1,15,['RECT',0.5,0.5,0]]] }
  assert.throws(() => assertRouteContactInputs(specialRoute, anchor, [unknownRange], new Set([1,2,15])), /LAYER_PHYS/, 'partial layer range without order is not claimed as contact')
  const physicalRecords = [
    ...[
      [1, 'TOP'], [2, 'BOTTOM'], [15, 'INNER_1'],
    ].map(([id, layerType]) => ({ type: 'LAYER', id: JSON.stringify(['LAYER', id]), data: { layerType } })),
    ...[
      [1, 0], [15, 10], [2, 20],
    ].map(([id, zIndex]) => ({ type: 'LAYER_PHYS', id: JSON.stringify(['LAYER_PHYS', id]), data: { zIndex } })),
  ]
  assert.deepEqual(physicalCopperLayerOrder(physicalRecords, multilayer), [1,15,2], 'order follows zIndex rather than numeric layer IDs')
  const partialSpecial = { ...top, layer: 12, hole: ['ROUND', 0.8], shape: ['RECT',0.1,0.1,0], specialPad: [[1,15,['RECT',0.5,0.5,0]]] }
  const innerPartialRoute = { ...specialRoute, layer: 15 }
  const innerPartialAnchor = [{ type: 'LINE', id: 'L1', data: { layerId: 15, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  assert.equal(assertRouteContactInputs(innerPartialRoute, innerPartialAnchor, [partialSpecial], multilayer, physicalRecords), partialSpecial,
    'partial range includes the physical inner layer even though its numeric ID exceeds the bottom ID')
  const bottomPartialRoute = { ...specialRoute, layer: 'bottom' }
  const bottomPartialAnchor = [{ type: 'LINE', id: 'L1', data: { layerId: 2, startX: -1, startY: 0, endX: 0, endY: 0, netName: 'N1' } }]
  assert.throws(() => assertRouteContactInputs(bottomPartialRoute, bottomPartialAnchor, [partialSpecial], multilayer, physicalRecords), /铜接触/,
    'numeric ID 2 lies between 1 and 15 numerically but below layer 15 physically')
  const missingZ = physicalRecords.filter(row => row.id !== JSON.stringify(['LAYER_PHYS', 15]))
  assert.equal(physicalCopperLayerOrder(missingZ, multilayer), undefined)
  assert.throws(() => assertRouteContactInputs(innerPartialRoute, innerPartialAnchor, [partialSpecial], multilayer, missingZ), /LAYER_PHYS/)
  const duplicateZ = physicalRecords.map(row => row.type === 'LAYER_PHYS' && row.id === JSON.stringify(['LAYER_PHYS', 15]) ? { ...row, data: { zIndex: 0 } } : row)
  assert.equal(physicalCopperLayerOrder(duplicateZ, multilayer), undefined)
  assert.throws(() => assertRouteContactInputs(innerPartialRoute, innerPartialAnchor, [partialSpecial], multilayer, duplicateZ), /LAYER_PHYS/)
  assertCreatedRouteLine({ layerId: 1, netName: 'N1', startX: 0, startY: 0, endX: 1, endY: 1 }, route, 1)
  assert.throws(() => assertCreatedRouteLine({ layerId: 2, netName: 'N1', startX: 0, startY: 0, endX: 1, endY: 1 }, route, 1), /实际层/)
  assert.throws(() => assertCreatedRouteLine({ layerId: 1, netName: 'N2', startX: 0, startY: 0, endX: 1, endY: 1 }, route, 1), /实际层/)
  const validLine = { layerId: 1, netName: 'N1', startX: 0, startY: 0, endX: 1, endY: 1 }
  for (const invalid of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
    assert.throws(() => assertCreatedRouteLine({ ...validLine, startX: invalid }, route, 1), /有效数值坐标/, `invalid LINE coordinate ${String(invalid)}`)
    assert.throws(() => assertCreatedRouteLine({ ...validLine, endY: invalid }, route, 1), /有效数值坐标/, `invalid LINE coordinate ${String(invalid)}`)
    assert.throws(() => assertRouteContactInputs(route, [{ ...anchor[0], data: { ...anchor[0].data, endX: invalid } }], [top]), /有效数值坐标/, `invalid anchor coordinate ${String(invalid)}`)
    assert.throws(() => assertRouteContactInputs(route, [{ ...anchor[0], data: { ...anchor[0].data, endY: invalid } }], [top]), /有效数值坐标/, `invalid anchor coordinate ${String(invalid)}`)
  }
  let createCount = 0
  const routeLines = []
  const ids = await writeVerifiedLocalRoutes([route], anchor, [top], new Set([1,2]), () => {}, async (_route, segment) => {
    createCount++
    const start = route.points[segment - 1], end = route.points[segment]
    const id = `line-${createCount}`
    routeLines.push({ type: 'LINE', id, data: { layerId: 1, netName: 'N1', startX: start[0], startY: start[1], endX: end[0], endY: end[1] } })
    return id
  }, async () => routeLines)
  assert.deepEqual(ids, ['line-1'])
  assert.equal(createCount, 1)
  let firstWriteRelease
  const firstWriteGate = new Promise(resolve => { firstWriteRelease = resolve })
  let stopAfterFirstWrite = false, lateWriteCount = 0
  const twoSegments = { ...route, points: [[0,0],[0.5,0.5],[1,1]] }
  const lateWrite = writeVerifiedLocalRoutes([twoSegments], anchor, [top], new Set([1,2]), () => { if (stopAfterFirstWrite) throw new Error('stop latched') }, async (_route, segment) => {
    lateWriteCount++
    if (segment === 1) await firstWriteGate
    return `late-${segment}`
  }, async () => [])
  await new Promise(resolve => setTimeout(resolve, 10))
  stopAfterFirstWrite = true
  firstWriteRelease()
  await assert.rejects(() => lateWrite, /stop latched/)
  assert.equal(lateWriteCount, 1, 'stop after a delayed segment prevents the next dependent line create')
  console.log('PASS route checks verify actual copper layer, SMD/through-hole/special shapes, pad-number disambiguation and created-line readback')
} finally { await rm(temp, { recursive: true, force: true }) }

