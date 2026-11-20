import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { frSetAndVerifyJobSettings } from '../src/bridge/freerouting.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'freerouting-settings-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { frSetAndVerifyJobSettings } = await import(moduleUrl)

const requested = {
	autorouter: { max_passes: 3 },
	scoring: { via_costs: 73, start_ripup_costs: 100 },
	optimizer: { improvement_threshold: 0, max_threads: 1 },
	trace_pull_tight_accuracy: 500,
	automatic_neckdown: true,
	allowed_via_types: true,
}
function install({ ignoreViaCosts = false, getFailure = false } = {}) {
	const calls = []
	globalThis.eda = {
		sys_ClientUrl: {
			request: async (url, method, body) => {
				calls.push({ url, method, body })
				if (getFailure && method === 'GET') throw new Error('readback unavailable')
				const effective = structuredClone(requested)
				if (ignoreViaCosts) effective.scoring.via_costs = 50
				return { ok: true, status: 200, json: async () => method === 'POST' ? {} : effective }
			},
		},
	}
	return calls
}

const calls = install()
const effective = await frSetAndVerifyJobSettings('job/with space', requested)
assert.deepEqual(effective, requested, 'all supported DTO settings are returned after readback')
assert.equal(calls.length, 2, 'settings are POSTed then read back')
assert.equal(calls[0].method, 'POST')
assert.equal(calls[0].url.endsWith('/jobs/job%2Fwith%20space/settings'), true, 'job IDs are encoded')
assert.deepEqual(JSON.parse(calls[0].body), requested, 'the posted settings preserve the nested DTO paths')
assert.equal(calls[1].method, 'GET')
assert.equal(calls[1].url.endsWith('/jobs/job%2Fwith%20space/settings'), true)

const ignoredCalls = install({ ignoreViaCosts: true })
await assert.rejects(() => frSetAndVerifyJobSettings('job-B', requested), /scoring\.via_costs: requested=73, effective=50/)
assert.deepEqual(ignoredCalls.map(call => call.method), ['POST', 'GET'], 'mismatch is discovered before the caller may start the job')

const unavailableCalls = install({ getFailure: true })
await assert.rejects(() => frSetAndVerifyJobSettings('job-C', requested), /effective settings 读回失败/)
assert.deepEqual(unavailableCalls.map(call => call.method), ['POST', 'GET'], 'unknown readback fails closed after the settings write')

const noSettingsCalls = install()
assert.equal(await frSetAndVerifyJobSettings('job-D'), undefined, 'omitted settings preserve the existing no-settings path')
assert.deepEqual(noSettingsCalls, [], 'omitted settings do not issue settings API calls')

console.log('PASS FreeRouting RouterSettings DTO mapping readback verification')
