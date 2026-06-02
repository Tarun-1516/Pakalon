# PowerShell completion for the Pakalon CLI.
# Install: .pakalon.ps1
#
# Use in your $PROFILE:
#   . "$env:USERPROFILE\.local\completions\pakalon.ps1"

using namespace System.Management.Automation
using namespace System.Management.Automation.Language

Register-ArgumentCompleter -Native -CommandName 'pakalon', 'omp' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $completions = @(
        switch -Regex ($commandAst.CommandElements) {
            # ─── subcommand completion ───────────────────────────────────
            '^\S+$' {
                # First word → root commands
                $commands = @(
                    'login', 'logout', 'status', 'doctor', 'install', 'init',
                    'models', 'sessions', 'history', 'agents', 'mcp', 'plugins',
                    'workflows', 'review', 'review-prs', 'pr', 'triage', 'release',
                    'fix-issues', 'stats', 'compact', 'setup-token', 'upgrade',
                    'update', 'help', 'version', 'config', 'prompts', 'completion',
                    'oauth'
                )
                $commands |
                    Where-Object { $_ -like "$wordToComplete*" } |
                    ForEach-Object {
                        [CompletionResult]::new($_, $_, 'ParameterName', $_)
                    }
                break
            }

            # ─── `login` ────────────────────────────────────────────────
            'login' {
                if ($wordToComplete -like '-*') {
                    '--provider', '--no-browser', '--timeout', '--scopes' |
                        Where-Object { $_ -like "$wordToComplete*" } |
                        ForEach-Object {
                            [CompletionResult]::new($_, $_, 'ParameterName', $_)
                        }
                } else {
                    'anthropic', 'openai', 'google', 'github-copilot', 'codex', 'openrouter' |
                        Where-Object { $_ -like "$wordToComplete*" } |
                        ForEach-Object {
                            [CompletionResult]::new($_, $_, 'ParameterValue', "OAuth provider: $_")
                        }
                }
                break
            }

            # ─── `logout` ───────────────────────────────────────────────
            'logout' {
                'anthropic', 'openai', 'google', 'github-copilot', 'codex', 'openrouter' |
                    Where-Object { $_ -like "$wordToComplete*" } |
                    ForEach-Object {
                        [CompletionResult]::new($_, $_, 'ParameterValue', "OAuth provider: $_")
                    }
                break
            }

            # ─── `models` ───────────────────────────────────────────────
            'models' {
                if ($commandAst.CommandElements[-1] -like '-*' -or $commandAst.CommandElements.Count -lt 3) {
                    'list', 'set', 'refresh', 'status' |
                        Where-Object { $_ -like "$wordToComplete*" } |
                        ForEach-Object {
                            [CompletionResult]::new($_, $_, 'ParameterValue', "models $_")
                        }
                } elseif ($commandAst.CommandElements[-2] -eq 'set') {
                    @(
                        'anthropic/claude-opus-4-1', 'anthropic/claude-sonnet-4-5',
                        'anthropic/claude-haiku-4-5', 'openai/gpt-4.1', 'openai/gpt-4o',
                        'openai/o3', 'openai/o4-mini', 'openai/codex-mini',
                        'google/gemini-2.5-pro', 'google/gemini-2.0-flash',
                        'github-copilot/claude-sonnet-4-5', 'github-copilot/gpt-4o',
                        'ollama/llama3', 'lmstudio/qwen2.5-coder'
                    ) | Where-Object { $_ -like "$wordToComplete*" } |
                    ForEach-Object {
                        [CompletionResult]::new($_, $_, 'ParameterValue', "model $_")
                    }
                }
                break
            }

            # ─── `mcp` / `agents` / `oauth` / `prompts` ────────────────
            'mcp'     { 'list','add','remove','discover','oauth' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "mcp $_") } ; break }
            'agents'  { 'list','create','remove','show'         | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "agents $_") } ; break }
            'oauth'   { 'list','refresh','revoke'               | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "oauth $_") } ; break }
            'prompts' { 'list','show','render'                  | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "prompts $_") } ; break }

            # ─── `completion` ───────────────────────────────────────────
            'completion' {
                'bash', 'zsh', 'fish', 'powershell' |
                    Where-Object { $_ -like "$wordToComplete*" } |
                    ForEach-Object {
                        [CompletionResult]::new($_, $_, 'ParameterValue', "shell: $_")
                    }
                break
            }

            # ─── `config` / `workflows` ─────────────────────────────────
            'config'    { 'get','set','unset','reset','list'   | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "config $_") } ; break }
            'workflows' { 'list','save','remove','run','show'  | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [CompletionResult]::new($_, $_, 'ParameterValue', "workflows $_") } ; break }

            # ─── default flags ──────────────────────────────────────────
            default {
                $flags = @(
                    '--agent', '-a',
                    '--dir', '-d',
                    '--model', '-m',
                    '--permission-mode',
                    '--verbose',
                    '--no-banner',
                    '--session-id',
                    '--debug',
                    '--privacy',
                    '--json'
                )
                $flags | Where-Object { $_ -like "$wordToComplete*" } |
                    ForEach-Object {
                        [CompletionResult]::new($_, $_, 'ParameterName', $_)
                    }
            }
        }
    )

    $completions | Sort-Object -Property ListItemText
}
