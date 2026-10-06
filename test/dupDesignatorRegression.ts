// 回归：重复位号（一批 "R?"）场景——0.10.60 的 pinsByDev Record 按位号做 key 会互相覆盖，
// 只读到第一个器件的引脚，导致其余器件引脚穿线漏报。0.10.61 改 compPins 条目数组后必须全部读到。
import { runStructuralAudit } from '../src/commands/schematicAuditEngine'
import type { IAuditInput } from '../src/commands/schematicAuditEngine'

function mkInput(ncExempt: Array<string>): IAuditInput {
	return {
		wires: [
			// NET_A 100,300 → 200,300（宿主已把桥接线并入此 wire，net=NET_A）
			{ primitiveId: 'wA', net: 'NET_A', line: [100, 300, 200, 300] },
			// 桥接 150,200 → 150,300（与 wA、wB 都物理相接；宿主并入 wA，这里单开便于构图）
			{ primitiveId: 'wBr', net: 'NET_A', line: [150, 200, 150, 300] },
			// NET_B 100,200 → 200,200（官方电气合并后 primitive 的 net 已被解析为 NET_A，
			// NET_B 只残留在标签属性上 → 树内单网名，走 LABEL_NET_MISMATCH 而非 MULTI_NET_TREE）
			{ primitiveId: 'wB', net: 'NET_A', line: [100, 200, 200, 200] },
			// 孤立线
			{ primitiveId: 'wO', net: '', line: [400, 400, 450, 400] },
			// NET_C 500,250 → 560,250，穿过 R3 pin1(530,250)
			{ primitiveId: 'wC', net: 'NET_C', line: [500, 250, 560, 250] },
		],
		labels: [
			// 宿主行为：NET_B 标签残留挂在被合并的 NET_A 树上 → LABEL_NET_MISMATCH
			{ primitiveId: 'lB', net: 'NET_B', x: 120, y: 200, attached: true, wireId: 'wB' },
			{ primitiveId: 'lC', net: 'NET_C', x: 510, y: 250, attached: true, wireId: 'wC' },
		],
		comps: [
			{ primitiveId: 'c1', designator: 'R?', x: 100, y: 100 },
			{ primitiveId: 'c2', designator: 'R?', x: 200, y: 100 },
			{ primitiveId: 'c3', designator: 'R?', x: 530, y: 270 },
		],
		// 三个器件位号全是 "R?"——0.10.60 在这里只保留 c1 的引脚
		compPins: [
			{ primitiveId: 'c1', designator: 'R?', pins: [
				{ pinNumber: '1', pinName: '1', x: 520, y: 300 },
				{ pinNumber: '2', pinName: '2', x: 540, y: 300 },
			] },
			{ primitiveId: 'c2', designator: 'R?', pins: [
				{ pinNumber: '1', pinName: '1', x: 300, y: 100 },
				{ pinNumber: '2', pinName: '2', x: 320, y: 100 },
			] },
			{ primitiveId: 'c3', designator: 'R?', pins: [
				{ pinNumber: '1', pinName: '1', x: 530, y: 250 }, // 落在 NET_C 内部
				{ pinNumber: '2', pinName: '2', x: 530, y: 290 },
			] },
		],
		// 0.10.62 回归：无位号器件（图框）在 rects 存在时不得误报 COMP_OUTSIDE_REGION
		rects: [{ id: 'region1', span: { x1: 250, y1: 50, x2: 350, y2: 350 } }],
		ncExempt: new Set(ncExempt),
		deviceMargin: 10,
	}
}

let failed = 0
const check = (cond: boolean, label: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
	if (!cond) failed++
}

const r1 = runStructuralAudit(mkInput([]))
check(r1.stats.pins === 6, `stats.pins == 6（0.10.60 实际只有 2）→ ${r1.stats.pins}`)
const lands = r1.issues.filter(i => i.rule === 'PIN_INTERIOR_LANDING')
check(lands.length === 1 && lands[0].message.includes('R?.1') && lands[0].net === 'NET_C',
	`R3(R?).pin1 穿线 NET_C 被报出 → ${JSON.stringify(lands.map(l => [l.message, l.net]))}`)
check(r1.issues.filter(i => i.rule === 'DUPLICATE_DESIGNATOR' && i.type === 'blocking').length === 2,
	'DUPLICATE_DESIGNATOR ×2 仍正常')
check(r1.issues.some(i => i.rule === 'LABEL_NET_MISMATCH' && i.type === 'blocking'),
	'桥接经 LABEL_NET_MISMATCH 抓到（blocking）')
check(!r1.issues.some(i => i.rule === 'MULTI_NET_TREE'),
	'真实宿主数据 MULTI_NET_TREE 不触发（符合语义预期）')

const r2 = runStructuralAudit(mkInput(['R?.1']))
check(!r2.issues.some(i => i.rule === 'PIN_INTERIOR_LANDING'),
	'ncExempt=["R?.1"] 后穿线候选消失（豁免通道有效）')

const r3 = runStructuralAudit({
	...mkInput([]),
	comps: [
		...mkInput([]).comps,
		{ primitiveId: 'tb', designator: undefined, x: 0, y: 0 }, // 图框标题块
	],
})
check(!r3.issues.some(i => i.rule === 'COMP_OUTSIDE_REGION' && i.primitiveIds.includes('tb')),
	'无位号图框器件不报 COMP_OUTSIDE_REGION（0.10.62）')
check(r3.issues.some(i => i.rule === 'COMP_OUTSIDE_REGION' && i.primitiveIds.includes('c1')),
	'有位号器件出区仍正常报（c1 在 100,100 不在 region1 内）')

process.exit(failed ? 1 : 0)
