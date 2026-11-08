import { getProxyPort, getProxyUrl } from './proxy-endpoint'

/** Open the SMT page served by the currently discovered local proxy. */
export async function openSmtQuery(): Promise<void> {
	const port = getProxyPort()
	if (port === null) {
		eda.sys_Dialog.showInformationMessage(
			'指令代理未连接，无法打开 SMT 物料查询窗口。请先连接配套技能的后台代理，再打开物料查询。',
			'SMT 物料查询',
		)
		return
	}
	const url = getProxyUrl('/smt')
	if (url === null)
		return
	try {
		const resp = await eda.sys_ClientUrl.request(`http://localhost:${port}/health`, 'GET')
		if (resp?.status === 200) {
			const health = await resp.json()
			if (health?.ok !== false && health?.service === 'ai-command-proxy' && health?.lifecycleProtocol === 1) {
				eda.sys_Window.open(url, '_blank' as any)
				return
			}
		}
	}
	catch {
		// The proxy stopped after discovery.
	}
	eda.sys_Dialog.showInformationMessage(
		'指令代理未运行，无法打开 SMT 物料查询窗口。\n请让 AI 使用配套技能的 scripts/start-proxy.ps1 在后台启动代理，再打开物料查询。',
		'SMT 物料查询',
	)
}
