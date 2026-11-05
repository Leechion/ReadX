# Build Note — 外部集成剩余工作

| Rung | Feature | Acceptance check | Tier | Status |
| --- | --- | --- | --- | --- |
| F0 | 既有首版端到端接口和分享产物基线 | `cd windows; npm run test:external` | MUST | 通过 |
| F1 | 书架持久授权、恢复后的重新确认 | `cd windows; npm run test:external; npm run test:backup` | MUST | 通过 |
| F2 | 跨页检索会话、去重和滚雪球路径 | `cd windows; npm run test:external` | MUST | 待实现 |
| F3 | 分享中的想法、对照与 EPUB 定位 | `cd windows; npm run test:external` | MUST | 待实现 |
| F4 | Zotero 归档迁移和可重复双向冲突处理 | `cd windows; npm run test:external; npm run typecheck` | MUST | 待实现 |

## Run record

F0：`npm run test:external` 退出 0；12 项 Go、4 项前端／协议测试通过；真实 HTTP 路由和 HTML 分享产物断言通过。

F1：新增书架 ID／禁发删除测试及恢复权限测试通过；`test:external`、`test:backup`（9 项）、分类／同步回归、`typecheck` 均退出 0。同步保留本机书架身份；修改书架成员撤销在途授权。

## Deferred

扩展商店上架。macOS、浏览器唤起和真实 Zotero 验收取决于本机可用运行环境。

## Blockers
