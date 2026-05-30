import type { Metadata } from 'next'
import { Space_Grotesk } from 'next/font/google'
import './globals.css'
import { Toaster } from 'sonner'

if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (event) => {
        const msg = String(event.reason?.message || event.reason || '');
        const name = String(event.reason?.name || '');
        if (
            msg.toLowerCase().includes('failed to fetch') ||
            msg.toLowerCase().includes('fetch') ||
            name === 'AbortError' ||
            msg.toLowerCase().includes('lock')
        ) {
            event.preventDefault();
            console.warn('Suppressed unhandled promise rejection:', event.reason);
        }
    });
}

const spaceGrotesk = Space_Grotesk({
    subsets: ['latin'],
    weight: ['300', '400', '500', '600', '700'],
    variable: '--font-space-grotesk',
    display: 'swap',
})

export const metadata: Metadata = {
    title: 'Pakalon',
    description: 'pakalon',
    icons: {
        icon: '/assets/Mini-logo.ico',
    },
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" className="dark">
            <head>
                <link
                    rel="stylesheet"
                    href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
                />
            </head>
            <body className={`${spaceGrotesk.variable} font-sans bg-background-dark text-white selection:bg-primary selection:text-background-dark antialiased`}>
                {children}
                <Toaster />
            </body>
        </html>
    )
}
