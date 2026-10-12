# Orin DNS 间歇故障检查（2026-10-08）

检查对象：10.18.143.96。时间使用 Asia/Hong_Kong。

## 结论

局域网、SSH、应用服务和 IPv4 外网连接可用；复现的是间歇 DNS 失败。WideWired 的 DNS 周期性接管与已有恢复定时器同时运行，旧恢复脚本仍有数秒失败窗口。初次检查仅做诊断；用户随后指定先在 Orin 寻找修复方案，已完成下述持久化修复和验收。

## 证据

- 有线接口 end0 地址为 10.18.143.96/24，主路由经 10.18.143.42。IPv4 B 站 room_init 请求返回 HTTP 200。
- `/etc/resolv.conf` 指向 systemd-resolved stub。有线接口接收校园 DNS；tailscale0 使用其域名路由。WideWired 接管时把 wwnet0 DNS 设为 100.100.100.53，同时设置 `~.` 和 DefaultRoute=yes。
- `ww-dns-fix.timer` 配置 OnUnitActiveSec=10s、AccuracySec=1s，实际约 11 秒执行一次。服务仅运行 `resolvectl revert wwnet0`。
- systemd-resolved 日志显示 WideWired 每约 30 秒重新设置上述全局 DNS。
- 19:12:07 WideWired 写入 DNS；随后以 bili-record-2k 用户运行、使用安装包 Node 的探针出现 getaddrinfo EAI_AGAIN、queryA ETIMEOUT 和 fetch 超时。19:12:14 恢复脚本执行，随后请求恢复 HTTP 200 / B 站 code=0。
- 19:12:37 再次写入 DNS；探针再次失败，19:12:47 恢复脚本执行，随后请求恢复。
- 19:14 的另一次采样在 wwnet0 DNS 为 100.100.100.53 时出现 queryA ESERVFAIL，说明故障不是仅发生过一次。
- 应用日志仅打印 error.message，隐藏了 fetch 的底层 cause.code，导致 UI 只能显示 fetch failed。

## 修复方向

从 WideWired 的全局 DNS 接管策略修复，或配置稳定的有线 DNS 路由，避免周期性写入与回退互相竞争。单纯缩短回退间隔、重启录制软件或固定 B 站 IP 不能根治。具体持久化修改应先确认 WideWired 支持的配置方式，并保留其内网域名解析与其他组网功能。

## 第二层原因与最终方案

WideWired 还安装了优先级 22739 的 UDP/TCP 53 端口策略路由。修复前，`ip route get 202.120.190.208 ipproto udp dport 53` 实际经 wwnet0、172.26.173.13 转发。这个本机节点在 Orin 状态中为 unknown path/checking，Windows 的 wwnet 服务也处于停止状态。单独提高有线 DNS 优先级或只添加 `~.` 仍不够，缓存过期时测试继续出现超时；当前校园 IPv6 DNS 的直接查询也超时。

最终保留 WideWired 组网，同时修复两处独立配置：

1. 有线连接 `Wired connection 1`（UUID `60cbc04b-ac3c-3fcc-a0b4-b40b69ddfe9c`）持久化增加 `ipv4.dns-search=~.`，不再忽略这个可靠的 DNS 入口。IPv4 DNS 仍由 DHCP 提供；`ipv6.ignore-auto-dns=yes` 排除本次不可达的 IPv6 DNS，未关闭 IPv6 地址或路由。
2. 为有线 DHCP IPv4 DNS 地址添加优先级 22010 的精确目标规则，查询 main 路由表。当前两个目标是 202.120.190.208、202.120.190.108，经 10.18.143.42/end0；其他目标及 WideWired 内网路由保留。

`scripts/orin-dns-bypass.py` 已安装为 `/usr/local/sbin/orin-dns-bypass.py`，开机 oneshot 单元 `/etc/systemd/system/orin-dns-bypass.service` 已启用。NetworkManager dispatcher `/etc/NetworkManager/dispatcher.d/90-orin-dns-bypass` 在 end0 up、DHCP4 变化及 reapply 时恢复规则。脚本从当前 DHCP DNS 读取地址、记录自身规则、避免重复，遇到同优先级的外来规则会停止而不删除它们；不清空路由表或其他策略规则。

旧 `ww-dns-fix.timer` 已停用，单元文件保留。原参数备份为 `/var/lib/orin-dns-bypass/backup-20261008.json`。

依据：[systemd 的 VPN/DNS 路由说明](https://github.com/systemd/systemd/blob/main/docs/RESOLVED-VPNS.md)说明相同长度的路由域会并行向相应接口查询、返回首个成功结果；[NetworkManager IPv4 设置文档](https://networkmanager.dev/docs/api/latest/settings-ipv4.html)定义了 DNS 路由域和连接的持久化设置。本方案让有线入口不被 `~.` 排除，并让该入口的实际 DNS 数据包避开错误的捕获路径。

## 验收与边界

- 暂停旧定时器后首轮 65 个样本全部成功；随后持久化、重新应用连接配置，再执行 65 个样本，仍无失败。
- 最终时间为 20:20:02–20:21:18。每个样本以 bili-record-2k 服务用户运行 Node lookup、resolve4 和 B 站 fetch；轮换六个域名，每十轮清理 resolved 缓存。WideWired 的 DNS 接管在最终 65 个样本中全部存在，最长 B 站请求 236ms。
- 六个域名为 api.live.bilibili.com、api.bilibili.com、www-api.widewired.com.cn、github.com、www.bilibili.com、api.github.com。
- 连续运行修复脚本两次，规则仍恰好两条。NetworkManager reapply 后 profile 参数、实际 DNS 及路由保持正确。没有为验证而重启整机。
- WideWired 仍 connected，原来 healthy 的对端继续 healthy；本机 .13 的独立连接问题尚未修复。两个直播间继续监听，lastError 已清除。录制软件未重启。
- 本机旧 E1000 修复是 Windows 安装目录所有者权限处理，不能移植到 Linux DNS 故障。本次按用户要求先修复 Orin，未改动 Windows 的网卡或服务。

证据位于 `docs/evidence/orin-dns-20261008/`，包含首轮报告、最终报告和完整最终样本。

## 回滚

仅在需要撤销本次修复时，以 root 执行以下命令。它们恢复备份中本机原来的两个连接属性，重新启用旧定时器；旧方案的间歇问题可能随之恢复。

```sh
chmod -x /etc/NetworkManager/dispatcher.d/90-orin-dns-bypass
systemctl disable orin-dns-bypass.service
python3 /usr/local/sbin/orin-dns-bypass.py --remove
nmcli connection modify 60cbc04b-ac3c-3fcc-a0b4-b40b69ddfe9c ipv4.dns-search '' ipv6.ignore-auto-dns no
nmcli device reapply end0
systemctl enable --now ww-dns-fix.timer
```
