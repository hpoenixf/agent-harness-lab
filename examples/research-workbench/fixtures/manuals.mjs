export const manuals = Object.freeze({
  'manual-a-v1': Object.freeze({
    title: '产品手册 A', version: '1.0',
    pages: Object.freeze([
      '编辑后请点击保存。',
      '导出：仅支持 Markdown。导出的文件包含笔记正文，不含操作历史。',
      '免费版可离线查看已缓存页面，编辑需要联网。',
      '免费版每次最多导出 1000 条记录。',
    ]),
    metrics: Object.freeze({ maxExportRows: 1000 }),
  }),
  'manual-b-v2': Object.freeze({
    title: '产品手册 B', version: '2.0',
    pages: Object.freeze([
      '编辑后自动保存。',
      '导出：支持 Markdown 和 PDF。导出的文件包含笔记正文，不含操作历史。',
      '免费版可离线查看已缓存页面，编辑需要联网。企业版支持离线编辑。',
      '免费版每次最多导出 5000 条记录。',
    ]),
    metrics: Object.freeze({ maxExportRows: 5000 }),
  }),
});
