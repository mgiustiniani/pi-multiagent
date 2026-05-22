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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AgentInfo {
  name: string;
  description: string;
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

const EXTENSION_FILE = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const SKILL_DIR = resolve(dirname(EXTENSION_FILE), "..");
const AGENTS_DIR = join(SKILL_DIR, "agents");
const WORKFLOWS_DIR = join(SKILL_DIR, "workflows");
const ACTIVE_WORKFLOW_FILE = join(SKILL_DIR, ".active-workflow");

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
    .filter((file) => file.endsWith(".md") && !file.endsWith("index.md"))
    .map((file) => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf8");
      const fm = readFrontmatter(content);
      const name = parseScalar(fm, "name") || basename(file, ".md");
      const description = parseScalar(fm, "description") || "Agent";
      return { name, description, emoji: DEFAULT_EMOJIS[name] || "🤖" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadWorkflows(): WorkflowInfo[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];

  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".md") && !file.endsWith("index.md"))
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

function parseActiveWorkflowFile(): { workflow: string | null; active: boolean } {
  if (!existsSync(ACTIVE_WORKFLOW_FILE)) return { workflow: null, active: false };

  const content = readFileSync(ACTIVE_WORKFLOW_FILE, "utf8");
  const workflow = content.match(/^workflow:\s*(\S+)/m)?.[1] || null;
  const status = content.match(/^status:\s*(\S+)/m)?.[1] || "inactive";
  return { workflow, active: status === "active" && Boolean(workflow) };
}

function persistActiveWorkflow(workflowName: string): void {
  writeFileSync(
    ACTIVE_WORKFLOW_FILE,
    `workflow: ${workflowName}\nactivated_at: ${new Date().toISOString()}\nstatus: active\n`,
    "utf8",
  );
}

function persistInactiveWorkflow(lastWorkflow: string | null): void {
  writeFileSync(
    ACTIVE_WORKFLOW_FILE,
    `workflow: ${lastWorkflow || ""}\ndeactivated_at: ${new Date().toISOString()}\nstatus: inactive\n`,
    "utf8",
  );
}

export default function (pi: ExtensionAPI) {
  let agents: AgentInfo[] = [];
  let workflows: WorkflowInfo[] = [];
  let workflowActive = false;
  let activeWorkflowName: string | null = null;
  let currentAgent: string | null = null;
  let currentMode: AgentMode | null = null;
  let currentTask: string | null = null;
  let forceWorkflowList = false;

  function refreshResources(): void {
    agents = loadAgents();
    workflows = loadWorkflows();
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
    const active = parseActiveWorkflowFile();
    workflowActive = active.active;
    activeWorkflowName = active.active ? active.workflow : null;

    if (!workflowActive) {
      currentAgent = null;
      currentMode = null;
      currentTask = null;
      return;
    }

    const workflow = getWorkflow(activeWorkflowName);
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
    persistActiveWorkflow(workflow.name);
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
    persistInactiveWorkflow(lastWorkflow);
  }

  function normalizeAgentCandidate(value: string | undefined): string | null {
    if (!value) return null;
    const cleaned = value.replace(/[\]})>,.:;]+$/g, "").replace(/^[\[({<]+/g, "");
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

  function parseStatusFromText(text: string): { agent: string; task: string | null } | null {
    const delegLine = text.match(/(?:Delegating|Delega|Delego)[:\s]+(\S+)\s*(?:→|->|to|a)\s*(\S+)/i);
    if (delegLine) {
      const delegated = normalizeAgentCandidate(delegLine[2]);
      if (delegated) return { agent: delegated, task: null };
    }

    const delegToLine = text.match(/(?:Delegating\s+to|Delego\s+a|Delega\s+a)\s+(\S+)/i);
    if (delegToLine) {
      const delegated = normalizeAgentCandidate(delegToLine[1]);
      if (delegated) return { agent: delegated, task: null };
    }

    const backLine = text.match(/(?:back\s+to|ritorno\s+a)\s*(\S+)/i);
    if (backLine) {
      const parent = normalizeAgentCandidate(backLine[1]);
      if (parent) return { agent: parent, task: null };
    }

    const agentLine = text.match(/\b(?:AGENT|Agent|agente)\s*:\s*(\S+)/i);
    if (agentLine) {
      const agent = normalizeAgentCandidate(agentLine[1]);
      if (agent) {
        const task = text.match(/\b(?:TASK|Task|task)\s*:\s*(.+)/)?.[1]?.trim() || null;
        return { agent, task };
      }
    }

    const doneLine = text.match(/✓\s*(\S+)\s*completed/i);
    if (doneLine) {
      const agent = normalizeAgentCandidate(doneLine[1]);
      if (agent) return { agent, task: "completed" };
    }

    const failLine = text.match(/✗\s*(\S+)\s*FAILED:?\s*(.*)/i);
    if (failLine) {
      const agent = normalizeAgentCandidate(failLine[1]);
      if (agent) return { agent, task: failLine[2] ? `FAILED: ${failLine[2]}` : "FAILED" };
    }

    for (const agent of agents) {
      const bracket = new RegExp(`\\[${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);
      if (bracket.test(text)) return { agent: agent.name, task: null };
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

  function renderTree(workflow: WorkflowInfo | undefined, nodes: AgentNode[], theme: any, prefix = "", root = true): string[] {
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

      lines.push(`${prefix}${connector}${color(label)}${suffix}`);
      lines.push(...renderTree(workflow, node.children, theme, `${prefix}${continuation}`, false));
    });

    return lines;
  }

  function buildLines(theme: any): string[] {
    if (workflowActive && !forceWorkflowList) {
      const workflow = getWorkflow();
      const workflowName = workflow?.name || activeWorkflowName || "unknown";
      const task = currentTask ? theme.fg("dim", ` — ${currentTask}`) : "";
      const lines = [
        `${theme.fg("success", "● Multi-Agent active")} ${theme.fg("accent", workflowName)}${task}`,
      ];

      if (workflow?.hierarchy.length) lines.push(...renderTree(workflow, workflow.hierarchy, theme, "  "));
      else if (workflow?.agents.length) {
        for (const agent of workflow.agents) {
          const active = agent === currentAgent;
          const color = active ? (t: string) => theme.fg("success", t) : agentColor(agent, theme);
          lines.push(`  ${color(`${getEmoji(agent)} ${agent}`)}${active ? theme.fg("success", "  ← ACTIVE") : ""}`);
        }
      } else {
        lines.push(theme.fg("warning", "  Workflow senza agenti definiti"));
      }

      return lines;
    }

    const lines = workflowActive && forceWorkflowList
      ? [
          `${theme.fg("success", "● Multi-Agent active")} ${theme.fg("accent", activeWorkflowName || "unknown")} ${theme.fg("dim", "— workflow disponibili")}`,
          theme.fg("dim", "  Cambia con: /skill:multi-agent activate <workflow>"),
        ]
      : [
          theme.fg("dim", "○ Multi-Agent: no active workflow"),
          theme.fg("dim", "  Activate with: /skill:multi-agent activate <workflow>"),
        ];

    if (workflows.length === 0) {
      lines.push(theme.fg("warning", "  Nessun workflow trovato in workflows/"));
      return lines;
    }

    for (const workflow of workflows) {
      lines.push(`${theme.fg("accent", `  ${workflow.name}`)} ${theme.fg("dim", `— ${workflow.description}`)}`);
      if (workflow.hierarchy.length) lines.push(...renderTree(workflow, workflow.hierarchy, theme, "    "));
      else if (workflow.agents.length) lines.push(theme.fg("dim", `    agents: ${workflow.agents.join(", ")}`));
      else lines.push(theme.fg("warning", "    no agents defined"));
    }

    return lines;
  }

  function updateWidget(ctx: any): void {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget("multi-agent-status", (_tui: any, theme: any) => ({
      render: () => buildLines(theme),
      invalidate: () => {},
    }), { placement: "belowEditor" });
  }

  function refreshAndUpdate(ctx: any): void {
    refreshResources();
    refreshActiveStateFromDisk();
    updateWidget(ctx);
  }

  // ── Commands exposed through the documented /skill:multi-agent syntax ──

  pi.on("input", async (event, ctx) => {
    const match = event.text.trim().match(/^\/skill:multi-agent(?:\s+(\S+))?(?:\s+(.+))?$/);
    if (!match) return { action: "continue" as const };

    const command = match[1] || "status";
    const args = (match[2] || "").trim();
    refreshResources();
    refreshActiveStateFromDisk();

    if (command === "activate") {
      if (!args) {
        ctx.ui.notify("Uso: /skill:multi-agent activate <workflow>", "error");
        return { action: "handled" as const };
      }
      if (!activateWorkflow(args, "activated")) {
        ctx.ui.notify(`Workflow non trovato: ${args}`, "error");
        updateWidget(ctx);
        return { action: "handled" as const };
      }
      ctx.ui.notify(`Active workflow: ${args}`, "info");
      updateWidget(ctx);
      return { action: "handled" as const };
    }

    if (command === "deactivate") {
      deactivateWorkflow();
      ctx.ui.notify("Workflow multi-agent disattivato", "info");
      updateWidget(ctx);
      return { action: "handled" as const };
    }

    if (command === "list") {
      forceWorkflowList = true;
      updateWidget(ctx);
      ctx.ui.notify(`${workflows.length} workflow disponibili`, "info");
      return { action: "handled" as const };
    }

    if (command === "status") {
      forceWorkflowList = false;
      updateWidget(ctx);
      ctx.ui.notify(workflowActive ? `Active: ${activeWorkflowName}` : "No active workflow", "info");
      return { action: "handled" as const };
    }

    ctx.ui.notify(`Comando multi-agent sconosciuto: ${command}`, "error");
    return { action: "handled" as const };
  });

  // ── Lifecycle hooks ──

  pi.on("session_start", async (_event, ctx) => {
    refreshAndUpdate(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshResources();
    refreshActiveStateFromDisk();

    if (workflowActive) {
      forceWorkflowList = false;
      const workflow = getWorkflow();
      const primary = primaryAgent(workflow);
      if (primary) {
        currentAgent = primary;
        currentMode = "primary";
        currentTask = typeof event.prompt === "string" ? event.prompt.slice(0, 80) : null;
      }
      updateWidget(ctx);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return;
    refreshResources();
    refreshActiveStateFromDisk();
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
    if (!ctx.hasUI) return;

    const text = toolResultText(event);

    if (/workflow\s+deactivated|status:\s*inactive/i.test(text)) {
      forceWorkflowList = false;
      workflowActive = false;
      activeWorkflowName = null;
      currentAgent = null;
      currentMode = null;
      currentTask = null;
      updateWidget(ctx);
      return;
    }

    refreshResources();
    refreshActiveStateFromDisk();

    if (event.toolName === "write" || event.toolName === "edit" || event.toolName?.endsWith(".write") || event.toolName?.endsWith(".edit")) {
      refreshResources();
    }

    const parsed = parseStatusFromText(text);
    if (parsed && setCurrentAgent(parsed.agent, parsed.task)) updateWidget(ctx);
    else updateWidget(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
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
