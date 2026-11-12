/** Orchestrates one or more explicitly requested component replacements. */
export type ReplacementPose = { x: number; y: number; rotation: number; mirror?: boolean };
export type ReplacementInput = {
	projectUuid: string;
	boardUuid: string;
	replacements: Array<{
		oldUid: string;
		pcbComponentId: string;
		schematicParts: Array<{ pageUuid: string; componentId: string; subPartName?: string; newSubPartName?: string }>;
		newDevice: { libraryUuid: string; uuid: string };
		pinMap: Array<{ oldNumber: string; newNumber: string }>;
		pcbPose?: ReplacementPose;
		schematicPoses?: Array<ReplacementPose>;
		localRoutes?: Array<{ net: string; layer: 'top' | 'bottom' | number; width: number; anchor: { primitiveId: string; endpoint: 'start' | 'end' }; targetPadNumber: string; points: Array<[number, number]> }>;
	}>;
};
export type ReplacementPlan = {
	schema: 1;
	planId: string;
	projectUuid: string;
	boardUuid: string;
	inputFingerprint: string;
	prepared: unknown;
	createdAt: number;
};
export type ReplacementOperation = {
	operationId: string;
	planId: string;
	projectUuid: string;
	status: 'running' | 'confirmed' | 'partial' | 'unknown' | 'not_started';
	phase: string;
	inputFingerprint: string;
	writeAttempted: boolean;
	completed: string[];
	/** JSON-safe readback from every completed stage, keyed by phase for later lookup. */
	stageResults: Array<{ phase: string; result: unknown }>;
	/** True only after final post-reopen verification; persisted-record confirmation is tracked separately. */
	designVerified?: boolean;
	operationRecordConfirmed?: boolean;
	result?: unknown;
	error?: string;
	failureEvidence?: unknown;
};

export type ReplacementHost<Prepared = unknown> = {
	readAndPrepare: (input: ReplacementInput) => Promise<Prepared>;
	readPlan: (planId: string) => Promise<ReplacementPlan | undefined>;
	writePlan: (plan: ReplacementPlan) => Promise<void>;
	readOperation: (operationId: string) => Promise<ReplacementOperation | undefined>;
	writeOperation: (operation: ReplacementOperation) => Promise<void>;
	assertPlanStillCurrent: (plan: ReplacementPlan) => Promise<void>;
	/** Each stage is one write boundary; implementations must return only after readback. */
	performStage: (prepared: Prepared, replacementIndex: number, stage: ReplacementStage, context: ReplacementStageContext) => Promise<unknown>;
	/** Save, close, verify tab absence, reopen, and read back; a failure is an unknown write outcome. */
	saveCloseReopen: (prepared: Prepared, priorResults: unknown[]) => Promise<unknown>;
	verifyFinal: (prepared: Prepared, priorResults: unknown[]) => Promise<unknown>;
};

export type ReplacementStage = 'pcb_create_candidate' | 'pcb_verify_candidate' | 'pcb_set_pad_nets' | 'pcb_restore_association'
	| 'pcb_local_routes' | 'pcb_verify_contact' | 'pcb_delete_old' | 'pcb_assign_identity'
	| 'schematic_create_part' | 'schematic_verify_part' | 'schematic_delete_old_part' | 'schematic_restore_properties'
	| 'schematic_restore_association';
export type ReplacementStageContext = {
	operationId: string;
	partIndex?: number;
	partCount?: number;
	previousResults: unknown[];
};

const PLAN_PREFIX = 'module-reuse:component-replacement:plan:v1:';
const OP_PREFIX = 'module-reuse:component-replacement:operation:v1:';
const STAGES: ReplacementStage[] = ['pcb_create_candidate', 'pcb_verify_candidate', 'pcb_set_pad_nets', 'pcb_restore_association',
	'pcb_local_routes', 'pcb_verify_contact', 'pcb_delete_old', 'pcb_assign_identity'];
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function fail(message: string): never { throw new Error(message); }
function jsonClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
function requireId(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空字符串`);
	return value;
}
function validatePose(value: unknown, label: string): ReplacementPose {
	if (!object(value)) fail(`${label} 必须是坐标对象`);
	for (const key of ['x', 'y', 'rotation'] as const)
		if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) fail(`${label}.${key} 必须是有限数值`);
	if (value.mirror !== undefined && typeof value.mirror !== 'boolean') fail(`${label}.mirror 必须是布尔值`);
	return { x: value.x as number, y: value.y as number, rotation: value.rotation as number, ...(value.mirror === undefined ? {} : { mirror: value.mirror as boolean }) };
}
function validateInput(raw: unknown): ReplacementInput {
	if (!object(raw) || !Array.isArray(raw.replacements) || raw.replacements.length === 0) fail('需要至少一个换件目标');
	const projectUuid = requireId(raw.projectUuid, 'projectUuid'), boardUuid = requireId(raw.boardUuid, 'boardUuid');
	const seenUids = new Set<string>(), seenPcbIds = new Set<string>();
	const replacements = raw.replacements.map((item, index) => {
		if (!object(item) || !Array.isArray(item.schematicParts) || !Array.isArray(item.pinMap)) fail(`replacements[${index}] 参数无效`);
		const oldUid = requireId(item.oldUid, `replacements[${index}].oldUid`);
		const pcbComponentId = requireId(item.pcbComponentId, `replacements[${index}].pcbComponentId`);
		if (seenUids.has(oldUid) || seenPcbIds.has(pcbComponentId)) fail('换件目标含重复旧 UID 或 PCB 图元 ID');
		seenUids.add(oldUid); seenPcbIds.add(pcbComponentId);
		if (!object(item.newDevice)) fail(`replacements[${index}].newDevice 无效`);
		const newDevice = { libraryUuid: requireId(item.newDevice.libraryUuid, 'newDevice.libraryUuid'), uuid: requireId(item.newDevice.uuid, 'newDevice.uuid') };
		const schematicParts = item.schematicParts.map((part, partIndex) => {
			if (!object(part)) fail(`schematicParts[${partIndex}] 无效`);
			return { pageUuid: requireId(part.pageUuid, 'schematicParts.pageUuid'), componentId: requireId(part.componentId, 'schematicParts.componentId'),
				...(part.subPartName === undefined ? {} : { subPartName: requireId(part.subPartName, 'schematicParts.subPartName') }),
				...(part.newSubPartName === undefined ? {} : { newSubPartName: requireId(part.newSubPartName, 'schematicParts.newSubPartName') }) };
		});
		if (!schematicParts.length) fail('每个目标都必须列出所有原理图分部');
		const pcbPose = item.pcbPose === undefined ? undefined : validatePose(item.pcbPose, `replacements[${index}].pcbPose`);
		let schematicPoses: ReplacementPose[] | undefined;
		if (item.schematicPoses !== undefined) {
			if (!Array.isArray(item.schematicPoses) || item.schematicPoses.length !== schematicParts.length) fail(`replacements[${index}].schematicPoses 数量必须与 schematicParts 一致`);
			schematicPoses = item.schematicPoses.map((pose, poseIndex) => validatePose(pose, `replacements[${index}].schematicPoses[${poseIndex}]`));
		}
		const pinMap = item.pinMap.map((pair, pairIndex) => {
			if (!object(pair)) fail(`pinMap[${pairIndex}] 无效`);
			return { oldNumber: requireId(pair.oldNumber, 'pinMap.oldNumber'), newNumber: requireId(pair.newNumber, 'pinMap.newNumber') };
		});
		if (new Set(pinMap.map(pair => pair.oldNumber)).size !== pinMap.length || new Set(pinMap.map(pair => pair.newNumber)).size !== pinMap.length) fail('pinMap 的旧/新焊盘号必须各自唯一');
		let localRoutes: NonNullable<ReplacementInput['replacements'][number]['localRoutes']> | undefined;
		if (item.localRoutes !== undefined) {
			if (!Array.isArray(item.localRoutes)) fail('localRoutes 必须为数组');
			localRoutes = item.localRoutes.map((route, routeIndex) => {
				if (!object(route)) fail(`localRoutes[${routeIndex}] 必须是对象`);
				const layer = route.layer;
				if (!(layer === 'top' || layer === 'bottom' || (typeof layer === 'number' && Number.isInteger(layer) && layer > 0))) fail(`localRoutes[${routeIndex}].layer 必须是 top/bottom 或正整数 SDK 层号`);
				if (typeof route.width !== 'number' || !Number.isFinite(route.width) || route.width <= 0) fail(`localRoutes[${routeIndex}].width 必须是正有限数值`);
				if (!object(route.anchor)) fail(`localRoutes[${routeIndex}].anchor 无效`);
				const endpoint = route.anchor.endpoint;
				if (endpoint !== 'start' && endpoint !== 'end') fail(`localRoutes[${routeIndex}].anchor.endpoint 必须是 start 或 end`);
				const validEndpoint: 'start' | 'end' = endpoint;
				const anchor = { primitiveId: requireId(route.anchor.primitiveId, `localRoutes[${routeIndex}].anchor.primitiveId`), endpoint: validEndpoint };
				if (!Array.isArray(route.points) || route.points.length < 2) fail(`localRoutes[${routeIndex}].points 至少需要两个坐标点`);
				const points = route.points.map((point, pointIndex) => {
					if (!Array.isArray(point) || point.length !== 2 || point.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) fail(`localRoutes[${routeIndex}].points[${pointIndex}] 必须包含两个有限坐标`);
					return [point[0], point[1]] as [number, number];
				});
				return { net: requireId(route.net, `localRoutes[${routeIndex}].net`), layer, width: route.width, anchor,
					targetPadNumber: requireId(route.targetPadNumber, `localRoutes[${routeIndex}].targetPadNumber`), points };
			});
		}
		return { oldUid, pcbComponentId, schematicParts, newDevice, pinMap,
			...(pcbPose === undefined ? {} : { pcbPose }), ...(schematicPoses === undefined ? {} : { schematicPoses }),
			...(localRoutes === undefined ? {} : { localRoutes }) };
	});
	return { projectUuid, boardUuid, replacements };
}
function fingerprint(value: unknown): string { return stable(value); }
function isWriteStage(stage: ReplacementStage): boolean {
	return !['pcb_verify_candidate', 'pcb_verify_contact', 'schematic_verify_part'].includes(stage);
}

export function createComponentReplacementService<Prepared>(host: ReplacementHost<Prepared>, createId: () => string = () => globalThis.crypto.randomUUID().replaceAll('-', '')) {
	const inFlight = new Map<string, { planId: string; promise: Promise<ReplacementOperation> }>();
	async function persist(operation: ReplacementOperation, patch: Partial<ReplacementOperation>): Promise<ReplacementOperation> {
		const next = deepFreeze(jsonClone({ ...operation, ...patch }));
		await host.writeOperation(next);
		const stored = await host.readOperation(next.operationId);
		if (!stored || stable(stored) !== stable(next)) throw new Error('换件操作进度保存后读回不一致；停止后续写入');
		Object.assign(operation, next);
		return operation;
	}
	async function prepareReplacement(raw: unknown): Promise<Omit<ReplacementPlan, 'prepared'> & { ready: true; targetCount: number }> {
		const input = jsonClone(validateInput(raw));
		const inputFingerprint = fingerprint(input);
		const prepared = await host.readAndPrepare(deepFreeze(jsonClone(input)));
		const plan = deepFreeze(jsonClone({ schema: 1 as const, planId: createId(), projectUuid: input.projectUuid, boardUuid: input.boardUuid,
			inputFingerprint, prepared, createdAt: Date.now() }));
		await host.writePlan(plan);
		const readback = await host.readPlan(plan.planId);
		if (!readback || stable(readback) !== stable(plan)) fail('换件计划保存后读回不一致');
		return { schema: 1, planId: plan.planId, projectUuid: plan.projectUuid, boardUuid: plan.boardUuid,
			inputFingerprint: plan.inputFingerprint, createdAt: plan.createdAt, ready: true, targetCount: input.replacements.length };
	}
	async function getReplacementOperation(operationId: string): Promise<ReplacementOperation> {
		const id = requireId(operationId, 'operationId');
		const record = await host.readOperation(id);
		if (!record) fail(`换件操作不存在：${operationId}`);
		if (record.status === 'confirmed' && (record.designVerified !== true || record.operationRecordConfirmed !== true))
			return { ...record, status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
				error: record.designVerified === true ? '设计读回已通过，但操作确认记录未能确认' : '操作记录为旧格式或缺少最终读回证明，不能确认完成' };
		if (record.designVerified === true && record.operationRecordConfirmed !== true)
			return { ...record, status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
				error: '设计读回已通过，但操作确认记录未能确认' };
		if (record.status === 'running' && !inFlight.has(id))
			return { ...record, status: 'unknown', phase: `${record.phase}_record_unconfirmed`, writeAttempted: record.writeAttempted,
				error: '持久记录仍为运行中，但当前服务没有对应执行；需先核实现场，不会重放写入' };
		return record;
	}
	function executeReplacement(raw: unknown): Promise<ReplacementOperation> {
		if (!object(raw)) fail('换件执行参数必须是对象');
		const planId = requireId(raw.planId, 'planId'), operationId = requireId(raw.operationId, 'operationId');
		const active = inFlight.get(operationId);
		if (active) {
			if (active.planId !== planId) fail('operationId 已并发用于不同换件计划');
			return active.promise;
		}
		const promise = executeReplacementOnce(planId, operationId);
		inFlight.set(operationId, { planId, promise });
		return promise.finally(() => { if (inFlight.get(operationId)?.promise === promise) inFlight.delete(operationId); });
	}
	async function executeReplacementOnce(planId: string, operationId: string): Promise<ReplacementOperation> {
		const plan = await host.readPlan(planId);
		if (!plan || plan.schema !== 1 || plan.planId !== planId || !object(plan.prepared)) fail('换件计划不存在或结构无效');
		deepFreeze(plan);
		const prior = await host.readOperation(operationId);
		if (prior) {
			if (prior.planId !== planId || prior.inputFingerprint !== plan.inputFingerprint) fail('operationId 已用于不同换件计划，拒绝重放');
			if (prior.status === 'confirmed' && prior.designVerified === true && prior.operationRecordConfirmed === true) return prior;
			if (prior.status === 'confirmed') return { ...prior, status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
				error: '操作记录缺少最终确认读回证明；拒绝重放' };
			fail(`operationId 已处于 ${prior.status}/${prior.phase}；先核实现场，不重放写入`);
		}
		let operation: ReplacementOperation = { operationId, planId, projectUuid: plan.projectUuid, status: 'not_started', phase: 'prepared',
			inputFingerprint: plan.inputFingerprint, writeAttempted: false, completed: [], stageResults: [] };
		await host.writeOperation(operation);
		const started = await host.readOperation(operationId);
		if (!started || stable(started) !== stable(operation)) fail('换件起始记录未通过读回');
		const results: unknown[] = operation.stageResults.map(item => item.result);
		let currentStageMayHaveWritten = false;
		const run = async (replacementIndex: number, stage: ReplacementStage, context: ReplacementStageContext = { operationId, previousResults: results }) => {
			await host.assertPlanStillCurrent(plan);
			const phase = `${replacementIndex}:${stage}${context.partIndex === undefined ? '' : `:${context.partIndex}`}`;
			const stageContext = { ...context, previousResults: deepFreeze(jsonClone(results)) };
			currentStageMayHaveWritten = isWriteStage(stage);
			await persist(operation, { status: 'running', phase, writeAttempted: currentStageMayHaveWritten });
			try {
				const result = await host.performStage(plan.prepared as Prepared, replacementIndex, stage, stageContext);
				// Stage results are operation evidence, so store a JSON snapshot rather than a live SDK object.
				const resultSnapshot = result === undefined ? null : jsonClone(result);
				results.push(resultSnapshot);
				currentStageMayHaveWritten = false;
				await persist(operation, { writeAttempted: false, completed: [...operation.completed, phase],
					stageResults: [...operation.stageResults, { phase, result: resultSnapshot }] });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const evidence=(error as {failureEvidence?:unknown}|null)?.failureEvidence;
				await persist(operation, { status: currentStageMayHaveWritten ? 'unknown' : (operation.completed.length ? 'partial' : 'not_started'),
					phase, error: message, writeAttempted: currentStageMayHaveWritten,
					...(evidence===undefined?{}:{failureEvidence:jsonClone(evidence)}) });
				throw error;
			}
		};
		let finalDesignVerified = false, finalVerificationResult: unknown;
		try {
			const prepared = plan.prepared as { replacements: Array<{ schematicParts: unknown[] }> };
			for (let index = 0; index < prepared.replacements.length; index++)
				for (const stage of STAGES) {
					const replacement = prepared.replacements[index] as { localRoutes?: unknown[] };
					if (stage === 'pcb_local_routes' && replacement.localRoutes?.length === 0) continue;
					await run(index, stage);
				}
			for (let index = 0; index < prepared.replacements.length; index++) {
				const parts = prepared.replacements[index].schematicParts;
				for (let partIndex = 0; partIndex < parts.length; partIndex++) {
					for (const stage of ['schematic_create_part', 'schematic_verify_part', 'schematic_delete_old_part', 'schematic_restore_properties', 'schematic_restore_association'] as const)
						await run(index, stage, { operationId, partIndex, partCount: parts.length, previousResults: results });
				}
			}
			await host.assertPlanStillCurrent(plan);
			const finalPhase = 'save_close_reopen';
			await persist(operation, { status: 'running', phase: finalPhase, writeAttempted: true });
			try {
				const closeReadback = await host.saveCloseReopen(plan.prepared as Prepared, deepFreeze(jsonClone(results)));
				const snapshot = closeReadback === undefined ? null : jsonClone(closeReadback);
				results.push(snapshot);
				await persist(operation, { writeAttempted: false, completed: [...operation.completed, finalPhase],
					stageResults: [...operation.stageResults, { phase: finalPhase, result: snapshot }] });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const evidence=(error as {failureEvidence?:unknown}|null)?.failureEvidence;
				await persist(operation, { status: 'unknown', phase: finalPhase, error: message, writeAttempted: true,
					...(evidence===undefined?{}:{failureEvidence:jsonClone(evidence)}) });
				throw error;
			}
			await host.assertPlanStillCurrent(plan);
			const result = await host.verifyFinal(plan.prepared as Prepared, deepFreeze(jsonClone(results)));
			finalDesignVerified = true;
			const resultSnapshot = finalVerificationResult = jsonClone(result);
			await persist(operation, { phase: 'verified', writeAttempted: false, designVerified: true, operationRecordConfirmed: false, result: resultSnapshot });
			try {
				return await persist(operation, { status: 'confirmed', phase: 'verified', writeAttempted: false,
					designVerified: true, operationRecordConfirmed: true, result: resultSnapshot });
			} catch (error) {
				const confirmationError = `设计已通过重开读回；操作确认记录未能读回：${error instanceof Error ? error.message : String(error)}`;
				try {
					return await persist(operation, { status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
						designVerified: true, operationRecordConfirmed: false, result: finalVerificationResult, error: confirmationError });
				} catch (fallbackError) {
					return { ...operation, status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
						designVerified: true, operationRecordConfirmed: false,
						error: `${confirmationError}；无法持久化unknown状态：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` };
				}
			}
		} catch (error) {
			if (finalDesignVerified) {
				const confirmationError = `设计已通过重开读回；操作确认记录未能读回：${error instanceof Error ? error.message : String(error)}`;
				try { return await persist(operation, { status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
					designVerified: true, operationRecordConfirmed: false, result: finalVerificationResult, error: confirmationError }); }
				catch (fallbackError) { return { ...operation, status: 'unknown', phase: 'confirmation_record_unconfirmed', writeAttempted: false,
					designVerified: true, operationRecordConfirmed: false,
					error: `${confirmationError}；无法持久化unknown状态：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` }; }
			}
			if (operation.status !== 'unknown' && operation.writeAttempted) return { ...operation, status: 'unknown', phase: `${operation.phase}_record_unconfirmed`,
				error: `${error instanceof Error ? error.message : String(error)}；状态记录未能确认，现场结果需查询核实` };
			if (operation.status !== 'unknown') {
				try { await persist(operation, { status: operation.completed.length ? 'partial' : 'not_started',
					phase: operation.phase, error: error instanceof Error ? error.message : String(error), writeAttempted: false,
					...(finalDesignVerified ? { designVerified: true } : {}) }); }
				catch (persistError) { return { ...operation, status: 'unknown', phase: `${operation.phase}_record_unconfirmed`, writeAttempted: false,
					error: `状态记录未能确认：${persistError instanceof Error ? persistError.message : String(persistError)}` }; }
			}
			return operation;
		}
	}
	return { prepareReplacement, executeReplacement, getReplacementOperation };
}

export const replacementStorageKeys = { plan: (id: string) => PLAN_PREFIX + id, operation: (id: string) => OP_PREFIX + id };
