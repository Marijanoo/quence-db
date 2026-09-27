// Previews of web links found in cells (the value panel): fetched here in the main process, so no
// page code runs in the app and sites that refuse to be framed still get a preview. Only http(s),
// no cookies, time and size limits.

export interface LinkPreview {
  url: string        // after redirects
  status: number
  contentType: string
  title?: string
  description?: string
  siteName?: string
  // data: URLs, so the renderer loads nothing itself
  image?: string
  icon?: string
  // The link is an image itself
  isImage: boolean
}

const TIMEOUT_MS = 8000
const MAX_HTML = 1_500_000
const MAX_IMAGE = 8_000_000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QuenceDB link preview'

export function checkUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error('Not a valid URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links are previewed')
  return u
}

async function fetchLimited(url: string, maxBytes: number, accept: string): Promise<{ res: Response; body: Buffer }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: accept }, credentials: 'omit' })
    const chunks: Buffer[] = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        chunks.push(Buffer.from(value))
        if (size >= maxBytes) { void reader.cancel(); break }
      }
    }
    return { res, body: Buffer.concat(chunks) }
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`No answer within ${TIMEOUT_MS / 1000} seconds`)
    throw new Error(`Couldn't reach ${new URL(url).host}: ${err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

const decodeEntities = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

// Title, description, site name, image and icon from a page's <head>
export function parseHtmlPreview(html: string, base: string): { title?: string; description?: string; siteName?: string; image?: string; icon?: string } {
  const head = html.slice(0, 300_000)
  const attrs = (tag: string) => {
    const out: Record<string, string> = {}
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '')
    return out
  }
  const meta: Record<string, string> = {}
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0])
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase()
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content.trim()
  }
  let icon: string | undefined
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0])
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(a.rel ?? '') && a.href) { icon = a.href; if (/apple-touch-icon/i.test(a.rel)) break }
  }
  const abs = (u?: string) => { if (!u) return undefined; try { return new URL(u, base).href } catch { return undefined } }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const clean = (s?: string) => s ? decodeEntities(s).replace(/\s+/g, ' ').trim() || undefined : undefined
  return {
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description),
    siteName: clean(meta['og:site_name']),
    image: abs(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? meta['twitter:image:src']),
    icon: abs(icon ?? '/favicon.ico'),
  }
}

async function imageData(url: string | undefined, max = MAX_IMAGE): Promise<string | undefined> {
  if (!url) return undefined
  try {
    const { res, body } = await fetchLimited(checkUrl(url).href, max, 'image/*')
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!res.ok || !type.startsWith('image/') || body.length >= max) return undefined
    return `data:${type};base64,${body.toString('base64')}`
  } catch {
    return undefined
  }
}

export async function linkPreview(raw: string): Promise<LinkPreview> {
  const url = checkUrl(raw).href
  const { res, body } = await fetchLimited(url, MAX_IMAGE, 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5')
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const base: LinkPreview = { url: res.url || url, status: res.status, contentType, isImage: false }
  if (contentType.startsWith('image/')) {
    return body.length < MAX_IMAGE ? { ...base, isImage: true, image: `data:${contentType};base64,${body.toString('base64')}` } : { ...base, isImage: true }
  }
  if (!/html|xml/.test(contentType)) return base
  const found = parseHtmlPreview(body.subarray(0, MAX_HTML).toString('utf8'), base.url)
  const [image, icon] = await Promise.all([imageData(found.image), imageData(found.icon, 300_000)])
  return { ...base, title: found.title, description: found.description, siteName: found.siteName, image, icon }
}
