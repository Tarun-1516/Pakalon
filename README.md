<div align="center">
  <img src="pakalon-web/public/assets/Dark_theme_TPBG.png" alt="Pakalon Logo" width="400">
  
  # Pakalon — AI-Powered CLI Code Editor
  
  > Build production-ready applications with one prompt. Pakalon is an AI-powered CLI that combines a streaming chat interface with a 6-phase autonomous build pipeline.
</div>

---

## Quick Start

```sh
npm install -g pakalon
pakalon
```

---

## How It Works

Pakalon is an AI-powered code editor that operates in two main modes:

### 1. Normal Mode (Chat Mode)
- Interactive streaming AI conversation
- Plan, Edit, and Auto-accept modes
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
│  Next.js · Tailwind · Supabase (GitHub OAuth) · Polar      │
│  Marketing + Dashboard + Device Auth UI                     │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS REST
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    pakalon-backend                          │
│  FastAPI · PostgreSQL · Redis · Supabase JWT                │
│  Auth / Billing / Models / Telemetry                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    pakalon-cli                              │
│  TypeScript · Bun · Ink TUI · Zustand · Drizzle ORM        │
│                                                             │
│  Chat mode → streams to OpenRouter                          │
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

In this mode, Pakalon operates as a standard AI chat interface:

| Feature | Description |
|---------|-------------|
| **Chat Mode** | Interactive streaming AI conversation |
| **Plan Mode** | Switch to planning mode (`/plan`) |
| **Edit Mode** | Switch to code editing mode (`/edit`) |
| **Auto-accept Mode** | All tool calls automatically accepted |
| **Bypass Mode** | YOLO mode - AI handles everything |

**Use Cases:**
- Quick code generation and editing
- Exploring codebases
- Getting explanations and suggestions
- One-off tasks and experiments

### When Pakalon-Agents is Initialized (Agent Mode)

Initialize with `/pakalon` command to enable the full 6-phase build pipeline:

```bash
pakalon
/pakalon "Build a SaaS dashboard with Next.js and PostgreSQL"
```

**Phase Structure:**

| Phase | Name | Description |
|-------|------|-------------|
| 1 | Planning & Requirements | Research, Q&A, plan files, context management |
| 2 | Wireframes | Penpot wireframes, TDD verification |
| 3 | Development | Frontend + Backend + Integration (5 sub-agents) |
| 4 | Testing & QA | SAST/DAST security scanning (5 sub-agents) |
| 5 | Deployment | CI/CD, GitHub Actions, PR creation |
| 6 | Documentation | API docs, README, CHANGELOG |


---

## Installation Options

### Cloud Version (Recommended)

```bash
# Install globally
npm install -g pakalon

# Or with bun
bun install -g pakalon

# Start the application
pakalon
```

**Requirements:** Node.js 20+ or Bun 1.0+

### Self-Hosted Version

For users who want to run Pakalon locally without cloud dependencies:

```bash
# Clone the repository
git clone https://github.com/pakalon/pakalon.git
cd pakalon

# Setup backend (optional - for full features)
cd pakalon-backend
cp .env.example .env
# Edit .env with your credentials
docker compose up -d
uv venv && uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000

# Setup web interface (optional - for dashboard)
cd ../pakalon-web
pnpm install
pnpm dev

# Build and run CLI (required)
cd ../pakalon-cli
bun install
bun run build
bun run start
```

**Self-Hosted Features:**
- Connect to local Ollama/LM Studio models
- No cloud authentication required
- Full offline capability
- Custom API endpoints
- Pure TypeScript - no Python required for CLI

### Local Model Support

Pakalon supports local LLM models via Ollama and LM Studio:

```bash
# Start Ollama (default: http://localhost:11434)
ollama serve

# Start LM Studio (default: http://localhost:1234)
# Start the LM Studio application

# List available local models
pakalon local-models

# Check provider status
pakalon local-models status

# Set default local model
pakalon local-models set-default ollama:llama3
```

---

## Features

### Core Features

| Feature | Description |
|---------|-------------|
| **AI Chat** | Streaming AI conversation with model selection |
| **Code Editing** | Real-time code generation and modification |
| **Plan Mode** | Planning and architecture discussions |
| **Undo** | Revert code changes with `/undo` |
| **Sessions** | Save and resume conversations |
| **Multi-session** | Run multiple sessions simultaneously |
| **Voice Input** | Voice-to-text transcription |
| **Context Window** | Token usage tracking and optimization |

### Agent Features

| Feature | Description |
|---------|-------------|
| **6-Phase Pipeline** | Autonomous build from planning to deployment |
| **Human-in-Loop** | Approval checkpoints at each phase |
| **YOLO Mode** | Fully autonomous - no user intervention |
| **Sub-agents** | Specialized agents for frontend, backend, testing |
| **Auditor** | Code review and quality assurance |
| **Security Scanning** | SAST/DAST with 15+ tools |
| **CI/CD** | GitHub Actions workflow generation |
| **Documentation** | Auto-generated API docs and README |

### Integration Features

| Feature | Description |
|---------|-------------|
| **Penpot** | Wireframe design and sync |
| **Figma** | Import Figma designs |
| **Telegram** | Connect via Telegram bot |
| **MCP Servers** | Model Context Protocol integration |
| **Browser Automation** | Playwright and Chrome DevTools |
| **Web Scraping** | Firecrawl and agent browser |

### Billing & Models

| Feature | Description |
|---------|-------------|
| **Free Tier** | 30 days full access, then free models only |
| **Pro Plan** | Access to all models, pay-per-use |
| **OpenRouter** | 550+ AI models available |
| **Auto Model Selection** | Automatic model optimization |
| **Token Tracking** | Usage analytics and cost management |

---

## Commands Reference

### Top-Level Commands

```bash
pakalon [message]              # Start interactive chat
pakalon --version              # Show version
pakalon --help                 # Show help
pakalon login                  # Authenticate (device code flow)
pakalon logout                 # Remove credentials
pakalon doctor                 # System requirements check
pakalon install                # Install dependencies
pakalon init                   # Initialize .pakalon/ config
pakalon /pakalon <prompt>      # Launch 6-phase agentic builder
```

### Slash Commands (Inside Chat)

| Command | Description |
|---------|-------------|
| `/pakalon` | Initialize agent mode |
| `/plan` | Switch to Plan mode |
| `/edit` | Switch to Edit mode |
| `/undo` | Undo last code change |
| `/compact` | Compact conversation context |
| `/clear` | Clear chat history |
| `/sessions` | Browse saved sessions |
| `/resume` | Resume previous session |
| `/new` | Create new session |
| `/models` | List available models |
| `/agents` | Manage agent teams |
| `/penpot` | Open Penpot design tool |
| `/connect` | Connect Telegram bot |
| `/auditor` | Run code audit |
| `/update` | Apply design changes |
| `/ans` | Q&A without interrupting agent |
| `/multi-session` | Manage multiple sessions |
| `/local-models` | Manage local LLM models |
| `/automations` | Manage automation workflows |
| `/help` | Show available commands |
| `/exit` or `q` | Quit |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+C` | Cancel stream / Quit |
| `Ctrl+U` | Clear input |
| `Ctrl+O` | Toggle verbose panel |
| `Tab` | Cycle through modes (Chat / Plan / Edit) |
| `↑ / ↓` | Browse input history |

---

## Configuration

### Environment Variables

```bash
# Backend
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
DATABASE_URL=your_database_url
JWT_SECRET=your_jwt_secret
OPENROUTER_MASTER_KEY=your_openrouter_key

# Optional
PENPOT_HOST=http://localhost:3449
PENPOT_API_TOKEN=your_penpot_token
```

### Configuration Files

```
~/.config/pakalon/
├── storage.json          # Authentication tokens
├── settings.json         # User preferences
├── telegram.json         # Telegram bot config
├── local-models.json     # Local model settings
└── debug.log             # Debug logs (if enabled)
```

### Project Configuration

```
.pakalon/
├── plan.md               # Project context
├── spec.md               # Technical specifications
├── CLAUDE.md             # Agent instructions
├── settings.local.json   # Local permissions
└── phase-N.md            # Phase outputs
```

---

## Security Tools

Pakalon includes 15+ security tools for comprehensive testing:

### Static Analysis (SAST)
- **Semgrep** - Multi-language code scanning
- **Gitleaks** - Secret detection
- **Bandit** - Python security
- **ESLint** - Code quality

### Dynamic Analysis (DAST)
- **OWASP ZAP** - Web application scanner
- **Nikto** - Web server scanner
- **SQLMap** - SQL injection testing
- **Nmap** - Network scanner

```bash
# Run baseline security scans
cd pakalon-cli
docker compose -f docker-compose.security.yml up -d

# Run full security suite
docker compose -f docker-compose.security.yml --profile full up -d
```

---

## Architecture Details

### Authentication Flow

1. User runs `pakalon login`
2. Backend generates 6-digit device code
3. User opens `https://pakalon.com/auth/device`
4. User enters code and signs in with GitHub
5. Backend validates and issues JWT
6. JWT stored in `~/.config/pakalon/storage.json`

### Agent Pipeline (Pure TypeScript)

The entire agent pipeline runs in **pure TypeScript** — no Python required:

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
- **Phase 4**: SAST/DAST security scanning with 15+ tools
- **Phase 5**: GitHub Actions workflows, PR creation
- **Phase 6**: Auto-generated documentation

### Token Management

- **Context Window**: Tracks token usage per session
- **Auto-Compact**: Automatically compacts when nearing limits
- **Budget Allocation**: Tokens allocated per phase with 10% buffer
- **Model Selection**: Automatic model optimization based on task

---

## Deployment

### Docker Deployment

```bash
# Build backend image
cd pakalon-backend
docker build -t pakalon-backend .

# Run with production settings
docker run -d \
  -p 8000:8000 \
  --env-file .env \
  --name pakalon-backend \
  pakalon-backend
```

### Cloud Deployment

```bash
# Deploy to Vercel/Netlify
cd pakalon-web
pnpm build
# Connect repository to Vercel/Netlify

# Deploy backend to AWS/GCP/Azure
docker tag pakalon-backend your-registry/pakalon-backend:latest
docker push your-registry/pakalon-backend:latest
```

### CLI Distribution

```bash
# Build standalone binary
cd pakalon-cli
bun run build

# Publish to npm
npm publish

# Or distribute binary directly
./dist/index.js
```

---

## Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| Bun not found | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| Port 8000 in use | Change port: `--port 8001` |
| Database connection failed | Check PostgreSQL: `docker ps` |
| Missing environment variables | Copy `.env.example` to `.env` |
| Docker not running | Docker only needed for Penpot (Phase 2) |
| Build fails | Run `bun install` then `bun run build` |

### Debug Mode

```bash
# Enable debug logging
pakalon --debug

# View debug log
tail -f ~/.config/pakalon/debug.log
```

### Privacy Mode

```bash
# Enable privacy mode (no data storage)
pakalon --privacy

# Or toggle with Ctrl+P in chat
```

---

## FAQ

**Can I use Pakalon without a Pro plan?**
Yes — free users get 30 days of full access. After that, free models remain accessible.

**How do I use it in CI/CD?**
Set `PAKALON_TOKEN` env var to your JWT, then run `pakalon setup-token` or pass `--token` flag.

**What AI models are supported?**
Pakalon supports 550+ models via OpenRouter, including GPT-4, Claude, Gemini, and local models via Ollama/LM Studio.

**Can I run Pakalon offline?**
Yes — with local models via Ollama/LM Studio, Pakalon works completely offline.

**How do I connect Telegram?**
Run `/connect` in chat, enter your bot token, and Pakalon will bridge to Telegram.

**Is Python required?**
No — Pakalon CLI is built entirely in TypeScript with Bun. No Python installation is needed.

---

## Additional Resources

- **Backend README:** `./pakalon-backend/README.md`
- **CLI README:** `./pakalon-cli/README.md`
- **Web README:** `./pakalon-web/README.md`
- **Penpot Docs:** https://penpot.app/docs
- **FastAPI Docs:** https://fastapi.tiangolo.com/
- **Next.js Docs:** https://nextjs.org/docs

---

<div align="center">
  <img src="pakalon-web/public/assets/Dark_theme_TPBG.png" alt="Pakalon Logo" width="200">
  
  **MIT © Pakalon**
</div>
