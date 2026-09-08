export interface ServerPackage {
  id: string
  name: string
  fileName: string
  size: number
  updatedAt: number
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

export async function downloadServerPackage(id: string): Promise<Blob> {
  const response = await fetch(`/api/packages/${encodeURIComponent(id)}/download`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.blob()
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

export async function uploadServerPackage(file: File): Promise<ServerPackage> {
  const formData = new FormData()
  formData.append('file', file)
  const result = await requestJson<{ package: ServerPackage }>('/api/packages', {
    method: 'POST',
    body: formData,
  })
  return result.package
}
