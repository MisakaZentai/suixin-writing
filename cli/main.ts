/** 命令行入口：node dist-cli/suixin.mjs … */
import path from 'node:path'
import { runCli } from './suixin'
import { serveStdio } from './mcp'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const argv = process.argv.slice(2)

if (argv[0] === 'mcp') {
  // suixin mcp [--as 名字] [--file 默认文稿]
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i > 0 ? argv[i + 1] : undefined
  }
  const file = flag('file')
  void serveStdio({
    cwd: process.cwd(),
    author: flag('as') ?? process.env.SUIXIN_AGENT,
    defaultFile: file ? path.resolve(file) : undefined,
  })
} else {
  runCli(argv, {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    readStdin,
    env: process.env,
    cwd: process.cwd(),
  }).then((code) => {
    process.exitCode = code
  })
}
