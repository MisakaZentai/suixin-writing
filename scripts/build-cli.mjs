/**
 * 打包命令行：dist-cli/suixin.mjs（单文件，Node ≥ 20 直接运行）。
 * 与 App 共用 src/lib 与 src/agent 的同一份代码，行为一致。
 */
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

await build({
  entryPoints: ['cli/main.ts'],
  outfile: 'dist-cli/suixin.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})
chmodSync('dist-cli/suixin.mjs', 0o755)
console.log('dist-cli/suixin.mjs')
