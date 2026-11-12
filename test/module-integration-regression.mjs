import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile('extension.json', 'utf8'));
assert.equal(manifest.version, '0.21.2');
for (const surface of ['home', 'sch', 'pcb']) {
	const groups = manifest.headerMenus[surface];
	assert.equal(groups.length, 1, `${surface} keeps a single top-level menu`);
	assert.equal(groups[0].menuItems.filter(item => item.id === 'ModuleReuse').length, 1);
	assert.equal(groups[0].menuItems.find(item => item.id === 'ModuleReuse').registerFn, 'openModuleTools');
}
const index = await readFile('src/index.ts', 'utf8');
assert.match(index, /\.\.\.moduleCommands/);
assert.match(index, /case 'open-modules'/);
assert.match(index, /case 'module-menu-context'/);
assert.match(index, /case 'module-menu-command'/);
assert.match(index, /MODULE_MENU_COMMANDS/);
assert.match(index, /module\.restoreFile/);
assert.match(index, /module\.getRestoreOperation/);
assert.match(index, /ok: false,\s*error:\s*\{/);
assert.match(index, /source: 'menu-project-preflight'/);
assert.match(index, /outcomeUnknown: false/);
assert.match(index, /restoreOutcomeUnknown: projectUuidOf/);
const frame = await readFile('iframe/module-library/index.html', 'utf8');
assert.match(frame, /window\.eda && window\.eda\.aiCommandModules/);
assert.match(frame, /提取、组合或替换模块时，请让 AI 协助/);
assert.match(frame, /metadataVerified/);
assert.match(frame, /lastRestoreOperationId/);
assert.match(frame, /restoreOutcomeUnknown/);
assert.match(frame, /查询上次恢复状态/);
assert.match(frame, /module\.getRestoreOperation/);
assert.match(frame, /cause\?\.partial === false/);
assert.match(frame, /restoreOutcomeUnknown = restoreStarted && !confirmedNotStarted/);
assert.match(frame, /restoreOutcomeUnknown = context\?\.restoreOutcomeUnknown === true/);
assert.match(frame, /const wasUnknown = restoreOutcomeUnknown/);
assert.match(frame, /restoreOutcomeUnknown = wasUnknown/);
assert.doesNotMatch(frame, /fetch\s*\(/);

const iframeScript = frame.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(iframeScript, 'module library panel includes its interaction script');
async function runRestoreUiScenario(restoreCommand) {
	class Node {
		constructor(id = '') { this.id = id; this.children = []; this.handlers = new Map(); this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
		append(child) { this.children.push(child); }
		replaceChildren(...children) { this.children = [...children]; }
		addEventListener(name, handler) { this.handlers.set(name, handler); }
		async click() { return this.handlers.get('click')?.({ target: this }); }
	}
	const nodes = new Map();
	const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); }, createElement: () => new Node() };
	const commandCalls = [];
	const api = {
		getContext: async () => ({ project: { uuid: 'project-1', name: 'Test' }, library: { directory: 'D:\\module-library', source: 'user' }, lastRestoreOperationId: '', restoreOutcomeUnknown: false }),
		command: async (cmd, params) => {
			commandCalls.push({ cmd, params });
			if (cmd === 'module.libraryList') return { ok: true, data: [{ localId: 'test-module', version: '1.0', name: 'Test module' }] };
			if (cmd === 'module.libraryGet') return { ok: true, data: { files: [{ role: 'native', relativePath: 'test.epro2', base64: 'YQ==' }] } };
			if (cmd === 'module.restoreFile') return restoreCommand(params);
			throw new Error(`unexpected command ${cmd}`);
		},
	};
	const window = { eda: { aiCommandModules: api }, confirm: () => true };
	const context = { window, document, console, Date, Math, Promise, Error };
	vm.runInNewContext(iframeScript, context);
	await new Promise(resolve => setTimeout(resolve, 0));
	const select = document.getElementById('module');
	select.value = select.children[1].value;
	await document.getElementById('restore').click();
	return { document, commandCalls };
}
{
	const notStarted = await runRestoreUiScenario(async () => ({ ok: false, error: { message: 'busy', cause: { partial: false, source: 'module-operation-busy' } } }));
	assert.equal(notStarted.document.getElementById('restore').disabled, false, 'confirmed pre-write rejection permits a later retry');
	assert.match(notStarted.document.getElementById('status').textContent, /已确认恢复没有开始/);
	const unknown = await runRestoreUiScenario(async () => { throw new Error('host response lost'); });
	assert.equal(unknown.document.getElementById('restore').disabled, true, 'lost restore response keeps duplicate submission blocked');
	assert.match(unknown.document.getElementById('status').textContent, /operationId=/);
	assert.ok(unknown.commandCalls.find(call => call.cmd === 'module.restoreFile')?.params.operationId);
}

const ownerBundle = await build({ entryPoints: ['src/bridge/owner.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const ownerContext = { exports: {}, module: { exports: {} }, eda: null };
const listeners = new Map();
const rpcHandlers = new Map();
const rpcMessages = [];
ownerContext.eda = { sys_MessageBus: {
	subscribe(topic, callback) { const set = listeners.get(topic) ?? new Set(); set.add(callback); listeners.set(topic, set); return { cancel: () => set.delete(callback) }; },
	publish(topic, message) { for (const callback of listeners.get(topic) ?? []) callback(message); },
	rpcService(topic, callback) { rpcHandlers.set(topic, callback); },
	rpcCall(topic, message) { rpcMessages.push(message); return Promise.resolve(rpcHandlers.get(topic)(message)); },
} };
vm.runInNewContext(ownerBundle.outputFiles[0].text, ownerContext);
const owner = ownerContext.module.exports.createBridgeOwnerCoordinator('0.21.2');
assert.equal(owner.activate(() => ({ ok: true })), 'owner');
owner.markReady();
await owner.request('status');
await owner.request('module-menu-command', { cmd: 'module.libraryList', params: {} });
assert.deepEqual(JSON.parse(JSON.stringify(rpcMessages)), [
	{ method: 'status' },
	{ method: 'module-menu-command', payload: { cmd: 'module.libraryList', params: {} } },
]);

const registryBundle = await build({ entryPoints: ['src/engine/registry.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const guardBundle = await build({ entryPoints: ['src/engine/moduleExecution.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
function createRegistry() {
	const context = { exports: {}, module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, eda: { sys_Log: { add() {} } } };
	vm.runInNewContext(registryBundle.outputFiles[0].text, context);
	return context.module.exports;
}
function createGuard() {
	const context = { exports: {}, module: { exports: {} } };
	vm.runInNewContext(guardBundle.outputFiles[0].text, context);
	return context.module.exports.runWithModuleExecution;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

{
	const run = createGuard();
	const pending = deferred();
	const operation = run('module.placeSchematicPage', () => pending.promise);
	for (const cmd of ['schematic.getNetlist', 'schematic.exportNetlist']) {
		await assert.rejects(run(cmd, () => assert.fail(`${cmd} must not start while a module operation is active`)), error => error?.cause?.source === 'module-operation-busy' && error.cause.partial === false);
	}
	assert.deepEqual(await run('module.getRestoreOperation', async () => ({ state: 'pending' })), { state: 'pending' });
	assert.deepEqual(await run('module.libraryInfo', async () => ({ directory: 'local' })), { directory: 'local' });
	pending.resolve({ done: true });
	await operation;
}

{
	const registry = createRegistry();
	const pending = deferred();
	let writes = 0;
	registry.registerCommand({ name: 'module.longOperation', params: [], handler: () => pending.promise });
	registry.registerCommand({ name: 'module.getStatus', params: [], handler: async () => ({ running: true }) });
	registry.registerCommand({ name: 'design.writeProbe', params: [], handler: async () => { writes++; return 'written'; } });
	const timedOut = await registry.executeCommand({ cmd: 'module.longOperation', params: { _timeoutMs: 1000 } });
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.error.cause.partial, true);
	const blockedWrite = await registry.executeCommand({ cmd: 'design.writeProbe' });
	assert.equal(blockedWrite.ok, false);
	assert.equal(blockedWrite.error.cause.partial, false);
	assert.equal(blockedWrite.error.cause.source, 'module-operation-busy');
	assert.equal(writes, 0);
	assert.equal((await registry.executeCommand({ cmd: 'module.getStatus' })).ok, true);
	pending.resolve({ completed: true });
	await pause(0);
	assert.equal((await registry.executeCommand({ cmd: 'design.writeProbe' })).ok, true);
	assert.equal(writes, 1);
}

{
	const registry = createRegistry();
	const pending = deferred();
	let writes = 0;
	registry.registerCommand({ name: 'module.longOperation', params: [], handler: () => pending.promise });
	registry.registerCommand({ name: 'design.writeProbe', params: [], handler: async () => { writes++; return 'written'; } });
	const macro = await registry.executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ cmd: 'module.longOperation', params: { _timeoutMs: 1000 } },
		{ cmd: 'design.writeProbe' },
	] } });
	assert.equal(macro.ok, false);
	assert.equal(macro.data.stoppedReason, 'partial');
	assert.equal(macro.data.steps.length, 1);
	assert.equal(writes, 0);
	pending.resolve({ completed: true });
}

{
	const registry = createRegistry();
	const first = deferred();
	const second = deferred();
	let started = 0;
	registry.registerCommand({ name: 'design.writeProbe', params: [], handler: () => (++started === 1 ? first.promise : second.promise) });
	const a = registry.executeCommand({ cmd: 'design.writeProbe' });
	const b = registry.executeCommand({ cmd: 'design.writeProbe' });
	assert.equal(started, 2, 'ordinary ACE design writes retain existing concurrency behavior');
	first.resolve('one');
	second.resolve('two');
	assert.equal((await a).ok, true);
	assert.equal((await b).ok, true);
}

console.log('PASS module integration, owner payload, execution guard and menu routing');

