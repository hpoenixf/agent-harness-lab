# 研究工作台

比较两版合成产品手册，输出带固定编号出处的报告，同时保存 Markdown、HTML、CSV 和 SVG 图。默认由确定性网关替身选择工具和撰写固定比较，不据此评价模型质量。

在仓库根目录运行：

```bash
node examples/research-workbench/src/cli.mjs demo
node examples/research-workbench/src/cli.mjs serve
```

第一条完成研究，第二条打印只读阅读地址。页面支持窄屏、原页回读与登记文件下载；关闭页面不会终止独立后台任务。

常用操作：

```bash
node examples/research-workbench/src/cli.mjs background --state .runs/background
node examples/research-workbench/src/cli.mjs inspect --state .runs/background
node examples/research-workbench/src/cli.mjs serve --state .runs/background
node examples/research-workbench/src/cli.mjs cancel --state .runs/background
node --test examples/research-workbench/test/*.test.mjs
```

`--state` 选择运行目录，默认 `.runs/workbench`。再次 `demo` 会复用已完成记录；新研究请选新目录。输出包含原始读取窗口、SQLite 运行事件、派生摘要、版本化记忆、发布修订和附件登记。

演示保存后的进程中断：

```bash
node examples/research-workbench/src/cli.mjs demo --state .runs/recovery --interrupt-after-save
# 首次以75退出；等待10秒让原执行租约到期，再恢复。
node examples/research-workbench/src/cli.mjs resume --state .runs/recovery
```

恢复复用原Run、授权、网关模式、调用身份和发布操作；已保存报告不会增加第二个修订。恢复真实运行仍需显式加 `--live`，不会自动付费或切换到替身。SQLite租约保护一个活动写入者，接管后旧owner不能再提交效果。文件效果独立于SQLite事务，以固定身份重放来收敛；这不是跨文件的统一事务。

可读源码入口：`src/workbench.mjs` 连接工具注册、受信任内建插件、Hook、按需Skill、并行子任务、关键词检索、来源外置与摘要、Memory、确定性计算、引用和附件。`src/storage.mjs` 与 `src/worker.mjs` 管执行与恢复；`src/gateway.mjs` 管普通JSON与SSE往返。各模块旁的测试覆盖可用路径与实际边界。

单人使用时，Node与运行记录都在本机，不需要部署数据库或注册应用账户。默认演示可完全断网运行。要让实际模型选择工具，先生成本机配置：

```bash
node examples/research-workbench/src/cli.mjs configure
```

编辑 `examples/research-workbench/.env` 的三项内容，再运行：

```bash
node examples/research-workbench/src/cli.mjs demo --live --state .runs/my-model
```

`HARNESS_BASE_URL` 是兼容服务的API根地址（通常以 `/v1` 结尾），`HARNESS_MODEL` 是已提供的模型名，`HARNESS_API_KEY` 是自己的Key。模板默认指向本机 `http://127.0.0.1:1234/v1`；已在本机启动且支持工具调用的服务可留空Key，实现本地推理。使用云服务时改成其地址与Key，需要联网并按服务方规则计费。

只自动读取本示例目录的 `.env`，不会向上寻找其他项目配置。环境变量优先；自定义配置可加 `--config /path/to/private.env`，后台与恢复使用相同参数。`configure` 遇到已有文件会原样保留；Key不写入运行记录、网页或命令行参数，配置文件已被Git忽略。配置好后仍需 `--live` 才会调用模型；普通 `demo` 始终使用免Key替身。

用户任务、当前记忆与授权手册内容会发给自己选定的模型服务。自动验证使用本机模拟HTTP，未调用云模型。默认教学预算为24次模型请求（含摘要）、80次工具调用，根任务和子任务共用并在恢复时继续累计。

边界：关键词检索不判断语义充分性，派生摘要不证明执行，记忆由模型提出、Host赋操作身份，引用只证明原窗口可回读。子任务是同一worker内的受限异步任务；后台worker才是独立进程。插件仅支持显式受信任内建贡献和整代替换，Schema验证为源码列出的有限子集。一Run只创建一份报告；CLI阅读页只展示已保存版本，保存前preview由模块测试单独演示。只读页面面向本机合成教学资料，不提供多用户生产鉴权或任意代码执行沙箱。工具和发布模块不替模型认证正文正确性。
