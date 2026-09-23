type SessionData = { authenticated?: boolean; token?: string; csrfToken?: string; role?: string; accountType?: string; mustChangePassword?: boolean; expiresAt?: string }

let csrfRefreshPromise: Promise<string | null> | null = null
let sessionRestorePromise: Promise<{ response: Response; data: SessionData | null }> | null = null

async function refreshCsrfToken() {
  if (csrfRefreshPromise) return csrfRefreshPromise
  csrfRefreshPromise = (async () => {
    const headers = new Headers()
    const token = sessionStorage.getItem('workpulse_token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch('/api/auth/session', { headers, credentials: 'include' })
    if (!response.ok) return null
    const data = await response.json() as SessionData
    if (!data.csrfToken) return null
    storeSession(data)
    return data.csrfToken
  })().finally(() => { csrfRefreshPromise = null })
  return csrfRefreshPromise
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = sessionStorage.getItem('workpulse_token')
  const csrfToken = sessionStorage.getItem('workpulse_csrf')
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  if (csrfToken && !headers.has('X-CSRF-Token') && !['GET', 'HEAD'].includes(String(init.method ?? 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    clearSession()
    window.location.replace('/')
    return response
  }
  if (response.status !== 403 || path === '/api/auth/session') return response

  const error = await response.clone().json().catch(() => null)
  if (error?.error !== 'Invalid or missing CSRF token') return response
  const refreshedToken = await refreshCsrfToken()
  if (!refreshedToken) return response
  headers.set('X-CSRF-Token', refreshedToken)
  return fetch(path, { ...init, headers, credentials: 'include' })
}

export function restoreSession() {
  if (!sessionRestorePromise) {
    sessionRestorePromise = apiFetch('/api/auth/session').then(async (response) => ({
      response,
      data: response.ok ? await response.json() as SessionData : null,
    }))
  }
  return sessionRestorePromise
}

export function storeSession(data: { token?: string; csrfToken?: string; role?: string; expiresAt?: string }) {
  if (data.token) sessionStorage.setItem('workpulse_token', data.token)
  else sessionStorage.removeItem('workpulse_token')
  if (data.csrfToken) sessionStorage.setItem('workpulse_csrf', data.csrfToken)
  if (data.role) sessionStorage.setItem('workpulse_role', data.role)
  if ('expiresAt' in data && typeof data.expiresAt === 'string') sessionStorage.setItem('workpulse_session_expires', data.expiresAt)
}

export function clearSession() {
  sessionStorage.removeItem('workpulse_token')
  sessionStorage.removeItem('workpulse_csrf')
  sessionStorage.removeItem('workpulse_role')
  sessionStorage.removeItem('workpulse_session_expires')
  sessionRestorePromise = null
}
