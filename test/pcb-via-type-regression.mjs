import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

async function main() {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const bundle = await build({
		entryPoints: [path.join(repo, 'src/commands/pcb.ts')],
		bundle: true,
		platform: 'node',
		format: 'iife',
		globalName: 'pcbModule',
		write: false,
	});
	const sandbox = { exports: {}, module: { exports: {} }, eda: {}, performance, setTimeout, clearTimeout };
	vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
	const commands = sandbox.pcbModule.pcbCommands;
	const placeVia = commands.find(command => command.name === 'pcb.placeVia').handler;
	const modifyVia = commands.find(command => command.name === 'pcb.modifyVia').handler;
	const listVias = commands.find(command => command.name === 'pcb.listVias').handler;
	let writeCalls = 0;
	const createdVias = new Map();
	const createdTypes = [];
	let createId = 0;
	const makeVia = (id, net, x, y, holeDiameter, diameter, viaType) => ({
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_X: () => x,
		getState_Y: () => y,
		getState_Diameter: () => diameter,
		getState_HoleDiameter: () => holeDiameter,
		getState_ViaType: () => viaType,
		getState_PrimitiveLock: () => false,
	});
	sandbox.eda.dmt_SelectControl = { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-test' }) };
	sandbox.eda.pcb_Net = { getAllNetsName: async () => ['GND'] };
	sandbox.eda.pcb_PrimitiveVia = {
		create: async (net, x, y, holeDiameter, diameter, viaType) => {
			writeCalls++;
			createdTypes.push(viaType);
			const id = `via-${++createId}`;
			const via = makeVia(id, net, x, y, holeDiameter, diameter, viaType);
			createdVias.set(id, via);
			return via;
		},
		getAllPrimitiveId: async () => [...createdVias.keys()],
		getAll: async () => [...createdVias.values()],
		modify: async (id, properties) => {
			writeCalls++;
			const via = createdVias.get(id);
			if (!via)
				return undefined;
			const current = ['Net', 'X', 'Y', 'HoleDiameter', 'Diameter', 'ViaType'].map(name => via[`getState_${name}`]());
			const [net, x, y, holeDiameter, diameter, viaType] = current;
			const updated = makeVia(id, properties.net ?? net, properties.x ?? x, properties.y ?? y, properties.holeDiameter ?? holeDiameter, properties.diameter ?? diameter, properties.viaType ?? viaType);
			createdVias.set(id, updated);
			return updated;
		},
	};
	sandbox.eda.pcb_Document = { startCalculatingRatline: async () => true };
	// Missing source/layer getters make the existing endpoint-refresh phase return a documented skipped result.

	const invalidVia = { net: 'GND', x: 1, y: 2, holeDiameter: 10, diameter: 20, viaType: 1 };
	await assert.rejects(placeVia(invalidVia), /viaType 仅支持 0.*2/);
	await assert.rejects(modifyVia({ primitiveId: 'via-missing', viaType: 1 }), /viaType 仅支持 0.*2/);
	assert.equal(writeCalls, 0, 'unsupported via types must be rejected before any SDK write');

	const defaultPlaced = await placeVia({ net: 'GND', x: 1, y: 2, holeDiameter: 10, diameter: 20 });
	assert.equal(defaultPlaced.readbackVerified, true);
	assert.equal(createdTypes.at(-1), 0, 'omitted viaType must create a normal via');
	assert.equal(createdVias.get(defaultPlaced.primitiveId).getState_ViaType(), 0, 'default via type must be present in fresh readback');

	const stitchPlaced = await placeVia({ net: 'GND', x: 3, y: 4, holeDiameter: 10, diameter: 20, viaType: 2 });
	assert.equal(stitchPlaced.readbackVerified, true);
	assert.equal(createdTypes.at(-1), 2, 'viaType 2 must be forwarded to SDK create');
	assert.equal(createdVias.get(stitchPlaced.primitiveId).getState_ViaType(), 2, 'stitch via type must be present in fresh readback');
	assert.equal((await listVias({})).find(via => via.primitiveId === stitchPlaced.primitiveId).viaType, 2);
	const changedToVia = await modifyVia({ primitiveId: stitchPlaced.primitiveId, viaType: 0 });
	assert.equal(changedToVia.modified, true);
	assert.equal(changedToVia.readback.viaType, 0, 'modifyVia must allow the value zero and verify its readback');
	assert.equal(createdVias.get(stitchPlaced.primitiveId).getState_ViaType(), 0);
	assert.equal(writeCalls, 3, 'only the two valid placements and one valid modification should write');

	console.log('PCB via type regression passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
