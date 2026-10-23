# 只读 MCP 服务

`fixtures.mjs` 提供两版合成手册；`server.mjs` 注册 `read_page`；`client.mjs` 启动服务，发现工具、读取页面并检查参数与错误返回，结束后关闭子进程。

```bash
cd examples/read-page-mcp
npm ci --ignore-scripts --no-audit --no-fund
npm run demo
```

预期输出包括 `tools: read_page`、两版第 2 页原文，以及最后的 `closed:`。客户端自带断言，不符合预期会以非零状态退出。

固定 Node 26.11.1、MCP 客户端/服务端 SDK 2.3.1、Zod 4.6.7，协议显式设为 2026-07-28。依赖版本见锁文件；传输为 stdio，资料仅来自本目录合成文本。
