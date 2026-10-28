import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: { contents: `import { pcbCommands } from '../src/commands/pcb.ts'; import { parseAutoRouteSes, mapSesRoutes, serializeSesSubset } from '../src/engine/autoRouteSes.ts'; export { pcbCommands, parseAutoRouteSes, mapSesRoutes, serializeSesSubset }`, resolveDir: resolve(root, 'test'), sourcefile: 'auto-route-result-regression-entry.ts' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { pcbCommands, parseAutoRouteSes, mapSesRoutes, serializeSesSubset } = await import(moduleUrl);
	const command = name => pcbCommands.find(item => item.name === name);
	const sesText = readFileSync(resolve(root, 'test/fixtures/auto-route-real-v223.ses'), 'utf8');
	const sesBase64 = Buffer.from(sesText, 'utf8').toString('base64');
	const sesLayers = [{ id: 1, name: 'TopLayer', type: 'SIGNAL', layerStatus: 1 }, { id: 2, name: 'BottomLayer', type: 'SIGNAL', layerStatus: 1 }];
	const sesExpected = mapSesRoutes(parseAutoRouteSes(sesText), sesLayers);
	const shortLine = { ...sesExpected.lines[0], a: { x: 0, y: 0 }, b: { x: 0.5, y: 0 } };
	const shortSesText = serializeSesSubset(sesText, { lines: [shortLine], vias: [] });
	const shortSesBase64 = Buffer.from(shortSesText, 'utf8').toString('base64');

	let routeJobCounter = 0;
	let statusState = 'COMPLETED';
	let statusJobId = 'job-1';
	let outputResponse = { job_id: 'job-1', data: sesBase64, filename: 'route.ses', format: 'SES', size: Buffer.from(sesText, 'utf8').length, crc32: 1234, statistics: { routed: 3 } };
	let outputCalls = 0;
	let statusCalls = 0;
	let pcbReads = 0;
	let pcbWrites = 0;
	let failRequestFor = '';
	let delayStatusMs = 0;
	let delayOutputMs = 0;
	const requests = [];
	const json = value => ({ ok: true, status: 200, json: async () => value });
	globalThis.eda = {
		sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
		dmt_SelectControl: {
			getCurrentDocumentInfo: async () => {
				pcbReads++;
				return { documentType: 3, uuid: 'board-uuid-1' };
			},
		},
		sys_FileManager: {
			getDocumentSource: async () => {
				pcbReads++;
				return undefined;
			},
		},
		pcb_Layer: {
			getAllLayers: async () => {
				pcbReads++;
				return [];
			},
		},
		pcb_Drc: {
			getNetRules: async () => {
				pcbReads++;
				return [];
			},
		},
		pcb_ManufactureData: {
			getDsnFile: async () => {
				pcbReads++;
				const file = new Blob(['dsn']);
				Object.defineProperty(file, 'name', { value: 'board.dsn' });
				return file;
			},
		},
		pcb_Document: {
			importAutoRouteSesFile: async () => {
				pcbWrites++;
				return true;
			},
			save: async () => {
				pcbWrites++;
				return true;
			},
		},
		pcb_PrimitiveLine: {
			getAll: async () => {
				pcbReads++;
				return [];
			},
			create: async () => {
				pcbWrites++;
				return {};
			},
			delete: async () => {
				pcbWrites++;
				return true;
			},
		},
		pcb_PrimitiveVia: {
			getAll: async () => {
				pcbReads++;
				return [];
			},
			create: async () => {
				pcbWrites++;
				return {};
			},
			delete: async () => {
				pcbWrites++;
				return true;
			},
		},
		sys_ClientUrl: {
			request: async (url, method) => {
				requests.push({ url, method });
				if (url.includes(failRequestFor) && failRequestFor)
					throw new Error('mock network failure');
				if (url.endsWith('/system/status'))
					return json({ ok: true });
				if (url.endsWith('/sessions/create'))
					return json({ id: 'session-1' });
				if (url.endsWith('/jobs/enqueue'))
					return json({ id: `job-${++routeJobCounter}` });
				if (/\/jobs\/[^/]+\/settings$/.test(url))
					return json({ ok: true });
				if (/\/jobs\/[^/]+\/input$/.test(url))
					return json({ ok: true });
				if (/\/jobs\/[^/]+\/start$/.test(url))
					return json({ ok: true });
				if (/\/jobs\/[^/]+\/output$/.test(url)) {
					outputCalls++;
					if (delayOutputMs)
						await new Promise(resolve => setTimeout(resolve, delayOutputMs));
					return json(outputResponse);
				}
				if (/\/jobs\/[^/]+$/.test(url)) {
					statusCalls++;
					if (delayStatusMs)
						await new Promise(resolve => setTimeout(resolve, delayStatusMs));
					return json({ id: statusJobId, state: statusState });
				}
				throw new Error(`Unexpected FreeRouting request: ${method} ${url}`);
			},
		},
	};

	const getResult = command('pcb.autoRouteGetResult');
	assert.ok(getResult, 'the completed SES retrieval command is registered');
	assert.deepEqual(getResult.params.find(item => item.name === 'jobId') && [getResult.params.find(item => item.name === 'jobId').required, getResult.params.find(item => item.name === 'jobId').type], [true, 'string']);
	assert.match(command('pcb.autoRouteStart').summary, /保留返回的 jobId/);
	assert.match(getResult.summary, /不导入|不会导入/);
	assert.match(getResult.returns, /imported:false.*autoImportEnabled:false/s);
	assert.match(command('pcb.autoRouteStatus').summary, /pcb\.autoRouteGetResult.*pcb\.importAutoRouteSes/);

	const callsBeforeMissing = requests.length;
	await assert.rejects(() => getResult.handler({}, {}), /jobId.*非空/);
	await assert.rejects(() => getResult.handler({ jobId: '   ' }, {}), /jobId.*非空/);
	assert.equal(requests.length, callsBeforeMissing, 'missing jobId is rejected before network access');

	const start = await command('pcb.autoRouteStart').handler({}, {});
	assert.equal(start.jobId, 'job-1');
	assert.equal(typeof command('pcb.autoRouteStatus').handler, 'function');
	// Completion status releases the implicit start slot; the result command must still work by explicit jobId.
	await command('pcb.autoRouteStatus').handler({ jobId: start.jobId }, {});
	const beforeRetrieval = { pcbReads, pcbWrites, outputCalls, statusCalls };
	const result = await getResult.handler({ jobId: start.jobId }, {});
	assert.equal(result.jobId, start.jobId);
	assert.equal(result.state, 'COMPLETED');
	assert.equal(result.fileName, 'route.ses');
	assert.equal(result.base64, sesBase64);
	assert.equal(result.documentUuid, 'board-uuid-1');
	assert.equal(result.documentUuidStatus, 'known');
	assert.equal(result.imported, false);
	assert.equal(result.autoImportEnabled, false);
	assert.equal(result.saved, false);
	assert.equal(result.sourceStabilityVerified, false);
	assert.equal(result.scope.pcbModified, false);
	assert.equal(result.scope.drcRun, false);
	assert.equal(result.sesSummary.wires > 0, true);
	assert.equal(result.statistics.routed, 3);
	assert.equal(result.outputMetadata.format, 'SES');
	assert.equal(result.outputMetadata.sizeVerified, true);
	assert.equal(result.outputMetadata.crc32, 1234);
	assert.equal(result.outputMetadata.crc32Verified, false);
	assert.equal(pcbReads, beforeRetrieval.pcbReads, 'result retrieval does not inspect PCB state');
	assert.equal(pcbWrites, beforeRetrieval.pcbWrites, 'result retrieval does not import, clear, or save');
	assert.equal(outputCalls, beforeRetrieval.outputCalls + 1);
	assert.ok(requests.some(call => call.url.endsWith(`/jobs/${start.jobId}/output`)));

	const outputCallsBeforeRepeat = outputCalls;
	await getResult.handler({ jobId: start.jobId }, {});
	assert.equal(outputCalls, outputCallsBeforeRepeat + 1, 'retrieval is repeatable and not consumption-locked');

	statusState = 'RUNNING';
	statusJobId = 'external-job';
	const outputCallsBeforeRunning = outputCalls;
	const running = await getResult.handler({ jobId: 'external-job' }, {});
	assert.equal(running.state, 'RUNNING');
	assert.equal(running.fetched, false);
	assert.equal(running.imported, false);
	assert.equal(running.documentUuid, 'unknown');
	assert.equal(running.documentUuidStatus, 'unknown');
	assert.equal(outputCalls, outputCallsBeforeRunning, 'output is never fetched before COMPLETED');
	statusState = 'COMPLETED';
	statusJobId = 'lowercase-state-job';
	statusState = 'completed';
	const outputCallsBeforeLowercaseState = outputCalls;
	const lowercaseState = await getResult.handler({ jobId: 'lowercase-state-job' }, {});
	assert.equal(lowercaseState.state, 'completed', 'the service state is preserved verbatim');
	assert.equal(lowercaseState.fetched, false, 'only the exact COMPLETED state permits reading output');
	assert.equal(outputCalls, outputCallsBeforeLowercaseState);
	statusState = 'COMPLETED';

	const spacedJobId = ' external ';
	statusJobId = spacedJobId;
	outputResponse = { ...outputResponse, job_id: spacedJobId };
	const spacedJob = await getResult.handler({ jobId: spacedJobId }, {});
	assert.equal(spacedJob.jobId, spacedJobId, 'the caller-supplied jobId is not silently trimmed');
	assert.ok(requests.some(call => call.url.endsWith(`/jobs/${encodeURIComponent(spacedJobId)}/output`)));

	const unusualJobId = 'external/job?x';
	statusJobId = unusualJobId;
	outputResponse = { ...outputResponse, job_id: unusualJobId };
	const unusual = await getResult.handler({ jobId: unusualJobId }, {});
	assert.ok(requests.some(call => call.url.endsWith(`/jobs/${encodeURIComponent(unusualJobId)}`)), 'jobId is URL-encoded in the status path');
	assert.ok(requests.some(call => call.url.endsWith(`/jobs/${encodeURIComponent(unusualJobId)}/output`)), 'jobId is URL-encoded in the output path');
	assert.equal(unusual.documentUuid, 'unknown');

	statusJobId = 'wrong-id';
	const outputCallsBeforeMismatchedStatus = outputCalls;
	await assert.rejects(() => getResult.handler({ jobId: 'requested-id' }, {}), /状态响应 id.*不匹配/);
	assert.equal(outputCalls, outputCallsBeforeMismatchedStatus, 'a mismatched status ID prevents fetching output');
	statusJobId = 'external-job';
	outputResponse = { job_id: 'external-job', data: sesBase64, filename: 'route.ses', format: 'SES', size: Buffer.from(sesText, 'utf8').length };

	for (const badOutput of [
		{ ...outputResponse, data: '' },
		{ ...outputResponse, data: '%%%not-base64%%%' },
		{ ...outputResponse, data: 'AB==' },
		{ ...outputResponse, data: Buffer.from([0xFF, 0xFE]).toString('base64') },
		{ ...outputResponse, data: Buffer.from('not a SES file', 'utf8').toString('base64') },
		{ ...outputResponse, data: sesBase64, filename: '' },
		{ ...outputResponse, filename: '..\\route.ses' },
		{ ...outputResponse, job_id: 'different-job' },
		Object.fromEntries(Object.entries(outputResponse).filter(([key]) => key !== 'job_id')),
		{ ...outputResponse, format: 'DSN' },
		{ ...outputResponse, size: 1 },
	]) {
		outputResponse = badOutput;
		await assert.rejects(() => getResult.handler({ jobId: 'external-job' }, {}), /输出|Base64|UTF-8|SES|jobId|文件名|格式|size/i);
	}

	outputResponse = { job_id: 'short-route-job', data: shortSesBase64, filename: 'short-route.ses', format: 'SES', size: Buffer.byteLength(shortSesText, 'utf8') };
	statusJobId = 'short-route-job';
	const shortResult = await getResult.handler({ jobId: 'short-route-job' }, {});
	assert.equal(shortResult.base64, shortSesBase64, 'a valid SES with a sub-mil route is retrieved byte-for-byte; segment policy is deferred to explicit import');
	assert.equal(shortResult.sesSummary.wires, 1);

	outputResponse = { job_id: 'external-job', data: sesBase64, filename: 'route.ses', format: 'SES', size: Buffer.from(sesText, 'utf8').length };
	statusJobId = 'external-job';
	failRequestFor = '/jobs/network-fail';
	const outputCallsBeforeNetworkFailure = outputCalls;
	await assert.rejects(() => getResult.handler({ jobId: 'network-fail' }, {}), /mock network failure/);
	assert.equal(outputCalls, outputCallsBeforeNetworkFailure, 'a status request failure does not proceed to output');
	failRequestFor = '';

	delayStatusMs = 20;
	const outputCallsBeforeTimeout = outputCalls;
	await assert.rejects(() => getResult.handler({ jobId: 'timeout-job', _timeoutMs: 1 }, {}), /超时|预算|timeout/i);
	assert.equal(outputCalls, outputCallsBeforeTimeout, 'shared deadline exhaustion prevents output request');
	delayStatusMs = 0;

	failRequestFor = '/jobs/output-fail/output';
	statusJobId = 'output-fail';
	const outputCallsBeforeOutputFailure = outputCalls;
	await assert.rejects(() => getResult.handler({ jobId: 'output-fail' }, {}), /mock network failure/);
	assert.equal(outputCalls, outputCallsBeforeOutputFailure, 'a failed output HTTP request is surfaced as one read-only failure');
	failRequestFor = '';

	delayOutputMs = 20;
	statusJobId = 'output-timeout';
	const outputCallsBeforeOutputTimeout = outputCalls;
	await assert.rejects(() => getResult.handler({ jobId: 'output-timeout', _timeoutMs: 10 }, {}), /超时|预算|timeout/i);
	assert.equal(outputCalls, outputCallsBeforeOutputTimeout + 1, 'status and output share one deadline, so a slow output cannot extend it');
	delayOutputMs = 0;

	console.log('PASS autoRouteGetResult fetches only COMPLETED SES output and remains read-only/repeatable');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
