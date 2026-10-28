import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: 'import { pcbCommands } from \'../src/commands/pcb.ts\'; export { pcbCommands }',
			resolveDir: resolve(root, 'test'),
			sourcefile: 'auto-route-start-outcome-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { pcbCommands } = await import(moduleUrl);
const actualWidthFixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/routing-width-real-host.json'), 'utf8'));
const actualWidthSource = `{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"pcb-A","client":"fixture"}|\n${actualWidthFixture.source}`;
	const start = pcbCommands.find(command => command.name === 'pcb.autoRouteStart');
	const slotSource = [
		'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"pcb-A","client":"one"}|',
		'{"type":"CANVAS","id":"CANVAS"}||{"unit":"mil"}|',
		'{"type":"RULE","id":"[\\"RULE\\",\\"SAFE\\",\\"copperThickness1oz\\"]","ticket":1}||{"ruleState":"DEFAULT","ruleContext":{"unit":"mil","isForAll":"ALL"}}|',
		'{"type":"PAD_NET","id":"padnet1","ticket":2}||{"padNet":"+5V"}|',
		'{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET\\",\\"+5V\\"]]","ticket":3}||{"ruleOrder":4,"ruleKeyValue":{},"copperValue":{},"innerPlaneValue":{},"parent":null}|',
		'{"type":"FILL","id":"slot1","ticket":4}||{"layerId":12,"netName":"","path":[["R",690,200,135,45,0,0]]}|',
	].join('\n');
	const slotDsn = `(pcb demo (parser) (resolution mil 1000) (unit mil)
	 (structure (boundary (path signal 0 0 0 0 1000 0 1000 1000 0 1000 0 0))
	  (layer TopLayer (type signal)) (layer Inner1 (type signal)) (layer Inner2 (type signal)) (layer BottomLayer (type signal)))
	 (placement (component u1 (place u1 0 0 front 0)))
	 (library (image u1 (pin ps-slot slot1 757.5 177.5))
	  (padstack ps-slot
	   (shape (polygon TopLayer 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
	   (shape (polygon Inner1 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
	   (shape (polygon Inner2 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
	   (shape (polygon BottomLayer 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))))
	 (network (net +5V (pins))))`;
	const slotDsnWithClass = slotDsn.replace('(structure', '(structure (rule (width 20))').replace('(network (net +5V (pins)))', '(network (net +5V (pins)) (class +5V "+5V" (rule (width 20))))');
	const strictDefaultTrack = '{"type":"NET","id":"[\\\"NET\\\",\\\"+5V\\\"]","ticket":5}||{"netType":null}|\n{"type":"RULE","id":"[\\\"RULE\\\",\\\"TRACK\\\",\\\"default\\\"]","ticket":6}||{"ruleState":"DEFAULT","ruleContext":{"unit":"mil","track":{"isOpen":true,"content":[{"layerId":1,"stroMin":10,"stroDef":20,"stroMax":30},{"layerId":15,"stroMin":10,"stroDef":30,"stroMax":40},{"layerId":16,"stroMin":10,"stroDef":20,"stroMax":30},{"layerId":2,"stroMin":10,"stroDef":20,"stroMax":30}]}}}|';
	function install({ startFailure = undefined, startState = 'READY_TO_START', missingSnapshot = false, slotCase = false, widthRuleCase = false, finalSnapshotChange = false, finalSnapshotReadFailure = false, focusChangeAfterSlot = false } = {}) {
		const calls = [];
		const edaCalls = [];
		let jobState = startState;
		let sourceReadIndex = 0;
		const getDocumentSource = () => {
			if (widthRuleCase && !slotCase) return actualWidthSource;
			sourceReadIndex++
			if (finalSnapshotReadFailure && sourceReadIndex >= 8) throw new Error('snapshot read failure')
			const head = `{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'PCB', client: `client-${sourceReadIndex}`, uuid: 'pcb-A', updateTime: sourceReadIndex, version: String(sourceReadIndex) })}|`
			const source = slotCase ? slotSource.replace(/^\{"type":"DOCHEAD"\}[^\n]*/u, head) : head
			if (widthRuleCase && slotCase) return `${source}\n${strictDefaultTrack}`
			return finalSnapshotChange && sourceReadIndex >= 8
				? `${source}\n{"type":"FILL","id":"new-slot","ticket":3}||{"layerId":12,"netName":"","path":[["R",1,2,3,4,0,0]]}|`
				: source
		}
		const dsnFile = new Blob([widthRuleCase ? slotCase ? slotDsnWithClass : actualWidthFixture.dsn : slotCase ? slotDsn : 'dsn']);
		Object.defineProperty(dsnFile, 'name', { value: 'design.dsn' });
			let focusReads = 0
		const defaultNetRule = {
			type: 'net',
			name: '+5V',
			'Safe Spacing': 'default',
			'Copper Safe Spacing': null,
			'Plane Safe Spacing': null,
			Track: 'default',
			'Net Length Range': 'default',
			'Net Length Tolerance': null,
			'Blind/Buried Via': 'default',
			'Via Size': 'default',
			'Plane Zone': 'default',
			'Copper Zone': 'default',
			'Solder Mask Expansion': 'default',
			'Paste Mask Expansion': 'default',
			'Creepage Distance': null,
			targetNet: null,
		};
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { edaCalls.push('getCurrentDocumentInfo'); focusReads++; return focusChangeAfterSlot && sourceReadIndex >= 8 ? { documentType: 3, uuid: 'pcb-B' } : { documentType: 3, uuid: 'pcb-A' } } },
			sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
			pcb_Layer: { getAllLayers: async () => widthRuleCase && slotCase ? [
				{ id: 1, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 },
				{ id: 15, name: 'Inner Layer 1', type: 'SIGNAL', layerStatus: 1 },
				{ id: 16, name: 'Inner Layer 2', type: 'SIGNAL', layerStatus: 1 },
				{ id: 2, name: 'Bottom Layer', type: 'SIGNAL', layerStatus: 1 },
			] : widthRuleCase ? [{ id: 1, name: 'TopLayer', type: 'SIGNAL', layerStatus: 1 }] : [] },
			pcb_PrimitivePour: { getAll: async () => [] },
			pcb_PrimitivePoured: { getAll: async () => [] },
			pcb_Drc: {
				getCurrentRuleConfiguration: async () => ({
					config: {
						Spacing: {
							'Safe Spacing': {
								copperThickness1oz: {
									isSetDefault: true,
									unit: 'mil',
									row: ['Slot Region', 'Track'],
									column: ['Track'],
									status: 0,
									tables: { '1': { status: 1, content: [[11.811], [6]] } },
								},
							},
						},
					},
				}),
				getNetRules: async () => [defaultNetRule],
			},
			pcb_ManufactureData: { getDsnFile: async () => { edaCalls.push('getDsnFile'); return dsnFile } },
			sys_ClientUrl: {
				request: async (url, method, body) => {
					calls.push({ url, method, body });
					if (startFailure === 'transport' && method === 'PUT' && url.endsWith('/jobs/job-A/start'))
						throw new Error('connection reset after request dispatch');
					if (startFailure === 'http' && method === 'PUT' && url.endsWith('/jobs/job-A/start')) {
						return { ok: false, status: 500, text: async () => 'start refused' };
					}
					if (method === 'PUT' && url.endsWith('/jobs/job-A/cancel'))
						jobState = 'CANCELLED';
					return {
						ok: true,
						status: 200,
						json: async () => {
							if (url.endsWith('/sessions/create'))
								return { id: 'session-A' };
							if (url.endsWith('/jobs/enqueue'))
								return { id: 'job-A' };
							if (url.endsWith('/jobs/job-A/start'))
								return { state: startState };
							if (url.endsWith('/jobs/job-A'))
								return { state: jobState, stage: 'queued', current_pass: 0 };
							return {};
						},
					};
				},
			},
		};
		if (!missingSnapshot)
			globalThis.eda.sys_FileManager = { getDocumentSource: async () => { edaCalls.push('getDocumentSource'); return getDocumentSource() } };
		return { calls, edaCalls };
	}

	const status = pcbCommands.find(command => command.name === 'pcb.autoRouteStatus');
	const stop = pcbCommands.find(command => command.name === 'pcb.autoRouteStop');
	const invalidCalls = install();
	for (const automaticNeckdown of [null, 'true', 1])
		await assert.rejects(() => start.handler({ automaticNeckdown }, {}), /automaticNeckdown 必须是布尔值/);
	for (const skipDrc of [null, 'false', 1])
		await assert.rejects(() => start.handler({ skipDrc }, {}), /skipDrc 必须是布尔值/);
	for (const noImport of [null, 'true', 0])
		await assert.rejects(() => status.handler({ noImport }, {}), /noImport 必须是布尔值/);
	assert.deepEqual(invalidCalls, { calls: [], edaCalls: [] }, 'invalid flags must be rejected before EDA or HTTP calls');
	for (const startFailure of ['http', 'transport']) {
		const { calls: failedCalls } = install({ startFailure });
		const error = await start.handler({}, {}).catch(reason => reason);
		assert.ok(error instanceof Error);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		assert.equal(error.cause?.jobId, 'job-A');
		assert.equal(error.cause?.outcome, 'start-request-unknown');
		assert.match(error.message, /结果未知/);
		assert.equal(failedCalls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/start')).length, 1);

		const beforeDuplicate = failedCalls.length;
		await assert.rejects(() => start.handler({}, {}), /已有布线任务/);
		const duplicateCalls = failedCalls.slice(beforeDuplicate);
		assert.equal(duplicateCalls.length, 1, 'a duplicate start may make one read-only status check for the previous job');
		assert.equal(duplicateCalls[0].method, 'GET', 'the duplicate guard performs only a status read');
		assert.ok(duplicateCalls[0].url.endsWith('/jobs/job-A'), 'the duplicate guard reads the occupied job');
		assert.equal(duplicateCalls.filter(call => call.method !== 'GET').length, 0, 'unknown start outcome must not cause another write');
		assert.equal(failedCalls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/start')).length, 1, 'do not retry the uncertain start request');

		const observed = await status.handler({ noImport: true }, {});
		assert.equal(observed.jobId, 'job-A');
		assert.equal(observed.state, 'READY_TO_START');
		const cancelled = await stop.handler({}, {});
		assert.deepEqual(cancelled, { cancelled: true, jobId: 'job-A', state: 'CANCELLED' });
		assert.equal(failedCalls.some(call => call.method === 'GET' && call.url.endsWith('/jobs/job-A')), true);
		assert.equal(failedCalls.some(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/cancel')), true);
	}

	const { calls } = install({ startState: 'READY_TO_START' });
	const result = await start.handler({ skipDrc: true }, {});
	assert.equal(result.jobId, 'job-A');
	assert.equal(result.outcome, 'start-request-submitted');
	assert.deepEqual(result.routingSettings, { automaticNeckdown: false, readbackVerified: false }, 'the default neckdown setting is reported as submitted, not readback verified');
	const defaultSettingsCall = calls.find(call => call.method === 'POST' && call.url.endsWith('/jobs/job-A/settings'));
	assert.equal(JSON.parse(defaultSettingsCall.body).automatic_neckdown, false, 'automatic neckdown defaults to false in the submitted FreeRouting settings');
	assert.equal(result.stateVerified, false);
	assert.equal(Object.hasOwn(result, 'state'), false);
	assert.doesNotMatch(JSON.stringify(result), /RUNNING/);
	assert.match(result.note, /查询任务实际状态/);
	assert.match(result.note, /不要重复提交/);
	assert.match(result.note, /状态查询只读/);
	assert.match(result.note, /pcb\.importAutoRouteSes 导入/);
	assert.doesNotMatch(result.note, /清除未锁定铜层走线|自动回灌/);
	assert.equal(calls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/start')).length, 1);
	await stop.handler({}, {});
	const { calls: explicitTrueCalls } = install();
	const explicitTrueResult = await start.handler({ automaticNeckdown: true }, {});
	assert.deepEqual(explicitTrueResult.routingSettings, { automaticNeckdown: true, readbackVerified: false }, 'an explicit true value is reported as submitted, not readback verified');
	const explicitTrueSettingsCall = explicitTrueCalls.find(call => call.method === 'POST' && call.url.endsWith('/jobs/job-A/settings'));
	assert.equal(JSON.parse(explicitTrueSettingsCall.body).automatic_neckdown, true, 'an explicit true value is sent to FreeRouting');
	await stop.handler({}, {});
	const { calls: mismatchCalls } = install({ widthRuleCase: true });
	const mismatchStart = await start.handler({}, {});
	assert.equal(mismatchStart.widthRuleComparison.status, 'mismatch', `autoRouteStart exposes a DSN width mismatch against known EDA limits: ${JSON.stringify(mismatchStart.widthRuleComparison)}`);
	assert.equal(mismatchStart.widthRuleComparison.defaultRule.status, 'mismatch');
	assert.equal(mismatchCalls.some(call => call.url.endsWith('/sessions/create')), true, 'a DSN width difference is reported without rewriting or blocking the routing request');
	await stop.handler({}, {});
	const { calls: missingSnapshotCalls } = install({ missingSnapshot: true });
	const unaugmented = await start.handler({}, {});
	assert.equal(unaugmented.outcome, 'start-request-submitted');
	assert.ok(unaugmented.dsnConversion.warnings.some(warning => warning.includes('getDocumentSource')));
	assert.ok(unaugmented.dsnConversion.limitations.some(item => item.includes('源码快照不可用')));
	assert.equal(missingSnapshotCalls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/start')).length, 1, 'missing snapshot support submits the original DSN with diagnostics');
	await stop.handler({}, {});
	const { calls: slotCalls } = install({ slotCase: true });
	const slotStart = await start.handler({}, {});
	assert.deepEqual(slotStart.dsnConversion.slotClearance?.appliedSlotIds, ['slot1'], 'pcb.autoRouteStart applies the same verified slot stage');
	const routeInput = slotCalls.find(call => call.method === 'POST' && call.url.endsWith('/jobs/job-A/input'));
	assert.ok(routeInput, 'autoRouteStart submitted prepared DSN input');
	assert.match(Buffer.from(JSON.parse(routeInput.body).data, 'base64').toString('utf8'), /clearance_class aceslotslot1/);
	await stop.handler({}, {});
	const { calls: layerAndSlotCalls } = install({ slotCase: true, widthRuleCase: true });
	const layerAndSlotStart = await start.handler({ applyLayerWidthRules: true }, {});
	assert.deepEqual(layerAndSlotStart.dsnConversion.slotClearance?.appliedSlotIds, ['slot1'], 'layer-width conversion retains slot-clearance diagnostics');
	assert.ok(layerAndSlotStart.dsnConversion.changes.some(change => change.kind === 'layer-width' && change.layerId === 15 && change.toWidthMil === 30), 'strict DEFAULT multilayer evidence produces a class layer-width change');
	assert.ok(layerAndSlotStart.dsnConversion.limitations.some(item => item.includes('槽孔')), 'layer-width conversion retains slot limitations');
	const layerAndSlotInput = layerAndSlotCalls.find(call => call.method === 'POST' && call.url.endsWith('/jobs/job-A/input'));
	assert.ok(layerAndSlotInput, 'layer-width conversion submits the merged prepared DSN');
	const layerAndSlotSubmitted = Buffer.from(JSON.parse(layerAndSlotInput.body).data, 'base64').toString('utf8');
	assert.match(layerAndSlotSubmitted, /clearance_class aceslotslot1/, 'the same submitted DSN retains the prepared slot clearance');
	assert.match(layerAndSlotSubmitted, /\(layer_rule Inner1 \(rule \(width 30\)\)\)/, 'submitted DSN retains slot prep and includes the confirmed class layer rule');
	assert.match(layerAndSlotSubmitted, /\(layer Inner1 \(type signal\) \(rule \(width 30\)\)\)/, 'the same submitted DSN includes the confirmed structure default layer rule');
	await stop.handler({}, {});
	const changedSlotSnapshot = install({ slotCase: true, finalSnapshotChange: true });
	await assert.rejects(() => start.handler({}, {}), /槽孔准备期间 PCB 源码快照已变化/);
	assert.equal(changedSlotSnapshot.calls.some(call => call.url.endsWith('/sessions/create') || call.url.endsWith('/jobs/enqueue')), false, 'a substantive final snapshot change must reject submission');
	const missingFinalSlotSnapshot = install({ slotCase: true, finalSnapshotReadFailure: true });
	const originalAfterUnknownFinal = await start.handler({}, {});
	assert.equal(originalAfterUnknownFinal.outcome, 'start-request-submitted');
	assert.ok(originalAfterUnknownFinal.dsnConversion.warnings.some(warning => warning.includes('槽孔准备后无法复核源码快照')));
	assert.ok(originalAfterUnknownFinal.dsnConversion.limitations.some(item => item.includes('不提交平面或槽孔增强 DSN')));
	const unknownFinalInput = missingFinalSlotSnapshot.calls.find(call => call.url.endsWith('/jobs/job-A/input'));
	assert.ok(unknownFinalInput, 'snapshot read failure falls back to original DSN and still submits with diagnostics');
	assert.doesNotMatch(Buffer.from(JSON.parse(unknownFinalInput.body).data, 'base64').toString('utf8'), /clearance_class aceslotslot1/);
	await stop.handler({}, {});
	const changedSlotFocus = install({ slotCase: true, focusChangeAfterSlot: true });
	await assert.rejects(() => start.handler({}, {}), /槽孔准备期间 PCB 焦点已变化/);
	assert.equal(changedSlotFocus.calls.some(call => call.url.endsWith('/sessions/create') || call.url.endsWith('/jobs/enqueue')), false, 'a final focus mismatch must reject submission even after helper fallback');
	console.log('PASS autoRouteStart reports submission without claiming RUNNING and rejects API failure');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});


