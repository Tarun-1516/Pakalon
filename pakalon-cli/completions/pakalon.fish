# Fish completions for pakalon + omp.
# Install: copy to ~/.config/fish/completions/pakalon.fish

# Disable file completions for the message argument
complete -c pakalon -f

# Top-level commands
set -l root_cmds \
    login logout status doctor install init \
    models sessions history agents mcp plugins \
    workflows review review-prs pr triage release \
    fix-issues stats compact setup-token upgrade \
    update help version config prompts completion oauth

for cmd in $root_cmds
    complete -c pakalon -n "__fish_use_subcommand" -a $cmd -d "Pakalon subcommand"
end

# Flags
complete -c pakalon -l agent -s a        -d "Start in agentic mode"
complete -c pakalon -l dir -s d          -d "Working directory" -r -F
complete -c pakalon -l model -s m        -d "Model id"          -r
complete -c pakalon -l permission-mode   -d "Permission mode"   -r -a "hil yolo"
complete -c pakalon -l verbose           -d "Show internal reasoning panel"
complete -c pakalon -l no-banner         -d "Hide ASCII banner"
complete -c pakalon -l session-id        -d "Resume a specific session" -r
complete -c pakalon -l debug             -d "Write debug log"
complete -c pakalon -l privacy           -d "Enable privacy mode"
complete -c pakalon -l json              -d "Machine-readable JSON output"

# Provider list
set -l providers anthropic openai google github-copilot codex openrouter

# login
complete -c pakalon -n "__fish_seen_subcommand_from login" -l provider     -d "Provider" -r -a "$providers"
complete -c pakalon -n "__fish_seen_subcommand_from login" -l no-browser   -d "Print URL only"
complete -c pakalon -n "__fish_seen_subcommand_from login" -l timeout      -d "Timeout (seconds)" -r
complete -c pakalon -n "__fish_seen_subcommand_from login" -l scopes       -d "Extra OAuth scopes" -r

# logout
complete -c pakalon -n "__fish_seen_subcommand_from logout" -a "$providers"

# models subcommands
complete -c pakalon -n "__fish_seen_subcommand_from models" -a "list set refresh status"
set -l models \
    anthropic/claude-opus-4-1 \
    anthropic/claude-sonnet-4-5 \
    anthropic/claude-haiku-4-5 \
    openai/gpt-4.1 \
    openai/gpt-4o \
    openai/o3 \
    openai/o4-mini \
    openai/codex-mini \
    google/gemini-2.5-pro \
    google/gemini-2.0-flash \
    github-copilot/claude-sonnet-4-5 \
    github-copilot/gpt-4o \
    ollama/llama3 \
    lmstudio/qwen2.5-coder
complete -c pakalon -n "__fish_seen_subcommand_from models; and __fish_seen_subcommand_from set" -a "$models"

# agents / mcp / prompts
complete -c pakalon -n "__fish_seen_subcommand_from agents" -a "list create remove show"
complete -c pakalon -n "__fish_seen_subcommand_from mcp"    -a "list add remove discover oauth"
complete -c pakalon -n "__fish_seen_subcommand_from oauth"  -a "list refresh revoke"
complete -c pakalon -n "__fish_seen_subcommand_from prompts" -a "list show render"

# completion target shells
complete -c pakalon -n "__fish_seen_subcommand_from completion" -a "bash zsh fish powershell"

# config / workflows
complete -c pakalon -n "__fish_seen_subcommand_from config"    -a "get set unset reset list"
complete -c pakalon -n "__fish_seen_subcommand_from workflows" -a "list save remove run show"

# omp = alias for pakalon
function __pakalon_complete_omp
    set -l args (commandline -opc)
    set -e args[1]
    set -l cmd "pakalon" $args
    set -l completions (eval $cmd --complete 2>/dev/null)
    for line in $completions
        echo $line
    end
end
complete -c omp -w pakalon
