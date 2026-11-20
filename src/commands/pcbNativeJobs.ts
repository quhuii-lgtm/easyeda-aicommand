import type { DocumentTargetIdentity, ICommandContext, ICommandDef } from '../engine/types';

type AnyRecord = Record<string, any>;

/**
 * The job API is present in the official pro-api-types 0.4.27 snapshot, but not in
 * this repository's installed SDK declaration. The current host returns a log
 * snapshot object (logs/result/progress), so retain that shape instead of assuming
 * the older declaration's array return. Keep this cast local and use lexical eda.
 */
interface NativePcbJobApi {
	startAutoRouting: (props: Record<string, unknown>) => Promise<{ jobId: string }>;
	getAutoJobStatus: (jobId: string) => Promise<NativePcbJobStatus | undefined>;
	getAutoJobLog: (jobId: string) => Promise<NativePcbJobLogSnapshot>;
	cancelAutoJob: (jobId: string) => Promise<boolean>;
}

interface NativePcbJobStatus {
	jobId: string;
	state: 'queued' | 'running' | 'completed' | 'canceled' | 'failed' | string;
	progress?: number;
	error?: { code?: string; message?: string };
	partial?: boolean;
}

interface NativePcbJobLogEntry {
	at: number;
	level: string;
	code?: string;
	message: string;
}

interface NativePcbJobLogSnapshot {
	logs: NativePcbJobLogEntry[];
	result: unknown | null;
	progress: unknown | null;
	[key: string]: unknown;
}

interface JobBinding {
	jobId: string;
	projectUuid: string;
	pcbUuid: string;
}

interface NormalizedJobStatus extends JobBinding {
	state: string;
	exists?: boolean | null;
	progress?: number;
	error?: { code?: string; message?: string };
	partial?: boolean;
	stopped: boolean;
	note?: string;
	rawState?: string;
}

const SYSTEM_KEYS = new Set(['instanceId', '__docUuid', '__tabId', '__projectUuid', '_timeoutMs']);
const JOB_STATES = new Set(['queued', 'running', 'completed', 'canceled', 'failed']);

function validateKeys(params: AnyRecord, allowed: string[]): void {
	for (const key of Object.keys(params)) {
		if (!allowed.includes(key) && !SYSTEM_KEYS.has(key) && !key.startsWith('__'))
			throw new Error(`未知参数: ${key}`);
	}
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`${label}必须是非空字符串`);
	return value;
}

function nativeApi(): NativePcbJobApi {
	return eda.pcb_Document as unknown as NativePcbJobApi;
}

interface NativePcbNetApi {
	getAllNetsName: () => Promise<unknown>;
}

function nativeNetApi(): NativePcbNetApi {
	return eda.pcb_Net as unknown as NativePcbNetApi;
}

function getBinding(ctx: ICommandContext, params: AnyRecord, includeJobId: boolean): JobBinding | Omit<JobBinding, 'jobId'> {
	const target = ctx.documentTarget as DocumentTargetIdentity | undefined;
	if (!target || target.documentType !== 3)
		throw new Error('缺少当前 PCB 文档目标，未调用原生任务接口');
	const pcbUuid = requireNonEmptyString(target.uuid, '当前 PCB UUID');
	const projectUuid = requireNonEmptyString(target.parentProjectUuid, '当前 PCB 所属工程 UUID');
	const requestedProject = params.projectUuid;
	const requestedPcb = params.pcbUuid;
	if (includeJobId) {
		requireNonEmptyString(params.jobId, 'jobId');
		if (params.jobId.trim() !== params.jobId)
			throw new Error('jobId 不得包含首尾空白');
	}
	if (requestedProject !== undefined && requireNonEmptyString(requestedProject, 'projectUuid') !== projectUuid)
		throw new Error(`当前 PCB 所属工程与任务绑定不符（当前=${projectUuid}，任务=${requestedProject}）`);
	if (requestedPcb !== undefined && requireNonEmptyString(requestedPcb, 'pcbUuid') !== pcbUuid)
		throw new Error(`当前 PCB 与任务绑定不符（当前=${pcbUuid}，任务=${requestedPcb}）`);
	if (includeJobId && (requestedProject === undefined || requestedPcb === undefined))
		throw new Error('恢复任务必须同时提供 projectUuid 和 pcbUuid；可使用启动结果中的 binding 对象字段');
	return includeJobId
		? { jobId: params.jobId, projectUuid, pcbUuid }
		: { projectUuid, pcbUuid };
}

async function assertTarget(ctx: ICommandContext): Promise<void> {
	ctx.stopSignal?.assertActive();
	if (!ctx.assertDocumentTarget)
		throw new Error('缺少文档目标守卫，拒绝调用原生 PCB 任务接口');
	await ctx.assertDocumentTarget();
	ctx.stopSignal?.assertActive();
}

function validateRouteParams(params: AnyRecord): Record<string, unknown> {
	validateKeys(params, ['RoutingNets', 'cornerStyle', 'existingPrimitiveMode', 'optimization', 'layers', 'ignoreNets']);
	if (!Array.isArray(params.RoutingNets) || params.RoutingNets.length === 0
		|| params.RoutingNets.some((net: unknown) => typeof net !== 'string' || !net.trim() || net !== net.trim())) {
		throw new Error('RoutingNets 必须是非空网络名数组；本命令不接受未指定网络或“全部未布线网络”');
	}
	if (new Set(params.RoutingNets).size !== params.RoutingNets.length)
		throw new Error('RoutingNets 不得包含重复网络名');
	if (params.cornerStyle !== undefined && ![0, 1].includes(params.cornerStyle))
		throw new Error('cornerStyle 仅支持 0（45度）或 1（90度）');
	const mode = params.existingPrimitiveMode ?? 'keep';
	if (mode !== 'keep' && mode !== 'remove')
		throw new Error('existingPrimitiveMode 仅支持 keep 或 remove');
	if (params.optimization !== undefined && ![0, 1].includes(params.optimization))
		throw new Error('optimization 仅支持 0（速度）或 1（布通率）');
	if (params.layers !== undefined && (!Array.isArray(params.layers) || params.layers.some((layer: unknown) => typeof layer !== 'number' || !Number.isFinite(layer))))
		throw new Error('layers 必须是有限数值数组，表示实际铜层 ID');
	if (params.ignoreNets !== undefined && (!Array.isArray(params.ignoreNets) || params.ignoreNets.some((net: unknown) => typeof net !== 'string')))
		throw new Error('ignoreNets 必须是字符串数组');
	return {
		RoutingNets: [...params.RoutingNets],
		cornerStyle: params.cornerStyle,
		existingPrimitiveMode: mode,
		optimization: params.optimization,
		layers: params.layers === undefined ? undefined : [...params.layers],
		ignoreNets: params.ignoreNets === undefined ? undefined : [...params.ignoreNets],
	};
}

function validateBindingParams(params: AnyRecord): JobBinding {
	validateKeys(params, ['jobId', 'projectUuid', 'pcbUuid']);
	const jobId = requireNonEmptyString(params.jobId, 'jobId');
	const projectUuid = requireNonEmptyString(params.projectUuid, 'projectUuid');
	const pcbUuid = requireNonEmptyString(params.pcbUuid, 'pcbUuid');
	if (jobId !== jobId.trim() || projectUuid !== projectUuid.trim() || pcbUuid !== pcbUuid.trim())
		throw new Error('jobId、projectUuid、pcbUuid 不得包含首尾空白');
	return { jobId, projectUuid, pcbUuid };
}

function normalizeStatus(raw: NativePcbJobStatus | undefined, binding: JobBinding): NormalizedJobStatus {
	if (raw === undefined || raw === null)
		return { ...binding, state: 'unknown', exists: false, stopped: false, note: '宿主当前查不到此任务；不能据此判断它已完成或已停止。请确认当前工程/PCB与启动时相同。' };
	if (raw.jobId !== binding.jobId)
		throw new Error(`宿主状态返回的 jobId 不符（返回=${String(raw.jobId)}，请求=${binding.jobId}）`);
	if (!JOB_STATES.has(raw.state))
		return { ...binding, state: 'unknown', exists: true, stopped: false, rawState: raw.state, note: '宿主返回了未识别状态，未推断任务是否完成或停止' };
	return {
		...binding,
		state: raw.state,
		exists: true,
		progress: raw.progress,
		error: raw.error,
		partial: raw.partial,
		stopped: raw.state === 'canceled',
	};
}

async function runStart(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} };
	const route = validateRouteParams(params);
	const binding = getBinding(ctx, params, false);
	await assertTarget(ctx);
	let rawNetNames: unknown;
	let netReadError: unknown;
	try {
		rawNetNames = await nativeNetApi().getAllNetsName();
	}
	catch (error) {
		netReadError = error;
	}
	await assertTarget(ctx);
	if (netReadError)
		throw new Error(`读取当前 PCB 网络列表失败，未启动原生自动布线：${netReadError instanceof Error ? netReadError.message : String(netReadError)}`);
	if (!Array.isArray(rawNetNames) || rawNetNames.some(net => typeof net !== 'string' || (net.trim() !== '' && net !== net.trim())))
		throw new Error('当前 PCB 网络列表不是完整的具名网络数组，未启动原生自动布线');
	const routeNets = route.RoutingNets as string[];
	const explicitIgnoreNets = (route.ignoreNets as string[] | undefined) ?? [];
	const excluded = new Set([...routeNets, ...explicitIgnoreNets]);
	const addedIgnoreNets: string[] = [];
	for (const net of rawNetNames as string[]) {
		if (net.trim() && !excluded.has(net)) {
			excluded.add(net);
			addedIgnoreNets.push(net);
		}
	}
	route.ignoreNets = [...explicitIgnoreNets, ...addedIgnoreNets];
	let rawHandle: { jobId: string };
	try {
		// A rejection after dispatch has an unknown outcome. Never retry start automatically.
		rawHandle = await nativeApi().startAutoRouting(route);
	}
	catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error), {
			cause: { partial: true, status: 'unknown', retryable: false, phase: 'startAutoRouting', jobBinding: binding, note: '原生启动请求已发出但没有收到句柄；不要重发启动，先人工核对任务与板面' },
		});
	}
	const jobId = rawHandle?.jobId;
	if (typeof jobId !== 'string' || !jobId.trim()) {
		throw new Error('原生启动调用未返回有效 jobId；启动结果未知，禁止自动重发', {
			cause: { partial: true, status: 'unknown', retryable: false, phase: 'startAutoRouting.handle', jobBinding: binding },
		});
	}
	const fullBinding: JobBinding = { ...binding, jobId };
	try {
		await assertTarget(ctx);
	}
	catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error), {
			cause: { partial: true, status: 'unknown', retryable: false, phase: 'startAutoRouting.afterStart', jobBinding: fullBinding, note: '已取得任务句柄；当前焦点身份变化，切回该工程与PCB后用 binding 查询' },
		});
	}
	let initialStatus: NormalizedJobStatus;
	let statusReadError: string | undefined;
	try {
		await assertTarget(ctx);
		initialStatus = normalizeStatus(await nativeApi().getAutoJobStatus(jobId), fullBinding);
		await assertTarget(ctx);
	}
	catch (error) {
		initialStatus = { ...fullBinding, state: 'unknown', stopped: false, note: '任务句柄已取得，但首次状态读取失败；不能据此判断任务是否存在或已结束。仅查询这个 binding，不要再次启动。' };
		statusReadError = error instanceof Error ? error.message : String(error);
	}
	return {
		...initialStatus,
		binding: fullBinding,
		launch: 'started',
		routingNets: route.RoutingNets,
		existingPrimitiveMode: route.existingPrimitiveMode,
		...(statusReadError ? { statusReadError } : {}),
		note: statusReadError ? `${initialStatus.note ?? ''}；可用 binding 调用状态查询，不要再次启动。` : initialStatus.note,
	};
}

async function runStatus(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} };
	const binding = validateBindingParams(params);
	const current = getBinding(ctx, params, true) as JobBinding;
	if (current.projectUuid !== binding.projectUuid || current.pcbUuid !== binding.pcbUuid)
		throw new Error('当前工程或 PCB 与传入任务 binding 不一致；未查询其他工程中的任务');
	await assertTarget(ctx);
	const raw = await nativeApi().getAutoJobStatus(binding.jobId);
	await assertTarget(ctx);
	const status = normalizeStatus(raw, binding);
	return { ...status, queried: true, note: status.note ?? '状态来自原生任务查询；completed 只表示引擎任务结束，不等同于 DRC 或整板验收通过' };
}

async function runLog(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} };
	const binding = validateBindingParams(params);
	const current = getBinding(ctx, params, true) as JobBinding;
	if (current.projectUuid !== binding.projectUuid || current.pcbUuid !== binding.pcbUuid)
		throw new Error('当前工程或 PCB 与传入任务 binding 不一致；未读取其他工程中的日志');
	await assertTarget(ctx);
	const snapshot = await nativeApi().getAutoJobLog(binding.jobId);
	await assertTarget(ctx);
	if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.logs))
		throw new Error('原生任务日志未返回带 logs 数组的快照对象');
	return {
		...binding,
		snapshot,
		logs: snapshot.logs,
		result: snapshot.result,
		progress: snapshot.progress,
		count: snapshot.logs.length,
	};
}

async function runStop(params: AnyRecord, context?: ICommandContext) {
	const ctx = context ?? { vars: {} };
	const binding = validateBindingParams(params);
	const current = getBinding(ctx, params, true) as JobBinding;
	if (current.projectUuid !== binding.projectUuid || current.pcbUuid !== binding.pcbUuid)
		throw new Error('当前工程或 PCB 与传入任务 binding 不一致；未向其他工程发送停止请求');
	await assertTarget(ctx);
	let cancelRequestAccepted: boolean;
	try {
		cancelRequestAccepted = await nativeApi().cancelAutoJob(binding.jobId);
	}
	catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error), {
			cause: { partial: true, status: 'unknown', retryable: false, phase: 'cancelAutoJob', jobBinding: binding, note: '停止请求结果未知；先查询状态，不要盲目重发停止请求' },
		});
	}
	try {
		await assertTarget(ctx);
		const status = normalizeStatus(await nativeApi().getAutoJobStatus(binding.jobId), binding);
		await assertTarget(ctx);
		return {
			...status,
			cancelRequestAccepted,
			stopped: status.state === 'canceled',
			cancellationPending: cancelRequestAccepted && (status.state === 'queued' || status.state === 'running'),
			note: status.state === 'canceled'
				? '原生任务状态已确认 canceled'
				: status.state === 'queued' || status.state === 'running'
					? `取消请求${cancelRequestAccepted ? '已接受' : '未被接受'}，但原生任务仍是 ${status.state}；尚未确认停止`
					: status.state === 'unknown'
						? `取消请求${cancelRequestAccepted ? '已接受' : '未被接受'}，但任务状态未知；不能声称已停止`
						: `取消请求${cancelRequestAccepted ? '已接受' : '未被接受'}；最终状态为 ${status.state}，停止状态以原生查询为准`,
		};
	}
	catch (error) {
		if ((error as any)?.cause?.partial)
			throw error;
		throw new Error(error instanceof Error ? error.message : String(error), {
			cause: { partial: true, status: 'unknown', retryable: false, phase: 'cancelAutoJob.readback', cancelRequestAccepted, jobBinding: binding, note: '取消请求已返回，但任务状态无法读回；不要据此声称已停止' },
		});
	}
}

export const pcbNativeJobCommands: ICommandDef[] = [
	{
		name: 'pcb.nativeAutoRouteStart',
		summary: '启动 EDA 原生后台自动布线任务；返回当前页面会话可用的工程、PCB和任务绑定',
		params: [
			{ name: 'RoutingNets', type: 'string[]', required: true, description: '必须明确指定一个或多个网络名；不支持省略为全部未布线网络' },
			{ name: 'cornerStyle', type: 'number', description: '拐角风格：0=45度，1=90度；省略使用宿主默认' },
			{ name: 'existingPrimitiveMode', type: 'string', description: '已有导线/过孔处理方式：keep（默认，保留）或 remove（移除）' },
			{ name: 'optimization', type: 'number', description: '优化目标：0=速度，1=布通率；省略使用宿主默认' },
			{ name: 'layers', type: 'number[]', description: '允许使用的实际铜层 ID 数组；省略使用当前 PCB 可用信号层' },
			{ name: 'ignoreNets', type: 'string[]', description: '明确排除的网络名数组' },
		],
		returns: '{ jobId, projectUuid, pcbUuid, binding, state, progress }',
		example: { cmd: 'pcb.nativeAutoRouteStart', params: { RoutingNets: ['GND'], cornerStyle: 0, existingPrimitiveMode: 'keep', optimization: 1 } },
		handler: runStart,
	},
	{
		name: 'pcb.nativeAutoRouteStatus',
		summary: '在当前页面会话按工程与 PCB 查询原生自动布线；页面刷新后不能依赖旧任务 ID，查不到时返回 unknown',
		params: [
			{ name: 'jobId', type: 'string', required: true, description: '启动结果返回的 jobId' },
			{ name: 'projectUuid', type: 'string', required: true, description: '启动结果 binding.projectUuid' },
			{ name: 'pcbUuid', type: 'string', required: true, description: '启动结果 binding.pcbUuid' },
		],
		returns: '{ jobId, projectUuid, pcbUuid, state: queued|running|completed|canceled|failed|unknown, progress, stopped }；jobId 仅限当前页面会话使用，刷新后查不到时为 unknown',
		example: { cmd: 'pcb.nativeAutoRouteStatus', params: { jobId: 'job-id', projectUuid: 'project-uuid', pcbUuid: 'pcb-uuid' } },
		handler: runStatus,
	},
	{
		name: 'pcb.nativeAutoRouteStop',
		summary: '请求停止 EDA 原生自动布线，并查询实际状态；取消请求被接受不代表任务已停止',
		params: [
			{ name: 'jobId', type: 'string', required: true, description: '启动结果返回的 jobId' },
			{ name: 'projectUuid', type: 'string', required: true, description: '启动结果 binding.projectUuid' },
			{ name: 'pcbUuid', type: 'string', required: true, description: '启动结果 binding.pcbUuid' },
		],
		returns: '{ cancelRequestAccepted, state, stopped, cancellationPending, jobId, projectUuid, pcbUuid }',
		example: { cmd: 'pcb.nativeAutoRouteStop', params: { jobId: 'job-id', projectUuid: 'project-uuid', pcbUuid: 'pcb-uuid' } },
		handler: runStop,
	},
	{
		name: 'pcb.nativeAutoRouteLog',
		summary: '读取指定工程和 PCB 下的 EDA 原生自动布线任务日志',
		params: [
			{ name: 'jobId', type: 'string', required: true, description: '启动结果返回的 jobId' },
			{ name: 'projectUuid', type: 'string', required: true, description: '启动结果 binding.projectUuid' },
			{ name: 'pcbUuid', type: 'string', required: true, description: '启动结果 binding.pcbUuid' },
		],
		returns: '{ jobId, projectUuid, pcbUuid, snapshot: { logs, result, progress }, logs, result, progress, count }',
		example: { cmd: 'pcb.nativeAutoRouteLog', params: { jobId: 'job-id', projectUuid: 'project-uuid', pcbUuid: 'pcb-uuid' } },
		handler: runLog,
	},
];
