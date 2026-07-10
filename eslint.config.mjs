import nextConfig from 'eslint-config-next'

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      'coverage/**',
    ],
  },
  ...nextConfig,
]

export default eslintConfig
