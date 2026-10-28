import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "export { selectDsnPadPhysicalViews } from '../src/engine/dsnPadPhysicalView.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'dsn-pad-physical-view-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { selectDsnPadPhysicalViews } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const identity = (componentId = 'cmp', localPadId = 'e7') => ({ componentId, localPadId })
const candidate = (shape, overrides = {}) => ({ ...identity(), centerMil: [100, 200], rotationDegrees: 0, shape, ...overrides })
const circle = diameter => `(shape(circle TopLayer ${diameter} 0 0)) (shape(circle BottomLayer ${diameter} 0 0))`
const rotate = ([x, y], degrees) => { const a = degrees * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] }
function rectPoints(width, height, angle = 0) {
	return [[-width / 2, -height / 2], [-width / 2, height / 2], [width / 2, height / 2], [width / 2, -height / 2]].map(point => rotate(point, angle).map(value => (Math.round(value * 100) / 100).toFixed(2)))
}
function ovalPoints(width, height, angle = 0, intervals = 12) {
	const long = Math.max(width, height); const short = Math.min(width, height); const radius = short / 2; const axis = (long - short) / 2; const vertical = height > width
	const points = []
	for (let i = 0; i <= intervals; i++) { const a = (-90 + i * 180 / intervals) * Math.PI / 180; points.push([axis + radius * Math.cos(a), radius * Math.sin(a)]) }
	for (let i = 0; i <= intervals; i++) { const a = (90 + i * 180 / intervals) * Math.PI / 180; points.push([-axis + radius * Math.cos(a), radius * Math.sin(a)]) }
	return points.map(point => rotate(vertical ? [-point[1], point[0]] : point, angle).map(value => (Math.round(value * 100) / 100).toFixed(2)))
}
const polygon = (layer, points, width = 0.1) => `(shape(polygon ${layer} ${width} ${points.flat().join(' ')}))`
function dsn({ pins = ['(pin pstack cmp7 100 200)'], stacks = [`(padstack pstack ${circle(32.13)})`], place = '(place u1 0 0 front 0)', extra = '' } = {}) {
	return `(PCB "" (resolution mil 1000) (placement (component u1 ${place})) (library (image u1 ${pins.join(' ')}) ${stacks.join(' ')} ${extra}))`
}
function selected(report, face = 'top') { assert.equal(report.selections[0][face].state, 'selected', report.selections[0][face].state === 'unknown' ? report.selections[0][face].reason : ''); return report.selections[0][face] }
const normal = selectDsnPadPhysicalViews({ dsnText: dsn(), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 })] })
assert.equal(normal.complete, true)
assert.equal(selected(normal).dsn.shapeKind, 'circle')
assert.equal(selected(normal).dsn.padstackName, 'pstack')

const actualRangeABytes = await readFile(resolve(root, 'test/fixtures/b2-native-rangeA.dsn'))
assert.equal(createHash('sha256').update(actualRangeABytes).digest('hex').toUpperCase(), '38184DC7F11E31E2F08A8CFA12B0BE3F7A49800E24ADB9B2D938CD1A08996881', 'checked-in native DSN fixture preserves the verified source export bytes')
const actualRangeA = actualRangeABytes.toString('utf8')
const actualRangeASelection = selectDsnPadPhysicalViews({
	dsnText: actualRangeA,
	candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, { ...identity('b291000000000001', 'e7'), centerMil: [550, 329.66] })],
})
assert.equal(actualRangeASelection.selections[0].top.state, 'selected', 'real v111 rangeA pin uses its second pin token as source identity')
assert.equal(actualRangeASelection.selections[0].top.dsn.padstackName, 'p51611a06d79522747', 'real rangeA pin may refer to a shared stack from another source PAD')
assert.equal(actualRangeASelection.selections[0].top.dsn.method, 'native-dsn-outer-shape-selection')
assert.equal(actualRangeASelection.selections[0].top.dsn.evidence, 'dsn-export-derived')
assert.equal(actualRangeASelection.selections[0].top.dsn.hostCad, 'EasyEDA Pro')
assert.equal(actualRangeASelection.selections[0].top.dsn.hostVersion, '4.1.78')
assert.deepEqual(actualRangeASelection.selections[0].top.dsn.quantization, { gridMil: 0.01, halfStepMil: 0.005 })

const sharedStack = selectDsnPadPhysicalViews({
	dsnText: dsn({ pins: ['(pin pstack cmp7 100 200)', '(pin pstack other8 300 400)'] }),
	candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }), candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, { ...identity('other', 'e8'), centerMil: [300, 400] })],
})
assert.equal(sharedStack.complete, true, 'different pin identities may share one padstack')

const duplicatePin = selectDsnPadPhysicalViews({ dsnText: dsn({ pins: ['(pin pstack cmp7 100 200)', '(pin pstack cmp7 100 200)'] }), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 })] })
assert.equal(duplicatePin.selections[0].top.state, 'unknown')
const missingStack = selectDsnPadPhysicalViews({ dsnText: dsn({ pins: ['(pin missing cmp7 100 200)'] }), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 })] })
assert.equal(missingStack.selections[0].top.state, 'unknown')

const collided = selectDsnPadPhysicalViews({
	dsnText: dsn({ pins: ['(pin pstack ab12 100 200)'] }),
	candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, identity('ab1', 'e2')), candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, identity('ab', 'e12'))],
	identityUniverse: [identity('ab1', 'e2'), identity('ab', 'e12')],
})
assert.ok(collided.selections.every(item => item.top.state === 'unknown'), 'full component/local identities detect concatenated pin-name collision')
for (const localPadId of ['e0', 'e07', 'e']) {
	const invalid = selectDsnPadPhysicalViews({ dsnText: dsn(), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, identity('cmp', localPadId))] })
	assert.equal(invalid.complete, false, `noncanonical identity ${localPadId} is rejected`)
}

const wrongCenter = selectDsnPadPhysicalViews({ dsnText: dsn({ pins: ['(pin pstack cmp7 100.01 200)'] }), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 })] })
assert.equal(wrongCenter.selections[0].top.state, 'unknown', 'pin center beyond 0.005 mil plus pure floating allowance is rejected')
const halfGrid = selectDsnPadPhysicalViews({ dsnText: dsn(), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }, { centerMil: [100.005, 200] })] })
assert.equal(halfGrid.selections[0].top.state, 'selected')
for (const place of ['(place u1 1 0 front 0)', '(place u1 0 0 back 0)', '(place u1 0 0 front 37)', '(place u1 0 0 front 0 (pin cmp7 90))']) {
	const invalid = selectDsnPadPhysicalViews({ dsnText: dsn({ place }), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 })] })
	assert.equal(invalid.selections[0].top.state, 'unknown', `unsupported placement rejected: ${place}`)
}

const rect = { padType: 'RECT', widthMil: 20, heightMil: 10, radiusMil: 0 }
const rectShape = `(padstack pstack ${polygon('TopLayer', rectPoints(20, 10).map(point => point.map(Number)))} ${polygon('BottomLayer', rectPoints(20, 10).map(point => point.map(Number)))})`
const rectMatch = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [rectShape] }), candidates: [candidate(rect), candidate({ padType: 'OVAL', widthMil: 20, heightMil: 10 })] })
assert.equal(selected(rectMatch).shape.padType, 'RECT', 'same bbox RECT and OVAL shapes are distinguished by complete point sequence')
const rotatedPoints = rectPoints(20, 10, 37).map(point => point.map(Number))
const rotated = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [`(padstack pstack ${polygon('TopLayer', rotatedPoints)} ${polygon('BottomLayer', rotatedPoints)})`] }), candidates: [candidate(rect, { rotationDegrees: 37 })] })
assert.equal(selected(rotated).shape.padType, 'RECT', '37-degree pad rotation is compared directly without face flipping')

const oval = { padType: 'OVAL', widthMil: 26, heightMil: 14 }
const sequence = ovalPoints(26, 14).slice(7).concat(ovalPoints(26, 14).slice(0, 7)).reverse()
const ovalStack = `(padstack pstack ${polygon('TopLayer', sequence)} ${polygon('BottomLayer', sequence)})`
const ovalMatch = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [ovalStack] }), candidates: [candidate(oval)] })
assert.equal(selected(ovalMatch).shape.padType, 'OVAL', '26-point capsule sequence permits cyclic start and reversed direction only')
const oval28 = { padType: 'OVAL', widthMil: 50.125, heightMil: 26.45 }
const oval28Stack = `(padstack pstack ${polygon('TopLayer', ovalPoints(50.125, 26.45, 0, 13))} ${polygon('BottomLayer', ovalPoints(50.125, 26.45, 0, 13))})`
const oval28Match = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [oval28Stack] }), candidates: [candidate(oval28)] })
assert.equal(selected(oval28Match).shape.padType, 'OVAL', '28-point capsule sequence uses the separately evidenced 13-interval half-circle pattern')
const verticalOval28 = { padType: 'OVAL', widthMil: 26.45, heightMil: 50.125 }
const verticalOval28Points = ovalPoints(26.45, 50.125, 0, 13)
const verticalOval28Stack = `(padstack pstack ${polygon('TopLayer', verticalOval28Points)} ${polygon('BottomLayer', verticalOval28Points)})`
assert.equal(selected(selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [verticalOval28Stack] }), candidates: [candidate(verticalOval28)] })).shape.padType, 'OVAL', 'width-smaller-than-height 28-point capsule preserves its vertical long axis')
const points28 = ovalPoints(50.125, 26.45, 0, 13)
for (const [label, changed] of [
	['missing point', points28.slice(1)],
	['non-adjacent duplicate', [...points28, points28[3]]],
	['beyond half-grid error', points28.map((point, index) => index === 8 ? [point[0] + 0.01, point[1]] : point)],
	['unsupported 14-interval sampling', ovalPoints(50.125, 26.45, 0, 14)],
]) {
	const invalidStack = `(padstack pstack ${polygon('TopLayer', changed)} ${polygon('BottomLayer', changed)})`
	const invalid = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [invalidStack] }), candidates: [candidate(oval28)] })
	assert.equal(invalid.selections[0].top.state, 'unknown', `${label} remains unknown rather than being approximated`)
}

for (const [label, stack] of [
	['wrong aperture', `(padstack pstack ${polygon('TopLayer', rectPoints(20, 10).map(point => point.map(Number)), 0.2)} ${polygon('BottomLayer', rectPoints(20, 10).map(point => point.map(Number)), 0.2)})`],
	['missing polygon vertex', `(padstack pstack (shape(polygon TopLayer 0.1 -10 -5 -10 5 10 5)) (shape(circle BottomLayer 20 0 0)))`],
	['missing bottom face', `(padstack pstack ${polygon('TopLayer', rectPoints(20, 10).map(point => point.map(Number)))})`],
]) {
	const invalid = selectDsnPadPhysicalViews({ dsnText: dsn({ stacks: [stack] }), candidates: [candidate(rect)] })
	assert.equal(invalid.selections[0][label === 'missing bottom face' ? 'bottom' : 'top'].state, 'unknown', `${label} is rejected conservatively`)
}

const nearAmbiguity = selectDsnPadPhysicalViews({ dsnText: dsn(), candidates: [candidate({ padType: 'ELLIPSE', widthMil: 32.125, heightMil: 32.125 }), candidate({ padType: 'ELLIPSE', widthMil: 32.126, heightMil: 32.126 })] })
assert.equal(nearAmbiguity.selections[0].top.state, 'unknown', 'one 0.01 mil DSN circle matching multiple full-precision candidates is ambiguous')

console.log('DSN pad physical view regression passed')
