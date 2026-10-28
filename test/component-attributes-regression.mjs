import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE = 'test/.component-attributes-regression-bundle.mjs';
const COMPONENT_ID = '51611a06d7952274';
const OTHER_COMPONENT_ID = '3b6f628633b0709d';
const ATTR_ID = '51611a06d7952274e16';

// Verbatim effective records copied from the host snapshot
// b-development-20261021/evidence/b8-host-pcb-before-source.json.
const fixtureSource = [
	'{"type":"DOCHEAD"}||{"docType":"PCB","client":"fff816b2607397b7","uuid":"3883ab7203d203769","updateTime":1792585595323,"version":"1792585595323"}|',
	'{"type":"VIA","ticket":157,"id":"88ec727a8ddd656d"}||{"partitionId":"","groupId":0,"netName":"+5V","ruleName":"","centerX":262.648,"centerY":292.917,"holeDiameter":12,"viaDiameter":24,"viaType":"NORMAL","topSolderExpansion":null,"bottomSolderExpansion":null,"locked":false,"unusedInnerLayers":[],"propagationDelay":0}|',
	'{"type":"LINE","ticket":161,"id":"4a4b25503a16fe46"}||{"partitionId":"","groupId":0,"netName":"+5V","layerId":16,"startX":262.648,"startY":292.917,"endX":962.648,"endY":292.917,"width":10.05,"locked":false,"zIndex":-1}|',
	'{"type":"COMPONENT","ticket":172,"id":"51611a06d7952274"}||{"partitionId":"","groupId":0,"layerId":1,"x":200,"y":300,"angle":0,"attrs":{"Add into BOM":"no","Unique ID":"gge1","Reuse Block":"","Group ID":"","Channel ID":"$2I2","DeviceName":"{\\"name\\":\\"0603WAF1002T5E\\",\\"source\\":\\"\\",\\"uuid\\":\\"734a176d26962cda\\"}"},"locked":false,"zIndex":-1,"pinSwap":false,"pinSwapInfo":{"51611a06d7952274e7":{"pinClass":"","differentialPairClass":""},"51611a06d7952274e8":{"pinClass":"","differentialPairClass":""}},"footprintPrimitives":true}|',
	'{"type":"ATTR","ticket":173,"id":"51611a06d7952274e15"}||{"partitionId":"","groupID":0,"parentId":"51611a06d7952274","layerId":3,"x":null,"y":null,"key":"Footprint","value":"b11cd6ee16e22f94","keyVisible":false,"valueVisible":false,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":0,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":15,"specialColor":null}|',
	'{"type":"ATTR","ticket":174,"id":"51611a06d7952274e16"}||{"partitionId":"","groupID":0,"parentId":"51611a06d7952274","layerId":3,"x":142.469,"y":334.008,"key":"Designator","value":"R1","keyVisible":false,"valueVisible":true,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":0,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":16,"specialColor":null}|',
	'{"type":"ATTR","ticket":175,"id":"51611a06d7952274e0"}||{"partitionId":"","groupID":0,"parentId":"51611a06d7952274","layerId":3,"x":null,"y":null,"key":"Device","value":"734a176d26962cda","keyVisible":false,"valueVisible":false,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":0,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":-1,"specialColor":null}|',
	'{"type":"PAD_NET","ticket":176,"id":"[\\"PAD_NET\\",\\"51611a06d7952274\\",\\"2\\",\\"e7\\"]"}||{"partitionId":"","padNet":"+5V","padLen":null,"propagationDelay":null,"attrsMap":{}}|',
	'{"type":"PAD_NET","ticket":177,"id":"[\\"PAD_NET\\",\\"51611a06d7952274\\",\\"1\\",\\"e8\\"]"}||{"partitionId":"","padNet":"ACE_VIA","padLen":null,"propagationDelay":null,"attrsMap":{}}|',
	'{"type":"COMPONENT","ticket":178,"id":"3b6f628633b0709d"}||{"partitionId":"","groupId":0,"layerId":2,"x":900,"y":300,"angle":0,"attrs":{"Add into BOM":"no","Unique ID":"gge2","Reuse Block":"","Group ID":"","Channel ID":"$2I3","DeviceName":"{\\"name\\":\\"0603WAF1002T5E\\",\\"source\\":\\"\\",\\"uuid\\":\\"734a176d26962cda\\"}"},"locked":false,"zIndex":-1,"pinSwap":false,"pinSwapInfo":{"3b6f628633b0709de7":{"pinClass":"","differentialPairClass":""},"3b6f628633b0709de8":{"pinClass":"","differentialPairClass":""}},"footprintPrimitives":true}|',
	'{"type":"ATTR","ticket":179,"id":"3b6f628633b0709de15"}||{"partitionId":"","groupID":0,"parentId":"3b6f628633b0709d","layerId":4,"x":null,"y":null,"key":"Footprint","value":"b11cd6ee16e22f94","keyVisible":false,"valueVisible":false,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":180,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":15,"specialColor":null}|',
	'{"type":"ATTR","ticket":180,"id":"3b6f628633b0709de16"}||{"partitionId":"","groupID":0,"parentId":"3b6f628633b0709d","layerId":4,"x":842.469,"y":265.992,"key":"Designator","value":"R2","keyVisible":false,"valueVisible":true,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":180,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":16,"specialColor":null}|',
	'{"type":"ATTR","ticket":181,"id":"3b6f628633b0709de0"}||{"partitionId":"","groupID":0,"parentId":"3b6f628633b0709d","layerId":4,"x":null,"y":null,"key":"Device","value":"734a176d26962cda","keyVisible":false,"valueVisible":false,"fontFamily":"default","fontSize":45,"strokeWidth":6,"bold":0,"italic":0,"origin":"LEFT_BOTTOM","angle":180,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":-1,"specialColor":null}|',
	'{"type":"PAD_NET","ticket":182,"id":"[\\"PAD_NET\\",\\"3b6f628633b0709d\\",\\"2\\",\\"e7\\"]"}||{"partitionId":"","padNet":"+5V","padLen":null,"propagationDelay":null,"attrsMap":{}}|',
	'{"type":"PAD_NET","ticket":183,"id":"[\\"PAD_NET\\",\\"3b6f628633b0709d\\",\\"1\\",\\"e8\\"]"}||{"partitionId":"","padNet":"ACE_VIA","padLen":null,"propagationDelay":null,"attrsMap":{}}|',
].join('\n');

function parseRows(source) {
	return source.split(/\r?\n/).filter(Boolean).map(line => {
		const at = line.indexOf('||');
		const header = JSON.parse(line.slice(0, at));
		const rawData = line.slice(at + 2).replace(/\|$/, '');
		return { header, data: rawData ? JSON.parse(rawData) : '' };
	});
}

function encodeRows(rows) {
	return rows.map(item => `${JSON.stringify(item.header)}||${JSON.stringify(item.data)}`).join('|\n');
}

function replaceTargetData(source, update) {
	const rows = parseRows(source);
	const target = rows.findLast(item => item.header.type === 'ATTR' && item.header.id === ATTR_ID);
	update(target.data);
	return encodeRows(rows);
}

function duplicateDesignator(source) {
	const rows = parseRows(source);
	const second = rows.findLast(item => item.header.type === 'ATTR' && item.header.id === '3b6f628633b0709de16');
	rows.push({ header: { ...second.header, ticket: second.header.ticket + 1 }, data: { ...second.data, value: 'R1' } });
	return encodeRows(rows);
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
	return value;
}

function makeSdk(source, options = {}) {
	let currentSource = source;
	let writes = 0;
	let sourceReads = 0;
	let focus = { documentType: 3, uuid: '3883ab7203d203769' };
	let afterWriteReads = 0;
	let lateTimer;
	const sourceRows = () => parseRows(currentSource);
	const readSource = () => {
		sourceReads++;
		if (options.volatileDocHeadEachRead || options.changeUuidOnRead === sourceReads || options.changeDocHeadFieldOnRead === sourceReads || options.changeNonTargetOnRead === sourceReads) {
			const rows = sourceRows();
			const docHead = rows.find(item => item.header.type === 'DOCHEAD');
			if (options.volatileDocHeadEachRead) {
				docHead.data.client = `client-${sourceReads}`;
				docHead.data.updateTime = Number(docHead.data.updateTime) + sourceReads;
				docHead.data.version = `v-${sourceReads}`;
			}
			if (options.changeUuidOnRead === sourceReads) docHead.data.uuid = 'different-document';
			if (options.changeDocHeadFieldOnRead === sourceReads) docHead.data.unexpected = 'changed';
			if (options.changeNonTargetOnRead === sourceReads) {
				const line = rows.find(item => item.header.type === 'LINE');
				line.data.width = 99;
			}
			currentSource = encodeRows(rows);
		}
		return currentSource;
	};
	const getComponent = id => {
		const row = sourceRows().find(item => item.header.type === 'COMPONENT' && item.header.id === id);
		return row ? { getState_PrimitiveId: () => id, getState_PrimitiveLock: () => row.data.locked } : undefined;
	};
	const makeAttr = row => {
		const id = row.header.id;
		const d = row.data;
		return {
			getState_PrimitiveId: () => id,
			getState_ParentPrimitiveId: () => d.parentId,
			getState_Key: () => d.key,
			getState_Value: () => d.value,
			getState_Layer: () => d.layerId,
			getState_X: () => options.mismatchGetter && id === ATTR_ID ? d.x + 1 : d.x,
			getState_Y: () => d.y,
			getState_Rotation: () => d.angle,
			getState_FontSize: () => options.mismatchFreshGetter && writes > 0 && id === ATTR_ID ? d.fontSize + 1 : d.fontSize,
			getState_ValueVisible: () => d.valueVisible,
			getState_PrimitiveLock: () => d.locked,
		};
	};
	const appendModified = (id, property) => {
		const rows = sourceRows();
		const old = rows.findLast(item => item.header.type === 'ATTR' && item.header.id === id);
		const next = { ...old.data };
		for (const [key, value] of Object.entries(property)) next[key === 'rotation' ? 'angle' : key] = value;
		if (options.modifyOtherRecord) {
			const line = rows.find(item => item.header.type === 'LINE');
			line.data.width = 99;
		}
		const encoded = encodeRows(rows);
		const header = { ...old.header, ticket: old.header.ticket + 1 };
		currentSource = `${encoded}|\n${JSON.stringify(header)}||${JSON.stringify(next)}`;
	};
	const api = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => focus },
		pcb_Drc: { getCurrentRuleConfiguration: async () => ({ spacing: 6 }) },
		sys_FileManager: { getDocumentSource: async () => readSource() },
		pcb_PrimitiveComponent: { get: async id => getComponent(id) },
		pcb_PrimitiveAttribute: {
			getAll: async parentId => sourceRows().filter(row => row.header.type === 'ATTR' && row.data.parentId === parentId).map(makeAttr),
			get: async id => {
				afterWriteReads++;
				if (options.failFreshGet && writes > 0 && afterWriteReads >= 1) return undefined;
				const row = sourceRows().findLast(item => item.header.type === 'ATTR' && item.header.id === id);
				return row ? makeAttr(row) : undefined;
			},
			modify: async (id, property) => {
				writes++;
				if (options.throwModify) throw new Error('SDK rejected');
				if (options.changeFocusAfterModify) focus = { ...focus, uuid: 'other-page' };
				if (options.hangModify) {
					lateTimer = setTimeout(() => appendModified(id, property), 1100);
					return new Promise(() => {});
				}
			appendModified(id, property);
			return undefined;
			},
		},
	};
	return {
		api,
		get source() { return currentSource; },
		get writes() { return writes; },
		get lateTimer() { return lateTimer; },
		setFocus(value) { focus = value; },
	};
}

async function main() {
	await build({
		stdin: {
			contents: `
import { componentAttributeCommands } from '../src/commands/componentAttributes.ts'
export { componentAttributeCommands }
`,
			resolveDir: resolve(ROOT, 'test'),
			sourcefile: '.component-attributes-regression-entry.ts',
		},
		outfile: BUNDLE,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node24',
	});
	try {
		const module = await import(pathToFileURL(resolve(BUNDLE)).href);
		const command = module.componentAttributeCommands.find(item => item.name === 'pcb.modifyComponentAttribute');
		assert.ok(command, 'component Designator command is defined');
		const original = fixtureSource;
		assert.equal(parseRows(original).filter(row => row.header.type === 'COMPONENT').length, 2, 'fixture contains two real components');
		assert.equal(parseRows(original).filter(row => row.header.type === 'ATTR').length, 6, 'fixture contains six real attributes');

		{
			const sdk = makeSdk(original);
			globalThis.eda = sdk.api;
			const result = await command.handler({ componentId: COMPONENT_ID, designator: 'R1', x: 150.25, y: 340.5, rotation: 90, fontSize: 50, visible: false });
			assert.equal(result.verified, true, 'top-side multi-field update passes source and getter readback');
			assert.equal(result.designator, 'R1', 'designator is returned without changing its text');
			assert.deepEqual(result.requested, { x: 150.25, y: 340.5, rotation: 90, fontSize: 50, valueVisible: false }, 'only requested attribute fields are sent to SDK');
			assert.equal(result.componentAndOtherRecordsUnchanged, true, 'component, pads, nets, and all non-target effective records are checked');
			assert.equal(result.sourceVerification.ticketChanges.length, 1, 'target ticket increment is reported separately');
			assert.equal(sdk.writes, 1, 'one SDK write only');
		}
		{
			const sdk = makeSdk(original, { volatileDocHeadEachRead: true });
			globalThis.eda = sdk.api;
			const result = await command.handler({ componentId: COMPONENT_ID, visible: false });
			assert.equal(result.verified, true, 'source reads differing only in DOCHEAD client/time/version pass');
			assert.deepEqual(result.sourceVerification.documentHeaderChanges.map(item => item.field).sort(), ['client', 'updateTime', 'version'], 'the three volatile DOCHEAD fields are reported separately');
		}
		{
			const sdk = makeSdk(original);
			globalThis.eda = sdk.api;
			const result = await command.handler({ designator: 'R2', visible: false });
			assert.equal(result.verified, true, 'bottom-side hidden Designator may be changed');
			assert.equal(result.after.valueVisible, false, 'visible maps to Value visibility');
			assert.equal(result.after.key, 'Designator', 'the Key is unchanged');
			assert.equal(sdk.writes, 1, 'designator-only lookup writes once');
		}
		{
			const sdk = makeSdk(replaceTargetData(original, data => { data.x = null; data.y = null; }));
			globalThis.eda = sdk.api;
			const result = await command.handler({ componentId: COMPONENT_ID, fontSize: 48 });
			assert.equal(result.verified, true, 'style-only modification preserves null coordinates');
			assert.equal(result.after.x, null, 'null x remains unchanged');
			assert.equal(result.after.y, null, 'null y remains unchanged');
		}
		for (const params of [
			{ x: 1 },
			{ componentId: COMPONENT_ID },
			{ componentId: COMPONENT_ID, designator: 'R2', visible: false },
			{ componentId: COMPONENT_ID, key: 'Footprint', visible: false },
			{ componentId: COMPONENT_ID, visible: 'false' },
			{ componentId: COMPONENT_ID, x: Number.NaN },
			{ componentId: COMPONENT_ID, unexpected: true, visible: true },
		]) {
			const sdk = makeSdk(original);
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler(params), undefined, `invalid params reject: ${JSON.stringify(params)}`);
			assert.equal(sdk.writes, 0, 'input validation failure does not write');
		}
		{
			const sdk = makeSdk(duplicateDesignator(original));
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ designator: 'R1', visible: false }), /unique|唯一/i);
			assert.equal(sdk.writes, 0, 'ambiguous designator is rejected before writing');
		}
		for (const options of [
			{ changeUuidOnRead: 4 },
			{ changeDocHeadFieldOnRead: 4 },
			{ changeNonTargetOnRead: 4 },
		]) {
			const sdk = makeSdk(original, options);
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /source changed|源码已变化|uuid|DOCHEAD|记录不同|different/i);
			assert.equal(sdk.writes, 0, 'non-volatile DOCHEAD/source changes are rejected before writing');
		}
		{
			const sdk = makeSdk(replaceTargetData(original, data => { data.locked = true; }));
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /locked|锁定/i);
			assert.equal(sdk.writes, 0, 'locked Designator is rejected without auto-unlock');
		}
		{
			const sdk = makeSdk(original, { modifyOtherRecord: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /non-target PCB source record changed|源码记录发生变化/i);
			assert.equal(sdk.writes, 1, 'source side effect is reported after one write and never retried');
			const independent = await command.handler({ componentId: OTHER_COMPONENT_ID, visible: false });
			assert.equal(independent.verified, true, 'a later independent command in the same SDK remains usable');
		}
		{
			const sdk = makeSdk(original, { mismatchGetter: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /source and EDA|源码与 EDA/i);
			assert.equal(sdk.writes, 0, 'source/getter mismatch is refused before writing');
		}
		{
			const sdk = makeSdk(original, { failFreshGet: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /cannot read back|无法按 ID 读回|读回为空/i);
			assert.equal(sdk.writes, 1, 'missing fresh getter is a post-write failure without retry');
		}
		{
			const sdk = makeSdk(original, { mismatchFreshGetter: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /write|写入后|getter/i);
			assert.equal(sdk.writes, 1, 'fresh getter difference is reported without retry');
		}
		{
			const sdk = makeSdk(original, { throwModify: true });
			globalThis.eda = sdk.api;
			let error;
			try { await command.handler({ componentId: COMPONENT_ID, visible: false }); } catch (caught) { error = caught; }
			assert.ok(error, 'SDK rejection propagates');
			assert.equal(error.cause?.partial, true, 'SDK rejection is marked partial because write was attempted');
			assert.equal(sdk.writes, 1, 'SDK rejection is never retried');
		}
		{
			const sdk = makeSdk(original, { changeFocusAfterModify: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false }), /focus|焦点/i);
			assert.equal(sdk.writes, 1, 'focus change stops after the single write');
		}
		{
			const sdk = makeSdk(original, { hangModify: true });
			globalThis.eda = sdk.api;
			await assert.rejects(command.handler({ componentId: COMPONENT_ID, visible: false, _timeoutMs: 1000 }), /预算|timeout|超时/i);
			assert.equal(sdk.writes, 1, 'late SDK operation is not retried');
			await new Promise(resolve => setTimeout(resolve, 250));
			assert.ok(sdk.lateTimer, 'late write remains observable in the fixture; timeout does not mean cancellation');
			assert.equal(parseRows(sdk.source).findLast(row => row.header.type === 'ATTR' && row.header.id === ATTR_ID).data.valueVisible, false, 'the host may still apply the late write after timeout');
		}
		{
			const sdk = makeSdk(original);
			globalThis.eda = sdk.api;
			const afterFailure = await command.handler({ componentId: OTHER_COMPONENT_ID, visible: false });
			assert.equal(afterFailure.verified, true, 'a separate command operation remains usable after another operation fails');
		}
		console.log('PASS: component attribute readback, exact source preservation, validation, focus, partial and late-write cases');
	}
	finally {
		delete globalThis.eda;
		await import('node:fs/promises').then(({ rm }) => rm(resolve(BUNDLE), { force: true }));
	}
}

await main();
