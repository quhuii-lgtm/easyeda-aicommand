/**
 * 知识库类指令
 */
import type { ICommandDef } from '../engine/types'
import { queryRules, RULE_ENTRIES, widthForCurrent } from '../knowledge/rules'

export const knowledgeCommands: Array<ICommandDef> = [
	{
		name: 'knowledge.query',
		summary: '查询布线 / 设计知识库（按关键词检索规则与经验）',
		params: [
			{ name: 'query', type: 'string', required: true, description: '查询关键词，如 "USB差分"、"线宽"、"去耦"' },
			{ name: 'limit', type: 'number', description: '返回条目上限，默认 3' },
		],
		returns: '规则条目列表 [{ id, title, constraints, guidance }]',
		example: { cmd: 'knowledge.query', params: { query: 'USB 差分' } },
		handler: async (params) => {
			if (!params.query)
				throw new Error('缺少参数 query')
			const entries = queryRules(String(params.query), Number(params.limit) || 3)
			if (entries.length === 0)
				return { matched: [], hint: '知识库暂无匹配条目，可按通用规则设计或先查询 knowledge.listRules' }
			return { matched: entries }
		},
	},
	{
		name: 'knowledge.listRules',
		summary: '列出知识库全部规则主题',
		params: [],
		returns: '规则主题列表 [{ id, title, keywords }]',
		example: { cmd: 'knowledge.listRules' },
		handler: async () => {
			return RULE_ENTRIES.map(({ id, title, keywords }) => ({ id, title, keywords }))
		},
	},
	{
		name: 'knowledge.widthForCurrent',
		summary: '按载流（安培）查询推荐线宽',
		params: [
			{ name: 'currentA', type: 'number', required: true, description: '载流，单位 A' },
		],
		returns: '{ widthMm, widthMil }',
		example: { cmd: 'knowledge.widthForCurrent', params: { currentA: 2 } },
		handler: async (params) => {
			if (params.currentA == null)
				throw new Error('缺少参数 currentA')
			const hit = widthForCurrent(Number(params.currentA))
			if (!hit)
				throw new Error('超出知识库线宽表范围（>5A），请查 IPC-2221 完整表')
			return hit
		},
	},
]
