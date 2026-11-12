/**
 * A small host-side exclusion guard for module operations that can change the
 * active document or project. HTTP requests already have their normal queue;
 * this guard covers direct menu/backup calls that bypass that queue.
 */
let activeModuleOperation: string | null = null;
let activeDesignWrites = 0;

/** Read-only view for connection lifecycle decisions while a raw EDA handler is still settling. */
export function hasActiveModuleExecution(): boolean {
	return activeModuleOperation !== null || activeDesignWrites > 0;
}

const safeReadPatterns = [
	/^__help$/,
	/^task\.(get|list)/,
	/^schematic\.(list|get|export|runDrc|checkRectOverlap)/,
	/^pcb\.(list|get|export|runDrc)/,
	/^pcb\.runDfm$/,
	/^pcb\.runSmtDfm$/,
	/^pcb\.checkSameNetPadSpacing$/,
	/^project\.(get|list|export)/,
	/^editor\.(listTabs|screenshot|zoomToAll|zoomToRegion)$/,
	/^library\.(search|get)/,
	/^knowledge\./,
];

function isSafeRead(cmd: string): boolean {
	return cmd === 'module.getStatus'
		|| /^module\.get.*Operation$/.test(cmd)
		|| /^module\.(?:library(?:Info|Save|List|Search|Get)|setLibraryDirectory)$/.test(cmd)
		|| (cmd !== 'schematic.getNetlist' && cmd !== 'schematic.exportNetlist'
			&& safeReadPatterns.some(pattern => pattern.test(cmd)));
}

function isModuleExclusive(cmd: string): boolean {
	return cmd.startsWith('module.') && !isSafeRead(cmd);
}

function isDesignWrite(cmd: string): boolean {
	return !isSafeRead(cmd) && !cmd.startsWith('module.library');
}

function busyError(cmd: string, operation: string): Error {
	return new Error(`指令 ${cmd} 未执行：模块操作“${operation}”仍在运行。请先等待它实际结束，再重试。`, {
		cause: { partial: false, source: 'module-operation-busy', retryable: true, activeOperation: operation },
	});
}

/**
 * Hold the module exclusion until the underlying handler promise settles.
 * The registry heartbeat fuse may stop waiting sooner; that must not release
 * this lock because the SDK call can still be running in the background.
 */
export function runWithModuleExecution<T>(cmd: string, handler: () => T | Promise<T>): Promise<T> {
	const moduleExclusive = isModuleExclusive(cmd);
	const designWrite = isDesignWrite(cmd);
	if (moduleExclusive && activeModuleOperation)
		return Promise.reject(busyError(cmd, activeModuleOperation));
	if (moduleExclusive && activeDesignWrites > 0)
		return Promise.reject(busyError(cmd, '其他设计写入'));
	if (designWrite && activeModuleOperation)
		return Promise.reject(busyError(cmd, activeModuleOperation));

	if (moduleExclusive)
		activeModuleOperation = cmd;
	if (designWrite)
		activeDesignWrites++;

	let raw: Promise<T>;
	try {
		raw = Promise.resolve(handler());
	}
	catch (error) {
		raw = Promise.reject(error);
	}
	return raw.finally(() => {
		if (moduleExclusive && activeModuleOperation === cmd)
			activeModuleOperation = null;
		if (designWrite)
			activeDesignWrites = Math.max(0, activeDesignWrites - 1);
	});
}
