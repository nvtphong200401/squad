/**
 * State Module — Typed Collection Facades
 *
 * Each class provides a typed, ergonomic interface over a specific
 * `.squad/` collection, backed by StorageProvider + IO layer.
 *
 * @module state/collections
 */

import type { StorageProvider } from '../storage/storage-provider.js';
import type { AgentHandle } from './collection-map.js';
import type {
  Decision,
  RoutingConfig,
  RoutingConfigRule,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TeamConfig,
  TeamMember,
} from './domain-types.js';
import type { SkillDefinition } from '../skills/skill-loader.js';
import { NotFoundError, ParseError } from './domain-types.js';
import { resolveCollectionPath } from './schema.js';
import { createAgentHandle } from './handles.js';
import { parseDecisions, serializeDecision, serializeDecisions } from './io/decisions-io.js';
import { parseRouting, serializeRouting, type ParsedRouting } from './io/routing-io.js';
import { parseTeam, serializeTeam, type ParsedTeam } from './io/team-io.js';
import {
  parseTaskEvent,
  parseTaskMeta,
  projectTaskRecord,
  serializeTaskEvent,
  serializeTaskMeta,
  type ParsedTaskEvent,
  type ParsedTaskMeta,
} from './io/tasks-io.js';
import { parseSkillFile } from '../skills/skill-loader.js';
import type { ParsedDecision } from './io/decisions-io.js';
import type { ParsedRoutingRule } from './io/routing-io.js';
import type { ParsedAgent } from './io/team-io.js';

// ── AgentsCollection ───────────────────────────────────────────────────────

export class AgentsCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** Return a handle for interacting with a specific agent's state. */
  get(name: string): AgentHandle {
    return createAgentHandle(name, this.storage, this.rootDir);
  }

  /** List agent names from `.squad/agents/`. */
  async list(): Promise<string[]> {
    const agentsDir = `${this.rootDir}/.squad/agents`;
    return this.storage.list(agentsDir);
  }

  /** Create a new agent with charter and empty history. */
  async create(name: string, charter: string): Promise<void> {
    const agentDir = `${this.rootDir}/.squad/agents/${name}`;
    await this.storage.write(`${agentDir}/charter.md`, charter);
    await this.storage.write(`${agentDir}/history.md`, `# ${name}\n\n## Learnings\n\n## Context\n`);
  }

  /** Soft-delete an agent by removing its directory. */
  async delete(name: string): Promise<void> {
    const agentDir = `${this.rootDir}/.squad/agents/${name}`;
    const exists = await this.storage.exists(agentDir);
    if (!exists) {
      throw new NotFoundError('agents', name);
    }
    await this.storage.deleteDir(agentDir);
  }
}

// ── DecisionsCollection ────────────────────────────────────────────────────

/** Map a ParsedDecision to the domain Decision type. */
function toDomainDecision(pd: ParsedDecision): Decision {
  return {
    date: pd.date ?? '',
    title: pd.title,
    author: pd.author ?? '',
    body: pd.body,
    configRelevant: pd.configRelevant,
  };
}

/** Map a domain Decision to ParsedDecision for serialization. */
function toParsedDecision(d: Decision): ParsedDecision {
  return {
    title: d.title,
    body: d.body,
    configRelevant: d.configRelevant,
    date: d.date || undefined,
    author: d.author || undefined,
  };
}

export class DecisionsCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** Parse and return all decisions from `decisions.md`. */
  async list(): Promise<Decision[]> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('decisions')}`;
    const content = await this.storage.read(filePath);
    if (content === undefined) {
      return [];
    }
    try {
      return parseDecisions(content).map(toDomainDecision);
    } catch (err) {
      throw new ParseError('decisions', err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  /** Append a new decision. Date is auto-generated if not provided. */
  async add(decision: Omit<Decision, 'date'>): Promise<void> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('decisions')}`;
    const date = new Date().toISOString().split('T')[0]!;
    const full: Decision = { ...decision, date };
    const parsed = toParsedDecision(full);

    const existing = await this.storage.read(filePath);
    if (existing === undefined || existing.trim().length === 0) {
      await this.storage.write(filePath, serializeDecisions([parsed]));
    } else {
      const fragment = '\n\n' + serializeDecision(parsed) + '\n';
      await this.storage.append(filePath, fragment);
    }
  }
}

// ── RoutingCollection ──────────────────────────────────────────────────────

/** Map ParsedRouting to RoutingConfig. */
function toRoutingConfig(parsed: ParsedRouting): RoutingConfig {
  return {
    rules: parsed.rules.map(
      (r): RoutingConfigRule => ({
        workType: r.workType,
        agents: r.agents,
        examples: r.examples ?? [],
      }),
    ),
    moduleOwnership: parsed.moduleOwnership,
    principles: [],
  };
}

/** Map RoutingConfig rules back to ParsedRoutingRule[]. */
function toParsedRoutingRules(config: RoutingConfig): ParsedRoutingRule[] {
  return config.rules.map(
    (r): ParsedRoutingRule => ({
      workType: r.workType,
      agents: [...r.agents],
      examples: [...r.examples],
    }),
  );
}

export class RoutingCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** Parse and return the routing configuration. */
  async get(): Promise<RoutingConfig> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('routing')}`;
    const content = await this.storage.read(filePath);
    if (content === undefined) {
      throw new NotFoundError('routing');
    }
    try {
      return toRoutingConfig(parseRouting(content));
    } catch (err) {
      throw new ParseError('routing', err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  /** Write back a full routing configuration. */
  async update(config: RoutingConfig): Promise<void> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('routing')}`;
    const rules = toParsedRoutingRules(config);
    await this.storage.write(filePath, serializeRouting(rules));
  }
}

// ── TeamCollection ─────────────────────────────────────────────────────────

/** Map ParsedTeam to TeamConfig. */
function toTeamConfig(parsed: ParsedTeam): TeamConfig {
  return {
    projectContext: parsed.projectContext,
    members: parsed.agents.map(
      (a): TeamMember => ({
        name: a.name,
        role: a.role,
        status: a.status,
      }),
    ),
  };
}

/** Map TeamConfig members back to ParsedAgent[]. */
function toParsedAgents(config: TeamConfig): ParsedAgent[] {
  return config.members.map(
    (m): ParsedAgent => ({
      name: m.name,
      role: m.role,
      skills: [],
      status: m.status,
    }),
  );
}

export class TeamCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** Parse and return the team configuration. */
  async get(): Promise<TeamConfig> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('team')}`;
    const content = await this.storage.read(filePath);
    if (content === undefined) {
      throw new NotFoundError('team');
    }
    try {
      return toTeamConfig(parseTeam(content));
    } catch (err) {
      throw new ParseError('team', err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  /** Write back a full team configuration. */
  async update(config: TeamConfig): Promise<void> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('team')}`;
    const agents = toParsedAgents(config);
    await this.storage.write(filePath, serializeTeam(agents));
  }
}

// ── SkillsCollection ──────────────────────────────────────────────────────

export class SkillsCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** List all skill IDs (directory names under .squad/skills/). */
  async list(): Promise<string[]> {
    const skillsDir = `${this.rootDir}/.squad/skills`;
    return this.storage.list(skillsDir);
  }

  /** Get a skill definition by ID. Returns undefined if not found or unparseable. */
  async get(id: string): Promise<SkillDefinition | undefined> {
    const skillFile = `${this.rootDir}/${resolveCollectionPath('skills', id)}/SKILL.md`;
    const content = await this.storage.read(skillFile);
    if (content === undefined) return undefined;
    return parseSkillFile(id, content);
  }

  /** Check if a skill exists. */
  async exists(id: string): Promise<boolean> {
    const skillFile = `${this.rootDir}/${resolveCollectionPath('skills', id)}/SKILL.md`;
    return this.storage.exists(skillFile);
  }
}

// ── TemplatesCollection ───────────────────────────────────────────────────

export class TemplatesCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** List template filenames under .squad/templates/. */
  async list(): Promise<string[]> {
    const templatesDir = `${this.rootDir}/.squad/templates`;
    return this.storage.list(templatesDir);
  }

  /** Get raw template content by ID. Returns undefined if not found. */
  async get(id: string): Promise<string | undefined> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('templates', id)}`;
    return this.storage.read(filePath);
  }

  /** Check if a template exists. */
  async exists(id: string): Promise<boolean> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('templates', id)}`;
    return this.storage.exists(filePath);
  }
}

// ── TasksCollection ────────────────────────────────────────────────────────

const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`Invalid task id "${taskId}"`);
  }
}

function statusForEventType(type: TaskEvent['type']): TaskStatus {
  switch (type) {
    case 'selected':
      return 'selected';
    case 'started':
    case 'heartbeat':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
  }
}

function isValidTransition(current: TaskStatus | undefined, next: TaskStatus): boolean {
  if (!current) return next === 'selected';
  if (current === 'selected') return next === 'selected' || next === 'running' || next === 'blocked' || next === 'cancelled';
  if (current === 'running') return next === 'running' || next === 'succeeded' || next === 'failed' || next === 'blocked' || next === 'cancelled';
  return next === 'selected' || next === 'running';
}

export interface CreateTaskInput {
  id: string;
  source: TaskRecord['source'];
  sourceRef: string;
  title: string;
  assignedAgent: string;
  createdAt?: string;
  links?: TaskRecord['links'];
  dependencies?: readonly string[];
}

export class TasksCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  private baseDir(): string {
    return `${this.rootDir}/.squad/tasks`;
  }

  private taskDir(taskId: string): string {
    return `${this.rootDir}/${resolveCollectionPath('tasks', taskId)}`;
  }

  private metaPath(taskId: string): string {
    return `${this.taskDir(taskId)}/meta.json`;
  }

  private eventsDir(taskId: string): string {
    return `${this.taskDir(taskId)}/events`;
  }

  private async readMeta(taskId: string): Promise<ParsedTaskMeta | undefined> {
    const content = await this.storage.read(this.metaPath(taskId));
    if (content === undefined) return undefined;
    try {
      return parseTaskMeta(content);
    } catch (err) {
      throw new ParseError('tasks', `invalid meta for ${taskId}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  private async readEvents(taskId: string): Promise<ParsedTaskEvent[]> {
    const eventsDir = this.eventsDir(taskId);
    if (!(await this.storage.exists(eventsDir))) return [];
    const files = (await this.storage.list(eventsDir))
      .filter((name) => name.endsWith('.json'))
      .filter((name) => !name.endsWith('.tmp') && !name.startsWith('.'))
      .sort();
    const events: ParsedTaskEvent[] = [];
    for (const file of files) {
      const content = await this.storage.read(`${eventsDir}/${file}`);
      if (content === undefined) continue;
      try {
        events.push(parseTaskEvent(content));
      } catch {
        // Skip malformed events to keep task projection resilient.
      }
    }
    return events;
  }

  async create(input: CreateTaskInput): Promise<void> {
    validateTaskId(input.id);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const meta: ParsedTaskMeta = {
      id: input.id,
      schemaVersion: 1,
      source: input.source,
      sourceRef: input.sourceRef,
      title: input.title,
      assignedAgent: input.assignedAgent,
      createdAt,
      links: input.links,
      dependencies: input.dependencies,
    };
    await this.storage.write(this.metaPath(input.id), serializeTaskMeta(meta));
    await this.storage.mkdir(this.eventsDir(input.id), { recursive: true });
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    validateTaskId(taskId);
    const meta = await this.readMeta(taskId);
    if (!meta) return undefined;
    const events = await this.readEvents(taskId);
    return projectTaskRecord(meta, events);
  }

  async getProjected(taskId: string): Promise<TaskRecord | undefined> {
    return this.get(taskId);
  }

  async list(): Promise<TaskRecord[]> {
    const tasksDir = this.baseDir();
    if (!(await this.storage.exists(tasksDir))) return [];
    const taskIds = await this.storage.list(tasksDir);
    const results: TaskRecord[] = [];
    for (const taskId of taskIds) {
      if (!TASK_ID_RE.test(taskId)) continue;
      try {
        const record = await this.get(taskId);
        if (record) results.push(record);
      } catch {
        // Skip malformed task entries to keep callers resilient.
      }
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendEvent(taskId: string, event: Omit<TaskEvent, 'schemaVersion'> & { schemaVersion?: number }): Promise<void> {
    validateTaskId(taskId);
    const normalizedEvent: ParsedTaskEvent = {
      ...event,
      schemaVersion: event.schemaVersion ?? 1,
    };

    if (!TASK_ID_RE.test(normalizedEvent.id)) {
      throw new Error(`Invalid event id "${normalizedEvent.id}"`);
    }
    if (!TASK_ID_RE.test(normalizedEvent.attemptId)) {
      throw new Error(`Invalid attempt id "${normalizedEvent.attemptId}"`);
    }

    let current = await this.get(taskId);
    if (!current) {
      throw new Error(`Task "${taskId}" must be created before appending events`);
    }

    const nextStatus = statusForEventType(normalizedEvent.type);
    if (!isValidTransition(current?.status, nextStatus)) {
      throw new Error(`Invalid task status transition: ${current?.status ?? 'none'} -> ${nextStatus}`);
    }

    const eventsDir = this.eventsDir(taskId);
    await this.storage.mkdir(eventsDir, { recursive: true });
    const existingFiles = await this.storage.list(eventsDir);
    const duplicate = existingFiles.some((name) => name.endsWith(`-${normalizedEvent.id}.json`));
    if (duplicate) {
      throw new Error(`Duplicate task event id "${normalizedEvent.id}" for ${taskId}`);
    }

    const safeTs = normalizedEvent.timestamp.replaceAll(':', '-').replaceAll('.', '-');
    const eventPath = `${eventsDir}/${safeTs}-${normalizedEvent.id}.json`;
    await this.storage.write(eventPath, serializeTaskEvent(normalizedEvent));
  }
}

// ── ConfigCollection ──────────────────────────────────────────────────────

/** Serializable subset of config stored in `.squad/config.json`. */
export interface ConfigFileData {
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
}

const DEFAULT_CONFIG: Required<ConfigFileData> = {
  cacheEnabled: false,
  cacheTtlMs: 300_000,
};

export class ConfigCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** Read and parse `.squad/config.json`. Returns defaults when file is missing or invalid. */
  async get(): Promise<ConfigFileData> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('config')}`;
    const content = await this.storage.read(filePath);
    if (content === undefined) {
      return { ...DEFAULT_CONFIG };
    }
    try {
      const parsed = JSON.parse(content) as ConfigFileData;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Write config to `.squad/config.json`. */
  async update(config: ConfigFileData): Promise<void> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('config')}`;
    await this.storage.write(filePath, JSON.stringify(config, null, 2) + '\n');
  }

  /** Check if `.squad/config.json` exists. */
  async exists(): Promise<boolean> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('config')}`;
    return this.storage.exists(filePath);
  }
}

// ── LogCollection ─────────────────────────────────────────────────────────

export class LogCollection {
  constructor(
    private readonly storage: StorageProvider,
    private readonly rootDir: string,
  ) {}

  /** List log entry filenames under .squad/log/. */
  async list(): Promise<string[]> {
    const logDir = `${this.rootDir}/${resolveCollectionPath('log')}`;
    return this.storage.list(logDir);
  }

  /** Read a specific log entry. Returns undefined if not found. */
  async get(id: string): Promise<string | undefined> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('log')}/${id}`;
    return this.storage.read(filePath);
  }

  /** Write a new log entry. */
  async write(id: string, content: string): Promise<void> {
    const filePath = `${this.rootDir}/${resolveCollectionPath('log')}/${id}`;
    await this.storage.write(filePath, content);
  }
}
