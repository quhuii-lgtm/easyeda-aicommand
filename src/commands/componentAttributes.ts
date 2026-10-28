import type { ICommandDef } from '../engine/types';
import { modifyComponentDesignatorAttribute, type ModifyDesignatorInput } from '../engine/componentAttributes';
import { createGeometryHost } from '../pcb/geometryHost';

async function modifyDesignator(params: Record<string, any>) {
	const host = await createGeometryHost(eda, params);
	try {
		return await modifyComponentDesignatorAttribute(host, params);
	}
	catch (error) {
		return host.fail(error);
	}
}

export const componentAttributeCommands: ICommandDef[] = [
	{
		name: 'pcb.modifyComponentAttribute',
		summary: '只修改器件 Designator 属性文字的位置、旋转、字号或显示状态；保留位号文本、器件本体和网络，并逐项进行 EDA getter 与完整源码读回验收。',
		params: [
			{ name: 'componentId', type: 'string', description: 'PCB 器件图元 ID；与 designator 至少提供一个。' },
			{ name: 'designator', type: 'string', description: '当前位号文本，用于唯一定位；与 componentId 同时给出时必须指向同一器件。' },
			{ name: 'key', type: 'Designator', description: "仅支持 'Designator'，默认就是该属性。" },
			{ name: 'x', type: 'number', description: '位号文字锚点 X 坐标，单位 mil；只修改本次明确传入的字段。' },
			{ name: 'y', type: 'number', description: '位号文字锚点 Y 坐标，单位 mil；只修改本次明确传入的字段。' },
			{ name: 'rotation', type: 'number', description: '位号文字旋转角度，按 EDA 属性的 rotation 语义。' },
			{ name: 'fontSize', type: 'number', description: '位号文字字号，必须大于 0。' },
			{ name: 'visible', type: 'boolean', description: '位号文字 Value 的显示状态；不修改 Key 显示状态。' },
		],
		returns: '返回目标组件/属性 ID、请求字段、写前写后 getter、源码差异与 ticket 变化；verified=true 表示位号值保持且完整源码中组件及所有非目标记录未变化。不会保存。',
		example: { cmd: 'pcb.modifyComponentAttribute', params: { componentId: 'component-id', x: 420, y: 315, rotation: 0, fontSize: 45, visible: true } },
		handler: modifyDesignator,
	},
];

export type { ModifyDesignatorInput };
