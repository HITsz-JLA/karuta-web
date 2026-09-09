import type { PackageMode } from '../types/models'

export interface ServerPackage {
  id: string
  name: string
  fileName: string
  size: number
  updatedAt: number
  mode: PackageMode
}

export interface ServerPackageDownloadProgress {
  loaded: number
  total: number
}

export type ServerPackageDownloadProgressHandler = (progress: ServerPackageDownloadProgress) => void

const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024

function parseContentRange(value: string | null) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '')
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  }
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) return body.message
  } catch {
    // Fall through to a generic message when the server did not return JSON.
  }
  return `请求失败（HTTP ${response.status}）`
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new Error(await responseError(response))
  return (await response.json()) as T
}

export async function listServerPackages(): Promise<ServerPackage[]> {
  const result = await requestJson<{ packages: ServerPackage[] }>('/api/packages')
  return result.packages
}

export async function downloadServerPackage(
  id: string,
  expectedSize?: number,
  onProgress?: ServerPackageDownloadProgressHandler,
): Promise<Blob> {
  try {
    const url = `/api/packages/${encodeURIComponent(id)}/download`
    const totalHint = expectedSize && expectedSize > 0 ? expectedSize : undefined
    const chunks: ArrayBuffer[] = []
    let offset = 0
    let total = totalHint
    const firstEnd = total ? Math.min(total - 1, DOWNLOAD_CHUNK_SIZE - 1) : DOWNLOAD_CHUNK_SIZE - 1
    const firstResponse = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Range: `bytes=0-${firstEnd}` },
    })
    if (!firstResponse.ok) throw new Error(await responseError(firstResponse))

    // A server/proxy that ignores Range may still return a complete ZIP. Keep
    // that path compatible, while normal downloads use bounded requests.
    if (firstResponse.status === 200) {
      const blob = await firstResponse.blob()
      if (!blob.size) throw new Error('服务器返回了空数据包')
      onProgress?.({ loaded: blob.size, total: totalHint || blob.size })
      return blob
    }

    const firstRange = parseContentRange(firstResponse.headers.get('content-range'))
    if (firstResponse.status !== 206 || !firstRange || firstRange.start !== 0 || firstRange.end < 0) {
      throw new Error('服务器未按分块方式返回数据包')
    }
    total = firstRange.total
    if (!total || (totalHint && total !== totalHint)) {
      throw new Error('服务器数据包大小发生变化，请刷新页面后重试')
    }
    const firstChunk = await firstResponse.arrayBuffer()
    if (firstChunk.byteLength !== firstRange.end - firstRange.start + 1) {
      throw new Error('服务器返回的数据包分块不完整')
    }
    chunks.push(firstChunk)
    offset = firstRange.end + 1
    onProgress?.({ loaded: offset, total })

    while (offset < total) {
      const end = Math.min(offset + DOWNLOAD_CHUNK_SIZE - 1, total - 1)
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Range: `bytes=${offset}-${end}` },
      })
      if (!response.ok) throw new Error(await responseError(response))
      const range = parseContentRange(response.headers.get('content-range'))
      if (response.status !== 206 || !range || range.start !== offset || range.end !== end || range.total !== total) {
        throw new Error('服务器返回的数据包分块顺序不正确')
      }
      const chunk = await response.arrayBuffer()
      if (chunk.byteLength !== end - offset + 1) {
        throw new Error('服务器返回的数据包分块不完整')
      }
      chunks.push(chunk)
      offset = end + 1
      onProgress?.({ loaded: offset, total })
    }

    const blob = new Blob(chunks, { type: 'application/zip' })
    if (!blob.size || blob.size !== total) throw new Error('服务器返回了不完整的数据包')
    return blob
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('无法从服务器读取数据包，请检查局域网连接后刷新页面重试')
    }
    throw error
  }
}

export async function getAdminSession(): Promise<boolean> {
  const result = await requestJson<{ authenticated: boolean }>('/api/admin/session')
  return result.authenticated
}

export async function loginAdmin(password: string): Promise<void> {
  await requestJson('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

export async function logoutAdmin(): Promise<void> {
  await requestJson('/api/admin/logout', { method: 'POST' })
}

export async function uploadServerPackage(file: File, mode: PackageMode): Promise<ServerPackage> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('mode', mode)
  const result = await requestJson<{ package: ServerPackage }>('/api/packages', {
    method: 'POST',
    body: formData,
  })
  return result.package
}
