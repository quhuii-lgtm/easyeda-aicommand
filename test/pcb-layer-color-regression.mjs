import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const bundled = await build({
	stdin: { contents: `import { pcbLayerColorCommands } from '../src/commands/pcbLayerColor.ts'; export { pcbLayerColorCommands }`, resolveDir: resolve(root, 'test'), sourcefile: 'pcb-layer-color-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false,
});
const { pcbLayerColorCommands } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const handlers = Object.fromEntries(pcbLayerColorCommands.map(command => [command.name, command.handler]));
let focus = { documentType: 3, uuid: 'pcb-a', tabId: 'tab-a' };
let layers = [{ id: 3, color: '#111111' }, { id: 4, color: '#222222' }];
let writes = [];
let modify = async (id, property) => {
	writes.push({ id, property });
	const layer = layers.find(item => item.id === id);
	layer.color = property.color;
	return true;
};
let afterLayerRead;
const getFocus = async () => focus;
globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: getFocus },
	pcb_Layer: {
		getAllLayers: async () => { const snapshot = structuredClone(layers); afterLayerRead?.(); return snapshot },
		modifyLayer: (...args) => modify(...args),
	},
};
const reset = () => {
	focus = { documentType: 3, uuid: 'pcb-a', tabId: 'tab-a' };
	layers = [{ id: 3, color: '#111111' }, { id: 4, color: '#222222' }];
	writes = []; modify = async (id, property) => { writes.push({ id, property }); layers.find(item => item.id === id).color = property.color; return true };
	afterLayerRead = undefined;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = getFocus;
};

reset();
const setTop = await handlers['pcb.setSilkscreenColor']({ side: 'top', color: '#abcdef', __docUuid: 'pcb-a', __tabId: 'tab-a' });
assert.equal(setTop.verified, true);
assert.deepEqual(writes, [{ id: 3, property: { color: '#ABCDEF' } }], 'top silk is layer 3 and modifyLayer receives only color');

reset();
modify = async (id, property) => { writes.push({ id, property }); layers.find(item => item.id === id).color = property.color; return false };
const ackFalse = await handlers['pcb.setSilkscreenColor']({ side: 'bottom', color: '#ABCDEF' });
assert.equal(ackFalse.verified, true, 'readback confirms the change even when SDK ACK is false');
assert.equal(writes[0].id, 4, 'bottom silk is layer 4');

reset();
layers[1].color = '#111111';
const same = await handlers['pcb.setSilkscreenColor']({ side: 'both', color: '#111111' });
assert.equal(same.verified, true);
assert.equal(writes.length, 0, 'same color skips all writes');

reset();
let attempts = 0;
modify = async (id, property) => {
	writes.push({ id, property }); attempts++;
	if (id === 3) { layers[0].color = property.color; return true }
	return false;
};
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'both', color: '#ABCDEF' }),
	error => {
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.layers.top.verified, true);
		assert.equal(error.cause.layers.bottom.verified, false);
		assert.equal(error.cause.layers.bottom.before, '#222222');
		assert.equal(error.cause.layers.bottom.target, '#ABCDEF');
		assert.equal(error.cause.layers.bottom.observed, '#222222');
		return true;
	},
);
assert.equal(attempts, 2, 'failure stops after bottom; no later writes are sent');

reset();
await assert.rejects(handlers['pcb.setSilkscreenColor']({ side: 'top', color: 'red' }), /#RRGGBB/);
assert.equal(writes.length, 0, 'invalid input is rejected before SDK access');

reset();
let focusReads = 0;
globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => {
	focusReads++;
	return focusReads > 3 ? { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' } : focus;
};
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'both', color: '#111111' }),
	error => {
		assert.equal(error.cause?.partial, undefined, 'all-skip document change is a normal no-write error');
		return /文档已变化/.test(error.message);
	},
);
assert.equal(writes.length, 0, 'document change after same-color skips is still rejected');

reset();
focusReads = 0;
globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => {
	focusReads++;
	return focusReads > 4 ? { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' } : focus;
};
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'both', color: '#ABCDEF' }),
	error => {
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.layers.top.verified, true, 'first layer success remains in partial evidence');
		assert.equal(error.cause.layers.bottom, undefined, 'second layer is recorded as not attempted');
		return /未处理 bottom/.test(error.message);
	},
);
assert.equal(writes.length, 1, 'tab switch after first layer readback prevents bottom layer write');

reset();
focusReads = 0;
globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => {
	focusReads++;
	return focusReads > 4 ? { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' } : focus;
};
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'top', color: '#ABCDEF' }),
	error => {
		assert.equal(error.cause.partial, true, 'final focus failure after a verified write is partial');
		assert.equal(error.cause.layers.top.verified, true);
		assert.equal(error.cause.before.top, '#111111');
		assert.equal(error.cause.target, '#ABCDEF');
		return /最终复核失败/.test(error.message);
	},
);
assert.equal(writes.length, 1, 'final check does not trigger a retry');

reset();
afterLayerRead = () => { focus = { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' } };
await assert.rejects(handlers['pcb.getSilkscreenColors']({ __docUuid: 'pcb-a', __tabId: 'tab-a' }), /文档或标签页已变化/);

reset();
afterLayerRead = () => { focus = { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' } };
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'top', color: '#ABCDEF', __docUuid: 'pcb-a', __tabId: 'tab-a' }),
	error => {
		assert.equal(error.cause?.partial, undefined, 'pre-write page change is not reported as a partial write');
		return /文档或标签页已变化/.test(error.message);
	},
);
assert.equal(writes.length, 0);

reset();
let readCount = 0;
globalThis.eda.pcb_Layer.getAllLayers = async () => {
	readCount++;
	if (readCount === 1) return structuredClone(layers);
	layers[0].color = '#ABCDEF';
	const value = structuredClone(layers);
	focus = { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b' };
	return value;
};
await assert.rejects(
	handlers['pcb.setSilkscreenColor']({ side: 'both', color: '#ABCDEF' }),
	error => {
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.layers.top.verified, false, 'readback from a switched document is not trusted');
		assert.equal(error.cause.layers.top.observed, null);
		return true;
	},
);
assert.equal(writes.length, 1, 'document change during readback prevents later layer writes');

console.log('PASS PCB silkscreen color commands validate layer IDs, color-only writes, readback, partial results, and document stability');
