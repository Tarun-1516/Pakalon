import { createBrowserClient, createServerClient as _createServerClient } from '@supabase/ssr'
import type { cookies } from 'next/headers'

let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null

/**
 * Create a Supabase browser client (for Client Components).
 * Uses cookies via @supabase/ssr so PKCE verifier is available server-side too.
 */
export function createClient() {
    if (typeof window === 'undefined') {
        return createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        )
    }

    if (!supabaseInstance) {
        supabaseInstance = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                auth: {
                    lockType: 'custom',
                    lock: async (name, acquireTimeout, fn) => {
                        return fn();
                    }
                }
            }
        )
    }
    return supabaseInstance
}

/**
 * Create a Supabase server client (for Route Handlers and Server Components).
 * Reads/writes cookies from the Next.js cookie store.
 * Pass the result of `await cookies()` from `next/headers`.
 */
export function createServerClient(cookieStore: Awaited<ReturnType<typeof cookies>>) {
    return _createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        )
                    } catch {
                        // setAll can be called from a Server Component where cookies are read-only.
                        // Safe to ignore — session refresh still works via middleware if configured.
                    }
                },
            },
        },
    )
}
