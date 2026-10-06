/**
 * 指令引擎类型定义
 */

/** AI 发送的单条指令 */
export interface ICommandRequest {
	/** 指令名，如 `schematic.placeDevice` */
	cmd: string
	/** 指令参数 */
	params?: Record<string, any>
}

/** 统一成功返回 */
export interface ICommandSuccess<T = any> {
	ok: true
	cmd: string
	data: T
	durationMs: number
}

/** 统一失败返回 */
export interface ICommandFailure {
	ok: false
	cmd: string
	error: {
		message: string
		/** 供 AI 参考的修复建议（可选） */
		suggestion?: string
	}
	durationMs: number
}

export type TCommandResult<T = any> = ICommandSuccess<T> | ICommandFailure

/** 宏指令执行上下文：存放各步骤输出，供 `$stepId.path` 引用 */
export interface ICommandContext {
	vars: Record<string, any>
	/**
	 * 0.10.49：进度心跳上报通道（桥层注入）。长指令（批量删除/batchWire/macro）处理过程中
	 * 周期性调用，桥层转成 { type:'progress', id } 消息发给代理，代理重置该指令的超时计时器。
	 * 普通指令无需关心；处理器应保证 patch 可 JSON 序列化且尽量小。
	 */
	onProgress?: (patch: Record<string, any>) => void
}

export type TCommandHandler = (params: Record<string, any>, ctx?: ICommandContext) => Promise<any>

export interface IParamDoc {
	name: string
	type: string
	required?: boolean
	description: string
}

/** 指令定义（含文档元数据，供 AI 查询） */
export interface ICommandDef {
	name: string
	summary: string
	params: IParamDoc[]
	returns: string
	example?: { cmd: string, params?: Record<string, any> }
	handler: TCommandHandler
}

/** 宏指令步骤 */
export interface IMacroStep {
	/** 步骤标识，后续步骤可用 `$id` 引用本步骤的 data */
	id?: string
	cmd: string
	params?: Record<string, any>
}

/** 宏指令请求 */
export interface IMacroRequest {
	cmd: 'macro'
	params: {
		steps: Array<IMacroStep>
		/** 任一步失败即中断，默认 true */
		stopOnError?: boolean
	}
}
