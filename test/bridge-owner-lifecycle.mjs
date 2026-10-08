import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
	plugins: [{
		name: 'mock-index-dependencies',
		setup(build) {
			build.onResolve({ filter: /^\.\/bridge\/client$/ }, () => ({ path: 'bridge-client', namespace: 'mock' }));
			build.onResolve({ filter: /^\.\/commands\// }, args => ({ path: args.path, namespace: 'mock' }));
			build.onResolve({ filter: /^\.\/engine\/registry$/ }, () => ({ path: 'registry', namespace: 'mock' }));
			build.onLoad({ filter: /.*/, namespace: 'mock' }, args => {
				if (args.path === 'bridge-client') {
					return { contents: `
						export const getBridgeLifecycleStatus = () => globalThis.__bridge.status;
						export const startBridgeClient = () => {
							globalThis.__bridge.startCalls++;
							if (globalThis.__bridge.failStarts > 0) {
								globalThis.__bridge.failStarts--;
								throw new Error('start failed');
							}
							if (!globalThis.__clientStarted) { globalThis.__clientStarted = true; globalThis.__bridge.clientInstances++; }
						};
						export const stopBridgeClient = () => { globalThis.__bridge.stopCalls++; globalThis.__bridge.status = 'stopped'; };
						export const reconnectBridgeClient = () => { globalThis.__bridge.reconnectCalls++; globalThis.__bridge.status = 'reconnecting'; };
					` };
				}
				if (args.path === 'registry')
					return { contents: 'export const executeCommand = async () => ({}); export const getCommandDocs = () => []; export const listCommandNames = () => ["demo.command"]; export const registerCommand = () => { if (globalThis.__bridge.failRegistrations > 0) { globalThis.__bridge.failRegistrations--; throw new Error("register failed"); } };' };
				return { contents: 'export const cbbCommands=[{name:"demo.command"}]; export const editorCommands=[]; export const knowledgeCommands=[]; export const libCommands=[]; export const pcbCommands=[]; export const pcbGroupingCommands=[]; export const libraryCommands=[]; export const projectCommands=[]; export const schematicCommands=[]; export const systemCommands=[];' };
			});
		},
	}],
});

function makeBus({ subscribeFailureAt = 0, publishFailureAt = 0, rpcServiceFailure = false, onRpcService = null } = {}) {
	const topics = new Map();
	const services = new Map();
	let subscribeCalls = 0;
	let publishCalls = 0;
	return {
		topics,
		services,
		messageBus: {
			subscribe(topic, callback) {
				subscribeCalls++;
				if (subscribeCalls === subscribeFailureAt)
					throw new Error('subscribe failed');
				const listeners = topics.get(topic) ?? new Set();
				listeners.add(callback);
				topics.set(topic, listeners);
				return { cancel: () => listeners.delete(callback), running: () => listeners.has(callback) };
			},
			publish(topic, message) {
				publishCalls++;
				if (publishCalls === publishFailureAt)
					throw new Error('publish failed');
				for (const callback of [...(topics.get(topic) ?? [])])
					callback(message);
			},
			rpcService(topic, callback) {
				if (rpcServiceFailure)
					throw new Error('rpcService failed');
				services.set(topic, callback);
				onRpcService?.(topic);
			},
			rpcCall(topic, message) {
				const callback = services.get(topic);
				if (!callback)
					return Promise.reject(new Error('rpc service missing'));
				return Promise.resolve(callback(message));
			},
		},
	};
}

function createModule(bus, sharedBridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' }) {
	const messages = [];
	const context = {
		exports: {},
		module: { exports: {} },
		__bridge: sharedBridge,
		__clientStarted: false,
		eda: {
			sys_MessageBus: bus.messageBus,
			sys_Log: { add: () => {} },
			sys_Dialog: { showInformationMessage: (...args) => messages.push(args) },
			sys_ClientUrl: { request: async () => ({ status: 200 }) },
			sys_Window: { open: () => {} },
		},
		console,
		Error,
	};
	vm.runInNewContext(compiled.outputFiles[0].text, context);
	return { api: context.module.exports, context, messages };
}

function addOwner(bus, id, version = '0.10.77', phase = 'ready') {
	const rpcTopic = `fake-rpc:${id}`;
	bus.messageBus.subscribe('ai-command-engine:owner:query:v1', request => bus.messageBus.publish(request.replyTopic, { id, rpcTopic, phase, version }));
	bus.messageBus.rpcService(rpcTopic, () => ({ status: 'fake' }));
}

let passed = 0;
async function test(name, fn) {
	await fn();
	console.log(`PASS ${name}`);
	passed++;
}

await test('same module repeated activation creates one owner and one client', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const owner = createModule(bus, bridge);
	owner.api.activate();
	owner.api.activate();
	assert.equal(bridge.clientInstances, 1);
	assert.equal(bus.services.size, 1);
});

await test('Promise.all activation across modules creates one client', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const a = createModule(bus, bridge), b = createModule(bus, bridge);
	await Promise.all([Promise.resolve().then(() => a.api.activate()), Promise.resolve().then(() => b.api.activate())]);
	assert.equal(bridge.clientInstances, 1);
	assert.equal(bus.services.size, 1);
});

await test('synchronous reentry sees the initializing placeholder', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const a = createModule(bus, bridge), b = createModule(bus, bridge);
	let reentered = false;
	const original = bus.messageBus.rpcService;
	bus.messageBus.rpcService = (topic, callback) => {
		original(topic, callback);
		if (!reentered) {
			reentered = true;
			b.api.activate();
		}
	};
	a.api.activate();
	assert.equal(bridge.clientInstances, 1);
	assert.equal(bus.services.size, 1);
	assert.equal((await b.api.connectBridge()), undefined);
	assert.equal(bridge.clientInstances, 1);
});

await test('synchronous client start failure retains the owner for menu retry', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected', failStarts: 1 };
	const owner = createModule(bus, bridge), menu = createModule(bus, bridge);
	owner.api.activate();
	assert.equal(bridge.clientInstances, 0);
	assert.equal(bus.services.size, 1);
	assert.ok(owner.messages.some(message => String(message[0]).includes('激活失败')));
	menu.api.activate();
	assert.equal(bridge.clientInstances, 0);
	assert.equal(bus.services.size, 1);
	await menu.api.connectBridge();
	assert.equal(bridge.clientInstances, 1);
	assert.equal(bridge.startCalls, 2);
});

await test('command registration failure releases the initializing owner and never starts', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected', failRegistrations: 1 };
	const module = createModule(bus, bridge);
	module.api.activate();
	assert.equal(bridge.clientInstances, 0);
	assert.equal(bus.topics.get('ai-command-engine:owner:query:v1')?.size ?? 0, 0);
	assert.ok(module.messages.some(message => String(message[0]).includes('register failed')));
});

await test('different EDA windows keep independent owners', async () => {
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const busA = makeBus(), busB = makeBus();
	createModule(busA, bridge).api.activate();
	createModule(busB, bridge).api.activate();
	assert.equal(bridge.clientInstances, 2);
	assert.equal(busA.services.size, 1);
	assert.equal(busB.services.size, 1);
});

for (const [name, options] of [
	['temporary subscribe throws', { subscribeFailureAt: 1 }],
	['owner placeholder subscribe throws', { subscribeFailureAt: 2 }],
	['query publish throws', { publishFailureAt: 1 }],
	['rpcService throws', { rpcServiceFailure: true }],
]) {
	await test(`${name} does not start a client`, async () => {
		const bus = makeBus(options);
		const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
		const module = createModule(bus, bridge);
		module.api.activate();
		assert.equal(bridge.clientInstances, 0);
		assert.ok(module.messages.some(message => String(message[0]).includes('激活失败')));
	});
}

await test('multiple owners and mismatched owner version fail without a client', async () => {
	const bus = makeBus();
	addOwner(bus, 'a', '0.10.78');
	addOwner(bus, 'b', '0.10.78');
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const module = createModule(bus, bridge);
	module.api.activate();
	assert.equal(bridge.clientInstances, 0);
	assert.ok(module.messages.some(message => String(message[0]).includes('2 个')));
});

await test('incompatible owner version is explicit and does not look like no owner', async () => {
	const bus = makeBus();
	addOwner(bus, 'old', '0.10.77');
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const module = createModule(bus, bridge);
	module.api.activate();
	assert.equal(bridge.clientInstances, 0);
	assert.ok(module.messages.some(message => String(message[0]).includes('不兼容')));
});

for (const [name, malformed] of [
	['missing id', { rpcTopic: 'fake-rpc:bad', phase: 'ready', version: '0.10.78' }],
	['empty rpc topic', { id: 'bad', rpcTopic: ' ', phase: 'ready', version: '0.10.78' }],
	['invalid phase', { id: 'bad', rpcTopic: 'fake-rpc:bad', phase: 'broken', version: '0.10.78' }],
]) {
	await test(`invalid owner reply (${name}) fails closed without starting`, async () => {
		const bus = makeBus();
		bus.messageBus.subscribe('ai-command-engine:owner:query:v1', request => bus.messageBus.publish(request.replyTopic, malformed));
		const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
		const module = createModule(bus, bridge);
		module.api.activate();
		assert.equal(bridge.clientInstances, 0);
		assert.equal(bus.services.size, 0);
		assert.ok(module.messages.some(message => String(message[0]).includes('无效')));
	});
}

await test('menus without an owner fail explicitly and do not activate locally', async () => {
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const module = createModule(makeBus(), bridge);
	await module.api.connectBridge();
	assert.equal(bridge.clientInstances, 0);
	assert.ok(module.messages.some(message => String(message[0]).includes('未发现')));
});

await test('secondary menus route reconnect, stop, start and status through the single owner', async () => {
	const bus = makeBus();
	const bridge = { startCalls: 0, clientInstances: 0, stopCalls: 0, reconnectCalls: 0, status: 'connected' };
	const owner = createModule(bus, bridge), menu = createModule(bus, bridge);
	owner.api.activate();
	menu.api.activate();
	const instances = bridge.clientInstances;
	await menu.api.reconnectBridge();
	await menu.api.disconnectBridge();
	await menu.api.connectBridge();
	await menu.api.about();
	assert.equal(bridge.clientInstances, instances);
	assert.equal(bridge.reconnectCalls, 1);
	assert.equal(bridge.stopCalls, 1);
	assert.equal(bridge.startCalls, 2);
	assert.ok(menu.messages.some(message => String(message[0]).includes('AI Command Engine v')));
});

console.log(`${passed}/${passed} bridge owner lifecycle cases passed`);
