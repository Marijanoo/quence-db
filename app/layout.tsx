import type { Metadata } from 'next'
import { ZoomHandler } from '@/components/zoom-handler'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata: Metadata = {
  title: 'QuenceDB',
  description: 'Database client',
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background">
      <body className="font-sans antialiased overflow-hidden">
        <ZoomHandler />
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
