#!/usr/bin/env node
// 迁移历史记录：把 JSON 里的 base64 图片提取成独立文件
// 用法: node migrate-history.js [test|prod|both]

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'history');
const IMG_DIR = path.join(HISTORY_DIR, 'images');

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

function migrate(env) {
  const file = path.join(HISTORY_DIR, `history_${env}.json`);
  if (!fs.existsSync(file)) { console.log(`[${env}] 文件不存在，跳过`); return; }

  const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`[${env}] 读取 history_${env}.json (${sizeMB} MB)...`);

  let records;
  try { records = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch(e) { console.error(`[${env}] JSON 解析失败: ${e.message}`); return; }

  console.log(`[${env}] 共 ${records.length} 条记录`);

  let migrated = 0, skipped = 0, already = 0;

  const slim = records.map((rec, i) => {
    // 已经迁移过的（有 imageUrl 且不是 data:）
    if (rec.imageUrl && !rec.imageUrl.startsWith('data:')) {
      already++;
      const { imageDataUrl, ...rest } = rec;
      return rest;
    }

    const dataUrl = rec.imageDataUrl || rec.imageUrl || '';
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      skipped++;
      const { imageDataUrl, ...rest } = rec;
      return { ...rest, imageUrl: dataUrl };
    }

    // 提取并保存
    try {
      const matches = dataUrl.match(/^data:image\/([a-z]+);base64,(.+)$/i);
      if (!matches) { skipped++; const { imageDataUrl, ...rest } = rec; return rest; }
      const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      const buf = Buffer.from(matches[2], 'base64');
      const filename = `${rec.id}.${ext}`;
      const filepath = path.join(IMG_DIR, filename);
      fs.writeFileSync(filepath, buf);
      migrated++;
      if (migrated % 20 === 0) process.stdout.write(`  已处理 ${migrated + already}/${records.length}...\r`);
      const { imageDataUrl, ...rest } = rec;
      return { ...rest, imageUrl: `/api/history-img/${filename}` };
    } catch(e) {
      skipped++;
      const { imageDataUrl, ...rest } = rec;
      return rest;
    }
  });

  console.log(`\n[${env}] 迁移完成: 新提取 ${migrated} 张, 已迁移 ${already} 条, 跳过 ${skipped} 条`);

  // 备份原文件
  const backup = file + '.bak';
  fs.copyFileSync(file, backup);
  console.log(`[${env}] 原文件已备份到 history_${env}.json.bak`);

  // 写新的精简 JSON
  fs.writeFileSync(file, JSON.stringify(slim, null, 2), 'utf-8');
  const newSizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`[${env}] 新 JSON 大小: ${newSizeMB} MB (原 ${sizeMB} MB)`);
}

const target = process.argv[2] || 'both';
if (target === 'both' || target === 'test') migrate('test');
if (target === 'both' || target === 'prod') migrate('prod');
console.log('全部完成！');
