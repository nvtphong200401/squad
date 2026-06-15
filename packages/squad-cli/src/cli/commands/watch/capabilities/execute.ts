/**
 * Execute capability — spawns Copilot sessions for eligible issues.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SquadState } from '@bradygaster/squad-sdk';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import type { MachineCapabilities } from '@bradygaster/squad-sdk/ralph/capabilities';
import { createVerboseLogger } from '../verbose.js';
import { loadAgentCharter } from '../../../shell/spawn.js';
import { withAdditionalMcpConfig } from '../../../core/copilot-invocation.js';

/** Normalized work item for execution. */
export interface ExecutableWorkItem {
  number: number;
  title: string;
  body?: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
}

interface LedgerRuntime {
  state: {
    tasks: {
      get(taskId: string): Promise<{ id: string } | undefined>;
      create(input: {
        id: string;
        source: 'issue' | 'manual' | 'pr' | 'external';
        sourceRef: string;
        title: string;
        assignedAgent: string;
        createdAt?: string;
        links?: { orchestrationLog?: string; sessionLog?: string };
      }): Promise<void>;
      appendEvent(taskId: string, event: {
        id: string;
        type: 'selected' | 'started' | 'completed' | 'failed' | 'blocked';
        attemptId: string;
        timestamp: string;
        assignedAgent?: string;
        summary?: string;
        links?: { orchestrationLog?: string; sessionLog?: string };
      }): Promise<void>;
    };
  };
  timestamp: string;
}

function resolveLedgerRuntime(context: WatchContext, timestamp: string): LedgerRuntime | undefined {
  if (!context.stateContext) return undefined;
  const rawState = SquadState.fromStorage(context.stateContext.storage, context.teamRoot) as unknown as {
    tasks?: LedgerRuntime['state']['tasks'];
  };
  if (!rawState.tasks) return undefined;
  return { state: { tasks: rawState.tasks }, timestamp };
}

function toTaskId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

async function initLedgerTask(runtime: LedgerRuntime, issue: ExecutableWorkItem): Promise<void> {
  const taskId = toTaskId(issue.number);
  const existing = await runtime.state.tasks.get(taskId);
  if (!existing) {
    await runtime.state.tasks.create({
      id: taskId,
      source: 'issue',
      sourceRef: `#${issue.number}`,
      title: issue.title,
      assignedAgent: 'ralph',
      createdAt: runtime.timestamp,
      links: {
        orchestrationLog: '.squad/orchestration-log.md',
        sessionLog: '.squad/sessions/',
      },
    });
  }
}

async function writeLedgerEvent(
  runtime: LedgerRuntime,
  issue: ExecutableWorkItem,
  event: {
    id: string;
    type: 'selected' | 'started' | 'completed' | 'failed' | 'blocked';
    attemptId: string;
    summary?: string;
  },
): Promise<void> {
  await runtime.state.tasks.appendEvent(toTaskId(issue.number), {
    id: event.id,
    type: event.type,
    attemptId: event.attemptId,
    timestamp: runtime.timestamp,
    assignedAgent: 'ralph',
    summary: event.summary,
    links: {
      orchestrationLog: '.squad/orchestration-log.md',
      sessionLog: '.squad/sessions/',
    },
  });
}

/** Check whether an issue carries a squad or squad:* label. */
function hasSquadLabel(issue: ExecutableWorkItem): boolean {
  return issue.labels.some(l => l.name === 'squad' || l.name.startsWith('squad:'));
}

/** Keywords that indicate read-heavy / analysis work. */
const READ_KEYWORDS = [
  'research', 'review', 'analyze', 'investigate', 'audit',
  'check', 'scan', 'assess', 'evaluate', 'fact-check',
  'document', 'report',
];

/** Keywords that indicate write-heavy / implementation work. */
const WRITE_KEYWORDS = [
  'fix', 'implement', 'create', 'build', 'refactor',
  'add', 'update', 'migrate', 'deploy', 'feature',
];

/** Classify an issue as read-heavy or write-heavy by title keywords. */
export function classifyIssue(title: string): 'read' | 'write' {
  const lower = title.toLowerCase();
  const isRead = READ_KEYWORDS.some(k => lower.includes(k));
  const isWrite = WRITE_KEYWORDS.some(k => lower.includes(k));
  if (isRead && !isWrite) return 'read';
  return 'write'; // default to write (safer — gets full agent session)
}

/** Build agent command for a prompt. */
function buildAgentCommand(
  prompt: string,
  context: WatchContext,
): { cmd: string; args: string[] } {
  if (context.agentCmd) {
    const parts = context.agentCmd.trim().split(/\s+/);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), '-p', prompt];
    return { cmd, args };
  }
  const args = ['-p', prompt];
  if (context.copilotFlags) {
    args.push(...context.copilotFlags.trim().split(/\s+/));
  }
  return { cmd: 'copilot', args: withAdditionalMcpConfig('copilot', args, context.teamRoot) };
}

/** Labels that indicate an issue should not be auto-executed. */
const BLOCKING_LABELS = ['status:blocked', 'status:wontfix', 'status:on-hold', 'blocked'];

/** Check whether an issue has a blocking status label. */
function hasBlockingLabel(issue: ExecutableWorkItem): boolean {
  return issue.labels.some(l => BLOCKING_LABELS.includes(l.name));
}

/** Check whether an issue is already assigned to a human. */
function isAssigned(issue: ExecutableWorkItem): boolean {
  return issue.assignees.length > 0;
}

/** Find issues eligible for autonomous execution.
 *
 * Pre-filters to keep only clearly actionable items:
 *  - must have a squad/squad:* label
 *  - must not be assigned to a human (agent decides once it reads ralph-instructions.md)
 *  - must not carry a blocking status label
 *
 * Matches the PS1 ralph-watch pre-filter design.
 */
export function findExecutableIssues(
  _roster: Array<{ name: string; label: string; expertise: string[] }>,
  _capabilities: MachineCapabilities | null,
  issues: ExecutableWorkItem[],
): ExecutableWorkItem[] {
  return issues.filter(
    issue => hasSquadLabel(issue) && !isAssigned(issue) && !hasBlockingLabel(issue),
  );
}

/** Format issue list for the agent prompt. */
function formatIssueList(issues: ExecutableWorkItem[]): string {
  return issues.map(i => {
    const labels = i.labels.map(l => l.name).join(', ');
    const assigned = i.assignees?.length
      ? `assigned: ${i.assignees.map(a => a.login).join(',')}`
      : 'unassigned';
    return `- #${i.number}: ${i.title} [${labels}] ${assigned}`;
  }).join('\n');
}

/** Build the rich agent prompt matching PS1 ralph-watch design. */
export function buildAgentPrompt(
  issues: ExecutableWorkItem[],
  teamRoot: string,
): string {
  const issueList = formatIssueList(issues);
  const hasInstructions = existsSync(path.join(teamRoot, '.squad', 'ralph-instructions.md'));

  if (hasInstructions) {
    return [
      'Ralph, Go! Read .squad/ralph-instructions.md for your full instructions. Follow ALL sections there. MAXIMIZE PARALLELISM — spawn agents for ALL actionable issues simultaneously.',
      '',
      'Here are the current open squad issues:',
      issueList,
      '',
      'Task: Read the issues, follow your instructions in .squad/ralph-instructions.md, and work on what\'s actionable.',
      'WHY: Keep the squad pipeline moving — no idle work.',
      'Success: Issues get branches, PRs, and progress.',
      'Escalation: If blocked, comment on the issue and move to next.',
    ].join('\n');
  }

  // Fallback when ralph-instructions.md does not exist
  return [
    'You are Ralph, the autonomous work monitor. Review the open squad issues below and work on every actionable one. Skip issues that are blocked, waiting on external input, or already assigned.',
    '',
    'Here are the current open squad issues:',
    issueList,
    '',
    'Task: Triage the list, pick up unblocked/unassigned issues, create branches and PRs.',
    'WHY: Keep the squad pipeline moving — no idle work.',
    'Success: Issues get branches, PRs, and progress.',
    'Escalation: If blocked, comment on the issue and move to next.',
  ].join('\n');
}

/** Spawn a single agent session for all eligible issues. */
async function executeAll(
  issues: ExecutableWorkItem[],
  context: WatchContext,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string; timedOut?: boolean }> {
  const prompt = buildAgentPrompt(issues, context.teamRoot);

  // Load Ralph's charter to give the spawned session full specialist context.
  let charterPrefix = '';
  try {
    const charter = await loadAgentCharter('ralph', context.teamRoot);
    charterPrefix = `You are an AI agent on a software development team.\n\nYOUR CHARTER:\n${charter}\n\nADDITIONAL CONTEXT:\n`;
  } catch {
    // Fall back gracefully if no charter exists (e.g., fresh setup)
  }

  const fullPrompt = charterPrefix + prompt;
  const { cmd, args } = buildAgentCommand(fullPrompt, context);

  return new Promise<{ success: boolean; error?: string; timedOut?: boolean }>((resolve) => {
    const cp: ChildProcess = execFile(
      cmd,
      args,
      { cwd: context.teamRoot, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
      (err) => {
        if (err) {
          const execErr = err as Error & { killed?: boolean };
          const msg = execErr.killed ? `Timed out` : execErr.message;
          resolve({ success: false, error: msg, timedOut: !!execErr.killed });
        } else {
          resolve({ success: true });
        }
      },
    );

    // Track child PID for cleanup on exit/crash
    if (context.pidTracker && cp.pid) {
      const issueNums = issues.map(i => `#${i.number}`).join(',');
      context.pidTracker.track(cp.pid, `copilot-session-${issueNums}`);
    }

    cp.on('exit', () => {
      if (context.pidTracker && cp.pid) {
        context.pidTracker.untrack(cp.pid);
      }
    });
  });
}

export class ExecuteCapability implements WatchCapability {
  readonly name = 'execute';
  readonly description = 'Spawn Copilot sessions to work on eligible issues';
  readonly configShape = 'boolean' as const;
  readonly requires = ['gh'];
  readonly phase = 'post-execute' as const;

  async preflight(_context: WatchContext): Promise<PreflightResult> {
    return new Promise<PreflightResult>((resolve) => {
      execFile('gh', ['--version'], (err) => {
        resolve(err ? { ok: false, reason: 'gh CLI not found' } : { ok: true });
      });
    });
  }

  async execute(context: WatchContext): Promise<CapabilityResult> {
    const vlog = createVerboseLogger(context.verbose ?? false);
    const timestamp = new Date().toISOString();
    const attemptId = `attempt-${timestamp.replaceAll(':', '-').replaceAll('.', '-')}`;
    const ledgerRuntime = resolveLedgerRuntime(context, timestamp);

    try {
      const timeout = ((context.config['timeout'] as number) ?? 30) * 60_000;

      vlog.log(`Execute: agentCmd=${context.agentCmd ?? 'copilot'}, timeout=${timeout / 60_000}m`);

      // Fetch open issues with squad label
      const sdkItems = await context.adapter.listWorkItems({ tags: ['squad'], state: 'open', limit: 50 });
      const issues: ExecutableWorkItem[] = sdkItems.map(wi => ({
        number: wi.id,
        title: wi.title,
        labels: wi.tags.map(t => ({ name: t })),
        assignees: wi.assignedTo ? [{ login: wi.assignedTo }] : [],
      }));

      // Minimal filter: must have squad or squad:* label (agent decides the rest)
      const eligible = findExecutableIssues(context.roster, null, issues);

      vlog.log(`Execute: ${issues.length} total issues, ${eligible.length} eligible`);
      for (const issue of eligible.slice(0, 5)) {
        const labels = issue.labels.map(l => l.name).join(', ');
        vlog.log(`  → #${issue.number}: "${issue.title}" [${labels}]`);
      }

      if (eligible.length === 0) {
        return { success: true, summary: 'no squad-labeled issues found' };
      }

      if (ledgerRuntime) {
        for (const issue of eligible) {
          try {
            await initLedgerTask(ledgerRuntime, issue);
            await writeLedgerEvent(ledgerRuntime, issue, {
              id: `selected-${attemptId}`,
              type: 'selected',
              attemptId,
              summary: `Watch selected issue #${issue.number} for execution`,
            });
            await writeLedgerEvent(ledgerRuntime, issue, {
              id: `started-${attemptId}`,
              type: 'started',
              attemptId,
              summary: 'Watch started Ralph execution for selected issue',
            });
          } catch (err) {
            vlog.log(`Task ledger write skipped for #${issue.number}: ${(err as Error).message}`);
          }
        }
      }

      // Single agent invocation with all issues — agent reads ralph-instructions.md
      const result = await executeAll(eligible, context, timeout);

      if (ledgerRuntime) {
        const terminalType = result.success ? 'completed' : (result.timedOut ? 'blocked' : 'failed');
        for (const issue of eligible) {
          try {
            await writeLedgerEvent(ledgerRuntime, issue, {
              id: `${terminalType}-${attemptId}`,
              type: terminalType,
              attemptId,
              summary: result.success
                ? `Watch execution completed for issue #${issue.number}`
                : `Watch execution ended: ${result.error ?? 'unknown error'}`,
            });
          } catch (err) {
            vlog.log(`Task ledger terminal write skipped for #${issue.number}: ${(err as Error).message}`);
          }
        }
      }

      return {
        success: result.success,
        summary: result.success
          ? `agent dispatched with ${eligible.length} issues`
          : `agent failed: ${result.error}`,
        data: { dispatched: eligible.length, success: result.success },
      };
    } catch (e) {
      return { success: false, summary: `execute error: ${(e as Error).message}` };
    }
  }
}