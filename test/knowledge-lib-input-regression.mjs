import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { knowledgeCommands } from '../src/commands/knowledge.ts'; export { libCommands } from '../src/commands/lib.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'knowledge-lib-input-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { knowledgeCommands, libCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = (commands, name) => commands.find(item => item.name === name).handler

const query = command(knowledgeCommands, 'knowledge.query')
for (const invalid of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
	await assert.rejects(() => query({ query: '线宽', limit: invalid }), /limit 必须是正整数/)
assert.ok((await query({ query: '线宽' })).matched.length > 0)

const width = command(knowledgeCommands, 'knowledge.widthForCurrent')
for (const invalid of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY])
	await assert.rejects(() => width({ currentA: invalid }), /currentA 必须/)
assert.deepEqual(await width({ currentA: 1 }), { widthMm: 0.3, widthMil: 12 })

let sdkCalls = 0
globalThis.eda = {
	lib_Symbol: {
		search: async () => { sdkCalls++; return [] },
		modify: async () => { sdkCalls++; return true },
	},
	lib_Footprint: { search: async () => { sdkCalls++; return [] } },
	lib_Device: { search: async () => { sdkCalls++; return [] } },
}
for (const name of ['lib.symbolSearch', 'lib.footprintSearch', 'lib.deviceSearch']) {
	const handler = command(libCommands, name)
	for (const params of [{ page: -1 }, { itemsOfPage: 0 }, { page: 1.5 }])
		await assert.rejects(() => handler({ libraryUuid: 'personal', ...params }), /必须是正整数/)
	assert.deepEqual(await handler({ libraryUuid: 'personal' }), [])
}
assert.equal(sdkCalls, 3, 'invalid search pages must not invoke SDK')
await assert.rejects(() => command(libCommands, 'lib.symbolModify')({ symbolUuid: 'symbol', libraryUuid: 'personal' }), /至少提供一个要修改的字段/)
await assert.rejects(() => command(libCommands, 'lib.symbolModify')({ symbolUuid: 'symbol', libraryUuid: 'personal', name: '' }), /name 必须是非空字符串/)
assert.equal(sdkCalls, 3, 'empty symbol modify must not invoke SDK')

const deviceCreate = command(libCommands, 'lib.deviceCreate')
let deviceCreateCalls = []
let modelGetCalls = []
globalThis.eda.lib_3DModel = {
	get: async (...args) => { modelGetCalls.push(args); return { uuid: args[0], libraryUuid: args[1], name: 'valid-model' } },
}
globalThis.eda.lib_Device.create = async (...args) => { deviceCreateCalls.push(args); return 'created-device' }
globalThis.eda.lib_Device.get = async () => ({ uuid: 'created-device', name: 'validated-device' })
for (const model3DUuid of ['', null, 0, {}, false]) {
	await assert.rejects(
		() => deviceCreate({ name: 'invalid-model-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid }),
		/model3DUuid 必须是非空字符串/,
	)
}
await assert.rejects(
	() => deviceCreate({ name: 'stray-model-lib-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DLibraryUuid: 'model-lib' }),
	/model3DLibraryUuid 时必须同时提供 model3DUuid/,
)
assert.equal(modelGetCalls.length, 0, 'invalid model inputs must not query the 3D model SDK')
assert.equal(deviceCreateCalls.length, 0, 'invalid model inputs must not invoke device create')

globalThis.eda.lib_3DModel.get = async () => undefined
await assert.rejects(
	() => deviceCreate({ name: 'missing-model-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid: 'missing', model3DLibraryUuid: 'model-lib' }),
	/3D 模型不存在或无权访问/,
)
assert.equal(deviceCreateCalls.length, 0, 'missing model must not invoke device create')

globalThis.eda.lib_3DModel.get = async () => ({ uuid: 'other-model', libraryUuid: 'model-lib', name: 'wrong-model' })
await assert.rejects(
	() => deviceCreate({ name: 'wrong-model-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid: 'requested-model', model3DLibraryUuid: 'model-lib' }),
	/3D 模型身份不符/,
)
assert.equal(deviceCreateCalls.length, 0, 'identity mismatch must not invoke device create')

globalThis.eda.lib_3DModel.get = async () => ({ uuid: 'requested-model', libraryUuid: 'other-model-lib', name: 'wrong-library-model' })
await assert.rejects(
	() => deviceCreate({ name: 'wrong-model-library-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid: 'requested-model', model3DLibraryUuid: 'model-lib' }),
	/3D 模型身份不符/,
)
assert.equal(deviceCreateCalls.length, 0, 'matching model UUID in the wrong library must not invoke device create')

const modelLookupError = new Error('model lookup failed')
globalThis.eda.lib_3DModel.get = async () => { throw modelLookupError }
await assert.rejects(
	() => deviceCreate({ name: 'model-error-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid: 'requested-model', model3DLibraryUuid: 'model-lib' }),
	error => /3D 模型验证失败/.test(error.message) && error.cause === modelLookupError,
)
assert.equal(deviceCreateCalls.length, 0, 'model lookup error must not invoke device create')

globalThis.eda.lib_3DModel.get = async (...args) => { modelGetCalls.push(args); return { uuid: args[0], libraryUuid: args[1], name: 'valid-model' } }
const createdReadback = { uuid: 'created-device', name: 'validated-device' }
globalThis.eda.lib_Device.get = async () => createdReadback
const createdDevice = await deviceCreate({
	name: 'valid-model-device',
	symbolUuid: 'symbol',
	libraryUuid: 'device-lib',
	model3DUuid: 'valid-model',
	model3DLibraryUuid: 'model-lib',
})
assert.equal(createdDevice, createdReadback, 'valid model creation returns the normal device readback')
assert.deepEqual(deviceCreateCalls.at(-1)[3].model3D, { uuid: 'valid-model', libraryUuid: 'model-lib' }, 'valid model association is passed through unchanged')
assert.deepEqual(modelGetCalls.at(-1), ['valid-model', 'model-lib'], 'model identity is checked against the requested library')
assert.equal(deviceCreateCalls.length, 1, 'only the verified model reaches device create')

const implicitLibraryDevice = await deviceCreate({ name: 'implicit-model-library-device', symbolUuid: 'symbol', libraryUuid: 'device-lib', model3DUuid: 'same-library-model' })
assert.equal(implicitLibraryDevice, createdReadback, 'implicit model library creation returns the normal device readback')
assert.deepEqual(modelGetCalls.at(-1), ['same-library-model', 'device-lib'], 'omitted model3DLibraryUuid defaults to the device library for verification')
assert.deepEqual(deviceCreateCalls.at(-1)[3].model3D, { uuid: 'same-library-model', libraryUuid: 'device-lib' }, 'implicit model library is preserved in the association')
assert.equal(deviceCreateCalls.length, 2, 'both verified model cases reach device create once')

const footprintGet = command(libCommands, 'lib.footprintGet')
const footprint = { uuid: 'footprint', name: 'R0603' }
globalThis.eda.lib_Footprint.get = async () => footprint
assert.equal(await footprintGet({ footprintUuid: footprint.uuid, libraryUuid: 'personal' }), footprint)
globalThis.eda.lib_Footprint.get = async () => null
await assert.rejects(() => footprintGet({ footprintUuid: 'missing', libraryUuid: 'personal' }), /封装不存在或无权访问（官方返回空）/)
const opaqueSdkError = new Error('[object Object]')
globalThis.eda.lib_Footprint.get = async () => { throw opaqueSdkError }
await assert.rejects(
	() => footprintGet({ footprintUuid: 'invalid', libraryUuid: 'personal' }),
	error => error.message === '封装读取失败：官方接口返回不可读错误，无法判断不存在、无权限或其他原因；请核对封装与库 UUID'
		&& error.cause === opaqueSdkError,
)
const otherSdkError = new Error('SDK transport failed')
globalThis.eda.lib_Footprint.get = async () => { throw otherSdkError }
await assert.rejects(() => footprintGet({ footprintUuid: 'any', libraryUuid: 'personal' }), error => error === otherSdkError)

const deviceGetByLcscIds = command(libCommands, 'lib.deviceGetByLcscIds')
const bLibraryResult = [{ uuid: 'b-device', lcscId: 'C1523', libraryUuid: 'library-b', payload: { source: 'B-library' } }]
let lcscCalls = []
globalThis.eda.lib_Device.getByLcscIds = async (...args) => { lcscCalls.push(args); return bLibraryResult }
assert.equal(await deviceGetByLcscIds({ lcscIds: ['C1523'], libraryUuid: 'library-b' }), bLibraryResult)
assert.equal(await deviceGetByLcscIds({ lcscIds: ['C1523'], libraryUuid: 'library-b', diagnostic: false }), bLibraryResult)
assert.equal(lcscCalls.length, 2, 'default and diagnostic:false each invoke SDK once')
assert.deepEqual(lcscCalls.map(args => args.slice(1)), [['library-b', false], ['library-b', false]])

const submittedIds = ['C1523', 'C17168']
const startedBefore = Date.now()
const diagnosticResult = await deviceGetByLcscIds({
	lcscIds: submittedIds,
	libraryUuid: 'library-a',
	allowMultiMatch: true,
	diagnostic: true,
})
assert.equal(lcscCalls.length, 3, 'diagnostic:true invokes SDK exactly once')
assert.deepEqual(lcscCalls[2], [submittedIds, 'library-a', true], 'SDK arguments match the command inputs')
assert.equal(diagnosticResult.result, bLibraryResult, 'diagnostic preserves the complete SDK result by identity')
assert.deepEqual(diagnosticResult.diagnostic, {
	sdkMethod: 'lib_Device.getByLcscIds',
	sdkArgs: { lcscIds: submittedIds, libraryUuid: 'library-a', allowMultiMatch: true },
	startedAt: diagnosticResult.diagnostic.startedAt,
	finishedAt: diagnosticResult.diagnostic.finishedAt,
})
assert.ok(Date.parse(diagnosticResult.diagnostic.startedAt) >= startedBefore)
assert.ok(Date.parse(diagnosticResult.diagnostic.finishedAt) >= Date.parse(diagnosticResult.diagnostic.startedAt))

const deviceWithoutFootprint = { uuid: 'no-footprint', libraryUuid: 'library-a', footprintUuid: '' }
globalThis.eda.lib_Device.getByLcscIds = async () => deviceWithoutFootprint
assert.equal(
	await deviceGetByLcscIds({ lcscIds: ['C8734'], libraryUuid: 'library-a' }),
	deviceWithoutFootprint,
	'default response shape stays the original SDK object and does not claim PCB readiness',
)
const missingFootprintResult = await deviceGetByLcscIds({ lcscIds: ['C8734'], libraryUuid: 'library-a', diagnostic: true })
assert.equal(missingFootprintResult.result, deviceWithoutFootprint)
assert.equal(missingFootprintResult.diagnostic.missingFootprint, true, 'diagnostic identifies an explicitly empty footprint UUID')
assert.equal('pcbReady' in missingFootprintResult.diagnostic, false, 'missing footprint is not translated into a PCB readiness claim')

const mutationInput = ['C999']
globalThis.eda.lib_Device.getByLcscIds = async ids => {
	ids.push('SDK-mutated')
	return { exact: 'raw SDK object' }
}
const mutationResult = await deviceGetByLcscIds({ lcscIds: mutationInput, libraryUuid: 'library-b', diagnostic: true })
assert.deepEqual(mutationResult.diagnostic.sdkArgs.lcscIds, ['C999'], 'SDK input mutation does not alter diagnostic snapshot')
assert.deepEqual(mutationInput, ['C999', 'SDK-mutated'], 'SDK receives the original input array')
assert.deepEqual(mutationResult.result, { exact: 'raw SDK object' })

const callsBeforeInvalidDiagnostic = lcscCalls.length
globalThis.eda.lib_Device.getByLcscIds = async (...args) => { lcscCalls.push(args); return bLibraryResult }
for (const diagnostic of [null, 'true', 1, {}])
	await assert.rejects(() => deviceGetByLcscIds({ lcscIds: ['C1'], libraryUuid: 'library-b', diagnostic }), /diagnostic 必须是布尔值/)
assert.equal(lcscCalls.length, callsBeforeInvalidDiagnostic, 'invalid diagnostic types must not invoke SDK')

globalThis.eda.lib_Device.getByLcscIds = async () => []
await assert.rejects(() => deviceGetByLcscIds({ lcscIds: ['C-missing'], libraryUuid: 'library-b', diagnostic: true }), /未匹配到器件（官方返回空）/)
const lcscSdkError = new Error('LCSC SDK failed')
globalThis.eda.lib_Device.getByLcscIds = async () => { throw lcscSdkError }
await assert.rejects(
	() => deviceGetByLcscIds({ lcscIds: ['C-error'], libraryUuid: 'library-b', diagnostic: true }),
	error => error === lcscSdkError,
)
console.log('PASS knowledge and library input guards reject invalid calls before SDK')
