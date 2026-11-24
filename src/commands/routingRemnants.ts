import type { ICommandContext, ICommandDef } from '../engine/types';
import type { LocalPad } from '../pcb/localRoutingReview';
import { pcbSourceRevision } from '../pcb/dsnSourceSnapshot';
import { analyzeRoutingRemnants } from '../pcb/routingRemnantAnalysis';
import { routingRemnantSource } from '../pcb/routingRemnantSource';
import { readRoutingPads } from './localRoutingReview';

async function reviewRoutingRemnants(params: Record<string, any>, ctx?: ICommandContext) {
	const nets = params.nets as unknown;
	if (nets !== undefined && (!Array.isArray(nets) || !nets.length
		|| nets.some(net => typeof net !== 'string' || !net.trim())))
		throw new Error('nets 必须是非空网络名数组');
	const scopes = nets === undefined ? undefined : new Set(nets as string[]);
	const target = ctx?.documentTarget;
	if (!target || target.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('整板余线检查需要核对活动 PCB');
	const active = async () => {
		ctx.stopSignal?.assertActive();
		await ctx.assertDocumentTarget!();
	};
	await active();
	const before = await eda.sys_FileManager.getDocumentSource();
	if (typeof before !== 'string' || !before.trim())
		throw new Error('PCB 当前编辑器源码读取失败');
	const revision = await pcbSourceRevision(before, target.uuid);
	let pads: LocalPad[] | undefined;
	let padReadError: string | undefined;
	try {
		pads = await readRoutingPads();
	}
	catch (error) {
		padReadError = (error as Error).message;
	}
	await active();
	const input = routingRemnantSource(before, pads);
	if (input.uuid !== target.uuid)
		throw new Error('当前 PCB 源码与指定文档身份不一致');
	const unknownNets = [...(scopes ?? [])].filter(net => !input.nets.has(net));
	if (unknownNets.length)
		throw new Error(`当前 PCB 未找到指定网络：${unknownNets.join('、')}`);
	const selected = <T extends { net: string }>(items: T[]) => scopes ? items.filter(item => scopes.has(item.net)) : items;
	const relevantIssues = input.issues.filter(issue => !scopes || !issue.net || scopes.has(issue.net));
	const analysis = analyzeRoutingRemnants({
		tracks: selected(input.tracks),
		vias: selected(input.vias),
		pads: selected(input.pads),
		copper: selected(input.copper),
		issues: relevantIssues.map(issue => ({ objectId: issue.id, net: issue.net, message: issue.reason, code: 'source-coverage' })),
	});
	await active();
	const after = await eda.sys_FileManager.getDocumentSource();
	if (typeof after !== 'string' || await pcbSourceRevision(after, target.uuid) !== revision)
		throw new Error('检查期间 PCB 已改变，报告已失效，请重新扫描');
	await active();
	return {
		...analysis,
		target,
		revision,
		scope: scopes ? { nets: [...scopes] } : 'whole-board',
		coordinateUnit: 'mil',
		layers: input.layers,
		padReadback: { ...input.padReadback, error: padReadError ?? null },
		inputStatus: padReadError || analysis.issues.length ? 'has-unverified-input' : 'supported-input-read',
		safety: { readOnly: true, deletionAuthorized: false, intentVerified: false },
	};
}

export const routingRemnantCommands: ICommandDef[] = [{
	name: 'pcb.reviewRoutingRemnants',
	summary: '只读扫描全板或指定网络的无负载支路、同网重叠走线与疑似废过孔，按实际填铜报告接触依据与人工复核项',
	params: [{ name: 'nets', type: 'string[]', description: '可选网络名。省略扫描整板' }],
	returns: '当前 PCB 和修订、铜层、支路／重叠／过孔候选、接触与覆盖情况。所有结果均需人工复核，命令不会修改工程',
	example: { cmd: 'pcb.reviewRoutingRemnants', params: { nets: ['VBAT'] } },
	handler: reviewRoutingRemnants,
}];
