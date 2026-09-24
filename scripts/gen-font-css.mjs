/**
 * 生成 src/styles/fonts.css：内置正文字体（思源宋体 / Noto Serif SC 常规字重）。
 * 只保留 woff2（WebView2 / WebKit 都支持），避免把 woff 备份一起打进安装包；
 * 按 unicode-range 分片，运行时只加载用到的字。
 *
 * 用法：node scripts/gen-font-css.mjs（升级 @fontsource/noto-serif-sc 后重跑）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync('node_modules/@fontsource/noto-serif-sc/400.css', 'utf8')
const out = source
  .replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '')
  .replace(/url\(\.\/files\//g, 'url(../../node_modules/@fontsource/noto-serif-sc/files/')
const header =
  '/* 由 scripts/gen-font-css.mjs 生成，请勿手改。字体：Noto Serif SC（SIL Open Font License 1.1） */\n'
writeFileSync('src/styles/fonts.css', header + out)
console.log('fonts.css:', (header + out).length, 'bytes,', (out.match(/@font-face/g) || []).length, 'faces')
