import { describe, expect, it } from "vite-plus/test";

import {
  extractOmpAcpToolFields,
  extractOmpSubagentSeeds,
  isOmpTaskToolCall,
  projectOmpOpenTasksTerminal,
  projectOmpTaskToolCall,
} from "./OmpTaskProjection.ts";

const BATCH_INPUT = {
  context: "Two independent strands.",
  i: "Dispatching skill-fix and auth-hardening agents",
  tasks: [
    { name: "SkillDriftFix", agent: "task", task: "Clean skill drift." },
    { name: "AuthHardening", agent: "scout", task: "Harden auth." },
  ],
};

describe("OmpTaskProjection", () => {
  it("recognizes OMP batch and flat task tool payloads", () => {
    expect(isOmpTaskToolCall({ title: "task", rawInput: {} })).toBe(true);
    expect(isOmpTaskToolCall({ title: "Reading file", rawInput: { path: "a.ts" } })).toBe(false);
    expect(isOmpTaskToolCall({ title: "Dispatching agents", rawInput: BATCH_INPUT })).toBe(true);
    expect(
      isOmpTaskToolCall({
        title: "Spawn scout",
        rawInput: { name: "PerfRendering", agent: "scout", task: "Look at perf." },
      }),
    ).toBe(true);
    expect(
      isOmpTaskToolCall({
        title: "Dispatching agents",
        rawOutput: { details: { progress: [{ id: "ScoutA", status: "running" }] } },
      }),
    ).toBe(true);
    expect(isOmpTaskToolCall({ title: "Dispatching agents", knownTaskIds: ["ScoutA"] })).toBe(true);
  });

  it("extracts one Agents-panel seed per nested task", () => {
    expect(
      extractOmpSubagentSeeds({ toolCallId: "call-1", rawInput: BATCH_INPUT }).map((seed) => ({
        taskId: seed.taskId,
        title: seed.title,
        role: seed.role,
      })),
    ).toEqual([
      { taskId: "SkillDriftFix", title: "SkillDriftFix", role: "task" },
      { taskId: "AuthHardening", title: "AuthHardening", role: "scout" },
    ]);
  });

  it("emits task.started for each spawn when the ACP tool_call arrives", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "Dispatching skill-fix and auth-hardening agents",
      kind: "other",
      status: "pending",
      rawInput: BATCH_INPUT,
    });

    expect(projected.taskIds).toEqual(["SkillDriftFix", "AuthHardening"]);
    expect(projected.events.map((event) => event.type)).toEqual(["task.started", "task.started"]);
    expect(projected.events[0]).toMatchObject({
      type: "task.started",
      taskId: "SkillDriftFix",
      title: "SkillDriftFix",
      role: "task",
      toolUseId: "call-1",
    });
    expect(projected.events[1]).toMatchObject({
      type: "task.started",
      taskId: "AuthHardening",
      role: "scout",
    });
  });

  it("does not re-start known agents; progress and completion follow the child status", () => {
    const progress = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "task",
      status: "in_progress",
      rawInput: BATCH_INPUT,
      rawOutput: {
        details: {
          progress: [
            {
              index: 0,
              id: "SkillDriftFix",
              agent: "task",
              status: "running",
              lastIntent: "Editing SKILL.md",
              currentTool: "edit",
            },
          ],
        },
      },
      knownTaskIds: ["SkillDriftFix", "AuthHardening"],
    });

    expect(progress.events).toHaveLength(1);
    expect(progress.events[0]).toMatchObject({
      type: "task.progress",
      taskId: "SkillDriftFix",
      summary: "Editing SKILL.md",
      lastToolName: "edit",
      status: "running",
    });

    const completed = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "task",
      status: "completed",
      rawInput: BATCH_INPUT,
      rawOutput: {
        details: {
          results: [
            { index: 0, id: "SkillDriftFix", agent: "task", exitCode: 0, lastIntent: "Done" },
            {
              index: 1,
              id: "AuthHardening",
              agent: "scout",
              exitCode: 1,
              error: "auth test failed",
            },
          ],
        },
      },
      knownTaskIds: ["SkillDriftFix", "AuthHardening"],
    });

    expect(
      completed.events.map((event) => [event.taskId, event.type, event.completedStatus]),
    ).toEqual([
      ["SkillDriftFix", "task.completed", "completed"],
      ["AuthHardening", "task.completed", "failed"],
    ]);
  });

  it("marks leftover agents completed when the parent task tool finishes", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "task",
      status: "completed",
      rawInput: BATCH_INPUT,
      knownTaskIds: ["SkillDriftFix", "AuthHardening"],
    });

    expect(projected.events).toHaveLength(2);
    expect(projected.events.every((event) => event.type === "task.completed")).toBe(true);
    expect(projected.events.every((event) => event.completedStatus === "completed")).toBe(true);
  });

  it("maps an aborted child result to a stopped task", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-abort",
      title: "task",
      status: "failed",
      rawInput: { name: "ScoutA", agent: "scout", task: "Look around." },
      rawOutput: {
        results: [{ id: "ScoutA", agent: "scout", aborted: true, exitCode: 1 }],
      },
    });

    const completed = projected.events.find((event) => event.type === "task.completed");
    expect(completed).toMatchObject({
      taskId: "ScoutA",
      completedStatus: "stopped",
      status: "cancelled",
    });
  });

  it("projects progress when only rawOutput remains (intent title, no rawInput)", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "Dispatching skill-fix and auth-hardening agents",
      status: "in_progress",
      rawOutput: {
        details: {
          progress: [
            {
              id: "SkillDriftFix",
              agent: "task",
              status: "running",
              lastIntent: "Editing SKILL.md",
              currentTool: "edit",
            },
          ],
        },
      },
    });

    expect(projected.taskIds).toEqual(["SkillDriftFix"]);
    expect(projected.events.map((event) => event.type)).toEqual(["task.started", "task.progress"]);
    expect(projected.events[1]).toMatchObject({
      type: "task.progress",
      taskId: "SkillDriftFix",
      summary: "Editing SKILL.md",
      lastToolName: "edit",
    });
  });

  it("surfaces retry/backoff on the child instead of looking stuck", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "task",
      status: "in_progress",
      rawOutput: {
        details: {
          progress: [
            {
              id: "ScoutA",
              agent: "scout",
              status: "running",
              retryState: {
                attempt: 2,
                maxAttempts: 5,
                delayMs: 4000,
                errorMessage: "429 rate limited",
              },
            },
          ],
        },
      },
    });

    expect(projected.events[1]).toMatchObject({
      type: "task.progress",
      taskId: "ScoutA",
      summary: "retry 2/5: 429 rate limited",
    });
  });

  it("does not leftover-complete detached async children while the job is still running", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "task",
      status: "completed",
      rawInput: BATCH_INPUT,
      rawOutput: {
        details: {
          async: { state: "running", jobId: "job-1", type: "task" },
          progress: [
            { id: "SkillDriftFix", agent: "task", status: "running", lastIntent: "still working" },
          ],
        },
      },
      knownTaskIds: ["SkillDriftFix", "AuthHardening"],
    });

    expect(projected.events.some((event) => event.type === "task.completed")).toBe(false);
    expect(projected.events.some((event) => event.type === "task.progress")).toBe(true);
  });

  it("completes leftover known ids even when compacted input dropped the spawn args", () => {
    const projected = projectOmpTaskToolCall({
      toolCallId: "call-1",
      title: "Dispatching agents",
      status: "completed",
      knownTaskIds: ["SkillDriftFix", "AuthHardening"],
    });

    expect(
      projected.events.map((event) => [event.taskId, event.type, event.completedStatus]),
    ).toEqual([
      ["SkillDriftFix", "task.completed", "completed"],
      ["AuthHardening", "task.completed", "completed"],
    ]);
  });

  it("settles open children as stopped when the parent turn is cancelled", () => {
    const projected = projectOmpOpenTasksTerminal({
      toolCallId: "call-1",
      taskIds: ["SkillDriftFix", "AuthHardening"],
      rawInput: BATCH_INPUT,
      completedStatus: "stopped",
    });

    expect(projected.events).toHaveLength(2);
    expect(projected.events.every((event) => event.completedStatus === "stopped")).toBe(true);
    expect(projected.events[0]).toMatchObject({
      taskId: "SkillDriftFix",
      title: "SkillDriftFix",
      role: "task",
    });
  });

  it("reads tool fields from a session/update envelope", () => {
    expect(
      extractOmpAcpToolFields({
        sessionId: "sess",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-9",
          title: "task",
          kind: "other",
          rawInput: BATCH_INPUT,
        },
      }),
    ).toMatchObject({
      toolCallId: "call-9",
      title: "task",
      kind: "other",
    });
  });
});
