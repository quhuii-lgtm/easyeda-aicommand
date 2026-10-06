# -*- coding: utf-8 -*-
"""eda.py — AI Command Engine 指令发送助手
用法：
    from eda import cmd, connections
    current_connections = connections()  # 每次先查 GET /connections，再选定本次要操作的窗口
    target = 'INSTANCE_ID_FROM_CURRENT_CONNECTIONS_RESPONSE'
    print(cmd('project.getInfo', instance_id=target))
    print(cmd('schematic.placeDevice', {'lcscId': 'C25744', 'x': 300, 'y': 300}, instance_id=target))
也可命令行：python eda.py --instance-id INSTANCE_ID project.getInfo '{"x":1}'
"""
import argparse
import json
import urllib.request

BASE = 'http://localhost:49720'


def health():
    """代理与扩展在线状态；extension 字段是当前选中的 EDA 窗口实例。"""
    with urllib.request.urlopen(BASE + '/health', timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def connections():
    """所有已连接的 EDA 窗口实例（多开窗口时排查用）。"""
    with urllib.request.urlopen(BASE + '/connections', timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def select(instance_id):
    """切换代理的全局所选实例；不能替代每条请求的 instance_id 路由。"""
    req = urllib.request.Request(
        BASE + '/select',
        data=json.dumps({'instanceId': instance_id}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _require_instance_id(instance_id):
    if not isinstance(instance_id, str) or not instance_id.strip():
        raise ValueError('instance_id must be a non-empty string; call connections() and choose a connected instance')


def cmd(name, params=None, timeout=120, *, instance_id):
    """发送一条指令，返回 {ok, cmd, data|error, durationMs}。失败时抛出带 message 的异常。"""
    _require_instance_id(instance_id)
    req = urllib.request.Request(
        BASE + '/command',
        data=json.dumps({'instanceId': instance_id, 'cmd': name, 'params': params or {}}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    if not result.get('ok'):
        raise RuntimeError(json.dumps(result.get('error'), ensure_ascii=False))
    return result


def macro(steps, stop_on_error=False, timeout=300, *, instance_id):
    """发送宏指令。steps: [{'id'?, 'cmd', 'params'?}, ...]；返回各步结果列表。"""
    _require_instance_id(instance_id)
    req = urllib.request.Request(
        BASE + '/command',
        data=json.dumps({'instanceId': instance_id, 'cmd': 'macro', 'params': {'stopOnError': stop_on_error, 'steps': steps}}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    if not result.get('ok'):
        raise RuntimeError(json.dumps(result.get('error'), ensure_ascii=False))
    return result.get('data', {}).get('steps', [])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Send an AI Command Engine request to a specific connected EDA instance.')
    parser.add_argument('--instance-id', required=True, help='Target ID from GET /connections')
    parser.add_argument('name', nargs='?', default='project.getInfo', help='Command name (default: project.getInfo)')
    parser.add_argument('params', nargs='?', help='Command parameters as JSON')
    args = parser.parse_args()
    params = json.loads(args.params) if args.params is not None else None
    print(json.dumps(cmd(args.name, params, instance_id=args.instance_id), ensure_ascii=False, indent=2))
