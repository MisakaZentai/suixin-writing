/**
 * 平台能力抽象（本地优先、Key 存系统安全区）。
 * Tauri 壳内走原生对话框 / 文件系统 / keyring，浏览器下降级运行：
 *   - 打开文件 → <input type=file>（拿不到路径，不能写回）
 *   - 保存文件 → 浏览器下载
 *   - 密钥 → localStorage（仅开发降级）
 */

const TAURI_FLAG = '__TAURI_INTERNALS__'

export const isTauri: boolean =
  typeof window !== 'undefined' &&
  ((window as unknown as Record<string, unknown>)[TAURI_FLAG] !== undefined ||
    (window as unknown as Record<string, unknown>).__TAURI__ !== undefined)

/**
 * Windows 桌面版不用系统标题栏（见 tauri.windows.conf.json）：顶栏兼作标题栏，
 * 窗口按钮由 WindowControls 自己画，和界面同一套颜色与深浅主题。
 */
export const customTitlebar: boolean = isTauri && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

export interface PickedFile {
  name: string
  text: string
  /** 桌面版的绝对路径；浏览器模式为 null */
  path: string | null
}

/* ── 打开 ───────────────────────────────────────────── */

export async function pickOpenFile(): Promise<PickedFile | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const path = await open({
      multiple: false,
      filters: [
        { name: '文稿', extensions: ['json', 'md', 'markdown', 'txt'] },
      ],
    })
    if (!path || typeof path !== 'string') return null
    const text = await readTextFile(path)
    return { name: path.split(/[\\/]/).pop() || '未命名', text, path }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      resolve({ name: file.name, text: await file.text(), path: null })
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** 选择若干份文字（建立 AI 味基线用）；取消返回空数组 */
export async function pickTextFiles(): Promise<{ name: string; text: string }[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const picked = await open({ multiple: true, filters: [{ name: '文字', extensions: ['txt', 'md', 'markdown', 'json'] }] })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    return Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop() || p, text: await readTextFile(p) })))
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.txt,.md,.markdown,.json'
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() }))))
    input.oncancel = () => resolve([])
    input.click()
  })
}

export interface PickedImage {
  name: string
  bytes: Uint8Array
}

/** 选择一张或多张图片；取消返回空数组 */
export async function pickImages(): Promise<PickedImage[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const picked = await open({
      multiple: true,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    return Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop() ?? p, bytes: await readFile(p) })))
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = async () => resolve(await filesToImages(Array.from(input.files ?? [])))
    input.oncancel = () => resolve([])
    input.click()
  })
}

export async function filesToImages(files: File[]): Promise<PickedImage[]> {
  return Promise.all(
    files
      .filter((f) => f.type.startsWith('image/'))
      .map(async (f) => ({ name: f.name || `image.${f.type.split('/')[1] || 'png'}`, bytes: new Uint8Array(await f.arrayBuffer()) }))
  )
}

/** 先选保存位置（仅桌面版）：导出时要按位置安排旁边的图片文件夹 */
export async function pickSavePath(suggestedName: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (!isTauri) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return (await save({ defaultPath: suggestedName, filters: [filter] })) ?? null
}

export async function writeBinaryAt(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri) throw new Error('浏览器模式不能直接写入文件')
  const { dirname } = await import('@tauri-apps/api/path')
  const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs')
  await mkdir(await dirname(path), { recursive: true }).catch(() => {})
  await writeFile(path, bytes)
}

/** 按路径读二进制文件（仅桌面版） */
export async function readBinaryAt(path: string): Promise<Uint8Array | null> {
  if (!isTauri) return null
  const { exists, readFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path))) return null
  return readFile(path)
}

/* ── 保存 ───────────────────────────────────────────── */

/** 让用户选择保存位置并写入；返回路径（浏览器下为文件名）；取消返回 null */
export async function saveTextFile(
  suggestedName: string,
  content: string,
  filter?: { name: string; extensions: string[] }
): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    const path = await save({ defaultPath: suggestedName, filters: filter ? [filter] : undefined })
    if (!path) return null
    await writeTextFile(path, content)
    return path
  }
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return suggestedName
}

/** 按路径读写（仅桌面版） */
export async function readFileAt(path: string): Promise<string | null> {
  if (!isTauri) return null
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path))) return null
  return readTextFile(path)
}

export async function writeFileAt(path: string, content: string): Promise<void> {
  if (!isTauri) throw new Error('浏览器模式不能直接写入文件')
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  await writeTextFile(path, content)
}

/* ── 网络请求 ───────────────────────────────────────── */

/**
 * AI 接口请求。桌面版由 Rust 侧发出（tauri-plugin-http），不受 WebView 跨域限制：
 * 自定义接口（本机模型、公司网关）多半不返回跨域头，OpenAI 在 Key 无效时的 401 也不带，
 * 走 WebView 只能看到"无法连接"，看不到真正的原因。浏览器模式照常用 fetch。
 */
export async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  if (!isTauri) return fetch(url, init)
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch(url, init)
}

/* ── 旧版恢复文件（只读，用于迁移进文稿库） ──────────── */

const LEGACY_RECOVERY_KEY = 'ai-writer:recovery'
const LEGACY_RECOVERY_TS_KEY = 'ai-writer:recovery-at'

/** 读取旧版恢复槽里的文稿（不删除，迁移成功后再调用 clearLegacyRecovery） */
export async function readLegacyRecovery(): Promise<{ content: string; at: string | null } | null> {
  const at = localStorage.getItem(LEGACY_RECOVERY_TS_KEY)
  let content: string | null = null
  if (isTauri) {
    try {
      const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
      for (const path of await legacyRecoveryPaths()) {
        if (await exists(path)) {
          content = await readTextFile(path)
          break
        }
      }
    } catch {
      /* 找不到就算了 */
    }
  }
  content = content ?? localStorage.getItem(LEGACY_RECOVERY_KEY)
  return content && content.trim() ? { content, at } : null
}

export async function clearLegacyRecovery(): Promise<void> {
  localStorage.removeItem(LEGACY_RECOVERY_KEY)
  localStorage.removeItem(LEGACY_RECOVERY_TS_KEY)
  if (!isTauri) return
  try {
    const { exists, remove } = await import('@tauri-apps/plugin-fs')
    for (const path of await legacyRecoveryPaths()) {
      if (await exists(path)) await remove(path)
    }
  } catch {
    /* ignore */
  }
}

/** 旧版拼路径时漏了分隔符，两种位置都找一找 */
async function legacyRecoveryPaths(): Promise<string[]> {
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  return [await join(dir, 'recovery.json'), `${dir}recovery.json`]
}

/* ── API Key 安全存储 ───────────────────────────────── */

const SECRET_PREFIX = 'ai-writer:secret:'

export const secret = {
  async get(name: string): Promise<string | null> {
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        return (await invoke('read_secret', { name })) as string | null
      } catch {
        return null
      }
    }
    return localStorage.getItem(SECRET_PREFIX + name)
  },
  async set(name: string, value: string): Promise<void> {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_secret', { name, value })
      return
    }
    localStorage.setItem(SECRET_PREFIX + name, value)
  },
  async del(name: string): Promise<void> {
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('delete_secret', { name })
        return
      } catch {
        /* ignore */
      }
    }
    localStorage.removeItem(SECRET_PREFIX + name)
  },
}
