#compdef pakalon omp
# Zsh completion for Pakalon CLI + omp (oh-my-pakalon).
# Install:
#   $PREFIX/share/zsh/site-functions/_pakalon   (system)
#   $ZDOTDIR/completions/_pakalon               (user)
#
# Enable: `autoload -U compinit && compinit` (zsh-newuser-install does this
# by default on most distros).

_pakalon_root_command() {
  local -a commands
  commands=(
    'login:Authenticate with a provider (anthropic/openai/google/github-copilot/codex)'
    'logout:Remove stored credentials'
    'status:Show current auth + plan status'
    'doctor:Check system requirements'
    'install:Install dependencies (shell completion, hook scripts)'
    'init:Initialize .pakalon/ config in the current directory'
    'models:List available models'
    'sessions:List saved sessions'
    'history:Show recent session history'
    'agents:List configured specialist agents'
    'mcp:Manage MCP servers'
    'plugins:Manage installed plugins'
    'workflows:Manage saved prompt workflows'
    'review:Run /review subagent on the working tree'
    'review-prs:Review open PRs in the current repo'
    'pr:Open a PR for the current branch'
    'triage:Auto-triage issues in the current repo'
    'release:Create a release'
    'fix-issues:Auto-fix issues in the current repo'
    'stats:Open the local observability dashboard'
    'compact:Compact conversation context'
    'setup-token:Store JWT from env (CI/CD)'
    'upgrade:Upgrade to Pro plan'
    'update:Update the CLI to latest version'
    'help:Show help for a command'
    'version:Show version'
    'config:Manage CLI config (read/write/reset keys)'
    'prompts:List / show static prompts'
    'completion:Print shell completion script'
    'oauth:Manage OAuth providers (list/refresh/revoke)'
  )
  _describe 'command' commands
}

_pakalon_mode_args() {
  _arguments \
    '--agent[Start in agentic mode]' \
    '-a[Start in agentic mode]' \
    '--dir[Working directory]:dir:_files -/' \
    '-d[Working directory]:dir:_files -/' \
    '--model[Model id]:model:_pakalon_models' \
    '-m[Model id]:model:_pakalon_models' \
    '--permission-mode[Permission mode]:mode:(hil yolo)' \
    '--verbose[Show internal reasoning panel]' \
    '--no-banner[Hide ASCII banner]' \
    '--session-id[Resume a specific session]:id:' \
    '--debug[Write debug log]' \
    '--privacy[Enable privacy mode (no Mem0, no telemetry)]' \
    '--json[Output machine-readable JSON]' \
    '1:message:'
}

_pakalon_models() {
  local -a models
  models=(
    'anthropic/claude-opus-4-1'
    'anthropic/claude-sonnet-4-5'
    'anthropic/claude-haiku-4-5'
    'openai/gpt-4.1'
    'openai/gpt-4o'
    'openai/o3'
    'openai/o4-mini'
    'openai/codex-mini'
    'google/gemini-2.5-pro'
    'google/gemini-2.0-flash'
    'github-copilot/claude-sonnet-4-5'
    'github-copilot/gpt-4o'
    'ollama/llama3'
    'lmstudio/qwen2.5-coder'
  )
  _describe 'model' models
}

_pakalon_login() {
  _arguments \
    '--provider[Provider]:provider:(anthropic openai google github-copilot codex openrouter)' \
    '--no-browser[Print URL instead of opening a browser]' \
    '--timeout[Timeout in seconds]:seconds:' \
    '--scopes[Extra OAuth scopes]:scopes:'
}

_pakalon_models_cmd() {
  local -a subcmds
  subcmds=(
    'list:List available models'
    'set:Set the default model'
    'refresh:Refresh the model catalog'
    'status:Show current model + provider status'
  )
  _describe 'subcommand' subcmds
}

_pakalon_agents() {
  local -a subcmds
  subcmds=(
    'list:List configured specialist agents'
    'create:Create a new specialist agent'
    'remove:Remove an agent'
    'show:Show the definition of an agent'
  )
  _describe 'subcommand' subcmds
}

_pakalon_mcp() {
  local -a subcmds
  subcmds=(
    'list:List active MCP servers'
    'add:Add an MCP server'
    'remove:Remove an MCP server'
    'discover:Discover MCP servers from a registry URL'
    'oauth:Run OAuth flow for an MCP server'
  )
  _describe 'subcommand' subcmds
}

_pakalon_oauth() {
  local -a subcmds
  subcmds=(
    'list:List configured OAuth providers'
    'refresh:Force-refresh the token for a provider'
    'revoke:Revoke the token for a provider'
  )
  _describe 'subcommand' subcmds
}

_pakalon_prompts() {
  local -a subcmds
  subcmds=(
    'list:List available static prompts'
    'show:Show a specific prompt'
    'render:Render a prompt with vars'
  )
  _describe 'subcommand' subcmds
}

_pakalon_completion() {
  local -a shells
  shells=(bash zsh fish powershell)
  _describe 'shell' shells
}

_pakalon() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \
    '1: :->command' \
    '*:: :->args'

  case $state in
    command)
      _pakalon_root_command
      ;;
    args)
      case $words[1] in
        login)      _pakalon_login ;;
        logout)     _arguments '1:provider:(anthropic openai google github-copilot codex openrouter)' ;;
        models)     _pakalon_models_cmd ;;
        agents)     _pakalon_agents ;;
        mcp)        _pakalon_mcp ;;
        oauth)      _pakalon_oauth ;;
        prompts)    _pakalon_prompts ;;
        completion) _pakalon_completion ;;
        config)     _arguments '1:action:(get set unset reset list)' '2:key:' '3:value:' ;;
        workflows)  _arguments '1:action:(list save remove run show)' '2:name:' ;;
        doctor)     _arguments '(--json)' ;;
        install)    _arguments '--no-completions[Skip shell completions]' '--completions-only[Only install completions]' ;;
        status)     _arguments '(--json)' ;;
        help)       _arguments '1:command:_pakalon_root_command' ;;
        *)          _pakalon_mode_args ;;
      esac
      ;;
  esac
}

# Register as `_pakalon` and (as a courtesy) for the `omp` alias.
compdef _pakalon pakalon
compdef _pakalon omp
