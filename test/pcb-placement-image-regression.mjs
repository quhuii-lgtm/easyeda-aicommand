import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: { contents: 'export { pcbPlacementImageCommands } from \'../src/commands/pcbPlacementImage.ts\'', resolveDir: resolve(root, 'test'), sourcefile: 'pcb-placement-image-entry.ts' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { pcbPlacementImageCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const command = name => pcbPlacementImageCommands.find(item => item.name === name);
	assert.equal(pcbPlacementImageCommands.length, 3);

	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==';
	const source = [[0, 0, 'L', 10, 0, 10, 10, 0, 10], [3, 3, 'L', 7, 3, 7, 7, 3, 7]];
	const fields = { primitiveId: 'image-1', x: 10, y: 20, layer: 3, width: 400, height: 300, rotation: 0, horizonMirror: false, primitiveLock: false, complexPolygon: source };
	let sourcePath = source;
	let createdSourcePathOverride;
	function sourceLog(path = sourcePath) {
		return [
			`${JSON.stringify({ type: 'DOCHEAD', id: 'DOCHEAD' })}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-1', client: 'test' })}|`,
			`${JSON.stringify({ type: 'IMAGE', id: fields.primitiveId, ticket: 1 })}||${JSON.stringify({ path, startX: fields.x, startY: fields.y, width: fields.width, height: fields.height, angle: fields.rotation, layerId: fields.layer, mirror: fields.horizonMirror, locked: fields.primitiveLock })}|`,
		].join('\n');
	}
	function makeImage(overrides = {}) {
		const current = { ...fields, ...overrides };
		return {
			getState_PrimitiveId: () => current.primitiveId,
			getState_X: () => current.x,
			getState_Y: () => current.y,
			getState_Layer: () => current.layer,
			getState_Width: () => current.width,
			getState_Height: () => current.height,
			getState_Rotation: () => current.rotation,
			getState_HorizonMirror: () => current.horizonMirror,
			getState_PrimitiveLock: () => current.primitiveLock,
			getState_ComplexPolygon: () => current.complexPolygon,
		};
	}
	function makeContext(assertTarget = async () => {}) {
		return { vars: {}, documentTarget: { documentType: 3, uuid: 'pcb-1' }, assertDocumentTarget: assertTarget };
	}
	const params = { imageBase64: png, imageWidth: 4, imageHeight: 4, x: 10, y: 20, layer: 3, width: 400, height: 300 };
	let createCalls = 0;
	let modifyCalls = 0;
	let createFailure;
	let modifyFailure;
	let convertedArgs;

	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => sourceLog() },
		pcb_Layer: { getAllLayers: async () => [{ id: 3, type: 'TOP_SILKSCREEN', layerStatus: 'HIDDEN' }, { id: 71, type: 'CUSTOM', layerStatus: 'HIDDEN' }] },
		pcb_MathPolygon: {
			convertImageToComplexPolygon: async (...args) => {
				convertedArgs = args;
				return { getSourceStrictComplex: () => source };
			},
		},
		pcb_PrimitiveImage: {
			create: async (...args) => {
				createCalls++;
				if (createFailure === 'throw')
					throw new Error('SDK create rejected');
				if (createFailure === 'undefined')
					return undefined;
				const [x, y, polygon, layer, width, height, rotation, horizonMirror, primitiveLock] = args;
				Object.assign(fields, { x, y, layer, width, height, rotation, horizonMirror, primitiveLock, complexPolygon: polygon.getSourceStrictComplex() });
				sourcePath = createdSourcePathOverride ?? polygon.getSourceStrictComplex();
				return makeImage();
			},
			get: async id => id === fields.primitiveId ? makeImage() : undefined,
			getAll: async () => [makeImage()],
			modify: async (_id, property) => {
				modifyCalls++;
				if (modifyFailure)
					throw new Error('SDK modify rejected');
				Object.assign(fields, property);
				return makeImage();
			},
		},
	};

	const place = command('pcb.placeImage');
	const placed = await place.handler(params, makeContext());
	assert.equal(createCalls, 1);
	assert.equal(placed.primitiveId, 'image-1');
	assert.equal(placed.vectorContours, 2);
	assert.equal(placed.imageKind, 'traced-vector');
	assert.equal(placed.trueColorPreserved, false);
	assert.equal(placed.sourcePathVerified, true);
	assert.equal(placed.saved, false);
	assert.equal(convertedArgs[1], 4);
	assert.equal(convertedArgs[2], 4);
	assert.equal(convertedArgs[0].type, 'image/png');

	const listed = await command('pcb.listImages').handler({}, makeContext());
	assert.equal(listed.count, 1);
	assert.equal(listed.images[0].primitiveId, 'image-1');

	const changed = await command('pcb.modifyImage').handler({ primitiveId: 'image-1', x: 15, rotation: 90 }, makeContext());
	assert.equal(modifyCalls, 1);
	assert.deepEqual(changed.changedProperties, { x: 15, rotation: 90 });
	assert.equal(changed.readback.x, 15);
	assert.equal(changed.readback.rotation, 90);
	assert.equal(changed.sourcePathVerified, true, 'rotation changes world transform but source-local path remains verified');

	await assert.rejects(() => place.handler({ ...params, imageWidth: 5 }, makeContext()), /实际尺寸为 4×4/);
	await assert.rejects(() => place.handler({ ...params, width: 0 }, makeContext()), /大于 0/);
	await assert.rejects(() => place.handler({ ...params, unknownOption: true }, makeContext()), /不支持的图片参数/);
	await assert.rejects(() => place.handler({ ...params, layer: 1.5 }, makeContext()), /官方支持的图片图层 ID/);
	await assert.rejects(() => place.handler({ ...params, layer: 7 }, makeContext()), /官方支持的图片图层 ID/);
	assert.equal(createCalls, 1, 'invalid inputs must fail before image creation');

	globalThis.eda.pcb_MathPolygon.convertImageToComplexPolygon = async () => undefined;
	await assert.rejects(() => place.handler(params, makeContext()), /未描摹出可放置轮廓，未创建图元/);
	assert.equal(createCalls, 1, 'empty trace must fail without a write');

	globalThis.eda.pcb_MathPolygon.convertImageToComplexPolygon = async () => ({ getSourceStrictComplex: () => source });
	const changedTarget = async () => {
		throw new Error('target changed');
	};
	await assert.rejects(() => place.handler(params, makeContext(changedTarget)), /target changed/);
	assert.equal(createCalls, 1, 'target mismatch must fail before a write');

	await assert.rejects(() => command('pcb.modifyImage').handler({ primitiveId: 'image-1' }, makeContext()), /至少传入一个/);
	assert.equal(modifyCalls, 1, 'empty modify must fail before a write');
	await assert.rejects(() => command('pcb.modifyImage').handler({ primitiveId: 'image-1', layer: 1.5 }, makeContext()), /官方支持的图片图层 ID/);
	await assert.rejects(() => command('pcb.modifyImage').handler({ primitiveId: 'image-1', layer: 7 }, makeContext()), /官方支持的图片图层 ID/);
	assert.equal(modifyCalls, 1, 'invalid modify layer must fail before a write');

	globalThis.eda.pcb_PrimitiveImage.get = async () => makeImage({ x: 999 });
	await assert.rejects(() => command('pcb.modifyImage').handler({ primitiveId: 'image-1', x: 22 }, makeContext()), (error) => {
		assert.match(error.message, /已调用宿主写入/);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		return true;
	});
	assert.equal(modifyCalls, 2, 'readback failure is reported after the single requested write');
	globalThis.eda.pcb_PrimitiveImage.get = async id => id === fields.primitiveId ? makeImage() : undefined;
	modifyFailure = true;
	await assert.rejects(() => command('pcb.modifyImage').handler({ primitiveId: 'image-1', x: 22 }, makeContext()), (error) => {
		assert.match(error.message, /已调用宿主写入/);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		return true;
	});
	assert.equal(modifyCalls, 3, 'SDK modify rejection is reported as partial and non-retryable');
	modifyFailure = false;

	globalThis.eda.pcb_PrimitiveImage.get = async id => id === fields.primitiveId ? makeImage() : undefined;
	const outerOnlySameBounds = [source[0]];
	createdSourcePathOverride = outerOnlySameBounds;
	globalThis.eda.pcb_MathPolygon.convertImageToComplexPolygon = async () => ({ getSourceStrictComplex: () => source });
	const beforeDeleteContourCreateCalls = createCalls;
	await assert.rejects(() => place.handler(params, makeContext()), (error) => {
		assert.match(error.message, /已调用宿主写入/);
		assert.match(error.message, /源记录中的描摹轮廓/);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		return true;
	});
	assert.equal(createCalls, beforeDeleteContourCreateCalls + 1, 'a missing inner contour with unchanged bbox is detected after one write');
	createdSourcePathOverride = undefined;
	for (const failure of ['throw', 'undefined']) {
		createFailure = failure;
		await assert.rejects(() => place.handler(params, makeContext()), (error) => {
			assert.match(error.message, /已调用宿主写入/);
			assert.equal(error.cause?.partial, true);
			assert.equal(error.cause?.retryable, false);
			return true;
		});
	}
	createFailure = undefined;

	console.log('PCB placement image regression passed: source path verification, rotation invariance, contour loss, layer validation, SDK write rejection, list/modify/invalid/target/partial.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
