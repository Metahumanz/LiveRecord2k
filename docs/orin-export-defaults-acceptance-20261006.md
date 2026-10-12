# 默认导出类型保存修复

“设为默认”先调用 `updateSettingsDraft`，紧接着调用 `commitSettingsDraft`。旧实现把同步草稿 ref 的写入放在 React state updater 中；React 延迟执行 updater 时，commit 读到的仍是旧草稿。这会把选中的“烧录片段”保存为旧值“纯净片段”，并且样式、布局等字段同样可能丢失。旧值请求成功后，界面仍会提示保存成功。

设置修改和服务端状态合并现在先同步更新权威草稿 ref，再提交 React 显示状态。显式保存、自动重试与 SSE 合并都读取同一份最新草稿，保持原有字段版本队列和脏字段保护。

验证使用实际 App 处理器及延迟执行的 state setter，覆盖整套默认选项保存、刷新、切换录像、由烧录改回纯净，以及渲染前收到 SSE 时的脏字段保护。将同一测试作用于修复前 App，两项均失败：实际请求为 clean/旧样式，另一个字段为 24 而非新值 29；修复后两项通过。设置相关 18 项测试、TypeScript 检查和 Vite 构建全部通过。

已覆盖 Orin WebUI 静态资源，不重启后端。保留旧哈希资源，旧页面仍可加载；备份位于 `/usr/lib/bili-record-2k/dist.bak-20261006-before-export-defaults`。按用户明确选择，将 `defaultExportMode` 保存为 `burn`，API 回读及磁盘配置均确认。新 index SHA-256：`a8dc2efd9abb54619e80a09bd58c62f6b61bef04e91cf438dd55fe9d62ee5b41`。

浏览器刷新后加载新保存逻辑。此前丢失的其他默认样式无法反推，若需要调整，应重新点击“设为默认”。本次未发布新版本。
