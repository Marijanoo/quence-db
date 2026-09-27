import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { checkUrl, linkPreview, parseHtmlPreview } from './link-preview'

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

describe('reading a page head', () => {
  it('prefers Open Graph, decodes entities and resolves relative URLs', () => {
    const html = `<html><head><title>Plain  title</title>
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Show&quot;">
      <meta name="description" content="Short   description">
      <meta property="og:site_name" content='Cartoons'>
      <meta property="og:image" content="/img/cover.png">
      <link rel="icon" href="favicon.png"></head><body></body></html>`
    expect(parseHtmlPreview(html, 'https://example.com/shows/1')).toEqual({
      title: `Tom & Jerry's "Show"`, description: 'Short description', siteName: 'Cartoons',
      image: 'https://example.com/img/cover.png', icon: 'https://example.com/shows/favicon.png',
    })
  })

  it('falls back to <title> and /favicon.ico', () => {
    expect(parseHtmlPreview('<title>Hello</title>', 'http://x.test/a')).toMatchObject({ title: 'Hello', icon: 'http://x.test/favicon.ico', image: undefined })
  })

  it('only takes http(s) links', () => {
    expect(() => checkUrl('file:///C:/Windows/win.ini')).toThrow(/Only http and https/)
    expect(() => checkUrl('javascript:alert(1)')).toThrow(/Only http and https/)
    expect(() => checkUrl('not a url')).toThrow(/Not a valid URL/)
  })
})

describe('fetching previews', () => {
  let server: http.Server
  let base = ''
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<head><meta property="og:title" content="A page"><meta property="og:image" content="/cover.png"></head>')
      } else if (req.url === '/cover.png' || req.url === '/photo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG)
      } else if (req.url === '/old') {
        res.writeHead(301, { Location: '/page' }); res.end()
      } else if (req.url === '/slow') {
        setTimeout(() => { res.writeHead(200); res.end('late') }, 20_000)
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<title>Not found</title>')
      }
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })

  it('previews a page with its image, following redirects', async () => {
    const p = await linkPreview(`${base}/old`)
    expect(p).toMatchObject({ url: `${base}/page`, status: 200, title: 'A page', isImage: false })
    expect(p.image).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  it('shows an image link as the image', async () => {
    expect(await linkPreview(`${base}/photo.png`)).toMatchObject({ isImage: true, contentType: 'image/png', image: `data:image/png;base64,${PNG.toString('base64')}` })
  })

  it('reports errors and missing pages', async () => {
    expect(await linkPreview(`${base}/nope`)).toMatchObject({ status: 404, title: 'Not found' })
    await expect(linkPreview('http://127.0.0.1:1/')).rejects.toThrow(/Couldn't reach 127\.0\.0\.1:1/)
  })

  it('gives up on slow sites', async () => {
    await expect(linkPreview(`${base}/slow`)).rejects.toThrow(/No answer within 8 seconds/)
  }, 15_000)
})
