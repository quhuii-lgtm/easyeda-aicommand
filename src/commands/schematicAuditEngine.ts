/**
 * structuralAudit 分析引擎（0.10.63）
 * 并查集配对走均匀网格空间哈希（bbox 剪枝，结果与全量 O(n²) 完全一致）
 * 原理：几何并查集把物理相接的导线段编成树，再用官方解析的 net 字段对账。
 * 判定来源：listWires 的 net 是宿主官方连接语义（非几何猜测），
 * 因此"合法 T 接/同网重叠"与"异网桥接"可严格区分。
 * 与工作区 sch_audit.py 算法同源（阳性 5/5、阴性 3 页 0 误报实测后移植）。
 * 零依赖纯函数，可独立单测。
 */

export interface IAuditWire { primitiveId: string, net: string, line: Array<number> }
export interface IAuditLabel { primitiveId: string, net: string, x?: number, y?: number, attached?: boolean, wireId?: string }
export interface IAuditComp { primitiveId: string, designator?: string, x?: number, y?: number }
export interface IAuditPin { pinNumber?: string, pinName?: string, x: number, y: number }
export interface IAuditRect { id: string, span: { x1: number, y1: number, x2: number, y2: number } }
export interface IAuditIssue {
	rule: string
	type: 'blocking' | 'candidate' | 'info'
	primitiveIds: Array<string>
	net?: string
	message: string
	coords?: { x: number, y: number }
}
export interface IAuditCompPins { primitiveId: string, designator?: string, pins: Array<IAuditPin> }
export interface IAuditInput {
	wires: Array<IAuditWire>
	labels: Array<IAuditLabel>
	comps: Array<IAuditComp>
	/** 每器件一条引脚条目（数组而非按位号索引——真实页面上未规范化位号会重复，Record 会互相覆盖丢引脚） */
	compPins: Array<IAuditCompPins>
	rects: Array<IAuditRect>
	ncExempt: Set<string>
	deviceMargin: number
}

export const AUDIT_EPS = 0.5

/** 轴对齐包围盒相交快筛（空间哈希的剪枝依据；只做数值比较，不做几何运算） */
function auditBboxHit(s: TSeg, t: TSeg): boolean {
	return Math.max(s[0], s[2]) >= Math.min(t[0], t[2]) - AUDIT_EPS
		&& Math.min(s[0], s[2]) <= Math.max(t[0], t[2]) + AUDIT_EPS
		&& Math.max(s[1], s[3]) >= Math.min(t[1], t[3]) - AUDIT_EPS
		&& Math.min(s[1], s[3]) <= Math.max(t[1], t[3]) + AUDIT_EPS
}

type TSeg = [number, number, number, number]

function auditPtOnSeg(px: number, py: number, s: TSeg, interior = false): boolean {
	const cross = (px - s[0]) * (s[3] - s[1]) - (py - s[1]) * (s[2] - s[0])
	if (Math.abs(cross) > AUDIT_EPS)
		return false
	const dot = (px - s[0]) * (px - s[2]) + (py - s[1]) * (py - s[3])
	return interior ? dot < -AUDIT_EPS : dot <= AUDIT_EPS
}

/** 物理相接（官方语义）：端点相接 / T 接 / 共线重叠；内部十字交叉不算 */
function auditSegsTouch(s: TSeg, t: TSeg): boolean {
	if (auditPtOnSeg(s[0], s[1], t) || auditPtOnSeg(s[2], s[3], t))
		return true
	return auditPtOnSeg(t[0], t[1], s) || auditPtOnSeg(t[2], t[3], s)
}

/** 共线重叠长度（线压线统计） */
function auditCollinearOverlap(s: TSeg, t: TSeg): number {
	const axisOf = (seg: TSeg): 'v' | 'h' | 'o' => Math.abs(seg[0] - seg[2]) < AUDIT_EPS
		? 'v'
		: (Math.abs(seg[1] - seg[3]) < AUDIT_EPS ? 'h' : 'o')
	const a = axisOf(s)
	const b = axisOf(t)
	if (a === 'o' || a !== b)
		return 0
	if (a === 'h') {
		if (Math.abs(s[1] - t[1]) > AUDIT_EPS)
			return 0
		const lo = Math.max(Math.min(s[0], s[2]), Math.min(t[0], t[2]))
		const hi = Math.min(Math.max(s[0], s[2]), Math.max(t[0], t[2]))
		return Math.max(0, hi - lo)
	}
	if (Math.abs(s[0] - t[0]) > AUDIT_EPS)
		return 0
	const lo = Math.max(Math.min(s[1], s[3]), Math.min(t[1], t[3]))
	const hi = Math.min(Math.max(s[1], s[3]), Math.max(t[1], t[3]))
	return Math.max(0, hi - lo)
}

export function runStructuralAudit(input: IAuditInput): { issues: Array<IAuditIssue>, stats: Record<string, number> } {
	const issues: Array<IAuditIssue> = []
	const add = (rule: string, type: IAuditIssue['type'], message: string, primitiveIds?: Array<string>, net?: string, coords?: { x: number, y: number }) => {
		const it: IAuditIssue = { rule, type, message, primitiveIds: primitiveIds ?? [] }
		if (net != null)
			it.net = net
		if (coords)
			it.coords = coords
		issues.push(it)
	}

	// 1. 解析线段（flat [x1,y1,x2,y2,...] → 简单段；零长重复点只计数）
	const allSegs: Array<{ wire: number, seg: TSeg }> = []
	let zeroCount = 0
	input.wires.forEach((w, wi) => {
		const line = w.line ?? []
		const pts: Array<[number, number]> = []
		for (let i = 0; i + 1 < line.length; i += 2)
			pts.push([Number(line[i]), Number(line[i + 1])])
		for (let i = 0; i + 1 < pts.length; i++) {
			const [x1, y1] = pts[i]
			const [x2, y2] = pts[i + 1]
			if (Math.abs(x1 - x2) < AUDIT_EPS && Math.abs(y1 - y2) < AUDIT_EPS) {
				zeroCount++
				continue
			}
			allSegs.push({ wire: wi, seg: [x1, y1, x2, y2] })
		}
	})
	if (zeroCount)
		add('ZERO_LENGTH_SEG', 'info', `${zeroCount} 个零长度重复点（画线痕迹，无害）`)

	const n = allSegs.length
	const parent = Array.from({ length: n }, (_, i) => i)
	const find = (x: number): number => {
		let r = x
		while (parent[r] !== r)
			r = parent[r]
		// 路径压缩
		while (parent[x] !== r) {
			const nxt = parent[x]
			parent[x] = r
			x = nxt
		}
		return r
	}
	const union = (a: number, b: number) => { parent[find(a)] = find(b) }

	// 2. 并查集——0.10.63 空间哈希剪枝：均匀网格（200mil/格）按 bbox 入格，
	// 只测试同格线段对（bbox 不相交的对不可能相接/交叉，结果与全量 O(n²) 完全一致）
	const GRID = 200
	const cellOf = (v: number): number => Math.floor(v / GRID)
	const grid = new Map<string, Array<number>>()
	for (let i = 0; i < n; i++) {
		const s = allSegs[i].seg
		const cx1 = cellOf(Math.min(s[0], s[2]) - AUDIT_EPS), cx2 = cellOf(Math.max(s[0], s[2]) + AUDIT_EPS)
		const cy1 = cellOf(Math.min(s[1], s[3]) - AUDIT_EPS), cy2 = cellOf(Math.max(s[1], s[3]) + AUDIT_EPS)
		for (let cx = cx1; cx <= cx2; cx++) {
			for (let cy = cy1; cy <= cy2; cy++) {
				const key = `${cx},${cy}`
				if (!grid.has(key))
					grid.set(key, [])
				grid.get(key)!.push(i)
			}
		}
	}
	const interiorCross: Array<[number, number]> = []
	const tested = new Set<string>()
	for (const mates of grid.values()) {
		for (let a = 0; a < mates.length; a++) {
			const i = mates[a]
			const s = allSegs[i].seg
			for (let b = a + 1; b < mates.length; b++) {
				const j = mates[b]
				const key = i < j ? `${i}|${j}` : `${j}|${i}`
				if (tested.has(key))
					continue
				tested.add(key)
				const t = allSegs[j].seg
				if (auditSegsTouch(s, t)) {
					union(i, j)
					continue
				}
				const sThroughT = auditPtOnSeg(s[0], s[1], t, true) || auditPtOnSeg(s[2], s[3], t, true)
				const tThroughS = auditPtOnSeg(t[0], t[1], s, true) || auditPtOnSeg(t[2], t[3], s, true)
				if (sThroughT && tThroughS)
					interiorCross.push([i, j])
			}
		}
	}

	// 3. 引脚落点（引脚可落在多条线段上，全部记录）
	// 内部 key 带条目序号防撞（重复位号时多个器件的 "R?.1" 会并存）；
	// 豁免匹配与报文用展示 key `${designator}.${pinNumber}`
	const pinSegs = new Map<string, Array<number>>() // 内部 key -> segidx[]
	const pinInfo = new Map<string, IAuditPin & { dev: string }>()
	input.compPins.forEach((entry, ei) => {
		const dev = entry.designator || entry.primitiveId
		for (const p of entry.pins) {
			const key = `${dev}.${p.pinNumber ?? '?'}@${ei}`
			pinInfo.set(key, { ...p, dev })
			const hits: Array<number> = []
			for (let i = 0; i < n; i++) {
				// bbox 快筛：引脚点不在线段包围盒 ±EPS 内不可能落在线段上
				const s = allSegs[i].seg
				if (p.x < Math.min(s[0], s[2]) - AUDIT_EPS || p.x > Math.max(s[0], s[2]) + AUDIT_EPS
					|| p.y < Math.min(s[1], s[3]) - AUDIT_EPS || p.y > Math.max(s[1], s[3]) + AUDIT_EPS)
					continue
				if (auditPtOnSeg(p.x, p.y, s))
					hits.push(i)
			}
			if (hits.length)
				pinSegs.set(key, hits)
		}
	})
	const pinAt = new Map<number, Array<string>>() // segidx -> keys
	for (const [key, hits] of pinSegs) {
		for (const i of hits) {
			if (!pinAt.has(i))
				pinAt.set(i, [])
			pinAt.get(i)!.push(key)
		}
	}

	// 4. 树级对账
	const trees = new Map<number, Array<number>>()
	for (let i = 0; i < n; i++) {
		const r = find(i)
		if (!trees.has(r))
			trees.set(r, [])
		trees.get(r)!.push(i)
	}

	const wireNet = (i: number): string => (input.wires[allSegs[i].wire].net ?? '').trim()
	const wireId = (i: number): string => input.wires[allSegs[i].wire].primitiveId

	const allPinsFlat: Array<{ x: number, y: number }> = input.compPins.flatMap(e => e.pins)

	for (const members of trees.values()) {
		const netMap = new Map<string, number>()
		for (const i of members) {
			const net = wireNet(i) || '(无名)'
			netMap.set(net, (netMap.get(net) ?? 0) + 1)
		}
		const treeNets = new Set([...netMap.keys()].filter(k => k !== '(无名)'))
		const treePins = new Set<string>()
		for (const i of members) {
			for (const key of pinAt.get(i) ?? [])
				treePins.add(key)
		}
		const treeLabels: Array<IAuditLabel> = []
		for (const lb of input.labels) {
			let hit = false
			if (lb.wireId)
				hit = members.some(i => wireId(i) === lb.wireId)
			if (!hit && lb.x != null && lb.y != null)
				hit = members.some(i => auditPtOnSeg(lb.x!, lb.y!, allSegs[i].seg))
			if (hit)
				treeLabels.push(lb)
		}

		// ① 多网线树 = 桥接实锤
		if (netMap.size > 1) {
			const detail = [...netMap.entries()].map(([k, v]) => `${k}×${v}`).join('; ')
			add('MULTI_NET_TREE', 'blocking',
				`一棵导线树内出现多个网名（${detail}），疑似异网桥接/短路`,
				members.map(wireId), [...netMap.keys()].filter(k => k !== '(无名)').join('/') || undefined)
		}
		// ② 标签 vs 树网名
		for (const lb of treeLabels) {
			const lnet = (lb.net ?? '').trim()
			if (lnet && treeNets.size && !treeNets.has(lnet)) {
				add('LABEL_NET_MISMATCH', 'blocking',
					`标签「${lnet}」挂在网名为 ${[...treeNets].join('/')} 的树上`,
					[lb.primitiveId, ...members.slice(0, 3).map(wireId)], lnet,
					lb.x != null && lb.y != null ? { x: lb.x, y: lb.y } : undefined)
			}
		}
		// ④ 孤立线树
		if (!treeNets.size && !treePins.size && !treeLabels.length) {
			add('ORPHAN_TREE', 'candidate', '孤立线树：无网名、无引脚、无标签',
				members.map(wireId), undefined,
				{ x: allSegs[members[0]].seg[0], y: allSegs[members[0]].seg[1] })
		}
		// ⑤ 悬空线头（info）
		const deg = new Map<string, number>()
		for (const i of members) {
			const s = allSegs[i].seg
			for (const v of [`${s[0]},${s[1]}`, `${s[2]},${s[3]}`]) {
				deg.set(v, (deg.get(v) ?? 0) + 1)
			}
		}
		for (const [v, d] of deg) {
			if (d !== 1)
				continue
			const [vx, vy] = v.split(',').map(Number)
			const onPin = allPinsFlat.some(p => Math.abs(p.x - vx) < AUDIT_EPS && Math.abs(p.y - vy) < AUDIT_EPS)
			const nearLabel = input.labels.some(lb => lb.x != null && lb.y != null
				&& Math.abs(lb.x - vx) <= 15 && Math.abs(lb.y - vy) <= 15)
			if (!onPin && !nearLabel && treeNets.size)
				add('DANGLING_END', 'info', `线头悬端 (${vx},${vy}) 无引脚无标签`, members.map(wireId), [...treeNets][0], { x: vx, y: vy })
		}
	}

	// 5. 浮空标签（全局）
	for (const lb of input.labels) {
		if (lb.attached === false) {
			const lnet = (lb.net ?? '').trim()
			add('FLOATING_LABEL', 'candidate', `标签「${lnet}」未挂接任何导线（attached=false）`,
				[lb.primitiveId], lnet || undefined,
				lb.x != null && lb.y != null ? { x: lb.x, y: lb.y } : undefined)
		}
	}
	// 引脚穿线（严格位于线段内部）
	for (const [key, hits] of pinSegs) {
		const p = pinInfo.get(key)
		if (!p)
			continue
		const disp = `${p.dev}.${p.pinNumber ?? '?'}`
		if (input.ncExempt.has(disp))
			continue
		for (const i of hits) {
			if (auditPtOnSeg(p.x, p.y, allSegs[i].seg, true)) {
				const wnet = wireNet(i)
				add('PIN_INTERIOR_LANDING', 'candidate',
					`引脚 ${disp}(${p.pinName ?? ''}) 落在 ${wnet || '无名'} 导线内部（穿线/压线），官方网名：${wnet || '（无）'}`,
					[wireId(i)], wnet || undefined, { x: p.x, y: p.y })
				break
			}
		}
	}
	// 线压线（不同网名共线重叠=blocking；同网名只计数）
	let sameNetOverlap = 0
	const seenOv = new Set<string>()
	for (let i = 0; i < n; i++) {
		const si = allSegs[i].seg
		for (let j = i + 1; j < n; j++) {
			const sj = allSegs[j].seg
			if (!auditBboxHit(si, sj))
				continue
			const ov = auditCollinearOverlap(si, sj)
			if (ov <= AUDIT_EPS)
				continue
			const ni = wireNet(i), nj = wireNet(j)
			if (ni === nj) {
				sameNetOverlap++
				continue
			}
			const ids = [wireId(i), wireId(j)].sort()
			const key = ids.join('|')
			if (seenOv.has(key))
				continue
			seenOv.add(key)
			add('WIRE_COLLINEAR_OVERLAP', 'blocking',
				`不同网名导线共线重叠 ${Math.round(ov)}mil：${ni || '无名'} × ${nj || '无名'}`,
				ids, `${ni}|${nj}`)
		}
	}
	if (sameNetOverlap)
		add('WIRE_OVERLAP_SAME_NET', 'info', `${sameNetOverlap} 处同网名导线共线重叠（无害但建议清理）`)
	// 内部十字交叉（官方 net 不同 → 候选，供目检）
	const seenCross = new Set<string>()
	for (const [i, j] of interiorCross) {
		const ni = wireNet(i), nj = wireNet(j)
		if (!ni || !nj || ni === nj)
			continue
		const ids = [wireId(i), wireId(j)].sort()
		const key = ids.join('|')
		if (seenCross.has(key))
			continue
		seenCross.add(key)
		add('CROSSING_INTERIOR', 'candidate',
			`导线内部十字交叉且官方网名不同（${ni} × ${nj}）：官方语义未接通，建议目检确认无结点`,
			ids, `${ni}|${nj}`)
	}

	// 6. 功能区（rect）：框重叠 + 器件归区
	const rectList = input.rects
	for (let a = 0; a < rectList.length; a++) {
		for (let b = a + 1; b < rectList.length; b++) {
			const A = rectList[a].span, B = rectList[b].span
			const ox = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1)
			const oy = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1)
			if (ox > 0 && oy > 0)
				add('RECT_OVERLAP', 'candidate', `功能区框重叠，面积 ${Math.round(ox * oy)} mil²`,
					[rectList[a].id, rectList[b].id])
		}
	}
	if (rectList.length) {
		for (const c of input.comps) {
			// 无位号器件（图框标题块等）不是器件，跳过——否则每页稳定误报一条 candidate（0.10.62）
			if (!c.designator)
				continue
			const cx = c.x, cy = c.y
			if (cx == null || cy == null)
				continue
			const hit = rectList.some(r => r.span.x1 - AUDIT_EPS <= cx && cx <= r.span.x2 + AUDIT_EPS
				&& r.span.y1 - AUDIT_EPS <= cy && cy <= r.span.y2 + AUDIT_EPS)
			if (!hit)
				add('COMP_OUTSIDE_REGION', 'candidate',
					`器件 ${c.designator || c.primitiveId} 原点 (${cx},${cy}) 不在任何功能区框内`,
					[c.primitiveId], undefined, { x: cx, y: cy })
		}
	}
	// 7. 重复位号 + 器件不碰（引脚云 ± margin 筛选，candidate 待目检）
	const seenDev = new Map<string, string>()
	for (const c of input.comps) {
		if (!c.designator)
			continue
		if (seenDev.has(c.designator)) {
			add('DUPLICATE_DESIGNATOR', 'blocking', `位号 ${c.designator} 出现多次（${seenDev.get(c.designator)} 与 ${c.primitiveId}）`,
				[seenDev.get(c.designator)!, c.primitiveId])
		}
		else {
			seenDev.set(c.designator, c.primitiveId)
		}
	}
	const boxes: Array<{ dev: string, id: string, x1: number, y1: number, x2: number, y2: number }> = []
	for (const entry of input.compPins) {
		// 重复位号只取首个出现器件的引脚（与 comps 去重口径一致）
		if (!entry.designator || seenDev.get(entry.designator) !== entry.primitiveId)
			continue
		if (!entry.pins.length)
			continue
		const xs = entry.pins.map(p => p.x), ys = entry.pins.map(p => p.y)
		const m = input.deviceMargin
		boxes.push({ dev: entry.designator, id: entry.primitiveId,
			x1: Math.min(...xs) - m, y1: Math.min(...ys) - m, x2: Math.max(...xs) + m, y2: Math.max(...ys) + m })
	}
	for (let a = 0; a < boxes.length; a++) {
		for (let b = a + 1; b < boxes.length; b++) {
			const A = boxes[a], B = boxes[b]
			const ox = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1)
			const oy = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1)
			if (ox > 0 && oy > 0)
				add('DEVICE_BBOX_OVERLAP', 'candidate',
					`器件 ${A.dev} × ${B.dev} 本体包围盒（引脚云+${input.deviceMargin}mil 近似）重叠 ${Math.round(ox)}×${Math.round(oy)}mil，需目检确认实际本体是否相碰`,
					[A.id, B.id])
		}
	}

	const stats = {
		wires: input.wires.length,
		segments: n,
		trees: trees.size,
		labels: input.labels.length,
		comps: input.comps.length,
		pins: allPinsFlat.length,
		rects: rectList.length,
	}
	return { issues, stats }
}
