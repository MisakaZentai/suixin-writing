/**
 * 文稿库：所有文稿都自动保存在这里，启动页据此列出"最近文稿"。
 *
 * - 浏览器模式：IndexedDB（条目与正文分两个表，列表不必读全文）；
 * - 桌面版：应用数据目录下的 library/，另有 index.json 记录条目；
 *   绑定了用户文件的文稿同时写回该文件，打开时以该文件为准
 *  （外部 agent 可能改过它）。
 */
import { isTauri, readFileAt, writeFileAt } from './platform'

export interface DocEntry {
  id: string
  title: string
  updatedAt: string
  /** 字数（不计空白） */
  chars: number
  /** 绑定的用户文件（桌面版）；null 表示只在文稿库里 */
  path: string | null
}

export interface Library {
  list: () => Promise<DocEntry[]>
  read: (id: string) => Promise<string | null>
  write: (entry: DocEntry, json: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

const byRecent = (a: DocEntry, b: DocEntry) => b.updatedAt.localeCompare(a.updatedAt)

/* ── 浏览器：IndexedDB ────────────────────────────────── */

const DB_NAME = 'suixin-library'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('entries', { keyPath: 'id' })
      req.result.createObjectStore('contents')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开本机文稿库'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('文稿库写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('文稿库写入被中止'))
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null
const db = () => (dbPromise ??= openDB())

const browserLibrary: Library = {
  async list() {
    const tx = (await db()).transaction('entries', 'readonly')
    const all = await request(tx.objectStore('entries').getAll() as IDBRequest<DocEntry[]>)
    return all.sort(byRecent)
  },
  async read(id) {
    const tx = (await db()).transaction('contents', 'readonly')
    return ((await request(tx.objectStore('contents').get(id))) as string | undefined) ?? null
  },
  async write(entry, json) {
    const tx = (await db()).transaction(['entries', 'contents'], 'readwrite')
    tx.objectStore('entries').put(entry)
    tx.objectStore('contents').put(json, entry.id)
    await done(tx)
  },
  async remove(id) {
    const tx = (await db()).transaction(['entries', 'contents'], 'readwrite')
    tx.objectStore('entries').delete(id)
    tx.objectStore('contents').delete(id)
    await done(tx)
  },
}

/* ── 桌面版：应用数据目录 ─────────────────────────────── */

async function libraryDir(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  const { mkdir } = await import('@tauri-apps/plugin-fs')
  const dir = await join(await appDataDir(), 'library')
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    /* 已存在 */
  }
  return dir
}

async function libraryPath(name: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  return join(await libraryDir(), name)
}

async function readIndex(): Promise<DocEntry[]> {
  const text = await readFileAt(await libraryPath('index.json'))
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as DocEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeIndex(entries: DocEntry[]): Promise<void> {
  await writeFileAt(await libraryPath('index.json'), JSON.stringify(entries, null, 2))
}

const tauriLibrary: Library = {
  async list() {
    return (await readIndex()).sort(byRecent)
  },
  async read(id) {
    const entry = (await readIndex()).find((e) => e.id === id)
    if (entry?.path) {
      const fromFile = await readFileAt(entry.path)
      if (fromFile) return fromFile
    }
    return readFileAt(await libraryPath(`${id}.suixin.json`))
  },
  async write(entry, json) {
    await writeFileAt(await libraryPath(`${entry.id}.suixin.json`), json)
    if (entry.path) await writeFileAt(entry.path, json)
    const index = (await readIndex()).filter((e) => e.id !== entry.id)
    await writeIndex([entry, ...index])
  },
  async remove(id) {
    const { remove } = await import('@tauri-apps/plugin-fs')
    try {
      await remove(await libraryPath(`${id}.suixin.json`))
    } catch {
      /* 文件可能已不存在 */
    }
    await writeIndex((await readIndex()).filter((e) => e.id !== id))
  },
}

export const library: Library = isTauri ? tauriLibrary : browserLibrary
