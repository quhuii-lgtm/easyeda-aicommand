import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'extension.json'), 'utf8'));
const menus = manifest.headerMenus;
assert.deepEqual(menus.pcb.map(item => item.id), ['aiCommandPcb'], 'PCB tools share one PCB-specific top-level menu');
const [pcbMenu] = menus.pcb;
const general = ['about', 'listCommands', 'connectBridge', 'disconnectBridge', 'reconnectBridge', 'openSmtQuery'];
const shared = [...general, 'openModuleTools'];
for (const context of ['home', 'sch']) {
	assert.deepEqual(menus[context].map(item => item.id), ['aiCommand']);
	assert.equal(menus[context][0].title, pcbMenu.title);
	assert.deepEqual(menus[context][0].menuItems.map(item => item.registerFn), shared);
}
assert.deepEqual(pcbMenu.menuItems.map(item => item.registerFn), [
	...shared,
	'pcbDfmMenu',
	'smtDfmMenu',
	'padSpacingMenu',
	'pcbGroupBySchematicRegionsMenu',
	'pcbAutoRouteStartMenu',
	'pcbAutoRouteStatusMenu',
	'pcbAutoRouteStopMenu',
	'pcbAutoRouteFetchMenu',
	'pcbAutoRouteImportMenu',
]);
assert.equal(new Set(pcbMenu.menuItems.map(item => item.id)).size, pcbMenu.menuItems.length);
assert.equal(menus.home.length + menus.sch.length + menus.pcb.length, 3, 'module reuse stays inside the existing top-level menus');

const source = readFileSync(resolve(root, 'src/menus/pcb-tools.ts'), 'utf8');
assert.match(source, /eda\.sys_ClientUrl\.request\(url, 'POST'/, 'menu commands use EDA HTTP API transport');
assert.match(source, /instanceId, cmd, params: menuParams\(target, params\)/, 'commands use explicit connected instance routing');
assert.match(source, /__docUuid: target\.uuid, __tabId: target\.tabId/, 'commands bind both document and tab identity');
assert.match(source, /pcb\.autoRouteGetResult/);
assert.match(source, /pcb\.importAutoRouteSes/);
assert.match(source, /routeBaseline \? \{ routeBaseline: ses\.routeBaseline \} : \{\}/, 'optional route baseline is passed only when returned');
assert.match(source, /uncertainBoards\.has\(keyOf\(target\)\)/, 'unknown import writes block repeated import');
assert.match(source, /expectedMenuPlan: JSON\.stringify\(plan\)/, 'menu carries an exact preview signature into the guarded write');

console.log('PASS PCB helper menu is PCB-only, routes commands through the owner instance, and keeps SES import explicit and guarded');

const bundled = await build({
	stdin: {
		contents: `import { launchPcbToolsAction } from '../src/menus/pcb-tools.ts'; import { setProxyPort } from '../src/bridge/proxy-endpoint.ts'; export { launchPcbToolsAction, setProxyPort }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-manual-menu-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false,
	plugins: [{
		name: 'inject-route-owner',
		setup(build) {
			build.onResolve({ filter: /bridge\/client$/ }, () => ({ path: 'route-client', namespace: 'route-test' }));
			build.onResolve({ filter: /bridge\/proxy-endpoint(?:\.ts)?$/ }, () => ({ path: 'route-proxy-endpoint', namespace: 'route-test' }));
			build.onLoad({ filter: /.*/, namespace: 'route-test' }, args => ({ contents: args.path === 'route-client'
				? `export const getBridgeInstanceId=()=>globalThis.__pcbRouteTest.instanceId;`
				: `export const getProxyUrl=path=>globalThis.__pcbRouteTest.proxyPort==null?null:\`http://127.0.0.1:\${globalThis.__pcbRouteTest.proxyPort}\${path}\`; export const setProxyPort=port=>{globalThis.__pcbRouteTest.proxyPort=port;};` }));
		},
	}],
});
globalThis.__pcbRouteTest = { proxyPort: 49721, instanceId: 'route-test-instance' };
const { launchPcbToolsAction, setProxyPort } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
setProxyPort(49721);
const dialogs = [], requests = [], opened = [];
let status;
let loseStartReply = false;
let acceptedStart = false;
let startReplyMode = 'success';
let acceptedStartCount = 0;
let routeStatusState = 'RUNNING';
const acceptedOperations = new Map();
const startReplyModesServed = [];
globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb', tabId: 'tab' }) },
	dmt_Project: { getCurrentProjectInfo: async () => ({}) },
	sys_ClientUrl: { request: async (url, method, body) => {
		requests.push({ url, method, body });
		if (url.endsWith('/system/status')) {
			if (!status) throw new Error('connection refused');
			return { ok: true, status: 200, json: async () => ({ status }) };
		}
		if (url.endsWith('/command')) {
			const request = JSON.parse(body);
			if (request.cmd === 'pcb.autoRouteStart') {
				acceptedStart = true;
				acceptedStartCount++;
				const operationId = request.params.__routeOperationId;
				const jobId = `job-${acceptedStartCount}`;
				if (startReplyMode !== 'business-preflight') acceptedOperations.set(operationId, jobId);
				if (loseStartReply) throw new Error('HTTP response lost after server accepted start');
				if (startReplyMode === 'heartbeat-fuse' || startReplyMode === 'client-watchdog') {
					startReplyModesServed.push(startReplyMode);
					return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, cmd: request.cmd, error: { message: startReplyMode, cause: { partial: true, source: startReplyMode === 'heartbeat-fuse' ? 'heartbeat-fuse' : 'client-watchdog' } } }) };
				}
				if (startReplyMode === 'business-preflight') {
					startReplyModesServed.push(startReplyMode);
					return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, cmd: request.cmd, error: { message: 'route preflight rejected', cause: { partial: false, outcome: 'not_started' } } }) };
				}
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId, dsnConversion: {}, routingConstraintsComplete: false } }) };
			}
			if (request.cmd === 'pcb.autoRouteStatus') {
				const jobId = request.params.jobId ?? acceptedOperations.get(request.params.__routeOperationId) ?? 'job-recovered';
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId, state: routeStatusState } }) };
			}
			if (request.cmd === 'pcb.autoRouteStop')
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId: request.params.jobId, state: 'CANCELLED', cancelled: true } }) };
		}
		throw new Error(`unexpected request ${method} ${url}`);
	} },
	sys_Dialog: {
		showConfirmationMessage: (...args) => dialogs.push(args),
		showInputDialog: (...args) => dialogs.push(args),
		showInformationMessage: (...args) => dialogs.push(args),
	},
	sys_Window: { open: url => opened.push(url) },
};
async function settleAction() {
	for (let index = 0; index < 5; index++)
		await new Promise(resolve => setImmediate(resolve));
}
async function start() {
	launchPcbToolsAction('route-start');
	await settleAction();
	return dialogs.pop();
}
const ai = await start();
assert.deepEqual(ai.slice(2, 4), ['AI 协助安装', '手动安装']);
ai[4](true);
assert.match(dialogs.pop()[4], /请按 AI Command Engine 的 PCB 指南/);
assert.deepEqual(opened, []);

const manual = await start();
manual[4](false);
dialogs.pop()[4](false);
assert.deepEqual(opened, []);
manual[4](false);
dialogs.pop()[4](true);
assert.match(opened[0], /^https:\/\/github\.com\/easyeda\/eext-freerouting-intergration/);

status = 'OK';
const ready = await start();
assert.equal(ready[2], '启动自动布线');
ready.at(-1)(undefined);
await new Promise(resolve => setImmediate(resolve));
assert.ok(requests.every(({url, method}) => url === 'http://127.0.0.1:37864/v1/system/status' && method === 'GET'));
loseStartReply = true;
const submit = await start();
submit.at(-1)('50');
await new Promise(resolve => setImmediate(resolve));
assert.equal(acceptedStart, true, `the mocked backend accepted the first start before its HTTP response was lost; submit=${JSON.stringify(submit.slice(0, 4))}, requests=${JSON.stringify(requests.map(item => ({ url: item.url, method: item.method, ...(item.body ? { cmd: JSON.parse(item.body).cmd } : {}) })))}, dialogs=${JSON.stringify(dialogs.map(item => item.slice(0, 3)))}`);
assert.equal(requests.filter(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === 'pcb.autoRouteStart').length, 1, 'lost response must not cause a repeated start');
const statusCallIndex = requests.length;
launchPcbToolsAction('route-status');
await new Promise(resolve => setImmediate(resolve));
const recoveredStatusCall = requests.slice(statusCallIndex).find(item => item.url.endsWith('/command'));
assert.ok(recoveredStatusCall, 'status must query the backend after a lost start response');
const recoveredStatusRequest = JSON.parse(recoveredStatusCall.body);
assert.equal(recoveredStatusRequest.cmd, 'pcb.autoRouteStatus');
assert.equal(recoveredStatusRequest.params.jobId, undefined, 'status recovery must not require the lost cached jobId');
assert.equal(recoveredStatusRequest.params.__docUuid, 'pcb');
assert.equal(recoveredStatusRequest.params.__tabId, 'tab');
assert.ok(recoveredStatusRequest.params.__routeOperationId, 'status recovery carries the original operation identity');
const stopStartCount = requests.filter(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === 'pcb.autoRouteStart').length;
launchPcbToolsAction('route-stop');
await new Promise(resolve => setImmediate(resolve));
const stopDialog = dialogs.pop();
assert.equal(stopDialog[1], '停止自动布线');
stopDialog[4](true);
await new Promise(resolve => setImmediate(resolve));
const stopRequest = requests.filter(item => item.url.endsWith('/command')).map(item => JSON.parse(item.body)).find(item => item.cmd === 'pcb.autoRouteStop');
assert.ok(stopRequest, 'stop is available after status recovered the lost jobId');
assert.equal(stopRequest.params.jobId, 'job-1');
assert.equal(stopRequest.params.__routeOperationId, recoveredStatusRequest.params.__routeOperationId, 'stop must stay bound to the original operation');
assert.equal(requests.filter(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === 'pcb.autoRouteStart').length, stopStartCount, 'status/stop recovery must not re-submit start');
loseStartReply = false;

const commandRequests = cmd => requests.filter(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === cmd);
const currentStarts = () => commandRequests('pcb.autoRouteStart').length;
async function submitStart(mode = 'success') {
	startReplyMode = mode;
	dialogs.length = 0;
	const prompt = await start();
	assert.equal(prompt?.[2], '启动自动布线', `expected a start prompt for ${mode}; received=${JSON.stringify(prompt?.slice(0, 3))}; status=${globalThis.__pcbRouteTest.proxyPort}/${globalThis.__pcbRouteTest.instanceId}`);
	prompt.at(-1)('50');
	await settleAction();
	return commandRequests('pcb.autoRouteStart').at(-1);
}
async function markCurrentSessionTerminal(state = 'COMPLETED') {
	routeStatusState = state;
	dialogs.length = 0;
	const before = requests.length;
	launchPcbToolsAction('route-status');
	await settleAction();
	return requests.slice(before).find(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === 'pcb.autoRouteStatus');
}
async function stopUnknownStart() {
	dialogs.length = 0;
	const before = requests.length;
	launchPcbToolsAction('route-stop');
	await settleAction();
	const confirmation = dialogs.findLast(item => item[1] === '停止自动布线');
	assert.ok(confirmation, 'stop recovery asks before sending the stop request');
	confirmation.at(-1)(true);
	await settleAction();
	return requests.slice(before).filter(item => item.url.endsWith('/command')).map(item => JSON.parse(item.body));
}

await markCurrentSessionTerminal();
const startsBeforeNoProxy = currentStarts();
setProxyPort(null);
await submitStart();
assert.equal(currentStarts(), startsBeforeNoProxy, 'missing proxy is rejected before any HTTP start request');
setProxyPort(49721);
const afterProxyRecovery = await submitStart();
assert.equal(currentStarts(), startsBeforeNoProxy + 1, 'restoring the proxy allows a fresh start after known-not-sent preflight');
const proxyRecoveryOperation = JSON.parse(afterProxyRecovery.body).params.__routeOperationId;
assert.ok(proxyRecoveryOperation && proxyRecoveryOperation !== recoveredStatusRequest.params.__routeOperationId, 'recovery creates a new operation instead of borrowing the earlier task');

await markCurrentSessionTerminal();
const startsBeforeBadInstance = currentStarts();
globalThis.__pcbRouteTest.instanceId = '';
await submitStart();
assert.equal(currentStarts(), startsBeforeBadInstance, 'an empty instanceId is rejected before any HTTP start request');
globalThis.__pcbRouteTest.instanceId = 'route-test-instance';
const afterInstanceRecovery = await submitStart();
assert.equal(currentStarts(), startsBeforeBadInstance + 1, 'restoring a valid instanceId allows a fresh start');
const instanceRecoveryOperation = JSON.parse(afterInstanceRecovery.body).params.__routeOperationId;
assert.notEqual(instanceRecoveryOperation, proxyRecoveryOperation, 'the retry does not reuse a stale operation identity');

await markCurrentSessionTerminal();
const heartbeatStart = await submitStart('heartbeat-fuse');
assert.ok(startReplyModesServed.includes('heartbeat-fuse'), 'heartbeat-fuse fixture returned the structured partial response');
const heartbeatOperation = JSON.parse(heartbeatStart.body).params.__routeOperationId;
const startsWithHeartbeat = currentStarts();
await settleAction();
assert.equal(currentStarts(), startsWithHeartbeat, 'heartbeat-fuse partial without a jobId prevents a second start');
const heartbeatStatus = await markCurrentSessionTerminal('RUNNING');
assert.equal(JSON.parse(heartbeatStatus.body).params.__routeOperationId, heartbeatOperation, 'status recovers the partial start using its original operation ID');
const heartbeatStopRequests = await stopUnknownStart();
const heartbeatStop = heartbeatStopRequests.find(item => item.cmd === 'pcb.autoRouteStop');
assert.equal(heartbeatStop.params.__routeOperationId, heartbeatOperation, 'stop remains associated with the heartbeat-fuse operation');

await markCurrentSessionTerminal('CANCELLED');
const watchdogStart = await submitStart('client-watchdog');
assert.ok(startReplyModesServed.includes('client-watchdog'), 'client-watchdog fixture returned the structured partial response');
const watchdogOperation = JSON.parse(watchdogStart.body).params.__routeOperationId;
const startsWithWatchdog = currentStarts();
await settleAction();
assert.equal(currentStarts(), startsWithWatchdog, 'client-watchdog partial without a jobId prevents a second start');
const watchdogRecovery = await stopUnknownStart();
const watchdogStatus = watchdogRecovery.find(item => item.cmd === 'pcb.autoRouteStatus');
const watchdogStop = watchdogRecovery.find(item => item.cmd === 'pcb.autoRouteStop');
assert.equal(watchdogStatus.params.__routeOperationId, watchdogOperation, 'stop recovery queries the client-watchdog start operation');
assert.equal(watchdogStop.params.__routeOperationId, watchdogOperation, 'stop request preserves the client-watchdog operation identity');

await markCurrentSessionTerminal('CANCELLED');
const startsBeforeBusinessReject = currentStarts();
await submitStart('business-preflight');
assert.ok(startReplyModesServed.includes('business-preflight'), 'business preflight fixture returned the explicit non-partial response');
assert.equal(currentStarts(), startsBeforeBusinessReject + 1, 'business preflight failure is returned by a valid HTTP response');
const startsAfterBusinessReject = currentStarts();
const afterBusinessRetry = await submitStart('success');
assert.equal(currentStarts(), startsAfterBusinessReject + 1, 'an explicit non-partial business rejection allows a later fresh attempt');
assert.ok(JSON.parse(afterBusinessRetry.body).params.__routeOperationId);
console.log('PASS FreeRouting start recovery: pre-send rejection, lost response, partial watchdog/fuse, and business preflight retry');
