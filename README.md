<div align="center">
  <img src="pakalon-web/public/assets/Light_theme_TPBG.png" alt="Pakalon Logo" width="400">

  # Pakalon — AI-Powered CLI Code Editor (Self-Hosted)

  > Build production-ready applications with one prompt. Pakalon is an AI-powered CLI that combines a streaming chat interface with a 6-phase autonomous build pipeline. **This README is for the self-hosted version — no cloud account, no login, fully local.**
</div>

---

## Quick Start (Self-Hosted)

Self-hosted mode runs **completely offline** against your own LLM (Ollama or LM Studio). No GitHub OAuth, no Polar billing, no cloud telemetry.

```sh
# 1. Clone
git clone https://github.com/Tarun-1516/Pakalon.git
cd Pakalon

# 2. Start a local LLM (pick one)
#    Ollama:  https://ollama.com   (default: http://localhost:11434)
ollama serve
ollama pull llama3
#    OR LM Studio: https://lmstudio.ai   (default: http://localhost:1234)
#    Start the LM Studio application and load a model.

# 3. Install the CLI
cd pakalon-cli
bun install
bun run build

# 4. Run
bun run start
```

The first time you launch, Pakalon auto-detects the self-hosted mode (no login prompt, no token window). Only local models are listed by `/models`.

---

## Self-Hosted vs Cloud

| | Self-Hosted (this README) | Cloud |
|---|---|---|
| **Account required** | No | Yes (GitHub OAuth via Clerk) |
| **Billing** | None | Polar, postpaid |
| **Auth** | None | 6-digit device code |
| **Models** | Ollama / LM Studio only | OpenRouter 550+ |
| **Telemetry** | Local only | Sent to pakalon servers |
| **Internet** | Optional | Required |
| **Folder layout** | `.pakalon/` | `.pakalon-agents/` |

> The application chooses between cloud and self-hosted **before** the login screen on the web UI. The CLI infers self-hosted by the presence of `~/.config/pakalon/selfhost.json` or the `--selfhost` flag.

---

## How It Works

Pakalon is an AI-powered code editor that operates in two main modes:

### 1. Normal Mode (Chat Mode)
- Interactive streaming AI conversation
- Plan, Edit, Auto-accept, Bypass modes
- Real-time code generation and editing
- No special initialization required

### 2. Agent Mode (Pakalon-Agents Initialized)
- 6-phase autonomous build pipeline
- Human-in-Loop (HIL) or YOLO mode
- Automatic project scaffolding and documentation
- Full-stack application generation

```
┌─────────────────────────────────────────────────────────────┐
│                      pakalon-web                            │
│  Next.js · Tailwind                                          │
│  Local dashboard + device code UI (optional)                │
└─────────────────────────┬───────────────────────────────────┘
                          │ Optional HTTPS (skip in self-hosted)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    pakalon-backend                          │
│  FastAPI · PostgreSQL · Redis                                │
│  Auth / Billing / Models / Telemetry  (optional in self)    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    pakalon-cli                              │
│  TypeScript · Bun · Ink TUI · Zustand · Drizzle ORM        │
│                                                             │
│  Chat mode → streams to local Ollama / LM Studio            │
│  Agent mode → 6-phase autonomous build                     │
│                                                             │
│  Phase 1  Planning — research + Q&A + plan files           │
│  Phase 2  Wireframes — Penpot SVG + TDD verification       │
│  Phase 3  Development — 5 sub-agents (SA1–SA5)             │
│  Phase 4  Testing & QA — SAST/DAST security scanning       │
│  Phase 5  CI/CD — GitHub Actions + PR                      │
│  Phase 6  Documentation — API docs + README                │
└─────────────────────────────────────────────────────────────┘
```

---

## Working Modes

### When Pakalon-Agents is NOT Initialized (Normal Mode)

| Feature | Description |
|---------|-------------|
| **Chat Mode** | Interactive streaming AI conversation |
| **Plan Mode** | Switch to planning mode (`/plan`) |
| **Edit Mode** | Switch to code editing mode (`/edit`) |
| **Auto-accept Mode** | All tool calls automatically accepted |
| **Bypass Mode** | YOLO mode — AI handles everything |

### When Pakalon-Agents is Initialized (Agent Mode)

Initialize with `/pakalon` command to enable the full 6-phase build pipeline:

```bash
pakalon
/pakalon "Build a SaaS dashboard with Next.js and PostgreSQL"
```

| Phase | Name | Description |
|-------|------|-------------|
| 1 | Planning & Requirements | Research, Q&A, plan files, context management |
| 2 | Wireframes | Penpot wireframes, TDD verification |
| 3 | Development | Frontend + Backend + Integration (5 sub-agents) |
| 4 | Testing & QA | SAST/DAST security scanning (5 sub-agents) |
| 5 | Deployment | CI/CD, GitHub Actions, PR creation |
| 6 | Documentation | API docs, README, CHANGELOG |

---

## Local Model Setup (Required for Self-Hosted)

### Option A: Ollama

```sh
# 1. Install from https://ollama.com
# 2. Start the server
ollama serve
# 3. Pull a model
ollama pull llama3
# 4. (Optional) Pull more
ollama pull qwen2.5-coder:32b
ollama pull deepseek-r1:14b
```

### Option B: LM Studio

1. Download from https://lmstudio.ai
2. Open the app and load a model
3. Start the local server (default: `http://localhost:1234`)

### Pakalon CLI — Local Model Commands

```bash
# List all local models (auto-detected from Ollama + LM Studio)
pakalon local-models

# Check provider health
pakalon local-models status

# Set default local model
pakalon local-models set-default ollama:llama3

# Start the chat (with --selfhost flag for explicit self-hosted mode)
pakalon --selfhost
```

---

## Installation

### Prerequisites (Self-Hosted)

| Tool | Min Version | Required? |
|------|-------------|-----------|
| **Bun** | 1.0+ | Yes — for CLI build |
| **Node.js** | 20+ | Optional — fallback runtime |
| **Ollama** or **LM Studio** | Latest | Yes — for LLM |
| **Docker** | Latest | Optional — for Penpot (Phase 2) and SAST/DAST (Phase 4) |
| **Git** | 2.x | Yes — for Phase 5 PR creation |

### CLI Build

```sh
cd pakalon-cli
bun install
bun run build
bun run start
```

### Optional: Backend (for dashboard / advanced features)

The CLI works **without the backend** in self-hosted mode. Add it only if you want a local dashboard:

```sh
cd pakalon-backend
cp .env.example .env
# Edit .env (most fields can stay blank in self-hosted mode)
docker compose up -d          # PostgreSQL + Redis
uv venv && uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

### Optional: Web UI

```sh
cd pakalon-web
pnpm install
pnpm dev
```

---

## Commands Reference

### Top-Level Commands (Self-Hosted)

```bash
pakalon                          # Start interactive chat
pakalon --version                # Show version
pakalon --help                   # Show help
pakalon --selfhost               # Force self-hosted mode
pakalon doctor                   # System requirements check
pakalon install                  # Install dependencies
pakalon init                     # Initialize .pakalon/ config
pakalon local-models             # Manage local LLM models
pakalon /pakalon "<prompt>"      # Launch 6-phase agentic builder
```

### Slash Commands (Inside Chat)

| Command | Description |
|---------|-------------|
| `/init` | Initialize `.pakalon/` folder with `skills.md` |
| `/pakalon` | Initialize agent mode (creates `.pakalon-agents/`) |
| `/plan` | Switch to Plan mode |
| `/edit` | Switch to Edit mode |
| `/undo` | Undo last code/conversation change |
| `/compact` | Compact conversation context |
| `/clear` | Clear chat history |
| `/sessions` | Browse saved sessions |
| `/resume` | Resume previous session |
| `/resume <session_id>` | Resume a specific session |
| `/session` | List sessions in current project |
| `/new` | Start a new session |
| `/history` | Show prompts + line-changes history |
| `/models` | List available models (local-only in self-hosted) |
| `/agents` | Manage agent teams |
| `/auditor` | Run code audit (loops Phase 3 ↔ Auditor until clean) |
| `/update` | Apply design changes (e.g. `/update navbar rounded`) |
| `/penpot` | Open Penpot design tool |
| `/connect` | Connect Telegram bot |
| `/connect-end` | Disconnect Telegram bot |
| `/ans` | Side Q&A without interrupting running agent |
| `/multi-session` | Multi-session manager with blinking indicators |
| `/local-models` | Manage local LLM models (alias of `pakalon local-models`) |
| `/automations` | Manage automation workflows (cron + GitHub + Slack) |
| `/workflows` | List saved workflows |
| `/plugins` | Manage plugins |
| `/phase-1` | Run only Phase 1 (planning + Q&A) |
| `/phase-2` | Run only Phase 2 (wireframes + Penpot) |
| `/phase-3` | Run only Phase 3 (5 sub-agents + auditor) |
| `/phase-4` | Run only Phase 4 (SAST/DAST + security tests) |
| `/phase-5` | Run only Phase 5 (CI/CD + GitHub PR) |
| `/phase-6` | Run only Phase 6 (documentation) |
| `/web` | Web command (search a URL and act on it) |
| `/directory` | Directory management |
| `@<agent-name>` | Mention an agent in chat |
| `/help` | Show available commands |
| `/exit` or `q` | Quit |

### CLI Flags (Self-Hosted)

```bash
--selfhost                     # Force self-hosted mode (skip cloud checks)
--add-dir <dir>...             # Add directories to agent scope
--allowed-tools <tools>...     # Whitelist tools for this session
--disallowed-tools <tools>...  # Blacklist tools for this session
--max-budget-usd <amount>      # Cap session spend (0 for unlimited in self-host)
--model <model>                # Override default model
--fallback-model <model>       # Fallback model if primary fails
--mcp-config <configs>...      # MCP server config
--permission-mode <mode>       # plan | edit | auto-accept | bypass-permissions
--session-id <uuid>            # Resume specific session
--settings <file-or-json>      # Apply settings file
--tools <tools>...             # Restrict available tools
--verbose                      # Verbose output
-v, --version                  # Show version
-h, --help                     # Show help
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+C` | Cancel stream / Quit |
| `Ctrl+U` | Clear input |
| `Ctrl+O` | Toggle verbose panel |
| `Tab` | Cycle through modes (Plan / Edit / Auto-accept / Bypass) |
| `Shift+Tab` | Toggle model thinking |
| `↑ / ↓` | Browse input history |
| `Ctrl+P` | Toggle privacy mode (no telemetry) |

---

## Project Layout

### `.pakalon/` (Normal Mode)

```
.pakalon/
├── agents/
│   └── skills.md
├── plan.md
├── task.md
├── user-stories.md
└── context-management.md
```

### `.pakalon-agents/` (Agent Mode — initialized by `/pakalon`)

```
.pakalon-agents/
└── ai-agents/
    ├── sync.js                          # Penpot sync bridge
    ├── phase-1/
    │   ├── context_management.md
    │   ├── plan.md
    │   ├── tasks.md
    │   ├── design.md
    │   ├── phase-1.md
    │   ├── agent-skills.md
    │   ├── prd.md
    │   ├── Database_schema.md
    │   ├── API_reference.md
    │   ├── risk-assessment.md
    │   ├── user-stories.md
    │   ├── technical-spec.md
    │   ├── competitive-analysis.md
    │   └── constraints-and-tradeoffs.md
    ├── phase-2/
    │   ├── phase-2.md
    │   ├── Wireframe_generated.svg
    │   ├── Wireframe_generated.json
    │   ├── Wireframe_generated.penpot
    │   └── tdd-screenshots/
    ├── phase-3/
    │   ├── auditor.md
    │   ├── subagent-1.md                 # Frontend
    │   ├── subagent-2.md                 # Backend
    │   ├── subagent-3.md                 # Integration
    │   ├── subagent-4.md                 # Debug + test
    │   ├── subagent-5.md                 # Review
    │   ├── execution_log.md
    │   └── test-evidence/
    ├── phase-4/
    │   ├── subagent-1.md                 # SAST
    │   ├── subagent-2.md                 # DAST
    │   ├── subagent-3.md                 # Code review
    │   ├── subagent-4.md                 # CI/CD review
    │   ├── subagent-5.md                 # Cyber best-practices
    │   ├── blackbox_testing.xml
    │   └── whitebox_testing.xml
    ├── phase-5/
    │   └── phase-5.md
    ├── phase-6/
    │   └── phase-6.md
    ├── mcp-servers/
    ├── wireframes/
    └── pakalon.db
```

---

## Configuration

### Environment Variables (Self-Hosted — all optional)

```bash
# Local LLM endpoints (auto-detected by default)
OLLAMA_HOST=http://localhost:11434
LMSTUDIO_HOST=http://localhost:1234

# Optional: skip cloud checks even if remote is reachable
PAKALON_SELFHOST=1

# Optional: enable privacy mode (no telemetry at all)
PAKALON_PRIVACY=1

# Optional: Penpot (only needed for Phase 2 wireframes)
PENPOT_HOST=http://localhost:3449
PENPOT_API_TOKEN=your_penpot_token
```


## Local Sandbox

For larger builds, Pakalon spins up a local Docker sandbox for the first run and testing. The sandbox is **only active when `.pakalon-agents` is initialized** (Agent Mode). After Phase 4 confirms no errors/bugs/vulnerabilities, the sandbox is torn down and the code moves to your local project folder.

```bash
# Sandbox is auto-managed. To inspect:
docker ps | grep pakalon-sandbox
```

---

## Security Tools (Self-Hosted)

Self-hosted mode runs the free-tier security toolset by default. To run the full suite (Pro), use the security compose profile:

```bash
cd pakalon-cli
docker compose -f docker-compose.security.yml up -d
docker compose -f docker-compose.security.yml --profile full up -d
```

### Static Analysis (SAST) — included
- Semgrep
- SonarQube Community
- Gitleaks
- Bandit
- FindSecBugs
- Brakeman
- ESLint with security plugins

### Dynamic Analysis (DAST) — included
- OWASP ZAP
- Nikto
- sqlmap
- Wapiti
- XSStrike
- nmap

---

## Architecture Details

### Agent Pipeline (Pure TypeScript)

The entire agent pipeline runs in **pure TypeScript** — no Python required for the CLI:

```
User Prompt → Phase 1 (Planning) → Phase 2 (Wireframes)
     ↓                                    ↓
Phase 3 (Development) ←────────────── Phase 4 (Testing)
     ↓                                    ↓
Phase 5 (CI/CD) → Phase 6 (Documentation) → Complete
```

- **Phase 1**: Research, Q&A, plan files, context management
- **Phase 2**: Penpot wireframes, TDD verification
- **Phase 3**: 5 sub-agents for frontend, backend, integration, debugging, review
- **Phase 4**: SAST/DAST security scanning with the free-tier toolset
- **Phase 5**: GitHub Actions workflows, PR creation
- **Phase 6**: Auto-generated documentation

### Token Management

- **Context Window**: Tracks token usage per session (local only in self-hosted)
- **Auto-Compact**: Automatically compacts when nearing limits
- **Budget Allocation**: Tokens allocated per phase with 10% buffer
- **Model Selection**: Automatic model optimization based on task

---



<div align="center">
  <img src="pakalon-web/public/assets/Dark_theme_TPBG.png" alt="Pakalon Logo" width="200">

  **MIT © Pakalon**
</div>
