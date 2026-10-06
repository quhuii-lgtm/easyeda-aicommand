// 回归：文档类型守卫误选页（KIMI-EDA-20261006-04/05 用例6）——
// 0.10.73 起焦点类型不符时只有"激活的同类标签"才自愈，唯一但未激活的无关标签绝不激活。
// 用 mock 的全局 eda 驱动 registry.executeCommand，断言：不激活无关页 + handler 不执行。
import { registerCommand, executeCommand } from '../src/engine/registry'

let failed = 0
const check = (cond: boolean, label: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
	if (!cond) failed++
}

/** 装配一个可控的 eda mock：当前焦点文档 + 分屏树 + 激活记录 */
function makeEda(opts: {
	focusDoc: { documentType: number, uuid: string } | undefined
	tree: any
	activateSwitchesFocus?: boolean
}) {
	const activated: string[] = []
	const edaMock = {
		dmt_SelectControl: {
			getCurrentDocumentInfo: async () => {
				// 模拟真实行为：activateDocument 后焦点切到目标页
				if (opts.activateSwitchesFocus && activated.length)
					return { documentType: 1, uuid: 'sch-active-1' }
				return opts.focusDoc
			},
		},
		dmt_EditorControl: {
			getSplitScreenTree: async () => opts.tree,
			activateDocument: async (tabId: string) => { activated.push(tabId); return true },
		},
	}
	return { edaMock, activated }
}

let handlerRan = 0
registerCommand({
	name: 'schematic.guardProbe',
	summary: '守卫行为探针（测试注册）',
	params: [],
	returns: 'string',
	handler: async () => { handlerRan++; return 'ran' },
})

async function scenario(name: string, edaMock: any, params: any, assertFn: (r: any) => boolean, label: string) {
	;(globalThis as any).eda = edaMock
	handlerRan = 0
	const r = await executeCommand({ cmd: 'schematic.guardProbe', params })
	check(assertFn(r), `${name}：${label}${r?.ok === false ? `（报错：${String(r?.error?.message ?? '').slice(0, 60)}）` : ''}`)
	return r
}

async function main() {
	// 反例（GPT 定案）：焦点 PCB，全树只有一个未激活的无关原理图标签
	{
		const { edaMock, activated } = makeEda({
			focusDoc: { documentType: 3, uuid: 'pcb-1' },
			tree: { tabs: [{ documentType: 3, tabId: 'tab-pcb', uuid: 'pcb-1', active: true }], children: [
				{ tabs: [{ documentType: 1, tabId: 'tab-sch-unrelated', uuid: 'sch-unrelated', active: false }], children: [] },
			] },
		})
		const r = await scenario('唯一无关页签', edaMock, {},
			(res) => res?.ok === false && /焦点文档不是原理图/.test(res?.error?.message ?? ''),
			'拒绝且报错')
		check(activated.length === 0, '唯一无关页签：未激活任何标签')
		check(handlerRan === 0, '唯一无关页签：handler 未执行')
		void r
	}

	// 焦点卡住自愈保留：激活的原理图标签在，getCurrentDocumentInfo 滞留 PCB → 激活后执行
	{
		const { edaMock, activated } = makeEda({
			focusDoc: { documentType: 3, uuid: 'pcb-1' },
			activateSwitchesFocus: true,
			tree: { tabs: [{ documentType: 1, tabId: 'tab-sch-active', uuid: 'sch-active-1', active: true }], children: [] },
		})
		await scenario('激活标签自愈', edaMock, {},
			(res) => res?.ok === true && res?.data === 'ran',
			'自愈激活后 handler 正常执行')
		check(activated.includes('tab-sch-active'), '激活标签自愈：activateDocument 被调用')
	}

	// __docUuid 核对：焦点类型正确但 uuid 不符 → 写入前拒绝
	{
		const { edaMock, activated } = makeEda({
			focusDoc: { documentType: 1, uuid: 'sch-A' },
			tree: { tabs: [], children: [] },
		})
		await scenario('__docUuid 不符', edaMock, { __docUuid: 'sch-B' },
			(res) => res?.ok === false && /__docUuid 不符/.test(res?.error?.message ?? ''),
			'uuid 不符拒绝')
		check(activated.length === 0 && handlerRan === 0, '__docUuid 不符：未激活、handler 未执行')
	}

	// 对照：__docUuid 匹配 → 放行
	{
		const { edaMock } = makeEda({
			focusDoc: { documentType: 1, uuid: 'sch-A' },
			tree: { tabs: [], children: [] },
		})
		await scenario('__docUuid 匹配', edaMock, { __docUuid: 'sch-A' },
			(res) => res?.ok === true && res?.data === 'ran',
			'匹配放行')
	}

	console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
	process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error('测试异常:', err); process.exit(2) })
