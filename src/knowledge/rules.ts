/**
 * 布线 / 设计知识库（规则包 MVP）
 *
 * 设计原则：
 * - 规则包是结构化数据，插件执行布线类指令时自行加载，AI 无需了解细节；
 * - knowledge.query 供 AI 在不确定时按关键词检索经验条目；
 * - 后续可扩展为外部 JSON 规则文件 + RAG（参考官方 eext-knowledge-base）。
 */

export interface IRuleEntry {
	/** 规则 ID */
	id: string
	/** 关键词（用于检索匹配） */
	keywords: Array<string>
	/** 规则主题 */
	title: string
	/** 结构化约束（插件执行时使用） */
	constraints?: Record<string, any>
	/** 给 AI / 用户的文字说明 */
	guidance: string
}

/** IPC-2221 简化线宽-载流表（1oz 铜厚，外层，温升 10°C） */
export const TRACE_WIDTH_TABLE: Array<{ currentA: number, widthMm: number, widthMil: number }> = [
	{ currentA: 0.5, widthMm: 0.15, widthMil: 6 },
	{ currentA: 1.0, widthMm: 0.3, widthMil: 12 },
	{ currentA: 1.5, widthMm: 0.5, widthMil: 20 },
	{ currentA: 2.0, widthMm: 0.7, widthMil: 28 },
	{ currentA: 3.0, widthMm: 1.2, widthMil: 47 },
	{ currentA: 4.0, widthMm: 1.8, widthMil: 71 },
	{ currentA: 5.0, widthMm: 2.5, widthMil: 98 },
]

export const RULE_ENTRIES: Array<IRuleEntry> = [
	{
		id: 'trace-width-current',
		keywords: ['线宽', '载流', '电流', 'width', 'current', '电源线', 'power'],
		title: '线宽-载流规则（IPC-2221 简化，1oz 外层）',
		constraints: { table: TRACE_WIDTH_TABLE, copperOz: 1, tempRiseC: 10 },
		guidance: '按网络电流查表取线宽；内层走线需约 2 倍宽度。电源主路径建议不小于 1A 对应 0.3mm，并留 50% 余量。',
	},
	{
		id: 'usb2-diff-pair',
		keywords: ['usb', '差分', 'differential', 'dp', 'dm', '90欧', '90ohm'],
		title: 'USB 2.0 差分对布线约束',
		constraints: {
			differentialImpedanceOhm: 90,
			intraPairSkewMil: 150,
			minPairGapMil: 8,
			referencePlane: '完整 GND 平面，禁止跨分割',
		},
		guidance: 'USB D+/D- 差分阻抗 90Ω，对内等长偏差 < 150mil；走线全程伴随完整地平面，避免过孔，必须换层时两线同位置伴地过孔。',
	},
	{
		id: 'decoupling-capacitor',
		keywords: ['去耦', '退耦', 'decoupling', '电容', 'bypass', '电源完整'],
		title: '去耦电容布局规则',
		constraints: { maxDistanceMm: 3, viaBeforeCap: false },
		guidance: '去耦电容紧贴芯片电源引脚放置（< 3mm），电流先经电容再到引脚；电容接地端用过孔就近下地，多电容时小容值靠最近。',
	},
	{
		id: 'crystal-layout',
		keywords: ['晶振', 'crystal', 'oscillator', '时钟', 'clock'],
		title: '晶振布局布线规则',
		constraints: { keepOutUnder: true, guardRing: 'GND' },
		guidance: '晶振紧贴 MCU 时钟引脚，下方各层禁止走线并铺地屏蔽；负载电容靠近晶振，时钟线短且远离开关节点。',
	},
	{
		id: 'power-routing',
		keywords: ['电源', 'power', '铺铜', 'pour', 'gnd', '地线'],
		title: '电源与地布线规则',
		constraints: { preferPour: true, minWidthA1Mm: 0.3 },
		guidance: '地网络优先整层铺铜；电源主干按载流表加宽并优先走顶层；避免地环路，大电流回路面积最小化。',
	},
	{
		id: 'buck-layout',
		keywords: ['buck', '降压', 'dcdc', 'dc-dc', '开关电源', 'tps5450', '电感', 'sw节点', '开关节点'],
		title: '降压 DC-DC（Buck）布局规则',
		constraints: {
			inputCapToIcMm: 2,
			swLoopMinimize: true,
			bootCapToIcMm: 1.5,
			fbAwayFromSw: true,
		},
		guidance: '输入电容紧贴 IC 的 VIN 与 GND 引脚（< 2mm），输入高频回路（VIN→电容→GND）面积最小；SW/PH 开关节点走线短而窄、只够载流即可，远离反馈和模拟信号；自举电容紧贴 BOOT 与 PH 引脚；续流二极管/电感紧贴 SW 引脚；反馈分压电阻靠近 FB 引脚，采样点取在输出电容之后；输出电容地端与 IC 地单点汇接。',
	},
	{
		id: 'current-sense-kelvin',
		keywords: ['采样电阻', '取样电阻', '电流采样', 'sense', 'kelvin', '开尔文', '分流'],
		title: '电流采样电阻（开尔文连接）规则',
		constraints: { kelvinRequired: true, senseTraceWidthMil: 10 },
		guidance: '采样信号必须从采样电阻焊盘内侧单独引出（开尔文连接），不得与主电流路径共用铜皮；采样线等长、并行走线、远离开关节点；采样电阻放在主电流路径上且靠近负载侧，方向与电流一致。',
	},
	{
		id: 'power-current-path',
		keywords: ['电流走向', '电流路径', '主回路', 'current path', 'loop', '环路面积'],
		title: '大电流路径规划规则',
		constraints: { mainPathPreferTopLayer: true, avoidViaOnMainPath: true },
		guidance: '先规划主电流走向再布局：输入→开关→电感→输出→地的环路走最短直线，中途不换层不打过孔；大电流路径用铺铜而非细线；信号地与功率地单点连接；连接器/保险丝等串联器件按电流方向一字排开。',
	},
	{
		id: 'thermal-layout',
		keywords: ['散热', '热', 'thermal', '发热', '温升', '散热过孔'],
		title: '发热器件散热布局规则',
		constraints: { thermalViaGridMm: 1.2, hotComponentSpacingMm: 5 },
		guidance: '发热器件（LDO、功率管、采样电阻）间距 ≥ 5mm；底部铺铜并打散热过孔阵列（约 1.2mm 网格）到背面铜皮；远离电解电容和晶振等热敏器件；优先放在板边利于空气流通处。',
	},
	{
		id: 'ldo-layout',
		keywords: ['ldo', '线性电源', '线性稳压', '稳压器', 'regulator', 'ams1117', '压差', '1117', '低压差'],
		title: 'LDO/线性电源布局规则',
		constraints: {
			inputCapToPinMm: 3,
			outputCapToPinMm: 3,
			outputCapEsr: '注意器件数据手册 ESR 稳定范围（如 AMS1117 要求输出电容 ESR 0.1~10Ω，慎用超低 ESR 陶瓷电容）',
			heatW: 'P = (VIN - VOUT) × IOUT',
		},
		guidance: '输入/输出电容紧贴对应引脚（< 3mm），地端就近过孔下地；发热按「压差 × 输出电流」估算，超过约 0.5W 就要铺铜散热（大面积铜皮作散热器，必要时散热过孔到背面）；输出电容 ESR 要落在手册稳定区间，全陶瓷方案先查手册是否支持。',
	},
	{
		id: 'connector-esd',
		keywords: ['连接器', '接口', 'esd', 'tvs', '防护', '防雷', '保险丝', '浪涌', 'connector', '静电', '端口'],
		title: '连接器/接口防护布局规则',
		constraints: {
			protectionToConnectorMm: 5,
			protectionFirst: true,
			protectGndToChassis: true,
			noParallelPrePost: true,
		},
		guidance: 'ESD/TVS、保险丝、共模电感等防护器件紧靠接口入口（< 5mm），信号进板第一站就是防护，再进滤波和电路；防护器件地直接短接机壳地/大地（低阻抗粗连接），不要绕进信号地；防护器件前后的走线不并行不靠近，防止浪涌耦合绕过防护。',
	},
	{
		id: 'analog-digital-partition',
		keywords: ['模拟', '数字', '分区', 'analog', 'digital', 'adc', '模数', '混合信号', '地分割', '单点接地', '前端'],
		title: '模拟/数字分区布局规则',
		constraints: {
			partitionRequired: true,
			adcFrontEndShort: true,
			gndSinglePoint: 'ADC 下方或电源入口处单点连接',
			noAnalogCrossSplit: true,
			clockAwayFromAnalogMm: 10,
		},
		guidance: '模拟区和数字区物理分开布局， ADC 放在交界处；模拟前端走线短、直接进 ADC，不跨地分割、不与数字线并行长距离；模拟地与数字地单点连接（ADC 下方或电源入口）；晶振/时钟/开关节点远离模拟前端（≥ 10mm）。',
	},
	{
		id: 'reset-boot-circuit',
		keywords: ['复位', 'reset', 'boot', '启动', '上拉', 'rst', 'nrst', '复位电路', '跳线', 'boot0'],
		title: '复位/BOOT 电路布局规则',
		constraints: {
			pullupToMcuMm: 10,
			resetTraceShort: true,
			awayFromNoise: ['SW', '时钟', '高速信号'],
			jumperAtEdge: true,
		},
		guidance: '复位上拉电阻和复位电容靠近 MCU 复位引脚（< 10mm），复位走线短、远离 SW/时钟/高速干扰源（复位线受干扰会导致随机复位）；BOOT 跳线/按键/拨码靠板边放置方便操作，丝印标注 0/1 状态含义。',
	},
	{
		id: 'hmi-components',
		keywords: ['led', '按键', '按钮', '指示灯', '拨码', '人机', 'hmi', 'button', 'switch', '蜂鸣器', '数码管'],
		title: 'LED/按键等人机件布局规则',
		constraints: {
			ledAtEdgeOrWindow: true,
			ledOrientationUniform: true,
			currentLimitResNearLedMm: 10,
			buttonAtEdge: true,
			polarityMark: true,
		},
		guidance: 'LED 靠板边或对准面板开窗，多个 LED 方向一致、间距均匀，限流电阻就近放置（< 10mm）；按键/拨码靠板边、触手可及，丝印标注功能；LED/蜂鸣器/电解等有极性器件丝印标清极性，方向尽量统一方便目检。',
	},
	{
		id: 'impedance-control',
		keywords: ['阻抗', 'impedance', '50欧', '90欧', '100欧', '差分阻抗', '射频', 'rf', '以太网', 'ethernet', '受控阻抗', '特征阻抗'],
		title: '阻抗控制通用规则',
		constraints: {
			singleEndedOhm: 50,
			usbDiffOhm: 90,
			ethernetDiffOhm: 100,
			referencePlaneSolid: true,
			minLayerChange: true,
			gndViaOnLayerChange: true,
			stubMinimize: true,
		},
		guidance: '常用阻抗：RF/时钟单端 50Ω、USB 差分 90Ω、以太网差分 100Ω（具体叠层线宽找板厂算）；阻抗线下方参考平面必须完整连续、不跨分割；少换层，换层时信号过孔旁伴地过孔（差分两根同位置换层）；分支 stub 最短，阻抗线不走直角。',
	},
	{
		id: 'via-rules',
		keywords: ['过孔', 'via', '过孔规则', '孔径', '过孔载流', '盘中孔', '通孔', '打几个过孔'],
		title: '过孔使用规则',
		constraints: {
			powerViaPerA: '每 1A 至少 1 个 0.3mm 过孔，大电流多过孔阵列分摊',
			signalViaMm: { drill: 0.3, pad: 0.6 },
			thermalViaGridMm: 1.2,
			noViaInPad: '除盘中孔（VIPPO）工艺外，过孔不压焊盘',
		},
		guidance: '电源/地换层过孔按电流配数量：每 1A 约 1 个 0.3mm（孔径）过孔起步，大电流路径用多过孔阵列；信号过孔默认 0.3/0.6mm（孔/盘）；散热过孔阵约 1.2mm 网格；过孔不要打在焊盘上（漏锡虚焊），需要盘中孔必须选对应工艺并说明。',
	},
	{
		id: 'silkscreen-assembly',
		keywords: ['丝印', 'silkscreen', '位号', '装配', '贴片', 'assembly', '极性标记', '脚1', '禁布区', '板边', '返修'],
		title: '丝印与装配规则',
		constraints: {
			refOrientationMax: 2,
			polarityMarkRequired: ['二极管', '电解电容', 'LED', '钽电容', '蜂鸣器'],
			connectorPin1Mark: true,
			componentSpacingMm: 1,
			edgeKeepoutMm: 3,
		},
		guidance: '位号丝印方向统一（全板最多两个方向，方便阅读和返修）；二极管/电解/LED/钽电容标极性，连接器标脚 1；器件间距 ≥ 1mm 满足贴片与返修操作；板边禁布区默认 3mm（导轨/外壳干涉），接插件伸出量按结构确认。',
	},
]

/** 关键词检索：返回匹配度排序的规则条目 */
export function queryRules(query: string, limit = 3): Array<IRuleEntry> {
	const q = query.toLowerCase()
	const scored = RULE_ENTRIES
		.map((entry) => {
			let score = 0
			for (const kw of entry.keywords) {
				if (q.includes(kw.toLowerCase()))
					score += kw.length
			}
			if (entry.title.toLowerCase().includes(q))
				score += 10
			return { entry, score }
		})
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score)
	return scored.slice(0, limit).map(item => item.entry)
}

/** 按载流需求查线宽（返回满足电流的最小线宽） */
export function widthForCurrent(currentA: number): { widthMm: number, widthMil: number } | undefined {
	const hit = TRACE_WIDTH_TABLE.find(row => row.currentA >= currentA)
	return hit ? { widthMm: hit.widthMm, widthMil: hit.widthMil } : undefined
}
