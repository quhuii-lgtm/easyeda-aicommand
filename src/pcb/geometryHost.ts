import { parseSourceLog } from './sourcelog';

const DEFAULT_BUDGET_MS = 290_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface GeometryHost {
	documentUuid: string;
	sdk: any;
	read: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
	write: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
	checkBudget: () => void;
	recordCreated: (id: string) => void;
	recordVerified: (id: string) => void;
	getBaseline: () => Promise<{ source: string; rules: unknown }>;
	assertBaseline: (baseline: { source: string; rules: unknown }) => Promise<void>;
	finish: () => Promise<void>;
	fail: (error: unknown, extra?: Record<string, unknown>) => never;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function stableValue(value: any): any {
	if (Array.isArray(value))
		return value.map(stableValue);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort())
			out[key] = stableValue(value[key]);
		return out;
	}
	return value;
}

function comparable(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || (Object.getPrototypeOf(prototype) === null && prototype.constructor?.name === 'Object');
}

/** Create the shared focus and monotonic-budget guard for one geometry operation. */
export async function createGeometryHost(sdk: any, params: Record<string, any>, expectedUuid?: string): Promise<GeometryHost> {
	const hasParameterUuid = Object.hasOwn(params, '__docUuid');
	const parameterUuid = params.__docUuid;
	if (hasParameterUuid && (typeof parameterUuid !== 'string' || parameterUuid.length === 0))
		throw new Error('__docUuid 若提供，必须是非空字符串');
	if (expectedUuid !== undefined && (typeof expectedUuid !== 'string' || expectedUuid.length === 0))
		throw new Error('expectedUuid 若提供，必须是非空字符串');
	if (expectedUuid !== undefined && hasParameterUuid && expectedUuid !== parameterUuid)
		throw new Error('expectedUuid 与 __docUuid 不一致');
	let documentUuid: string | undefined = expectedUuid ?? (hasParameterUuid ? parameterUuid : undefined);
	const requestedBudget = params._timeoutMs == null ? DEFAULT_BUDGET_MS : Number(params._timeoutMs);
	if (!Number.isFinite(requestedBudget) || requestedBudget > MAX_TIMER_MS)
		throw new Error(`_timeoutMs 必须是有限且不超过 ${MAX_TIMER_MS}ms 的数值`);
	const budgetMs = Math.max(1000, requestedBudget);
	const deadline = performance.now() + budgetMs;
	const createdIds: string[] = [];
	const verifiedIds: string[] = [];
	let writeAttempted = false;
	let failure: Error | undefined;
	let failureStep: string | undefined;
	let failureStepAttempted = false;
	let currentStep = '几何操作开始';
	let currentStepAttempted = false;
	let queue: Promise<unknown> = Promise.resolve();

	const latch = (error: unknown, step = currentStep, attempted = currentStepAttempted): Error => {
		if (!failure) {
			failure = asError(error);
			failureStep = step;
			failureStepAttempted = attempted;
		}
		return failure;
	};
	const assertAvailable = (): number => {
		if (failure)
			throw failure;
		const remaining = deadline - performance.now();
		if (remaining <= 0)
			throw latch(new Error(`几何操作超过共享 ${budgetMs}ms 时间预算，停止后续 SDK 调用`));
		return remaining;
	};
	const invoke = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
		const remaining = assertAvailable();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let result: T;
		try {
			result = await Promise.race([
				Promise.resolve().then(fn),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`${label} 超过共享剩余预算，结果未知`)), remaining);
				}),
			]);
		}
		catch (error) {
			throw latch(error, label, currentStepAttempted);
		}
		finally {
			if (timer != null)
				clearTimeout(timer);
		}
		assertAvailable();
		return result;
	};
	const checkFocus = async (stage: string): Promise<void> => {
		const focusStep = `${stage} 焦点核对`;
		const previousStep = currentStep;
		const previousAttempted = currentStepAttempted;
		currentStep = focusStep;
		currentStepAttempted = false;
		let focus: any;
		try {
			focus = await invoke(focusStep, () => sdk.dmt_SelectControl.getCurrentDocumentInfo());
		}
		catch (error) {
			throw latch(error, focusStep, false);
		}
		if (focus?.documentType !== 3 || typeof focus.uuid !== 'string' || !focus.uuid)
			throw latch(new Error(`${stage} 时没有有效的 PCB 焦点，停止后续操作`), focusStep, false);
		if (documentUuid === undefined)
			documentUuid = focus.uuid;
		else if (focus.uuid !== documentUuid)
			throw latch(new Error(`${stage} 时焦点已离开 PCB ${documentUuid}，停止后续操作`), focusStep, false);
		currentStep = previousStep;
		currentStepAttempted = previousAttempted;
	};
	const guarded = <T>(kind: 'read' | 'write', label: string, fn: () => Promise<T> | T): Promise<T> => {
		const operation = queue.then(async () => {
			currentStep = label;
			currentStepAttempted = false;
			assertAvailable();
			await checkFocus(`${label} 前`);
			let value: T | undefined;
			let operationError: unknown;
			let operationFailed = false;
			try {
				value = await invoke(label, () => {
					currentStep = label;
					currentStepAttempted = kind === 'write';
					if (kind === 'write') {
						writeAttempted = true;
					}
					return fn();
				});
				if (kind === 'write' && value && typeof value === 'object') {
					const getId = (value as any).getState_PrimitiveId;
					if (typeof getId === 'function') {
						const id = Reflect.apply(getId, value, []);
						if (typeof id === 'string' && id.length > 0 && !createdIds.includes(id))
							createdIds.push(id);
					}
				}
			}
			catch (error) {
				operationFailed = true;
				operationError = error;
			}
			await checkFocus(`${label} 后`);
			if (operationFailed)
				throw latch(operationError);
			return value as T;
		});
		queue = operation.then(() => undefined, () => undefined);
		return operation;
	};
	const stripDocHead = (source: unknown): string => {
		if (typeof source !== 'string')
			throw new Error('getDocumentSource 返回空或非字符串值');
		const document = parseSourceLog(source);
		if (document.uuid !== documentUuid || document.docType.toUpperCase() !== 'PCB')
			throw new Error(`源码 DOCHEAD 与 PCB ${documentUuid} 不符`);
		return document.records.filter(record => record.header.type !== 'DOCHEAD').map(record => record.raw).join('\n');
	};
	const readBaseline = async (): Promise<{ source: string; rules: unknown }> => {
		const strippedSource = await guarded('read', '读取几何基线源码', async () => stripDocHead(await sdk.sys_FileManager.getDocumentSource()));
		const rules = await guarded('read', '读取 PCB DRC 规则', async () => {
			const current = await sdk.pcb_Drc.getCurrentRuleConfiguration();
			if (!isPlainObject(current) || Object.keys(current).length === 0)
				throw new Error('pcb_Drc.getCurrentRuleConfiguration 必须返回非空普通对象');
			return stableValue(current);
		});
		return { source: strippedSource, rules };
	};

	await checkFocus('几何操作开始');
	const host: GeometryHost = {
		documentUuid: documentUuid!,
		sdk,
		read: <T>(label: string, fn: () => Promise<T> | T) => guarded('read', label, fn),
		write: <T>(label: string, fn: () => Promise<T> | T) => guarded('write', label, fn),
		checkBudget: () => { assertAvailable(); },
		recordCreated: (id: string) => {
			if (!createdIds.includes(id))
				createdIds.push(id);
		},
		recordVerified: (id: string) => {
			if (!verifiedIds.includes(id))
				verifiedIds.push(id);
		},
		getBaseline: readBaseline,
		assertBaseline: async (baseline) => {
			if (!isPlainObject(baseline) || typeof baseline.source !== 'string' || !isPlainObject(baseline.rules) || Object.keys(baseline.rules).length === 0)
				throw latch(new Error('几何操作基线结构非法'), 'assertBaseline 输入', false);
			const current = await readBaseline();
			if (current.source !== baseline.source || comparable(current.rules) !== comparable(baseline.rules))
				throw latch(new Error('几何操作基线已变化，停止执行'), 'assertBaseline', false);
		},
		finish: async () => {
			assertAvailable();
			await checkFocus('几何操作结束');
			assertAvailable();
		},
		fail: (error, extra = {}) => {
			const wrapped = asError(error) as Error & { cause?: unknown };
			if (!writeAttempted)
				throw wrapped;
			wrapped.cause = {
				...(wrapped.cause && typeof wrapped.cause === 'object' ? wrapped.cause as Record<string, unknown> : {}),
				...extra,
				partial: true,
				createdIds: [...createdIds],
				verifiedIds: [...verifiedIds],
				failedStep: typeof extra.failedStep === 'string' ? extra.failedStep : failureStep ?? currentStep ?? wrapped.message,
				failedStepAttempted: typeof extra.failedStepAttempted === 'boolean' ? extra.failedStepAttempted : failure ? failureStepAttempted : currentStepAttempted,
				retryable: false,
				saved: false,
			};
			throw wrapped;
		},
	};
	return host;
}
