/**
 * Built-in brainstorming questions for Phase 1.
 *
 * These are the curated question templates that Phase 1 will ask the
 * user. Each entry maps to a multi-choice prompt with 2-4 options.
 *
 * CLI-req §"Phase 1" requires at minimum 10 questions to be asked. The
 * list below provides 12, which gives the LLM room to drop two if the
 * user has already implied an answer in the original prompt.
 */
import type { AskUserQuestion } from "./AskUserQuestionTool.js";

export const BRAINSTORM_QUESTIONS: AskUserQuestion[] = [
  {
    question: "Which frontend framework should the app use?",
    header: "Frontend",
    multiSelect: false,
    options: [
      { label: "Next.js + React", description: "App Router, RSC, shadcn/ui" },
      { label: "Vite + React", description: "SPA, fast HMR" },
      { label: "Remix", description: "Nested routes, loaders" },
      { label: "Plain HTML/TS", description: "No framework" },
    ],
  },
  {
    question: "Which backend runtime should power the API?",
    header: "Backend",
    multiSelect: false,
    options: [
      { label: "FastAPI (Python)", description: "Type hints, Pydantic" },
      { label: "Node.js + Express", description: "Familiar, fast to scaffold" },
      { label: "Node.js + Hono", description: "Lightweight, edge-ready" },
      { label: "Bun + Elysia", description: "Fastest cold start" },
    ],
  },
  {
    question: "Which database should store primary data?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "PostgreSQL", description: "Relational, JSONB, full-text" },
      { label: "SQLite", description: "Single-file, zero-ops" },
      { label: "MongoDB", description: "Document store" },
      { label: "Supabase", description: "Postgres + auth out of the box" },
    ],
  },
  {
    question: "How should users authenticate?",
    header: "Auth",
    multiSelect: false,
    options: [
      { label: "GitHub OAuth", description: "Dev-friendly, low friction" },
      { label: "Email + password", description: "Classic, password reset flow" },
      { label: "Magic link", description: "No passwords, email-based" },
      { label: "Anonymous / guest", description: "No account required" },
    ],
  },
  {
    question: "How will the app be deployed?",
    header: "Deploy",
    multiSelect: false,
    options: [
      { label: "Vercel", description: "Best for Next.js" },
      { label: "AWS", description: "ECS, Fargate, or Lambda" },
      { label: "Self-hosted Docker", description: "Your own server" },
      { label: "Static export", description: "No server, CDN only" },
    ],
  },
  {
    question: "Which design system should drive the UI?",
    header: "Design",
    multiSelect: false,
    options: [
      { label: "shadcn/ui", description: "Tailwind, copy-paste" },
      { label: "Material UI", description: "Mature, opinionated" },
      { label: "Chakra UI", description: "Composable, themeable" },
      { label: "Plain Tailwind", description: "Build components from scratch" },
    ],
  },
  {
    question: "Which payment provider (if any)?",
    header: "Payments",
    multiSelect: false,
    options: [
      { label: "Stripe", description: "Cards, subscriptions, Checkout" },
      { label: "Polar.sh", description: "Open-source, dev-friendly" },
      { label: "Paddle", description: "Merchant of record" },
      { label: "None", description: "No payments needed" },
    ],
  },
  {
    question: "Who is the primary user?",
    header: "Audience",
    multiSelect: false,
    options: [
      { label: "Developers", description: "API-first, CLI-friendly" },
      { label: "End consumers", description: "Mobile-first, marketing site" },
      { label: "Internal team", description: "Admin-focused, low polish" },
      { label: "Enterprise", description: "SSO, audit logs, SLAs" },
    ],
  },
  {
    question: "What scale target should the architecture support?",
    header: "Scale",
    multiSelect: false,
    options: [
      { label: "Hobby (< 1k MAU)", description: "Single VPS, SQLite OK" },
      { label: "Startup (1k–100k MAU)", description: "Managed Postgres, 1–3 services" },
      { label: "Growth (100k–1M MAU)", description: "Queues, caching, multi-region" },
      { label: "Enterprise (> 1M MAU)", description: "Sharding, dedicated infra" },
    ],
  },
  {
    question: "Which security baseline should be enforced?",
    header: "Security",
    multiSelect: true,
    options: [
      { label: "OWASP ASVS L1", description: "Basic web app security" },
      { label: "OWASP ASVS L2", description: "Standard for sensitive apps" },
      { label: "SOC 2 ready", description: "Auditable logs, encryption" },
      { label: "HIPAA / PCI", description: "Regulated workloads" },
    ],
  },
  {
    question: "Should the app be open source?",
    header: "License",
    multiSelect: false,
    options: [
      { label: "MIT", description: "Permissive, do anything" },
      { label: "Apache 2.0", description: "Permissive + patent grant" },
      { label: "AGPL", description: "Copyleft, network-use" },
      { label: "Proprietary", description: "Closed source" },
    ],
  },
  {
    question: "Should Pakalon finish building once the 6 phases are done?",
    header: "End Phase 1",
    multiSelect: false,
    options: [
      { label: "Yes, continue", description: "Move on to Phase 2" },
      { label: "Pause for review", description: "Stop and let me inspect" },
      { label: "Revisit answers", description: "Re-ask one or more questions" },
    ],
  },
];

/** Minimum number of questions CLI-req §"Phase 1" requires. */
export const MIN_BRAINSTORM_QUESTIONS = 10;
