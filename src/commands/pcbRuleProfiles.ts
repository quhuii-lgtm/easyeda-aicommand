import type { ICommandContext, ICommandDef } from '../engine/types';
import { compareDocumentSources } from '../engine/documentRecovery';
import { assertJsonValue, cloneRuleValue, stableRuleJson } from '../pcb/ruleEditing';

type RuleProfile = Record<string, any> & { name: string };
interface Target { documentType: number; uuid: string; tabId?: unknown; parentProjectUuid?: unknown }
interface BoardSnapshot { configurationName?: string; configuration: unknown; source: string; defaultName?: string; defaultNameRead: boolean }
interface ProfileSet { all: RuleProfile[]; custom: RuleProfile[]; systems: RuleProfile[] }

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function cleanName(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new Error(`${label}必须是非空字符串`);
	return value;
}

async function captureTarget(ctx?: ICommandContext): Promise<Target> {
	ctx?.stopSignal?.assertActive();
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (document?.documentType !== 3 || typeof document.uuid !== 'string' || !document.uuid.trim())
		throw new Error('规则方案管理需要当前焦点为有效 PCB');
	await assertTarget(ctx, document);
	return cloneRuleValue(document);
}

async function assertTarget(ctx: ICommandContext | undefined, target: Target): Promise<void> {
	ctx?.stopSignal?.assertActive();
	if (ctx?.assertDocumentTarget) {
		await ctx.assertDocumentTarget();
	}
	else {
		const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (focus?.documentType !== target.documentType || focus.uuid !== target.uuid
			|| (target.tabId !== undefined && focus.tabId !== target.tabId)
			|| (target.parentProjectUuid !== undefined && focus.parentProjectUuid !== target.parentProjectUuid)) {
			throw new Error(`PCB目标已变化：期望 ${target.uuid}，当前 ${focus?.uuid ?? '未知'}`);
		}
	}
	ctx?.stopSignal?.assertActive();
}

async function readAtTarget<T>(ctx: ICommandContext | undefined, target: Target, _operation: string, read: () => Promise<T>): Promise<T> {
	await assertTarget(ctx, target);
	const value = await read();
	await assertTarget(ctx, target);
	return value;
}

function normalizeProfileList(value: unknown, label: string): RuleProfile[] {
	if (!Array.isArray(value))
		throw new Error(`${label}未返回配置数组`);
	const names = new Set<string>();
	return value.map((item, index) => {
		if (!isRecord(item) || typeof item.name !== 'string' || !item.name)
			throw new Error(`${label}[${index}]缺少可识别的配置名称`);
		if (names.has(item.name))
			throw new Error(`${label}中存在重复名称“${item.name}”，拒绝按名称管理`);
		names.add(item.name);
		return item as RuleProfile;
	});
}

function findUnique(profiles: RuleProfile[], name: string, label: string): RuleProfile | undefined {
	const matches = profiles.filter(profile => profile.name === name);
	if (matches.length > 1)
		throw new Error(`${label}中配置名“${name}”重复，拒绝写入`);
	return matches[0];
}

async function readProfileSet(ctx: ICommandContext | undefined, target: Target): Promise<ProfileSet> {
	const all = normalizeProfileList(await readAtTarget(ctx, target, '读取全部规则方案', () => eda.pcb_Drc.getAllRuleConfigurations(true)), '全部规则方案');
	const custom = normalizeProfileList(await readAtTarget(ctx, target, '读取自定义规则方案', () => eda.pcb_Drc.getAllRuleConfigurations(false)), '自定义规则方案');
	const allNames = all.map(profile => profile.name);
	for (const profile of custom) {
		if (!allNames.includes(profile.name))
			throw new Error(`自定义规则方案“${profile.name}”未出现在全部方案列表中，拒绝按未知类型管理`);
	}
	return { all, custom, systems: all.filter(profile => !custom.some(item => item.name === profile.name)) };
}

function payloadFromProfile(profile: unknown, label: string): Record<string, any> {
	if (!isRecord(profile))
		throw new Error(`${label}没有返回完整规则对象`);
	// The SDK getter may return a named wrapper or the raw rule table. Unwrap only
	// the documented `config` field; otherwise preserve the table exactly as read.
	const payload = Object.prototype.hasOwnProperty.call(profile, 'config') ? profile.config : profile;
	if (!isRecord(payload) || Object.keys(payload).length === 0)
		throw new Error(`${label}未返回非空完整规则配置`);
	assertJsonValue(payload, label);
	return payload;
}

async function readBoardSnapshot(ctx: ICommandContext | undefined, target: Target): Promise<BoardSnapshot> {
	const current = await readAtTarget(ctx, target, '读取当前PCB规则配置', () => eda.pcb_Drc.getCurrentRuleConfiguration());
	if (!isRecord(current) || !isRecord(current.config))
		throw new Error('当前PCB规则getter未返回完整 configuration.config');
	assertJsonValue(current.config, '当前PCB规则配置');
	const configurationName = await readAtTarget(ctx, target, '读取当前PCB规则方案名称', () => eda.pcb_Drc.getCurrentRuleConfigurationName());
	if (configurationName !== undefined && typeof configurationName !== 'string')
		throw new Error('当前PCB规则方案名称getter返回了非字符串值');
	const source = await readAtTarget(ctx, target, '读取当前PCB源码', () => eda.sys_FileManager.getDocumentSource());
	if (typeof source !== 'string' || source.length === 0)
		throw new Error('无法读取当前PCB源码，不能确认模板操作未影响当前板');
	let defaultName: string | undefined;
	let defaultNameRead = false;
	await assertTarget(ctx, target);
	try {
		defaultName = await eda.pcb_Drc.getDefaultRuleConfigurationName();
		defaultNameRead = typeof defaultName === 'string';
	}
	catch {
		// The SDK exposes this getter, but its undefined/failure result is not needed
		// to perform template CRUD and does not authorize a default-setting write.
		defaultName = undefined;
	}
	await assertTarget(ctx, target);
	return { configurationName, configuration: cloneRuleValue(current.config), source, defaultName, defaultNameRead };
}

function profileMap(profiles: RuleProfile[], omitNames: Set<string> = new Set()): Map<string, string> {
	const entries = profiles.filter(profile => !omitNames.has(profile.name)).map(profile => [profile.name, stableRuleJson(profile)] as const);
	return new Map(entries);
}

function assertMapEqual(expected: Map<string, string>, actual: Map<string, string>, label: string): void {
	if (expected.size !== actual.size)
		throw new Error(`${label}数量变化：${expected.size} → ${actual.size}`);
	for (const [name, value] of expected) {
		if (actual.get(name) !== value)
			throw new Error(`${label}“${name}”内容或身份变化`);
	}
}

function compareBoardSnapshots(before: BoardSnapshot, after: BoardSnapshot): { differences: string[]; globalDefaultChanged: boolean | null; globalDefaultVerification: 'unchanged' | 'unknown' } {
	const differences: string[] = [];
	if (stableRuleJson(before.configuration) !== stableRuleJson(after.configuration))
		differences.push('当前PCB有效规则配置变化');
	if (before.configurationName !== after.configurationName)
		differences.push('当前PCB规则方案名称变化');
	const sourceComparison = compareDocumentSources(before.source, after.source);
	if (!sourceComparison.equal)
		differences.push(`当前PCB有效源码变化：${sourceComparison.difference ?? '未能匹配'}`);
	const canCompareDefault = before.defaultNameRead && after.defaultNameRead;
	const globalDefaultChanged = canCompareDefault ? before.defaultName !== after.defaultName : null;
	if (globalDefaultChanged === true)
		differences.push('用户新建PCB默认规则方案名称变化');
	return {
		differences,
		globalDefaultChanged,
		globalDefaultVerification: canCompareDefault ? 'unchanged' : 'unknown',
	};
}

function partialUnknown(operation: string, error: unknown, details: Record<string, unknown>, sdkReturned: boolean, sdkResult: unknown): Error {
	const sdkStatus = sdkReturned ? `SDK已返回 ${String(sdkResult)}` : 'SDK未返回结果';
	return new Error(`${operation}已发送（${sdkStatus}），但最终结果未知：${error instanceof Error ? error.message : String(error)}`, {
		cause: { partial: true, retryable: false, outcome: 'unknown', operation, ...details, sdkReturned, sdkResult, cause: error },
	});
}

async function mutateAndVerify<T>(
	operation: string,
	ctx: ICommandContext | undefined,
	target: Target,
	write: () => Promise<unknown>,
	verify: (sdkResult: unknown) => Promise<T>,
	details: Record<string, unknown>,
): Promise<T> {
	let writeSent = false;
	let sdkReturned = false;
	let sdkResult: unknown;
	try {
		await assertTarget(ctx, target);
		writeSent = true;
		sdkResult = await write();
		sdkReturned = true;
		await assertTarget(ctx, target);
		return await verify(sdkResult);
	}
	catch (error) {
		if (!writeSent)
			throw error;
		ctx?.stopSignal?.stop(`${operation}写入结果未知，停止后续步骤`);
		throw partialUnknown(operation, error, details, sdkReturned, sdkResult);
	}
}

async function readSourceConfiguration(sourceName: string | undefined, ctx: ICommandContext | undefined, target: Target, profiles: ProfileSet): Promise<{ sourceType: 'current-pcb' | 'system' | 'custom'; sourceName?: string; configuration: Record<string, any> }> {
	if (sourceName === undefined) {
		const current = await readAtTarget(ctx, target, '读取当前PCB规则作为来源', () => eda.pcb_Drc.getCurrentRuleConfiguration());
		if (!isRecord(current) || !isRecord(current.config))
			throw new Error('当前PCB规则getter未返回完整 configuration.config');
		assertJsonValue(current.config, '当前PCB规则来源');
		return { sourceType: 'current-pcb', sourceName: undefined, configuration: cloneRuleValue(current.config) };
	}
	const profile = findUnique(profiles.all, sourceName, '全部规则方案列表');
	if (!profile)
		throw new Error(`规则方案“${sourceName}”不存在，未写入`);
	const source = await readAtTarget(ctx, target, `读取来源规则方案 ${sourceName}`, () => eda.pcb_Drc.getRuleConfiguration(sourceName));
	if (!source)
		throw new Error(`规则方案“${sourceName}”读回为空，未写入`);
	if (isRecord(source) && source.name !== undefined && source.name !== sourceName)
		throw new Error(`来源规则方案名称不符：请求“${sourceName}”，读回“${String(source.name)}”`);
	const configuration = payloadFromProfile(source, `来源规则方案“${sourceName}”`);
	return { sourceType: profiles.custom.some(item => item.name === sourceName) ? 'custom' : 'system', sourceName, configuration: cloneRuleValue(configuration) };
}

async function readTargetProfile(ctx: ICommandContext | undefined, target: Target, name: string): Promise<Record<string, any>> {
	const profile = await readAtTarget(ctx, target, `读取规则方案 ${name}`, () => eda.pcb_Drc.getRuleConfiguration(name));
	if (!isRecord(profile))
		throw new Error(`规则方案“${name}”不存在或读回无效`);
	if (profile.name !== undefined && profile.name !== name)
		throw new Error(`规则方案精确名称不符：请求“${name}”，读回“${String(profile.name)}”`);
	return profile;
}

export const pcbRuleProfileCommands: ICommandDef[] = [
	{
		name: 'pcb.listRuleConfigurations',
		summary: '列出当前PCB上下文可见的设计规则方案；默认包含系统方案，只读模板库，不切换当前板规则或用户默认方案',
		params: [{ name: 'includeSystem', type: 'boolean', description: '是否包含系统方案，默认 true' }],
		returns: '{ configurations:官方原样方案列表, customCount, systemCount, currentConfigurationName }',
		example: { cmd: 'pcb.listRuleConfigurations' },
		handler: async (params, ctx) => {
			if (params.includeSystem !== undefined && typeof params.includeSystem !== 'boolean')
				throw new Error('includeSystem必须是boolean');
			const target = await captureTarget(ctx);
			const profiles = await readProfileSet(ctx, target);
			const currentConfigurationName = await readAtTarget(ctx, target, '读取当前PCB规则方案名称', () => eda.pcb_Drc.getCurrentRuleConfigurationName());
			return {
				configurations: params.includeSystem === false ? profiles.custom : profiles.all,
				customCount: profiles.custom.length,
				systemCount: profiles.systems.length,
				currentConfigurationName,
			};
		},
	},
	{
		name: 'pcb.getRuleConfiguration',
		summary: '按精确名称读取完整设计规则方案；只读模板库，不应用到当前PCB，也不改用户默认方案',
		params: [{ name: 'name', type: 'string', required: true, description: '设计规则方案精确名称' }],
		returns: '{ name, configuration:官方读回完整方案, sourceType:"system"|"custom" }',
		example: { cmd: 'pcb.getRuleConfiguration', params: { name: '自定义配置3' } },
		handler: async (params, ctx) => {
			const name = cleanName(params.name, 'name');
			const target = await captureTarget(ctx);
			const profiles = await readProfileSet(ctx, target);
			const indexRecord = findUnique(profiles.all, name, '全部规则方案列表');
			if (!indexRecord)
				throw new Error(`规则方案“${name}”不存在`);
			const configuration = await readTargetProfile(ctx, target, name);
			return { name, configuration, sourceType: profiles.custom.some(item => item.name === name) ? 'custom' : 'system' };
		},
	},
	{
		name: 'pcb.saveRuleConfiguration',
		summary: '把当前PCB完整规则配置或指定已有方案复制到模板库；默认预览，不应用方案到当前板，也不设置用户默认方案',
		params: [
			{ name: 'name', type: 'string', required: true, description: '目标自定义方案名称；已有系统方案不可覆盖' },
			{ name: 'sourceName', type: 'string', description: '已有方案来源；当前PCB和自定义来源已实证，系统原始格式的复制仍未解决，不保证可保存。省略时复制当前PCB完整配置。不可传任意配置JSON' },
			{ name: 'allowOverwrite', type: 'boolean', description: '是否允许覆盖同名自定义方案，默认 false' },
			{ name: 'dryRun', type: 'boolean', description: '默认 true，只预览影响，不写入模板库' },
		],
		returns: '{ dryRun, status, sourceType, sourceName, name, currentConfigurationName, currentPcbChanged, globalDefaultChanged:boolean|null, globalDefaultVerification:"not-written"|"unchanged"|"unknown", verified? }',
		example: { cmd: 'pcb.saveRuleConfiguration', params: { name: 'XLink_规则方案_RevA' } },
		handler: async (params, ctx) => {
			const name = cleanName(params.name, 'name');
			const sourceName = params.sourceName === undefined ? undefined : cleanName(params.sourceName, 'sourceName');
			if (['config', 'configuration', 'ruleConfiguration'].some(key => Object.prototype.hasOwnProperty.call(params, key)))
				throw new Error('不接受任意规则JSON；请从当前PCB完整配置或已有规则方案复制');
			const allowOverwrite = params.allowOverwrite === undefined ? false : params.allowOverwrite;
			const dryRun = params.dryRun === undefined ? true : params.dryRun;
			if (typeof allowOverwrite !== 'boolean' || typeof dryRun !== 'boolean')
				throw new Error('allowOverwrite和dryRun必须是boolean');
			const target = await captureTarget(ctx);
			const profiles = await readProfileSet(ctx, target);
			const existing = findUnique(profiles.all, name, '全部规则方案列表');
			const existingCustom = findUnique(profiles.custom, name, '自定义规则方案列表');
			if (existing && !existingCustom)
				throw new Error(`系统规则方案“${name}”不可覆盖`);
			if (existingCustom && !allowOverwrite)
				throw new Error(`自定义规则方案“${name}”已存在；默认拒绝覆盖，请显式设置 allowOverwrite:true`);
			const source = await readSourceConfiguration(sourceName, ctx, target, profiles);
			const boardBefore = await readBoardSnapshot(ctx, target);
			const preview = {
				dryRun,
				status: dryRun ? 'preview' : 'pending',
				action: existingCustom ? 'overwrite' : 'create',
				name,
				sourceType: source.sourceType,
				sourceName: source.sourceName,
				configuration: cloneRuleValue(source.configuration),
				existingTarget: existing ? cloneRuleValue(existing) : undefined,
				currentConfigurationName: boardBefore.configurationName,
				currentPcbChanged: false,
				globalDefaultChanged: false,
				globalDefaultVerification: 'not-written',
				willChange: ['模板库中指定的自定义规则方案'],
				willNotChange: ['当前PCB生效规则', '用户新建PCB默认方案'],
			};
			if (dryRun)
				return preview;
			const beforeOtherProfiles = profileMap(profiles.all, new Set(existingCustom ? [name] : []));
			return mutateAndVerify('保存设计规则方案', ctx, target, () => eda.pcb_Drc.saveRuleConfiguration(cloneRuleValue(source.configuration), name, Boolean(existingCustom && allowOverwrite)), async (sdkResult) => {
				const readback = await readTargetProfile(ctx, target, name);
				const readbackConfiguration = payloadFromProfile(readback, `保存后规则方案“${name}”`);
				if (stableRuleJson(readbackConfiguration) !== stableRuleJson(source.configuration))
					throw new Error('保存后的完整规则内容与来源不一致');
				const afterProfiles = await readProfileSet(ctx, target);
				if (!afterProfiles.custom.some(item => item.name === name))
					throw new Error(`新模板“${name}”未以自定义方案读回`);
				assertMapEqual(beforeOtherProfiles, profileMap(afterProfiles.all, new Set([name])), '非目标方案');
				const boardAfter = await readBoardSnapshot(ctx, target);
				const boardCheck = compareBoardSnapshots(boardBefore, boardAfter);
				if (boardCheck.differences.length)
					throw new Error(`模板保存影响了当前PCB或全局默认：${boardCheck.differences.join('、')}`);
				return { ...preview, dryRun: false, status: 'saved', sdkResult, configuration: readbackConfiguration, currentPcbChanged: false, globalDefaultChanged: boardCheck.globalDefaultChanged, globalDefaultVerification: boardCheck.globalDefaultVerification, verified: true };
			}, { name, sourceName: source.sourceName, targetUuid: target.uuid });
		},
	},
	{
		name: 'pcb.renameRuleConfiguration',
		summary: '重命名一个已确认的自定义规则方案；默认预览，不改变当前PCB规则或用户默认方案',
		params: [
			{ name: 'name', type: 'string', required: true, description: '已有自定义方案的精确名称；系统方案不可改名' },
			{ name: 'newName', type: 'string', required: true, description: '新的自定义方案名称，必须无重名' },
			{ name: 'dryRun', type: 'boolean', description: '默认 true，只预览影响，不写入模板库' },
		],
		returns: '{ dryRun, status, name, newName, configuration, currentPcbChanged, globalDefaultChanged:boolean|null, globalDefaultVerification:"not-written"|"unchanged"|"unknown", verified? }',
		example: { cmd: 'pcb.renameRuleConfiguration', params: { name: 'XLink_规则方案_RevA', newName: 'XLink_规则方案_RevB' } },
		handler: async (params, ctx) => {
			const name = cleanName(params.name, 'name');
			const newName = cleanName(params.newName, 'newName');
			const dryRun = params.dryRun === undefined ? true : params.dryRun;
			if (typeof dryRun !== 'boolean')
				throw new Error('dryRun必须是boolean');
			const target = await captureTarget(ctx);
			const profiles = await readProfileSet(ctx, target);
			const sourceRecord = findUnique(profiles.all, name, '全部规则方案列表');
			if (!sourceRecord)
				throw new Error(`规则方案“${name}”不存在`);
			if (!findUnique(profiles.custom, name, '自定义规则方案列表'))
				throw new Error(`系统规则方案“${name}”不可重命名`);
			const collision = findUnique(profiles.all, newName, '全部规则方案列表');
			if (collision && newName !== name)
				throw new Error(`目标名称“${newName}”已存在，拒绝覆盖`);
			const profile = await readTargetProfile(ctx, target, name);
			const configuration = payloadFromProfile(profile, `规则方案“${name}”`);
			const boardBefore = await readBoardSnapshot(ctx, target);
			const preview = { dryRun, status: dryRun ? 'preview' : 'pending', name, newName, configuration: cloneRuleValue(configuration), isCurrentBoardConfiguration: boardBefore.configurationName === name, isGlobalDefault: boardBefore.defaultName === name, currentPcbChanged: false, globalDefaultChanged: false, globalDefaultVerification: 'not-written', willChange: ['模板库中的指定自定义规则方案名称'], willNotChange: ['当前PCB生效规则'] };
			if (name === newName)
				return { ...preview, status: dryRun ? 'preview-noop' : 'unchanged', verified: !dryRun };
			if (dryRun)
				return preview;
			const beforeOtherProfiles = profileMap(profiles.all, new Set([name]));
			return mutateAndVerify('重命名设计规则方案', ctx, target, () => eda.pcb_Drc.renameRuleConfiguration(name, newName), async (sdkResult) => {
				const readback = await readTargetProfile(ctx, target, newName);
				if (stableRuleJson(payloadFromProfile(readback, `改名后规则方案“${newName}”`)) !== stableRuleJson(configuration))
					throw new Error('改名后的完整规则内容与改名前不一致');
				const afterProfiles = await readProfileSet(ctx, target);
				if (afterProfiles.custom.some(item => item.name === name) || !afterProfiles.custom.some(item => item.name === newName))
					throw new Error('改名后的自定义方案名称集合不符');
				assertMapEqual(beforeOtherProfiles, profileMap(afterProfiles.all, new Set([newName])), '非目标方案');
				const boardAfter = await readBoardSnapshot(ctx, target);
				const boardCheck = compareBoardSnapshots(boardBefore, boardAfter);
				if (boardCheck.differences.length)
					throw new Error(`重命名影响了当前PCB或全局默认：${boardCheck.differences.join('、')}`);
				return { ...preview, dryRun: false, status: 'renamed', sdkResult, configuration: payloadFromProfile(readback, `改名后规则方案“${newName}”`), currentPcbChanged: false, globalDefaultChanged: boardCheck.globalDefaultChanged, globalDefaultVerification: boardCheck.globalDefaultVerification, verified: true };
			}, { name, newName, targetUuid: target.uuid });
		},
	},
	{
		name: 'pcb.deleteRuleConfiguration',
		summary: '删除一个已确认的自定义规则方案；默认预览完整影响，不改变当前PCB参数或显式设置用户默认方案',
		params: [
			{ name: 'name', type: 'string', required: true, description: '已有自定义方案的精确名称；系统方案不可删除' },
			{ name: 'dryRun', type: 'boolean', description: '默认 true，只预览影响，不写入模板库' },
		],
		returns: '{ dryRun, status, name, configuration, isCurrentBoardConfiguration, isGlobalDefault, currentPcbChanged, globalDefaultChanged:boolean|null, globalDefaultVerification:"not-written"|"unchanged"|"unknown", verified? }',
		example: { cmd: 'pcb.deleteRuleConfiguration', params: { name: 'XLink_规则方案_RevA' } },
		handler: async (params, ctx) => {
			const name = cleanName(params.name, 'name');
			const dryRun = params.dryRun === undefined ? true : params.dryRun;
			if (typeof dryRun !== 'boolean')
				throw new Error('dryRun必须是boolean');
			const target = await captureTarget(ctx);
			const profiles = await readProfileSet(ctx, target);
			const sourceRecord = findUnique(profiles.all, name, '全部规则方案列表');
			if (!sourceRecord)
				throw new Error(`规则方案“${name}”不存在`);
			if (!findUnique(profiles.custom, name, '自定义规则方案列表'))
				throw new Error(`系统规则方案“${name}”不可删除`);
			const profile = await readTargetProfile(ctx, target, name);
			const configuration = payloadFromProfile(profile, `规则方案“${name}”`);
			const boardBefore = await readBoardSnapshot(ctx, target);
			const preview = { dryRun, status: dryRun ? 'preview' : 'pending', name, configuration: cloneRuleValue(configuration), profile: cloneRuleValue(profile), isCurrentBoardConfiguration: boardBefore.configurationName === name, isGlobalDefault: boardBefore.defaultName === name, currentPcbChanged: false, globalDefaultChanged: false, globalDefaultVerification: 'not-written', willChange: [`模板库中的自定义规则方案“${name}”`], willNotChange: ['当前PCB生效规则', '其他规则方案'] };
			if (dryRun)
				return preview;
			const beforeOtherProfiles = profileMap(profiles.all, new Set([name]));
			return mutateAndVerify('删除设计规则方案', ctx, target, () => eda.pcb_Drc.deleteRuleConfiguration(name), async (sdkResult) => {
				const removed = await readAtTarget(ctx, target, `确认方案 ${name} 已删除`, () => eda.pcb_Drc.getRuleConfiguration(name));
				if (removed !== undefined)
					throw new Error(`删除后规则方案“${name}”仍可读`);
				const afterProfiles = await readProfileSet(ctx, target);
				if (afterProfiles.all.some(item => item.name === name) || afterProfiles.custom.some(item => item.name === name))
					throw new Error(`删除后方案“${name}”仍在配置列表中`);
				assertMapEqual(beforeOtherProfiles, profileMap(afterProfiles.all), '非目标方案');
				const boardAfter = await readBoardSnapshot(ctx, target);
				const boardCheck = compareBoardSnapshots(boardBefore, boardAfter);
				if (boardCheck.differences.length)
					throw new Error(`删除影响了当前PCB或全局默认：${boardCheck.differences.join('、')}`);
				return { ...preview, dryRun: false, status: 'deleted', sdkResult, currentPcbChanged: false, globalDefaultChanged: boardCheck.globalDefaultChanged, globalDefaultVerification: boardCheck.globalDefaultVerification, verified: true };
			}, { name, targetUuid: target.uuid });
		},
	},
];
