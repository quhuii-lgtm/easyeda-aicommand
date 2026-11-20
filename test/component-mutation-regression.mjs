import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const bundle = 'test/.component-mutation-regression-bundle.mjs';
async function main() {
	try {
		await build({
			stdin: {
				contents: `
import { modifyComponentSafely, moveComponentSafely } from '../src/engine/componentMutation.ts'
import { schematicCommands } from '../src/commands/schematic.ts'
import { registerCommand, executeCommand } from '../src/engine/registry.ts'
export { modifyComponentSafely, moveComponentSafely, schematicCommands, registerCommand, executeCommand }
`,
				resolveDir: resolve(ROOT, 'test'),
				sourcefile: '.component-mutation-regression-entry.ts',
			},
			outfile: bundle,
			bundle: true,
			format: 'esm',
			platform: 'node',
			target: 'node24',
		});
		const mod = await import(pathToFileURL(resolve(bundle)).href);
		const fields = {
			x: 100,
			y: 200,
			rotation: 0,
			mirror: false,
			addIntoBom: true,
			addIntoPcb: true,
			designator: 'R1',
			name: 'Resistor',
			uniqueId: 'uid-1',
			manufacturer: null,
			manufacturerId: null,
			supplier: null,
			supplierId: null,
			otherProperty: { Resistance: '10k', Tolerance: 1 },
		};
		const aliasedFields = {
			...fields,
			addIntoBom: false,
			addIntoPcb: true,
			designator: 'TP1',
			name: 'Test Point',
			uniqueId: 'uid-tp1',
			manufacturer: 'Maker',
			manufacturerId: 'MPN-1',
			supplier: 'Supplier',
			supplierId: 'SPN-1',
			otherProperty: {
				'Resistance': '10k',
				'Tolerance': 1,
				'Add into BOM': 'no',
				'Convert to PCB': 'yes',
				'Designator': 'TP1',
				'Name': 'Test Point',
				'Unique ID': 'uid-tp1',
				'Manufacturer': 'Maker',
				'Manufacturer Part': 'MPN-1',
				'Supplier': 'Supplier',
				'Supplier Part': 'SPN-1',
			},
		};
		const preserved = {
			primitiveType: 'Component',
			componentType: 'part',
			component: { libraryUuid: 'lib', uuid: 'device' },
			symbol: { libraryUuid: 'lib', uuid: 'symbol' },
			footprint: { libraryUuid: 'lib', uuid: 'footprint' },
			subPartName: undefined,
			addIntoBom: true,
			addIntoPcb: true,
			net: undefined,
			designator: 'R1',
			name: 'Resistor',
			uniqueId: 'uid-1',
			manufacturer: undefined,
			manufacturerId: undefined,
			supplier: undefined,
			supplierId: undefined,
			otherProperty: { Resistance: '10k', Tolerance: 1 },
		};
		const getterNames = {
			primitiveType: 'PrimitiveType',
			componentType: 'ComponentType',
			component: 'Component',
			symbol: 'Symbol',
			footprint: 'Footprint',
			subPartName: 'SubPartName',
			addIntoBom: 'AddIntoBom',
			addIntoPcb: 'AddIntoPcb',
			net: 'Net',
			designator: 'Designator',
			name: 'Name',
			uniqueId: 'UniqueId',
			manufacturer: 'Manufacturer',
			manufacturerId: 'ManufacturerId',
			supplier: 'Supplier',
			supplierId: 'SupplierId',
			otherProperty: 'OtherProperty',
		};
		function fixture(options = {}) {
			const state = { ...fields, ...structuredClone(preserved), ...structuredClone(options.state ?? {}) };
			let focus = { documentType: 1, uuid: 'page-a', parentProjectUuid: 'project-a' };
			let getCount = 0;
			const stats = { modifies: 0, dones: 0, wireGets: 0, deletes: 0, sentinel: 0, setters: [], modifiedProperty: undefined };
			const component = {
				getState_PrimitiveId: () => 'component-1',
				getState_X: () => state.x,
				getState_Y: () => state.y,
				getState_Rotation: () => state.rotation,
				getState_Mirror: () => state.mirror,
				toAsync() {
					const draft = { ...state };
					for (const [field, name] of Object.entries({ x: 'X', y: 'Y', rotation: 'Rotation', mirror: 'Mirror' })) {
						draft[`setState_${name}`] = (value) => {
							draft[field] = value;
							stats.setters.push(field);
							return draft;
						};
					}
					draft.done = async () => {
						stats.dones++;
						for (const field of ['x', 'y', 'rotation', 'mirror']) {
							if (draft[field] !== undefined)
								state[field] = draft[field];
						}
						if (options.moveMutation)
							options.moveMutation(state);
						if (options.changeFocusAfterMove)
							focus = { ...focus, uuid: 'page-b' };
						return component;
					};
					return draft;
				},
			};
			for (const [key, suffix] of Object.entries(getterNames)) component[`getState_${suffix}`] = () => state[key];
			const api = {
				dmt_SelectControl: { getCurrentDocumentInfo: async () => focus },
				sch_PrimitiveComponent: {
					get: async () => {
						getCount++;
						if (options.missingReadback && getCount > 1)
							return undefined;
						return component;
					},
					modify: async (_id, property) => {
						stats.modifies++;
						stats.modifiedProperty = structuredClone(property);
						Object.assign(state, property);
						if (options.modifyMutation)
							options.modifyMutation(state, property);
						if (options.changeFocusAfterModify)
							focus = { ...focus, uuid: 'page-b' };
						return component;
					},
					getAll: async () => [component],
					getAllPinsByPrimitiveId: async () => [{ getState_PinNumber: () => '1', getState_X: () => state.x, getState_Y: () => state.y }],
				},
				sch_ManufactureData: { getNetlistFile: async () => new Blob([JSON.stringify({ components: { gge1: { props: { Designator: 'C1' }, pinInfoMap: { 1: { net: 'SIG' } } } } })]) },
				sch_PrimitiveWire: {
					getAll: async () => {
						stats.wireGets++;
						return [];
					},
					delete: async () => {
						stats.deletes++;
						return true;
					},
				},
				sch_Netlist: { getNetlist: async () => '' },
				sch_PrimitiveAttribute: {
					getAll: async () => [],
					getAllPrimitiveId: async () => [],
					get: async ids => Array.isArray(ids) ? [] : undefined,
				},
				sys_Storage: { getExtensionUserConfig: () => undefined, setExtensionUserConfig: async () => true },
			};
			return {
				api,
				state,
				stats,
				setFocus: (value) => {
					focus = value;
				},
			};
		}
		async function rejectsPartial(action, label) {
			let error;
			try {
				await action();
			}
			catch (caught) { error = caught; }
			assert.ok(error, `${label}: expected rejection`);
			assert.equal(error.cause?.partial, true, `${label}: partial cause preserved`);
			assert.equal(error.cause?.retryable, false, `${label}: non-retryable cause preserved`);
		}

		const fieldNames = mod.schematicCommands.find(command => command.name === 'schematic.modifyComponent').params;
		assert.ok(fieldNames.length === 2, 'schematic.modifyComponent is registered in source commands');
		for (const field of Object.keys(fields)) {
			const f = fixture();
			const partial = { ...fields };
			delete partial[field];
			await assert.rejects(mod.modifyComponentSafely(f.api, 'component-1', partial), new RegExp(field));
			assert.equal(f.stats.modifies, 0, `missing ${field} never calls modify`);
		}
		for (const invalid of [
			{ ...fields, x: Number.NaN },
			{ ...fields, mirror: 'false' },
			{ ...fields, addIntoBom: 1 },
			{ ...fields, designator: 4 },
			{ ...fields, otherProperty: [] },
			{ ...fields, otherProperty: { Resistance: Number.POSITIVE_INFINITY } },
			{ ...fields, unexpected: true },
		]) {
			const f = fixture();
			await assert.rejects(mod.modifyComponentSafely(f.api, 'component-1', invalid));
			assert.equal(f.stats.modifies, 0, 'invalid value never calls modify');
		}
		{
			const f = fixture();
			await assert.rejects(mod.modifyComponentSafely(f.api, 'component-1', { ...fields, otherProperty: { Resistance: '10k' } }), /Tolerance/);
			assert.equal(f.stats.modifies, 0, 'omitting an existing otherProperty key never calls modify');
		}
		{
			const f = fixture();
			const result = await mod.modifyComponentSafely(f.api, 'component-1', { ...fields, otherProperty: { Tolerance: 1, Resistance: '10k', Note: true } });
			assert.equal(f.stats.modifies, 1, 'complete modify invokes official modify exactly once');
			assert.equal(result.readback.verified, true, 'complete modify verifies all fields and added property');
		}
		{
			const submitted = structuredClone(aliasedFields);
			const f = fixture({ modifyMutation: (state) => {
				for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
					delete state.otherProperty[key];
			} });
			const result = await mod.modifyComponentSafely(f.api, 'component-1', aliasedFields);
			assert.equal(f.stats.modifies, 1, 'all nine system property aliases allow one modify');
			assert.equal(result.readback.verified, true, 'system property aliases are verified through projected getters');
			assert.equal(result.readback.otherProperty.Designator, undefined, 'readback does not invent projected aliases in otherProperty');
			assert.deepEqual(f.stats.modifiedProperty.otherProperty, aliasedFields.otherProperty, 'consistent aliases are submitted unchanged to the SDK');
			assert.deepEqual(aliasedFields, submitted, 'alias validation leaves caller-owned input unchanged');
		}
		{
			const customProperties = { constructor: 'custom-constructor', toString: 'custom-toString', hasOwnProperty: 'custom-hasOwnProperty' };
			const f = fixture({ modifyMutation: (state) => {
				for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
					delete state.otherProperty[key];
			} });
			const result = await mod.modifyComponentSafely(f.api, 'component-1', {
				...aliasedFields,
				otherProperty: { ...aliasedFields.otherProperty, ...customProperties },
			});
			assert.equal(result.readback.verified, true, 'prototype-named custom properties use ordinary strict custom-property validation');
			for (const [key, value] of Object.entries(customProperties))
				assert.equal(result.readback.otherProperty[key], value, `${key} custom property is preserved`);
		}
		for (const [key, conflictingValue] of [
			['Add into BOM', 'yes'],
			['Convert to PCB', 'no'],
			['Name', 'Other Name'],
			['Designator', 'C7'],
		]) {
			const f = fixture();
			await assert.rejects(mod.modifyComponentSafely(f.api, 'component-1', {
				...aliasedFields,
				otherProperty: { ...aliasedFields.otherProperty, [key]: conflictingValue },
			}), /冲突/);
			assert.equal(f.stats.modifies, 0, `${key} conflict is rejected before modify`);
		}
		for (const invalidBooleanAlias of ['', 'YES', 'true', true]) {
			const f = fixture();
			await assert.rejects(mod.modifyComponentSafely(f.api, 'component-1', {
				...aliasedFields,
				otherProperty: { ...aliasedFields.otherProperty, 'Add into BOM': invalidBooleanAlias },
			}), /yes.*no/);
			assert.equal(f.stats.modifies, 0, 'invalid yes/no system alias is rejected before modify');
		}
		for (const [aliasKey, field] of [
			['Designator', 'designator'],
			['Name', 'name'],
			['Unique ID', 'uniqueId'],
			['Manufacturer', 'manufacturer'],
			['Manufacturer Part', 'manufacturerId'],
			['Supplier', 'supplier'],
			['Supplier Part', 'supplierId'],
		]) {
			for (const actualValue of [null, undefined, '']) {
				const emptyAlias = { ...aliasedFields, [field]: null, otherProperty: { ...aliasedFields.otherProperty, [aliasKey]: '' } };
				const f = fixture({ modifyMutation: (state) => {
					state[field] = actualValue;
					for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
						delete state.otherProperty[key];
				} });
				const result = await mod.modifyComponentSafely(f.api, 'component-1', emptyAlias);
				assert.equal(result.readback.verified, true, `${aliasKey} null and empty alias accepts ${String(actualValue)} readback under the established null contract`);
				assert.equal(f.stats.modifiedProperty.otherProperty[aliasKey], '', `${aliasKey} empty alias is passed unchanged to the SDK`);
			}
		}
		{
			const f = fixture({ modifyMutation: (state) => {
				state.name = '';
				for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
					delete state.otherProperty[key];
			} });
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', aliasedFields), 'non-null top field does not accept empty string readback');
			assert.equal(f.stats.modifies, 1, 'non-null string readback mismatch does not retry');
		}
		for (const option of [
			{ modifyMutation: (state) => { state.designator = 'C1'; } },
			{ modifyMutation: (state) => { state.addIntoBom = undefined; } },
		]) {
			const f = fixture({ ...option, modifyMutation: (state, property) => {
				for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
					delete state.otherProperty[key];
				option.modifyMutation(state, property);
			} });
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', aliasedFields), 'system alias getter mismatch or missing value');
		}
		{
			const f = fixture({ modifyMutation: (state) => {
				for (const key of Object.keys(aliasedFields.otherProperty).filter(key => key !== 'Resistance' && key !== 'Tolerance'))
					delete state.otherProperty[key];
				state.otherProperty.Designator = 'C1';
			} });
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', aliasedFields), 'contradictory projected alias in actual OtherProperty');
		}
		for (const [label, mutate] of [
			['cleared OtherProperty', (state) => { state.otherProperty = {}; }],
			['changed Name', (state) => { state.name = 'other'; }],
		]) {
			const f = fixture({ modifyMutation: mutate });
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', fields), label);
			assert.equal(f.stats.modifies, 1, `${label}: no retry`);
		}
		{
			const f = fixture({ modifyMutation: (state, property) => {
				property.name = 'sdk-mutated-name';
				property.otherProperty.Resistance = 'sdk-mutated-value';
				state.name = property.name;
				state.otherProperty = structuredClone(property.otherProperty);
			} });
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', fields), 'SDK mutates submitted property and returns its mutated values');
			assert.equal(f.stats.modifies, 1, 'SDK mutated input still results in one official modify call');
			assert.equal(fields.name, 'Resistor', 'SDK receives an independent property copy');
			assert.equal(fields.otherProperty.Resistance, '10k', 'SDK cannot mutate caller-owned nested property values');
		}
		for (const option of [{ missingReadback: true }, { changeFocusAfterModify: true }]) {
			const f = fixture(option);
			await rejectsPartial(() => mod.modifyComponentSafely(f.api, 'component-1', fields), 'modify unreadable or focus changed');
		}
		for (const request of [
			{ x: 101 },
			{ y: 202 },
			{ rotation: 90 },
			{ mirror: true },
			{ x: 101, y: 202, rotation: 90, mirror: true },
		]) {
			const f = fixture();
			const result = await mod.moveComponentSafely(f.api, 'component-1', request);
			assert.equal(result.readback.verified, true, `move ${Object.keys(request).join('/')} verifies geometry and preservation`);
			assert.equal(f.stats.dones, 1, 'safe move submits one async state object');
			assert.deepEqual(f.stats.setters, Object.keys(request), 'safe move sets only requested fields');
		}
		for (const option of [
			{ moveMutation: (state) => { state.otherProperty.Resistance = 'changed'; } },
			{ moveMutation: (state) => { state.name = 'changed'; } },
			{ moveMutation: (state) => { state.rotation = 90; } },
			{ missingReadback: true },
			{ changeFocusAfterMove: true },
		]) {
			const f = fixture(option);
			await rejectsPartial(() => mod.moveComponentSafely(f.api, 'component-1', { x: 101 }), 'move state corruption, missing readback, or focus change');
		}
		for (const [label, original, changed] of [
			['undefined to empty string', undefined, ''],
			['null to empty string', null, ''],
			['nonempty string change', 'Resistor', 'changed'],
		]) {
			const f = fixture({ state: { name: original }, moveMutation: (state) => {
				state.name = changed;
			} });
			let error;
			try {
				await mod.moveComponentSafely(f.api, 'component-1', { x: 101 });
			}
			catch (caught) { error = caught; }
			assert.ok(error, `${label}: preserved state change remains a failure`);
			assert.equal(error.cause?.operation, 'moveComponentSafely', `${label}: operation is diagnostic`);
			assert.equal(error.cause?.primitiveId, 'component-1', `${label}: primitive id is diagnostic`);
			assert.equal(error.cause?.documentUuid, 'page-a', `${label}: document uuid is diagnostic`);
			assert.deepEqual(error.cause?.requested, { type: 'object', value: { x: { type: 'number', value: 101 } } }, `${label}: requested values retain types`);
			const difference = error.cause?.stateDifferences?.find(item => item.field === 'name');
			assert.ok(difference, `${label}: changed field is reported`);
			assert.deepEqual(difference.before, original === undefined ? { type: 'undefined' } : original === null ? { type: 'null', value: null } : { type: 'string', value: original }, `${label}: before value and type are explicit`);
			assert.deepEqual(difference.after, { type: 'string', value: changed }, `${label}: after value and type are explicit`);
			assert.deepEqual(JSON.parse(JSON.stringify(error.cause)).stateDifferences.find(item => item.field === 'name').before, difference.before, `${label}: JSON serialization preserves undefined distinction`);
		}
		{
			const f = fixture({ state: { designator: 'C1' }, moveMutation: (state) => {
				state.otherProperty = {};
			} });
			await rejectsPartial(() => mod.moveComponentSafely(f.api, 'component-1', { x: 101 }), 'in-place OtherProperty mutation is detected');
		}
		{
			const f = fixture({ moveMutation: (state) => {
				state.name = 'changed';
			} });
			globalThis.eda = f.api;
			mod.registerCommand(mod.schematicCommands.find(command => command.name === 'schematic.moveComponent'));
			mod.registerCommand({ name: 'probe.writeAfterMove', summary: 'test sentinel', params: [], returns: '', handler: async () => {
				f.stats.sentinel++;
				return { wrote: true };
			} });
			const result = await mod.executeCommand({
				cmd: 'macro',
				params: { stopOnError: false, steps: [
					{ cmd: 'schematic.moveComponent', params: { primitiveId: 'component-1', x: 101 } },
					{ cmd: 'probe.writeAfterMove' },
				] },
			});
			assert.equal(result.ok, false, 'macro reports partial move failure');
			assert.equal(result.error?.cause?.partial, true, `registry keeps partial cause at the level macro checks: ${JSON.stringify(result)}`);
			assert.equal(result.error?.cause?.operation, 'moveComponentSafely', 'registry preserves operation diagnostics through schematic.moveComponent');
			assert.equal(result.error?.cause?.primitiveId, 'component-1', 'registry preserves the failing primitive id');
			assert.equal(result.error?.cause?.documentUuid, 'page-a', 'registry preserves the document uuid');
			assert.ok(result.error?.cause?.stateDifferences?.some(item => item.field === 'name'), 'registry preserves structured state differences');
			assert.equal(result.data?.stoppedReason, 'partial', 'real registry macro stops on partial even when stopOnError is false');
			assert.equal(f.stats.sentinel, 0, 'macro does not run the later write step');
		}
		{
			const f = fixture({ state: { designator: 'C1' }, moveMutation: (state) => {
				state.otherProperty = {};
			} });
			globalThis.eda = f.api;
			mod.registerCommand(mod.schematicCommands.find(command => command.name === 'schematic.autoLayout'));
			mod.registerCommand({ name: 'probe.writeAfterLayout', summary: 'test sentinel', params: [], returns: '', handler: async () => {
				f.stats.sentinel++;
				return { wrote: true };
			} });
			const result = await mod.executeCommand({
				cmd: 'macro',
				params: { stopOnError: false, steps: [
					{ cmd: 'schematic.autoLayout', params: { designators: ['C1'], dryRun: false, rewire: true, template: { origin: { x: 300, y: 300 }, maxCols: 1 } } },
					{ cmd: 'probe.writeAfterLayout' },
				] },
			});
			assert.equal(result.ok, false, 'macro reports partial autoLayout failure');
			assert.equal(result.error?.cause?.partial, true, `registry keeps autoLayout partial cause: ${JSON.stringify(result)}`);
			assert.equal(result.error?.cause?.operation, 'moveComponentSafely', 'autoLayout preserves the move operation diagnostic');
			assert.equal(result.error?.cause?.primitiveId, 'component-1', 'autoLayout preserves the failing primitive id');
			assert.equal(result.error?.cause?.documentUuid, 'page-a', 'autoLayout preserves the document uuid');
			const difference = result.error?.cause?.stateDifferences?.find(item => item.field === 'otherProperty');
			assert.ok(difference, 'autoLayout preserves structured state differences');
			assert.deepEqual(difference.before, { type: 'object', value: { Resistance: { type: 'string', value: '10k' }, Tolerance: { type: 'number', value: 1 } } }, 'autoLayout preserves typed before value');
			assert.deepEqual(difference.after, { type: 'object', value: {} }, 'autoLayout preserves typed after value');
			assert.deepEqual(JSON.parse(JSON.stringify(result.error.cause)).stateDifferences.find(item => item.field === 'otherProperty').before, difference.before, 'autoLayout cause retains typed values after JSON serialization');
			assert.equal(result.data?.stoppedReason, 'partial', 'real registry macro stops on autoLayout partial even when stopOnError is false');
			assert.equal(f.stats.sentinel, 0, 'autoLayout macro skips the later write step');
			assert.equal(f.stats.wireGets, 1, 'autoLayout reads and plans wires before movement, but stops before deletion after move fails');
			assert.equal(f.stats.deletes, 0, 'autoLayout does not delete wires after move fails');
		}
		console.log('PASS component mutation regression (all checks)');
	}
	finally {
		await rm(resolve(ROOT, bundle), { force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
