import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: {
		contents: `export { schematicCommands } from '../src/commands/schematic.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-wire-attribute-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { schematicCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = name => schematicCommands.find(item => item.name === name).handler
const modifyWire = command('schematic.modifyWire')
const setAttribute = command('schematic.setAttribute')
const listComponents = command('schematic.listComponents')
const structuralAudit = command('schematic.structuralAudit')
const pruneFloatingLabels = command('schematic.pruneFloatingLabels')
const fixNetLabels = command('schematic.fixNetLabels')
const exportPng = command('schematic.exportPng')
const sourceLineTypeByGetter = { 0: 'SOLID', 1: 'SHORT_DASH', 2: 'DOT' }
const getterLineTypeBySource = Object.fromEntries(Object.entries(sourceLineTypeByGetter).map(([getter, source]) => [source, Number(getter)]))

const originalTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, ms, ...args) => ms === 400 || ms === 300
	? (queueMicrotask(() => callback(...args)), 0)
	: originalTimeout(callback, ms, ...args)

function wire(id, state = {}) {
	const current = {
		color: Object.hasOwn(state, 'color') ? state.color : '#000000',
		lineWidth: Object.hasOwn(state, 'lineWidth') ? state.lineWidth : 6,
		lineType: Object.hasOwn(state, 'lineType') ? state.lineType : 0,
		net: Object.hasOwn(state, 'net') ? state.net : 'SIG',
		line: Object.hasOwn(state, 'line') ? state.line : [0, 0, 10, 0],
	}
	return {
		getState_PrimitiveId: () => id,
		getState_Color: () => current.color,
		getState_LineWidth: () => current.lineWidth,
		getState_LineType: () => current.lineType,
		getState_Net: () => current.net,
		getState_Line: () => current.line,
		current,
	}
}

function makeWireEda({ result = {}, apply = true, ids = ['wire-1'], nets = {}, styles = {}, onModify, nameOnlyIds = [], apiNameIds = [], apiNameValueOverrides = {}, sourceNetStale = false, sourceStyleStale = [], sourceLineTypeOverrides = {}, churnAttrIdOnModify = [], churnLineIdOnModify = [], nullOmittedStyles = false, emptyNetAttrs = [], sourceAttrFailure = null, displayDriftOnModify = [], endpointDriftOnModify = [], malformedSourceEndpoints = {}, damageEarlierOnSecondModify = false, restoreObjects = true } = {}) {
	const objects = new Map(ids.map(id => [id, wire(id, { ...styles[id], net: Object.hasOwn(nets, id) ? nets[id] : 'SIG' })]))
	const sourceNets = new Map([...objects].map(([id, object]) => [id, object.current.net]))
	const netAttrPresent = new Map([...objects].map(([id, object]) => [id, (typeof object.current.net === 'string' && object.current.net !== '') || emptyNetAttrs.includes(id)]))
	const duplicateNetAttrs = new Set()
	const attrDisplays = new Map([...objects].map(([id, object]) => [id, object.current.net]))
	const endpointOverrides = new Map()
	const sourceStyles = new Map([...objects].map(([id, object]) => [id, {
		strokeColor: object.current.color,
		strokeWidth: object.current.lineWidth,
		strokeStyle: Object.hasOwn(sourceLineTypeOverrides, id) ? sourceLineTypeOverrides[id] : sourceLineTypeByGetter[object.current.lineType] ?? object.current.lineType,
	}]))
	let modifyCalls = 0
	const calls = []
	let sourceOverride
	let sourceReads = 0
	const attrIdOverrides = new Map()
	const lineIdOverrides = new Map()
	const sourceFor = () => {
		if (sourceOverride != null) return sourceOverride
		sourceReads++
		const records = [`{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'SCH', uuid: 'doc-1', client: `client-${sourceReads}`, updateTime: sourceReads, version: sourceReads })}`]
		let ticket = 1
		for (const [id, object] of objects) {
			records.push(`${JSON.stringify({ type: 'WIRE', id, ticket: ticket++ })}||${JSON.stringify({ line: object.current.line ?? [0, 0, 10, 0] })}`)
			if (netAttrPresent.get(id)) records.push(`${JSON.stringify({ type: 'ATTR', id: attrIdOverrides.get(id) ?? `attr-${id}`, ticket: ticket++ })}||${JSON.stringify({ parentId: id, key: nameOnlyIds.includes(id) ? 'Name' : 'NET', value: sourceNets.get(id), display: attrDisplays.get(id) })}`)
			if (duplicateNetAttrs.has(id)) records.push(`${JSON.stringify({ type: 'ATTR', id: `attr-${id}-duplicate`, ticket: ticket++ })}||${JSON.stringify({ parentId: id, key: 'NET', value: sourceNets.get(id), display: attrDisplays.get(id) })}`)
			const sourceStyle = sourceStyles.get(id)
			const endpoints = { ...(endpointOverrides.get(id) ?? { startX: 0, startY: 0, endX: 10, endY: 0 }) }
			if (malformedSourceEndpoints[id] === 'missing') delete endpoints.startX
			if (malformedSourceEndpoints[id] === 'nonfinite') endpoints.endY = Number.POSITIVE_INFINITY
			records.push(`${JSON.stringify({ type: 'LINE', id: lineIdOverrides.get(id) ?? `line-${id}`, ticket: ticket++ })}||${JSON.stringify({ ...sourceStyle, ...endpoints, lineGroup: id })}`)
		}
		return records.join('\n')
	}
	const restoreFromSource = value => {
		const records = value.split(/\r?\n/).filter(Boolean).map(line => {
			const separator = line.indexOf('||')
			return { header: JSON.parse(line.slice(0, separator)), data: JSON.parse(line.slice(separator + 2).replace(/\|$/, '')) }
		})
		for (const [id, object] of objects) {
			const netRecord = records.find(record => record.header.type === 'ATTR' && record.data.parentId === id && record.data.key === 'NET')
			const net = netRecord?.data.value ?? ''
			const lines = records.filter(record => record.header.type === 'LINE' && record.data.lineGroup === id)
			const sourceStyle = sourceStyles.get(id)
			const line = lines[0]?.data
			sourceNets.set(id, net)
			netAttrPresent.set(id, !!netRecord)
			attrDisplays.set(id, netRecord?.data.display ?? net)
			duplicateNetAttrs.delete(id)
			object.current.net = net
			if (line) {
				object.current.color = line.strokeColor
				object.current.lineWidth = line.strokeWidth
				object.current.lineType = getterLineTypeBySource[line.strokeStyle] ?? line.strokeStyle
				object.current.line = [line.startX, line.startY, line.endX, line.endY]
				Object.assign(sourceStyle, { strokeColor: line.strokeColor, strokeWidth: line.strokeWidth, strokeStyle: line.strokeStyle })
			}
		}
	}
	const attrsFor = id => {
		const current = objects.get(id)?.current
		if (!current) return []
		const attrs = []
		if (netAttrPresent.get(id)) attrs.push({ getState_PrimitiveId: () => `attr-${id}`, getState_Key: () => nameOnlyIds.includes(id) || apiNameIds.includes(id) ? 'Name' : 'NET', getState_Value: () => Object.hasOwn(apiNameValueOverrides, id) ? apiNameValueOverrides[id] : current.net })
		return attrs
	}
	const storage = new Map()
	globalThis.eda = {
		sch_PrimitiveWire: {
			getAll: async () => [...objects.values()],
			modify: async (id, props) => {
				modifyCalls++
				calls.push({ id, props: { ...props } })
				if (onModify) onModify(objects.get(id), props)
				else if (apply) {
					Object.assign(objects.get(id).current, props)
					if (damageEarlierOnSecondModify && modifyCalls === 2) {
						objects.get('wire-1').current.color = '#BADBAD'
						sourceStyles.get('wire-1').strokeColor = '#BADBAD'
					}
					if (displayDriftOnModify.includes(id)) attrDisplays.set(id, 'DISPLAY-DRIFT')
					if (endpointDriftOnModify.includes(id)) endpointOverrides.set(id, { startX: 1, startY: 0, endX: 10, endY: 0 })
					if (churnAttrIdOnModify.includes(id)) attrIdOverrides.set(id, `attr-${id}-changed`)
					if (churnLineIdOnModify.includes(id)) lineIdOverrides.set(id, `line-${id}-changed`)
					if (props.net !== undefined && !sourceNetStale) sourceNets.set(id, props.net)
					if (props.net !== undefined && !sourceNetStale && props.net !== '') netAttrPresent.set(id, true)
					if (sourceAttrFailure === 'delete') netAttrPresent.set(id, false)
					if (sourceAttrFailure === 'change') sourceNets.set(id, `${objects.get(id).current.net}-DRIFT`)
					if (sourceAttrFailure === 'duplicate') duplicateNetAttrs.add(id)
					if (!sourceStyleStale.includes(id)) {
						const sourceStyle = sourceStyles.get(id)
						if (props.color !== undefined) sourceStyle.strokeColor = props.color
						if (props.lineWidth !== undefined) sourceStyle.strokeWidth = props.lineWidth
						if (props.lineType !== undefined) sourceStyle.strokeStyle = sourceLineTypeByGetter[props.lineType] ?? props.lineType
						if (nullOmittedStyles) {
							if (props.color === undefined) { objects.get(id).current.color = null; sourceStyle.strokeColor = null }
							if (props.lineWidth === undefined) { objects.get(id).current.lineWidth = null; sourceStyle.strokeWidth = null }
							if (props.lineType === undefined) { objects.get(id).current.lineType = null; sourceStyle.strokeStyle = null }
						}
					}
				}
				return typeof result === 'function' ? result(id, props) : result
			},
		},
		sch_PrimitiveAttribute: { getAll: async id => attrsFor(id) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc-1', documentType: 1 }) },
		sys_FileManager: {
			getDocumentSource: async () => sourceFor(),
			setDocumentSource: async value => {
				sourceOverride = value
				if (restoreObjects) restoreFromSource(value)
				return true
			},
		},
		sys_Storage: {
			setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true },
			getExtensionUserConfig: key => storage.get(key),
		},
	}
	return { objects, calls, get modifyCalls() { return modifyCalls }, sourceFor }
}

function sourceRecords(source) {
	return source.split(/\r?\n/).filter(Boolean).map(line => {
		const separator = line.indexOf('||')
		return { header: JSON.parse(line.slice(0, separator)), data: JSON.parse(line.slice(separator + 2).replace(/\|$/, '')) }
	})
}

{
	const eda = makeWireEda()
	await assert.rejects(modifyWire({ primitiveId: 'NOT_A_WIRE', color: '#FF0000' }), /导线 NOT_A_WIRE 不存在/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda({ result: false, nets: { 'wire-1': '' } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /整页恢复/)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ result: false, apiNameIds: ['wire-1'] })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /导线 wire-1 修改接口返回空值或 false/)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ apply: false, result: {}, nets: { 'wire-1': '' } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000', lineWidth: 9, lineType: 'dotted' }), /整页恢复/)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ result: {}, nullOmittedStyles: true })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#FF0000' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(eda.modifyCalls, 1)
	assert.deepEqual(eda.calls[0], { id: 'wire-1', props: { color: '#FF0000', lineWidth: 6, lineType: 0, net: 'SIG' } })
}

{
	const eda = makeWireEda({ apiNameIds: ['wire-1'] })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#FF0000' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(eda.modifyCalls, 1)
	assert.deepEqual(eda.calls[0].props, { color: '#FF0000', lineWidth: 6, lineType: 0, net: 'SIG' })
}

{
	const eda = makeWireEda({ apiNameIds: ['wire-1'], apiNameValueOverrides: { 'wire-1': 'CONFLICT' } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /NET\/Name 属性与源码不一致.*整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda({ result: {}, nets: { 'wire-1': '' } })
	const result = await modifyWire({ primitiveId: 'wire-1', newNet: 'NEW' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.deepEqual(result.failed, [])
	assert.equal(result.readback[0].fields.net.verified, true)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ styles: { 'wire-1': { color: null, lineWidth: null, lineType: null } } })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#123456' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(result.readback[0].fields.lineWidth.actual, null)
	assert.equal(result.readback[0].fields.lineWidth.verified, true)
	assert.equal(result.readback[0].fields.lineType.actual, null)
	assert.equal(result.readback[0].fields.lineType.verified, true)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ result: {}, nets: { 'wire-1': '' }, nullOmittedStyles: true })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#FF0000' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(eda.modifyCalls, 1)
	assert.deepEqual(eda.calls[0].props, { color: '#FF0000', lineWidth: 6, lineType: 0 })
}

{
	const eda = makeWireEda({ nullOmittedStyles: true })
	const result = await modifyWire({ primitiveId: 'wire-1', lineWidth: 9 })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.deepEqual(eda.calls[0].props, { color: '#000000', lineWidth: 9, lineType: 0, net: 'SIG' })
}

{
	const eda = makeWireEda({ nullOmittedStyles: true })
	const result = await modifyWire({ primitiveId: 'wire-1', newNet: 'NEW' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.deepEqual(eda.calls[0].props, { color: '#000000', lineWidth: 6, lineType: 0, net: 'NEW' })
}

{
	const eda = makeWireEda({ nets: { 'wire-1': '' }, emptyNetAttrs: ['wire-1'], nullOmittedStyles: true })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#FF0000' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.deepEqual(eda.calls[0].props, { color: '#FF0000', lineWidth: 6, lineType: 0, net: '' })
	assert.equal(result.readback[0].fields.netAttribute.verified, true)
}

for (const failure of ['delete', 'change', 'duplicate']) {
	const eda = makeWireEda({ nets: { 'wire-1': '' }, emptyNetAttrs: ['wire-1'], sourceAttrFailure: failure })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => error.cause?.restored === true && /整页恢复/.test(error.message))
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ ids: ['wire-1', 'wire-2'], nets: { 'wire-1': 'VCC', 'wire-2': 'VCC' }, nameOnlyIds: ['wire-2'] })
	await assert.rejects(modifyWire({ net: 'VCC', color: '#FF0000' }), /整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda({ nets: { 'wire-1': undefined } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /网络、样式或几何读回不可信.*整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda({ result: {}, nets: { 'wire-1': 'SIG' } })
	const result = await modifyWire({ primitiveId: 'wire-1', color: '#FF0000', newNet: 'NEW' })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(result.readback[0].fields.net.verified, true)
	assert.equal(eda.modifyCalls, 1)
	assert.deepEqual(eda.calls[0].props, { color: '#FF0000', lineWidth: 6, lineType: 0, net: 'NEW' })
}

{
	const eda = makeWireEda({ sourceNetStale: true })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000', newNet: 'NEXT' }), /整页恢复/)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ sourceStyleStale: ['wire-1'] })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /整页恢复/)
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ churnAttrIdOnModify: ['wire-1'] })
	let failure
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => {
		failure = error
		return error.cause?.restored === true && /整页恢复/.test(error.message)
	})
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('netAttribute'))
	assert.equal(diagnostic.attributes.before.source.records[0].id, 'attr-wire-1')
	assert.equal(diagnostic.attributes.after.source.records[0].id, 'attr-wire-1-changed')
	assert.deepEqual(diagnostic.targetWire, { before: true, afterGetter: true, afterSource: true })
	assert.equal(diagnostic.callProps.color, '#FF0000')
	assert.equal(diagnostic.docUuid, 'doc-1')
}

{
	const eda = makeWireEda({ churnLineIdOnModify: ['wire-1'] })
	let failure
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => {
		failure = error
		return error.cause?.restored === true && /整页恢复/.test(error.message)
	})
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('sourceLineStyle'))
	assert.equal(diagnostic.lines.before.records[0].id, 'line-wire-1')
	assert.equal(diagnostic.lines.after.records[0].id, 'line-wire-1-changed')
	assert.equal(diagnostic.lines.after.records[0].lineGroup, 'wire-1')
}

{
	const eda = makeWireEda({ endpointDriftOnModify: ['wire-1'] })
	let failure
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => { failure = error; return error.cause?.restored === true })
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('sourceLineStyle'))
	assert.deepEqual(diagnostic.lines.after.records[0].start, [1, 0])
}

{
	const eda = makeWireEda({ displayDriftOnModify: ['wire-1'] })
	let failure
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => { failure = error; return error.cause?.restored === true })
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('netAttribute'))
	assert.equal(diagnostic.attributes.before.source.records[0].display, 'SIG')
	assert.equal(diagnostic.attributes.after.source.records[0].display, 'DISPLAY-DRIFT')
}

{
	const eda = makeWireEda({ ids: ['wire-1', 'wire-2'], nets: { 'wire-1': 'SIG', 'wire-2': 'SIG' }, damageEarlierOnSecondModify: true })
	let failure
	await assert.rejects(modifyWire({ net: 'SIG', color: '#FF0000' }), error => { failure = error; return error.cause?.restored === true })
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('color'))
	assert.equal(eda.modifyCalls, 2)
	assert.equal(eda.objects.get('wire-1').current.color, '#000000')
}

{
	const eda = makeWireEda({ churnAttrIdOnModify: ['wire-1'], churnLineIdOnModify: ['wire-1'] })
	let failure
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => {
		failure = error
		return error.cause?.restored === true && /整页恢复/.test(error.message)
	})
	const diagnostic = JSON.parse(failure.message.match(/诊断=(\{.*\})$/)?.[1] ?? 'null')
	assert.ok(diagnostic.failedFields.includes('sourceLineStyle'))
	assert.ok(diagnostic.failedFields.includes('netAttribute'))
}

{
	const eda = makeWireEda({ sourceLineTypeOverrides: { 'wire-1': null } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', lineType: 'dotted' }), /strokeStyle.*数值映射.*整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

for (const [lineType, expectedGetter, expectedSource] of [['solid', 0, 'SOLID'], ['dashed', 1, 'SHORT_DASH'], ['dotted', 2, 'DOT']]) {
	const eda = makeWireEda()
	const result = await modifyWire({ primitiveId: 'wire-1', lineType })
	assert.deepEqual(result.modified, ['wire-1'])
	assert.equal(eda.objects.get('wire-1').current.lineType, expectedGetter)
	assert.equal(sourceRecords(eda.sourceFor()).find(record => record.header.type === 'LINE').data.strokeStyle, expectedSource)
	assert.equal(result.readback[0].fields.sourceLineStyle.verified, true)
}

{
	const eda = makeWireEda({ sourceLineTypeOverrides: { 'wire-1': 'DASHED' } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', lineType: 'dotted' }), /strokeStyle.*数值映射.*整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda()
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', lineType: 'dash-dot' }), /lineType 仅支持 solid、dashed 或 dotted/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda()
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', lineType: ['dashed'] }), /lineType 必须是字符串/)
	assert.equal(eda.modifyCalls, 0)
}

for (const malformed of ['missing', 'nonfinite']) {
	const eda = makeWireEda({ malformedSourceEndpoints: { 'wire-1': malformed } })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /LINE 源码端点 .*缺失或非有限数值.*整批未执行修改/)
	assert.equal(eda.modifyCalls, 0)
}

{
	const eda = makeWireEda({
		onModify: object => { object.current.color = '#FF0000'; object.current.net = '' },
		nets: { 'wire-1': 'SIG' },
	})
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), /整页恢复/)
	assert.equal(eda.modifyCalls, 1)
	assert.deepEqual(eda.objects.get('wire-1').current, { color: '#000000', lineWidth: 6, lineType: 0, net: 'SIG', line: [0, 0, 10, 0] })
	const restoredSource = sourceRecords(eda.sourceFor())
	assert.equal(restoredSource.find(record => record.header.type === 'ATTR' && record.data.key === 'NET')?.data.value, 'SIG')
	assert.equal(restoredSource.find(record => record.header.type === 'LINE')?.data.strokeColor, '#000000')
}

{
	const eda = makeWireEda({ onModify: object => { object.current.color = '#FF0000'; object.current.net = '' }, nets: { 'wire-1': 'SIG' } })
	globalThis.eda.sys_FileManager.setDocumentSource = async () => false
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => error.cause?.partial === true && /恢复未确认/.test(error.message))
	assert.equal(eda.modifyCalls, 1)
}

{
	const eda = makeWireEda({ onModify: object => { object.current.color = '#FF0000'; object.current.net = '' }, nets: { 'wire-1': 'SIG' }, restoreObjects: false })
	await assert.rejects(modifyWire({ primitiveId: 'wire-1', color: '#FF0000' }), error => error.cause?.partial === true && error.cause?.modelRestored === false && error.cause?.retryable === false && /对象 getter\/属性恢复未确认/.test(error.message))
	assert.equal(eda.modifyCalls, 1)
	assert.equal(eda.objects.get('wire-1').current.net, '')
	assert.equal(eda.objects.get('wire-1').current.color, '#FF0000')
	const restoredSource = sourceRecords(eda.sourceFor())
	assert.equal(restoredSource.find(record => record.header.type === 'ATTR' && record.data.key === 'NET')?.data.value, 'SIG')
}

{
	let sdkCalls = 0
	globalThis.eda = {
		sch_PrimitiveAttribute: {
			getAllPrimitiveId: async () => { sdkCalls++; return [] },
			get: async () => { sdkCalls++; return undefined },
			modify: async () => { sdkCalls++; return true },
		},
	}
	for (const params of [{}, { primitiveId: 'c1' }, { primitiveId: 'c1', key: 'Value' }, { primitiveId: ' ', key: 'Value', value: '1' }, { primitiveId: 'c1', key: ' ', value: '1' }, { primitiveId: 'c1', key: 'Value', value: null }]) {
		await assert.rejects(setAttribute(params), /primitiveId|key|value/)
	}
	assert.equal(sdkCalls, 0)
}

{
	let value = 'old'
	globalThis.eda = {
		sch_PrimitiveAttribute: {
			getAllPrimitiveId: async () => ['attr-1'],
			get: async ids => {
				if (Array.isArray(ids)) return [{ getState_Key: () => 'Value', getState_PrimitiveId: () => 'attr-1', getState_Value: () => value }]
				return { getState_Value: () => value }
			},
			modify: async (_id, props) => { value = props.value; return true },
		},
		sys_Timer: { setTimeoutTimer: (_id, _delay, callback) => { queueMicrotask(callback); return true } },
	}
	const result = await setAttribute({ primitiveId: 'comp-1', key: 'Value', value: '' })
	assert.equal(result.key, 'Value')
	assert.equal(result.value, '')
	assert.equal(result.readback.verified, true)
}

{
	const calls = []
	globalThis.eda = { sch_PrimitiveComponent: { getAll: async (...args) => { calls.push(args); return [] } } }
	for (const params of [{ allPages: 'bad' }, { allPages: 'false' }])
		await assert.rejects(listComponents(params), /allPages 必须是布尔值/)
	assert.equal(calls.length, 0)
	await listComponents({})
	await listComponents({ allPages: false })
	await listComponents({ allPages: true })
	assert.deepEqual(calls, [[undefined, false], [undefined, false], [undefined, true]])
}

{
	let sdkCalls = 0
	globalThis.eda = new Proxy({}, { get: () => { sdkCalls++; throw new Error('SDK must not be called') } })
	await assert.rejects(structuralAudit({ ncExempt: 'bad' }), /ncExempt 必须是字符串数组/)
	await assert.rejects(structuralAudit({ ncExempt: ['U1.1', 3] }), /ncExempt 必须是字符串数组/)
	await assert.rejects(structuralAudit({ allPages: 'bad' }), /allPages 必须是布尔值/)
	for (const params of [
		{ deviceMargin: -1 }, { deviceMargin: '5' }, { deviceMargin: Number.NaN },
		{ deviceMargin: Number.POSITIVE_INFINITY }, { deviceMargin: Number.NEGATIVE_INFINITY },
		{ deviceMargin: null }, { deviceMargin: undefined },
	])
		await assert.rejects(structuralAudit(params), /deviceMargin 必须是有限且不小于 0 的数字/)
	await assert.rejects(pruneFloatingLabels({ dryRun: 'bad' }), /dryRun 必须是布尔值/)
	await assert.rejects(fixNetLabels({ dryRun: 'false' }), /dryRun 必须是布尔值/)
	assert.equal(sdkCalls, 0)
}

{
	const comp = (id, designator) => ({
		getState_PrimitiveId: () => id,
		getState_Designator: () => designator,
	})
	const pin = x => ({ getState_PinNumber: () => '1', getState_X: () => x, getState_Y: () => 0 })
	globalThis.eda = {
		sch_PrimitiveWire: { getAll: async () => [] },
		sch_PrimitiveAttribute: { getAll: async () => [] },
		sch_PrimitiveComponent: {
			getAll: async () => [comp('c1', 'U1'), comp('c2', 'U2')],
			getAllPinsByPrimitiveId: async id => [pin(id === 'c1' ? 0 : 15)],
		},
		sch_PrimitiveRectangle: { getAll: async () => [] },
		sys_FileManager: { getDocumentSource: async () => ' ' },
	}
	const defaultMargin = await structuralAudit({})
	assert.equal(defaultMargin.issues.some(issue => issue.rule === 'DEVICE_BBOX_OVERLAP'), true)
	const zeroMargin = await structuralAudit({ deviceMargin: 0 })
	assert.equal(zeroMargin.issues.some(issue => issue.rule === 'DEVICE_BBOX_OVERLAP'), false)
}

{
	const calls = []
	globalThis.eda = { sch_ManufactureData: { getPngFile: async (...args) => { calls.push(args); return undefined } } }
	for (const params of [
		{ width: -1 }, { height: 0 }, { width: 1.5 }, { height: Number.NaN },
		{ width: Number.POSITIVE_INFINITY }, { height: 4097 }, { width: '2048' },
	]) {
		await assert.rejects(exportPng(params), /width|height 必须是 1 至 4096 之间的正整数/)
	}
	assert.equal(calls.length, 0)
	await assert.rejects(exportPng({ width: 2048 }), /PNG 导出失败/)
	assert.deepEqual(calls, [[undefined, { width: 2048 }]])
}

globalThis.setTimeout = originalTimeout
console.log('schematic-wire-attribute-regression: passed')
