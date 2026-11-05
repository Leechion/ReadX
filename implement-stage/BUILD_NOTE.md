# Build Note — 外部集成剩余工作

| Rung | Feature | Acceptance check | Tier | Status |
| --- | --- | --- | --- | --- |
| F0 | 既有首版端到端接口和分享产物基线 | `cd windows; npm run test:external` | MUST | 通过 |
| F1 | 书架持久授权、恢复后的重新确认 | `cd windows; npm run test:external; npm run test:backup` | MUST | 通过 |
| F2 | 跨页检索会话、去重和滚雪球路径 | `cd windows; npm run test:external` | MUST | 通过 |
| F3 | 分享中的想法、对照与 EPUB 定位 | `cd windows; npm run test:external` | MUST | 通过 |
| F4 | Zotero 归档迁移和可重复双向冲突处理 | `cd windows; npm run test:external; npm run typecheck` | MUST | 通过 |

## Run record

F0：`npm run test:external` 退出 0；12 项 Go、4 项前端／协议测试通过；真实 HTTP 路由和 HTML 分享产物断言通过。

F1：新增书架 ID／禁发删除测试及恢复权限测试通过；`test:external`、`test:backup`（9 项）、分类／同步回归、`typecheck` 均退出 0。同步保留本机书架身份；修改书架成员撤销在途授权。

F2：跨页会话、来源合并、不可变检索式、父节点、无 DOI 去重和书库匹配测试通过；新增工作台任务幂等测试通过。`test:external`、`typecheck` 和前序 `test:backup` 退出 0。支持 OpenAlex W 标识锚点。

F3：新增 EPUB／章节定位、图片白名单、相关想法过滤和对照状态测试通过；生成 `implement-stage/readonly-share-fixture.html` 合成样本。`test:external`、`typecheck`、前序 `test:backup` 通过。浏览器工具明确拒绝 file:// URL，未绕过限制，真实浏览器离线验收仍待完成。

F4：迁移／归档／原生页码、重复迁移、缺附件保留、双向笔记、题录回写、集合稳定身份、版本冲突和本地修订 CAS 端到端测试通过。`test:external`、`typecheck` 和前序 `test:backup` 通过。Live 检索：Crossref 20 条、PubMed 20 条；OpenAlex HTTP 503，未将其记为通过。本机 23119 无 Zotero 服务，真实客户端验收未完成。

## Deferred

扩展商店上架。macOS、浏览器唤起和真实 Zotero 验收取决于本机可用运行环境。

## Blockers

## Assumption sweep

Reviewer: gpt-6-luna（遵循用户全局偏好）；review_independence: same-family；acceptance_status: provisional。第一轮发现 2 项未声明语义决定、1 项接口范围和 3 条过时表述，原文保存在 SILENT_ASSUMPTION_SWEEP.round1.json。已修复并发书架删除、历史附件导出保留、5,000 对象限制及图片占位，另补本地双视图冲突保护；相关回归全部通过，第二轮记录见下。被取消的 Astra 任务未参与结论。

第二轮 Luna 原文保存在 SILENT_ASSUMPTION_SWEEP.json，发现 2 项未声明语义问题：集合双本地编辑冲突、移除 PDF 后父条目／集合权限关联。已补修并增加移除 PDF 的权限回归及集合冲突回归；测试退出 0。按两轮预算结束审查，补修由执行者验证，未再次委派。review_independence: same-family；acceptance_status: provisional。

完整语义约定和接口约定逐条见 ASSUMPTIONS.md；无伪造结果的存活桩。四组实现及前序基线检查通过；真实环境阻塞见 docs/外部集成剩余工作交付-2026-11-05.md。

最终相关 Go 回归 41 通过、1 个 opt-in 网络用例跳过；前端及 SSE／聊天回归 10 通过，备份恢复 9 通过。Windows 生产构建与 macOS arm64 服务交叉编译通过，31 个共用源码／测试文件镜像无差异。真实目录单独联调的 OpenAlex 503 不记为通过。
