/**
 * 平台能力抽象（spec §7：本地优先、Key 存系统安全区）。
 * Tauri 壳内走原生（对话框/文件/keyring），浏览器下调级运行：
 *   - 文件选择 → <input type=file>
 *   - 文件保存 → 浏览器下载
 *   - 密钥 → localStorage（仅开发降级，README 有说明）
 *   - 恢复文件 → localStorage
 */
import { nowISO } from './ids'

const TAURI_FLAG = '__TAURI_INTERNALS__'

export const isTauri: boolean =
  typeof window !== 'undefined' &&
  ((window as unknown as Record<string, unknown>)[TAURI_FLAG] !== undefined ||
    (window as unknown as Record<string, unknown>).__TAURI__ !== undefined)

/* ── 文件读取 ───────────────────────────────────────── */

export async function openTextFile(): Promise<{
  name: string
  text: string
} | null> {
  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const path = await open({
        multiple: false,
        filters: [
          { name: '文档', extensions: ['md', 'markdown', 'txt'] },
          { name: '工程 JSON', extensions: ['json'] },
        ],
      })
      if (!path || typeof path !== 'string') return null
      const suffix = path.toLowerCase()
      const isJson = suffix.endsWith('.json')
      const text = await readTextFile(path)
      return { name: path.split(/[\\/]/).pop() || '未命名', text, ...(isJson ? {} : {}) } as {
        name: string
        text: string
      }
    } catch (e) {
      console.error('Tauri open failed', e)
      return null
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      resolve({ name: file.name, text: await file.text() })
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/* ── 文件保存 ───────────────────────────────────────── */

export async function saveTextFile(
  suggestedName: string,
  content: string
): Promise<string | null> {
  if (isTauri) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const path = await save({ defaultPath: suggestedName })
      if (!path) return null
      await writeTextFile(path, content)
      return path
    } catch (e) {
      console.error('Tauri save failed', e)
      return null
    }
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

/* ── 崩溃恢复文件（spec F6：每 30s 自动保存） ────────── */

const RECOVERY_KEY = 'ai-writer:recovery'
const RECOVERY_TS_KEY = 'ai-writer:recovery-at'

export async function saveRecovery(content: string): Promise<void> {
  if (isTauri) {
    try {
      const { appDataDir } = await import('@tauri-apps/api/path')
      const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs')
      const dir = await appDataDir()
      try {
        await mkdir(dir, { recursive: true })
      } catch {
        /* 已存在 */
      }
      await writeTextFile(`${dir}recovery.json`, content)
      localStorage.setItem(RECOVERY_TS_KEY, nowISO())
      return
    } catch (e) {
      console.error('recovery save failed', e)
    }
  }
  try {
    localStorage.setItem(RECOVERY_KEY, content)
    localStorage.setItem(RECOVERY_TS_KEY, nowISO())
  } catch {
    /* 配额溢出时忽略 */
  }
}

export async function loadRecovery(): Promise<{
  content: string
  at: string | null
} | null> {
  let at = localStorage.getItem(RECOVERY_TS_KEY)
  if (isTauri) {
    try {
      const { appDataDir } = await import('@tauri-apps/api/path')
      const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
      const path = `${await appDataDir()}recovery.json`
      if (await exists(path)) {
        return { content: await readTextFile(path), at }
      }
      return null
    } catch {
      /* 走浏览器降级 */
    }
  }
  const content = localStorage.getItem(RECOVERY_KEY)
  if (!content) return null
  return { content, at }
}

export async function clearRecovery(): Promise<void> {
  localStorage.removeItem(RECOVERY_KEY)
  localStorage.removeItem(RECOVERY_TS_KEY)
  if (isTauri) {
    try {
      const { appDataDir } = await import('@tauri-apps/api/path')
      const { remove } = await import('@tauri-apps/plugin-fs')
      await remove(`${await appDataDir()}recovery.json`)
    } catch {
      /* ignore */
    }
  }
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
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('write_secret', { name, value })
        return
      } catch (e) {
        console.error('keyring write failed', e)
        throw e
      }
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
