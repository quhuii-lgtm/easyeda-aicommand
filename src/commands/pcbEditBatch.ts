import type { ICommandContext, ICommandDef, ICommandRequest, TCommandResult } from '../engine/types';
import { compareDocumentSources } from '../engine/documentRecovery';
import { executeCommand, hasCommand } from '../engine/registry';
import { parseSourceLog } from '../pcb/sourcelog';
import { pcbPlacementPrimitiveCommands } from './pcbPlacementPrimitives';

interface CommandGroupApi {
	beginCommandGroup: (name?: string) => Promise<{ groupId?: unknown } | undefined> | { groupId?: unknown } | undefined;
	commitCommandGroup: (groupId: string) => Promise<boolean> | boolean;
	rollbackCommandGroup: (groupId: string) => Promise<boolean> | boolean;
}

interface EditStep {
	cmd: string;
	params?: Record<string, unknown>;
}

interface PreparedStep {
	cmd: string;
	params: Record<string, unknown>;
}

const placementPrimitiveWriteCommands = new Set(pcbPlacementPrimitiveCommands
	.map(command => command.name)
	.filter(name => /^pcb\.(?:place|modify)/.test(name)));

function commandGroupApi(): CommandGroupApi {
	return eda.pcb_Document as unknown as CommandGroupApi;
}

function assertTargetContext(ctx?: ICommandContext): asserts ctx is ICommandContext & {
	documentTarget: NonNullable<ICommandContext['documentTarget']>;
	assertDocumentTarget: () => Promise<void>;
} {
	if (ctx?.documentTarget?.documentType !== 3 || !ctx.documentTarget.uuid || !ctx.assertDocumentTarget)
		throw new Error('缺少当前 PCB 目标身份校验，拒绝执行批量操作');
	if (typeof ctx.documentTarget.tabId !== 'string' || !ctx.documentTarget.tabId.trim()
		|| typeof ctx.documentTarget.parentProjectUuid !== 'string' || !ctx.documentTarget.parentProjectUuid.trim()) {
		throw new Error('当前 PCB 未提供有效工程和页签身份，拒绝执行批量操作');
	}
}

function prepareSteps(value: unknown, ctx: ICommandContext): PreparedStep[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error('steps 必须是非空数组');
	return value.map((raw: EditStep, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.cmd !== 'string' || !raw.cmd.trim())
			throw new Error(`第 ${index + 1} 步缺少有效 cmd`);
		if (!placementPrimitiveWriteCommands.has(raw.cmd))
			throw new Error(`第 ${index + 1} 步命令 ${raw.cmd} 不在批量编辑白名单中`);
		if (!hasCommand(raw.cmd))
			throw new Error(`第 ${index + 1} 步命令 ${raw.cmd} 尚未注册`);
		if (raw.params !== undefined && (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)))
			throw new Error(`第 ${index + 1} 步 params 必须是对象`);
		const params = { ...(raw.params ?? {}) };
		const expectedTarget: Record<string, unknown> = {
			__docUuid: ctx.documentTarget?.uuid,
			__projectUuid: ctx.documentTarget?.parentProjectUuid,
			__tabId: ctx.documentTarget?.tabId,
		};
		for (const [key, value] of Object.entries(expectedTarget)) {
			if (params[key] !== undefined && params[key] !== value)
				throw new Error(`第 ${index + 1} 步 ${key} 与批量目标不一致`);
			params[key] = value;
		}
		return { cmd: raw.cmd, params };
	});
}

async function readTargetSource(ctx: ICommandContext): Promise<string> {
	await ctx.assertDocumentTarget?.();
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim())
		throw new Error('PCB 源码读回为空');
	const document = parseSourceLog(source);
	if (document.docType !== 'PCB' || document.uuid !== ctx.documentTarget?.uuid)
		throw new Error(`PCB 源码身份与批量目标不一致（source=${document.uuid}, target=${ctx.documentTarget?.uuid ?? 'unknown'}）`);
	await ctx.assertDocumentTarget?.();
	return source;
}

function errorCause(result: TCommandResult): Record<string, unknown> | undefined {
	const cause = result.ok ? undefined : (result.error as { cause?: unknown } | undefined)?.cause;
	if (!cause || typeof cause !== 'object' || Array.isArray(cause))
		return undefined;
	return cause as Record<string, unknown>;
}

function unknownFailure(result: TCommandResult): boolean {
	if (result.ok)
		return false;
	const cause = errorCause(result);
	return cause?.partial === true || cause?.status === 'unknown' || cause?.source === 'heartbeat-fuse'
		|| /超时|timeout/i.test(result.error.message);
}

function failure(label: string, cause: Record<string, unknown>): Error {
	return new Error(label, { cause });
}

export const pcbEditBatchCommands: ICommandDef[] = [
	{
		name: 'pcb.runEditBatch',
		summary: '把多个 PCB 放置和属性修改步骤作为一个撤销组执行；默认仅预演，不写入。',
		params: [
			{ name: 'steps', type: 'array', required: true, description: '按顺序执行的 {cmd,params} 步骤；仅支持 PCB 图元放置和属性修改命令。' },
			{ name: 'name', type: 'string', description: '可选撤销组名称。' },
			{ name: 'dryRun', type: 'boolean', description: '默认 true，只检查目标、注册状态和命令白名单；设为 false 才实际执行。' },
			{ name: '__docUuid', type: 'string', description: '可选目标 PCB 页 UUID。' },
			{ name: '__projectUuid', type: 'string', description: '可选目标工程 UUID。' },
		],
		returns: '预演返回可执行步骤；执行返回各步真实回执、groupId 和 committed。此指令不运行 DRC。',
		example: { cmd: 'pcb.runEditBatch', params: { steps: [{ cmd: 'pcb.placeArc', params: { net: '', layer: 3, startX: 100, startY: 100, endX: 120, endY: 100, arcAngle: 90 } }] } },
		handler: async (params, ctx) => {
			const allowedParams = new Set(['steps', 'name', 'dryRun', '__docUuid', '__projectUuid', '__tabId', '_timeoutMs']);
			const unexpected = Object.keys(params).filter(key => !allowedParams.has(key));
			if (unexpected.length)
				throw new Error(`不支持的批量编辑参数：${unexpected.join(', ')}`);
			assertTargetContext(ctx);
			if (params.__docUuid !== undefined && params.__docUuid !== ctx.documentTarget.uuid)
				throw new Error('__docUuid 与当前批量目标不一致');
			if (params.__projectUuid !== undefined && params.__projectUuid !== ctx.documentTarget.parentProjectUuid)
				throw new Error('__projectUuid 与当前批量目标不一致');
			if (params.__tabId !== undefined && params.__tabId !== ctx.documentTarget.tabId)
				throw new Error('__tabId 与当前批量目标不一致');
			if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim()))
				throw new Error('name 必须是非空字符串');
			if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
				throw new Error('dryRun 必须是布尔值');
			const steps = prepareSteps(params.steps, ctx);
			await ctx.assertDocumentTarget();
			const beforeSource = await readTargetSource(ctx);
			if (params.dryRun !== false)
				return { dryRun: true, target: ctx.documentTarget, steps: steps.map(({ cmd, params: stepParams }) => ({ cmd, params: stepParams })), groupStarted: false, committed: false };

			const api = commandGroupApi();
			ctx.stopSignal?.assertActive();
			await ctx.assertDocumentTarget();
			let group: { groupId?: unknown } | undefined;
			try {
				group = await api.beginCommandGroup(params.name as string | undefined);
			}
			catch (error) {
				throw failure(`开始 PCB 命令组结果未知；没有继续执行步骤。${error instanceof Error ? error.message : String(error)}`, { partial: true, status: 'unknown', retryable: false, phase: 'begin' });
			}
			const groupId = typeof group?.groupId === 'string' && group.groupId.trim() ? group.groupId : undefined;
			if (!groupId)
				throw failure('开始 PCB 命令组未返回有效 ID；结果未知，未继续执行步骤。', { partial: true, status: 'unknown', retryable: false, phase: 'begin' });

			const receipts: Array<{ cmd: string; result: TCommandResult }> = [];
			let lastSuccessfulSource = beforeSource;
			try {
				for (const [index, step] of steps.entries()) {
					ctx.stopSignal?.assertActive();
					await ctx.assertDocumentTarget();
					const currentBeforeStep = await readTargetSource(ctx);
					const stable = compareDocumentSources(lastSuccessfulSource, currentBeforeStep);
					if (!stable.equal)
						throw failure(`第 ${index + 1} 步开始前 PCB 源码已偏离上一已确认状态，停止批量操作。`, { partial: true, status: 'unknown', retryable: false, groupId, phase: 'pre-step-source', difference: stable.difference });
					ctx.onProgress?.({ stage: 'pcb-edit-batch-step', step: index + 1, total: steps.length, cmd: step.cmd, groupId });
					const result = await executeCommand({ cmd: step.cmd, params: step.params } as ICommandRequest, ctx);
					receipts.push({ cmd: step.cmd, result });
					if (!result.ok) {
						if (unknownFailure(result))
							throw failure(`第 ${index + 1} 步 ${step.cmd} 的结果不确定；保留现场，不回滚、不重试。`, { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, receipts });
						let failedSource: string;
						try {
							failedSource = await readTargetSource(ctx);
						}
						catch (error) {
							throw failure(`第 ${index + 1} 步失败后无法安全读取目标源码；保留现场，不回滚。${error instanceof Error ? error.message : String(error)}`, { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, receipts });
						}
						const failedStepComparison = compareDocumentSources(lastSuccessfulSource, failedSource);
						if (!failedStepComparison.equal)
							throw failure(`第 ${index + 1} 步 ${step.cmd} 失败后 PCB 源码发生变化；保留现场，不回滚。`, { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, difference: failedStepComparison.difference, receipts });
						ctx.stopSignal?.assertActive();
						await ctx.assertDocumentTarget();
						let rolledBack: boolean;
						try {
							rolledBack = await api.rollbackCommandGroup(groupId);
						}
						catch (error) {
							throw failure(`步骤失败后撤销组结果未知；保留现场。${error instanceof Error ? error.message : String(error)}`, { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, receipts });
						}
						if (rolledBack !== true)
							throw failure('步骤失败后宿主未确认撤销组成功；保留现场。', { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, receipts });
						const afterRollback = await readTargetSource(ctx);
						const rollbackComparison = compareDocumentSources(beforeSource, afterRollback);
						if (!rollbackComparison.equal)
							throw failure('宿主报告撤销成功，但完整 PCB 源码与批量操作前不一致；保留现场。', { partial: true, status: 'unknown', retryable: false, groupId, failedStep: index + 1, difference: rollbackComparison.difference, receipts });
						throw failure(`第 ${index + 1} 步 ${step.cmd} 失败；撤销组已完成，PCB 源码与批前一致。`, { partial: false, status: 'rolled-back', retryable: true, groupId, failedStep: index + 1, receipts });
					}
					ctx.stopSignal?.assertActive();
					await ctx.assertDocumentTarget();
					lastSuccessfulSource = await readTargetSource(ctx);
				}

				ctx.stopSignal?.assertActive();
				await ctx.assertDocumentTarget();
				let committed: boolean;
				try {
					committed = await api.commitCommandGroup(groupId);
				}
				catch (error) {
					throw failure(`提交 PCB 命令组结果未知；不执行回滚或后续操作。${error instanceof Error ? error.message : String(error)}`, { partial: true, status: 'unknown', retryable: false, groupId, phase: 'commit', receipts });
				}
				if (committed !== true)
					throw failure('宿主未确认提交 PCB 命令组；结果未知，不执行回滚或重试。', { partial: true, status: 'unknown', retryable: false, groupId, phase: 'commit', receipts });
				ctx.stopSignal?.assertActive();
				await ctx.assertDocumentTarget();
				const committedSource = await readTargetSource(ctx);
				const committedComparison = compareDocumentSources(lastSuccessfulSource, committedSource);
				if (!committedComparison.equal)
					throw failure('命令组已提交，但提交后目标源码与最后一步读回不一致；结果未知，保留现场且不回滚。', { partial: true, status: 'unknown', retryable: false, groupId, phase: 'post-commit-readback', committed: true, difference: committedComparison.difference, receipts });
				return { target: ctx.documentTarget, groupId, committed: true, dryRun: false, sourceVerifiedAfterCommit: true, steps: receipts, drcRun: false };
			}
			catch (error) {
				const cause = (error as any)?.cause;
				if (cause && typeof cause === 'object' && (cause.status === 'unknown' || cause.status === 'rolled-back'))
					throw error;
				throw failure(`PCB 批量编辑在命令组开始后中断；无法确认结果，保留现场且不回滚。${error instanceof Error ? error.message : String(error)}`, { partial: true, status: 'unknown', retryable: false, groupId, receipts });
			}
		},
	},
];
