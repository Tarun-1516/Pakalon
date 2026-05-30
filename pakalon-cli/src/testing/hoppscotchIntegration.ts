/**
 * Hoppscotch API Testing Integration
 *
 * Integrates Hoppscotch for automated API testing via agent browser.
 * This allows the security testing phase to perform API vulnerability
 * testing using Hoppscotch's capabilities.
 *
 * Strategy:
 * 1. Launch Hoppscotch in agent browser
 * 2. Import API collections
 * 3. Execute test collections
 * 4. Capture results and vulnerabilities
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HoppscotchOptions {
  /** Hoppscotch URL (default: https://hoppscotch.io) */
  baseUrl?: string;
  /** API endpoint to test */
  targetUrl: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Whether to run in headless mode (default: true) */
  headless?: boolean;
  /** Additional headers for requests */
  headers?: Record<string, string>;
  /** Collections to test */
  collections?: HoppscotchCollection[];
}

export interface HoppscotchCollection {
  /** Collection name */
  name: string;
  /** Collection requests */
  requests: HoppscotchRequest[];
}

export interface HoppscotchRequest {
  /** Request name */
  name: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Request URL (can include environment variables) */
  url: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body */
  body?: string | Record<string, unknown>;
  /** Expected status code */
  expectedStatus?: number;
  /** Test scripts */
  testScript?: string;
  /** Pre-request scripts */
  preRequestScript?: string;
}

export interface HoppscotchTestResult {
  /** Request name */
  requestName: string;
  /** HTTP method */
  method: string;
  /** Request URL */
  url: string;
  /** Response status code */
  statusCode: number;
  /** Response time in ms */
  responseTime: number;
  /** Whether test passed */
  passed: boolean;
  /** Test output */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Vulnerabilities detected */
  vulnerabilities: Vulnerability[];
}

export interface Vulnerability {
  /** Vulnerability type */
  type: 'sqli' | 'xss' | 'csrf' | 'idor' | 'auth' | 'info' | 'other';
  /** Vulnerability description */
  description: string;
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Evidence of vulnerability */
  evidence?: string;
  /** Remediation suggestion */
  remediation?: string;
}

export interface HoppscotchTestSuite {
  /** Suite name */
  name: string;
  /** Target URL */
  targetUrl: string;
  /** Test results */
  results: HoppscotchTestResult[];
  /** Summary */
  summary: {
    total: number;
    passed: number;
    failed: number;
    vulnerabilities: number;
  };
  /** Execution time in ms */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Collection Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a basic API test collection for common endpoints.
 */
export function buildBasicApiCollection(
  baseUrl: string,
  endpoints: string[] = []
): HoppscotchCollection {
  const requests: HoppscotchRequest[] = [];

  // Add health check
  requests.push({
    name: 'Health Check',
    method: 'GET',
    url: `${baseUrl}/health`,
    expectedStatus: 200,
  });

  // Add common API endpoints
  const commonEndpoints = [
    { path: '/api', method: 'GET' as const, name: 'API Root' },
    { path: '/api/v1', method: 'GET' as const, name: 'API v1 Root' },
    { path: '/api/docs', method: 'GET' as const, name: 'API Docs' },
    { path: '/api/swagger.json', method: 'GET' as const, name: 'Swagger Spec' },
  ];

  for (const endpoint of commonEndpoints) {
    requests.push({
      name: endpoint.name,
      method: endpoint.method,
      url: `${baseUrl}${endpoint.path}`,
      expectedStatus: 200,
    });
  }

  // Add custom endpoints
  for (const endpoint of endpoints) {
    requests.push({
      name: `Custom: ${endpoint}`,
      method: 'GET',
      url: `${baseUrl}${endpoint}`,
    });
  }

  return {
    name: 'Basic API Tests',
    requests,
  };
}

/**
 * Build a security-focused test collection.
 */
export function buildSecurityTestCollection(baseUrl: string): HoppscotchCollection {
  const requests: HoppscotchRequest[] = [];

  // SQL Injection tests
  const sqliPayloads = ["' OR '1'='1", "1; DROP TABLE users--", "' UNION SELECT * FROM users--"];

  for (const payload of sqliPayloads) {
    requests.push({
      name: `SQLi Test: ${payload.substring(0, 20)}...`,
      method: 'GET',
      url: `${baseUrl}/api/search?q=${encodeURIComponent(payload)}`,
      testScript: `
        pm.test("No SQL error in response", function() {
          const response = pm.response.text();
          pm.expect(response).to.not.include("sql");
          pm.expect(response).to.not.include("syntax error");
          pm.expect(response).to.not.include("mysql");
          pm.expect(response).to.not.include("postgresql");
        });
      `,
    });
  }

  // XSS tests
  const xssPayloads = ['<script>alert("xss")</script>', '<img src="x" onerror="alert(1)">', 'javascript:alert(1)'];

  for (const payload of xssPayloads) {
    requests.push({
      name: `XSS Test: ${payload.substring(0, 20)}...`,
      method: 'GET',
      url: `${baseUrl}/api/search?q=${encodeURIComponent(payload)}`,
      testScript: `
        pm.test("No XSS in response", function() {
          const response = pm.response.text();
          pm.expect(response).to.not.include("<script>");
          pm.expect(response).to.not.include("onerror");
          pm.expect(response).to.not.include("javascript:");
        });
      `,
    });
  }

  // Authentication tests
  requests.push({
    name: 'Auth: No Token',
    method: 'GET',
    url: `${baseUrl}/api/protected`,
    expectedStatus: 401,
  });

  requests.push({
    name: 'Auth: Invalid Token',
    method: 'GET',
    url: `${baseUrl}/api/protected`,
    headers: {
      Authorization: 'Bearer invalid_token_12345',
    },
    expectedStatus: 401,
  });

  // CORS tests
  requests.push({
    name: 'CORS: Cross-Origin Request',
    method: 'OPTIONS',
    url: `${baseUrl}/api`,
    headers: {
      Origin: 'https://evil.com',
      'Access-Control-Request-Method': 'POST',
    },
    testScript: `
      pm.test("CORS properly configured", function() {
        const allowOrigin = pm.response.headers.get("Access-Control-Allow-Origin");
        pm.expect(allowOrigin).to.not.equal("https://evil.com");
      });
    `,
  });

  return {
    name: 'Security Tests',
    requests,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hoppscotch Executor (Placeholder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a Hoppscotch test suite.
 * This is a placeholder implementation - in production, this would
 * use the agent browser to interact with Hoppscotch.
 */
export async function executeHoppscotchTests(
  options: HoppscotchOptions
): Promise<HoppscotchTestSuite> {
  const startTime = Date.now();

  logger.debug('[Hoppscotch] Starting API tests', {
    targetUrl: options.targetUrl,
    collections: options.collections?.length || 0,
  });

  const results: HoppscotchTestResult[] = [];

  // Build test collections if not provided
  const collections = options.collections || [
    buildBasicApiCollection(options.targetUrl),
    buildSecurityTestCollection(options.targetUrl),
  ];

  // Execute each collection
  for (const collection of collections) {
    for (const request of collection.requests) {
      const result = await executeRequest(request, options);
      results.push(result);
    }
  }

  // Build summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const vulnerabilities = results.reduce(
    (sum, r) => sum + r.vulnerabilities.length,
    0
  );

  const suite: HoppscotchTestSuite = {
    name: 'Hoppscotch API Tests',
    targetUrl: options.targetUrl,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      vulnerabilities,
    },
    durationMs: Date.now() - startTime,
  };

  logger.debug('[Hoppscotch] Tests completed', {
    total: suite.summary.total,
    passed: suite.summary.passed,
    failed: suite.summary.failed,
    vulnerabilities: suite.summary.vulnerabilities,
    durationMs: suite.durationMs,
  });

  return suite;
}

/**
 * Execute a single request (placeholder implementation).
 */
async function executeRequest(
  request: HoppscotchRequest,
  options: HoppscotchOptions
): Promise<HoppscotchTestResult> {
  const startTime = Date.now();

  try {
    // Build request options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: {
        ...options.headers,
        ...request.headers,
      },
    };

    if (request.body) {
      fetchOptions.body = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);
    }

    // Execute request
    const response = await fetch(request.url, fetchOptions);
    const statusCode = response.status;
    const responseTime = Date.now() - startTime;

    // Check if test passed
    const passed = request.expectedStatus
      ? statusCode === request.expectedStatus
      : statusCode >= 200 && statusCode < 300;

    // Detect vulnerabilities
    const vulnerabilities = await detectVulnerabilities(response, request);

    return {
      requestName: request.name,
      method: request.method,
      url: request.url,
      statusCode,
      responseTime,
      passed,
      output: `Status: ${statusCode}, Time: ${responseTime}ms`,
      vulnerabilities,
    };
  } catch (error) {
    return {
      requestName: request.name,
      method: request.method,
      url: request.url,
      statusCode: 0,
      responseTime: Date.now() - startTime,
      passed: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
      vulnerabilities: [],
    };
  }
}

/**
 * Detect vulnerabilities in response.
 */
async function detectVulnerabilities(
  response: Response,
  request: HoppscotchRequest
): Promise<Vulnerability[]> {
  const vulnerabilities: Vulnerability[] = [];

  try {
    const text = await response.text();

    // Check for SQL errors
    const sqlErrors = [
      'sql syntax',
      'mysql',
      'postgresql',
      'sqlite',
      'ORA-',
      'Microsoft OLE DB',
    ];

    for (const error of sqlErrors) {
      if (text.toLowerCase().includes(error.toLowerCase())) {
        vulnerabilities.push({
          type: 'sqli',
          description: `SQL error detected in response: ${error}`,
          severity: 'high',
          evidence: text.substring(0, 200),
          remediation: 'Use parameterized queries and input validation',
        });
        break;
      }
    }

    // Check for XSS
    if (text.includes('<script>') || text.includes('onerror=')) {
      vulnerabilities.push({
        type: 'xss',
        description: 'Potential XSS vulnerability detected',
        severity: 'medium',
        evidence: text.substring(0, 200),
        remediation: 'Sanitize user input and use Content Security Policy',
      });
    }

    // Check for information disclosure
    const infoPatterns = [
      'stack trace',
      'debug',
      'internal server error',
      'password',
      'secret',
      'api_key',
    ];

    for (const pattern of infoPatterns) {
      if (text.toLowerCase().includes(pattern)) {
        vulnerabilities.push({
          type: 'info',
          description: `Information disclosure detected: ${pattern}`,
          severity: 'low',
          evidence: text.substring(0, 200),
          remediation: 'Remove sensitive information from production responses',
        });
        break;
      }
    }
  } catch {
    // Response body not available
  }

  return vulnerabilities;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create Hoppscotch test options.
 */
export function createHoppscotchOptions(
  targetUrl: string,
  options: Partial<HoppscotchOptions> = {}
): HoppscotchOptions {
  return {
    targetUrl,
    baseUrl: 'https://hoppscotch.io',
    timeout: 30000,
    headless: true,
    ...options,
  };
}

export default executeHoppscotchTests;