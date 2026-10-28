import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import JSZip from 'jszip';

const ROOT = resolve(import.meta.dirname, '..');
const bundle = 'test/.component-placement-regression-bundle.mjs';
const projectUuid = 'project-footprint-1';
const libraryFootprintUuid = 'library-footprint-1';
const libraryUuid = 'library-1';

function footprintSource(options = {}) {
	const rows = [
		['DOCTYPE', 'FOOTPRINT', '1.8'],
		['HEAD', { uuid: options.projectUuid ?? projectUuid, source: options.source ?? `${libraryFootprintUuid}|${libraryUuid}` }],
		...((options.pads ?? [['pad-1', '1'], ['pad-2', '2']]).map(([id, number]) => ['PAD', id, 0, '', 1, number, 0, 0, 0])),
	];
	return rows.map(row => JSON.stringify(row)).join('\n');
}

function fixture(options = {}) {
	let focus = options.initialFocus ?? { documentType: 1, uuid: 'page-1', parentProjectUuid: 'project-1' };
	let createCalls = 0;
	let resourceCalls = 0;
	let projectExportCalls = 0;
	let projectLibraryUuidCalls = 0;
	let writeCalls = 0;
	const lookupCalls = [];
	let deviceGetCalls = 0;
	let instanceFootprintUuid = options.instanceFootprint === undefined ? projectUuid : options.instanceFootprint?.uuid ?? null;
	const created = {
		getState_PrimitiveId: () => 'component-1',
		getState_Designator: () => 'TP1',
	};
	const back = {
		getState_Footprint: () => instanceFootprintUuid ? { uuid: instanceFootprintUuid, libraryUuid: options.instanceFootprint?.libraryUuid ?? 'project-library-1' } : null,
	};
	const device = options.device ?? {
		uuid: 'device-1',
		libraryUuid,
		association: { footprintUuid: libraryFootprintUuid, footprint: { uuid: libraryFootprintUuid, libraryUuid } },
	};
	let currentDevice = device;
	const api = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => options.initialFocusError ? Promise.reject(new Error('focus unavailable')) : focus },
		lib_LibrariesList: { getProjectLibraryUuid: async () => {
			projectLibraryUuidCalls++;
			if (options.projectLibraryUuidError)
				throw new Error('project library UUID unavailable');
			return options.projectLibraryUuid ?? 'project-library-1';
		} },
		lib_Device: {
			getByLcscIds: async (...args) => {
				lookupCalls.push(args);
				const item = options.lookupSequence?.[lookupCalls.length - 1] ?? options.lookupResult ?? { uuid: 'device-1', libraryUuid };
				return item ? [item] : [];
			},
			get: async (uuid, selectedLibraryUuid) => {
				deviceGetCalls++;
				currentDevice = options.devicesByIdentity?.[`${selectedLibraryUuid}:${uuid}`] ?? device;
				if (options.deviceSequence?.length)
					currentDevice = options.deviceSequence[Math.min(deviceGetCalls - 1, options.deviceSequence.length - 1)];
				if (options.deviceSequence?.length) {
					const fp = currentDevice?.association?.footprint?.uuid ?? currentDevice?.association?.footprintUuid;
					instanceFootprintUuid = fp ? (currentDevice.projectFootprintUuid ?? projectUuid) : null;
				}
				return currentDevice;
			},
		},
		sys_FileManager: {
			getDocumentFootprintSources: async () => {
				resourceCalls++;
				if (options.changeFocusAfterResources)
					focus = { ...focus, uuid: 'page-2' };
				return options.sources ?? [{ footprintUuid: projectUuid, documentSource: footprintSource(options.footprintOptions) }];
			},
			getProjectFile: async () => {
				projectExportCalls++;
				if (options.projectExportError)
					throw new Error('project export failed');
				if (options.projectFileMissing)
					return undefined;
				if (options.changeFocusDuringExport)
					focus = { ...focus, uuid: 'page-2' };
				const entryUuid = instanceFootprintUuid ?? projectUuid;
				const zip = new JSZip();
				if (!options.projectEntryMissing)
					zip.file(`FOOTPRINT/${entryUuid}.efoo`, options.projectSource ?? footprintSource({
						...options.footprintOptions,
						...(options.deviceSequence?.length && currentDevice?.association?.footprint
							? { source: `${currentDevice.association.footprint.uuid}|${currentDevice.association.footprint.libraryUuid}` }
							: {}),
					}));
				const data = options.projectBadZip ? new Uint8Array([1, 2, 3, 4]) : await zip.generateAsync({ type: 'uint8array' });
				if (options.changeInstanceAfterExport)
					instanceFootprintUuid = 'changed-footprint';
				return { arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
			},
			setDocumentSource: async () => {
				writeCalls++;
				return true;
			},
			exportProject: async () => {
				writeCalls++;
				return true;
			},
		},
		sch_PrimitiveComponent: {
			create: async (...args) => {
				createCalls++;
				if (options.changeFocusAfterCreate)
					focus = { ...focus, uuid: 'page-2' };
				if (options.createError)
					throw new Error('create failed');
				if (options.emptyCreate)
					return null;
				api.createArgs = args;
				return created;
			},
			get: async () => options.readbackError ? Promise.reject(new Error('readback unavailable')) : options.missingReadback ? undefined : back,
			getAllPinsByPrimitiveId: async () => options.pins ?? [
				{ getState_PinNumber: () => '1', getState_PrimitiveId: () => 'pin-1' },
				{ getState_PinNumber: () => '2', getState_PrimitiveId: () => 'pin-2' },
			],
			modify: async () => {
				writeCalls++;
				return true;
			},
		},
		sch_Document: {
			save: async () => {
				writeCalls++;
				return true;
			},
		},
		pcb_Document: {
			save: async () => {
				writeCalls++;
				return true;
			},
		},
	};
	return {
		api,
		focusChange: (value) => { focus = value; },
		get createCalls() { return createCalls; },
		get resourceCalls() { return resourceCalls; },
		get projectExportCalls() { return projectExportCalls; },
		lookupCalls,
	get projectLibraryUuidCalls() { return projectLibraryUuidCalls; },
		get writeCalls() { return writeCalls; },
	};
}

function assertPartial(error, label) {
	assert.equal(error.partial, true, `${label}: error.partial`);
	assert.equal(error.retryable, false, `${label}: error.retryable`);
	assert.equal(error.cause?.partial, true, `${label}: cause.partial`);
	assert.equal(error.cause?.retryable, false, `${label}: cause.retryable`);
}

async function main() {
	try {
		await build({
			stdin: {
				contents: `import { placeDeviceSafely } from '../src/engine/componentPlacement.ts'; import { schematicCommands } from '../src/commands/schematic.ts'; export { placeDeviceSafely, schematicCommands }`,
				resolveDir: resolve(ROOT, 'test'),
				sourcefile: '.component-placement-regression-entry.ts',
			},
			outfile: bundle,
			bundle: true,
			format: 'esm',
			platform: 'node',
			target: 'node24',
		});
		const mod = await import(pathToFileURL(resolve(ROOT, bundle)).href);
		const command = mod.schematicCommands.find(item => item.name === 'schematic.placeDevice');
		assert.ok(command, 'schematic.placeDevice command exists');
		for (const name of ['subPartName', 'addIntoBom', 'addIntoPcb'])
			assert.ok(command.params.some(param => param.name === name), `${name} appears in command metadata`);
		const inspectCommand = mod.schematicCommands.find(item => item.name === 'schematic.getPlacementResourcesDiagnostic');
		assert.ok(inspectCommand, 'read-only placement resource diagnostic command exists');
		assert.deepEqual(inspectCommand.params, [{ name: 'primitiveId', type: 'string', required: true, description: '待检查的原理图器件实例 primitiveId' }]);

		for (const [label, opts, expectedUuid] of [
			['bare resource id', { sources: [{ footprintUuid: 'f7546383e37c5c50', documentSource: footprintSource({ projectUuid: 'f7546383e37c5c50' }) }] }, 'f7546383e37c5c50'],
			['FOOTPRINT-prefixed resource id', { sources: [{ footprintUuid: 'FOOTPRINT_f7546383e37c5c50', documentSource: footprintSource({ projectUuid: 'f7546383e37c5c50' }) }] }, 'FOOTPRINT_f7546383e37c5c50'],
			['empty resource list', { sources: [] }, null],
			['damaged HEAD record', { sources: [{ footprintUuid: 'FOOTPRINT_bad', documentSource: '["DOCTYPE","FOOTPRINT","1.8"]\n["HEAD",{"source":"library|lib"}]' }] }, 'FOOTPRINT_bad'],
			['focus changes during resource read', { changeFocusAfterResources: true }, projectUuid],
		]) {
			const f = fixture(opts);
			globalThis.eda = f.api;
			const result = await inspectCommand.handler({ primitiveId: 'component-1' });
			assert.equal(result.diagnosticOnly, true, `${label}: diagnostic-only result`);
			assert.equal(result.placementVerified, false, `${label}: does not claim placement verified`);
			assert.equal(result.documentUuid, 'page-1', `${label}: page UUID is returned`);
			assert.equal(result.projectUuid, 'project-1', `${label}: project UUID is returned`);
			assert.deepEqual(result.typedFootprint, { uuid: projectUuid, libraryUuid: 'project-library-1' }, `${label}: complete SDK footprint reference is returned`);
			assert.equal(result.projectLibraryUuid, 'project-library-1', `${label}: project library UUID is returned`);
			assert.equal(result.resources[0]?.rawFootprintUuid ?? null, expectedUuid, `${label}: returns raw resource ID`);
			assert.equal(f.resourceCalls, 1, `${label}: calls getDocumentFootprintSources once`);
			assert.equal(f.createCalls, 0, `${label}: create is never called`);
			assert.equal(f.writeCalls, 0, `${label}: no modify/save/export writes`);
			assert.equal(f.projectExportCalls, label === 'focus changes during resource read' ? 0 : 1, `${label}: project epro read count matches focus guard`);
			assert.equal(f.projectLibraryUuidCalls, 1, `${label}: project library UUID is read once for a valid schematic focus`);
			if (label === 'empty resource list') {
				assert.equal(result.resourceCount, 0);
				assert.equal(result.resourceListState, 'empty-returned', 'empty API result is distinguished from a missing project identity');
				assert.equal(result.complete, true, 'empty array is a complete read-only result');
				assert.equal(result.projectResource.path, `FOOTPRINT/${projectUuid}.efoo`, 'empty current-document list is separate from project export resource');
			}
			if (label === 'damaged HEAD record') {
				assert.match(result.resources[0].parseError, /HEAD\/DOCHEAD\.uuid/);
				assert.equal(result.complete, false, 'malformed HEAD marks diagnostic incomplete');
			}
			if (label === 'focus changes during resource read') {
				assert.equal(result.focusUnchanged, false);
				assert.equal(result.complete, false);
			}
		}

		{
			const f = fixture({ projectLibraryUuidError: true });
			globalThis.eda = f.api;
			const result = await inspectCommand.handler({ primitiveId: 'component-1' });
			assert.equal(result.projectLibraryUuid, null);
			assert.equal(result.projectLibraryUuidError, 'project library UUID unavailable');
			assert.equal(result.complete, false, 'project library UUID retrieval failure marks the diagnostic incomplete');
			assert.equal(result.typedFootprint.libraryUuid, 'project-library-1', 'the SDK typed footprint reference remains available on library UUID failure');
			assert.equal(f.writeCalls, 0);
		}

		{
			const f = fixture({ instanceFootprint: null });
			globalThis.eda = f.api;
			const result = await inspectCommand.handler({ primitiveId: 'component-1' });
			assert.equal(result.instanceFootprintUuid, null, 'missing instance footprint is reported');
			assert.equal(result.typedFootprint, null, 'missing instance footprint has no typed SDK reference');
			assert.deepEqual(result.projectResource, { state: 'no-instance-footprint' });
			assert.equal(result.focusUnchanged, true);
			assert.equal(result.complete, true, 'valid focus with no footprint is a complete diagnostic');
			assert.equal(f.resourceCalls, 1, 'no-footprint diagnostic still reads current-document resources');
			assert.equal(f.projectExportCalls, 0, 'no-footprint diagnostic skips project export');
			assert.equal(f.writeCalls, 0, 'no-footprint diagnostic performs no writes');
		}

		for (const [label, initialFocus, expectedPageUuid, expectedProjectUuid] of [
			['blank page UUID', { documentType: 1, uuid: '   ', parentProjectUuid: 'project-1' }, '   ', 'project-1'],
			['blank project UUID', { documentType: 1, uuid: 'page-1', parentProjectUuid: '   ' }, 'page-1', '   '],
		]) {
			const f = fixture({ initialFocus });
			globalThis.eda = f.api;
			const result = await inspectCommand.handler({ primitiveId: 'component-1' });
			assert.equal(result.documentUuid, expectedPageUuid, `${label}: raw page UUID is preserved`);
			assert.equal(result.projectUuid, expectedProjectUuid, `${label}: raw project UUID is preserved`);
			assert.equal(result.focusUnchanged, false, `${label}: invalid start identity cannot count as unchanged`);
			assert.equal(result.complete, false, `${label}: invalid start identity makes diagnostic incomplete`);
			assert.equal(result.resourceListState, 'not-read-invalid-focus', `${label}: resources are not reported as an empty result`);
			assert.equal(result.resourceCount, null, `${label}: no resource count is claimed`);
			assert.equal(f.resourceCalls, 0, `${label}: current-document resources are not read`);
			assert.equal(f.projectExportCalls, 0, `${label}: project epro is not exported`);
			assert.equal(f.writeCalls, 0, `${label}: diagnostic performs no writes`);
		}

		{
			const f = fixture({ footprintOptions: { pads: [['pad-a', '1'], ['pad-b', '1'], ['pad-c', '2']] } });
			const result = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 10, y: 20, addIntoBom: false, addIntoPcb: true });
			assert.equal(f.createCalls, 1, 'one create call');
			assert.deepEqual(f.api.createArgs, [{ libraryUuid, uuid: 'device-1' }, 10, 20, undefined, undefined, undefined, false, true], 'create reference and BOM/PCB arguments are preserved');
			assert.equal(result.primitiveId, 'component-1');
			assert.equal(result.designator, 'TP1');
			assert.deepEqual(result.device, {
				requestedLcscId: 'C123', requestedLibraryUuid: null,
				selectedDeviceUuid: 'device-1', selectedLibraryUuid: libraryUuid,
			}, 'reports requested and selected device identity');
			assert.equal(result.placementVerified, true, 'instance placement and readback are explicitly verified');
			assert.equal(result.footprintVerified, true, 'library footprint and source are independently verified');
			assert.equal(result.footprintStatus, 'verified');
			assert.equal(result.pcbReady, true, 'verified footprint and pin-to-pad map are scoped as PCB readiness');
			assert.equal(result.pcbReadyScope, 'footprint-and-instance-pin-pad-map-only');
			assert.equal(f.lookupCalls[0].length, 1, 'unspecified library preserves the original one-argument SDK call');
			assert.deepEqual(f.lookupCalls[0][0], ['C123']);
			assert.deepEqual(result.readback.pinPadMap, { 1: ['pad-a', 'pad-b'], 2: ['pad-c'] }, 'pin numbers map to all matching footprint PAD ids');
			assert.equal(result.readback.pinMapScope, 'placed-instance-only');
			assert.equal(result.readback.footprint.projectUuid, projectUuid, 'project resource UUID stays distinct from library footprint UUID');
			assert.equal(result.readback.footprint.resourceSource, `${libraryFootprintUuid}|${libraryUuid}`);
			assert.equal(result.readback.footprint.resourceOrigin, 'project-export-epro');
			assert.equal(result.readback.footprint.resourcePath, `FOOTPRINT/${projectUuid}.efoo`);
			assert.equal(f.projectExportCalls, 1, 'placement reads one project epro');
			assert.equal(result.readback.persistenceVerified, false, 'no persistence claim');
		}

		{
			const f = fixture({ sources: [
				{ footprintUuid: 'unrelated-footprint', documentSource: 'unrelated damaged footprint data' },
				{ footprintUuid: projectUuid, documentSource: footprintSource() },
			] });
			const result = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 });
			assert.equal(result.readback.footprint.resourceVerified, true, 'unrelated damaged resource does not block a valid target');
		}

		{
			const f = fixture({ device: { uuid: 'device-1', libraryUuid, association: { footprintUuid: libraryFootprintUuid } } });
			const result = await mod.placeDeviceSafely(f.api, { deviceUuid: 'device-1', libraryUuid, x: 1, y: 2 });
			assert.equal(result.device.requestedLibraryUuid, libraryUuid, 'explicit device lookup records requested library identity');
			assert.equal(result.device.selectedDeviceUuid, 'device-1');
			assert.equal(result.device.selectedLibraryUuid, libraryUuid);
			assert.equal(result.readback.footprint.resourceVerified, true, 'flat footprintUuid uses the full device libraryUuid');
		}

		{
			const f = fixture({ device: { uuid: 'device-1', libraryUuid, association: { footprintUuid: libraryFootprintUuid, footprint: { uuid: 'different-footprint', libraryUuid } } } });
			await assert.rejects(mod.placeDeviceSafely(f.api, { deviceUuid: 'device-1', libraryUuid, x: 1, y: 2 }), (error) => {
				assert.equal(error.partial, false, 'library association conflict is rejected before write');
				assert.equal(error.cause?.partial, false);
				return true;
			});
			assert.equal(f.createCalls, 0, 'conflicting library associations cause zero writes');
		}

		for (const [label, opts] of [
			['missing resource', { projectEntryMissing: true }],
			['library UUID incorrectly used as project UUID', { sources: [], instanceFootprint: { uuid: libraryFootprintUuid } }],
			['source mismatch', { footprintOptions: { source: 'another-footprint|another-library' } }],
			['pin number has no PAD match', { pins: [{ getState_PinNumber: () => '3', getState_PrimitiveId: () => 'pin-3' }] }],
			['pin numbering whitespace remains significant', { pins: [{ getState_PinNumber: () => '1 ', getState_PrimitiveId: () => 'pin-1' }] }],
			['malformed project efoo', { projectSource: 'not json' }],
		]) {
			const f = fixture(opts);
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assertPartial(error, label);
				return true;
			});
		}

		for (const [label, opts] of [
			['empty project export', { projectFileMissing: true }],
			['project export throws', { projectExportError: true }],
			['bad project ZIP', { projectBadZip: true }],
			['project efoo missing', { projectEntryMissing: true }],
			['focus changes during export', { changeFocusDuringExport: true }],
			['instance footprint changes after export', { changeInstanceAfterExport: true }],
		]) {
			const f = fixture(opts);
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assertPartial(error, label);
				return true;
			});
		}

		for (const [label, device] of [
			['missing library device uuid', { libraryUuid, association: {} }],
			['missing library device libraryUuid', { uuid: 'device-1', association: {} }],
			['mismatched library device uuid', { uuid: 'different-device', libraryUuid, association: {} }],
		]) {
			const f = fixture({ device });
			await assert.rejects(mod.placeDeviceSafely(f.api, { deviceUuid: 'device-1', libraryUuid, x: 1, y: 2 }), (error) => {
				assert.equal(error.partial, false, `${label} rejected before create`);
				return true;
			});
			assert.equal(f.createCalls, 0, `${label} causes zero writes`);
		}

		for (const [label, opts] of [
			['create returns empty', { emptyCreate: true }],
			['create throws', { createError: true }],
			['instance readback returns empty', { missingReadback: true }],
			['instance readback throws', { readbackError: true }],
		]) {
			const f = fixture(opts);
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assertPartial(error, label);
				return true;
			});
		}

		{
			const f = fixture({ device: { uuid: 'device-1', libraryUuid, association: {} }, instanceFootprint: null, sources: [] });
			const result = await mod.placeDeviceSafely(f.api, { deviceUuid: 'device-1', libraryUuid, x: 1, y: 2 });
			assert.equal(result.readback.footprint.libraryFootprint, 'none', 'library device without footprint remains placeable');
			assert.equal(result.readback.footprint.resourceVerified, false, 'no footprint resource is not claimed as verified');
			assert.equal(result.placementVerified, true, 'placing a symbol without a footprint is still a verified placement');
			assert.equal(result.footprintVerified, false);
			assert.equal(result.footprintStatus, 'missing');
			assert.equal(result.pcbReady, false, 'missing footprint cannot be reported PCB ready');
			assert.match(result.warnings[0], /明确选择带封装的库器件/);
		}

		{
			const deviceWithoutFootprint = { uuid: 'device-no-fp', libraryUuid: 'library-no-fp', association: {} };
			const deviceWithFootprint = {
				uuid: 'device-with-fp', libraryUuid: 'library-with-fp',
				association: { footprintUuid: 'footprint-with-fp', footprint: { uuid: 'footprint-with-fp', libraryUuid: 'library-with-fp' } },
			};
			const f = fixture({
				lookupSequence: [
					{ uuid: deviceWithoutFootprint.uuid, libraryUuid: deviceWithoutFootprint.libraryUuid },
					{ uuid: deviceWithFootprint.uuid, libraryUuid: deviceWithFootprint.libraryUuid },
				],
				deviceSequence: [deviceWithoutFootprint, deviceWithFootprint],
			});
			const without = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 });
			const withFootprint = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 3, y: 4 });
			assert.equal(without.device.selectedDeviceUuid, deviceWithoutFootprint.uuid, 'first same-C result identity is explicit');
			assert.equal(without.footprintStatus, 'missing', 'first same-C result remains a placeable symbol with no footprint');
			assert.equal(without.footprintVerified, false);
			assert.equal(without.pcbReady, false);
			assert.equal(withFootprint.device.selectedDeviceUuid, deviceWithFootprint.uuid, 'second same-C result uses its own selected device identity');
			assert.equal(withFootprint.footprintStatus, 'verified', 'second same-C result independently verifies its footprint');
			assert.equal(withFootprint.footprintVerified, true);
			assert.equal(withFootprint.pcbReady, true, 'later footprint-bearing selection is not tainted by the earlier result');
		}

		{
			const f = fixture({
				lookupResult: { uuid: 'device-explicit', libraryUuid: 'library-explicit' },
				device: {
					uuid: 'device-explicit', libraryUuid: 'library-explicit',
					association: { footprintUuid: libraryFootprintUuid, footprint: { uuid: libraryFootprintUuid, libraryUuid: 'library-explicit' } },
				},
				footprintOptions: { source: `${libraryFootprintUuid}|library-explicit` },
			});
			const result = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', libraryUuid: 'library-explicit', x: 1, y: 2 });
			assert.equal(f.lookupCalls[0].length, 2, 'explicit library uses the two-argument SDK overload');
			assert.deepEqual(f.lookupCalls[0], [['C123'], 'library-explicit'], 'explicit library is forwarded to the SDK lookup');
			assert.equal(result.device.requestedLibraryUuid, 'library-explicit');
			assert.equal(result.device.selectedLibraryUuid, 'library-explicit');
		}

		{
			const f = fixture({ lookupResult: { uuid: 'device-wrong-library', libraryUuid: 'library-other' } });
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', libraryUuid: 'library-requested', x: 1, y: 2 }), error => {
				assert.equal(error.partial, false, 'wrong-library lookup is rejected before placement');
				assert.match(error.message, /非请求库的结果/);
				return true;
			});
			assert.equal(f.createCalls, 0, 'wrong library causes zero create calls');
		}

		{
			const f = fixture({ footprintOptions: { pads: [['mechanical-pad', '']] }, pins: [] });
			const result = await mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 });
			assert.equal(result.readback.electricalMapping, 'none', 'no pins and no numbered PAD is explicit no electrical mapping');
			assert.equal(result.readback.pinPadMapVerified, false, 'empty arrays do not claim mapping verified');
			assert.deepEqual(result.readback.footprint.nonElectricalPadPrimitiveIds, ['mechanical-pad']);
		}

		{
			const f = fixture({ footprintOptions: { pads: [['pad-1', '1']] }, pins: [] });
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assertPartial(error, 'numbered PAD with empty pin set');
				return true;
			});
		}

		{
			const f = fixture({ changeFocusAfterCreate: true });
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assertPartial(error, 'focus changes after create');
				assert.equal(error.cause.primitiveId, 'component-1');
				return true;
			});
		}

		{
			const f = fixture();
			const originalGet = f.api.lib_Device.get;
			f.api.lib_Device.get = async (...args) => {
				const device = await originalGet(...args);
				f.focusChange({ documentType: 1, uuid: 'page-2', parentProjectUuid: 'project-1' });
				return device;
			};
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assert.equal(error.partial, false, 'focus change before create is non-partial');
				assert.equal(error.cause?.partial, false);
				return true;
			});
			assert.equal(f.createCalls, 0, 'focus change before create causes zero writes');
		}

		{
			const f = fixture({ initialFocusError: true });
			await assert.rejects(mod.placeDeviceSafely(f.api, { lcscId: 'C123', x: 1, y: 2 }), (error) => {
				assert.equal(error.partial, false, 'initial focus failure is pre-write');
				assert.equal(error.cause?.partial, false);
				return true;
			});
			assert.equal(f.createCalls, 0, 'initial focus failure causes zero writes');
		}

		console.log('component-placement-regression: passed');
	}
	finally {
		await rm(resolve(ROOT, bundle), { force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
