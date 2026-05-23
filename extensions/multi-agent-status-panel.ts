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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
const STATE_SCOPE = (process.env.MULTI_AGENT_STATE_SCOPE || "session").toLowerCase(); // session | project | legacy
const MAX_COMPACT_WORKFLOWS = Number(process.env.MULTI_AGENT_MAX_COMPACT_WORKFLOWS || 6);
const MAX_WIDGET_LINES = Number(process.env.MULTI_AGENT_MAX_WIDGET_LINES || 12);
const WORKFLOW_STATE_ENTRY = "multi-agent-workflow-state";

interface CapabilityRegistry {
  owners?: Record<string, string>;
  aliases?: Record<string, string>;
  fileRules?: Array<{ pattern: string; capability?: string; owner: string }>;
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

function readActiveWorkflowFile(filePath: string): { workflow: string | null; active: boolean } | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf8");
  const workflow = content.match(/^workflow:\s*(\S+)/m)?.[1] || null;
  const status = content.match(/^status:\s*(\S+)/m)?.[1] || "inactive";
  return { workflow, active: status === "active" && Boolean(workflow) };
}

function projectActiveWorkflowFile(cwd: string): string {
  return join(cwd, ".pi", "multi-agent", "active-workflow.yml");
}

function parseActiveWorkflowFile(cwd: string, sessionState: { workflow: string | null; active: boolean } | null): { workflow: string | null; active: boolean } {
  if (FORCED_WORKFLOW) return { workflow: FORCED_WORKFLOW, active: true };
  if (STATE_SCOPE === "session") return sessionState || { workflow: null, active: false };
  if (STATE_SCOPE === "project") return readActiveWorkflowFile(projectActiveWorkflowFile(cwd)) || { workflow: null, active: false };
  if (STATE_SCOPE === "legacy") return readActiveWorkflowFile(LEGACY_ACTIVE_WORKFLOW_FILE) || { workflow: null, active: false };
  return sessionState || { workflow: null, active: false };
}

function persistActiveWorkflow(cwd: string, workflowName: string): void {
  if (STATE_SCOPE === "session") return;
  const content = `workflow: ${workflowName}\nproject: ${cwd}\nactivated_at: ${new Date().toISOString()}\nstatus: active\n`;
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
  let sessionWorkflowState: { workflow: string | null; active: boolean } | null = null;
  let workflowActive = false;
  let activeWorkflowName: string | null = null;
  let currentAgent: string | null = null;
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

  function readSessionWorkflowState(ctx: any): { workflow: string | null; active: boolean } | null {
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
      return { workflow, active: status === "active" && Boolean(workflow) };
    }

    return null;
  }

  function appendSessionWorkflowState(workflow: string | null, status: "active" | "inactive"): void {
    if (STATE_SCOPE !== "session") return;
    pi.appendEntry(WORKFLOW_STATE_ENTRY, {
      workflow,
      status,
      project: currentCwd,
      updated_at: new Date().toISOString(),
    });
    sessionWorkflowState = { workflow, active: status === "active" && Boolean(workflow) };
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

  function refreshActiveStateFromDisk(): void {
    const active = parseActiveWorkflowFile(currentCwd, sessionWorkflowState);
    workflowActive = active.active;
    activeWorkflowName = active.active ? active.workflow : null;

    if (!workflowActive) {
      currentAgent = null;
      currentMode = null;
      currentTask = null;
      return;
    }

    const workflow = getWorkflow(activeWorkflowName);
    if (FORCED_AGENT && workflowUsesAgent(workflow, FORCED_AGENT)) {
      currentAgent = FORCED_AGENT;
      currentMode = isRootAgent(workflow, FORCED_AGENT) ? "primary" : "delegated";
      return;
    }

    if (!currentAgent || !workflowUsesAgent(workflow, currentAgent)) {
      currentAgent = primaryAgent(workflow);
      currentMode = currentAgent ? "primary" : null;
    }
  }

  function activateWorkflow(workflowName: string, task: string | null = null): boolean {
    const workflow = getWorkflow(workflowName);
    if (!workflow) return false;

    forceWorkflowList = false;
    workflowActive = true;
    activeWorkflowName = workflow.name;
    currentAgent = primaryAgent(workflow);
    currentMode = currentAgent ? "primary" : null;
    currentTask = task;
    appendSessionWorkflowState(workflow.name, "active");
    persistActiveWorkflow(currentCwd, workflow.name);
    return true;
  }

  function deactivateWorkflow(): void {
    forceWorkflowList = false;
    const lastWorkflow = activeWorkflowName;
    workflowActive = false;
    activeWorkflowName = null;
    currentAgent = null;
    currentMode = null;
    currentTask = null;
    autoCompactTriggered = false;
    appendSessionWorkflowState(lastWorkflow, "inactive");
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
    return FORCED_AGENT || currentAgent || primaryAgent(workflow);
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

  function classifyJavaImports(filePath: string): Classification | null {
    if (!existsSync(filePath)) return null;
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { return null; }
    const scan = content.split(/\r?\n/).slice(0, 200).join("\n");
    if (/import\s+(org\.springframework|reactor\.|tools\.jackson\.)/.test(scan)) {
      return { capability: "infrastructure-code-generation", owner: "java-infra-coder", reason: "Java framework import scan" };
    }
    if (/import\s+(io\.cucumber|org\.junit\.)/.test(scan)) {
      return { capability: "integration-test-setup", owner: "java-tester", reason: "Java test import scan" };
    }
    return null;
  }

  function classifyPath(filePath: string): Classification | null {
    const relPath = toProjectRelative(filePath);
    const absPath = resolve(currentCwd, filePath);
    const normalized = relPath.replace(/^\.\//, "");

    if (normalized.endsWith(".java")) {
      const importClass = classifyJavaImports(absPath);
      if (importClass) return importClass;
    }

    if (normalized === "docs/test-report.md") {
      return { capability: "test-report-documentation", owner: "documenter", allowedOwners: ["documenter", "java-tester"], reason: "shared test report ownership" };
    }

    for (const rule of registry.fileRules || []) {
      if (globLikeMatch(rule.pattern, normalized)) {
        return { capability: rule.capability || "file-mutation", owner: rule.owner, reason: `file rule ${rule.pattern}` };
      }
    }

    if (normalized === "README.md") return { capability: "readme-management", owner: "documenter", reason: "README ownership" };
    if (normalized === "PLAN.md") return { capability: "plan-management", owner: "documenter", reason: "PLAN ownership" };
    if (normalized.startsWith("docs/c4/")) return { capability: "structurizr-dsl", owner: "c4model", reason: "C4 documentation path" };
    if (normalized.startsWith("docs/arc42/") || normalized.startsWith("docs/adr/")) return { capability: "arc42-documentation", owner: "documenter", reason: "documentation path" };
    if (basename(normalized) === "pom.xml") return { capability: "pom-generation", owner: "java-scaffolder", reason: "Maven POM" };
    if (normalized.includes("-domain/")) return { capability: "domain-code-generation", owner: "java-domain-coder", reason: "domain module path" };
    if (normalized.includes("-application/") || normalized.includes("-infrastructure/") || normalized.startsWith("s3-api/") || normalized.startsWith("bootstrap-application/")) {
      return { capability: "application-code-generation", owner: "java-infra-coder", reason: "application/infrastructure module path" };
    }
    if (normalized.endsWith(".feature")) return { capability: "gherkin-feature-writing", owner: "java-tester", reason: "Gherkin feature" };
    if (/Test\.java$|Steps\.java$/.test(normalized)) return { capability: "integration-test-setup", owner: "java-tester", reason: "test Java file name" };
    if (basename(normalized) === "test-aws-cli.sh") return { capability: "aws-cli-compatibility-tests", owner: "java-tester", reason: "AWS CLI test script" };
    return null;
  }

  function classifyBash(command: string): Classification | null {
    if (/c4model-|structurizr|docs\/c4\//.test(command)) return { capability: "structurizr-export", owner: "c4model", reason: "C4/Structurizr command" };
    if (/\b(test-aws-cli\.sh|cucumber|surefire|clover:|mvn\s+.*\btest\b)/.test(command)) return { capability: "integration-test-setup", owner: "java-tester", reason: "test command" };
    if (/\bpom\.xml\b|mvn\s+archetype|mvn\s+-N/.test(command)) return { capability: "pom-generation", owner: "java-scaffolder", reason: "Maven scaffolding command" };
    return null;
  }

  function isMutationTool(toolName: string): boolean {
    return ["write", "edit", "bash"].some((name) => toolName === name || toolName.endsWith(`.${name}`));
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
    if (toolName === "delegate_agent" || toolName.endsWith(".delegate_agent")) return null;

    if (toolName === "write" || toolName.endsWith(".write") || toolName === "edit" || toolName.endsWith(".edit")) {
      const filePath = input?.path;
      if (typeof filePath === "string") {
        const classification = classifyPath(filePath);
        if (classification) return validationForClassification(classification, `${toolName} ${filePath}`);
      }
    }

    if (toolName === "bash" || toolName.endsWith(".bash")) {
      const command = input?.command;
      if (typeof command === "string") {
        const classification = classifyBash(command);
        if (classification) return validationForClassification(classification, `${toolName} ${command.slice(0, 80)}`);
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
      const chain = currentAgentChain(workflow);
      const activeLabel = chain.length ? chain.join(" → ") : currentAgent || "unknown";
      const lines = [
        truncateToWidth(`${theme.fg("success", "● Multi-Agent")} ${theme.fg("accent", workflowName)} ${theme.fg("dim", "| active:")} ${theme.fg("success", activeLabel)}${task}`, width),
      ];

      if (view === "compact") {
        lines.push(truncateToWidth(theme.fg("dim", `  ${countWorkflowAgents(workflow || { name: "", description: "", agents: [], hierarchy: [], filePath: "" })} agents • /skill:multi-agent detail for tree • /skill:multi-agent list for workflows`), width));
        return lines;
      }

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

      return truncatePanel(lines, theme, width);
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

  async function runDelegatedAgent(agentName: string, task: string, cwd: string, signal: AbortSignal | undefined, ctx: any): Promise<{ output: string; stderr: string; exitCode: number }> {
    const agent = getAgent(agentName);
    if (!agent) throw new Error(`Unknown delegated agent: ${agentName}`);

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
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
        env: { ...process.env, MULTI_AGENT_AGENT: agentName, MULTI_AGENT_PARENT: activeAgentName() || "", MULTI_AGENT_WORKFLOW: activeWorkflowName || "" },
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
        stdout += text;
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolvePromise({ output: finalOutput || stdout.trim() || "(no output)", stderr, exitCode: code ?? 0 });
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      setCwd(ctx);
      refreshResources();
      refreshActiveStateFromDisk();
      const workflow = getWorkflow();
      const from = activeAgentName() || primaryAgent(workflow);

      if (workflowActive && workflow && from) {
        if (!workflowUsesAgent(workflow, params.agent)) throw new Error(`Agent ${params.agent} is not part of workflow ${workflow.name}.`);
        if (!isDirectChild(workflow, from, params.agent)) {
          const path = delegationPath(workflow, from, params.agent).join(" → ");
          throw new Error(`Invalid delegation: ${from} can delegate only to direct children. Use path: ${path || `${from} → ${params.agent}`}.`);
        }
      }

      const previousAgent = currentAgent;
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
      const result = await runDelegatedAgent(params.agent, params.task, params.cwd || ctx.cwd || currentCwd, signal, ctx);
      if (previousAgent) setCurrentAgent(previousAgent);

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
        details: { agent: params.agent, task: params.task, stderr: result.stderr, exitCode: result.exitCode },
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
      if (!activateWorkflow(args, "activated")) {
        ctx.ui.notify(`Workflow not found: ${args}`, "error");
        updateWidget(ctx);
        return { action: "handled" as const };
      }
      ctx.ui.notify(`Active workflow: ${args}`, "info");
      updateWidget(ctx);
      // Let pi expand the skill command so the agent receives SKILL.md content
      return { action: "continue" as const };
    }

    if (command === "deactivate") {
      deactivateWorkflow();
      ctx.ui.notify("Multi-agent workflow deactivated", "info");
      updateWidget(ctx);
      // Let pi expand the skill command so the agent receives updated context
      return { action: "continue" as const };
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
      ctx.ui.notify(workflowActive ? `Active: ${activeWorkflowName}` : "No active workflow", "info");
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

    if (workflowActive) {
      forceWorkflowList = false;
      const workflow = getWorkflow();
      const primary = primaryAgent(workflow);
      if (primary && !FORCED_AGENT) {
        currentAgent = primary;
        currentMode = "primary";
        currentTask = typeof event.prompt === "string" ? event.prompt.slice(0, 80) : null;
      }
      updateWidget(ctx);
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
      currentAgent = null;
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
