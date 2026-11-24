import type { ICommandContext, ICommandDef } from '../engine/types';
import type { RoutingWidthSnapshot } from '../engine/routingWidthRules';
import type { LocalPad } from '../pcb/localRoutingReview';
import type { RoutingPath } from '../pcb/routingDetourPaths';
import { buildRoutingWidthSnapshot, checkSesWidthRules } from '../engine/routingWidthRules';
import { pcbSourceRevision } from '../pcb/dsnSourceSnapshot';
import { extractRuleEvidence } from '../pcb/kiroutingInput';
import { assessRoutingDetour } from '../pcb/routingDetourObstacles';
import { buildRoutingPaths } from '../pcb/routingDetourPaths';
import { routingDetourSource } from '../pcb/routingDetourSource';
import { readRoutingPads } from './localRoutingReview';

type DetourSource = ReturnType<typeof routingDetourSource>;
interface DetourRules {
	clearanceMil?: number;
	edgeClearanceMil?: number;
	source: string;
}
const noRules: DetourRules = { source: '没有核实当前设计规则的间距和板边距' };

function foldbackSegments(path: RoutingPath) {
	const dx = path.end.x - path.start.x;
	const dy = path.end.y - path.start.y;
	const directDistance = Math.hypot(dx, dy);
	if (directDistance <= 0.001)
		return [];
	return path.segments.flatMap((segment) => {
		if (segment.kind !== 'track' || segment.arc)
			return [];
		const delta = ((segment.to.x - segment.from.x) * dx + (segment.to.y - segment.from.y) * dy) / directDistance;
		return delta < -0.001 ? [{ trackId: segment.id, layer: segment.from.layer, from: segment.from, to: segment.to, backwardMil: -delta }] : [];
	});
}

export function analyzeDetourBoard(input: DetourSource, options: { nets?: string[]; minimumSavingsMil?: number; rules?: DetourRules; widths?: RoutingWidthSnapshot } = {}) {
	const nets = options.nets ? new Set(options.nets) : undefined;
	const include = <T extends { net: string }>(items: T[]) => nets ? items.filter(item => nets.has(item.net)) : items;
	const rules = options.rules ?? noRules;
	const routing = buildRoutingPaths({
		tracks: include(input.routing.tracks), vias: include(input.routing.vias),
		pads: include(input.pathPads), copper: include(input.copper),
	});
	const tracksById = new Map(input.tracks.map(track => [track.id, track]));
	const padsById = new Map(input.padObstacles.map(pad => [pad.id, pad]));
	const paths = routing.paths.map((path) => {
		const foldbacks = foldbackSegments(path);
		const foldbackCount = foldbacks.length || path.reversals.length;
		const known = { ...path, foldbackCount, foldbacks,
			directDistanceMil: Math.hypot(path.end.x - path.start.x, path.end.y - path.start.y) };
		const purpose = input.blockedNets.get(path.net);
		if (purpose)
			return { ...known, shortening: { status: 'protected' as const, reason: purpose } };
		if (path.improvability !== 'review-required')
			return { ...known, shortening: { status: 'unverified' as const, reason: '路径端点、分支或锁定状态需要核对' } };
		if (path.layerSwitchCount > 0 || path.vertices.some(point => point.layer !== path.start.layer))
			return { ...known, shortening: { status: 'unverified' as const, reason: '跨层路径已统计，首版仅评估保留同层端点的捷径' } };
		const widths = new Set(path.trackIds.map(id => tracksById.get(id)?.width));
		const widthMil = widths.values().next().value;
		if (widths.size !== 1 || typeof widthMil !== 'number' || !Number.isFinite(widthMil) || widthMil <= 0)
			return { ...known, shortening: { status: 'unverified' as const, reason: '原路径含变宽或未知线宽，需确认宽度用途' } };
		const widthCheck = options.widths && checkSesWidthRules(options.widths, [{ net: path.net, layer: path.start.layer, widthMil }]);
		if (widthCheck?.status === 'violation')
			return { ...known, shortening: { status: 'blocked' as const, reason: '原线宽不符合该网络当前图层规则', widthCheck } };
		const terminals = (endpoint: typeof path.start) => endpoint.padIds.flatMap((id) => {
			const pad = padsById.get(id);
			return pad ? [{ id, windowMil: pad.radius + Math.hypot(endpoint.x - pad.x, endpoint.y - pad.y) + widthMil / 2 }] : [];
		});
		const gaps = input.geometryGaps.filter(gap => !gap.layers || gap.layers.includes(path.start.layer));
		const issues = gaps.map(gap => ({ id: gap.id, reason: gap.reason }));
		if (widthCheck?.status !== 'compliant')
			issues.push({ id: path.id, reason: '未核实该网络当前图层允许的线宽' });
		const assessment = assessRoutingDetour({
			source: { id: path.id, objectIds: path.trackIds, net: path.net, points: path.vertices, layer: path.start.layer, widthMil },
			outline: input.boardRings, tracks: input.tracks, vias: input.vias, pads: input.padObstacles,
			copper: input.copper, keepouts: input.keepouts, rules,
			terminalContacts: { start: terminals(path.start), end: terminals(path.end) },
			issues,
			obstacleCoverageComplete: issues.length === 0,
			minimumSavingsMil: options.minimumSavingsMil,
		});
		const status = assessment.candidates.some(item => item.decision === 'manual-review-candidate')
			? 'candidate' as const
			: assessment.candidates.some(item => item.decision === 'geometry-preview-only')
				? 'geometry-preview' as const
				: assessment.candidates.length ? 'blocked' as const : 'no-shorter-tested' as const;
		return { ...known, shortening: { status, assessment } };
	});
	return {
		paths,
		candidates: paths.filter(path => path.shortening.status === 'candidate'),
		geometryPreviews: paths.filter(path => path.shortening.status === 'geometry-preview'),
		rules,
		issues: routing.issues,
		coverage: { ...routing.coverage, activeCopperLayers: input.routing.layers, geometryGaps: input.geometryGaps },
	};
}

async function readRules(source: string, input: DetourSource, check: () => Promise<void>): Promise<{ rules: DetourRules; widths?: RoutingWidthSnapshot }> {
	try {
		const configuration = await eda.pcb_Drc.getCurrentRuleConfiguration();
		await check();
		const netRules = await eda.pcb_Drc.getNetRules();
		await check();
		const sourceRules = input.records.filter(record =>
			['RULE', 'RULE_SELECTOR', 'RULE_TEMPLATE', 'PAD_NET', 'NET', 'POUR'].includes(record.header.type),
		).map(record => ({ type: record.header.type, id: record.header.id, data: record.data }));
		const defaults = sourceRules.filter(record => record.type === 'RULE' && String(record.id).includes('"SAFE"') && record.data.ruleState === 'DEFAULT');
		const layers = await eda.pcb_Layer.getAllLayers();
		await check();
		const editorVersion = String(eda.sys_Environment.getEditorCurrentVersion?.() ?? '');
		const widths = buildRoutingWidthSnapshot({ source, editorVersion, layers, netRules });
		if (defaults.length !== 1 || defaults[0].data.ruleContext?.isForAll !== 'ALL'
			|| defaults[0].data.ruleContext?.safeSpacing?.length !== 1)
			return { rules: noRules, widths };
		const evidence = extractRuleEvidence(configuration, netRules, [...input.routing.nets], sourceRules, widths, []);
		return evidence.globalClearance.status === 'known' && evidence.boardEdgeClearance.status === 'known'
			? { rules: { clearanceMil: evidence.globalClearance.mil!, edgeClearanceMil: evidence.boardEdgeClearance.mil!, source: evidence.globalClearance.source }, widths }
			: { rules: noRules, widths };
	}
	catch {
		return { rules: noRules };
	}
}

async function reviewRoutingDetours(params: Record<string, any>, ctx?: ICommandContext) {
	if (params.nets !== undefined && (!Array.isArray(params.nets) || !params.nets.length
		|| params.nets.some((net: unknown) => typeof net !== 'string' || !net.trim())))
		throw new Error('nets 必须是非空网络名数组');
	if (params.minimumSavingsMil !== undefined && (!Number.isFinite(params.minimumSavingsMil) || params.minimumSavingsMil < 0))
		throw new Error('minimumSavingsMil 必须为大于等于零的有限数值');
	const target = ctx?.documentTarget;
	if (!target || target.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('绕行检查需要核对活动 PCB');
	const check = async () => {
		ctx.stopSignal?.assertActive();
		await ctx.assertDocumentTarget!();
	};
	await check();
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim())
		throw new Error('PCB 编辑器源码读取失败');
	const revision = await pcbSourceRevision(source, target.uuid);
	let pads: LocalPad[] | undefined;
	try {
		pads = await readRoutingPads();
	}
	catch {
		// Source-only path metrics are still useful. Coverage lists the missing geometry.
	}
	await check();
	const input = routingDetourSource(source, pads);
	if (input.routing.uuid !== target.uuid)
		throw new Error('当前 PCB 源码与指定文档身份不一致');
	const invalidNets = params.nets?.filter((net: string) => !input.routing.nets.has(net)) ?? [];
	if (invalidNets.length)
		throw new Error(`当前 PCB 未找到指定网络：${invalidNets.join('、')}`);
	const ruleState = await readRules(source, input, check);
	await check();
	const analysis = analyzeDetourBoard(input, { nets: params.nets, minimumSavingsMil: params.minimumSavingsMil, ...ruleState });
	const after = await eda.sys_FileManager.getDocumentSource();
	if (typeof after !== 'string' || await pcbSourceRevision(after, target.uuid) !== revision)
		throw new Error('扫描期间 PCB 已改变，绕行报告已失效，请重新检查');
	await check();
	return { ...analysis, target, revision, coordinateUnit: 'mil', safety: { readOnly: true, changesMade: false, drcVerified: false },
		scope: params.nets ? { nets: params.nets } : 'whole-board' };
}

export const routingDetourCommands: ICommandDef[] = [{
	name: 'pcb.reviewRoutingDetours',
	summary: '只读统计实际走线路径的线长、转弯、换层过孔和折返；验证同层候选捷径所经过的板框、已知障碍及可核实的间距规则',
	params: [
		{ name: 'nets', type: 'string[]', description: '可选网络名。缺省统计整板，所有网络仍参与障碍检查' },
		{ name: 'minimumSavingsMil', type: 'number', description: '只列出至少缩短指定 mil 的几何方案，可省略' },
	],
	returns: '当前 PCB 和修订、实际路径统计、可供复核的捷径、仅几何预览、阻挡对象和覆盖缺口。所有结果只读',
	example: { cmd: 'pcb.reviewRoutingDetours', params: { nets: ['SIG'] } },
	handler: reviewRoutingDetours,
}];
