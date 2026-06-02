/**
 * Per-phase auto-writer content templates for phases 2 through 5.
 *
 * Phase 1 already writes phase-1.md as part of its 12-file generation.
 * Phase 6 writes Doc.md + CHANGELOG.md + phase-6.md.
 *
 * Phases 2–5 used to be silent — this module gives each a structured
 * `phase-N.md` summary that is dropped next to the phase output.
 */
import { writePhase, type PhaseSummary, type PhaseSummarySection } from "./phase-writer.js";

// ---------------------------------------------------------------------------
// Phase 2 — Wireframes
// ---------------------------------------------------------------------------

export interface Phase2SummaryInput {
  projectDir: string;
  penpotProjectId?: string;
  penpotFileId?: string;
  pages: Array<{ name: string; route: string; svgFile: string; tddScore?: number }>;
  designTokens: Record<string, string>;
  approved: boolean;
}

export async function writePhase2Summary(input: Phase2SummaryInput): Promise<string> {
  const sections: PhaseSummarySection[] = [
    {
      heading: "Overview",
      body:
        "Phase 2 produced a Penpot wireframe set covering all major routes. " +
        "Each wireframe was TDD-verified against a generated component test before sign-off.",
    },
    {
      heading: "Penpot Project",
      body: [
        `- Project ID: \`${input.penpotProjectId ?? "n/a"}\``,
        `- File ID: \`${input.penpotFileId ?? "n/a"}\``,
        `- Pages: ${input.pages.length}`,
        `- TDD coverage: ${input.pages.filter((p) => (p.tddScore ?? 0) >= 0.8).length}/${input.pages.length} pages above 80%`,
      ].join("\n"),
    },
    {
      heading: "Pages",
      body:
        input.pages.length === 0
          ? "_No pages were generated._"
          : input.pages
              .map((p) => `- **${p.name}** → \`${p.route}\`  •  svg: \`${p.svgFile}\`  •  TDD: ${p.tddScore ?? "n/a"}`)
              .join("\n"),
    },
    {
      heading: "Design Tokens",
      body: Object.keys(input.designTokens).length === 0
        ? "_No design tokens extracted._"
        : Object.entries(input.designTokens)
            .map(([k, v]) => `- \`${k}\` = \`${v}\``)
            .join("\n"),
    },
    {
      heading: "Approval",
      body: input.approved
        ? "**Approved** by the human-in-loop reviewer."
        : "_Awaiting human review._",
    },
  ];

  const summary: PhaseSummary = {
    phase: 2,
    name: "Wireframes",
    status: input.approved ? "success" : "partial",
    sections,
    metadata: {
      penpotProjectId: input.penpotProjectId,
      penpotFileId: input.penpotFileId,
      pageCount: input.pages.length,
    },
  };
  return writePhase(input.projectDir, summary);
}

// ---------------------------------------------------------------------------
// Phase 3 — Development
// ---------------------------------------------------------------------------

export interface Phase3SummaryInput {
  projectDir: string;
  subAgents: Array<{ name: string; files: number; status: "ok" | "warn" | "fail"; notes?: string }>;
  totalFiles: number;
  totalLines: number;
  stack: Record<string, string>;
  hasOpenPR: boolean;
  prNumber?: number;
}

export async function writePhase3Summary(input: Phase3SummaryInput): Promise<string> {
  const sections: PhaseSummarySection[] = [
    {
      heading: "Overview",
      body:
        `Phase 3 generated ${input.totalFiles} files (${input.totalLines} LOC) across ${input.subAgents.length} sub-agents.`,
    },
    {
      heading: "Sub-agents",
      body:
        input.subAgents.length === 0
          ? "_No sub-agents ran._"
          : input.subAgents
              .map((sa) => `- **${sa.name}** — ${sa.files} files, status: \`${sa.status}\`${sa.notes ? ` — _${sa.notes}_` : ""}`)
              .join("\n"),
    },
    {
      heading: "Stack",
      body: Object.entries(input.stack)
        .map(([k, v]) => `- **${k}**: \`${v}\``)
        .join("\n"),
    },
    {
      heading: "Pull Request",
      body: input.hasOpenPR
        ? `Open PR #${input.prNumber ?? "?"} on the working branch.`
        : "_No PR was opened — the implementation lives on the working branch only._",
    },
  ];
  const summary: PhaseSummary = {
    phase: 3,
    name: "Development",
    status: input.subAgents.some((sa) => sa.status === "fail") ? "partial" : "success",
    sections,
    metadata: {
      totalFiles: input.totalFiles,
      totalLines: input.totalLines,
      subAgentCount: input.subAgents.length,
    },
  };
  return writePhase(input.projectDir, summary);
}

// ---------------------------------------------------------------------------
// Phase 4 — Testing & QA
// ---------------------------------------------------------------------------

export interface Phase4SummaryInput {
  projectDir: string;
  sast: Array<{ tool: string; findings: number; severity: Record<string, number> }>;
  dast: Array<{ tool: string; findings: number; severity: Record<string, number> }>;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  screenshots: number;
  recorders: number;
}

export async function writePhase4Summary(input: Phase4SummaryInput): Promise<string> {
  const totalFindings =
    input.sast.reduce((s, t) => s + t.findings, 0) +
    input.dast.reduce((s, t) => s + t.findings, 0);

  const sections: PhaseSummarySection[] = [
    {
      heading: "Overview",
      body:
        `Phase 4 ran ${input.sast.length} SAST + ${input.dast.length} DAST tools, ` +
        `executed ${input.testsRun} tests (${input.testsPassed} passed, ${input.testsFailed} failed), ` +
        `captured ${input.screenshots} screenshots and ${input.recorders} recorders.`,
    },
    {
      heading: "SAST Findings",
      body: input.sast.length === 0
        ? "_No static analysis tools were run._"
        : input.sast
            .map((t) => `- **${t.tool}** — ${t.findings} findings (${Object.entries(t.severity).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`)
            .join("\n"),
    },
    {
      heading: "DAST Findings",
      body: input.dast.length === 0
        ? "_No dynamic analysis tools were run._"
        : input.dast
            .map((t) => `- **${t.tool}** — ${t.findings} findings (${Object.entries(t.severity).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`)
            .join("\n"),
    },
    {
      heading: "Test Suite",
      body: `- Total: **${input.testsRun}**\n- Passed: **${input.testsPassed}**\n- Failed: **${input.testsFailed}**`,
    },
  ];
  const summary: PhaseSummary = {
    phase: 4,
    name: "Testing & QA",
    status: input.testsFailed > 0 || totalFindings > 0 ? "partial" : "success",
    sections,
    metadata: {
      sastCount: input.sast.length,
      dastCount: input.dast.length,
      totalFindings,
      screenshots: input.screenshots,
      recorders: input.recorders,
    },
  };
  return writePhase(input.projectDir, summary);
}

// ---------------------------------------------------------------------------
// Phase 5 — Deployment & CI/CD
// ---------------------------------------------------------------------------

export interface Phase5SummaryInput {
  projectDir: string;
  target: "vercel" | "netlify" | "aws" | "gcp" | "azure" | "selfhost";
  ciWorkflowPath: string;
  deploymentUrl?: string;
  prCreated: boolean;
  prNumber?: number;
  prUrl?: string;
  environment: string;
}

export async function writePhase5Summary(input: Phase5SummaryInput): Promise<string> {
  const sections: PhaseSummarySection[] = [
    {
      heading: "Overview",
      body: `Phase 5 deployed the application to **${input.target}** and opened a release PR.`,
    },
    {
      heading: "CI Workflow",
      body: `Generated at \`${input.ciWorkflowPath}\`.`,
    },
    {
      heading: "Deployment",
      body: input.deploymentUrl
        ? `Live at: ${input.deploymentUrl}\n- Environment: \`${input.environment}\``
        : `_Deployment URL not yet available._`,
    },
    {
      heading: "Pull Request",
      body: input.prCreated
        ? `PR #${input.prNumber ?? "?"} opened${input.prUrl ? ` at ${input.prUrl}` : ""}.`
        : "_No PR was created._",
    },
  ];
  const summary: PhaseSummary = {
    phase: 5,
    name: "Deployment & CI/CD",
    status: input.deploymentUrl ? "success" : "partial",
    sections,
    metadata: {
      target: input.target,
      environment: input.environment,
      prCreated: input.prCreated,
    },
  };
  return writePhase(input.projectDir, summary);
}
