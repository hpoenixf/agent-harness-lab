# Agent Harness Lab

通过两版教学文档，观察工具调用、原文读取和报告下载怎样连起来。支持 Node.js **>=26.11.1 <27**。仓库 `.node-version` 固定为 **26.11.1**，用于复现和回归；使用 fnm 可运行 `fnm install`、`fnm use`。

| 示例 | 用途 |
| --- | --- |
| [最小文档比较](examples/document-desk/) | 从工具循环到第一份报告，无第三方依赖 |
| [研究工作台](examples/research-workbench/) | 扩展、并行读取、上下文、记忆、引用、附件、后台、恢复、观测与交付检查，无第三方依赖 |
| [只读 MCP](examples/read-page-mcp/) | 真实 SDK 的 stdio 客户端与服务端，需要安装锁定依赖 |

先运行最小示例，结果保存在 `.runs/demo/artifacts/save-report/report.md`：

```bash
node examples/document-desk/src/demo.mjs
```

再运行完整研究示例，打开页面看出处和附件：

```bash
node examples/research-workbench/src/cli.mjs demo
node examples/research-workbench/src/cli.mjs serve
```

打开第二条命令显示的本机地址，可以回读原页、下载报告和数据图表。默认使用模拟网关，断网也能演示；单人本机使用不需要云数据库或登录。也可配置自己的Key，或接入本机无Key模型，见示例说明。

运行自动检查：

```bash
node --test examples/document-desk/test/*.test.mjs examples/research-workbench/test/*.test.mjs
```

Node 版本范围检查：

```bash
node --test test/node-version.test.mjs
```

用 Docker 固定版本复现研究工作台的离线演示：

```bash
docker build -t agent-harness-lab .
docker run --rm agent-harness-lab
```

`Dockerfile` 使用官方 `node:26.11.1-bookworm-slim` 镜像。根目录 [LICENSE](LICENSE) 仅许可本仓库自身代码和教学资料；MCP 示例的锁定依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。独立书稿不在本仓库许可范围内。

这些是可修改的教学实现，存储、协议和界面的适用范围见各示例说明。仓库只维护独立代码、合成数据与运行说明。

真实模型练习与记录：使用[四题运行入口](docs/live-evaluation.md)接入自己已获准的兼容服务；[2026-10-25 两模型运行记录](docs/live-runs/2026-10-25/README.md)同时保留交付结果与辅助核对发现的内容缺陷。
