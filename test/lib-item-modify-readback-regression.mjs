import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { libCommands } from '../src/commands/lib.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'lib-item-modify-readback-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { libCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const libraryUuid = 'personal-library'
const command = name => libCommands.find(item => item.name === name).handler

function setup(kind, { oldItem, items, searchRows, searchRowsBefore = [], modify = async () => true }) {
	const apiName = kind === 'footprint' ? 'lib_Footprint' : 'lib_Device'
	let modified = false
	const calls = { search: 0 }
	const api = {
		get: async (uuid, library) => {
			if (library !== libraryUuid)
				return undefined
			return structuredClone(items.get(uuid) ?? (uuid === oldItem.uuid ? oldItem : undefined))
		},
		modify: async (...args) => {
			const result = await modify(...args)
			modified = true
			return result
		},
		search: async (...args) => {
			calls.search++
			const pageSize = kind === 'footprint' ? args[3] : args[4]
			const page = kind === 'footprint' ? args[4] : args[5]
			assert.equal(args[0], 'Renamed')
			assert.equal(args[1], libraryUuid)
			const rows = modified ? searchRows : searchRowsBefore
			return rows.slice((page - 1) * pageSize, page * pageSize)
		},
	}
	globalThis.eda = {
		lib_LibrariesList: { getPersonalLibraryUuid: async () => libraryUuid },
		[apiName]: api,
	}
	return calls
}

const oldFootprint = { uuid: 'fp-old', libraryUuid, name: 'Before' }
setup('footprint', {
	oldItem: oldFootprint,
	items: new Map([['fp-new', { uuid: 'fp-new', libraryUuid, name: 'Renamed' }]]),
	searchRows: [{ uuid: 'fp-new', libraryUuid, name: 'Renamed' }],
})
const footprintRename = await command('lib.footprintModify')({ footprintUuid: 'fp-old', libraryUuid, name: 'Renamed' })
assert.deepEqual(footprintRename, { modified: true, uuid: 'fp-new', uuidChanged: true, verify: 'search' }, 'stale old UUID value is not accepted; unique renamed footprint is read back')

const unchangedUuidCalls = setup('device', {
	oldItem: { uuid: 'dev-same', libraryUuid, name: 'Existing', association: {}, property: { designator: 'R' } },
	items: new Map(),
	searchRows: [],
})
const unchangedUuidResult = await command('lib.deviceModify')({ deviceUuid: 'dev-same', libraryUuid, property: { designator: 'R' } })
assert.equal(unchangedUuidResult.verify, 'get')
assert.equal(unchangedUuidCalls.search, 0, 'ordinary unchanged-UUID readback does not trigger name searches')

const oldDevice = { uuid: 'dev-old', libraryUuid, name: 'Before', association: {}, property: {} }
setup('device', {
	oldItem: oldDevice,
	items: new Map([
		['dev-wrong', { uuid: 'dev-wrong', libraryUuid, name: 'Renamed', association: {}, property: {} }],
		['dev-new', { uuid: 'dev-new', libraryUuid, name: 'Renamed', association: { symbol: { uuid: 'symbol-new' } }, property: {} }],
	]),
	searchRows: [
		{ uuid: 'dev-wrong', libraryUuid, name: 'Renamed' },
		{ uuid: 'dev-new', libraryUuid, name: 'Renamed' },
	],
})
const deviceRename = await command('lib.deviceModify')({ deviceUuid: 'dev-old', libraryUuid, name: 'Renamed', symbolUuid: 'symbol-new' })
assert.deepEqual(deviceRename, { modified: true, uuid: 'dev-new', uuidChanged: true, verify: 'search' }, 'requested association disambiguates same-name device results after full readback')

setup('device', {
	oldItem: { uuid: 'dev-old', libraryUuid, name: 'Before', association: {}, property: {} },
	items: new Map([
		['dev-readable', { uuid: 'dev-readable', libraryUuid, name: 'Renamed', association: {}, property: {} }],
	]),
	searchRows: [
		{ uuid: 'dev-readable', libraryUuid, name: 'Renamed' },
		{ uuid: 'dev-unreadable', libraryUuid, name: 'Renamed' },
	],
})
await assert.rejects(
	() => command('lib.deviceModify')({ deviceUuid: 'dev-old', libraryUuid, name: 'Renamed' }),
	error => {
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.candidateUuid, null)
		assert.equal(Object.hasOwn(error.cause, 'uuid'), false)
		assert.match(error.cause.reason, /1 个同名候选无法读回/)
		return true
	},
)

const oldSameName = { uuid: 'dev-old', libraryUuid, name: 'Before', association: {}, property: {} }
setup('device', {
	oldItem: oldSameName,
	items: new Map([
		['dev-a', { uuid: 'dev-a', libraryUuid, name: 'Renamed', association: {}, property: {} }],
		['dev-b', { uuid: 'dev-b', libraryUuid, name: 'Renamed', association: {}, property: {} }],
	]),
	searchRows: [
		{ uuid: 'dev-a', libraryUuid, name: 'Renamed' },
		{ uuid: 'dev-b', libraryUuid, name: 'Renamed' },
	],
})
await assert.rejects(
	() => command('lib.deviceModify')({ deviceUuid: 'dev-old', libraryUuid, name: 'Renamed' }),
	error => {
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.retryable, false)
		assert.equal(error.cause.sdkModified, true)
		assert.equal(error.cause.candidateUuid, null, 'ambiguous homonyms do not expose a trusted candidate UUID')
		assert.match(error.cause.reason, /2 个同名/)
		assert.equal(Object.hasOwn(error.cause, 'uuid'), false, 'ambiguous result has no UUID for dependent operations')
		return true
	},
)

setup('footprint', {
	oldItem: { uuid: 'fp-old', libraryUuid, name: 'Before' },
	items: new Map([
		['fp-decoy', { uuid: 'fp-decoy', libraryUuid, name: 'Renamed' }],
	]),
	searchRowsBefore: [{ uuid: 'fp-decoy', libraryUuid, name: 'Renamed' }],
	searchRows: [{ uuid: 'fp-decoy', libraryUuid, name: 'Renamed' }],
})
await assert.rejects(
	() => command('lib.footprintModify')({ footprintUuid: 'fp-old', libraryUuid, name: 'Renamed' }),
	error => {
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.retryable, false)
		assert.equal(error.cause.candidateUuid, null)
		assert.equal(Object.hasOwn(error.cause, 'uuid'), false)
		assert.deepEqual(error.cause.actualFields, { name: 'Before' })
		assert.match(error.cause.reason, /修改前未能建立|未找到身份/)
		return true
	},
)

console.log('lib item modify readback regression passed')
