/**
 * 0.10.52 诊断日志（KIMI-EDA-20261003-09）：删除/终扫/探针各阶段起止、底层调用、探针候选 ID。
 *
 * 流向：指令内部 diag() → 安装期注入的 sink → bridge/client.ts 经 WebSocket 发
 * { type:'log', ts, cmd, stage, detail } → 代理写入 lane-log-YYYY-MM-DD.jsonl。
 * 同时镜像到 EDA 系统日志（eda.sys_Log），便于 EDA 侧查看。
 *
 * 日志失败绝不影响主流程。
 */
export interface IDiagEvent {
	cmd?: string
	stage: string
	detail?: string
}

export type TDiagSink = (event: IDiagEvent) => void

let sink: TDiagSink | undefined

/** 由 bridge/client.ts 在启动时注入发送器 */
export function setDiagSink(s: TDiagSink | undefined): void {
	sink = s
}

/** 指令内部调用：记录一个诊断事件 */
export function diag(cmd: string, stage: string, detail?: string): void {
	try {
		sink?.({ cmd, stage, detail })
	}
	catch {
		// 日志失败不影响主流程
	}
}
