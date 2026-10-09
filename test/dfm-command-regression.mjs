import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const plugins = [{
	name: 'mock-dfm-dependencies',
	setup(build) {
		build.onResolve({ filter: /^\.\.\/engine\/registry$/ }, () => ({ path: 'registry', namespace: 'mock' }));
		build.onResolve({ filter: /^\.\.\/dfm\/official$/ }, () => ({ path: 'official', namespace: 'mock' }));
		build.onResolve({ filter: /^\.\.\/pcb\/sourcelog$/ }, () => ({ path: 'sourcelog', namespace: 'mock' }));
		build.onLoad({ filter: /.*/, namespace: 'mock' }, args => {
			if (args.path === 'registry') return { contents: `
				export const registerCommand = def => globalThis.__dfm.registry.set(def.name, def);
				export const executeCommand = async request => {
					globalThis.__dfm.executeRequests.push(request);
					const def = globalThis.__dfm.registry.get(request.cmd);
					if (!def) return { ok: false, cmd: request.cmd, error: { message: 'unknown command' } };
					try { return { ok: true, cmd: request.cmd, data: await def.handler(request.params), durationMs: 0 }; }
					catch (error) { return { ok: false, cmd: request.cmd, error: { message: String(error?.message ?? error) } }; }
				};
			` };
			if (args.path === 'official') return { contents: `
				export const JLC_SUPPORTED_MATERIALS = ['FR4', 'CEM1'];
				export const DFM_COVERAGE = ['coverage boundary'];
				export const UPSTREAM_INFO = { repository: 'pinned-upstream', commit: 'commit-1', version: '1.0.4', license: 'Apache-2.0' };
				export async function runOfficialDfm(kind, params, sdk) { return await globalThis.__dfm.runOfficialDfm(kind, params, sdk); }
			` };
			return { contents: `export function parseSourceLog(source) { const marker = String(source).split('DOCHEAD:')[1]; if (!marker) throw new Error('missing DOCHEAD'); const [uuid, docType] = marker.split('|'); if (!uuid || !docType) throw new Error('invalid DOCHEAD'); return { uuid, docType }; }` };
		});
	},
}];
const commandBundle = await build({ entryPoints: ['src/commands/dfm.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, plugins });
const menuBundle = await build({ entryPoints: ['src/dfm/menu.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, plugins });

function fixture({ runOfficialDfm = async (kind, params, sdk) => {
	const pads = await sdk.pcb_PrimitivePad.getAll();
	const source = await sdk.sys_FileManager.getDocumentSource();
	return { results: [{ number: 1, item: kind, actualValue: String(pads.length), standardValue: '1', result: 'success', source }], expectedCount: 1, issues: [], coverage: ['coverage boundary'], upstreamPassed: true, complete: true, passed: true };
}, focus = { uuid: 'pcb-A', documentType: 3 }, now = 1000, lexicalEda = false } = {}) {
	const state = { focus, now, reads: [], focusReads: 0, source: 'DOCHEAD:pcb-A|PCB', sourceReads: 0, coreCalls: [], executeRequests: [], registry: new Map(), writes: [], selected: [], navigated: [], saveResult: undefined, saveError: undefined, afterPadRead: undefined, padGate: undefined };
	class TestDate extends Date { static now() { return state.now; } }
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => { state.focusReads++; return { ...state.focus }; } },
		sys_FileManager: { getDocumentSource: async () => { state.sourceReads++; state.reads.push('source'); return state.source; } },
		pcb_PrimitivePad: { getAll: async () => { state.reads.push('pads'); if (state.padGate) await state.padGate; if (state.afterPadRead) await state.afterPadRead(); return [{}]; } },
		pcb_SelectControl: { doSelectPrimitives: async ids => { state.selected.push(ids); return true; } },
		pcb_Document: { navigateToCoordinates: async (x, y) => { state.navigated.push([x, y]); return true; } },
		sys_FileSystem: { saveFile: async (blob, name) => { if (state.saveError) throw state.saveError; state.writes.push({ blob, name }); return state.saveResult; } },
		sys_Unit: { mmToMil: x => x * 39.37, milToMm: x => x / 39.37 },
		sys_Log: { add: () => { throw new Error('DFM must not write logs'); } },
		sys_IFrame: { openIFrame: async (...args) => { state.frame = args; return true; } },
		sys_Dialog: { showInformationMessage: (...args) => { state.dialog = args; } },
	};
	const context = { module: { exports: {} }, exports: {}, Date: TestDate, Blob, console, __dfm: state };
	if (lexicalEda) {
		context.__hostEda = eda;
		vm.runInNewContext('const eda = __hostEda;', context);
	}
	else {
		context.eda = eda;
	}
	state.runOfficialDfm = runOfficialDfm;
	vm.runInNewContext(commandBundle.outputFiles[0].text, context);
	if (lexicalEda)
		assert.equal(vm.runInNewContext('globalThis.eda', context), undefined);
	return { state, eda, api: context.module.exports };
}

let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
function jsonEqual(actual, expected) { assert.equal(JSON.stringify(actual), JSON.stringify(expected)); }

await test('required parameters reject missing, strings, NaN, Infinity, and nonpositive values before SDK reads', async () => {
	const f = fixture();
	const byName = Object.fromEntries(f.api.dfmCommands.map(command => [command.name, command]));
	for (const [name, params] of [
		['pcb.runDfm', { material: 'FR4', thickness: 1.6 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, outerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, outerCopperOz: 1, innerCopperOz: 2 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, outerCopperOz: 3, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, outerCopperOz: NaN, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 1.6, outerCopperOz: '1', innerCopperOz: 1 }],
		['pcb.runDfm', { thickness: 1.6, outerCopperOz: 1, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 'NaN', outerCopperOz: 1, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: Infinity, outerCopperOz: 1, innerCopperOz: 1 }],
		['pcb.runDfm', { material: 'FR4', thickness: 0, outerCopperOz: 1, innerCopperOz: 1 }],
		['pcb.runSmtDfm', { standard: 'eco', thickness: 1.6 }], ['pcb.runSmtDfm', { standard: 'standard', thickness: '1.6' }],
		['pcb.checkSameNetPadSpacing', { minSpacingMm: 'NaN' }], ['pcb.checkSameNetPadSpacing', { minSpacingMm: -0.1 }],
	]) await assert.rejects(byName[name].handler(params));
	assert.equal(f.state.reads.length, 0);
	assert.equal(f.state.focusReads, 0);
	assert.equal(f.state.coreCalls.length, 0);
});

await test('three command definitions use lexical EDA binding, pass only validated inputs, and return source metadata', async () => {
	const f = fixture({ lexicalEda: true, runOfficialDfm: async (kind, params, sdk) => {
		fState.coreCalls.push({ kind, params });
		const pads = await sdk.pcb_PrimitivePad.getAll();
		await sdk.sys_FileManager.getDocumentSource();
		return {
			results: [{ item: kind, result: 'success', violations: [] }], expectedCount: 1, issues: [], coverage: ['geometry scope'], upstreamPassed: true, complete: true, passed: true, padCount: pads.length,
			...(kind === 'pcb' ? { reportedCopper: { status: 'available', layers: [{ layerId: 1, thicknessMil: 1.379, copperOz: 1 }], matchesTarget: false, differences: [{ layerId: 1, requestedOz: params.outerCopperOz, reportedOz: 1 }], messages: [] } } : {}),
		};
	} });
	const fState = f.state;
	const byName = Object.fromEntries(f.api.dfmCommands.map(command => [command.name, command]));
	const pcb = await byName['pcb.runDfm'].handler({ material: 'FR4', thickness: 1.6, outerCopperOz: 2, innerCopperOz: 1 });
	const smt = await byName['pcb.runSmtDfm'].handler({ standard: 'economy', thickness: 1.2 });
	const spacing = await byName['pcb.checkSameNetPadSpacing'].handler({ minSpacingMm: 0.18 });
	jsonEqual(fState.coreCalls, [
		{ kind: 'pcb', params: { material: 'FR4', thickness: 1.6, outerCopperOz: 2, innerCopperOz: 1 } },
		{ kind: 'smt', params: { standard: 'economy', thickness: 1.2 } },
		{ kind: 'spacing', params: { minSpacingMm: 0.18 } },
	]);
	for (const [result, checkType, inputs] of [[pcb, 'pcb', { material: 'FR4', thickness: 1.6, outerCopperOz: 2, innerCopperOz: 1 }], [smt, 'smt', { standard: 'economy', thickness: 1.2 }], [spacing, 'spacing', { minSpacingMm: 0.18 }]]) {
		assert.equal(result.documentUuid, 'pcb-A'); assert.equal(result.checkType, checkType); jsonEqual(result.inputs, inputs);
		assert.equal(result.upstream.commit, 'commit-1'); assert.equal(result.complete, true); assert.equal(result.passed, true); assert.equal(typeof result.timestamp, 'number');
	}
	assert.equal(pcb.reportedCopper.status, 'available');
	assert.equal(pcb.reportedCopper.matchesTarget, false);
	assert.equal(pcb.passed, true);
	assert.equal(smt.reportedCopper, undefined);
	assert.equal(fState.writes.length, 0); assert.equal(fState.selected.length, 0); assert.equal(fState.navigated.length, 0);
});

await test('focus loss latches failure and blocks every later real SDK read even if core catches it', async () => {
	const f = fixture({ runOfficialDfm: async (_kind, _params, sdk) => {
		try { await sdk.pcb_PrimitivePad.getAll(); } catch {}
		try { await sdk.sys_FileManager.getDocumentSource(); } catch {}
		return { results: [], expectedCount: 1, issues: [], coverage: [], upstreamPassed: false, complete: false, passed: false };
	} });
	f.state.afterPadRead = async () => { f.state.focus = { uuid: 'pcb-B', documentType: 3 }; };
	await assert.rejects(f.api.dfmCommands[2].handler({ minSpacingMm: 0.2 }), /DFM 检查已停止.*焦点已离开/);
	assert.deepEqual(f.state.reads, ['pads']);
});

await test('late SDK return after the existing deadline cannot start the next read', async () => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const f = fixture({ runOfficialDfm: async (_kind, _params, sdk) => {
		try { await sdk.pcb_PrimitivePad.getAll(); } catch {}
		try { await sdk.sys_FileManager.getDocumentSource(); } catch {}
		return { results: [], expectedCount: 1, issues: [], coverage: [], upstreamPassed: false, complete: false, passed: false };
	} });
	f.state.padGate = gate;
	const pending = f.api.dfmCommands[2].handler({ minSpacingMm: 0.2, _timeoutMs: 1000 });
	for (let i = 0; i < 8; i++) await Promise.resolve();
	f.state.now = 2000;
	release();
	await assert.rejects(pending, /超过现有 1000ms 执行预算/);
	assert.deepEqual(f.state.reads, ['pads']);
});

await test('getDocumentSource checks DOCHEAD identity and preserves the original SDK rejection', async () => {
	const wrong = fixture({ runOfficialDfm: async (_kind, _params, sdk) => { await sdk.sys_FileManager.getDocumentSource(); return {}; } });
	wrong.state.source = 'DOCHEAD:pcb-B|PCB';
	await assert.rejects(wrong.api.dfmCommands[2].handler({ minSpacingMm: 0.2 }), /DOCHEAD.*不符/);
	const sdkFailure = new Error('original source read refused');
	const rejected = fixture({ runOfficialDfm: async (_kind, _params, sdk) => { await sdk.sys_FileManager.getDocumentSource(); return {}; } });
	rejected.eda.sys_FileManager.getDocumentSource = async () => { throw sdkFailure; };
	await assert.rejects(rejected.api.dfmCommands[2].handler({ minSpacingMm: 0.2 }), error => error === sdkFailure);
});

await test('per-request SDK read queues are independent and preserve pure unit conversions', async () => {
	const f = fixture({ runOfficialDfm: async (_kind, _params, sdk) => {
		const reads = await Promise.all([sdk.pcb_PrimitivePad.getAll(), sdk.pcb_PrimitivePad.getAll()]);
		return { results: [{ item: 'spacing', result: 'success', mm: sdk.sys_Unit.milToMm(39.37), count: reads.length }], expectedCount: 1, issues: [], coverage: [], upstreamPassed: true, complete: true, passed: true };
	} });
	const result = await f.api.dfmCommands[2].handler({ minSpacingMm: 0.2 });
	assert.deepEqual(f.state.reads, ['pads', 'pads']);
	assert.equal(result.results[0].mm, 1);
});

await test('menu binds a unique PCB session, calls shared command handler, guards selection/navigation, and exports through saveFile', async () => {
	const f = fixture();
	const context = { module: { exports: {} }, exports: {}, Date: Date, Blob, console, __dfm: f.state, __hostEda: f.eda };
	vm.runInNewContext('const eda = __hostEda;', context);
	vm.runInNewContext(menuBundle.outputFiles[0].text, context);
	assert.equal(vm.runInNewContext('globalThis.eda', context), undefined);
	context.module.exports.installDfmMenuApi();
	await context.module.exports.pcbDfmMenu();
	assert.match(f.state.frame[3], /^jlcOrderDfm-/);
	assert.equal(f.state.frame[0], '/iframe/jlc-dfm/index.html');
	const api = f.eda.jlcOrderDfm;
	const menuContext = await api.getContext();
	assert.equal(menuContext.documentUuid, 'pcb-A');
	const report = await api.runCheck('pcb', { material: 'FR4', thickness: 1.6, outerCopperOz: 1, innerCopperOz: 1 }, menuContext.sessionToken);
	assert.equal(report.data.documentUuid, 'pcb-A');
	jsonEqual(f.state.executeRequests[0].params, { material: 'FR4', thickness: 1.6, outerCopperOz: 1, innerCopperOz: 1, __docUuid: 'pcb-A' });
	assert.equal(await api.locate({ id: 'pad-1', x: 12, y: 34 }, menuContext.sessionToken), true);
	jsonEqual(f.state.selected, [['pad-1']]); jsonEqual(f.state.navigated, [[12, 34]]);
	const saved = await api.saveReport('json', '{"report":true}', menuContext.sessionToken);
	assert.equal(saved.saved, true); assert.equal(f.state.writes.length, 1);
	assert.match(f.state.writes[0].name, /pcb-A/);
	f.state.focus = { uuid: 'pcb-B', documentType: 3 };
	await assert.rejects(api.locate({ id: 'pad-2', x: 1, y: 2 }, menuContext.sessionToken), /文档已切换/);
	assert.equal(f.state.selected.length, 1);
	await assert.rejects(api.runCheck('pcb', { material: 'FR4', thickness: 1.6, outerCopperOz: 2, innerCopperOz: 1 }, menuContext.sessionToken), /文档已切换/);
	assert.equal(f.state.executeRequests.length, 1);
});

await test('iframe report failure clears a previously rendered report and uses text nodes for dynamic text', async () => {
	const html = await readFile('iframe/jlc-dfm/index.html', 'utf8');
	assert.doesNotMatch(html, /\.innerHTML\s*=/);
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	class Element {
		constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = new Map(); this.disabled = false; this.hidden = false; this.value = ''; this.valueAsNumber = NaN; this.textContent = ''; }
		append(...nodes) { this.children.push(...nodes); }
		replaceChildren(...nodes) { this.children = [...nodes]; }
		addEventListener(name, fn) { this.listeners.set(name, fn); }
		click() { return this.listeners.get('click')?.(); }
		dispatch(name) { return this.listeners.get(name)?.(); }
	}
	const allText = node => `${node.textContent}${node.children.map(allText).join('')}`;
	const elements = new Map();
	const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }, createElement: tag => new Element(tag), querySelectorAll: () => [] };
	const completeReport = outerCopperOz => ({ ok: true, cmd: 'pcb.runDfm', data: {
		checkType: 'pcb', documentUuid: 'pcb-A',
		results: [{ number: 5, item: '外层铜厚', result: 'success', actualValue: `${outerCopperOz} oz`, standardValue: `${outerCopperOz === 2 ? '0.15' : '0.10'} mm 线宽/线距目标`, violations: [] }],
		expectedCount: 18, issues: [], coverage: ['<script>text</script>'], complete: true, upstreamPassed: true, passed: true, timestamp: Date.now(),
		upstream: { repository: 'repo', version: '1.0.4', commit: 'commit', license: 'Apache-2.0' },
		inputs: { material: 'FR4', thickness: 1.6, outerCopperOz, innerCopperOz: 1 },
		reportedCopper: { status: 'partial', layers: [{ layerId: 1, thicknessMil: 0.69, copperOz: 0.5 }], matchesTarget: false, differences: [{ layerId: 1, requestedOz: outerCopperOz, reportedOz: 0.5 }], messages: ['图纸源记录到外层 0.5 oz'] },
	} });
	let runs = 0;
	const runInputs = [];
	const savedReports = [];
	const window = { eda: { jlcOrderDfm: {
		getContext: async () => ({ documentUuid: 'pcb-A', sessionToken: 'session-1', initialKind: 'pcb', materials: ['FR4'], upstream: completeReport(2).data.upstream }),
		runCheck: async (_kind, inputs) => { runInputs.push({ ...inputs }); if (++runs === 1) return completeReport(2); if (runs === 2) return completeReport(1); throw new Error('mock read failure'); },
		saveReport: async (extension, content) => { savedReports.push({ extension, content }); return { saved: true, fileName: `report.${extension}` }; },
	} } };
	vm.runInNewContext(script, { window, document, Date, console, Blob });
	for (let i = 0; i < 10; i++) await Promise.resolve();
	document.getElementById('material').value = 'FR4'; document.getElementById('thickness').valueAsNumber = 1.6;
	document.getElementById('outer-copper').value = '2'; document.getElementById('inner-copper').value = '1';
	document.getElementById('run').click();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	jsonEqual(runInputs[0], { material: 'FR4', thickness: 1.6, outerCopperOz: 2, innerCopperOz: 1 });
	assert.ok(document.getElementById('report').children.length > 0);
	assert.ok(allText(document.getElementById('report')).includes('外层铜厚'));
	assert.ok(allText(document.getElementById('report')).includes('<script>text</script>'));
	assert.ok(allText(document.getElementById('report')).includes('material：FR4'));
	assert.ok(allText(document.getElementById('report')).includes('thickness：1.6'));
	assert.ok(allText(document.getElementById('report')).includes('下单外层铜厚目标：2 oz'));
	assert.ok(allText(document.getElementById('report')).includes('下单内层铜厚选项：1 oz'));
	assert.ok(allText(document.getElementById('report')).includes('综合 passed：是'));
	assert.ok(allText(document.getElementById('report')).includes('图层 1 与目标差异：要求 2 oz，图纸记录 0.5 oz'));
	assert.ok(allText(document.getElementById('report')).includes('0.15 mm 线宽/线距目标'));
	document.getElementById('export-txt').click();
	document.getElementById('export-json').click();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(savedReports.length, 2);
	assert.match(savedReports[0].content, /输入：\{"material":"FR4","thickness":1\.6,"outerCopperOz":2,"innerCopperOz":1\}/);
	assert.match(savedReports[0].content, /下单外层铜厚目标：2 oz/);
	assert.match(savedReports[0].content, /图纸源记录到外层 0\.5 oz/);
	assert.match(savedReports[0].content, /要求 2 oz，图纸记录 0\.5 oz/);
	assert.match(savedReports[0].content, /0\.15 mm 线宽\/线距目标/);
	const exportedJson = JSON.parse(savedReports[1].content);
	assert.equal(exportedJson.data.inputs.outerCopperOz, 2);
	assert.equal(exportedJson.data.inputs.innerCopperOz, 1);
	assert.equal(exportedJson.data.reportedCopper.differences[0].reportedOz, 0.5);
	assert.match(exportedJson.data.results[0].standardValue, /0\.15 mm 线宽\/线距目标/);
	document.getElementById('outer-copper').value = '1';
	document.getElementById('outer-copper').dispatch('change');
	assert.equal(document.getElementById('report').children.length, 0);
	document.getElementById('run').click();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	jsonEqual(runInputs[1], { material: 'FR4', thickness: 1.6, outerCopperOz: 1, innerCopperOz: 1 });
	assert.ok(allText(document.getElementById('report')).includes('下单外层铜厚目标：1 oz'));
	assert.ok(allText(document.getElementById('report')).includes('0.10 mm 线宽/线距目标'));
	assert.ok(allText(document.getElementById('report')).includes('图层 1 与目标差异：要求 1 oz，图纸记录 0.5 oz'));
	document.getElementById('run').click();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(document.getElementById('report').children.length, 0);
	assert.match(document.getElementById('status').textContent, /mock read failure/);
	assert.equal(document.getElementById('export-json').disabled, true);
});

console.log(`${passed}/${passed} DFM command and menu cases passed`);
