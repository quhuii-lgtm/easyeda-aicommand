import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const primitive = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]));
function pad(changes) {
	return primitive({ PrimitiveId: 'p', Net: 'N', X: 10, Y: 20, Layer: 1, Hole: null, Metallization: true,	Pad: ['ELLIPSE', 20, 20], SpecialPad: undefined, Rotation: 0, HoleOffsetX: 0, HoleOffsetY: 0, ...changes });
}
async function main() {
	const built = await build({ entryPoints: [resolve(import.meta.dirname, '../src/pcb/lengthTuneContacts.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
	const { readTuneContacts, tunePadContact } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	assert.deepEqual(tunePadContact(pad(), 1), { id: 'p', net: 'N', layers: [1], kind: 'circle', center: [10, 20], radius: 10 });
	assert.equal(tunePadContact(pad({ Hole: ['ROUND', 8], Layer: 12 }), 1).holeRadius, 4);
	assert.equal(tunePadContact(pad({ Hole: ['ROUND', 8], HoleOffsetX: 1 }), 1).kind, 'unknown');
	assert.deepEqual(tunePadContact(pad({ Pad: ['RECT', 20, 10, 0], Rotation: 45 }), 1),	{ id: 'p', net: 'N', layers: [1], kind: 'rect', center: [10, 20], width: 20, height: 10, rotation: 45 });
	assert.equal(tunePadContact(pad({ Pad: ['RECT', 20, 10, 2] }), 1).kind, 'unknown');
	assert.equal(tunePadContact(pad({ Pad: ['RECT', 20, 10, 0], Hole: ['ROUND', 8] }), 1).kind, 'unknown');
	assert.deepEqual(tunePadContact(pad({ Layer: 12, Metallization: false }), 1).layers, null);
	assert.equal(tunePadContact(pad({ SpecialPad: [[1, 1, ['RECT', 10, 12, 0]]] }), 1).kind, 'rect');
	assert.equal(tunePadContact(pad({ SpecialPad: [[1, 1, ['RECT', 10, 12, 0]], [1, 1, ['ELLIPSE', 12, 12]]] }), 1).kind, 'unknown');
	assert.equal(tunePadContact(pad({ SpecialPad: [[1, 'bad', ['RECT', 10, 12, 0]]] }), 1).kind, 'unknown');
	assert.equal(tunePadContact(pad({ Layer: 12, SpecialPad: [[1, 2, ['RECT', 10, 12, 0]]] }), 15).kind, 'unknown', 'do not expand numeric layer IDs as physical layer order');
	assert.throws(() => tunePadContact(pad({ Rotation: Number.NaN }), 1), /有限/);

	let padEnumerations = 0, componentEnumerations = 0;
	const component = { ...primitive({ PrimitiveId: 'c' }), getAllPins: async () => [pad(), pad({ PrimitiveId: 'cp', Layer: 2 })] };
	const sdk = {
		pcb_PrimitivePad: { getAll: async () => { padEnumerations++; return [pad()] } },
		pcb_PrimitiveComponent: { getAll: async () => { componentEnumerations++; return [component] } },
		pcb_PrimitiveVia: { getAll: async () => [primitive({ PrimitiveId: 'v', Net: 'N', X: 5, Y: 6, Diameter: 20, HoleDiameter: 10, ViaType: 0 })] },
		pcb_PrimitiveArc: { getAll: async () => [] },
		pcb_PrimitiveFill: { getAll: async () => [] },
		pcb_PrimitivePour: { getAll: async () => [primitive({ PrimitiveId: 'pour', Net: 'N', Layer: 1, LineWidth: 2, ComplexPolygon: { getSource: () => ['R', 100, 200, 20, 40, 0, 0] } })] },
		pcb_PrimitivePolyline: { getAll: async () => [primitive({ PrimitiveId: 'polyline', Net: 'N', Layer: 1, LineWidth: 2, Polygon: { getSource: () => [500, 500, 'L', 510, 500, 'L', 510, 510] } })] },
		pcb_PrimitivePoured: { getAll: async () => [primitive({ PrimitiveId: 'filled', PourPrimitiveId: 'pour', PourFills: [{ fill: true, lineWidth: 0, coordinateUnit: 'mil', path: [100, 200, 'L', 120, 200, 120, 160, 100, 160] }] })] },
	};
	const labels = [];
	const host = { sdk, read: async (label, fn) => {
		labels.push(label);
		return fn();
	}, checkBudget: () => {} };
	const contacts = await readTuneContacts(host, 1);
	assert.equal(contacts.filter(x => x.id === 'p').length, 1, 'component pin deduplication');
	assert.equal(contacts.find(x => x.id === 'cp').layers[0], 2);
	assert.equal(contacts.find(x => x.id === 'v').holeRadius, 5);
	assert.deepEqual(contacts.find(x => x.id === 'pour').bounds, { xMin: 99, xMax: 121, yMin: 159, yMax: 201 });
	assert.deepEqual(contacts.find(x => x.id === 'polyline').bounds, { xMin: 499, xMax: 511, yMin: 499, yMax: 511 });
	assert.deepEqual(contacts.find(x => x.id === 'filled:0').bounds, { xMin: 100, xMax: 120, yMin: 160, yMax: 200 });
	assert.ok(labels.some(x => x.includes('器件 c 焊盘')));
	labels.length = 0;
	const cachedContacts = await readTuneContacts(host, 1, [pad(), ...await component.getAllPins()]);
	assert.equal(cachedContacts.filter(x => x.id === 'p').length, 1, 'cached PAD objects retain component-pin deduplication');
	assert.equal(padEnumerations, 1, 'cached PAD objects avoid a second independent-PAD enumeration');
	assert.equal(componentEnumerations, 1, 'cached PAD objects avoid a second component enumeration');
	assert.ok(!labels.some(x => x.includes('器件 c 焊盘')), 'cached component pins are not queried twice');
	sdk.pcb_PrimitiveVia.getAll = async () => undefined;
	await assert.rejects(readTuneContacts(host, 1), /过孔枚举无效/);
	console.log('length-tune-contacts-regression: all assertions passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
