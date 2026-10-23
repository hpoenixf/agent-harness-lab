# 文档比较工作台

使用合成手册和确定性网关替身，演示读取、工具回执、报告文件与顺序冷恢复。

在仓库根目录运行：

```bash
node examples/document-desk/src/demo.mjs
node --test examples/document-desk/test/desk.test.mjs
```

结果写入 `.runs/demo/`：`run.jsonl` 是运行记录，`artifacts/save-report/report.md` 是报告。报告保留两版手册第 2 页的出处；再次运行会读取已有完成记录。

需要演示恢复时，用 `--state .runs/recovery` 选一个新目录，先加 `--interrupt-after-save` 运行，再用同一目录普通运行。首次以 75 退出，第二次补齐回执，不创建第二份报告。

要求 Node 26.11.1；一个状态目录只由一个进程写入。不使用真实模型或业务数据。
