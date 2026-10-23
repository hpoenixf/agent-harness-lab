# Agent Harness Lab

用合成手册搭建可运行的文档研究工作台。准备 Node.js **26.11.1**；使用 fnm 时先运行 `fnm use`。

| 示例 | 用途 |
| --- | --- |
| [最小文档比较](examples/document-desk/) | 从工具循环到第一份报告，无第三方依赖 |
| [研究工作台](examples/research-workbench/) | 扩展、并行读取、上下文、记忆、引用、附件、后台与恢复，无第三方依赖 |
| [只读 MCP](examples/read-page-mcp/) | 真实 SDK 的 stdio 客户端与服务端，需要安装锁定依赖 |

先跑完整示例：

```bash
node examples/research-workbench/src/cli.mjs demo
node examples/research-workbench/src/cli.mjs serve
```

打开第二条命令显示的本机地址，可以回读原页、下载报告和数据图表。默认使用确定性网关替身，断网也能演示；单人本机使用不需要云数据库或登录。也可配置自己的Key，或接入本机无Key模型，见示例说明。

运行自动检查：

```bash
node --test examples/document-desk/test/*.test.mjs examples/research-workbench/test/*.test.mjs
```

这些是可修改的教学实现，存储、协议和界面的适用范围见各示例说明。仓库只维护独立代码、合成数据与运行说明。
