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
for (const context of ['home', 'sch']) {
	assert.deepEqual(menus[context].map(item => item.id), ['aiCommand']);
	assert.equal(menus[context][0].title, pcbMenu.title);
	assert.deepEqual(menus[context][0].menuItems.map(item => item.registerFn), general);
}
assert.deepEqual(pcbMenu.menuItems.map(item => item.registerFn), [
	...general,
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
});
const { launchPcbToolsAction, setProxyPort } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
setProxyPort(49721);
const dialogs = [], requests = [], opened = [];
let status;
let loseStartReply = false;
let acceptedStart = false;
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
				if (loseStartReply) throw new Error('HTTP response lost after server accepted start');
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId: 'job-A', dsnConversion: {}, routingConstraintsComplete: false } }) };
			}
			if (request.cmd === 'pcb.autoRouteStatus')
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId: 'job-A', state: 'RUNNING' } }) };
			if (request.cmd === 'pcb.autoRouteStop')
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cmd: request.cmd, data: { jobId: 'job-A', state: 'CANCELLED', cancelled: true } }) };
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
async function start() {
	launchPcbToolsAction('route-start');
	await new Promise(resolve => setImmediate(resolve));
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
assert.equal(stopRequest.params.jobId, 'job-A');
assert.equal(stopRequest.params.__routeOperationId, recoveredStatusRequest.params.__routeOperationId, 'stop must stay bound to the original operation');
assert.equal(requests.filter(item => item.url.endsWith('/command') && JSON.parse(item.body).cmd === 'pcb.autoRouteStart').length, stopStartCount, 'status/stop recovery must not re-submit start');
console.log('PASS FreeRouting setup choices, cancel, and healthy service bypass without a routing submission');
