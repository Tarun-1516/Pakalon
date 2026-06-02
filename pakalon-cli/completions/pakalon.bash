# bash completion for pakalon + omp                              -*- shell-script -*-
# Install:
#   $PREFIX/share/bash-completion/completions/pakalon
#
# Enable: ensure `bash-completion` is installed and your .bashrc sources it.

_pakalon_root_commands() {
  printf '%s\n' \
    login logout status doctor install init \
    models sessions history agents mcp plugins \
    workflows review review-prs pr triage release \
    fix-issues stats compact setup-token upgrade \
    update help version config prompts completion oauth
}

_pakalon_providers() {
  printf '%s\n' anthropic openai google github-copilot codex openrouter
}

_pakalon_models() {
  printf '%s\n' \
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
}

_pakalon() {
  local cur prev words cword
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    # bash-completion < 2.0 fallback
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  # First word — top-level command
  if [[ $cword -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$(_pakalon_root_commands)" -- "$cur"))
    return 0
  fi

  local sub="${words[1]}"

  # Common flags
  local common_flags="--agent -a --dir -d --model -m --verbose --no-banner --debug --privacy --json --permission-mode"

  case "$sub" in
    login)
      case "$prev" in
        --provider) COMPREPLY=($(compgen -W "$(_pakalon_providers)" -- "$cur")) ;;
        *)          COMPREPLY=($(compgen -W "--provider --no-browser --timeout --scopes" -- "$cur")) ;;
      esac
      ;;
    logout)
      COMPREPLY=($(compgen -W "$(_pakalon_providers)" -- "$cur"))
      ;;
    models)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list set refresh status" -- "$cur"))
      else
        case "${words[2]}" in
          set) COMPREPLY=($(compgen -W "$(_pakalon_models)" -- "$cur")) ;;
        esac
      fi
      ;;
    agents)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list create remove show" -- "$cur"))
      fi
      ;;
    mcp)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list add remove discover oauth" -- "$cur"))
      fi
      ;;
    oauth)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list refresh revoke" -- "$cur"))
      elif [[ $cword -eq 3 ]]; then
        case "${words[2]}" in
          refresh|revoke) COMPREPLY=($(compgen -W "$(_pakalon_providers)" -- "$cur")) ;;
        esac
      fi
      ;;
    prompts)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list show render" -- "$cur"))
      fi
      ;;
    completion)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "bash zsh fish powershell" -- "$cur"))
      fi
      ;;
    config)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "get set unset reset list" -- "$cur"))
      fi
      ;;
    workflows)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list save remove run show" -- "$cur"))
      fi
      ;;
    help)
      COMPREPLY=($(compgen -W "$(_pakalon_root_commands)" -- "$cur"))
      ;;
    *)
      # Default: flags + remaining text
      case "$prev" in
        --model|-m)   COMPREPLY=($(compgen -W "$(_pakalon_models)" -- "$cur")) ;;
        --permission-mode) COMPREPLY=($(compgen -W "hil yolo" -- "$cur")) ;;
        --dir|-d)
          COMPREPLY=($(compgen -d -- "$cur"))
          ;;
        *)            COMPREPLY=($(compgen -W "$common_flags" -- "$cur")) ;;
      esac
      ;;
  esac

  return 0
}

complete -F _pakalon pakalon
complete -F _pakalon omp
