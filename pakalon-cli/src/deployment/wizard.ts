/**
 * Cloud deployment wizard.
 *
 * CLI-req §"Phase 5" requires an interactive wizard that:
 *   1. Asks the user which cloud (AWS / Azure / GCP / DigitalOcean / None).
 *   2. Collects credentials interactively.
 *   3. Hands off to the provider's deploy() function.
 *
 * The wizard is intentionally small and uses the AskUserQuestionTool
 * for the multi-choice provider selection so it composes with the
 * existing UI.
 */
import { askUserQuestion, type AskUserQuestion } from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import logger from "@/utils/logger.js";

export type CloudProvider = "aws" | "azure" | "gcp" | "digitalocean" | "none";

export interface CloudWizardResult {
  provider: CloudProvider;
  region: string;
  credentials: Record<string, string>;
  skipped: boolean;
}

const PROVIDER_QUESTION: AskUserQuestion = {
  question: "Which cloud provider should host the production deployment?",
  header: "Cloud",
  multiSelect: false,
  options: [
    { label: "AWS", description: "ECS, Fargate, or Lambda" },
    { label: "Azure", description: "App Service or Container Apps" },
    { label: "GCP", description: "Cloud Run or GKE" },
    { label: "DigitalOcean", description: "App Platform or droplets" },
    { label: "Self-hosted", description: "Skip cloud — generate deploy script only" },
  ],
};

const REGION_QUESTION: AskUserQuestion = {
  question: "Which region should the deployment target?",
  header: "Region",
  multiSelect: false,
  options: [
    { label: "us-east-1", description: "N. Virginia (cheapest, fastest cold start)" },
    { label: "us-west-2", description: "Oregon" },
    { label: "eu-west-1", description: "Ireland" },
    { label: "ap-southeast-1", description: "Singapore" },
  ],
};

const REGION_BY_PROVIDER: Record<CloudProvider, AskUserQuestion> = {
  aws: REGION_QUESTION,
  azure: { ...REGION_QUESTION, options: REGION_QUESTION.options.map((o) => ({ ...o, label: o.label.replace("us-east-1", "eastus") })) },
  gcp: { ...REGION_QUESTION, options: REGION_QUESTION.options.map((o) => ({ ...o, label: o.label.replace("us-east-1", "us-central1") })) },
  digitalocean: { ...REGION_QUESTION, options: REGION_QUESTION.options.map((o) => ({ ...o, label: o.label.replace("us-east-1", "nyc3") })) },
  none: REGION_QUESTION,
};

export async function runCloudWizard(projectDir: string, opts: { skip?: boolean } = {}): Promise<CloudWizardResult> {
  if (opts.skip) {
    logger.info("Cloud wizard skipped by flag");
    return { provider: "none", region: "us-east-1", credentials: {}, skipped: true };
  }

  const [providerAnswer] = await askUserQuestion({ questions: [PROVIDER_QUESTION], projectDir });
  const provider = mapProvider(providerAnswer.answer);
  if (provider === "none") {
    return { provider, region: "us-east-1", credentials: {}, skipped: false };
  }

  const [regionAnswer] = await askUserQuestion({ questions: [REGION_BY_PROVIDER[provider]], projectDir });
  const region = regionAnswer.answer;

  const credentials = await collectCredentials(provider);
  return { provider, region, credentials, skipped: false };
}

function mapProvider(answer: string): CloudProvider {
  const lower = answer.toLowerCase();
  if (lower.startsWith("aws")) return "aws";
  if (lower.startsWith("azure")) return "azure";
  if (lower.startsWith("gcp")) return "gcp";
  if (lower.startsWith("digital")) return "digitalocean";
  return "none";
}

async function collectCredentials(provider: CloudProvider): Promise<Record<string, string>> {
  const prompts: Record<string, string> = {
    aws: "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (comma-separated)",
    azure: "AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET",
    gcp: "GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)",
    digitalocean: "DIGITALOCEAN_TOKEN",
  };
  const promptText = prompts[provider] ?? "";
  if (!promptText) return {};
  const { default: readline } = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((resolve) => rl.question(`${promptText}\n> `, (a) => resolve(a.trim())));
  rl.close();
  const out: Record<string, string> = {};
  for (const pair of ans.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/** Hand off to the provider-specific deploy() function. */
export async function deployToCloud(projectDir: string, result: CloudWizardResult): Promise<string> {
  if (result.provider === "none") {
    return "Skipped — no provider selected.";
  }
  const mod = await import(`./${result.provider}.js`).catch(() => null);
  if (!mod || typeof mod.deploy !== "function") {
    logger.warn({ provider: result.provider }, "Provider module not found — emitting instructions only");
    return `No deploy() implemented for ${result.provider}. Use the credentials in your CI environment.`;
  }
  return mod.deploy({ projectDir, region: result.region, credentials: result.credentials });
}
