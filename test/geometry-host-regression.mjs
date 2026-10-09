import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

async function main() {
	const bundle = await build({
		entryPoints: ['src/pcb/geometryHost.ts'],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		write: false,
	});

	function source(extra) {
		return [
			`${JSON.stringify({ type: 'DOCHEAD', id: 'head' })}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-A', client: 'test' })}`,
			`${JSON.stringify({ type: 'TRACK', id: 'track-1', ticket: 1 })}||${JSON.stringify({ x: 10, y: 20 })}|`,
			extra,
		].filter(Boolean).join('\n');
	}

	function fixture(overrides = {}) {
		const fakeClock = overrides.fakeClock === true;
		const state = { calls: [], focus: { uuid: 'pcb-A', documentType: 3 }, source: source(), rules: { spacing: 6, width: 8 }, now: performance.now(), ...overrides };
		const sdk = {
			dmt_SelectControl: {
				getCurrentDocumentInfo: async () => {
					state.calls.push('focus');
					return { ...state.focus };
				},
			},
			sys_FileManager: {
				getDocumentSource: async () => {
					state.calls.push('source');
					return state.source;
				},
			},
			pcb_Drc: {
				getCurrentRuleConfiguration: async () => {
					state.calls.push('rules');
					return state.rules;
				},
			},
		};
		const context = { module: { exports: {} }, exports: {}, performance: fakeClock ? { now: () => state.now } : performance, setTimeout, clearTimeout };
		vm.runInNewContext(bundle.outputFiles[0].text, context);
		return { state, sdk, createGeometryHost: context.module.exports.createGeometryHost };
	}

	let passed = 0;
	async function test(name, fn) {
		await fn();
		console.log(`PASS ${name}`);
		passed++;
	}
	async function delay(ms) {
		await new Promise(resolve => setTimeout(resolve, ms));
	}

	await test('normal read/write tracks ids and keeps the original SDK object', async () => {
		const f = fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		assert.equal(host.sdk, f.sdk);
		assert.equal(host.documentUuid, 'pcb-A');
		const baseline = await host.getBaseline();
		assert.equal(baseline.source, `${JSON.stringify({ type: 'TRACK', id: 'track-1', ticket: 1 })}||${JSON.stringify({ x: 10, y: 20 })}|`);
		assert.equal(JSON.stringify(baseline.rules), JSON.stringify({ spacing: 6, width: 8 }));
		assert.equal(await host.read('read sample', () => 42), 42);
		assert.equal(await host.write('create sample', () => 'new-1'), 'new-1');
		host.recordCreated('new-1');
		host.recordVerified('new-1');
		await host.finish();
		assert.deepEqual(f.state.calls.filter(call => call === 'focus').length >= 6, true);
	});

	await test('read rejection latches failure without partial and prevents later SDK calls', async () => {
		const f = await fixture();
		f.sdk.sys_FileManager.getDocumentSource = async () => {
			f.state.calls.push('source-error');
			throw new Error('source denied');
		};
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		await assert.rejects(host.read('read failed', () => f.sdk.sys_FileManager.getDocumentSource()), (error) => {
			assert.match(error.message, /source denied/);
			assert.equal(error.cause?.partial, undefined);
			return true;
		});
		const calls = f.state.calls.length;
		await assert.rejects(host.write('must not run', () => {
			f.state.calls.push('write');
		}), /source denied/);
		assert.equal(f.state.calls.length, calls);
	});

	await test('permanent read hang hits the shared minimum budget and blocks later work', async () => {
		const f = await fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A', _timeoutMs: 1 });
		const started = Date.now();
		await assert.rejects(host.read('permanent read', () => new Promise(() => {})), /共享剩余预算/);
		assert.ok(Date.now() - started >= 950);
		const calls = f.state.calls.length;
		await assert.rejects(host.write('after hang', () => {
			f.state.calls.push('write');
		}), /共享剩余预算/);
		assert.equal(f.state.calls.length, calls);
	});

	await test('late write completion is partial and no following write is invoked', async () => {
		const f = await fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A', _timeoutMs: 1000 });
		let lateCompleted = false;
		const error = await host.write('late write', async () => {
			f.state.calls.push('write-1');
			await delay(1100);
			lateCompleted = true;
			return 'late-id';
		}).then(
			() => assert.fail('late write should time out'),
			caught => host.fail(caught),
		).catch(caught => caught);
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.equal(error.cause.saved, false);
		await assert.rejects(host.write('must not follow late write', () => {
			f.state.calls.push('write-2');
		}), /剩余预算|late write/);
		await delay(150);
		assert.equal(lateCompleted, true);
		assert.equal(f.state.calls.filter(call => call.startsWith('write-')).length, 1);
	});

	await test('focus change latches and prevents any subsequent write', async () => {
		const f = await fixture();
		let focusReads = 0;
		f.sdk.dmt_SelectControl.getCurrentDocumentInfo = async () => {
			focusReads++;
			return focusReads >= 3 ? { uuid: 'pcb-B', documentType: 3 } : { uuid: 'pcb-A', documentType: 3 };
		};
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		await assert.rejects(host.write('switch during write', () => {
			f.state.calls.push('write-1');
			return true;
		}), /焦点已离开/);
		const calls = f.state.calls.filter(call => call.startsWith('write-')).length;
		await assert.rejects(host.write('after focus change', () => {
			f.state.calls.push('write-2');
			return true;
		}), /焦点已离开/);
		assert.equal(calls, 1);
	});

	await test('separate operations consume one shared budget', async () => {
		const f = await fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A', _timeoutMs: 1200 });
		await host.read('first operation', async () => {
			await delay(650);
			return true;
		});
		await assert.rejects(host.read('second operation', async () => {
			f.state.calls.push('second');
			await delay(650);
			return true;
		}), /剩余预算|共享/);
		assert.equal(f.state.calls.includes('second'), true);
	});

	await test('baseline detects source changes and normalized DRC rule changes', async () => {
		for (const change of ['source', 'rules']) {
			const f = await fixture();
			const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
			const baseline = await host.getBaseline();
			if (change === 'source')
				f.state.source = source(`${JSON.stringify({ type: 'VIA', id: 'via-2' })}||{}|`);
			else
				f.state.rules = { width: 8, spacing: 7 };
			await assert.rejects(host.assertBaseline(baseline), /基线已变化/);
			const calls = f.state.calls.length;
			await assert.rejects(host.write('after baseline mismatch', () => {
				f.state.calls.push('must-not-write');
			}), /基线已变化/);
			assert.equal(f.state.calls.length, calls);
		}
		const f = await fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		const baseline = await host.getBaseline();
		f.state.rules = { width: 8, spacing: 6 };
		await host.assertBaseline(baseline);
	});

	await test('write interruption is partial and stops subsequent SDK writes', async () => {
		const f = await fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		const error = await host.write('interrupted write', async () => {
			f.state.calls.push('write-1');
			throw new Error('SDK interrupted');
		}).then(
			() => assert.fail('write should reject'),
			caught => host.fail(caught),
		).catch(caught => caught);
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.failedStepAttempted, true);
		assert.equal(error.cause.createdIds.length, 0);
		await assert.rejects(host.write('stopped write', () => {
			f.state.calls.push('write-2');
		}), /SDK interrupted/);
		assert.equal(f.state.calls.filter(call => call.startsWith('write-')).length, 1);
	});

	await test('invalid baseline shape latches before further SDK calls', async () => {
		const f = fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		await assert.rejects(host.assertBaseline({ source: 42, rules: {} }), /基线结构非法/);
		const calls = f.state.calls.length;
		await assert.rejects(host.read('after invalid baseline', () => {
			f.state.calls.push('must-not-read');
		}), /基线结构非法/);
		assert.equal(f.state.calls.length, calls);
	});

	await test('write then failed readback reports created ids and attempted state accurately', async () => {
		const f = fixture();
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		const error = await host.write('create primitive', () => {
			f.state.calls.push('write-create');
			return { getState_PrimitiveId: () => 'primitive-9' };
		}).then(async () => {
			host.recordCreated('primitive-9');
			await host.read('readback primitive', () => {
				f.state.calls.push('readback');
				throw new Error('readback denied');
			});
			assert.fail('readback should fail');
		}).catch((caught) => {
			try {
				host.fail(caught);
			}
			catch (wrapped) { return wrapped; }
		});
		assert.equal(error.cause.partial, true);
		assert.equal(JSON.stringify(error.cause.createdIds), JSON.stringify(['primitive-9']));
		assert.equal(error.cause.failedStep, 'readback primitive');
		assert.equal(error.cause.failedStepAttempted, false);
		const calls = f.state.calls.length;
		await assert.rejects(host.write('after readback failure', () => {
			f.state.calls.push('must-not-write');
		}), /readback denied/);
		assert.equal(f.state.calls.length, calls);
	});

	await test('known ID is recorded before post-write focus failure', async () => {
		const f = fixture();
		let focusReads = 0;
		f.sdk.dmt_SelectControl.getCurrentDocumentInfo = async () => {
			focusReads++;
			return focusReads >= 3 ? { uuid: 'pcb-B', documentType: 3 } : { uuid: 'pcb-A', documentType: 3 };
		};
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
		const error = await host.write('create then switch', () => ({ getState_PrimitiveId: () => 'primitive-10' })).then(
			() => assert.fail('focus switch should fail'),
			(caught) => {
				try {
					host.fail(caught);
				}
				catch (wrapped) { return wrapped; }
			},
		);
		assert.equal(error.cause.partial, true);
		assert.equal(JSON.stringify(error.cause.createdIds), JSON.stringify(['primitive-10']));
		assert.equal(error.cause.failedStepAttempted, false);
	});

	await test('focus identity parameters and missing baseline rules are strict', async () => {
		const f = await fixture();
		await assert.rejects(f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' }, 'pcb-B'), /不一致/);
		await assert.rejects(f.createGeometryHost(f.sdk, { __docUuid: '' }), /非空字符串/);
		for (const rules of [undefined, null, [], {}, 7, 'bad']) {
			f.state.rules = rules;
			const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
			await assert.rejects(host.getBaseline(), /非空普通对象/);
		}
	});

	await test('baseline rejects DOCHEAD identity and document type mismatches', async () => {
		for (const [uuid, docType] of [['pcb-B', 'PCB'], ['pcb-A', 'SCH']]) {
			const f = fixture();
			f.state.source = [
				`${JSON.stringify({ type: 'DOCHEAD', id: 'head' })}||${JSON.stringify({ docType, uuid })}`,
				`${JSON.stringify({ type: 'TRACK', id: 'track-1' })}||{}|`,
			].join('\n');
			const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A' });
			await assert.rejects(host.getBaseline(), /DOCHEAD 与 PCB pcb-A 不符/);
		}
	});

	await test('omitted UUID binds to the initial PCB focus and remains pinned', async () => {
		const f = fixture();
		const host = await f.createGeometryHost(f.sdk, {});
		assert.equal(host.documentUuid, 'pcb-A');
		f.state.focus = { uuid: 'pcb-B', documentType: 3 };
		const calls = f.state.calls.length;
		await assert.rejects(host.read('after focus switch', () => {
			f.state.calls.push('read');
			return true;
		}), /焦点已离开 PCB pcb-A/);
		assert.equal(f.state.calls.slice(calls).includes('read'), false);
	});

	await test('synchronous checkBudget uses the shared deadline and latches later SDK calls', async () => {
		const f = fixture({ fakeClock: true });
		const host = await f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A', _timeoutMs: 1000 });
		f.state.now += 1001;
		assert.throws(() => host.checkBudget(), /共享 1000ms 时间预算/);
		const calls = f.state.calls.length;
		await assert.rejects(host.read('after synchronous budget failure', () => {
			f.state.calls.push('must-not-read');
		}), /共享 1000ms 时间预算/);
		assert.equal(f.state.calls.length, calls);
	});

	console.log(`PASS ${passed} geometry host regression groups`);
}

main().catch((error) => {
	console.error(error);
	throw error;
});
