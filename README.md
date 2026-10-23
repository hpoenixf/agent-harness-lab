# Agent Harness Lab

可运行的 Agent Harness 教学示例，使用合成资料。

准备 Node.js **26.11.1**。安装了 fnm 的读者可先运行 `fnm use`。

| 示例 | 内容 | 运行方式 |
| --- | --- | --- |
| [文档比较工作台](examples/document-desk/) | 工具循环、页码出处、报告保存、顺序冷恢复；确定性网关替身 | `node examples/document-desk/src/demo.mjs` |
| [只读 MCP 服务](examples/read-page-mcp/) | 真实 MCP 客户端与服务端的 stdio 往返 | 进入目录，运行 `npm ci --ignore-scripts`，再运行 `npm run demo` |

第一个示例无需安装依赖；第二个示例需联网安装锁定依赖。运行示例不需要模型密钥。

工作台检查：`node --test examples/document-desk/test/desk.test.mjs`。

本仓库提供代码与简要运行说明。书稿另行维护。
