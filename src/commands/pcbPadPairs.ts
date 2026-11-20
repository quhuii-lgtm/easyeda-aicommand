import type { ICommandContext, ICommandDef } from '../engine/types';
import { createGeometryHost } from '../pcb/geometryHost';

type PadPair = [string, string];
interface PadPairGroup {
	name: string;
	padPairs: PadPair[];
	[key: string]: unknown;
}

const commonKeys = new Set(['__docUuid', '__projectUuid', '__tabId', '_timeoutMs']);
const allowedByCommand: Record<string, Set<string>> = {
	'pcb.listPadPairGroups': new Set(),
	'pcb.createPadPairGroup': new Set(['name', 'pairs']),
	'pcb.renamePadPairGroup': new Set(['oldName', 'newName']),
	'pcb.deletePadPairGroup': new Set(['name']),
	'pcb.addPadsToPadPairGroup': new Set(['name', 'pairs']),
	'pcb.removePadsFromPadPairGroup': new Set(['name', 'pairs']),
	'pcb.getPadPairGroupMinWireLengths': new Set(['name']),
};

function ensureOnlyKeys(params: Record<string, unknown>, command: string): void {
	const allowed = allowedByCommand[command];
	for (const key of Object.keys(params)) {
		if (!allowed.has(key) && !commonKeys.has(key))
			throw new Error(`${command} 不支持参数 ${key}`);
	}
}

function groupName(value: unknown, key: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new Error(`${key} 必须是非空字符串`);
	return value;
}

function validatePairs(value: unknown, key = 'pairs', allowEmpty = false): PadPair[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
		throw new Error(`${key} 必须是${allowEmpty ? '' : '非空'}焊盘对数组`);
	const pairs = value.map((item, index): PadPair => {
		if (!Array.isArray(item) || item.length !== 2)
			throw new Error(`${key}[${index}] 必须包含两个焊盘引用`);
		const [first, second] = item;
		if (typeof first !== 'string' || first.trim().length === 0 || typeof second !== 'string' || second.trim().length === 0)
			throw new Error(`${key}[${index}] 的两个焊盘引用都必须是非空字符串`);
		if (first === second)
			throw new Error(`${key}[${index}] 不能把同一个焊盘配成一对`);
		return [first, second];
	});
	const keys = pairs.map(pairKey);
	if (new Set(keys).size !== keys.length)
		throw new Error(`${key} 中包含重复焊盘对`);
	return pairs;
}

function pairKey(pair: PadPair): string {
	return JSON.stringify(pair);
}

function stable(value: unknown): string {
	const normalize = (item: any): any => Array.isArray(item)
		? item.map(normalize)
		: item && typeof item === 'object'
			? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
			: item;
	return JSON.stringify(normalize(value));
}

function groupsEquivalentByName(a: PadPairGroup[], b: PadPairGroup[]): boolean {
	if (a.length !== b.length)
		return false;
	const aByName = new Map(a.map(group => [group.name, group]));
	const bByName = new Map(b.map(group => [group.name, group]));
	return aByName.size === bByName.size
		&& [...aByName].every(([name, group]) => stable(group) === stable(bByName.get(name)));
}

function readGroupsShape(value: unknown): PadPairGroup[] {
	if (!Array.isArray(value))
		throw new Error('getAllPadPairGroups() 未返回完整数组');
	const groups = value.map((item, index): PadPairGroup => {
		if (!item || typeof item !== 'object' || Array.isArray(item))
			throw new Error(`焊盘对组 ${index} 不是对象`);
		const row = item as Record<string, unknown>;
		if (typeof row.name !== 'string' || row.name.trim().length === 0 || !Array.isArray(row.padPairs))
			throw new Error(`焊盘对组 ${index} 缺少有效 name/padPairs`);
		const pairs = row.padPairs.map((pair, pairIndex): PadPair => {
			if (!Array.isArray(pair) || pair.length !== 2 || pair.some(id => typeof id !== 'string' || id.trim().length === 0) || pair[0] === pair[1])
				throw new Error(`焊盘对组 ${row.name} 的第 ${pairIndex} 对数据无效`);
			return [pair[0], pair[1]];
		});
		return { ...row, name: row.name, padPairs: pairs } as PadPairGroup;
	});
	if (new Set(groups.map(group => group.name)).size !== groups.length)
		throw new Error('getAllPadPairGroups() 返回重复组名，目标状态有歧义');
	return groups;
}

function findGroup(groups: PadPairGroup[], name: string): PadPairGroup | undefined {
	return groups.find(group => group.name === name);
}

function assertOtherGroupsUnchanged(before: PadPairGroup[], after: PadPairGroup[], excludedNames: Set<string>): void {
	const beforeOther = before.filter(group => !excludedNames.has(group.name));
	const afterOther = after.filter(group => !excludedNames.has(group.name));
	if (!groupsEquivalentByName(beforeOther, afterOther))
		throw new Error('焊盘对组操作同时改动了非目标组，写入结果为部分完成，禁止重试');
}

async function readGroups(host: Awaited<ReturnType<typeof createGeometryHost>>, label: string): Promise<PadPairGroup[]> {
	return host.read(label, async () => readGroupsShape(await host.sdk.pcb_Drc.getAllPadPairGroups()));
}

type Operation = 'list' | 'create' | 'rename' | 'delete' | 'add' | 'remove' | 'lengths';

async function handle(operation: Operation, params: Record<string, any>, ctx?: ICommandContext): Promise<unknown> {
	const command = Object.keys(allowedByCommand).find(key => key.endsWith(operation === 'lengths' ? 'MinWireLengths' : operation === 'add' ? 'addPadsToPadPairGroup' : operation === 'remove' ? 'removePadsFromPadPairGroup' : operation === 'list' ? 'listPadPairGroups' : `${operation}PadPairGroup`));
	if (!command)
		throw new Error(`未识别的焊盘对组操作 ${operation}`);
	ensureOnlyKeys(params, command);
	const host = await createGeometryHost(eda, params, undefined, ctx);
	try {
		if (operation === 'list') {
			const groups = await readGroups(host, '读取全部焊盘对组');
			await host.finish();
			return { documentUuid: host.documentUuid, groups, complete: true };
		}

		if (operation === 'lengths') {
			const name = groupName(params.name, 'name');
			const groups = await readGroups(host, '确认最短导线长度查询目标组');
			if (!findGroup(groups, name))
				throw new Error(`不存在焊盘对组 ${name}`);
			const values = await host.read(`读取焊盘对组 ${name} 的最短导线长度`, async () => await host.sdk.pcb_Drc.getPadPairGroupMinWireLength(name));
			if (!Array.isArray(values) || values.some((item: any) => !item || !Array.isArray(item.padPair) || item.padPair.length !== 2
				|| item.padPair.some((id: unknown) => typeof id !== 'string') || typeof item.minWireLength !== 'number' || !Number.isFinite(item.minWireLength))) {
				throw new Error('getPadPairGroupMinWireLength() 返回不完整或无效数据');
			}
			await host.finish();
			return { documentUuid: host.documentUuid, name, reportedValues: values, unit: 'unknown', valueMeaning: '主机接口报告的最短导线长度；当前公开类型未声明单位或进一步计算语义' };
		}

		let name: string;
		let oldName: string | undefined;
		let newName: string | undefined;
		let pairs: PadPair[] | undefined;
		if (operation === 'rename') {
			oldName = groupName(params.oldName, 'oldName');
			newName = groupName(params.newName, 'newName');
			name = oldName;
		}
		else {
			name = groupName(params.name, 'name');
		}
		if (operation === 'create' || operation === 'add' || operation === 'remove')
			pairs = validatePairs(params.pairs, 'pairs', operation === 'create');

		const before = await readGroups(host, '读取焊盘对组写入前状态');
		const target = findGroup(before, name);
		if (operation === 'create' && target)
			throw new Error(`焊盘对组 ${name} 已存在，拒绝覆盖`);
		if (operation !== 'create' && !target)
			throw new Error(`不存在焊盘对组 ${name}`);
		if (operation === 'rename') {
			if (newName === oldName) {
				await host.finish();
				return { documentUuid: host.documentUuid, operation, oldName, newName, sdkResult: null, verified: true, changed: false };
			}
			if (findGroup(before, newName!))
				throw new Error(`焊盘对组 ${newName} 已存在，拒绝重命名覆盖`);
		}

		let expected: PadPairGroup[];
		let noOp = false;
		let mutation: () => Promise<boolean>;
		if (operation === 'create') {
			expected = [...before, { name, padPairs: pairs! }];
			mutation = async () => await host.sdk.pcb_Drc.createPadPairGroup(name, pairs!);
		}
		else if (operation === 'rename') {
			expected = before.map(group => group.name === oldName ? { ...group, name: newName! } : group);
			mutation = async () => await host.sdk.pcb_Drc.modifyPadPairGroupName(oldName!, newName!);
		}
		else if (operation === 'delete') {
			expected = before.filter(group => group.name !== name);
			mutation = async () => await host.sdk.pcb_Drc.deletePadPairGroup(name);
		}
		else if (operation === 'add') {
			const present = new Set(target!.padPairs.map(pairKey));
			const additions = pairs!.filter(pair => !present.has(pairKey(pair)));
			noOp = additions.length === 0;
			expected = before.map(group => group.name === name ? { ...group, padPairs: [...group.padPairs, ...additions] } : group);
			mutation = async () => await host.sdk.pcb_Drc.addPadPairToPadPairGroup(name, additions);
		}
		else {
			const removalKeys = new Set(pairs!.map(pairKey));
			const remaining = target!.padPairs.filter(pair => !removalKeys.has(pairKey(pair)));
			noOp = remaining.length === target!.padPairs.length;
			expected = before.map(group => group.name === name ? { ...group, padPairs: remaining } : group);
			const actualRemovals = target!.padPairs.filter(pair => removalKeys.has(pairKey(pair)));
			mutation = async () => await host.sdk.pcb_Drc.removePadPairFromPadPairGroup(name, actualRemovals);
		}

		if (noOp) {
			await host.finish();
			return { documentUuid: host.documentUuid, operation, name, ...(operation === 'rename' ? { oldName, newName } : {}), ...(pairs ? { pairs } : {}), sdkResult: null, verified: true, changed: false };
		}

		await host.checkBudget();
		ctx?.stopSignal?.assertActive();
		const immediatelyBefore = await readGroups(host, '写入前复核焊盘对组状态');
		if (!groupsEquivalentByName(immediatelyBefore, before))
			throw new Error('焊盘对组状态在写入前发生变化，已停止写入');
		ctx?.stopSignal?.assertActive();
		const sdkResult = await host.write(`焊盘对组 ${operation}`, mutation);
		if (typeof sdkResult !== 'boolean')
			throw new Error(`焊盘对组操作返回非 boolean：${String(sdkResult)}`);
		ctx?.stopSignal?.assertActive();
		const after = await readGroups(host, '读回焊盘对组写入结果');
		const changedNames = operation === 'rename' ? new Set([oldName!, newName!]) : new Set([name]);
		assertOtherGroupsUnchanged(before, after, changedNames);
		const verified = groupsEquivalentByName(after, expected);
		const unchanged = groupsEquivalentByName(after, before);
		if (!verified && sdkResult === false && unchanged) {
			throw new Error(`焊盘对组 ${operation} 未应用：官方接口返回 false，完整读回确认状态未变化`, {
				cause: { partial: false, retryable: false, source: 'pad-pair-operation-not-applied', sdkResult: false },
			});
		}
		if (!verified)
			throw new Error(`焊盘对组写入后读回与预期不符；sdkResult=${sdkResult}，verified=false，禁止重试`);
		await host.finish();
		return {
			documentUuid: host.documentUuid,
			operation,
			...(operation === 'rename' ? { oldName, newName } : { name }),
			...(pairs ? { pairs } : {}),
			sdkResult,
			verified,
			changed: verified && !unchanged,
			groups: after,
		};
	}
	catch (error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		if (cause && typeof cause === 'object' && (cause as Record<string, unknown>).source === 'pad-pair-operation-not-applied')
			throw error;
		return host.fail(error, { operation: `padPairGroup.${operation}` });
	}
}

const pairListDescription = '二维数组；每项为两个焊盘引用，例如 [["C6:1","C7:1"]]。SDK 文档也示例游离焊盘 ID，但本命令不推断未验证的引用形态。';

export const pcbPadPairCommands: ICommandDef[] = [
	{ name: 'pcb.listPadPairGroups', summary: '读取当前 PCB 的全部焊盘对组和焊盘成员。', params: [], returns: '{ documentUuid, groups, complete }；仅表示当前接口读回，不代表保存重开持久性。', example: { cmd: 'pcb.listPadPairGroups' }, handler: (params, ctx) => handle('list', params, ctx) },
	{ name: 'pcb.createPadPairGroup', summary: '创建焊盘对组；每对是两个焊盘引用。目标名称必须不存在。', params: [{ name: 'name', type: 'string', required: true, description: '新焊盘对组名称。' }, { name: 'pairs', type: 'string[][]', required: true, description: pairListDescription }], returns: '{ sdkResult, verified, changed, groups }；SDK 返回 false 时仍会读回，只有目标与其他组均核对通过才 verified:true。', example: { cmd: 'pcb.createPadPairGroup', params: { name: 'C6-C7', pairs: [['C6:1', 'C7:1']] } }, handler: (params, ctx) => handle('create', params, ctx) },
	{ name: 'pcb.renamePadPairGroup', summary: '重命名焊盘对组；不覆盖已有组名。', params: [{ name: 'oldName', type: 'string', required: true, description: '现有组名。' }, { name: 'newName', type: 'string', required: true, description: '未占用的新组名。' }], returns: '{ sdkResult, verified, changed, groups }。', example: { cmd: 'pcb.renamePadPairGroup', params: { oldName: 'C6-C7', newName: 'CLK_PAIR' } }, handler: (params, ctx) => handle('rename', params, ctx) },
	{ name: 'pcb.deletePadPairGroup', summary: '删除焊盘对组。', params: [{ name: 'name', type: 'string', required: true, description: '现有组名。' }], returns: '{ sdkResult, verified, changed, groups }。', example: { cmd: 'pcb.deletePadPairGroup', params: { name: 'C6-C7' } }, handler: (params, ctx) => handle('delete', params, ctx) },
	{ name: 'pcb.addPadsToPadPairGroup', summary: '向焊盘对组添加焊盘对；已存在的成员不会重复写入。', params: [{ name: 'name', type: 'string', required: true, description: '现有组名。' }, { name: 'pairs', type: 'string[][]', required: true, description: pairListDescription }], returns: '{ sdkResult, verified, changed, groups }；全为已有焊盘对时零写入。', example: { cmd: 'pcb.addPadsToPadPairGroup', params: { name: 'CLK_PAIR', pairs: [['U1:2', 'R4:1']] } }, handler: (params, ctx) => handle('add', params, ctx) },
	{ name: 'pcb.removePadsFromPadPairGroup', summary: '从焊盘对组移除指定焊盘对。', params: [{ name: 'name', type: 'string', required: true, description: '现有组名。' }, { name: 'pairs', type: 'string[][]', required: true, description: pairListDescription }], returns: '{ sdkResult, verified, changed, groups }；没有目标成员时零写入。', example: { cmd: 'pcb.removePadsFromPadPairGroup', params: { name: 'CLK_PAIR', pairs: [['U1:2', 'R4:1']] } }, handler: (params, ctx) => handle('remove', params, ctx) },
	{ name: 'pcb.getPadPairGroupMinWireLengths', summary: '读取焊盘对组各对的主机最短导线长度报告。', params: [{ name: 'name', type: 'string', required: true, description: '现有焊盘对组名。' }], returns: '{ reportedValues, unit:"unknown", valueMeaning }；原样保留主机数值，不猜测单位。', example: { cmd: 'pcb.getPadPairGroupMinWireLengths', params: { name: 'CLK_PAIR' } }, handler: (params, ctx) => handle('lengths', params, ctx) },
];
