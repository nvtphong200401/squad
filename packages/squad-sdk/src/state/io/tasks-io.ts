/**
 * Task ledger JSON I/O and projection helpers.
 *
 * Source of truth is append-only task events; meta.json provides static task
 * metadata and defaults for projection.
 *
 * @module state/io/tasks-io
 */

import type {
  TaskEvent,
  TaskEventType,
  TaskLinks,
  TaskRecord,
  TaskSource,
  TaskStatus,
} from '../domain-types.js';

export interface ParsedTaskMeta {
  readonly id: string;
  readonly schemaVersion: number;
  readonly source: TaskSource;
  readonly sourceRef: string;
  readonly title: string;
  readonly assignedAgent: string;
  readonly createdAt: string;
  readonly links?: TaskLinks;
  readonly dependencies?: readonly string[];
}

export type ParsedTaskEvent = TaskEvent;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function asTaskSource(value: unknown): TaskSource {
  const source = asString(value, 'source');
  if (source === 'issue' || source === 'manual' || source === 'pr' || source === 'external') {
    return source;
  }
  throw new Error('invalid source');
}

function asTaskEventType(value: unknown): TaskEventType {
  const type = asString(value, 'type');
  if (
    type === 'selected'
    || type === 'started'
    || type === 'heartbeat'
    || type === 'completed'
    || type === 'failed'
    || type === 'blocked'
    || type === 'cancelled'
  ) {
    return type;
  }
  throw new Error('invalid type');
}

function parseLinks(value: unknown): TaskLinks | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value);
  return {
    orchestrationLog:
      typeof obj['orchestrationLog'] === 'string' ? obj['orchestrationLog'] : undefined,
    sessionLog: typeof obj['sessionLog'] === 'string' ? obj['sessionLog'] : undefined,
    rawOutput: typeof obj['rawOutput'] === 'string' ? obj['rawOutput'] : undefined,
  };
}

function statusFromEventType(type: TaskEventType): TaskStatus {
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

export function parseTaskMeta(json: string): ParsedTaskMeta {
  const parsed = asObject(JSON.parse(json) as unknown);
  const schemaVersion = parsed['schemaVersion'] === undefined ? 1 : asNumber(parsed['schemaVersion'], 'schemaVersion');
  return {
    id: asString(parsed['id'], 'id'),
    schemaVersion,
    source: asTaskSource(parsed['source']),
    sourceRef: asString(parsed['sourceRef'], 'sourceRef'),
    title: asString(parsed['title'], 'title'),
    assignedAgent: asString(parsed['assignedAgent'], 'assignedAgent'),
    createdAt: asString(parsed['createdAt'], 'createdAt'),
    links: parseLinks(parsed['links']),
    dependencies: Array.isArray(parsed['dependencies'])
      ? parsed['dependencies'].filter((v): v is string => typeof v === 'string')
      : undefined,
  };
}

export function serializeTaskMeta(meta: ParsedTaskMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export function parseTaskEvent(json: string): ParsedTaskEvent {
  const parsed = asObject(JSON.parse(json) as unknown);
  const schemaVersion = parsed['schemaVersion'] === undefined ? 1 : asNumber(parsed['schemaVersion'], 'schemaVersion');
  return {
    schemaVersion,
    id: asString(parsed['id'], 'id'),
    type: asTaskEventType(parsed['type']),
    attemptId: asString(parsed['attemptId'], 'attemptId'),
    timestamp: asString(parsed['timestamp'], 'timestamp'),
    summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : undefined,
    assignedAgent: typeof parsed['assignedAgent'] === 'string' ? parsed['assignedAgent'] : undefined,
    branchName: typeof parsed['branchName'] === 'string' ? parsed['branchName'] : undefined,
    prNumber: typeof parsed['prNumber'] === 'number' ? parsed['prNumber'] : undefined,
    links: parseLinks(parsed['links']),
  };
}

export function serializeTaskEvent(event: ParsedTaskEvent): string {
  return `${JSON.stringify(event, null, 2)}\n`;
}

export function projectTaskRecord(meta: ParsedTaskMeta, events: ParsedTaskEvent[]): TaskRecord {
  const sortedEvents = [...events].sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
    return a.timestamp.localeCompare(b.timestamp);
  });

  let status: TaskStatus = 'selected';
  let latestAttemptId = '';
  let updatedAt = meta.createdAt;
  let assignedAgent = meta.assignedAgent;
  let branchName: string | undefined;
  let prNumber: number | undefined;
  let links: TaskLinks | undefined = meta.links;
  const attempts = new Set<string>();

  for (const event of sortedEvents) {
    status = statusFromEventType(event.type);
    latestAttemptId = event.attemptId;
    attempts.add(event.attemptId);
    updatedAt = event.timestamp;
    if (event.assignedAgent) assignedAgent = event.assignedAgent;
    if (event.branchName) branchName = event.branchName;
    if (typeof event.prNumber === 'number') prNumber = event.prNumber;
    if (event.links) links = { ...(links ?? {}), ...event.links };
  }

  return {
    id: meta.id,
    schemaVersion: meta.schemaVersion,
    source: meta.source,
    sourceRef: meta.sourceRef,
    title: meta.title,
    status,
    assignedAgent,
    createdAt: meta.createdAt,
    updatedAt,
    latestAttemptId,
    attemptCount: attempts.size,
    branchName,
    prNumber,
    links,
    dependencies: meta.dependencies,
  };
}
