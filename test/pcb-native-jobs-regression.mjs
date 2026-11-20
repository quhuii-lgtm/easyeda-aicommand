import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/commands/pcbNativeJobs.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
	let doc = { documentType: 3, uuid: 'pcb-1', parentProjectUuid: 'project-1', tabId: 'tab-1' };
	let status = { jobId: 'job-1', state: 'running', progress: 35, partial: true };
	let statusError;
	let startError;
	let cancelAccepted = true;
	let netNames = ['GND', '+5V', 'A', 'B'];
	let netReadError;
	let logSnapshot = {
		logs: [{ at: 5, level: 'info', message: 'routing started' }],
		result: { completedNets: ['GND'], failedNets: [] },
		progress: { state: 'running', percent: 35 },
	};
	let startProps;
	const calls = { start: 0, status: 0, log: 0, cancel: 0, nets: 0 };
	let failTarget = false;
	let targetChecks = 0;
	let failTargetAt;
	const eda = {
		pcb_Net: {
			getAllNetsName: async () => {
				calls.nets++;
				if (netReadError)
					throw netReadError;
				return netNames;
			},
		},
		pcb_Document: {
			startAutoRouting: async (props) => {
				calls.start++;
				if (startError)
					throw startError;
				startProps = props;
				return { jobId: 'job-1', props };
			},
			getAutoJobStatus: async (jobId) => {
				calls.status++;
				assert.equal(jobId, 'job-1');
				if (statusError)
					throw statusError;
				return status;
			},
			getAutoJobLog: async (jobId) => {
				calls.log++;
				assert.equal(jobId, 'job-1');
				return logSnapshot;
			},
			cancelAutoJob: async (jobId) => {
				calls.cancel++;
				assert.equal(jobId, 'job-1');
				return cancelAccepted;
			},
		},
	};
	const sandbox = { exports: {}, sdkEda: eda, Error, Set, Map, Array, Object, String, Number, Boolean, Promise };
	// The extension runtime exposes eda as a lexical identifier; globalThis.eda is intentionally absent.
	vm.runInNewContext(`const eda = sdkEda;\n${code}`, sandbox);
	const ctx = {
		vars: {},
		documentTarget: { documentType: 3, uuid: 'pcb-1', parentProjectUuid: 'project-1', tabId: 'tab-1' },
		assertDocumentTarget: async () => {
			targetChecks++;
			if (failTarget || targetChecks === failTargetAt)
				throw new Error('target changed');
			if (doc.documentType !== 3 || doc.uuid !== 'pcb-1' || doc.parentProjectUuid !== 'project-1')
				throw new Error('target changed');
		},
		stopSignal: { assertActive() {} },
	};
	const commands = sandbox.exports.pcbNativeJobCommands;
	return {
		commands,
		ctx,
		calls,
		eda,
		setDoc(value) { doc = value; },
		setStatus(value) { status = value; },
		setStatusError(value) { statusError = value; },
		setStartError(value) { startError = value; },
		setCancelAccepted(value) { cancelAccepted = value; },
		setNetNames(value) { netNames = value; },
		setNetReadError(value) { netReadError = value; },
		setLogSnapshot(value) { logSnapshot = value; },
		setFailTarget(value) { failTarget = value; },
		setFailTargetAt(value) { failTargetAt = value; },
		getStartProps() { return startProps; },
		getLogSnapshot() { return logSnapshot; },
	};
}

async function main() {
	const env = setup();
	assert.deepEqual(Array.from(env.commands, command => command.name), [
		'pcb.nativeAutoRouteStart',
		'pcb.nativeAutoRouteStatus',
		'pcb.nativeAutoRouteStop',
		'pcb.nativeAutoRouteLog',
	]);
	assert.equal(vm.runInNewContext('typeof globalThis.eda'), 'undefined', 'implementation must use the lexical eda binding');

	const [start, , , log] = env.commands;
	await assert.rejects(() => start.handler({ RoutingNets: [] }, env.ctx), /非空网络名数组/);
	await assert.rejects(() => start.handler({ RoutingNets: ['GND'], typo: true }, env.ctx), /未知参数/);
	assert.equal(env.calls.start, 0, 'invalid requests must be rejected before dispatch');

	const launched = await start.handler({ RoutingNets: ['GND', '+5V'], cornerStyle: 0, optimization: 1 }, env.ctx);
	assert.equal(env.calls.start, 1);
	assert.deepEqual(Array.from(env.getStartProps().RoutingNets), ['GND', '+5V']);
	assert.equal(env.getStartProps().existingPrimitiveMode, 'keep');
	assert.equal(env.getStartProps().cornerStyle, 0, '45-degree enum value must match official declaration');
	assert.equal(env.getStartProps().optimization, 1, 'completion-priority enum value must match official declaration');
	assert.deepEqual(Array.from(env.getStartProps().ignoreNets), ['A', 'B'], 'all named non-target nets are explicitly excluded');
	assert.equal(start.example.params.cornerStyle, 0);
	assert.equal(start.example.params.optimization, 1);
	assert.deepEqual(Array.from(launched.routingNets), ['GND', '+5V']);
	assert.equal(launched.existingPrimitiveMode, 'keep', 'KEEP must be the default');
	assert.deepEqual(JSON.parse(JSON.stringify(launched.binding)), { jobId: 'job-1', projectUuid: 'project-1', pcbUuid: 'pcb-1' });
	assert.equal(launched.state, 'running');

	const routeSubset = setup();
	const all35Nets = Array.from({ length: 35 }, (_, index) => `N${String(index).padStart(2, '0')}`);
	routeSubset.setNetNames(all35Nets);
	const target11 = all35Nets.slice(0, 11);
	await routeSubset.commands[0].handler({ RoutingNets: target11 }, routeSubset.ctx);
	assert.deepEqual(Array.from(routeSubset.getStartProps().RoutingNets), target11);
	assert.equal(routeSubset.getStartProps().ignoreNets.length, 24, 'eleven requested nets leave twenty-four named non-target nets ignored');
	assert.deepEqual(Array.from(routeSubset.getStartProps().ignoreNets), all35Nets.slice(11));
	assert.equal(routeSubset.calls.nets, 1, 'the network list is read once before native dispatch');

	const explicitIgnore = setup();
	explicitIgnore.setNetNames(all35Nets);
	await explicitIgnore.commands[0].handler({ RoutingNets: target11, ignoreNets: ['MANUAL_SKIP', 'N00'] }, explicitIgnore.ctx);
	assert.deepEqual(Array.from(explicitIgnore.getStartProps().ignoreNets), ['MANUAL_SKIP', 'N00', ...all35Nets.slice(11)], 'explicit ignore values and overlap remain unchanged before adding the non-target complement');

	const networkReadFailure = setup();
	networkReadFailure.setNetReadError(new Error('network read failed'));
	await assert.rejects(() => networkReadFailure.commands[0].handler({ RoutingNets: ['GND'] }, networkReadFailure.ctx), /读取当前 PCB 网络列表失败.*network read failed/);
	assert.equal(networkReadFailure.calls.start, 0, 'a failed network read must prevent native dispatch');

	const malformedNetworkList = setup();
	malformedNetworkList.setNetNames(undefined);
	await assert.rejects(() => malformedNetworkList.commands[0].handler({ RoutingNets: ['GND'] }, malformedNetworkList.ctx), /不是完整的具名网络数组/);
	assert.equal(malformedNetworkList.calls.start, 0, 'an unverified network list must prevent native dispatch');

	const targetChangedDuringNetworkRead = setup();
	targetChangedDuringNetworkRead.setFailTargetAt(2);
	await assert.rejects(() => targetChangedDuringNetworkRead.commands[0].handler({ RoutingNets: ['GND'] }, targetChangedDuringNetworkRead.ctx), /target changed/);
	assert.equal(targetChangedDuringNetworkRead.calls.start, 0, 'a target change across the network read must prevent native dispatch');

	const binding = launched.binding;
	const wrongProject = setup();
	await assert.rejects(() => wrongProject.commands[1].handler({ ...binding, projectUuid: 'project-2' }, wrongProject.ctx), /工程与任务绑定不符/);
	assert.equal(wrongProject.calls.status, 0, 'wrong project must be rejected before host query');
	const wrongPcb = setup();
	wrongPcb.setDoc({ documentType: 3, uuid: 'pcb-2', parentProjectUuid: 'project-1', tabId: 'tab-2' });
	wrongPcb.ctx.documentTarget.uuid = 'pcb-2';
	wrongPcb.ctx.documentTarget.tabId = 'tab-2';
	await assert.rejects(() => wrongPcb.commands[1].handler(binding, wrongPcb.ctx), /PCB 与任务绑定不符/);
	assert.equal(wrongPcb.calls.status, 0, 'wrong PCB must be rejected before host query');

	const refreshed = setup();
	refreshed.setStatus(undefined);
	const missingAfterRefresh = await refreshed.commands[1].handler(binding, refreshed.ctx);
	assert.equal(missingAfterRefresh.state, 'unknown', 'missing host state must remain unknown after refresh');
	assert.equal(missingAfterRefresh.stopped, false, 'missing host state must not claim stopped');
	assert.equal(missingAfterRefresh.exists, false);
	assert.match(refreshed.commands[1].summary, /页面刷新后不能依赖旧任务 ID/);

	const stopPending = setup();
	stopPending.setStatus({ jobId: 'job-1', state: 'running', progress: 37 });
	const pendingResult = await stopPending.commands[2].handler(binding, stopPending.ctx);
	assert.equal(stopPending.calls.cancel, 1);
	assert.equal(pendingResult.cancelRequestAccepted, true);
	assert.equal(pendingResult.state, 'running');
	assert.equal(pendingResult.stopped, false, 'accepting cancel is not confirmation of stop');
	assert.equal(pendingResult.cancellationPending, true);

	const stopped = setup();
	stopped.setStatus({ jobId: 'job-1', state: 'canceled', progress: 42 });
	const stoppedResult = await stopped.commands[2].handler(binding, stopped.ctx);
	assert.equal(stoppedResult.stopped, true, 'only a canceled status confirms stop');

	const noRetry = setup();
	noRetry.setStartError(new Error('response lost'));
	await assert.rejects(() => noRetry.commands[0].handler({ RoutingNets: ['GND'] }, noRetry.ctx), (error) => {
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		assert.equal(error.cause?.status, 'unknown');
		return true;
	});
	assert.equal(noRetry.calls.start, 1, 'a lost start response must not trigger an automatic second start');

	const statusReadFailure = setup();
	statusReadFailure.setStatusError(new Error('status unavailable'));
	const startedWithoutStatus = await statusReadFailure.commands[0].handler({ RoutingNets: ['GND'] }, statusReadFailure.ctx);
	assert.equal(startedWithoutStatus.launch, 'started', 'the start handle remains known when the separate status read fails');
	assert.equal(startedWithoutStatus.state, 'unknown');
	assert.equal(Object.hasOwn(startedWithoutStatus, 'exists'), false, 'a failed status query must not claim the job is absent');
	assert.deepEqual(JSON.parse(JSON.stringify(startedWithoutStatus.binding)), { jobId: 'job-1', projectUuid: 'project-1', pcbUuid: 'pcb-1' });
	assert.equal(statusReadFailure.calls.start, 1, 'status errors must not restart the route job');

	const targetChangedDuringStartStatus = setup();
	targetChangedDuringStartStatus.setFailTargetAt(4);
	const startedAfterTargetChange = await targetChangedDuringStartStatus.commands[0].handler({ RoutingNets: ['GND'] }, targetChangedDuringStartStatus.ctx);
	assert.equal(startedAfterTargetChange.state, 'unknown');
	assert.equal(Object.hasOwn(startedAfterTargetChange, 'exists'), false, 'a target switch during status checks is unknown, not absent');
	assert.equal(targetChangedDuringStartStatus.calls.start, 1);
	assert.equal(targetChangedDuringStartStatus.calls.status, 0, 'target drift before status read prevents querying another document');
	assert.deepEqual(JSON.parse(JSON.stringify(startedAfterTargetChange.binding)), { jobId: 'job-1', projectUuid: 'project-1', pcbUuid: 'pcb-1' });

	const targetDrift = setup();
	targetDrift.setFailTarget(true);
	await assert.rejects(() => targetDrift.commands[0].handler({ RoutingNets: ['GND'] }, targetDrift.ctx), /target changed/);
	assert.equal(targetDrift.calls.start, 0, 'target changes before dispatch must prevent SDK call');
	await assert.rejects(() => env.commands[1].handler(binding, {
		...env.ctx,
		assertDocumentTarget: async () => { throw new Error('target changed'); },
	}), /target changed/);
	assert.equal(env.calls.status, 1, 'target changes must prevent status query');

	const logResult = await log.handler(binding, env.ctx);
	assert.equal(logResult.count, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(logResult.result)), { completedNets: ['GND'], failedNets: [] });
	assert.deepEqual(JSON.parse(JSON.stringify(logResult.progress)), { state: 'running', percent: 35 });
	assert.deepEqual(JSON.parse(JSON.stringify(logResult.snapshot)), JSON.parse(JSON.stringify(env.getLogSnapshot())));
	assert.equal(env.calls.log, 1);
	const emptyLog = setup();
	emptyLog.setLogSnapshot({ logs: [], result: null, progress: null });
	const emptySnapshot = await emptyLog.commands[3].handler(binding, emptyLog.ctx);
	assert.equal(emptySnapshot.count, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(emptySnapshot.snapshot)), { logs: [], result: null, progress: null });

	console.log('pcb native jobs regression passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
