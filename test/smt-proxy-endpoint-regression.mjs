import assert from 'node:assert/strict'
import vm from 'node:vm'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const compiled = await build({
	stdin: {
		contents: `export { openSmtQuery } from '../src/bridge/smtMenu.ts'; export { setProxyPort } from '../src/bridge/proxy-endpoint.ts'`,
		resolveDir: resolve(import.meta.dirname),
		sourcefile: 'smt-proxy-endpoint-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
})
const context = {
	module: { exports: {} },
	exports: {},
	requests: [],
	opened: [],
	dialogs: [],
	eda: {
		sys_ClientUrl: { request: async (url, method) => {
			context.requests.push({ url, method })
			return { status: 200, json: async () => ({ service: 'ai-command-proxy', lifecycleProtocol: 1 }) }
		} },
		sys_Window: { open: (...args) => context.opened.push(args) },
		sys_Dialog: { showInformationMessage: (...args) => context.dialogs.push(args) },
	},
}
vm.runInNewContext(compiled.outputFiles[0].text, context)
const { openSmtQuery, setProxyPort } = context.module.exports

setProxyPort(49721)
await openSmtQuery()
assert.deepEqual(context.requests, [{ url: 'http://localhost:49721/health', method: 'GET' }])
assert.deepEqual(context.opened, [['http://127.0.0.1:49721/smt', '_blank']])
assert.deepEqual(context.dialogs, [])

context.requests.length = 0
context.opened.length = 0
context.eda.sys_ClientUrl.request = async (url, method) => {
	context.requests.push({ url, method })
	return { status: 200, json: async () => ({ service: 'other-service', lifecycleProtocol: 1 }) }
}
await openSmtQuery()
assert.deepEqual(context.requests, [{ url: 'http://localhost:49721/health', method: 'GET' }])
assert.equal(context.opened.length, 0)
assert.equal(context.dialogs.length, 1)
console.log('PASS SMT health and page requests use the discovered alternate port and reject incompatible health')
