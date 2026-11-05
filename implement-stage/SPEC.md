# 外部集成剩余工作

Base commit: 724d9ac00511a27b462915c547f8d4f5544512b7

目标：继续完成首版交付清单中的功能缺口，沿用 Go、React、Electron、本地优先和两端镜像。

输入：现有书库、分类、备份、检索记录、Zotero 本机 API、笔记与证据。输出：可操作的权限、检索会话、迁移／同步、扩充后的只读分享；持久结构记录在 ASSUMPTIONS.md，运行结果记录在 BUILD_NOTE.md。

Success command: `cd windows; npm run test:external; npm run test:backup; npm run typecheck`

真实客户端与 macOS 验收依赖可用运行环境；不会用模拟测试声称完成实机验收。第三方扩展商店上架不包含在源码实现内。
