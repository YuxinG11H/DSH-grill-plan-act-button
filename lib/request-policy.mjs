// Custom plugin routes are not an authentication boundary. Block drive-by website
// access, require JSON for mutations, and leave authorization to the DSH host.
export function checkRequest(req) {
  const origin = req.headers?.origin
  if (origin) {
    let trusted = origin === 'dsh-app://app'
    if (!trusted) {
      try {
        const url = new URL(origin)
        const host = String(req.headers?.host || '')
        trusted = ['http:', 'https:'].includes(url.protocol)
          && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          && url.host.toLowerCase() === host.toLowerCase()
      } catch {}
    }
    if (!trusted) return { status: 403, error: 'Cross-origin plugin requests are not allowed' }
  }
  const method = req.method || 'GET'
  if (!['GET', 'POST', 'PUT'].includes(method)) return { status: 405, error: 'Method not allowed' }
  if (method === 'POST' || method === 'PUT') {
    const mime = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (mime !== 'application/json') return { status: 415, error: 'JSON content type required' }
  }
  return null
}
