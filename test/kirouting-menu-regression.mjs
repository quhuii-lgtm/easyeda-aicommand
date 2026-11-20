import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'src/menus/pcb-tools.ts'), 'utf8');
assert.match(source, /engine: 'kirouting'/);
assert.match(source, /pcb\.kiRoutingStart/);
assert.match(source, /pcb\.kiRoutingGetResult/);
assert.match(source, /pcb\.importKiRoutingResult/);
assert.match(source, /dryRun: false/);

const bundled = await build({
	stdin: {
		contents: `import { launchPcbToolsAction } from '../src/menus/pcb-tools.ts'; import { setProxyPort } from '../src/bridge/proxy-endpoint.ts'; export { launchPcbToolsAction, setProxyPort }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'kirouting-menu-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false,
	plugins: [{
		name: 'inject-owner-bridge',
		setup(build) {
			build.onResolve({ filter: /bridge\/client$/ }, () => ({ path: 'client', namespace: 'ki-menu-test' }));
			build.onResolve({ filter: /bridge\/proxy-endpoint(?:\.ts)?$/ }, () => ({ path: 'endpoint', namespace: 'ki-menu-test' }));
			build.onResolve({ filter: /bridge\/freerouting$/ }, () => ({ path: 'freerouting', namespace: 'ki-menu-test' }));
			build.onLoad({ filter: /.*/, namespace: 'ki-menu-test' }, args => ({ contents: args.path === 'client'
				? `export const getBridgeInstanceId=()=>globalThis.__kiMenu.instanceId;`
				: args.path === 'freerouting'
					? `export const frRequest=async()=>({status:'healthy'});`
					: `export const getProxyUrl=path=>globalThis.__kiMenu.proxyPort==null?null:\`http://127.0.0.1:\${globalThis.__kiMenu.proxyPort}\${path}\`; export const setProxyPort=port=>{globalThis.__kiMenu.proxyPort=port;};` }));
		},
	}],
});
globalThis.__kiMenu = { proxyPort: 49723, instanceId: 'ki-menu-test-instance' };
const { launchPcbToolsAction, setProxyPort } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
setProxyPort(49723);

let target = { documentType: 3, uuid: 'pcb-a', tabId: 'tab-a', parentProjectUuid: 'project-a' };
let runtimeReady = true;
const nativeBinding = () => ({ jobId: 'native-1', pcbUuid: target.uuid, projectUuid: target.parentProjectUuid });
let loseNextStartReply = false;
let startCount = 0;
let importCount = 0;
let installCount = 0;
let installStatus = 'running';
let nativeStopState = 'canceled';
let freeStopState = 'RUNNING';
const requests = [];
const dialogs = [];
const jobByOperation = new Map();
const routeTarget = () => ({ instanceId: globalThis.__kiMenu.instanceId, projectUuid: target.parentProjectUuid, documentUuid: target.uuid, tabId: target.tabId });
const ok = (cmd, data) => ({ ok: true, cmd, data });
globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => target },
	dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'project-a', data: [{ pcb: { uuid: target.uuid, name: target.uuid } }] }) },
	sys_ClientUrl: { request: async (_url, _method, body) => {
		const req = JSON.parse(body); requests.push(req);
		const params = req.params;
		let result;
		switch (req.cmd) {
		case 'pcb.listNets': result = ok(req.cmd, ['SIG1', 'SIG2', 'GND', '']); break;
		case 'pcb.nativeAutoRouteStart': result = ok(req.cmd, { binding: nativeBinding(), state: 'running' }); break;
		case 'pcb.nativeAutoRouteStatus': result = ok(req.cmd, { ...nativeBinding(), state: 'running', progress: 40 }); break;
		case 'pcb.nativeAutoRouteLog': result = ok(req.cmd, { ...nativeBinding(), count: 1, logs: ['running'] }); break;
		case 'pcb.nativeAutoRouteStop': result = ok(req.cmd, { ...nativeBinding(), state: nativeStopState, stopped: nativeStopState === 'canceled' }); break;
		case 'pcb.autoRouteStart': result = ok(req.cmd, { jobId: 'free-job-1', state: 'RUNNING' }); break;
		case 'pcb.autoRouteStop': result = ok(req.cmd, { jobId: params.jobId, state: freeStopState, cancelled: freeStopState === 'CANCELLED' }); break;
		case 'pcb.kiRoutingInfo': result = ok(req.cmd, runtimeReady
			? { runtimeReady: true, supportedModes: ['single', 'differential', 'length-match', 'fanout'], modeInputSchema: { single: { fields: [] }, differential: { fields: [{ key: 'pair', label: '差分对', source: 'differentialPairs', type: 'string', required: true }] }, 'length-match': { fields: [{ key: 'group', label: '等长组', source: 'lengthMatchGroups', type: 'string', required: true }] }, fanout: { fields: [{ key: 'component', label: '器件', source: 'components', type: 'string', required: true }] } } }
			: { runtimeReady: false, setupRequired: true, supportedModes: [], message: '需要准备本地 KiRouting 环境', python: { available: true } }); break;
		case 'pcb.exportKiRouting': result = ok(req.cmd, { choices: { differentialPairs: [{ name: 'USB_DP_DM', value: 'USB_DP_DM' }], lengthMatchGroups: [{ name: 'CLK', value: 'CLK' }], components: [{ designator: 'U1', value: 'U1' }] } }); break;
		case 'pcb.kiRoutingStart': {
			startCount++;
			const op = params.operationId;
			jobByOperation.set(op, 'ki-job-1');
			if (loseNextStartReply) { loseNextStartReply = false; throw new Error('reply lost after accepted submit'); }
			result = ok(req.cmd, { engine: 'kirouting', operationId: op, jobId: 'ki-job-1', target: routeTarget(), state: 'submitted', format: 'kirouting-json', inputCoverage: { complete: true } }); break;
		}
		case 'pcb.kiRoutingStatus': result = ok(req.cmd, params.kind === 'install'
			? { engine: 'kirouting', type: 'install', jobId: params.jobId, target: routeTarget(), state: installStatus }
			: { engine: 'kirouting', operationId: params.operationId, jobId: params.jobId ?? jobByOperation.get(params.operationId), target: routeTarget(), state: 'completed' }); break;
		case 'pcb.kiRoutingStop': result = ok(req.cmd, { engine: 'kirouting', operationId: params.operationId, jobId: params.jobId, target: routeTarget(), state: 'cancelled' }); break;
		case 'pcb.kiRoutingGetResult': result = ok(req.cmd, { engine: 'kirouting', operationId: params.operationId, jobId: params.jobId ?? jobByOperation.get(params.operationId), target: routeTarget(), state: 'completed', format: 'kirouting-json', result: { schemaVersion: 1, units: 'mil', lines: [{ net: 'N1', layer: 1, widthMil: 5, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [], coverage: { complete: true } } }); break;
		case 'pcb.importKiRoutingResult':
			if (params.dryRun === false) { importCount++; result = ok(req.cmd, { imported: true, operationId: params.operationId, jobId: 'ki-job-1', format: 'kirouting-json', convertedTransport: 'SES', sesGeometryVerified: true, persistence: 'not-verified' }); }
			else result = ok(req.cmd, { dryRun: true, preview: { counts: { lines: 1, vias: 0 }, ruleStatus: 'complete', existingCopperPreserved: true } });
			break;
		case 'pcb.kiRoutingInstall': installCount++; result = ok(req.cmd, { engine: 'kirouting', type: 'install', installJob: { jobId: 'install-1', state: 'submitted' } }); break;
		case 'pcb.kiRoutingList': result = ok(req.cmd, { target: routeTarget(), jobs: [...jobByOperation].map(([operationId, jobId]) => ({ operationId, jobId, state: 'completed', target: { ...routeTarget(), documentUuid: 'pcb-a', tabId: 'tab-a' } })) }); break;
		default: throw new Error(`unexpected command ${req.cmd}`);
		}
		return { ok: true, status: 200, text: async () => JSON.stringify(result) };
	} },
	sys_Dialog: {
		showConfirmationMessage: (...args) => dialogs.push({ kind: 'confirm', args }),
		showInputDialog: (...args) => dialogs.push({ kind: 'input', args }),
		showSelectDialog: (...args) => dialogs.push({ kind: 'select', args }),
		showInformationMessage: (...args) => dialogs.push({ kind: 'info', args }),
	},
	sys_Window: { open: () => assert.fail('KiRouting setup must not open a browser') },
};

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const latest = kind => [...dialogs].reverse().find(item => item.kind === kind);
const invoke = async action => { launchPcbToolsAction(action); await settle(); };
const chooseSelect = async (predicate, value) => { const item = latest('select'); assert.ok(item, 'select dialog shown'); assert.ok(predicate(item.args[3]), `unexpected select dialog ${item.args[3]}`); item.args[6](value); await settle(); };
const chooseConfirm = async (predicate, accepted) => { const item = latest('confirm'); assert.ok(item, 'confirmation dialog shown'); assert.ok(predicate(item.args[1]), `unexpected confirmation ${item.args[1]}`); item.args[4](accepted); await settle(); };

// The engine is chosen per new route. KiRouting modes come from info and their input choices from the real-input export command.
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'kirouting');
await chooseSelect(title => title === '选择 KiRouting 模式', 'differential');
await chooseSelect(title => title === '差分对', 'USB_DP_DM');
assert.equal(startCount, 1);
const startRequest = requests.find(req => req.cmd === 'pcb.kiRoutingStart');
assert.equal(startRequest.params.settings.mode, 'differential');
assert.equal(startRequest.params.settings.pair, 'USB_DP_DM');
assert.equal(startRequest.params.settings.keep_input_copper, true);
assert.equal(startRequest.params.__projectUuid, 'project-a');

// Engine-bound status/fetch/import preserve JSON semantics; import always previews then requires an explicit confirmation.
await invoke('route-status');
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingStatus' && req.params.operationId === startRequest.params.operationId));
await invoke('route-fetch');
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingGetResult'));
assert.equal(latest('info').args[1], 'KiRouting 结果已取回');
await invoke('route-import');
assert.equal(importCount, 0, 'preview alone never writes');
assert.ok(requests.some(req => req.cmd === 'pcb.importKiRoutingResult' && req.params.dryRun === true));
await chooseConfirm(title => title === '显式导入 KiRouting 结果', true);
assert.equal(importCount, 1, 'explicit confirmation is followed by dryRun:false exactly once');
assert.ok(requests.some(req => req.cmd === 'pcb.importKiRoutingResult' && req.params.dryRun === false));

// The KiRouting start marker is saved before the call; after a lost reply status uses that same operationId and never starts again.
loseNextStartReply = true;
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'kirouting');
await chooseSelect(title => title === '选择 KiRouting 模式', 'single');
const lostStart = requests.filter(req => req.cmd === 'pcb.kiRoutingStart').at(-1);
await invoke('route-status');
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingStatus' && req.params.operationId === lostStart.params.operationId));
assert.equal(requests.filter(req => req.cmd === 'pcb.kiRoutingStart').length, 2, 'status recovery does not duplicate start');
await invoke('route-stop');
await chooseConfirm(title => title === '停止 KiRouting 自动布线', true);
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingStop' && req.params.operationId === lostStart.params.operationId));
assert.ok(!requests.some(req => req.cmd === 'pcb.autoRouteStop'), 'KiRouting jobs never enter the FreeRouting stop path');

// Runtime setup is explicit. Install sends confirmed:true, and completion is only reported after runtimeReady is read back.
runtimeReady = false;
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'kirouting');
await chooseConfirm(title => title === '配置 KiRouting 运行环境', true);
assert.equal(installCount, 1);
assert.equal(requests.find(req => req.cmd === 'pcb.kiRoutingInstall').params.confirmed, true);
await invoke('route-status');
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingStatus' && req.params.kind === 'install'));
installStatus = 'completed';
runtimeReady = true;
await invoke('route-status');
assert.ok(requests.filter(req => req.cmd === 'pcb.kiRoutingInfo').length >= 2, 'runtime status is rechecked after install completion');

// A changed target cannot consume the cached board-A session or write its result into board B.
target = { documentType: 3, uuid: 'pcb-b', tabId: 'tab-b', parentProjectUuid: 'project-a' };
await invoke('route-import');
await chooseSelect(title => title === '选择要查询的布线引擎', 'kirouting');
assert.equal(importCount, 1, 'target switch prevents importing the prior target result');
assert.ok(!requests.some(req => req.cmd === 'pcb.importKiRoutingResult' && req.params.dryRun === false && req.params.__docUuid === 'pcb-b'));

console.log('PASS KiRouting menu binds the engine and target, recovers lost starts, and requires explicit import confirmation');


// The new default selects the native menu flow, then requires an explicit network selection.
target = { documentType: 3, uuid: 'pcb-native', tabId: 'tab-native', parentProjectUuid: 'project-a' };
const nativeStart = () => requests.filter(req => req.cmd === 'pcb.nativeAutoRouteStart');
await invoke('route-start');
const picker = latest('select');
assert.deepEqual(picker.args[0].map(option => option.value), ['native', 'freerouting', 'kirouting']);
assert.equal(picker.args[4], 'native');
await chooseSelect(title => title === '选择布线引擎', picker.args[4]);
assert.equal(latest('select').args[5], true);
assert.deepEqual(latest('select').args[4], []);
await chooseSelect(title => title === '选择原生布线网络', []);
assert.equal(nativeStart().length, 0, 'empty selection does not start routing');

await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'native');
await chooseSelect(title => title === '选择原生布线网络', ['SIG1', 'SIG2']);
assert.deepEqual(nativeStart().at(-1).params, { RoutingNets: ['SIG1', 'SIG2'], existingPrimitiveMode: 'keep', __projectUuid: 'project-a', __docUuid: 'pcb-native', __tabId: 'tab-native' });
await invoke('route-status');
await invoke('route-fetch');
await invoke('route-import');
assert.equal(latest('info').args[1], '原生布线结果');
await invoke('route-stop');
await chooseConfirm(title => title === '停止原生布线', true);
for (const action of ['Status', 'Log', 'Stop']) {
	const req = requests.find(item => item.cmd === 'pcb.nativeAutoRoute' + action);
	assert.ok(req);
	assert.equal(req.params.jobId, 'native-1');
	assert.equal(req.params.pcbUuid, 'pcb-native');
	assert.equal(req.params.__tabId, 'tab-native');
}
assert.equal(importCount, 1, 'native output never enters external import');

await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'native');
target = { ...target, uuid: 'pcb-other', tabId: 'tab-other' };
await chooseSelect(title => title === '选择原生布线网络', ['SIG1']);
assert.equal(nativeStart().length, 1, 'changing board during the network picker does not start routing');
console.log('PASS native default, explicit network selection, target binding, and native task lifecycle');


// Only a confirmed finish permits an engine switch, including native's single-l "canceled".
target = { documentType: 3, uuid: 'pcb-native', tabId: 'tab-native', parentProjectUuid: 'project-a' };
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'kirouting');
await chooseSelect(title => title === '选择 KiRouting 模式', 'single');
assert.ok(requests.some(req => req.cmd === 'pcb.kiRoutingStart' && req.params.__docUuid === 'pcb-native'));

target = { ...target, uuid: 'pcb-stop', tabId: 'tab-stop' };
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'native');
await chooseSelect(title => title === '选择原生布线网络', ['SIG1']);
nativeStopState = 'running';
await invoke('route-stop');
await chooseConfirm(title => title === '停止原生布线', true);
let externalStarts = requests.filter(req => req.cmd === 'pcb.autoRouteStart').length;
let dialogCount = dialogs.length;
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'freerouting');
assert.equal(requests.filter(req => req.cmd === 'pcb.autoRouteStart').length, externalStarts);
assert.ok(!dialogs.slice(dialogCount).some(item => item.kind === 'input'), 'accepted but still running must not offer start');
nativeStopState = 'unknown';
await invoke('route-stop');
await chooseConfirm(title => title === '停止原生布线', true);
dialogCount = dialogs.length;
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'freerouting');
assert.ok(!dialogs.slice(dialogCount).some(item => item.kind === 'input'), 'unknown stop must not offer start');
nativeStopState = 'canceled';
await invoke('route-stop');
await chooseConfirm(title => title === '停止原生布线', true);
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'freerouting');
assert.equal(latest('input').args[2], '启动自动布线');
latest('input').args[6]('50');
await settle();
assert.equal(requests.filter(req => req.cmd === 'pcb.autoRouteStart').length, externalStarts + 1);
freeStopState = 'CANCELLED';
await invoke('route-stop');
await chooseConfirm(title => title === '停止自动布线', true);
await invoke('route-start');
await chooseSelect(title => title === '选择布线引擎', 'native');
await chooseSelect(title => title === '选择原生布线网络', ['SIG2']);
assert.equal(nativeStart().at(-1).params.__docUuid, 'pcb-stop', 'confirmed FreeRouting stop updates the menu session');
console.log('PASS confirmed cancellations permit switching; running and unknown results retain the task');
