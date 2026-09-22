/**
 * Maps OMP's `task` tool (batch or single spawn) onto T3's task.* runtime
 * events so subagents appear in the Agents panel.
 *
 * OMP does not open a child ACP session per spawn. The parent only emits one
 * ACP tool_call named `task` (kind "other") whose rawInput holds `{ context,
 * tasks: [{ name, agent, task }] }` or the flat `{ name, agent, task }` form.
 * Progress rides on later tool_call_update rawOutput (`details.progress` /
 * `details.results`).
 */

export type OmpTaskRuntimeEventType =
  | "task.started"
  | "task.progress"
  | "task.updated"
  | "task.completed";

export type OmpTaskRuntimeStatus = "running" | "completed" | "failed" | "cancelled";

export interface OmpTaskRuntimeEvent {
  readonly type: OmpTaskRuntimeEventType;
  readonly taskId: string;
  readonly title: string;
  readonly role: string;
  readonly description: string;
  readonly summary?: string;
  readonly status?: OmpTaskRuntimeStatus;
  readonly lastToolName?: string;
  readonly model?: string;
  readonly toolUseId?: string;
  readonly completedStatus?: "completed" | "failed" | "stopped";
}

export interface OmpTaskProjectionResult {
  readonly events: ReadonlyArray<OmpTaskRuntimeEvent>;
  readonly taskIds: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function acpUpdateRecord(rawPayload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawPayload)) {
    return undefined;
  }
  const update = rawPayload.update;
  if (isRecord(update)) {
    return update;
  }
  return rawPayload.sessionUpdate !== undefined ? rawPayload : undefined;
}

export function extractOmpAcpToolFields(rawPayload: unknown): {
  readonly toolCallId: string | undefined;
  readonly title: string | undefined;
  readonly kind: string | undefined;
  readonly status: string | undefined;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
} {
  const update = acpUpdateRecord(rawPayload);
  return {
    toolCallId: asTrimmedString(update?.toolCallId),
    title: asTrimmedString(update?.title),
    kind: asTrimmedString(update?.kind),
    status: asTrimmedString(update?.status),
    rawInput: update?.rawInput,
    rawOutput: update?.rawOutput,
  };
}

export function isOmpTaskToolCall(input: {
  readonly title?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly knownTaskIds?: ReadonlyArray<string>;
}): boolean {
  if (input.knownTaskIds !== undefined && input.knownTaskIds.length > 0) {
    return true;
  }
  if (hasOmpTaskSpawnArgs(input.rawInput)) {
    return true;
  }
  if (hasOmpTaskOutput(input.rawOutput)) {
    return true;
  }
  const title = input.title?.trim().toLowerCase();
  return title === "task" || title === "task tool";
}

function hasOmpTaskSpawnArgs(rawInput: unknown): boolean {
  if (!isRecord(rawInput)) {
    return false;
  }
  if (Array.isArray(rawInput.tasks)) {
    return true;
  }
  return asTrimmedString(rawInput.task) !== undefined;
}

function hasOmpTaskOutput(rawOutput: unknown): boolean {
  const details = detailsRecord(rawOutput);
  if (details === undefined) {
    return false;
  }
  return Array.isArray(details.progress) || Array.isArray(details.results);
}

function asyncTaskStillRunning(rawOutput: unknown): boolean {
  const details = detailsRecord(rawOutput);
  if (details === undefined || !isRecord(details.async)) {
    return false;
  }
  return asTrimmedString(details.async.state) === "running";
}

interface OmpSubagentSeed {
  readonly taskId: string;
  readonly title: string;
  readonly role: string;
  readonly description: string;
}

function fallbackTaskId(toolCallId: string, index: number): string {
  return `${toolCallId}:${index}`;
}

function seedFromItem(
  item: Record<string, unknown>,
  toolCallId: string,
  index: number,
): OmpSubagentSeed {
  const name = asTrimmedString(item.name);
  const role = asTrimmedString(item.agent) ?? "task";
  const assignment = asTrimmedString(item.task);
  const title = name ?? role;
  return {
    taskId: name ?? fallbackTaskId(toolCallId, index),
    title,
    role,
    description: assignment ?? title,
  };
}

export function extractOmpSubagentSeeds(input: {
  readonly toolCallId: string;
  readonly rawInput?: unknown;
}): ReadonlyArray<OmpSubagentSeed> {
  const rawInput = input.rawInput;
  if (!isRecord(rawInput)) {
    return [];
  }
  if (Array.isArray(rawInput.tasks)) {
    const seeds: Array<OmpSubagentSeed> = [];
    for (const [index, entry] of rawInput.tasks.entries()) {
      if (!isRecord(entry)) {
        continue;
      }
      seeds.push(seedFromItem(entry, input.toolCallId, index));
    }
    return seeds;
  }
  if (
    asTrimmedString(rawInput.task) !== undefined ||
    asTrimmedString(rawInput.name) !== undefined
  ) {
    return [seedFromItem(rawInput, input.toolCallId, 0)];
  }
  return [];
}

function detailsRecord(rawOutput: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  if (isRecord(rawOutput.details)) {
    return rawOutput.details;
  }
  if (Array.isArray(rawOutput.progress) || Array.isArray(rawOutput.results)) {
    return rawOutput;
  }
  return undefined;
}

function mapProgressStatus(raw: string | undefined): OmpTaskRuntimeStatus | undefined {
  switch (raw) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    case "pending":
    case "running":
      return "running";
    default:
      return undefined;
  }
}

function completedStatusFrom(
  status: OmpTaskRuntimeStatus | undefined,
): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

function progressSummary(progress: Record<string, unknown>): string | undefined {
  const retryState = isRecord(progress.retryState) ? progress.retryState : undefined;
  if (retryState !== undefined) {
    const attempt = retryState.attempt;
    const maxAttempts = retryState.maxAttempts;
    const errorMessage = asTrimmedString(retryState.errorMessage);
    const label =
      typeof attempt === "number" && typeof maxAttempts === "number"
        ? `retry ${attempt}/${maxAttempts}`
        : "retrying";
    return errorMessage ? `${label}: ${errorMessage}` : label;
  }
  const retryFailure = isRecord(progress.retryFailure) ? progress.retryFailure : undefined;
  if (retryFailure !== undefined) {
    const errorMessage = asTrimmedString(retryFailure.errorMessage);
    return errorMessage ? `blocked: ${errorMessage}` : "blocked";
  }
  const lastIntent = asTrimmedString(progress.lastIntent);
  if (lastIntent) {
    return lastIntent;
  }
  const currentTool = asTrimmedString(progress.currentTool);
  if (currentTool) {
    return `running ${currentTool}`;
  }
  const description = asTrimmedString(progress.description);
  if (description) {
    return description;
  }
  const recent = progress.recentOutput;
  if (Array.isArray(recent)) {
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const line = asTrimmedString(recent[index]);
      if (line) {
        return line;
      }
    }
  }
  return undefined;
}

function seedFromProgress(
  progress: Record<string, unknown>,
  toolCallId: string,
  index: number,
  known: ReadonlyMap<string, OmpSubagentSeed>,
): OmpSubagentSeed {
  const id = asTrimmedString(progress.id);
  const nameMatch = id !== undefined ? known.get(id) : undefined;
  if (nameMatch) {
    return nameMatch;
  }
  const byIndex = known.get(fallbackTaskId(toolCallId, index));
  if (byIndex && id === undefined) {
    return byIndex;
  }
  const role = asTrimmedString(progress.agent) ?? byIndex?.role ?? "task";
  const title = id ?? asTrimmedString(progress.description) ?? byIndex?.title ?? role;
  return {
    taskId: id ?? byIndex?.taskId ?? fallbackTaskId(toolCallId, index),
    title,
    role,
    description: asTrimmedString(progress.assignment) ?? asTrimmedString(progress.task) ?? title,
  };
}

/**
 * Turns one OMP task tool_call / tool_call_update into task.* events.
 * `knownTaskIds` is the set already started for this tool call so later
 * updates do not re-emit task.started.
 */
export function projectOmpTaskToolCall(input: {
  readonly toolCallId: string;
  readonly title?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly knownTaskIds?: ReadonlyArray<string>;
}): OmpTaskProjectionResult {
  if (
    !isOmpTaskToolCall({
      title: input.title,
      kind: input.kind,
      rawInput: input.rawInput,
      rawOutput: input.rawOutput,
      ...(input.knownTaskIds !== undefined ? { knownTaskIds: input.knownTaskIds } : {}),
    })
  ) {
    return { events: [], taskIds: input.knownTaskIds ?? [] };
  }

  const known = new Map<string, OmpSubagentSeed>();
  const seeds = extractOmpSubagentSeeds({
    toolCallId: input.toolCallId,
    rawInput: input.rawInput,
  });
  for (const seed of seeds) {
    known.set(seed.taskId, seed);
  }
  for (const taskId of input.knownTaskIds ?? []) {
    if (!known.has(taskId)) {
      known.set(taskId, {
        taskId,
        title: taskId,
        role: "task",
        description: taskId,
      });
    }
  }

  const alreadyStarted = new Set(input.knownTaskIds ?? []);
  const events: Array<OmpTaskRuntimeEvent> = [];
  const seenIds = new Set<string>(alreadyStarted);

  const startSeed = (seed: OmpSubagentSeed) => {
    if (alreadyStarted.has(seed.taskId)) {
      return;
    }
    alreadyStarted.add(seed.taskId);
    seenIds.add(seed.taskId);
    events.push({
      type: "task.started",
      taskId: seed.taskId,
      title: seed.title,
      role: seed.role,
      description: seed.description,
      toolUseId: input.toolCallId,
    });
  };

  for (const seed of seeds) {
    startSeed(seed);
  }

  const details = detailsRecord(input.rawOutput);
  const progressRows = Array.isArray(details?.progress) ? details.progress : [];
  for (const [index, row] of progressRows.entries()) {
    if (!isRecord(row)) {
      continue;
    }
    const seed = seedFromProgress(row, input.toolCallId, index, known);
    known.set(seed.taskId, seed);
    startSeed(seed);
    const status = mapProgressStatus(asTrimmedString(row.status));
    const summary = progressSummary(row);
    const lastToolName = asTrimmedString(row.currentTool);
    const model = asTrimmedString(row.resolvedModel);
    const completedStatus = completedStatusFrom(status);
    if (completedStatus !== undefined) {
      events.push({
        type: "task.completed",
        taskId: seed.taskId,
        title: seed.title,
        role: seed.role,
        description: seed.description,
        ...(summary ? { summary } : {}),
        ...(status ? { status } : {}),
        completedStatus,
        ...(lastToolName ? { lastToolName } : {}),
        ...(model ? { model } : {}),
        toolUseId: input.toolCallId,
      });
      continue;
    }
    if (summary !== undefined || lastToolName !== undefined || status === "running") {
      events.push({
        type: "task.progress",
        taskId: seed.taskId,
        title: seed.title,
        role: seed.role,
        description: seed.description,
        ...(summary ? { summary } : { summary: "Working" }),
        status: status ?? "running",
        ...(lastToolName ? { lastToolName } : {}),
        ...(model ? { model } : {}),
        toolUseId: input.toolCallId,
      });
    }
  }

  const resultRows = Array.isArray(details?.results) ? details.results : [];
  for (const [index, row] of resultRows.entries()) {
    if (!isRecord(row)) {
      continue;
    }
    const seed = seedFromProgress(row, input.toolCallId, index, known);
    known.set(seed.taskId, seed);
    startSeed(seed);
    const aborted = row.aborted === true;
    const failed = typeof row.exitCode === "number" && row.exitCode !== 0;
    const error = asTrimmedString(row.error);
    const status: OmpTaskRuntimeStatus = aborted
      ? "cancelled"
      : failed || error
        ? "failed"
        : "completed";
    const summary =
      asTrimmedString(row.lastIntent) ??
      asTrimmedString(row.description) ??
      error ??
      (aborted ? "Aborted" : undefined);
    const resolvedModel = asTrimmedString(row.resolvedModel);
    events.push({
      type: "task.completed",
      taskId: seed.taskId,
      title: seed.title,
      role: seed.role,
      description: seed.description,
      ...(summary ? { summary } : {}),
      status,
      completedStatus: completedStatusFrom(status) ?? "completed",
      ...(resolvedModel ? { model: resolvedModel } : {}),
      toolUseId: input.toolCallId,
    });
  }

  const toolStatus = input.status ?? undefined;
  if (
    (toolStatus === "completed" || toolStatus === "failed") &&
    !asyncTaskStillRunning(input.rawOutput)
  ) {
    const leftoverStatus: OmpTaskRuntimeStatus = toolStatus === "failed" ? "failed" : "completed";
    for (const seed of known.values()) {
      if (events.some((event) => event.taskId === seed.taskId && event.type === "task.completed")) {
        continue;
      }
      startSeed(seed);
      events.push({
        type: "task.completed",
        taskId: seed.taskId,
        title: seed.title,
        role: seed.role,
        description: seed.description,
        status: leftoverStatus,
        completedStatus: leftoverStatus === "failed" ? "failed" : "completed",
        toolUseId: input.toolCallId,
      });
    }
    if (known.size === 0) {
      const fallback: OmpSubagentSeed = {
        taskId: input.toolCallId,
        title: asTrimmedString(input.title) ?? "task",
        role: "task",
        description: asTrimmedString(input.title) ?? "task",
      };
      startSeed(fallback);
      events.push({
        type: "task.completed",
        taskId: fallback.taskId,
        title: fallback.title,
        role: fallback.role,
        description: fallback.description,
        status: leftoverStatus,
        completedStatus: leftoverStatus === "failed" ? "failed" : "completed",
        toolUseId: input.toolCallId,
      });
    }
  }

  return { events, taskIds: [...seenIds] };
}

/**
 * Settles every known child when the parent turn ends without a final
 * tool_call_update (Stop, prompt error, or a dropped completion row).
 */
export function projectOmpOpenTasksTerminal(input: {
  readonly toolCallId: string;
  readonly taskIds: ReadonlyArray<string>;
  readonly rawInput?: unknown;
  readonly completedStatus: "completed" | "failed" | "stopped";
}): OmpTaskProjectionResult {
  const seedsById = new Map<string, OmpSubagentSeed>();
  for (const seed of extractOmpSubagentSeeds({
    toolCallId: input.toolCallId,
    rawInput: input.rawInput,
  })) {
    seedsById.set(seed.taskId, seed);
  }
  const status: OmpTaskRuntimeStatus =
    input.completedStatus === "completed"
      ? "completed"
      : input.completedStatus === "failed"
        ? "failed"
        : "cancelled";
  const events: Array<OmpTaskRuntimeEvent> = [];
  const taskIds: Array<string> = [];
  for (const taskId of input.taskIds) {
    const seed = seedsById.get(taskId) ?? {
      taskId,
      title: taskId,
      role: "task",
      description: taskId,
    };
    taskIds.push(seed.taskId);
    events.push({
      type: "task.completed",
      taskId: seed.taskId,
      title: seed.title,
      role: seed.role,
      description: seed.description,
      status,
      completedStatus: input.completedStatus,
      toolUseId: input.toolCallId,
    });
  }
  return { events, taskIds };
}
