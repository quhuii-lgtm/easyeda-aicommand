# -*- coding: utf-8 -*-
"""eda.py — AI Command Engine 指令发送助手
用法：
    from eda import cmd
    print(cmd('project.getInfo'))
    print(cmd('schematic.placeDevice', {'lcscId': 'C25744', 'x': 300, 'y': 300}))
也可命令行：python eda.py project.getInfo '{"x":1}'
"""
import json
import sys
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
    """多开 EDA 窗口时，切换指令发往的窗口。"""
    req = urllib.request.Request(
        BASE + '/select',
        data=json.dumps({'instanceId': instance_id}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def cmd(name, params=None, timeout=120):
    """发送一条指令，返回 {ok, cmd, data|error, durationMs}。失败时抛出带 message 的异常。"""
    req = urllib.request.Request(
        BASE + '/command',
        data=json.dumps({'cmd': name, 'params': params or {}}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    if not result.get('ok'):
        raise RuntimeError(json.dumps(result.get('error'), ensure_ascii=False))
    return result


def macro(steps, stop_on_error=False, timeout=300):
    """发送宏指令。steps: [{'id'?, 'cmd', 'params'?}, ...]；返回各步结果列表。"""
    req = urllib.request.Request(
        BASE + '/command',
        data=json.dumps({'cmd': 'macro', 'params': {'stopOnError': stop_on_error, 'steps': steps}}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    return result.get('data', {}).get('steps', [])


if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else 'project.getInfo'
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
    print(json.dumps(cmd(name, params), ensure_ascii=False, indent=2))
