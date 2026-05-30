'use client'

import Image from 'next/image'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { toast } from 'sonner'

function GithubLoginContent() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [isConnecting, setIsConnecting] = useState(false)
    const [selectedHostMode, setSelectedHostMode] = useState<'select' | 'cloud'>('select')
    const [isCheckingSession, setIsCheckingSession] = useState(true)
    const initialError = searchParams.get('error')
    const [errorMsg, setErrorMsg] = useState<string | null>(initialError)

    const nextPath = useMemo(() => {
        const rawNext = searchParams.get('next') || '/dashboard'
        return rawNext.startsWith('/') ? rawNext : '/dashboard'
    }, [searchParams])

    useEffect(() => {
        const supabase = createClient()
        supabase.auth.getSession().then(({ data }) => {
            if (data?.session && !initialError) {
                router.replace(nextPath)
            } else {
                setIsCheckingSession(false)
            }
        }).catch((err) => {
            console.error("Failed to fetch session:", err)
            setIsCheckingSession(false)
        })
    }, [initialError, nextPath, router])

    const handleLogin = async () => {
        setIsConnecting(true)
        setErrorMsg(null)
        try {
            const supabase = createClient()
            const { data } = await supabase.auth.getSession()
            if (data.session) {
                router.replace(nextPath)
                return
            }
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'github',
                options: {
                    redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(nextPath)}`,
                },
            })
            if (error) {
                console.error('Supabase OAuth error:', error)
                throw error
            }
        } catch (err: any) {
            console.error('Login error:', err)
            const message = err?.message ?? err?.error_description ?? 'GitHub sign-in failed'
            setErrorMsg(message)
            setIsConnecting(false)
            if (typeof toast !== 'undefined') {
                toast.error(`Login failed: ${message}`)
            }
        }
    }

    if (isCheckingSession) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background-dark">
                <div className="flex flex-col items-center gap-4">
                    <div className="size-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <p className="text-[#b1b4a2] text-sm">Checking authentication status…</p>
                </div>
            </div>
        )
    }

    if (selectedHostMode === 'select') {
        return (
            <div className="min-h-screen flex items-center justify-center p-6 bg-background-dark relative">
                {/* Back button */}
                <div className="absolute top-6 left-6 z-20">
                    <a
                        href="/"
                        className="inline-flex items-center gap-2 text-sm text-[#b1b4a2] hover:text-white transition-colors group"
                    >
                        <span className="material-symbols-outlined text-lg group-hover:-translate-x-0.5 transition-transform">arrow_back</span>
                        Back to Home
                    </a>
                </div>
                {/* Decorative background elements */}
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none opacity-20">
                    <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary rounded-full blur-[120px]"></div>
                    <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-primary/30 rounded-full blur-[120px]"></div>
                </div>

                <div className="w-full max-w-4xl space-y-8 z-10">
                    <div className="text-center space-y-4">
                        <div className="mx-auto flex items-center justify-center">
                            <Image
                                src="/assets/Light_theme_TPBG.png"
                                alt="Pakalon"
                                width={265}
                                height={125}
                                className="object-contain"
                                style={{ height: '125px', width: 'auto' }}
                                priority
                            />
                        </div>
                        <div className="space-y-1">
                            <h1 className="text-3xl font-bold tracking-tight text-white">Choose your hosting methodology</h1>
                            <p className="text-[#b1b4a2] max-w-lg mx-auto">
                                To get started with Pakalon, please select your preferred deployment environment.
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl mx-auto">
                        {/* Cloud Card */}
                        <button
                            onClick={() => setSelectedHostMode('cloud')}
                            className="group relative text-left bg-surface-dark border border-border-dark rounded-2xl p-8 hover:border-primary/30 hover:scale-[1.02] transition-all duration-300 flex flex-col h-full cursor-pointer w-full"
                        >
                            <div className="absolute -inset-px bg-gradient-to-b from-primary/10 to-transparent opacity-0 group-hover:opacity-100 rounded-2xl transition-opacity duration-300 pointer-events-none" />
                            <div className="size-14 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-6">
                                <span className="material-symbols-outlined text-3xl">cloud</span>
                            </div>
                            <h2 className="text-2xl font-bold text-white mb-4">Cloud Based</h2>
                            <p className="text-[#b1b4a2] text-sm leading-relaxed flex-1 mb-8">
                                Connect to Pakalon Cloud. Sign in using GitHub to access your hosted dashboard, API credentials, and cloud integrations.
                            </p>
                            <div className="w-full bg-primary text-background-dark px-6 py-3 rounded-lg font-bold text-center group-hover:opacity-90 transition-opacity">
                                Choose Cloud Based
                            </div>
                        </button>

                        {/* Self-Hosted Card */}
                        <a
                            href="https://github.com/Tarun-1516/Pakalon.git"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative text-left bg-surface-dark border border-border-dark rounded-2xl p-8 hover:border-primary/30 hover:scale-[1.02] transition-all duration-300 flex flex-col h-full"
                        >
                            <div className="absolute -inset-px bg-gradient-to-b from-primary/10 to-transparent opacity-0 group-hover:opacity-100 rounded-2xl transition-opacity duration-300 pointer-events-none" />
                            <div className="size-14 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-6">
                                <span className="material-symbols-outlined text-3xl">terminal</span>
                            </div>
                            <h2 className="text-2xl font-bold text-white mb-4">Self-Hosted</h2>
                            <p className="text-[#b1b4a2] text-sm leading-relaxed flex-1 mb-8">
                                Run your own local Pakalon node. View instructions and clone the source code repository directly from GitHub.
                            </p>
                            <div className="w-full bg-surface-dark border border-border-dark text-white px-6 py-3 rounded-lg font-bold text-center group-hover:bg-white/5 transition-colors">
                                Go to GitHub Repo
                            </div>
                        </a>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-background-dark relative">
            {/* Back button */}
            <div className="absolute top-6 left-6 z-20">
                <button
                    onClick={() => setSelectedHostMode('select')}
                    className="inline-flex items-center gap-2 text-sm text-[#b1b4a2] hover:text-white transition-colors group"
                >
                    <span className="material-symbols-outlined text-lg group-hover:-translate-x-0.5 transition-transform">arrow_back</span>
                    Back to Hosting Selector
                </button>
            </div>
            {/* Decorative background elements */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none opacity-20">
                <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary rounded-full blur-[120px]"></div>
                <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-primary/30 rounded-full blur-[120px]"></div>
            </div>

            <div className="w-full max-w-md space-y-8 z-10">
                <div className="text-center space-y-4">
                    <div className="mx-auto flex items-center justify-center">
                        <Image
                            src="/assets/Light_theme_TPBG.png"
                            alt="Pakalon"
                            width={265}
                            height={125}
                            className="object-contain"
                            style={{ height: '125px', width: 'auto' }}
                            priority
                        />
                    </div>
                    <div className="space-y-1">
                        <h1 className="text-3xl font-bold tracking-tight text-white">Welcome Back</h1>
                        <p className="text-[#b1b4a2]">Sign in to Pakalon with your GitHub account</p>
                    </div>
                </div>

                <div className="bg-surface-dark border border-border-dark p-8 rounded-2xl shadow-xl space-y-6">
                    <div className="flex items-center gap-4 p-4 rounded-xl bg-background-dark/50 border border-border-dark">
                        <div className="size-10 bg-primary rounded-lg flex items-center justify-center text-background-dark shrink-0">
                            <span className="material-symbols-outlined font-bold">terminal</span>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white leading-none">Pakalon CLI</p>
                            <p className="text-[10px] text-primary uppercase font-bold tracking-widest mt-1">
                                Official OAuth Application
                            </p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="flex items-center gap-3 text-sm text-[#b1b4a2]">
                            <span className="material-symbols-outlined text-green-400 text-lg">check_circle</span>
                            <span>Read access to your public profile</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-[#b1b4a2]">
                            <span className="material-symbols-outlined text-green-400 text-lg">check_circle</span>
                            <span>Email address verification</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-[#b1b4a2]">
                            <span className="material-symbols-outlined text-green-400 text-lg">check_circle</span>
                            <span>Secure CLI session management</span>
                        </div>
                    </div>

                    {errorMsg && (
                        <p className="text-sm text-red-400 text-center px-2">{errorMsg}</p>
                    )}

                    <button
                        onClick={handleLogin}
                        disabled={isConnecting}
                        className={`w-full h-14 rounded-xl font-bold flex items-center justify-center gap-3 transition-all ${isConnecting
                            ? 'bg-surface-hover text-[#b1b4a2] cursor-not-allowed'
                            : 'bg-white text-black hover:bg-gray-200 hover:scale-[1.01] active:scale-[0.98]'
                            }`}
                    >
                        {isConnecting ? (
                            <>
                                <div className="size-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
                                Connecting...
                            </>
                        ) : (
                            <>
                                <svg height="20" viewBox="0 0 16 16" version="1.1" width="20" aria-hidden="true">
                                    <path
                                        fill="currentColor"
                                        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                                    />
                                </svg>
                                Continue with GitHub
                            </>
                        )}
                    </button>

                    <p className="text-[11px] text-center text-[#b1b4a2] px-4">
                        By continuing, you agree to Pakalon&apos;s{' '}
                        <a href="#" className="underline hover:text-white">
                            Terms of Service
                        </a>{' '}
                        and{' '}
                        <a href="#" className="underline hover:text-white">
                            Privacy Policy
                        </a>
                        .
                    </p>
                </div>

                <div className="flex justify-center gap-6 text-xs text-[#b1b4a2]">
                    <a href="#" className="hover:text-white transition-colors">Help</a>
                    <a href="#" className="hover:text-white transition-colors">Security</a>
                    <a href="#" className="hover:text-white transition-colors">API Status</a>
                </div>
            </div>
        </div>
    )
}

export default function GithubLoginPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center bg-background-dark">
                    <div className="flex flex-col items-center gap-4">
                        <div className="size-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <p className="text-[#b1b4a2] text-sm">Preparing sign-in…</p>
                    </div>
                </div>
            }
        >
            <GithubLoginContent />
        </Suspense>
    )
}
