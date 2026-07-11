/**
 * Multi-Agent Status Panel Extension
 *
 * Persistent TUI widget for the multi-agent skill.
 * - Inactive: lists every activatable workflow and its agent branches.
 * - Active: shows the active workflow tree and highlights the current agent.
 *
 * The extension discovers agents/workflows from the skill directory at runtime;
 * it is not tied to the pre-defined Java agents.
 *
 * Load this extension alongside the multi-agent skill:
 *   pi --skill /path/to/multi-agent --extension /path/to/this/file
 *
 * Or add to settings.json:
 *   { "extensions": ["~/.pi/agent/skills/multi-agent/extensions/multi-agent-status-panel.ts"] }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

interface AgentInfo {
  name: string;
  description: string;
  capabilities: string[];
  filePath: string;
  emoji: string;
}

interface AgentNode {
  name: string;
  children: AgentNode[];
}

interface WorkflowInfo {
  name: string;
  description: string;
  agents: string[];
  hierarchy: AgentNode[];
  filePath: string;
}

interface WorkflowModelLock {
  provider: string;
  model: string;
  thinkingLevel?: string;
  lockedAt: string;
}

interface WorkflowState {
  workflow: string | null;
  active: boolean;
  modelLock?: WorkflowModelLock | null;
}

type AgentMode = "primary" | "delegated";
type PanelView = "compact" | "list" | "detail";

const EXTENSION_FILE = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const SKILL_DIR = resolve(dirname(EXTENSION_FILE), "..");
const AGENTS_DIR = join(SKILL_DIR, "agents");
const WORKFLOWS_DIR = join(SKILL_DIR, "workflows");
const LEGACY_ACTIVE_WORKFLOW_FILE = join(SKILL_DIR, ".active-workflow");
const CAPABILITY_REGISTRY_FILE = join(SKILL_DIR, "enforcement", "capability-registry.json");
const FORCED_AGENT = process.env.MULTI_AGENT_AGENT || null;
const FORCED_WORKFLOW = process.env.MULTI_AGENT_WORKFLOW || null;
const FORCED_MODEL_PROVIDER = process.env.MULTI_AGENT_MODEL_PROVIDER || null;
const FORCED_MODEL_ID = process.env.MULTI_AGENT_MODEL_ID || null;
const FORCED_THINKING_LEVEL = process.env.MULTI_AGENT_THINKING_LEVEL || null;
const STATE_SCOPE = (process.env.MULTI_AGENT_STATE_SCOPE || "session").toLowerCase(); // session | project | legacy
const MAX_COMPACT_WORKFLOWS = Number(process.env.MULTI_AGENT_MAX_COMPACT_WORKFLOWS || 6);
const MAX_WIDGET_LINES = Number(process.env.MULTI_AGENT_MAX_WIDGET_LINES || 12);
const WORKFLOW_STATE_ENTRY = "multi-agent-workflow-state";
const TRAJECTORY_SCHEMA_VERSION = "multi-agent-trajectory-v1";
const TRAJECTORY_CAPTURE_LABEL = "raw observable events + sealed SHA-256";

interface CapabilityFileRule {
  pattern: string;
  capability?: string;
  owner: string;
  workflows?: string[];
  allowedOwners?: string[];
  reason?: string;
}

interface CapabilityDenyRule {
  pattern: string;
  workflows?: string[];
  capability?: string;
  reason?: string;
}

interface CapabilityRegistry {
  owners?: Record<string, string>;
  aliases?: Record<string, string>;
  fileRules?: CapabilityFileRule[];
  denyRules?: CapabilityDenyRule[];
  sharedOwnership?: Record<string, Record<string, string>>;
}

interface Classification {
  capability: string;
  owner: string;
  reason: string;
  allowedOwners?: string[];
}

interface DelegateActivity {
  agent: string;
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  lastTool?: string;
  lastTarget?: string;
  readCount: number;
  writeCount: number;
  editCount: number;
  bashCount: number;
  otherCount: number;
  message?: string;
}

interface GitTraceState {
  head: string | null;
  tree: string | null;
  statusPorcelainV2: string | null;
}

interface DelegationTrace {
  traceId: string;
  traceDir: string;
  eventsPath: string;
  metadataPath: string;
  patchPath: string;
  sealPath: string;
  sequence: number;
  previousHash: string;
  startedAt: string;
  initialGit: GitTraceState;
}

interface DelegationTraceResult {
  traceId: string;
  tracePath: string;
  metadataPath: string;
  patchPath: string | null;
  sealPath: string;
  sha256: string;
  eventCount: number;
  complete: boolean;
  changedFiles: AgentFileChange[];
}

interface AgentFileChange {
  path: string;
  status: string;
}

interface AgentRunTrace {
  runId: string;
  traceId: string;
  runDir: string;
  tracePath: string;
  metadataPath: string;
  sealPath: string;
  sequence: number;
  startedAt: string;
  previousHash: string;
  workflow: string | null;
  workspaceId: string;
  agentId: string;
  parentAgentId: string | null;
}

interface AgentRunTraceEventInput {
  type: string;
  [key: string]: unknown;
}

interface MultiAgentTraceEnvelope {
  schemaVersion: "pi-multi-agent-trace-v1";
  runId: string;
  traceId: string;
  workspaceId: string;
  workflow: string | null;
  agentId: string;
  parentAgentId: string | null;
  timestamp: string;
  sequence: number;
  previousHash: string;
  hash?: string;
}

interface AgentRunTraceEvent extends AgentRunTraceEventInput {
  multiAgent: MultiAgentTraceEnvelope;
}

const DEFAULT_EMOJIS: Record<string, string> = {
  "java-planner": "🏗️",
  "java-scaffolder": "📦",
  "java-domain-coder": "🔧",
  "java-infra-coder": "⚙️",
  "java-tester": "🧪",
  documenter: "📝",
  c4model: "🗺️",
};

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function readFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function commandOutput(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.trimEnd();
}

function captureGitTraceState(cwd: string): GitTraceState {
  return {
    head: commandOutput(cwd, ["rev-parse", "HEAD"]),
    tree: commandOutput(cwd, ["rev-parse", "HEAD^{tree}"]),
    statusPorcelainV2: commandOutput(cwd, ["status", "--porcelain=v2", "--untracked-files=all"]),
  };
}

function sanitizeObservableEvent(value: any): any {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item?.type !== "thinking")
      .map((item) => sanitizeObservableEvent(item));
  }
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "thinking" || key === "reasoning" || key === "reasoning_content") continue;
    sanitized[key] = sanitizeObservableEvent(item);
  }
  return sanitized;
}

function isObservableJsonEvent(event: any): boolean {
  return new Set([
    "multi_agent_trace_metadata",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
  ]).has(String(event?.type || ""));
}

function promptVersion(agentFile: string): string | null {
  const content = readFileSync(agentFile, "utf8");
  return content.match(/^Prompt version:\s*(.+?)\.?\s*$/m)?.[1]?.trim() || null;
}

function createDelegationTrace(options: {
  sessionId: string;
  workflow: string | null;
  parentAgent: string | null;
  agent: AgentInfo;
  task: string;
  cwd: string;
  modelLock: WorkflowModelLock | null;
  toolRegistryFingerprint: string;
  parentTraceId: string | null;
}): DelegationTrace {
  const traceId = randomUUID();
  const root = process.env.MULTI_AGENT_TRAJECTORY_DIR || join(homedir(), ".pi", "agent", "trajectories");
  const traceDir = join(root, safePathSegment(options.sessionId), traceId);
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  try { chmodSync(traceDir, 0o700); } catch { /* Best effort on non-POSIX filesystems. */ }

  const eventsPath = join(traceDir, "events.jsonl");
  const metadataPath = join(traceDir, "metadata.json");
  const patchPath = join(traceDir, "worktree.patch");
  const sealPath = join(traceDir, "seal.json");
  writeFileSync(eventsPath, "", { encoding: "utf8", mode: 0o600 });

  const startedAt = new Date().toISOString();
  const initialGit = captureGitTraceState(options.cwd);
  const metadata = {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    captureMode: "RAW_EVENT_STREAM",
    traceId,
    parentTraceId: options.parentTraceId,
    startedAt,
    workflow: options.workflow,
    parentAgent: options.parentAgent,
    agent: options.agent.name,
    promptVersion: promptVersion(options.agent.filePath),
    agentDefinitionSha256: sha256File(options.agent.filePath),
    canonicalTask: options.task,
    canonicalTaskLanguage: "en",
    sourceUserMessageIncluded: false,
    modelLock: options.modelLock,
    toolRegistryFingerprint: options.toolRegistryFingerprint,
    initialGit,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    traceId,
    traceDir,
    eventsPath,
    metadataPath,
    patchPath,
    sealPath,
    sequence: 0,
    previousHash: "0".repeat(64),
    startedAt,
    initialGit,
  };
}

function appendDelegationTraceEvent(trace: DelegationTrace, event: unknown): void {
  const base = {
    sequence: trace.sequence,
    capturedAt: new Date().toISOString(),
    previousHash: trace.previousHash,
    event: sanitizeObservableEvent(event),
  };
  const hash = sha256Text(canonicalJson(base));
  appendFileSync(trace.eventsPath, `${JSON.stringify({ ...base, hash })}\n`, "utf8");
  trace.previousHash = hash;
  trace.sequence++;
}

function parseGitStatusPaths(statusPorcelainV2: string | null): Map<string, string> {
  const changes = new Map<string, string>();
  if (!statusPorcelainV2) return changes;

  for (const line of statusPorcelainV2.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("? ")) {
      changes.set(line.slice(2), "untracked");
      continue;
    }
    if (line.startsWith("! ")) continue;
    if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const path = parts.slice(8).join(" ").trim();
      if (path) changes.set(path, parts[1] || "modified");
      continue;
    }
    if (line.startsWith("2 ")) {
      const tabIndex = line.indexOf("\t");
      const withoutOriginal = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
      const parts = withoutOriginal.split(" ");
      const path = parts.slice(9).join(" ").trim();
      if (path) changes.set(path, parts[1] || "renamed");
      continue;
    }
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ").trim();
      if (path) changes.set(path, "unmerged");
    }
  }

  return changes;
}

function isAgentTraceArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(".ide/agent-runs/");
}

function computeChangedFiles(initialGit: GitTraceState, finalGit: GitTraceState): AgentFileChange[] {
  const initial = parseGitStatusPaths(initialGit.statusPorcelainV2);
  const final = parseGitStatusPaths(finalGit.statusPorcelainV2);
  const changed: AgentFileChange[] = [];

  for (const [path, status] of final.entries()) {
    if (isAgentTraceArtifactPath(path)) continue;
    if (initial.get(path) !== status) changed.push({ path, status });
  }

  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

function sealDelegationTrace(trace: DelegationTrace, cwd: string, exitCode: number, complete: boolean): DelegationTraceResult {
  const finalGit = captureGitTraceState(cwd);
  const changedFiles = computeChangedFiles(trace.initialGit, finalGit);
  const patch = commandOutput(cwd, ["diff", "--binary", "HEAD", "--"]);
  let patchPath: string | null = null;
  let patchSha256: string | null = null;
  if (patch) {
    writeFileSync(trace.patchPath, `${patch}\n`, { encoding: "utf8", mode: 0o600 });
    patchPath = trace.patchPath;
    patchSha256 = sha256File(trace.patchPath);
  }
  const eventsSha256 = sha256File(trace.eventsPath);
  const seal = {
    schemaVersion: "multi-agent-trajectory-seal-v1",
    traceId: trace.traceId,
    startedAt: trace.startedAt,
    sealedAt: new Date().toISOString(),
    complete,
    exitCode,
    eventCount: trace.sequence,
    finalEventHash: trace.previousHash,
    eventsSha256,
    metadataSha256: sha256File(trace.metadataPath),
    patchSha256,
    changedFiles,
    initialGit: trace.initialGit,
    finalGit,
  };
  writeFileSync(trace.sealPath, `${JSON.stringify(seal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    traceId: trace.traceId,
    tracePath: trace.eventsPath,
    metadataPath: trace.metadataPath,
    patchPath,
    sealPath: trace.sealPath,
    sha256: eventsSha256,
    eventCount: trace.sequence,
    complete,
    changedFiles,
  };
}

function truncateForTrace(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}

function workspaceIdForCwd(cwd: string): string {
  return sha256Text(resolve(cwd)).slice(0, 16);
}

function createAgentRunTrace(options: {
  traceId: string;
  workflow: string | null;
  parentAgent: string | null;
  agent: AgentInfo;
  task: string;
  cwd: string;
  rawTracePath: string;
}): AgentRunTrace | null {
  if (process.env.MULTI_AGENT_IDE_TRACE === "0") return null;
  const root = process.env.MULTI_AGENT_IDE_TRACE_DIR || join(options.cwd, ".ide", "agent-runs");
  const runId = options.traceId;
  const runDir = join(root, safePathSegment(runId));
  try {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    try { chmodSync(runDir, 0o700); } catch { /* Best effort on non-POSIX filesystems. */ }
    const tracePath = join(runDir, "trace.jsonl");
    const metadataPath = join(runDir, "metadata.json");
    const sealPath = join(runDir, "seal.json");
    writeFileSync(tracePath, "", { encoding: "utf8", mode: 0o600 });
    const startedAt = new Date().toISOString();
    const metadata = {
      schemaVersion: "ide-agent-run-v1",
      runId,
      traceId: options.traceId,
      workflow: options.workflow,
      workspaceId: workspaceIdForCwd(options.cwd),
      cwd: options.cwd,
      agentId: options.agent.name,
      parentAgentId: options.parentAgent,
      taskPreview: truncateForTrace(options.task, 240),
      taskSha256: sha256Text(options.task),
      rawTrajectoryPath: options.rawTracePath,
      startedAt,
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return {
      runId,
      traceId: options.traceId,
      runDir,
      tracePath,
      metadataPath,
      sealPath,
      sequence: 0,
      previousHash: "0".repeat(64),
      startedAt,
      workflow: options.workflow,
      workspaceId: workspaceIdForCwd(options.cwd),
      agentId: options.agent.name,
      parentAgentId: options.parentAgent,
    };
  } catch {
    return null;
  }
}

function appendAgentRunTraceEvent(trace: AgentRunTrace | null, input: AgentRunTraceEventInput): AgentRunTraceEvent | null {
  if (!trace) return null;
  const sanitizedInput = sanitizeObservableEvent(input) as AgentRunTraceEventInput;
  const envelope: MultiAgentTraceEnvelope = {
    schemaVersion: "pi-multi-agent-trace-v1",
    runId: trace.runId,
    traceId: trace.traceId,
    workspaceId: trace.workspaceId,
    workflow: trace.workflow,
    agentId: trace.agentId,
    parentAgentId: trace.parentAgentId,
    timestamp: new Date().toISOString(),
    sequence: trace.sequence,
    previousHash: trace.previousHash,
  };
  const withoutHash = { ...sanitizedInput, multiAgent: envelope };
  const hash = sha256Text(canonicalJson(withoutHash));
  const event = { ...sanitizedInput, multiAgent: { ...envelope, hash } };
  appendFileSync(trace.tracePath, `${JSON.stringify(event)}\n`, "utf8");
  trace.previousHash = hash;
  trace.sequence++;
  return event;
}

function emitAgentRunTraceEvent(trace: AgentRunTrace | null, onUpdate: ((result: any) => void) | undefined, input: AgentRunTraceEventInput): void {
  const event = appendAgentRunTraceEvent(trace, input);
  if (!event || process.env.MULTI_AGENT_FORWARD_CHILD_EVENTS !== "1") return;
  try {
    onUpdate?.({
      content: [],
      details: { event },
    });
  } catch {
    /* Progress updates are best-effort and must not fail delegation. */
  }
}

function sealAgentRunTrace(trace: AgentRunTrace | null, options: { complete: boolean; exitCode: number; rawTrace: DelegationTraceResult }): void {
  if (!trace) return;
  const seal = {
    schemaVersion: "ide-agent-run-seal-v1",
    runId: trace.runId,
    traceId: trace.traceId,
    startedAt: trace.startedAt,
    sealedAt: new Date().toISOString(),
    complete: options.complete,
    exitCode: options.exitCode,
    eventCount: trace.sequence,
    finalEventHash: trace.previousHash,
    traceSha256: sha256File(trace.tracePath),
    metadataSha256: sha256File(trace.metadataPath),
    rawTrajectory: options.rawTrace,
  };
  writeFileSync(trace.sealPath, `${JSON.stringify(seal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function traceToolName(event: any): string {
  return String(event?.toolName || event?.name || event?.tool?.name || "tool");
}

function traceToolInput(event: any): any {
  return event?.input || event?.args || event?.arguments || {};
}

function toolTarget(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["path", "file_path", "url", "cwd", "agent", "command"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncateForTrace(value, 160);
  }
  if (Array.isArray(input.tool_uses)) return `${input.tool_uses.length} parallel tool use(s)`;
  return undefined;
}

function toolEventMetadata(event: any): Record<string, unknown> {
  const input = traceToolInput(event);
  return {
    toolName: traceToolName(event),
    target: toolTarget(input),
  };
}

function parseScalar(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return "";
  const value = match[1].trim();
  if (value === ">" || value === "|") return "";
  return stripQuotes(value);
}

function getYamlBlock(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.match(new RegExp(`^${key}:\\s*(?:$|\\[|>)`)));
  if (start < 0) return "";

  const out: string[] = [];
  const first = lines[start];
  const inline = first.replace(new RegExp(`^${key}:\\s*`), "").trim();
  if (inline) out.push(inline);

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S[^:]*:\s*/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

function parseList(yaml: string, key: string): string[] {
  const block = getYamlBlock(yaml, key).trim();
  if (!block) return [];

  if (block.startsWith("[") && block.endsWith("]")) {
    return block
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item))
      .filter(Boolean);
  }

  return block
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+)\s*$/)?.[1])
    .filter((item): item is string => Boolean(item))
    .map((item) => stripQuotes(item.replace(/\s+#.*$/, "")))
    .filter(Boolean);
}

function parseHierarchy(yaml: string): AgentNode[] {
  const block = getYamlBlock(yaml, "hierarchy");
  const roots: AgentNode[] = [];
  const stack: Array<{ indent: number; node: AgentNode }> = [];

  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^(\s*)-\s*(?:agent:\s*)?([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/);
    if (!match) continue;

    const indent = match[1].length;
    const node: AgentNode = { name: match[2], children: [] };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.push({ indent, node });
  }

  return roots;
}

function loadAgents(): AgentInfo[] {
  if (!existsSync(AGENTS_DIR)) return [];

  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md") && !file.endsWith("index.md") && file !== "README.md")
    .map((file) => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf8");
      const fm = readFrontmatter(content);
      const filePath = join(AGENTS_DIR, file);
      const name = parseScalar(fm, "name") || basename(file, ".md");
      const description = parseScalar(fm, "description") || "Agent";
      const capabilities = parseList(fm, "capabilities");
      return { name, description, capabilities, filePath, emoji: DEFAULT_EMOJIS[name] || "🤖" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadWorkflows(): WorkflowInfo[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];

  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".md") && !file.endsWith("index.md") && file !== "README.md")
    .map((file) => {
      const filePath = join(WORKFLOWS_DIR, file);
      const content = readFileSync(filePath, "utf8");
      const fm = readFrontmatter(content);
      const name = parseScalar(fm, "name") || basename(file, ".md");
      const description = parseScalar(fm, "description") || "Workflow multi-agent";
      const hierarchy = parseHierarchy(fm);
      const agents = parseList(fm, "agents");
      return { name, description, agents, hierarchy, filePath };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function modelLockFromValues(
  provider: unknown,
  model: unknown,
  thinkingLevel?: unknown,
  lockedAt?: unknown,
): WorkflowModelLock | null {
  if (typeof provider !== "string" || provider.trim().length === 0) return null;
  if (typeof model !== "string" || model.trim().length === 0) return null;
  const lock: WorkflowModelLock = {
    provider: provider.trim(),
    model: model.trim(),
    lockedAt: typeof lockedAt === "string" && lockedAt.trim().length > 0 ? lockedAt.trim() : new Date().toISOString(),
  };
  if (typeof thinkingLevel === "string" && thinkingLevel.trim().length > 0) lock.thinkingLevel = thinkingLevel.trim();
  return lock;
}

function forcedModelLock(): WorkflowModelLock | null {
  return modelLockFromValues(FORCED_MODEL_PROVIDER, FORCED_MODEL_ID, FORCED_THINKING_LEVEL, process.env.MULTI_AGENT_MODEL_LOCKED_AT);
}

function modelLockLabel(lock: WorkflowModelLock | null | undefined): string {
  if (!lock) return "unlocked";
  const thinking = lock.thinkingLevel ? `:${lock.thinkingLevel}` : "";
  return `${lock.provider}/${lock.model}${thinking}`;
}

function readActiveWorkflowFile(filePath: string): WorkflowState | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf8");
  const workflow = content.match(/^workflow:\s*(\S+)/m)?.[1] || null;
  const status = content.match(/^status:\s*(\S+)/m)?.[1] || "inactive";
  const activatedAt = content.match(/^activated_at:\s*(.+)$/m)?.[1];
  const modelLock = modelLockFromValues(
    content.match(/^model_provider:\s*(.+)$/m)?.[1],
    content.match(/^model_id:\s*(.+)$/m)?.[1],
    content.match(/^thinking_level:\s*(.+)$/m)?.[1],
    content.match(/^model_locked_at:\s*(.+)$/m)?.[1] || activatedAt,
  );
  return { workflow, active: status === "active" && Boolean(workflow), modelLock };
}

function projectActiveWorkflowFile(cwd: string): string {
  return join(cwd, ".pi", "multi-agent", "active-workflow.yml");
}

function parseActiveWorkflowFile(cwd: string, sessionState: WorkflowState | null): WorkflowState {
  if (FORCED_WORKFLOW) return { workflow: FORCED_WORKFLOW, active: true, modelLock: forcedModelLock() };
  if (STATE_SCOPE === "session") return sessionState || { workflow: null, active: false, modelLock: null };
  if (STATE_SCOPE === "project") return readActiveWorkflowFile(projectActiveWorkflowFile(cwd)) || { workflow: null, active: false, modelLock: null };
  if (STATE_SCOPE === "legacy") return readActiveWorkflowFile(LEGACY_ACTIVE_WORKFLOW_FILE) || { workflow: null, active: false, modelLock: null };
  return sessionState || { workflow: null, active: false, modelLock: null };
}

function workflowStateFileContent(cwd: string, workflowName: string, modelLock: WorkflowModelLock | null): string {
  const activatedAt = new Date().toISOString();
  const lines = [
    `workflow: ${workflowName}`,
    `project: ${cwd}`,
    `activated_at: ${activatedAt}`,
    "status: active",
  ];
  if (modelLock) {
    lines.push(`model_provider: ${modelLock.provider}`);
    lines.push(`model_id: ${modelLock.model}`);
    if (modelLock.thinkingLevel) lines.push(`thinking_level: ${modelLock.thinkingLevel}`);
    lines.push(`model_locked_at: ${modelLock.lockedAt || activatedAt}`);
  }
  return `${lines.join("\n")}\n`;
}

function persistActiveWorkflow(cwd: string, workflowName: string, modelLock: WorkflowModelLock | null): void {
  if (STATE_SCOPE === "session") return;
  const content = workflowStateFileContent(cwd, workflowName, modelLock);
  if (STATE_SCOPE === "project") {
    const projectFile = projectActiveWorkflowFile(cwd);
    mkdirSync(dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, content, "utf8");
  }
  if (STATE_SCOPE === "legacy") writeFileSync(LEGACY_ACTIVE_WORKFLOW_FILE, content, "utf8");
}

function persistInactiveWorkflow(cwd: string, lastWorkflow: string | null): void {
  if (STATE_SCOPE === "session") return;
  const content = `workflow: ${lastWorkflow || ""}\nproject: ${cwd}\ndeactivated_at: ${new Date().toISOString()}\nstatus: inactive\n`;
  if (STATE_SCOPE === "project") {
    const projectFile = projectActiveWorkflowFile(cwd);
    mkdirSync(dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, content, "utf8");
  }
  if (STATE_SCOPE === "legacy") writeFileSync(LEGACY_ACTIVE_WORKFLOW_FILE, content, "utf8");
}

function mergeCapabilityRegistry(target: CapabilityRegistry, source: CapabilityRegistry): CapabilityRegistry {
  target.owners = { ...(target.owners || {}), ...(source.owners || {}) };
  target.aliases = { ...(target.aliases || {}), ...(source.aliases || {}) };
  target.fileRules = [...(target.fileRules || []), ...(source.fileRules || [])];
  target.denyRules = [...(target.denyRules || []), ...(source.denyRules || [])];
  target.sharedOwnership = { ...(target.sharedOwnership || {}), ...(source.sharedOwnership || {}) };
  return target;
}

function readCapabilityRegistry(filePath: string): CapabilityRegistry {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as CapabilityRegistry;
  } catch {
    return {};
  }
}

function loadCapabilityRegistry(): CapabilityRegistry {
  const merged: CapabilityRegistry = {};
  mergeCapabilityRegistry(merged, readCapabilityRegistry(CAPABILITY_REGISTRY_FILE));

  const packsDir = join(SKILL_DIR, "enforcement", "packs");
  if (existsSync(packsDir)) {
    for (const packName of readdirSync(packsDir).sort()) {
      mergeCapabilityRegistry(merged, readCapabilityRegistry(join(packsDir, packName, "capability-registry.json")));
    }
  }

  return merged;
}

export default function (pi: ExtensionAPI) {
  let agents: AgentInfo[] = [];
  let workflows: WorkflowInfo[] = [];
  let registry: CapabilityRegistry = {};
  let currentCwd = process.cwd();
  let sessionWorkflowState: WorkflowState | null = null;
  let workflowActive = false;
  let activeWorkflowName: string | null = null;
  let activeModelLock: WorkflowModelLock | null = forcedModelLock();
  let currentAgent: string | null = null;
  // Agent that owns the current process turn for enforcement/delegation.
  // currentAgent is allowed to move for UI display while a child is running;
  // executionAgent must remain the parent/orchestrator in the parent process.
  let executionAgent: string | null = null;
  let currentMode: AgentMode | null = null;
  let currentTask: string | null = null;
  let forceWorkflowList = false;
  let panelView: PanelView = "compact";
  let delegateActivity: DelegateActivity | null = null;
  let autoCompactTriggered = false;

  function refreshResources(): void {
    agents = loadAgents();
    workflows = loadWorkflows();
    registry = loadCapabilityRegistry();
  }

  function readSessionWorkflowState(ctx: any): WorkflowState | null {
    const entries = typeof ctx?.sessionManager?.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : typeof ctx?.sessionManager?.getEntries === "function"
        ? ctx.sessionManager.getEntries()
        : [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== WORKFLOW_STATE_ENTRY) continue;
      const data = entry.data || {};
      const workflow = typeof data.workflow === "string" && data.workflow ? data.workflow : null;
      const status = typeof data.status === "string" ? data.status : data.active === true ? "active" : "inactive";
      const rawLock = data.modelLock || {};
      const modelLock = modelLockFromValues(
        rawLock.provider || data.model_provider,
        rawLock.model || rawLock.id || data.model_id,
        rawLock.thinkingLevel || data.thinking_level,
        rawLock.lockedAt || data.model_locked_at || data.updated_at,
      );
      return { workflow, active: status === "active" && Boolean(workflow), modelLock };
    }

    return null;
  }

  function appendSessionWorkflowState(workflow: string | null, status: "active" | "inactive", modelLock: WorkflowModelLock | null = activeModelLock): void {
    if (STATE_SCOPE !== "session") return;
    pi.appendEntry(WORKFLOW_STATE_ENTRY, {
      workflow,
      status,
      project: currentCwd,
      modelLock,
      updated_at: new Date().toISOString(),
    });
    sessionWorkflowState = { workflow, active: status === "active" && Boolean(workflow), modelLock };
  }

  function setCwd(ctx: any): void {
    if (typeof ctx?.cwd === "string" && ctx.cwd) currentCwd = ctx.cwd;
    sessionWorkflowState = readSessionWorkflowState(ctx);
  }

  function getAgent(agentName: string): AgentInfo | undefined {
    return agents.find((agent) => agent.name === agentName);
  }

  function getWorkflow(name: string | null = activeWorkflowName): WorkflowInfo | undefined {
    return workflows.find((workflow) => workflow.name === name);
  }

  function getEmoji(agentName: string): string {
    return getAgent(agentName)?.emoji || DEFAULT_EMOJIS[agentName] || "🤖";
  }

  function agentColor(agentName: string, theme: any): (text: string) => string {
    const emoji = getEmoji(agentName);
    switch (emoji) {
      case "🏗️": return (t: string) => theme.fg("accent", t);
      case "📦": return (t: string) => theme.fg("success", t);
      case "🔧": return (t: string) => theme.fg("warning", t);
      case "⚙️": return (t: string) => theme.fg("muted", t);
      case "🧪": return (t: string) => theme.fg("success", t);
      case "📝": return (t: string) => theme.fg("accent", t);
      case "🗺️": return (t: string) => theme.fg("success", t);
      default: return (t: string) => theme.fg("text", t);
    }
  }

  function walkNodes(nodes: AgentNode[], visitor: (node: AgentNode, parent: AgentNode | null) => void, parent: AgentNode | null = null): void {
    for (const node of nodes) {
      visitor(node, parent);
      walkNodes(node.children, visitor, node);
    }
  }

  function workflowUsesAgent(workflow: WorkflowInfo | undefined, agentName: string): boolean {
    if (!workflow) return false;
    if (workflow.agents.includes(agentName)) return true;

    let found = false;
    walkNodes(workflow.hierarchy, (node) => {
      if (node.name === agentName) found = true;
    });
    return found;
  }

  function isRootAgent(workflow: WorkflowInfo | undefined, agentName: string): boolean {
    return Boolean(workflow?.hierarchy.some((node) => node.name === agentName));
  }

  function primaryAgent(workflow: WorkflowInfo | undefined): string | null {
    return workflow?.hierarchy[0]?.name || workflow?.agents[0] || null;
  }

  function captureModelLock(ctx: any): WorkflowModelLock | null {
    return modelLockFromValues(ctx?.model?.provider, ctx?.model?.id, pi.getThinkingLevel?.(), new Date().toISOString());
  }

  function delegatedModelArgs(): string[] {
    if (!activeModelLock) return [];
    const args: string[] = [];
    if (activeModelLock.provider) args.push("--provider", activeModelLock.provider);
    args.push("--model", activeModelLock.model);
    if (activeModelLock.thinkingLevel) args.push("--thinking", activeModelLock.thinkingLevel);
    return args;
  }

  function currentToolRegistryFingerprint(): string {
    const tools = pi.getAllTools()
      .map((tool: any) => ({
        name: tool.name,
        parameters: tool.parameters,
        sourceInfo: tool.sourceInfo,
      }))
      .sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)));
    return sha256Text(canonicalJson(tools));
  }

  async function applyModelLock(ctx: any): Promise<void> {
    if (!workflowActive || !activeModelLock) return;
    const current = ctx?.model;
    const sameModel = current?.provider === activeModelLock.provider && current?.id === activeModelLock.model;
    if (!sameModel) {
      const lockedModel = ctx?.modelRegistry?.find?.(activeModelLock.provider, activeModelLock.model);
      if (lockedModel) {
        const ok = await pi.setModel(lockedModel);
        if (!ok && ctx?.hasUI) ctx.ui.notify(`Workflow model lock has no available credentials: ${modelLockLabel(activeModelLock)}`, "warning");
      } else if (ctx?.hasUI) ctx.ui.notify(`Workflow model lock not found: ${modelLockLabel(activeModelLock)}`, "warning");
    }
    if (activeModelLock.thinkingLevel) pi.setThinkingLevel(activeModelLock.thinkingLevel as any);
  }

  function refreshActiveStateFromDisk(): void {
    const previousWorkflowName = activeWorkflowName;
    const previousModelLock = activeModelLock;
    const active = parseActiveWorkflowFile(currentCwd, sessionWorkflowState);
    workflowActive = active.active;
    activeWorkflowName = active.active ? active.workflow : null;

    if (!workflowActive) {
      activeModelLock = null;
      currentAgent = null;
      executionAgent = null;
      currentMode = null;
      currentTask = null;
      return;
    }

    if (active.workflow !== previousWorkflowName || !previousModelLock) {
      activeModelLock = active.modelLock || forcedModelLock() || previousModelLock || null;
    } else {
      activeModelLock = previousModelLock;
    }

    const workflow = getWorkflow(activeWorkflowName);
    if (FORCED_AGENT && workflowUsesAgent(workflow, FORCED_AGENT)) {
      currentAgent = FORCED_AGENT;
      executionAgent = FORCED_AGENT;
      currentMode = isRootAgent(workflow, FORCED_AGENT) ? "primary" : "delegated";
      return;
    }

    const primary = primaryAgent(workflow);
    if (!executionAgent || !workflowUsesAgent(workflow, executionAgent)) executionAgent = primary;

    if (!currentAgent || !workflowUsesAgent(workflow, currentAgent)) {
      currentAgent = executionAgent || primary;
      currentMode = currentAgent ? (isRootAgent(workflow, currentAgent) ? "primary" : "delegated") : null;
    }
  }

  function activateWorkflow(workflowName: string, task: string | null = null, modelLock: WorkflowModelLock | null = null): boolean {
    const workflow = getWorkflow(workflowName);
    if (!workflow) return false;

    forceWorkflowList = false;
    workflowActive = true;
    activeWorkflowName = workflow.name;
    activeModelLock = modelLock;
    currentAgent = primaryAgent(workflow);
    executionAgent = currentAgent;
    currentMode = currentAgent ? "primary" : null;
    currentTask = task;
    appendSessionWorkflowState(workflow.name, "active", activeModelLock);
    persistActiveWorkflow(currentCwd, workflow.name, activeModelLock);
    return true;
  }

  function deactivateWorkflow(): void {
    forceWorkflowList = false;
    const lastWorkflow = activeWorkflowName;
    workflowActive = false;
    activeWorkflowName = null;
    activeModelLock = null;
    currentAgent = null;
    executionAgent = null;
    currentMode = null;
    currentTask = null;
    autoCompactTriggered = false;
    appendSessionWorkflowState(lastWorkflow, "inactive", null);
    persistInactiveWorkflow(currentCwd, lastWorkflow);
  }

  function normalizeAgentCandidate(value: string | undefined): string | null {
    if (!value) return null;
    // Strip markdown bold/italic, backticks, quotes, and trailing punctuation
    var cleaned = value
      .replace(/[*_`~]+/g, '')
      .replace(/^['"`\[({<]+/g, '')
      .replace(/[\]})>,.:;]+$/g, '')
      .trim();
    return agents.some((agent) => agent.name === cleaned) ? cleaned : null;
  }

  function detectAgentFromPath(filePath: string | undefined): string | null {
    if (!filePath) return null;
    const stem = basename(filePath.replace(/\\/g, "/")).replace(/\.(?:md|ts|js)$/, "");
    return normalizeAgentCandidate(stem);
  }

  function isReadTool(toolName: string): boolean {
    return toolName === "read" || toolName.endsWith(".read");
  }

  function isDelegateAgentTool(toolName: string | undefined): boolean {
    return Boolean(toolName && (toolName === "delegate_agent" || toolName.endsWith(".delegate_agent")));
  }

  function collectReadPaths(toolName: string, input: any): string[] {
    const paths: string[] = [];

    if (isReadTool(toolName) && input?.path) paths.push(String(input.path));

    if (Array.isArray(input?.tool_uses)) {
      for (const use of input.tool_uses) {
        if (isReadTool(String(use?.recipient_name || use?.toolName || "")) && use?.parameters?.path) {
          paths.push(String(use.parameters.path));
        }
      }
    }

    return paths;
  }

  function setCurrentAgent(agentName: string, task: string | null = null): boolean {
    const workflow = getWorkflow();
    if (!workflowActive || !workflowUsesAgent(workflow, agentName)) return false;

    forceWorkflowList = false;
    currentAgent = agentName;
    currentMode = isRootAgent(workflow, agentName) ? "primary" : "delegated";
    currentTask = task;
    return true;
  }

  function findNode(nodes: AgentNode[], name: string): AgentNode | null {
    for (const node of nodes) {
      if (node.name === name) return node;
      const found = findNode(node.children, name);
      if (found) return found;
    }
    return null;
  }

  function getParentMap(workflow: WorkflowInfo | undefined): Map<string, string | null> {
    const parents = new Map<string, string | null>();
    if (!workflow) return parents;
    const visit = (nodes: AgentNode[], parent: string | null) => {
      for (const node of nodes) {
        parents.set(node.name, parent);
        visit(node.children, node.name);
      }
    };
    visit(workflow.hierarchy, null);
    return parents;
  }

  function isDirectChild(workflow: WorkflowInfo | undefined, parent: string, child: string): boolean {
    return Boolean(findNode(workflow?.hierarchy || [], parent)?.children.some((node) => node.name === child));
  }

  function directChildNames(workflow: WorkflowInfo | undefined, parent: string | null): string[] {
    if (!parent) return [];
    return findNode(workflow?.hierarchy || [], parent)?.children.map((node) => node.name) || [];
  }

  function delegationPath(workflow: WorkflowInfo | undefined, from: string, to: string): string[] {
    const parents = getParentMap(workflow);
    const path = [to];
    let cur = to;
    while (parents.has(cur)) {
      const parent = parents.get(cur);
      if (!parent) break;
      path.unshift(parent);
      if (parent === from) return path;
      cur = parent;
    }
    return path.includes(from) ? path.slice(path.indexOf(from)) : path;
  }

  function activeAgentName(): string | null {
    const workflow = getWorkflow();
    if (FORCED_AGENT && workflowUsesAgent(workflow, FORCED_AGENT)) return FORCED_AGENT;
    return executionAgent || primaryAgent(workflow) || currentAgent;
  }

  function normalizeCapability(capability: string): string {
    return registry.aliases?.[capability] || capability;
  }

  function ownerForCapability(capability: string): string | null {
    const canonical = normalizeCapability(capability);
    const fromRegistry = registry.owners?.[canonical];
    if (fromRegistry) return fromRegistry;
    return agents.find((agent) => agent.capabilities.includes(canonical))?.name || null;
  }

  function toProjectRelative(filePath: string): string {
    const absolute = resolve(currentCwd, filePath);
    const rel = relative(currentCwd, absolute).replace(/\\/g, "/");
    return rel.startsWith("..") ? filePath.replace(/\\/g, "/") : rel;
  }

  function globLikeMatch(pattern: string, relPath: string): boolean {
    const compile = (p: string) => {
      const token = "__DOUBLE_STAR__";
      const esc = p
        .replace(/\*\*/g, token)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(new RegExp(token, "g"), ".*");
      return new RegExp(`^${esc}$`);
    };
    if (compile(pattern).test(relPath)) return true;
    if (pattern.startsWith("**/")) return compile(pattern.slice(3)).test(relPath);
    return false;
  }

  function workflowAllowsOwner(owner: string): boolean {
    const workflow = getWorkflow();
    if (!workflowActive || !workflow) return true;
    return workflowUsesAgent(workflow, owner);
  }

  function ruleAppliesToActiveWorkflow(rule: { workflows?: string[] }): boolean {
    if (!rule.workflows?.length) return true;
    return Boolean(activeWorkflowName && rule.workflows.includes(activeWorkflowName));
  }

  function fileRuleSpecificity(pattern: string): number {
    const withoutGlobs = pattern.replace(/\*\*/g, "").replace(/\*/g, "");
    const slashCount = (pattern.match(/\//g) || []).length;
    const literalChars = withoutGlobs.replace(/[{}()[\]\\.+?^$|]/g, "").length;
    return literalChars + slashCount * 8 - (pattern.match(/\*/g) || []).length * 3;
  }

  function sharedAllowedOwners(normalizedPath: string): string[] {
    const shared = registry.sharedOwnership?.[normalizedPath];
    if (!shared) return [];
    const names = new Set<string>();
    for (const value of Object.values(shared)) {
      if (typeof value === "string" && agents.some((agent) => agent.name === value)) names.add(value);
    }
    return Array.from(names);
  }

  function classifyPath(filePath: string): Classification | null {
    const relPath = toProjectRelative(filePath);
    const normalized = relPath.replace(/^\.\//, "");
    const candidates: Array<{ rule: CapabilityFileRule; score: number; workflowOwner: boolean; index: number }> = [];

    (registry.fileRules || []).forEach((rule, index) => {
      if (!ruleAppliesToActiveWorkflow(rule)) return;
      if (!globLikeMatch(rule.pattern, normalized)) return;
      candidates.push({
        rule,
        score: fileRuleSpecificity(rule.pattern),
        workflowOwner: workflowAllowsOwner(rule.owner),
        index,
      });
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a.workflowOwner !== b.workflowOwner) return a.workflowOwner ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.index - b.index;
    });

    const rule = candidates[0].rule;
    const allowedOwners = Array.from(new Set([...(rule.allowedOwners || []), ...sharedAllowedOwners(normalized)]));
    return {
      capability: rule.capability || "file-mutation",
      owner: rule.owner,
      allowedOwners: allowedOwners.length ? allowedOwners : undefined,
      reason: rule.reason || `file rule ${rule.pattern}`,
    };
  }

  function classifyBash(command: string): Classification | null {
    if (/c4model-|structurizr|docs\/c4\//.test(command)) return { capability: "structurizr-export", owner: "c4model", reason: "C4/Structurizr command" };
    return null;
  }

  function cleanShellPathToken(token: string): string | null {
    let cleaned = token.trim().replace(/^['"]|['"]$/g, "");
    cleaned = cleaned.replace(/[;,|&)]*$/g, "");
    if (!cleaned || cleaned.startsWith("-") || cleaned.startsWith("$") || /^[A-Z_][A-Z0-9_]*=/.test(cleaned)) return null;
    if (/^[a-z]+:\/\//i.test(cleaned)) return null;
    if (cleaned === "." || cleaned === ".." || cleaned === "~") return null;
    return cleaned;
  }

  function looksLikeProjectPath(token: string): boolean {
    const base = basename(token.replace(/\\/g, "/"));
    if (token.startsWith("./") || token.startsWith("../") || token.includes("/")) return true;
    if (/^(README|PLAN|Makefile|CMakeLists)\.?(md|txt|json)?$/i.test(base)) return true;
    if (/^(package|pnpm-workspace|tsconfig|CMakePresets|meson\.build)$/i.test(base)) return true;
    return /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm|cu|cuh|hip|metal|java|kt|rs|ts|tsx|js|jsx|vue|svelte|json|yaml|yml|toml|xml|feature|sh|md|adoc|onnx|ort|gguf|safetensors|mlmodel)$/i.test(base);
  }

  function bashMayMutateFiles(command: string): boolean {
    if (/(?:^|\s)(?:>|>>|<>|2>|2>>|&>|&>>)\s*[^\s;&|]+/.test(command)) return true;
    if (/\b(touch|mkdir|rm|rmdir|cp|mv|install|tee|truncate|chmod|chown)\b/.test(command)) return true;
    if (/\b(sed|perl)\b[^\n;|&]*\s-(?:[^\s]*i|[^\s]*pi)\b/.test(command)) return true;
    if (/\b(python3?|node|bun)\b[\s\S]*(writeFile|appendFile|createWriteStream|open\([^)]*["'][wa])/.test(command)) return true;
    return false;
  }

  function extractBashPathCandidates(command: string): string[] {
    const paths = new Set<string>();
    const add = (raw: string | undefined) => {
      if (!raw) return;
      const cleaned = cleanShellPathToken(raw);
      if (cleaned && looksLikeProjectPath(cleaned)) paths.add(cleaned);
    };

    const redirection = /(?:^|\s)(?:>|>>|<>|<|2>|2>>|&>|&>>)\s*([^\s;&|]+)/g;
    let match: RegExpExecArray | null;
    while ((match = redirection.exec(command))) add(match[1]);

    const tokenized = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const pathArgCommands = new Set(["touch", "mkdir", "rm", "rmdir", "cp", "mv", "install", "tee", "truncate", "chmod", "chown"]);
    for (let i = 0; i < tokenized.length; i++) {
      const token = cleanShellPathToken(tokenized[i]);
      if (!token) continue;
      if (pathArgCommands.has(token)) {
        for (let j = i + 1; j < tokenized.length; j++) {
          const next = cleanShellPathToken(tokenized[j]);
          if (!next || next.startsWith("-")) continue;
          if (/^(&&|\|\||;|\|)$/.test(next)) break;
          add(next);
        }
      } else {
        add(token);
      }
    }

    return Array.from(paths);
  }

  function isMutationTool(toolName: string): boolean {
    return ["write", "edit", "bash"].some((name) => toolName === name || toolName.endsWith(`.${name}`));
  }

  function validationForDeniedPath(filePath: string, toolLabel: string): string | null {
    if (!workflowActive || !activeWorkflowName) return null;
    const normalized = toProjectRelative(filePath).replace(/^\.\//, "");

    for (const rule of registry.denyRules || []) {
      if (!ruleAppliesToActiveWorkflow(rule)) continue;
      if (!globLikeMatch(rule.pattern, normalized)) continue;
      return [
        "Multi-agent validation blocked this tool call.",
        `Workflow: ${activeWorkflowName}`,
        `Denied path: ${normalized}`,
        `Capability: ${rule.capability || "workflow-path-deny"}`,
        `Reason: ${rule.reason || `deny rule ${rule.pattern}`}`,
        `Tool: ${toolLabel}`,
      ].join("\n");
    }

    return null;
  }

  function validationForClassification(classification: Classification, toolLabel: string): string | null {
    if (!workflowActive) return null;
    const workflow = getWorkflow();
    if (!workflow) return null;
    if (!workflowUsesAgent(workflow, classification.owner)) return null;
    const agent = activeAgentName();
    if (!agent) return null;
    if (classification.allowedOwners?.includes(agent) || agent === classification.owner) return null;

    const path = delegationPath(workflow, agent, classification.owner).join(" → ");
    return [
      "Multi-agent validation blocked this tool call.",
      `Current agent: ${agent}`,
      `Required owner: ${classification.owner}`,
      `Capability: ${classification.capability}`,
      `Reason: ${classification.reason}`,
      `Tool: ${toolLabel}`,
      `Suggested delegation: ${path || `${agent} → ${classification.owner}`}`,
    ].join("\n");
  }

  function validateToolUse(toolName: string, input: any): string | null {
    if (!workflowActive) return null;
    if (toolName === "multi_tool_use.parallel" || toolName.endsWith(".parallel")) {
      const count = Array.isArray(input?.tool_uses) ? input.tool_uses.length : 0;
      if (count > 1) return "Multi-agent validation blocked parallel tool execution while a workflow is active. Execute delegated work sequentially.";
    }
    if (isDelegateAgentTool(toolName)) return null;

    if (toolName === "write" || toolName.endsWith(".write") || toolName === "edit" || toolName.endsWith(".edit")) {
      const filePath = input?.path;
      if (typeof filePath === "string") {
        const denied = validationForDeniedPath(filePath, `${toolName} ${filePath}`);
        if (denied) return denied;
        const classification = classifyPath(filePath);
        if (classification) return validationForClassification(classification, `${toolName} ${filePath}`);
      }
    }

    if (toolName === "bash" || toolName.endsWith(".bash")) {
      const command = input?.command;
      if (typeof command === "string") {
        const toolLabel = `${toolName} ${command.slice(0, 80)}`;
        if (bashMayMutateFiles(command)) {
          for (const filePath of extractBashPathCandidates(command)) {
            const denied = validationForDeniedPath(filePath, `${toolName} ${filePath}`);
            if (denied) return denied;
            const pathClassification = classifyPath(filePath);
            if (pathClassification) {
              const pathBlock = validationForClassification(pathClassification, `${toolName} ${filePath}`);
              if (pathBlock) return pathBlock;
            }
          }
        }
        const classification = classifyBash(command);
        if (classification) return validationForClassification(classification, toolLabel);
      }
    }

    if (Array.isArray(input?.tool_uses)) {
      for (const use of input.tool_uses) {
        const nested = validateToolUse(String(use?.recipient_name || use?.toolName || ""), use?.parameters || {});
        if (nested) return nested;
      }
    }

    return null;
  }

  function parseStatusFromText(text: string): { agent: string; task: string | null } | null {
    // Strip markdown formatting before matching
    var plain = text.replace(/[*_`~]+/g, '');

    const delegLine = plain.match(/(?:Delegating|Delega|Delego)[:\s]+(\S+)\s*(?:\u2192|->|to|a)\s*(\S+)/i);
    if (delegLine) {
      const delegated = normalizeAgentCandidate(delegLine[2]);
      if (delegated) return { agent: delegated, task: null };
    }

    const delegToLine = plain.match(/(?:Delegating\s+to|Delego\s+a|Delega\s+a)\s+(\S+)/i);
    if (delegToLine) {
      const delegated = normalizeAgentCandidate(delegToLine[1]);
      if (delegated) return { agent: delegated, task: null };
    }

    const backLine = plain.match(/(?:back\s+to|ritorno\s+a)\s*(\S+)/i);
    if (backLine) {
      const parent = normalizeAgentCandidate(backLine[1]);
      if (parent) return { agent: parent, task: null };
    }

    const agentLine = plain.match(/\b(?:AGENT|Agent|agente)\s*:\s*(\S+)/i);
    if (agentLine) {
      const agent = normalizeAgentCandidate(agentLine[1]);
      if (agent) {
        const task = plain.match(/\b(?:TASK|Task|task)\s*:\s*(.+)/)?.[1]?.trim() || null;
        return { agent, task };
      }
    }

    const doneLine = plain.match(/\u2713\s*(\S+)\s*completed/i);
    if (doneLine) {
      const agent = normalizeAgentCandidate(doneLine[1]);
      if (agent) return { agent, task: 'completed' };
    }

    const failLine = plain.match(/\u2717\s*(\S+)\s*FAILED:?\s*(.*)/i);
    if (failLine) {
      const agent = normalizeAgentCandidate(failLine[1]);
      if (agent) return { agent, task: failLine[2] ? `FAILED: ${failLine[2]}` : 'FAILED' };
    }

    for (const agent of agents) {
      const bracket = new RegExp(`\\[${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\\$&")}\\]`);
      if (bracket.test(plain)) return { agent: agent.name, task: null };
    }

    return null;
  }

  function toolResultText(event: any): string {
    const parts: string[] = [];

    if (typeof event.details?.result === "string") parts.push(event.details.result);
    if (typeof event.content === "string") parts.push(event.content);
    if (Array.isArray(event.content)) {
      for (const item of event.content) {
        if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
      }
    }

    return parts.join("\n");
  }

  function messageText(message: any): string {
    if (!message) return "";
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((content: any) => content?.type === "text" && typeof content.text === "string")
      .map((content: any) => content.text)
      .join("\n");
  }

  function renderTree(workflow: WorkflowInfo | undefined, nodes: AgentNode[], theme: any, width: number, prefix = "", root = true): string[] {
    const lines: string[] = [];

    nodes.forEach((node, index) => {
      const isLast = index === nodes.length - 1;
      const connector = root ? "" : isLast ? "└─ " : "├─ ";
      const continuation = root ? "" : isLast ? "   " : "│  ";
      const active = workflowActive && workflow?.name === activeWorkflowName && node.name === currentAgent;
      const role = isRootAgent(workflow, node.name) ? "PRIMARY" : "DELEGATED";
      const color = active ? (t: string) => theme.fg("success", t) : agentColor(node.name, theme);
      const label = `${getEmoji(node.name)} ${node.name}`;
      const suffix = active ? theme.fg("success", `  ← ACTIVE [${role}]`) : theme.fg("dim", `  [${role}]`);

      const line = `${prefix}${connector}${color(label)}${suffix}`;
      lines.push(truncateToWidth(line, width));
      lines.push(...renderTree(workflow, node.children, theme, width, `${prefix}${continuation}`, false));
    });

    return lines;
  }

  function countWorkflowAgents(workflow: WorkflowInfo): number {
    let count = 0;
    if (workflow.hierarchy.length) walkNodes(workflow.hierarchy, () => { count++; });
    return count || workflow.agents.length;
  }

  function currentAgentChain(workflow: WorkflowInfo | undefined): string[] {
    const agent = currentAgent;
    if (!workflow || !agent) return [];
    const parents = getParentMap(workflow);
    const chain = [agent];
    let cur = agent;
    while (parents.has(cur)) {
      const parent = parents.get(cur);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }

  function truncatePanel(lines: string[], theme: any, width: number): string[] {
    if (MAX_WIDGET_LINES <= 0 || lines.length <= MAX_WIDGET_LINES) return lines;
    const visible = Math.max(1, MAX_WIDGET_LINES - 1);
    const omitted = lines.length - visible;
    return [
      ...lines.slice(0, visible),
      truncateToWidth(theme.fg("dim", `  … ${omitted} more line(s). Use /skill:multi-agent detail for full tree.`), width),
    ];
  }

  function workflowSummaryLine(workflow: WorkflowInfo, theme: any, width: number): string {
    const roots = workflow.hierarchy.map((node) => node.name).join(", ") || workflow.agents[0] || "none";
    const count = countWorkflowAgents(workflow);
    const suffix = `${count} agent${count === 1 ? "" : "s"}, root: ${roots}`;
    return truncateToWidth(`${theme.fg("accent", `  ${workflow.name}`)} ${theme.fg("dim", `— ${suffix}`)}`, width);
  }

  function formatElapsed(startedAt?: number, completedAt?: number): string {
    if (!startedAt) return "00:00";
    const seconds = Math.max(0, Math.floor(((completedAt || Date.now()) - startedAt) / 1000));
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function toolTarget(toolName: string, args: any): string {
    const raw = args?.path || args?.file_path || args?.command || args?.pattern || "";
    if (!raw) return toolName;
    const text = String(raw).replace(/\s+/g, " ");
    return text.length > 70 ? `${text.slice(0, 67)}...` : text;
  }

  function noteDelegateToolCall(toolName: string, args: any): void {
    if (!delegateActivity) return;
    delegateActivity.lastTool = toolName;
    delegateActivity.lastTarget = toolTarget(toolName, args);
    if (toolName === "read" || toolName.endsWith(".read")) delegateActivity.readCount++;
    else if (toolName === "write" || toolName.endsWith(".write")) delegateActivity.writeCount++;
    else if (toolName === "edit" || toolName.endsWith(".edit")) delegateActivity.editCount++;
    else if (toolName === "bash" || toolName.endsWith(".bash")) delegateActivity.bashCount++;
    else delegateActivity.otherCount++;
  }

  function buildActivityLines(theme: any, width: number): string[] {
    const lines = [truncateToWidth(theme.fg("accent", "Agent Activity"), width)];
    const activity = delegateActivity;
    if (!activity) {
      lines.push(truncateToWidth(theme.fg("dim", "idle"), width));
      lines.push(truncateToWidth(theme.fg("dim", "delegated agent activity appears here"), width));
      return lines;
    }

    const statusColor = activity.status === "running" ? "warning" : activity.status === "completed" ? "success" : activity.status === "failed" ? "error" : "dim";
    lines.push(truncateToWidth(`${agentColor(activity.agent, theme)(`${getEmoji(activity.agent)} ${activity.agent}`)} ${theme.fg(statusColor, activity.status)}`, width));
    lines.push(truncateToWidth(theme.fg("dim", `read ${activity.readCount} • write ${activity.writeCount} • edit ${activity.editCount} • bash ${activity.bashCount} • other ${activity.otherCount}`), width));
    if (activity.lastTool) lines.push(truncateToWidth(`${theme.fg("dim", "last:")} ${theme.fg("accent", activity.lastTool)} ${theme.fg("dim", activity.lastTarget || "")}`, width));
    lines.push(truncateToWidth(theme.fg("dim", `elapsed ${formatElapsed(activity.startedAt, activity.completedAt)}`), width));
    if (activity.message) lines.push(truncateToWidth(theme.fg(activity.status === "failed" ? "error" : "dim", activity.message), width));
    return lines;
  }

  function padAnsi(text: string, width: number): string {
    const truncated = truncateToWidth(text, width, "");
    const pad = Math.max(0, width - visibleWidth(truncated));
    return truncated + " ".repeat(pad);
  }

  function combineColumns(left: string[], right: string[], theme: any, width: number): string[] {
    if (width < 96) return [...left, ...right.map((line) => truncateToWidth(line, width))];
    const gap = theme.fg("dim", " │ ");
    const leftWidth = Math.max(40, Math.floor((width - 3) * 0.58));
    const rightWidth = Math.max(20, width - leftWidth - 3);
    const rows = Math.max(left.length, right.length);
    const out: string[] = [];
    for (let i = 0; i < rows; i++) {
      out.push(`${padAnsi(left[i] || "", leftWidth)}${gap}${truncateToWidth(right[i] || "", rightWidth)}`);
    }
    return out;
  }

  function buildStatusLines(theme: any, width: number): string[] {
    const view: PanelView = forceWorkflowList ? "list" : panelView;

    if (workflowActive && view !== "list") {
      const workflow = getWorkflow();
      const workflowName = workflow?.name || activeWorkflowName || "unknown";
      const task = currentTask ? theme.fg("dim", ` — ${currentTask}`) : "";
      const model = activeModelLock ? theme.fg("dim", ` | model: ${modelLockLabel(activeModelLock)}`) : "";
      const chain = currentAgentChain(workflow);
      const activeLabel = chain.length ? chain.join(" → ") : currentAgent || "unknown";
      const lines = [
        truncateToWidth(`${theme.fg("success", "● Multi-Agent")} ${theme.fg("accent", workflowName)} ${theme.fg("dim", "| active:")} ${theme.fg("success", activeLabel)}${model}${task}`, width),
      ];

      if (view === "compact") {
        lines.push(truncateToWidth(theme.fg("dim", `  ${countWorkflowAgents(workflow || { name: "", description: "", agents: [], hierarchy: [], filePath: "" })} agents • /skill:multi-agent detail for tree • /skill:multi-agent list for workflows`), width));
        return lines;
      }

      lines.push(truncateToWidth(`${theme.fg("dim", "  training capture:")} ${theme.fg("success", "enabled")} ${theme.fg("dim", `(${TRAJECTORY_SCHEMA_VERSION}; ${TRAJECTORY_CAPTURE_LABEL})`)}`, width));
      lines.push(truncateToWidth(theme.fg("dim", `  trajectory root: ${process.env.MULTI_AGENT_TRAJECTORY_DIR || join(homedir(), ".pi", "agent", "trajectories")}`), width));

      if (workflow?.hierarchy.length) lines.push(...renderTree(workflow, workflow.hierarchy, theme, width, "  "));
      else if (workflow?.agents.length) {
        for (const agent of workflow.agents) {
          const active = agent === currentAgent;
          const color = active ? (t: string) => theme.fg("success", t) : agentColor(agent, theme);
          lines.push(truncateToWidth(`  ${color(`${getEmoji(agent)} ${agent}`)}${active ? theme.fg("success", "  ← ACTIVE") : ""}`, width));
        }
      } else {
        lines.push(truncateToWidth(theme.fg("warning", "  Workflow has no defined agents"), width));
      }

      return view === "detail" ? lines : truncatePanel(lines, theme, width);
    }

    const lines = workflowActive && view === "list"
      ? [
          truncateToWidth(`${theme.fg("success", "● Multi-Agent")} ${theme.fg("accent", activeWorkflowName || "unknown")} ${theme.fg("dim", `— ${workflows.length} workflow(s) installed`)}`, width),
          truncateToWidth(theme.fg("dim", "  /skill:multi-agent status returns to compact view; /skill:multi-agent detail shows active tree"), width),
        ]
      : [
          truncateToWidth(`${theme.fg("dim", "○ Multi-Agent: no active workflow")} ${theme.fg("dim", `— ${workflows.length} workflow(s) installed`)}`, width),
          truncateToWidth(theme.fg("dim", "  Activate with: /skill:multi-agent activate <workflow> • /skill:multi-agent list for all"), width),
        ];

    if (workflows.length === 0) {
      lines.push(truncateToWidth(theme.fg("warning", "  No workflow found in workflows/"), width));
      return lines;
    }

    if (view === "compact") {
      const shown = workflows.slice(0, MAX_COMPACT_WORKFLOWS).map((workflow) => workflow.name);
      const rest = workflows.length - shown.length;
      const suffix = rest > 0 ? `, … +${rest}` : "";
      lines.push(truncateToWidth(`${theme.fg("dim", "  Workflows:")} ${theme.fg("accent", shown.join(", "))}${theme.fg("dim", suffix)}`, width));
      return lines;
    }

    for (const workflow of workflows) {
      lines.push(workflowSummaryLine(workflow, theme, width));
      if (view === "detail") {
        if (workflow.hierarchy.length) lines.push(...renderTree(workflow, workflow.hierarchy, theme, width, "    "));
        else if (workflow.agents.length) lines.push(truncateToWidth(theme.fg("dim", `    agents: ${workflow.agents.join(", ")}`), width));
        else lines.push(truncateToWidth(theme.fg("warning", "    no agents defined"), width));
      }
    }

    return truncatePanel(lines, theme, width);
  }

  function buildLines(theme: any, width: number): string[] {
    if (width >= 96) {
      const leftWidth = Math.max(40, Math.floor((width - 3) * 0.58));
      const rightWidth = Math.max(20, width - leftWidth - 3);
      return combineColumns(buildStatusLines(theme, leftWidth), buildActivityLines(theme, rightWidth), theme, width);
    }
    return [...buildStatusLines(theme, width), ...buildActivityLines(theme, width)];
  }

  function updateWidget(ctx: any): void {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget("multi-agent-status", (_tui: any, theme: any) => ({
      render: (width: number) => buildLines(theme, width),
      invalidate: () => {},
    }), { placement: "belowEditor" });
  }

  function refreshAndUpdate(ctx: any): void {
    setCwd(ctx);
    refreshResources();
    refreshActiveStateFromDisk();
    updateWidget(ctx);
  }

  function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    if (currentScript && existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }
    const executable = basename(process.execPath).toLowerCase();
    if (/^(node|bun)(\.exe)?$/.test(executable)) return { command: "pi", args };
    return { command: process.execPath, args };
  }

  async function runDelegatedAgent(agentName: string, task: string, cwd: string, parentAgent: string | null, signal: AbortSignal | undefined, onUpdate: ((result: any) => void) | undefined, ctx: any): Promise<{ output: string; stderr: string; exitCode: number; trace: DelegationTraceResult }> {
    const agent = getAgent(agentName);
    if (!agent) throw new Error(`Unknown delegated agent: ${agentName}`);

    const trace = createDelegationTrace({
      sessionId: String(ctx?.sessionManager?.getSessionId?.() || "ephemeral"),
      workflow: activeWorkflowName,
      parentAgent,
      agent,
      task,
      cwd,
      modelLock: activeModelLock,
      toolRegistryFingerprint: currentToolRegistryFingerprint(),
      parentTraceId: process.env.MULTI_AGENT_TRACE_ID || null,
    });

    const agentRunTrace = createAgentRunTrace({
      traceId: trace.traceId,
      workflow: activeWorkflowName,
      parentAgent,
      agent,
      task,
      cwd,
      rawTracePath: trace.eventsPath,
    });

    emitAgentRunTraceEvent(agentRunTrace, onUpdate, {
      type: "tool_execution_start",
      toolCallId: `delegate_agent:${trace.traceId}`,
      toolName: "delegate_agent",
      args: {
        agent: agentName,
        cwd,
        taskPreview: truncateForTrace(task, 240),
        taskSha256: sha256Text(task),
      },
    });

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      ...delegatedModelArgs(),
      "--skill", SKILL_DIR,
      "--extension", EXTENSION_FILE,
      "--append-system-prompt", agent.filePath,
      `Delegated agent: ${agentName}\n\nTask:\n${task}`,
    ];

    const invocation = getPiInvocation(args);
    return await new Promise((resolvePromise, reject) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        env: {
          ...process.env,
          MULTI_AGENT_AGENT: agentName,
          MULTI_AGENT_PARENT: parentAgent || "",
          MULTI_AGENT_WORKFLOW: activeWorkflowName || "",
          MULTI_AGENT_MODEL_PROVIDER: activeModelLock?.provider || "",
          MULTI_AGENT_MODEL_ID: activeModelLock?.model || "",
          MULTI_AGENT_THINKING_LEVEL: activeModelLock?.thinkingLevel || "",
          MULTI_AGENT_MODEL_LOCKED_AT: activeModelLock?.lockedAt || "",
          MULTI_AGENT_TRACE_ID: trace.traceId,
          MULTI_AGENT_TRACE_PATH: trace.eventsPath,
          MULTI_AGENT_TRACE_METADATA_PATH: trace.metadataPath,
          MULTI_AGENT_TRACE_EMIT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let finalOutput = "";
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (isObservableJsonEvent(event)) {
            appendDelegationTraceEvent(trace, event);
            if (event.type !== "multi_agent_trace_metadata") emitAgentRunTraceEvent(agentRunTrace, onUpdate, event);
          }
          if (event.type === "tool_call") {
            emitAgentRunTraceEvent(agentRunTrace, onUpdate, {
              type: "tool_execution_start",
              toolCallId: String(event.toolCallId || event.id || `${trace.traceId}:${trace.sequence}`),
              toolName: traceToolName(event),
              args: traceToolInput(event),
            });
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = Array.isArray(event.message.content) ? event.message.content : [];
            for (const part of content) {
              if (part?.type === "toolCall") noteDelegateToolCall(String(part.name || "tool"), part.arguments || {});
            }
            const text = content.find((part: any) => part?.type === "text")?.text;
            if (typeof text === "string") finalOutput = text;
            if (ctx?.hasUI) updateWidget(ctx);
          }
          if (event.type === "tool_call" || event.type === "tool_execution_start") {
            noteDelegateToolCall(String(event.toolName || event.name || "tool"), event.input || event.args || {});
            if (ctx?.hasUI) updateWidget(ctx);
          }
        } catch {
          /* Ignore non-JSON output. */
        }
      };

      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        // Prevent RangeError: Invalid string length by capping accumulators.
        if (stdout.length > 500_000) {
          stdout = stdout.slice(-250_000) + text.slice(-250_000);
        } else {
          stdout += text;
        }
        buffer += text;
        if (buffer.length > 500_000) {
          buffer = buffer.slice(-500_000);
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (chunk) => {
        const t = chunk.toString();
        appendDelegationTraceEvent(trace, { type: "process_stderr", text: t });
        if (stderr.length > 500_000) {
          stderr = stderr.slice(-250_000) + t.slice(-250_000);
        } else {
          stderr += t;
        }
      });
      let settled = false;
      proc.on("error", (error) => {
        if (settled) return;
        settled = true;
        appendDelegationTraceEvent(trace, { type: "process_error", message: error.message });
        const sealedTrace = sealDelegationTrace(trace, cwd, -1, false);
        emitAgentRunTraceEvent(agentRunTrace, onUpdate, {
          type: "tool_execution_end",
          toolCallId: `delegate_agent:${trace.traceId}`,
          toolName: "delegate_agent",
          result: {
            content: [],
            details: { trace: sealedTrace, errorMessage: error.message },
          },
          isError: true,
        });
        sealAgentRunTrace(agentRunTrace, { complete: false, exitCode: -1, rawTrace: sealedTrace });
        reject(error);
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (buffer.trim()) processLine(buffer);
        const exitCode = code ?? 0;
        appendDelegationTraceEvent(trace, { type: "process_exit", exitCode });
        const sealedTrace = sealDelegationTrace(trace, cwd, exitCode, exitCode === 0);
        emitAgentRunTraceEvent(agentRunTrace, onUpdate, {
          type: "tool_execution_end",
          toolCallId: `delegate_agent:${trace.traceId}`,
          toolName: "delegate_agent",
          result: {
            content: [],
            details: {
              trace: sealedTrace,
              exitCode,
              changedFiles: sealedTrace.changedFiles,
            },
          },
          isError: exitCode !== 0,
        });
        sealAgentRunTrace(agentRunTrace, { complete: exitCode === 0, exitCode, rawTrace: sealedTrace });
        resolvePromise({ output: finalOutput || stdout.trim() || "(no output)", stderr, exitCode, trace: sealedTrace });
      });

      const abort = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  pi.registerTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: "Delegate work to a direct child agent from the active multi-agent workflow. Runs the child in an isolated pi process and preserves sequential execution.",
    promptSnippet: "Delegate work to a direct child agent in the active multi-agent workflow.",
    promptGuidelines: [
      "Use delegate_agent whenever the active multi-agent workflow says a child agent owns the task capability.",
      "delegate_agent may only target direct children of the current workflow agent; delegate through intermediate agents for deeper tasks.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Direct child agent to invoke" }),
      task: Type.String({ description: "Task description for the delegated agent" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the delegated pi process" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      setCwd(ctx);
      refreshResources();
      refreshActiveStateFromDisk();
      const workflow = getWorkflow();
      const from = activeAgentName() || primaryAgent(workflow);

      if (workflowActive && workflow && from) {
        if (!workflowUsesAgent(workflow, params.agent)) throw new Error(`Agent ${params.agent} is not part of workflow ${workflow.name}.`);
        if (!isDirectChild(workflow, from, params.agent)) {
          const path = delegationPath(workflow, from, params.agent).join(" → ");
          const children = directChildNames(workflow, from);
          const childList = children.length ? children.join(", ") : "none (leaf agent)";
          throw new Error(`Invalid delegation: ${from} can delegate only to direct children (${childList}). Use path: ${path || `${from} → ${params.agent}`}. If ${from} is a leaf agent, return a handoff request to the parent instead of delegating to siblings.`);
        }
      }

      const parentAgent = from || executionAgent || primaryAgent(workflow);
      const restoreParentAgent = () => {
        if (parentAgent && setCurrentAgent(parentAgent)) return;
        refreshActiveStateFromDisk();
      };

      setCurrentAgent(params.agent, params.task.slice(0, 80));
      delegateActivity = {
        agent: params.agent,
        status: "running",
        startedAt: Date.now(),
        readCount: 0,
        writeCount: 0,
        editCount: 0,
        bashCount: 0,
        otherCount: 0,
        message: params.task.slice(0, 90),
      };
      updateWidget(ctx);

      let result: { output: string; stderr: string; exitCode: number; trace: DelegationTraceResult };
      try {
        result = await runDelegatedAgent(params.agent, params.task, params.cwd || ctx.cwd || currentCwd, parentAgent, signal, onUpdate, ctx);
      } catch (error) {
        restoreParentAgent();
        if (delegateActivity) {
          delegateActivity.status = "failed";
          delegateActivity.completedAt = Date.now();
          delegateActivity.message = error instanceof Error ? error.message : String(error);
          updateWidget(ctx);
        }
        throw error;
      }
      restoreParentAgent();

      if (result.exitCode !== 0) {
        if (delegateActivity) {
          delegateActivity.status = "failed";
          delegateActivity.completedAt = Date.now();
          delegateActivity.message = result.stderr || result.output;
          updateWidget(ctx);
        }
        throw new Error(`Delegated agent ${params.agent} failed with exit code ${result.exitCode}: ${result.stderr || result.output}`);
      }
      if (delegateActivity) {
        delegateActivity.status = "completed";
        delegateActivity.completedAt = Date.now();
        delegateActivity.message = "completed";
        updateWidget(ctx);
      }
      return {
        content: [{ type: "text", text: result.output }],
        details: { agent: params.agent, parentAgent, task: params.task, stderr: result.stderr, exitCode: result.exitCode, trace: result.trace },
      };
    },
  });

  // ── Commands exposed through the documented /skill:multi-agent syntax ──

  pi.on("input", async (event, ctx) => {
    setCwd(ctx);
    const match = event.text.trim().match(/^\/skill:multi-agent(?:\s+(\S+))?(?:\s+(.+))?$/);
    if (!match) return { action: "continue" as const };

    const command = match[1] || "status";
    const args = (match[2] || "").trim();
    refreshResources();
    refreshActiveStateFromDisk();

    if (command === "activate") {
      if (!args) {
        ctx.ui.notify("Usage: /skill:multi-agent activate <workflow>", "error");
        return { action: "handled" as const };
      }
      const modelLock = captureModelLock(ctx);
      if (!activateWorkflow(args, "activated", modelLock)) {
        ctx.ui.notify(`Workflow not found: ${args}`, "error");
        updateWidget(ctx);
        return { action: "handled" as const };
      }
      ctx.ui.notify(`Active workflow: ${args} • model locked: ${modelLockLabel(modelLock)}`, "info");
      updateWidget(ctx);
      return { action: "continue" as const };
    }

    if (command === "deactivate") {
      deactivateWorkflow();
      ctx.ui.notify("Multi-agent workflow deactivated", "info");
      updateWidget(ctx);
      return { action: "handled" as const };
    }

    if (command === "list") {
      forceWorkflowList = true;
      panelView = "list";
      updateWidget(ctx);
      ctx.ui.notify(`${workflows.length} workflows available`, "info");
      return { action: "handled" as const };
    }

    if (command === "detail" || command === "expand") {
      forceWorkflowList = false;
      panelView = "detail";
      updateWidget(ctx);
      ctx.ui.notify("Multi-agent panel: detailed view", "info");
      return { action: "handled" as const };
    }

    if (command === "compact" || command === "status") {
      forceWorkflowList = false;
      panelView = "compact";
      updateWidget(ctx);
      ctx.ui.notify(workflowActive ? `Active: ${activeWorkflowName} • model locked: ${modelLockLabel(activeModelLock)}` : "No active workflow", "info");
      return { action: "handled" as const };
    }

    ctx.ui.notify(`Unknown multi-agent command: ${command}. Use status, list, detail, compact, activate, or deactivate.`, "error");
    return { action: "handled" as const };
  });

  // ── Lifecycle hooks ──

  pi.on("session_start", async (_event, ctx) => {
    refreshAndUpdate(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    setCwd(ctx);
    refreshResources();
    refreshActiveStateFromDisk();

    if (process.env.MULTI_AGENT_TRACE_EMIT === "1" && ctx.mode === "json") {
      const runtimeFingerprint = {
        type: "multi_agent_trace_metadata",
        traceId: process.env.MULTI_AGENT_TRACE_ID || null,
        capturedAt: new Date().toISOString(),
        systemPromptSha256: sha256Text(event.systemPrompt),
        toolRegistryFingerprint: currentToolRegistryFingerprint(),
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        thinkingLevel: pi.getThinkingLevel?.() || null,
        cwdSha256: sha256Text(ctx.cwd || currentCwd),
      };
      process.stdout.write(`${JSON.stringify(runtimeFingerprint)}\n`);
    }

    if (workflowActive) {
      await applyModelLock(ctx);
      forceWorkflowList = false;
      const workflow = getWorkflow();
      const primary = primaryAgent(workflow);
      if (primary && !FORCED_AGENT) {
        currentAgent = primary;
        executionAgent = primary;
        currentMode = "primary";
        currentTask = typeof event.prompt === "string" ? event.prompt.slice(0, 80) : null;
      }
      const runtimeAgent = activeAgentName() || primary;
      const children = directChildNames(workflow, runtimeAgent);
      updateWidget(ctx);
      // Inject active workflow state into the system prompt so the agent
      // knows the workflow is already active and does not attempt to re-activate.
      const stateNote = `\n\n## Active Workflow State\nWorkflow: ${activeWorkflowName}\nStatus: active\nPrimary agent: ${primary || "unknown"}\nCurrent execution agent: ${runtimeAgent || "unknown"}\nParent agent: ${process.env.MULTI_AGENT_PARENT || "none"}\nWorkflow model lock: ${modelLockLabel(activeModelLock)}\nDirect children for current execution agent: ${children.length ? children.join(", ") : "none"}\nIMPORTANT: This workflow is already active. Do NOT attempt to re-activate it via /skill:multi-agent activate or any other means. Proceed with the workflow phases as defined in the workflow file. delegate_agent may target only the direct children listed above. If the current execution agent has no direct children and work belongs to a sibling or parent, report a handoff request to the parent instead of calling delegate_agent.\n`;
      return { systemPrompt: `${event.systemPrompt}${stateNote}` };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    setCwd(ctx);
    refreshResources();
    refreshActiveStateFromDisk();

    const blockReason = validateToolUse(event.toolName, event.input);
    if (blockReason) return { block: true, reason: blockReason };

    if (!ctx.hasUI) return;
    if (!workflowActive) {
      forceWorkflowList = false;
      updateWidget(ctx);
      return;
    }

    for (const filePath of collectReadPaths(event.toolName, event.input)) {
      const agent = detectAgentFromPath(filePath);
      if (agent && setCurrentAgent(agent)) {
        updateWidget(ctx);
        return;
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    setCwd(ctx);
    if (!ctx.hasUI) return;

    const text = toolResultText(event);

    if (/workflow\s+deactivated|status:\s*inactive/i.test(text)) {
      forceWorkflowList = false;
      workflowActive = false;
      activeWorkflowName = null;
      activeModelLock = null;
      currentAgent = null;
      executionAgent = null;
      currentMode = null;
      currentTask = null;
      autoCompactTriggered = false;
      updateWidget(ctx);
      return;
    }

    refreshResources();
    refreshActiveStateFromDisk();

    if (event.toolName === "write" || event.toolName === "edit" || event.toolName?.endsWith(".write") || event.toolName?.endsWith(".edit")) {
      refreshResources();

      // Auto-compact: detect PLAN.md writes and trigger compaction
      const filePath = typeof event.input?.path === "string" ? event.input.path : "";
      const fileName = basename(filePath.replace(/\\/g, "/"));
      if (workflowActive && (fileName === "PLAN.md" || fileName === "plan.md" || filePath.endsWith("/PLAN.md") || filePath.endsWith("/plan.md"))) {
        if (!autoCompactTriggered) {
          autoCompactTriggered = true;
          ctx.ui.notify("PLAN.md written — triggering auto-compact", "info");
          ctx.compact({
            customInstructions: "Compact session after PLAN.md update for course correction",
          });
        }
      }
    }

    const parsed = parseStatusFromText(text);
    if (parsed && setCurrentAgent(parsed.agent, parsed.task)) updateWidget(ctx);
    else updateWidget(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    setCwd(ctx);
    if (!ctx.hasUI || event.message?.role !== "assistant") return;

    refreshResources();
    refreshActiveStateFromDisk();
    if (!workflowActive) return updateWidget(ctx);

    const parsed = parseStatusFromText(messageText(event.message));
    if (parsed && setCurrentAgent(parsed.agent, parsed.task)) updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("multi-agent-status", undefined);
  });
}
