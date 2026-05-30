/**
 * Bash Command Arity Dictionary
 *
 * Maps command prefixes to their arity (number of tokens that define the command).
 * Used for permission evaluation to identify the "human-understandable command" from
 * input shell commands.
 *
 * Pattern: "command" → arity (number of tokens)
 * Flags NEVER count as tokens. Only subcommands count.
 * Longest matching prefix wins.
 *
 * Ported from opencode's permission/arity.ts for parity.
 */

const ARITY: Record<string, number> = {
  // Basic commands
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,

  // Cloud CLIs
  aws: 3, // aws s3 ls
  az: 3, // az storage blob list

  // Build tools
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,

  // Container CLIs
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,

  // Git
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,

  // Go
  go: 2,
  gradle: 2,

  // Kubernetes
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,

  // Make
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,

  // Node.js
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  nvm: 2,
  nx: 2,

  // OpenSSL
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,

  // Python
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  pyenv: 2,
  python: 2,

  // Ruby
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,

  // Serverless
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,

  // System
  systemctl: 2,

  // Infrastructure
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,

  // JavaScript
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}

/**
 * Extract the command prefix from a bash command string.
 * Returns the tokens that define the command (excluding flags and arguments).
 *
 * @param command - The bash command string
 * @returns The command prefix tokens
 *
 * @example
 * extractCommandPrefix("git checkout main") // ["git", "checkout"]
 * extractCommandPrefix("npm run dev --verbose") // ["npm", "run"]
 * extractCommandPrefix("ls -la /tmp") // ["ls"]
 * extractCommandPrefix("docker compose up -d") // ["docker", "compose"]
 */
export function extractCommandPrefix(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter(t => !t.startsWith('-'))
  return prefix(tokens)
}

/**
 * Get the arity for a command prefix.
 * Returns the number of tokens that define the command.
 *
 * @param tokens - The command tokens
 * @returns The arity (number of tokens that define the command)
 */
export function prefix(tokens: string[]): string[] {
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ")
    const arity = ARITY[prefix]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)
}

/**
 * Get the human-readable command name from a bash command string.
 *
 * @param command - The bash command string
 * @returns The command name (e.g., "git", "npm run", "docker compose")
 *
 * @example
 * getCommandName("git checkout main") // "git"
 * getCommandName("npm run dev") // "npm run"
 * getCommandName("docker compose up -d") // "docker compose"
 */
export function getCommandName(command: string): string {
  return extractCommandPrefix(command).join(" ")
}

/**
 * Check if a command matches a pattern.
 * Supports wildcards (*) in the pattern.
 *
 * @param pattern - The pattern to match (e.g., "git *", "npm run *")
 * @param command - The command to check
 * @returns Whether the command matches the pattern
 *
 * @example
 * matchesCommandPattern("git *", "git checkout main") // true
 * matchesCommandPattern("npm run *", "npm run dev") // true
 * matchesCommandPattern("docker *", "docker compose up") // true
 */
export function matchesCommandPattern(pattern: string, command: string): boolean {
  const patternTokens = pattern.split(/\s+/)
  const commandTokens = command.trim().split(/\s+/)

  for (let i = 0; i < patternTokens.length; i++) {
    const patternToken = patternTokens[i]
    if (patternToken === '*') continue
    if (i >= commandTokens.length) return false
    if (patternToken !== commandTokens[i]) return false
  }

  return true
}

/**
 * Get all supported commands.
 * Useful for documentation and testing.
 *
 * @returns Array of supported command prefixes
 */
export function getSupportedCommands(): string[] {
  return Object.keys(ARITY).sort()
}

/**
 * Get the arity for a specific command.
 *
 * @param command - The command prefix (e.g., "git", "npm run")
 * @returns The arity, or undefined if not found
 *
 * @example
 * getArity("git") // 2
 * getArity("npm run") // 3
 * getArity("unknown") // undefined
 */
export function getArity(command: string): number | undefined {
  return ARITY[command]
}

export * as BashArity from "./bashArity.js"
