import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'

const port = parseInt(process.env.PORT || process.argv[2] || '3001', 10)
const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev, turbopack: false })
const handle = app.getRequestHandler()

await app.prepare()

const server = createServer((req, res) => {
  handle(req, res, parse(req.url, true))
})

const nextUpgradeHandler = app.getUpgradeHandler()
server.on('upgrade', (req, socket, head) => {
  nextUpgradeHandler(req, socket, head)
})

server.listen(port, () => {
  console.log(`> Ready on http://localhost:${port}`)
})
