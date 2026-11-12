/** Find a uniquely open tab for this document in the requested project. Invalid trees are ignored. */
export function findReplacementDocumentTab(tree: unknown, projectUuid: string, documentUuid: string): string | undefined {
	const tabIds = new Set<string>(), matches: string[] = [];
	const visit = (value: unknown): boolean => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
		const node = value as Record<string, unknown>;
		if (typeof node.id !== 'string' || !node.id || (!Object.hasOwn(node, 'tabs') && !Object.hasOwn(node, 'children'))) return false;
		if (Object.hasOwn(node, 'tabs')) {
			if (!Array.isArray(node.tabs)) return false;
			for (const item of node.tabs) {
				if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
				const tab = item as Record<string, unknown>;
				if (typeof tab.tabId !== 'string' || !tab.tabId) return false;
				if (tabIds.has(tab.tabId)) continue;
				tabIds.add(tab.tabId);
				const data = tab.data && typeof tab.data === 'object' && !Array.isArray(tab.data) ? tab.data as Record<string, unknown> : undefined;
				if (tab.tabId === `${documentUuid}@${projectUuid}` && (data?.pid === undefined || data.pid === projectUuid)) matches.push(tab.tabId);
			}
		}
		if (Object.hasOwn(node, 'children')) {
			if (!Array.isArray(node.children) || !node.children.every(visit)) return false;
		}
		return true;
	};
	if (!visit(tree) || matches.length !== 1) return undefined;
	return matches[0];
}

/** Activate an exact already-open tab, or open once and activate if it is absent. */
export async function activateOrOpenReplacementDocument(api: any, projectUuid: string, documentUuid: string): Promise<string> {
	let tabId: string | undefined;
	try {
		if (typeof api?.dmt_EditorControl?.getSplitScreenTree === 'function') {
			tabId = findReplacementDocumentTab(await api.dmt_EditorControl.getSplitScreenTree(), projectUuid, documentUuid);
		}
	} catch { /* An unavailable or invalid public tab tree follows the normal open path. */ }
	if (!tabId) tabId = await api.dmt_EditorControl.openDocument(documentUuid);
	if (typeof tabId !== 'string' || !tabId || await api.dmt_EditorControl.activateDocument(tabId) !== true)
		throw new Error(`无法打开并激活目标文档 ${documentUuid}`);
	return tabId;
}
