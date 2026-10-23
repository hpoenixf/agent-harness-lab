// Synthetic teaching fixtures. These are not real product documents.
export const manuals = Object.freeze({
  "manual-v1": Object.freeze({
    version: "1.0",
    pages: Object.freeze([
      "星河笔记 1.0：编辑后请点击保存。关闭页面前应确认保存完成。",
      "导出：仅支持 Markdown。导出的文件包含笔记正文，不含操作历史。"
    ])
  }),
  "manual-v2": Object.freeze({
    version: "2.0",
    pages: Object.freeze([
      "星河笔记 2.0：编辑后自动保存。页面会显示最近一次保存的时间。",
      "导出：支持 Markdown 和 PDF。导出的文件包含笔记正文，不含操作历史。"
    ])
  })
});
