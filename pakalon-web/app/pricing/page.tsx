'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'

export default function PricingPage() {
    const router = useRouter()
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [isCheckingSession, setIsCheckingSession] = useState(true)

    useEffect(() => {
        const supabase = createClient()

        supabase.auth.getSession().then(({ data }) => {
            setIsAuthenticated(Boolean(data?.session))
            setIsCheckingSession(false)
        }).catch((err) => {
            console.error("Failed to fetch session:", err)
            setIsAuthenticated(false)
            setIsCheckingSession(false)
        })

        const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
            setIsAuthenticated(Boolean(session))
            setIsCheckingSession(false)
        })

        return () => listener.subscription.unsubscribe()
    }, [])

    const freePlanCta = useMemo(() => {
        if (isCheckingSession) {
            return 'Checking access…'
        }
        return isAuthenticated ? 'Continue to Dashboard' : 'Sign in to Get Started'
    }, [isAuthenticated, isCheckingSession])

    const proPlanCta = 'Upgrade to Pro'

    const handleSelect = () => {
        if (isCheckingSession) {
            return
        }

        if (isAuthenticated) {
            router.push('/dashboard')
            return
        }

        router.push('/login?next=%2Fpricing')
    }

    const handleSelectPro = () => {
        window.open('https://airtable.com/appP7Y6kgdGeSpcLe/tblm1lZ7BJ46vBMuF/viwKepQIxZYC54fam', '_blank')
    }

    return (
        <div className="p-8 lg:p-16 space-y-24 max-w-6xl mx-auto">

            {/* Back button */}
            <div>
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-sm text-[#b1b4a2] hover:text-white transition-colors group"
                >
                    <span className="material-symbols-outlined text-lg group-hover:-translate-x-0.5 transition-transform">
                        arrow_back
                    </span>
                    Back to Home
                </Link>
            </div>

            <div className="text-center space-y-6">
                <div className="inline-flex items-center px-4 py-1 rounded-full border border-border-dark bg-surface-dark text-primary text-sm font-medium">
                    Simple, transparent pricing
                </div>
                <h1 className="text-5xl lg:text-7xl font-bold text-white tracking-tight">
                    Scale your AI workflows <br />
                    <span className="text-primary">effortlessly.</span>
                </h1>
                <p className="text-lg text-[#b1b4a2] max-w-xl mx-auto">
                    Lifetime free access for <span className="font-mono">:free</span> models, or unlock all models with Pro postpaid billing.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Free plan */}
                <div className="bg-surface-dark border border-border-dark rounded-2xl p-8 space-y-8 hover:border-white/10 transition-colors">
                    <div className="space-y-2">
                        <h3 className="text-2xl font-bold">Free</h3>
                        <p className="text-[#b1b4a2] text-sm">Perfect for hobbyists and side projects.</p>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-5xl font-bold text-white">$0</span>
                        <span className="text-[#b1b4a2] text-sm">/ month</span>
                    </div>
                    <button
                        onClick={handleSelect}
                        disabled={isCheckingSession}
                        className={`w-full py-3 rounded-lg border font-bold transition-colors ${
                            isCheckingSession
                                ? 'border-border-dark text-[#b1b4a2] cursor-not-allowed'
                                : 'border-border-dark hover:bg-white/5'
                        }`}
                    >
                        {freePlanCta}
                    </button>
                    <div className="space-y-4">
                        <p className="text-xs font-bold text-[#b1b4a2] uppercase tracking-wider">
                            What&apos;s included
                        </p>
                        <ul className="space-y-3">
                            {[
                                'Lifetime free access',
                                'OpenRouter models ending with :free',
                                'Basic security scanning (Bandit, sqlmap)',
                                'Penpot for wireframing and designing',
                            ].map((f, i) => (
                                <li key={i} className="flex items-center gap-3 text-sm text-[#b1b4a2]">
                                    <span className="material-symbols-outlined text-lg">check_circle</span> {f}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                {/* Pro plan */}
                <div className="bg-surface-dark border-2 border-primary rounded-2xl p-8 space-y-8 relative shadow-[0_0_40px_-10px_rgba(215,225,157,0.15)]">
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-background-dark text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                        Recommended
                    </div>
                    <div className="space-y-2">
                        <h3 className="text-2xl font-bold">Pro</h3>
                        <p className="text-[#b1b4a2] text-sm">Postpaid usage billing for professionals and teams.</p>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-4xl lg:text-5xl font-bold text-white">Pay as you go</span>
                    </div>
                    <p className="text-sm text-[#b1b4a2]">Monthly usage + 10% platform fee.</p>
                    <button
                        onClick={handleSelectPro}
                        className="w-full py-3 rounded-lg bg-primary text-background-dark font-bold hover:brightness-110 transition-all"
                    >
                        {proPlanCta}
                    </button>
                    <div className="space-y-4">
                        <p className="text-xs font-bold text-primary uppercase tracking-wider">
                            Everything in Free, plus
                        </p>
                        <ul className="space-y-3">
                            {[
                                'All 550+ AI models',
                                'Postpaid monthly usage statement',
                                '10% platform fee on model usage',
                                'Advanced security tools (Semgrep, OWASP ZAP)',
                                'Priority support',
                                'Extended context windows',
                                'Unlimited sessions',
                            ].map((f, i) => (
                                <li key={i} className="flex items-center gap-3 text-sm text-white">
                                    <span className="material-symbols-outlined text-lg text-primary">
                                        check_circle
                                    </span>{' '}
                                    {f}
                                </li>
                             ))}
                        </ul>
                    </div>
                </div>
            </div>

            {/* FAQ */}
            <div className="space-y-12">
                <h2 className="text-3xl font-bold text-center">Frequently Asked Questions</h2>
                <div className="max-w-3xl mx-auto space-y-4">
                    {[
                        {
                            q: 'What happens if I exceed my limit?',
                            a: 'For Pro, usage is metered postpaid; for Free, only :free models are available.',
                        },
                        {
                            q: 'Can I change plans at any time?',
                            a: 'Yes. You can switch between Free and Pro from billing settings.',
                        },
                        {
                            q: 'How does Pro billing work?',
                            a: 'Pro is metered pay-as-you-go based on monthly model usage and a 10% platform fee.',
                        },
                        {
                            q: 'Is Free really lifetime?',
                            a: 'Yes. Free remains lifetime for models that end with :free.',
                        },
                    ].map((item, i) => (
                        <details
                            key={i}
                            className="group bg-surface-dark border border-border-dark rounded-xl p-4 cursor-pointer hover:border-primary/20"
                        >
                            <summary className="flex items-center justify-between font-medium text-white list-none">
                                {item.q}
                                <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                                    expand_more
                                </span>
                            </summary>
                            <div className="mt-4 text-sm text-[#b1b4a2] leading-relaxed pb-2">{item.a}</div>
                        </details>
                    ))}
                </div>
            </div>

        </div>
    )
}
