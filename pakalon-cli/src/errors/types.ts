/**
 * Typed Error Hierarchy
 *
 * Base error class and typed subclasses for structured error handling.
 * Each error carries a machine-readable `code` for programmatic handling.
 */

export interface ErrorMetadata {
  [key: string]: unknown;
}

/**
 * Base error class for all pakalon errors.
 */
export class AppError extends Error {
  readonly code: string;
  readonly metadata: ErrorMetadata;
  readonly timestamp: number;

  constructor(
    message: string,
    code: string = 'APP_ERROR',
    metadata: ErrorMetadata = {},
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.metadata = metadata;
    this.timestamp = Date.now();
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Validation error for invalid input/arguments.
 */
export class ValidationError extends AppError {
  readonly field?: string;

  constructor(message: string, field?: string, metadata?: ErrorMetadata) {
    super(message, 'VALIDATION_ERROR', { ...metadata, field });
    this.name = 'ValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Permission error for denied operations.
 */
export class PermissionError extends AppError {
  readonly tool?: string;
  readonly requiredPermission?: string;

  constructor(
    message: string,
    options?: { tool?: string; requiredPermission?: string; metadata?: ErrorMetadata },
  ) {
    super(message, 'PERMISSION_ERROR', { ...options?.metadata, tool: options?.tool, requiredPermission: options?.requiredPermission });
    this.name = 'PermissionError';
    this.tool = options?.tool;
    this.requiredPermission = options?.requiredPermission;
    Object.setPrototypeOf(this, PermissionError.prototype);
  }
}

/**
 * Tool execution error.
 */
export class ToolError extends AppError {
  readonly toolName?: string;

  constructor(
    message: string,
    options?: { toolName?: string; metadata?: ErrorMetadata; cause?: Error },
  ) {
    super(message, 'TOOL_ERROR', { ...options?.metadata, toolName: options?.toolName }, options?.cause);
    this.name = 'ToolError';
    this.toolName = options?.toolName;
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/**
 * Agent execution error.
 */
export class AgentError extends AppError {
  readonly agentType?: string;

  constructor(
    message: string,
    options?: { agentType?: string; metadata?: ErrorMetadata; cause?: Error },
  ) {
    super(message, 'AGENT_ERROR', { ...options?.metadata, agentType: options?.agentType }, options?.cause);
    this.name = 'AgentError';
    this.agentType = options?.agentType;
    Object.setPrototypeOf(this, AgentError.prototype);
  }
}

/**
 * Session error for session-related failures.
 */
export class SessionError extends AppError {
  readonly sessionId?: string;

  constructor(
    message: string,
    options?: { sessionId?: string; metadata?: ErrorMetadata; cause?: Error },
  ) {
    super(message, 'SESSION_ERROR', { ...options?.metadata, sessionId: options?.sessionId }, options?.cause);
    this.name = 'SessionError';
    this.sessionId = options?.sessionId;
    Object.setPrototypeOf(this, SessionError.prototype);
  }
}

/**
 * Configuration error.
 */
export class ConfigError extends AppError {
  readonly configKey?: string;

  constructor(
    message: string,
    options?: { configKey?: string; metadata?: ErrorMetadata; cause?: Error },
  ) {
    super(message, 'CONFIG_ERROR', { ...options?.metadata, configKey: options?.configKey }, options?.cause);
    this.name = 'ConfigError';
    this.configKey = options?.configKey;
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Network/API error.
 */
export class NetworkError extends AppError {
  readonly statusCode?: number;
  readonly url?: string;

  constructor(
    message: string,
    options?: { statusCode?: number; url?: string; metadata?: ErrorMetadata; cause?: Error },
  ) {
    super(message, 'NETWORK_ERROR', { ...options?.metadata, statusCode: options?.statusCode, url: options?.url }, options?.cause);
    this.name = 'NetworkError';
    this.statusCode = options?.statusCode;
    this.url = options?.url;
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * Type guards for error classes.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isPermissionError(error: unknown): error is PermissionError {
  return error instanceof PermissionError;
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

export function isSessionError(error: unknown): error is SessionError {
  return error instanceof SessionError;
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}
