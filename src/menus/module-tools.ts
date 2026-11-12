export type ModuleToolsOwnerRequest = (method: string, payload?: unknown) => Promise<any>;

/** Install only a narrow IFrame relay; every call is routed through the single bridge owner. */
export function installModuleToolsApi(request: ModuleToolsOwnerRequest): void {
	if (typeof eda === 'undefined')
		return;
	const sdk = eda as any;
	sdk.aiCommandModules = {
		getContext: () => request('module-menu-context'),
		command: (cmd: unknown, params?: unknown) => request('module-menu-command', { cmd, params }),
	};
}

export async function openModuleToolsMenu(): Promise<void> {
	try {
		const opened = await eda.sys_IFrame.openIFrame(
			'/iframe/module-library/index.html',
			900,
			650,
			'aiCommandModuleLibrary',
			{ title: '模块复用', maximizeButton: true, minimizeButton: true },
		);
		if (!opened)
			throw new Error('宿主未能打开模块复用窗口');
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try { eda.sys_Dialog.showInformationMessage(message, '模块复用'); }
		catch { throw error; }
	}
}
