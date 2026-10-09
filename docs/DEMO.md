# 真实 EDA 操作演示

![PCB 实际操作定格动画](../images/demo-pcb.gif)

此 GIF 用于插件介绍：实际 EDA 画面配上整理后的指令字幕，按操作阶段停留播放，并非实时录屏。图纸内容没有合成或重绘。

## 环境与准备

- 录制日期：2026-10-09。
- 实际运行扩展：v0.10.89；嘉立创 EDA 专业版：4.1.60。
- 在独立测试工程中新建演示 PCB，预置一个 GND 焊盘与网络。
- 坐标、走线宽度与区域尺寸仅用于演示操作，不是器件布局规范或制造建议。

## 实际步骤

| 阶段 | 实际指令 | 演示结果 |
| --- | --- | --- |
| 创建板框 | `pcb.drawOutline` | 2400 × 1600 mil 矩形板框 |
| 顶层走线 | `pcb.routeTrack` | GND 网络、24 mil、4 段走线 |
| 双层连接 | `pcb.placeVia`、`pcb.routeTrack` | 一个过孔及 2 段底层走线 |
| 铺铜边界 | `pcb.pourCopper` | 底层 GND 铺铜区域，尚未填充 |
| 重建铺铜 | `pcb.rebuildPour` | 填充区域数从 0 变为 5 |
| 保存与检查 | `pcb.save`、`editor.closeDocument`、`editor.openDocument`、`pcb.listLines`、`pcb.listPours` | 重开后仍为 6 段走线，`filled=true`、`fillStatus=filled`、`fillRegions=5` |

重建命令返回的 `freshnessVerified=false` 不被当作独立验收结论。本演示另外完成了保存、关闭、重开和只读查询；结论限于上述演示对象。未进行整板 DRC、电气、热、机械、打样或生产验收。

## 文件

- [演示 GIF](../images/demo-pcb.gif)：1200 × 760，6 个阶段，17.7 秒，循环播放。
- [静态封面](../images/demo-pcb-poster.png)：用于不支持 GIF 的介绍位置。

截图已裁去账号、窗口标题和工程列表。字幕来自实际调用与返回信息，不是聊天界面截图。录制版本与当前交付版本均为 v0.10.89；动画的有限验证不能代替本次交付包的安装测试或市场审核。
