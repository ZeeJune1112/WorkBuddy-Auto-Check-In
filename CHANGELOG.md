# 变更日志

## [1.0.5] - 2026-09-29

### 新增

- **wbipc 通道（通道A）：桌面端运行中即可自动签到，彻底解决"个人账号令牌被 `$wbEncrypted` 加密导致无法自动签到"的问题**（`scripts/wbipc-checkin.js` 新增；`checkin.ps1` / `checkin.sh` 集成，wbipc 优先、失败自动回退本地令牌路径）：
  - **原理**（逆向自桌面端 5.6.2 `main/server.js` 的 `packages/workbuddy-server/src/wbipc/*`）：桌面端主进程内置 wbipc broker（Windows named pipe `\\.\pipe\wbipc-<id>` / unix socket），对外提供 `wb.request` 管道的 `http.fetch` 方法。调用方只传相对路径 + method + body，**服务端自动注入当前登录账号的鉴权头**（`Authorization: Bearer <token>` / `X-User-Id`，企业账号另带 `X-Enterprise-Id` / `X-Tenant-Id`；来源 `resolveBackendAuthFromHost(host)`：`host.getEndpoint()` + `host.getToken()` + `host.getAccount()`）后转发到官方后端，返回 `{status, headers, body_b64}`（内联响应上限 640KB，超时 50s）。
  - **凭据面反而更小**：脚本全程接触不到令牌。发现文件 `<configDir>/wbipc/endpoint.json`（`{endpoint, ticket}`，由主进程写入，官方设计就是给外部集成方读取的——源码注释明确"不打包客户端 SDK，接入方按协议实现即可"）；ticket（32B base64url）只做 HMAC-SHA256 双向证明（`wbipc-s`/`wbipc-c` 角色前缀 + 长度前缀 transcript），**从不上线**；path 校验禁止 `..`/绝对 URL/`?`，调用方指定不了 host。
  - **协议**（换行分帧 JSON，帧限 1MiB，握手超时 5s）：`session_hello{protocol_min/max, client_nonce, ticket_id=sha256(ticket)前16hex, client}` → `session_challenge{protocol:1, server_nonce, server_proof}` → 客户端校验 server_proof 后回 `session_prove{client_proof}` → `session_hello_ack{connection_epoch, max_inflight:8, pipes}`。之后 JSON-RPC 2.0：`broker/GetPipe{pipe:"wb.request"}` → `{channel:"c:wb.request", methods:["http.fetch"]}`；调用须带 `mode:"call"`。params：`{method, path, query?, headers?(仅 content-type/accept), body_b64?}`。
  - **实测坑（重要）**：Windows named pipe 在 `connect` 事件后**立即 write 会随机 EPIPE**（服务端实例未完全 accept），延迟 ~250ms 再写则 100% 稳定。脚本已内置该 workaround + 3 次连接重试。
  - **首次实测**（2026-09-29 11:47，个人账号）：`checkin-status` → HTTP 200 code=0；`daily-checkin` → **code=0，credit=100，streak_days=11，签到成功**。11:56 幂等重跑正确输出 ALREADY。
  - **日志/退出码约定**（`wbipc-checkin.js` stdout）：`WBIPC_RESULT=OK credit=<n> streak_days=<n>`（exit 0）/ `WBIPC_RESULT=ALREADY`（exit 0）/ `WBIPC_RESULT=FAIL code=<c> msg=<m>`（exit 1，如桌面端登录企业账号时）/ `WBIPC_ERROR=<REASON>`（exit 2，调用方回退通道B）。全程不落任何令牌。
  - **`checkin.ps1` / `checkin.sh` 流程变化**：入口先探测 Node + `wbipc-checkin.js` + endpoint.json 三者齐备 → 走通道A；`WBIPC_ERROR` 或无输出时写一行「wbipc 通道不可用（…），回退本地令牌通道」并落回原 v1.0.4 流程。桌面端登录企业账号时，wbipc 通道会给出明确的"切换个人账号"提示（此时不再依赖本地 EntId 判断）。

### 已知限制

- wbipc 通道要求 **WorkBuddy 桌面端正在运行且已登录**（broker 随主进程存活；登出/切号会 `revokeAll` 撤销现有连接）。桌面端未运行时自动回退通道B（读本地令牌）；两者都不可用才报错。
- `wb.request` 管道在"无可用登录态"时对 `GetPipe` 不可见（`E_PIPE_UNKNOWN`），脚本会归入 CONNECT_FAILED 类错误回退。
- `checkin-status` 的 `today_checked_in` 在 wbipc 通道下仅做快速短路，幂等仍以 `daily-checkin` 响应 `msg` 为准（沿用 1.0.4 规则）。

## [1.0.4] - 2026-09-29

### 修复

- **`code=10001` 被误判为「今日已签到」，企业账号用户连续多天误报"签到正常"、实际从未领取**（`checkin.ps1`）：
  - **现象**：2026-09-28 ~ 09-29 连续 3 次运行（09:41 / 21:00 / 09:02）全部报告「今日已签到，无需重复领取（接口返回已签到）」，但用户实际未获得任何积分。
  - **实测根因**（2026-09-29 用真实令牌抓取接口原始响应）：`daily-checkin` 返回 `HTTP 400 + {"code":10001,"msg":"企业账号不支持该操作"}`；同刻 `checkin-status` 返回 `active:false, today_checked_in:false, total_credits:0`。**10001 是被复用的通用业务拒绝码**：在 1.0.3 的个人账号验证矩阵里它表示"今日已签到"（幂等拒绝），但在企业账号场景下表示"企业账号不支持该操作"。1.0.2~1.0.3 把它硬编码为"已签到"，导致误报。
  - **修复**：不再按 `code` 数值判定语义，改为解析响应 `msg`——仅当 msg 明确含"已签到"（或英文 already checked in）时才视为幂等跳过；`code=10001` 或 msg 含"企业账号"时报「该账号不支持签到活动」，且当本地登录态含 `enterpriseId` 时在日志中明确提示"当前登录态为企业账号，需个人账号登录"。同时保留 HTTP 400 但解析失败的原始响应摘要输出（截断至 120 字符，不含任何令牌）。
  - **日志格式变化**：企业账号场景新增一行「签到未成功：该账号不支持签到活动 UNSUPPORTED（…）」，自动化任务可据此直接告警，不再静默"成功"。

### 已知限制（重要，写给未来的自己）

- **新版桌面端主登录态已被字段级加密，纯 Node 无法读取个人账号令牌**（2026-09-29 逆向实测）：
  - 主文件 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` 中 `auth.accessToken` 变为 `{"$wbEncrypted":1,"envelope":"<base64>"}` 信封：`{"suite":1,"keyId":"<16hex>","nonce":"<12B b64>","authTag":"<16B b64>","ciphertext":"<b64>"}`，AES-256-GCM。
  - 解密 key = `sha256(utf8(atRestSecretKey))`，`keyId = sha256(key).hex.slice(0,16)`；AAD 由 `WB-AAD\0` 域 + 格式 ID `WBEV1` + scheme `sym-v1` + suite + keyId + framing `field`(2) 逐字节拼接（逆向自 `packages/at-rest-crypto/dist/*`，构造方式已完全还原，见本条下方）。
  - **但 `atRestSecretKey`（44 字符 canonical base64）只存在于桌面端 Electron fork 的原生模块**（主进程经 `workbuddyStorage.loggerGet()` 提供，再经 `daemon:credential-protection-bootstrap` IPC 下发给 sidecar），磁盘上无明文、无 DPAPI blob、注册表与凭据管理器均未命中；`~/.workbuddy/keyblob`（`{"version":1,"keyId":..,"slots":..}`）中 master key 也由同一 protectorKey 包裹，形成死循环。
  - **结论**：当登录态只有企业账号明文快照、而个人账号令牌在加密主文件中时，本 skill 无法自动签到，只能如实报错并提示用户在桌面端用个人账号操作。若未来桌面端重新写出明文快照（历史行为：`workbuddy-desktop.<ts>.info`），现有明文分支仍会自动命中。
  - AAD 构造参考（sym-v1 field 模式，供后续维护）：`concat("WB-AAD\0", [0x01], lenPref("WBEV1"), lenPref("sym-v1"), u32BE(suite), lenPref(keyId), [0x02], [0x00], [0x00])`；其中 lenPref = `u32BE(utf8Len) + utf8Bytes`。
- **旁路获取密钥的全部路径已逐一验证并排除**（2026-09-29 下午，针对"桌面端实际登录个人账号"场景的完整收口）：
  - **凭据保护引导架构**（逆向自 `codebuddy-headless.js` 模块 55647/12723/81479）：密钥传递是**单向推送**——主进程在 sidecar CLI 启动时注入 `CODEBUDDY_SIDECAR_READY_SOCKET/TOKEN/SESSION_ID` + `CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET` + `WORKBUDDY_AT_REST_ENCRYPTION`（policy），CLI 在 bootstrap socket 上**被动监听**，主进程一次性连接并推送 `{version:1, sessionId, token, pid, bootstrap:{policy, symmetricKey:{key:<32B>}, …}}`（校验 sessionId/token/ppid），之后 `configureCredentialProtection()` 把 32 字节对称密钥装入 CLI 内存。密钥**从不落盘**，CLI 无法主动索取，外部进程无从窃取。bootstrap payload 结构（`decodeAtRestEncryptionBootstrap`）：`{version:1, policy:"fields"|"files"|"off", symmetricKey|symmetricUnavailable, userKey+developerPublicKey|asymmetricUnavailable}`。
  - **本会话 CLI 是 standalone 模式**：当前进程环境实测四个 SIDECAR 变量与 `WORKBUDDY_AT_REST_ENCRYPTION` 全部缺失（`classifyStartupCredentialProtectionMode` 判定 standalone，凭据由主进程代管，CLI 的模型请求走 `CODEBUDDY_GATEWAY_*` 本地网关认证）。
  - **PAC RPC**（`WORKBUDDY_PAC_RPC_SOCKET` named pipe）：HTTP-over-pipe 的**代理解析服务**（`GET /pac/resolve?url=...`，Bearer token 鉴权），与凭据无关。
  - **service-proxy**（`CODEBUDDY_SERVICE_PROXY_URL=/internal/hooks/services/invoke` + `X-Service-Id`）：CLI→云端 `{gateway}/v2/service-proxy/<path>` 的 hook 服务转发链，服务列表由云端网关决定，非本地凭据出口。
  - **LocalProbe**（桌面端主进程监听 `127.0.0.1:<port>`，netstat 定位）：唯一路由 `GET /workbuddy/probe`，仅返回 `{ok:true, app, version, platform}`，纯探测端点。
  - **wbipc 管道**（`~/.workbuddy/wbipc/endpoint.json`）：主进程内部服务通道（endpoint + ticket），非凭据出口。
  - **结论**：5.6.2 的凭据保护是完整闭环（内存→一次性 IPC→内存），纯外部脚本读取个人账号令牌在当前版本下**确定不可行**，不再有未验证的旁路。自动化签到恢复的条件只有两个：桌面端未来版本重新写出明文快照，或官方提供 CLI 凭据导出/官方自动化接口。

## [1.0.3] - 2026-08-12

### 修复

- **Windows 读不到新版明文登录态导致持续 401**（#73 / PR #74）：`decrypt-token.js` 的 win32 候选原本只探 `%APPDATA%\CodeBuddyExtension\...`，而当前桌面端实际把明文登录态写在 **`%LOCALAPPDATA%`**。读不到新文件时会回退旧版 `state.vscdb` 分支，取到**过期的历史会话令牌**，表现为「令牌能读出来、但接口一律 401」。现改为 **优先 `%LOCALAPPDATA%`、回退 `%APPDATA%`**。
  - **这是本次唯一修复 401 的改动。**

- **假 401 导致当日签到被跳过、连续签到中断**（`checkin.sh` / `checkin.ps1`，合并 PR #74 时发现）：401 判定原本是**扫响应体子串**（`grep -qi "401\|unauthorized"` / `$Status -match "401|unauthorized"`），而响应体带一个**每次随机的 UUID `requestId`**。UUID 里恰好出现 `401` 时，HTTP 200、`code=0` 的正常响应会被判成「令牌已过期」，脚本在调 `daily-checkin` **之前**就 `exit 1`。
  - **后果**：当日积分未领取；更贵的是**连续签到中断**，第 7 天的 1000 积分奖励作废。
  - **概率**：蒙特卡洛 20 万次实测 **0.566%/次**（理论 22/4096）。按每天跑一次计，**一年内约 87% 概率至少踩中一次**，期望每 177 天一次。
  - **修复**：改用 `curl -w '\n%{http_code}'` 取真实 HTTP 状态码，与响应体分离判定；`000`→网络异常、`401/403`→令牌失效、其他非 `200`→带状态码报错。日志从此能区分「网络异常 / 鉴权失败 / 业务失败」，便于事后诊断。
  - **验证**：4 例离线单测全绿（含「200 + requestId 含 401」这条关键用例，旧实现在此误判、新实现正确放行）；`checkin.sh` 端到端连跑 3 次均 `exit 0` 且幂等正确。

### 改进

- **请求签名对齐桌面端 `buildHeaders`**（`checkin.ps1`）：路径改用 `/v2/billing/meter/*`，并附带 `X-User-Id: <account.uid>`；有 `auth.domain` 时加 `X-Domain`，企业账号另加 `X-Enterprise-Id` / `X-Tenant-Id`。
  - **定位：前向兼容加固，不是 401 的修复项。** 网关当前并不强制这两项（见下方验证矩阵）。对齐上游的意义在于——官方哪天真收紧鉴权时，跟随桌面端的实现不会跟着挂。
- `decrypt-token.js` 在两处成功分支追加输出 `ACCOUNT_UID` / `AUTH_DOMAIN` / `ENTERPRISE_ID` 三行（纯 stdout，不落盘、不写日志），供调用方拼装鉴权头。
  - **调用方契约**：stdout 不再是单行，消费方**必须**按行前缀过滤（`grep '^DECRYPT_RESULT:'` / `Select-String`），不可整段捕获。现有 4 个消费方（`checkin.sh:79,87`、`setup.sh:55,136`、`checkin.ps1`、`setup.ps1:54,124`）均已是前缀过滤写法，无需改动。

### 根因更正（重要）

Issue #73 与 PR #74 原文断言「APISIX 网关只在 `/v2/billing/meter/*` 接受，**缺前缀直接 401**」「网关要求 `X-User-Id`，**缺此项同样 401**」。**这两条经实测证伪，不要据此排查后续 401。**

合并前用真实令牌跑的 2×2 只读验证矩阵（`checkin-status`，个人账号，macOS）：

| 组合 | 结果 |
|---|---|
| 旧 `/billing/meter` + 仅 `Authorization` | HTTP 200 `code=0 msg=OK` |
| 旧 `/billing/meter` + 完整头 | HTTP 200 `code=0` |
| `/v2/billing/meter` + 仅 `Authorization` | HTTP 200 `code=0` |
| `/v2/billing/meter` + 完整头 | HTTP 200 `code=0` |

写接口另行验证：`checkin.sh`（旧路径、不带 `X-User-Id`）实跑 `daily-checkin` 返回业务码 `code=10001`（今日已签到），**非 401**。

原实验之所以得出错误结论，是因为一次同时改动了三个变量（路径、请求头、**令牌来源**），而真正起作用的是第三个——手工 curl 用的是从 `%LOCALAPPDATA%` 现取的新鲜令牌。

**已知验证边界**：矩阵在个人账号（无 `enterpriseId`）、单一区域、单一时间点取得；企业账号或后续网关策略调整下的行为未覆盖。

### 文档

- `SKILL.md`：版本升至 1.0.3；原理章节补充 `/v2/` 与 `buildHeaders` 签名及其"非必要条件"的定位；平台表 Windows 行改为 `%LOCALAPPDATA%`（回退 `%APPDATA%`）；安全说明的网络访问范围补 `/v2/` 路径；排错新增「Windows 已登录却持续 401」条目，明确指向令牌来源而非请求构造。
- `decrypt-token.js`：恢复 PR #74 中被一并删除的维护性注释——跨平台登录态路径清单（并修正 Windows 为 `%LOCALAPPDATA%`）、依赖与运行方式、`emitAndExit` 延迟退出的原因、`app.setName` 必须早于 ready 的警告、python3 回退的信任边界说明。
- `checkin.ps1`：恢复 `today_checked_in` 字段不可靠的说明（它是 `code=10001` 幂等兜底存在的理由）、`ELECTRON_RUN_AS_NODE` 必须移除的原因、`WB_CHECKIN_JITTER` 用法说明。

### 已知限制

- `checkin.sh`（macOS / Linux）仍使用不带 `/v2/` 前缀、仅 `Authorization` 的旧写法。实测可用，故本版未改动；如需与桌面端完全对齐可后续收敛。
- Windows 侧（`%LOCALAPPDATA%` 路径修复、`/v2/` 签名、`checkin.ps1` 的 HTTP 状态码判定）**未在 Windows 实机验证**，本版验证均在 macOS 完成；以 PR #74 提交者与后续使用者反馈为准。

## [1.0.2] - 2026-08-06

### 修复

- **兼容 WorkBuddy 桌面端 v5.3.8 新版登录态存储**（#68）：v5.3.8 不再把当前登录态写入 `state.vscdb`，改用明文 JSON 文件 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`（Windows/Linux 同构路径）。旧版（≤1.0.1）只认 `state.vscdb`，导致连续报「获取令牌失败（未知原因）」。
  - `decrypt-token.js` 改为**新版明文文件优先、旧版 `state.vscdb` 回退**；新版分支纯 Node 读取 `auth.accessToken`，无需 Electron `safeStorage` 解密。
  - `require("electron")` 包裹 try/catch，脚本可由普通 `node` 直接执行。
  - 统一 `emitAndExit()`（`process.stdout.write` 后延迟 ~200ms 退出），避免 `console.log` 后立即 `app.exit()` 导致 stdout 未 flush。
- **macOS 运行时策略改为 Node 优先**（#68）：直接调用 WorkBuddy.app 的 Electron 二进制会启动主应用而非执行脚本；新版明文文件用纯 Node 即可读取，无需依赖应用内 Electron。`checkin.sh`/`checkin.ps1`/`setup.sh`/`setup.ps1` 均改为 Node 优先、Electron 回退，新增 `WB_CHECKIN_NODE=<path>` 环境变量。
- **`daily-checkin` 的 `code=10001` 识别为已签到**（#68）：v5.3.8 实测 `checkin-status` 的 `today_checked_in` 不可靠（签到成功后仍为 `false`），当日重跑会再次调 `daily-checkin` 并返回 `code=10001`（今天已签到）；旧版将其误报为「签到未成功」，导致幂等分支失效。1.0.2 起正确报告「今日已签到，无需重复领取」。

### 改进

- 文档同步：`SKILL.md` / `references/dependencies.md` 更新原理、平台路径、依赖（Electron 降级为仅旧版可选）、环境变量（新增 `WB_CHECKIN_NODE`）、排错（v5.3.8 专项条目）。
- `setup.sh`/`setup.ps1`：v5.3.8 用户（仅 Node、无 Electron）不再被误判为「未找到 Electron」而失败。

### 合并前代码评审修复

- **`checkin.sh` / `checkin.ps1` Electron 回退条件修正（高）**：原实现仅当 Node 输出为空才回退 Electron；但旧版 `state.vscdb` 账户在装有 Node 的机器上，纯 Node 会输出非空的 `ERR`（无法解 safeStorage），导致 Electron 回退被跳过、误报失败（对 v1.0.1 旧版账户的回归）。改为「空 或 ERR」均回退。
- **`decrypt-token.js` 部分明文文件不再硬失败**：明文文件存在但缺 `auth.accessToken`（如升级中途 / 写入中）或解析失败时，不再 `exit 5`，而是落入旧版 `state.vscdb` 分支兜底。
- **`decrypt-token.js` 旧版读取异常可观测**：`readValue` 抛错（如 `node:sqlite` 不可用且未开 python3 回退）时不再裸抛，统一经 `DECRYPT_RESULT:ERR` 带原因输出，避免「未知原因」式失败。
- **`checkin.sh` `WB_CHECKIN_JITTER=0` / 非数字不再触发除零中止**：改为先 `[ -gt 0 ]` 校验。
- **`checkin.sh` 缺 `python3` 不再误报「签到未成功」**：结果解析为空时改为提示「请求已提交，缺 python3 无法解析」，避免服务端已成功却被报失败。

### 已知限制

### 已知限制

- Windows / Linux 的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` 路径基于 v5.3.8 桌面端约定推导，已在 macOS 实测命中，其他平台待真实环境确认。

## [1.0.1] - 2026-08-05

### 改进

- 凭据安全：解密成功时向 stderr 输出安全提示（不污染 token 管道）；python3 回退默认关闭，需 `WB_CHECKIN_ALLOW_PY_FALLBACK=1` 启用
- 安装安全：`setup.sh`/`setup.ps1` 自动 `npm install electron` 默认关闭，需 `WB_CHECKIN_AUTO_INSTALL_ELECTRON=1` 才下载，默认提示手动指定路径并声明供应链风险
- 文档：SKILL.md 安全说明补强，新增「所需权限」清单与「为何需要这些能力」上下文说明，回应 SkillSpector 审计 findings

### 技术优化

- `checkin.sh`/`checkin.ps1` 头部注释补充凭据安全说明

## [1.0.0] - 2026-08-05

### 新增

- 初始版本：WorkBuddy 每日积分自动签到 skill 正式纳入 legal-skills 仓库
- 跨平台签到脚本：`scripts/checkin.sh`（macOS/Linux/Git Bash）与 `scripts/checkin.ps1`（Windows PowerShell，兼容 PS 5.1）
- 令牌解密脚本 `scripts/decrypt-token.js`：基于 Electron `safeStorage` 解密本地 `state.vscdb` 会话，`node:sqlite` 不可用时自动回退 `python3`
- 一键安装脚本 `scripts/setup.sh` / `scripts/setup.ps1`：自动检测或通过 npm 下载 Electron 运行时，并验证解密链路
- 多 Agent 框架适配（WorkBuddy 自动化任务 / Claude Code / Codex / OpenClaw / 纯终端），定时方式覆盖 crontab / launchd / schtasks / WorkBuddy recurring
- 幂等保护：每次运行先查 `checkin-status`，今日已签到立即跳过，支持一天多时间点补签（默认推荐 09/12/15/18/21 点）
- 随机错峰：`WB_CHECKIN_JITTER=<秒>` 环境变量让脚本启动前随机等待，避免整点风暴
- 兼容旧版应用名 CodeBuddy：`WB_CHECKIN_APP_NAME=CodeBuddy` 覆盖钥匙串绑定名

### 设计要点

- **全本机运行**：不含任何后端服务，令牌仅发往腾讯官方接口 `copilot.tencent.com`，不上传第三方
- **令牌不落盘**：仅在内存中传递；`logs/` 只记录签到结果（积分/连续天数），不含令牌
- **沙箱兼容**：WorkBuddy 等 Agent 沙箱默认设 `ELECTRON_RUN_AS_NODE=1` 会导致 `require('electron')` 拿不到 `safeStorage`，脚本已用 `env -u`（sh）/ `Remove-Item Env:`（ps1）显式处理

### 已知限制

- 签到按自然日结算，若整天未开机则当日无法补签，次日首个运行点自动重新开始（连续天数会重置）
- 令牌过期（401）需打开 WorkBuddy 桌面端刷新登录态，次日自动恢复
- macOS 应用名与钥匙串绑定：新装为 `WorkBuddy`，旧版迁移可能仍是 `CodeBuddy`

### 合规提示

- 本 skill 等价于「每天手动点一次领取今日礼包」，仅操作本机当前登录用户自己的 WorkBuddy 账户
- 请勿用于他人账户、批量注册刷分或任何违反 WorkBuddy 用户协议的用途
- 使用者需自行承担使用风险，确保来源可信
