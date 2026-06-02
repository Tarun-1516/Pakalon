import type { ChildProcess } from "child_process";

/**
 * Backend type for spawning teammates as OS-level processes.
 */
export type BackendType = "in_process" | "tmux" | "iterm" | "pane";

/**
 * Status of a spawned teammate process.
 */
export type TeammateProcessStatus =
  | "starting"
  | "running"
  | "idle"
  | "busy"
  | "disconnected"
  | "stopped"
  | "error";

/**
 * Information about a spawned teammate process.
 */
export interface TeammateProcessInfo {
  id: string;
  name: string;
  backend: BackendType;
  status: TeammateProcessStatus;
  pid?: number;
  sessionName?: string;
  windowId?: string;
  paneId?: string;
  cwd: string;
  startedAt: number;
  lastHeartbeat?: number;
  error?: string;
}

/**
 * Options for spawning a teammate via a backend.
 */
export interface SpawnTeammateOpts {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  agentType?: string;
  teamName?: string;
  color?: string;
  env?: Record<string, string>;
  cwdLayout?: PaneLayoutConfig;
}

/**
 * Options for sending a message to a teammate process.
 */
export interface SendMessageOpts {
  recipientId: string;
  senderId: string;
  content: string;
  type?: "task" | "message" | "permission_request" | "permission_response" | "shutdown";
}

/**
 * Layout configuration for pane-based backends (tmux, iTerm2, Windows Terminal).
 */
export interface PaneLayoutConfig {
  /** Which position to place the new pane: "right" | "bottom" | "tab" */
  position: "right" | "bottom" | "tab";
  /** Percentage of the window to give the new pane */
  sizePercent?: number;
  /** Target pane/window to split from */
  targetPaneId?: string;
}

/**
 * Reconnection state for a teammate that was disconnected.
 */
export interface ReconnectionState {
  teammateId: string;
  backend: BackendType;
  lastKnownSession?: string;
  lastKnownPid?: number;
  lastKnownCwd: string;
  disconnectedAt: number;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

/**
 * Permission state that gets synchronized across teammates.
 */
export interface PermissionSyncState {
  teammateId: string;
  permissions: string[];
  permissionMode: "hil" | "yolo";
  updatedAt: number;
}

/**
 * Message written to or read from a filesystem mailbox.
 */
export interface MailboxMessage {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  type: "task" | "message" | "permission_request" | "permission_response" | "shutdown" | "status_update";
  timestamp: number;
  read: boolean;
}

/**
 * Interface that all OS-level swarm backends must implement.
 */
export interface SwarmBackend {
  /** Backend identifier */
  readonly backendType: BackendType;

  /** Spawn a new teammate as an OS process */
  spawnTeammate(opts: SpawnTeammateOpts): Promise<TeammateProcessInfo>;

  /** Send a message to a running teammate */
  sendToTeammate(recipientId: string, message: string): Promise<boolean>;

  /** Get the current status of a teammate */
  getTeammateStatus(id: string): TeammateProcessInfo | undefined;

  /** Kill a running teammate process */
  killTeammate(id: string): Promise<boolean>;

  /** List all teammates managed by this backend */
  listTeammates(): TeammateProcessInfo[];

  /** Dispose of the backend and clean up resources */
  dispose(): Promise<void>;
}

/**
 * Layout slot for visual arrangement of teammates.
 */
export interface LayoutSlot {
  teammateId: string;
  row: number;
  col: number;
  width: number;
  height: number;
  window?: string;
  pane?: string;
}

/**
 * Team configuration for a group of teammates.
 */
export interface TeamConfig {
  teamName: string;
  leaderId: string;
  leaderName: string;
  backend: BackendType;
  projectDir: string;
  createdAt: number;
}
