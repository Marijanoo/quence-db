/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.NODE_ENV === 'production' ? { output: 'export' } : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  turbopack: {},
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        poll: false,
        aggregateTimeout: 1000,
        ignored: [
          '**/node_modules/**',
          '**/.next/**',
          '**/dist-electron/**',
          '**/dist/**',
          '**/out/**',
          '**/.git/**',
          '**/electron/**',
        ],
      }
      for (const rule of config.module.rules) {
        if (!rule || typeof rule !== 'object') continue
        const uses = Array.isArray(rule.use) ? rule.use : rule.use ? [rule.use] : []
        for (const use of uses) {
          if (use?.loader?.includes('postcss-loader')) {
            use.options = { ...use.options, workerThreads: false, parallel: false }
          }
        }
        const oneOf = rule.oneOf
        if (Array.isArray(oneOf)) {
          for (const r of oneOf) {
            const innerUses = Array.isArray(r?.use) ? r.use : r?.use ? [r.use] : []
            for (const use of innerUses) {
              if (use?.loader?.includes('postcss-loader')) {
                use.options = { ...use.options, workerThreads: false, parallel: false }
              }
            }
          }
        }
      }
    }
    return config
  },
}

export default nextConfig
