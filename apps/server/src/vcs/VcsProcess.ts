import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type VcsError,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: ProcessRunner.ProcessRunInput["outputMode"];
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Present on real process output; optional so narrow test doubles remain lightweight. */
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/VcsProcess") {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const VCS_PROCESS_CONCURRENCY = 8;
const GITHUB_PROCESS_CONCURRENCY = 4;

export const CHECKPOINT_CAPTURE_OPERATION = "GitVcsDriver.checkpoints.captureCheckpoint";
const MAX_STDERR_LOG_CHARS = 2_000;
const STDERR_REDACTED_MARKER = "[redacted]";

/**
 * Best-effort redaction for server-side stderr diagnostics. VCS failures never
 * carry stderr across the wire (only its length), so this only guards what
 * lands in the journal: token-bearing URLs, `--token=...` echoes, and
 * `key=value` credential lines.
 */
const redactSecrets = (text: string): string =>
  text.replace(
    /(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s"']+)/gi,
    STDERR_REDACTED_MARKER,
  );

const classifyNonZeroExit = (command: string, stderr: string): VcsProcessExitFailureKind => {
  const normalized = stderr.toLowerCase();

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("not logged in") ||
    normalized.includes("gh auth login") ||
    normalized.includes("glab auth login") ||
    normalized.includes("az devops login") ||
    normalized.includes("please run az login") ||
    normalized.includes("no oauth token") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    normalized.includes("api rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429")
  ) {
    return "rate-limited";
  }

  if (
    (command === "gh" &&
      (normalized.includes("could not resolve to a pullrequest") ||
        normalized.includes("repository.pullrequest") ||
        normalized.includes("no pull requests found for branch") ||
        normalized.includes("pull request not found"))) ||
    (command === "glab" &&
      (normalized.includes("merge request not found") ||
        normalized.includes("not found") ||
        normalized.includes("404"))) ||
    (command === "az" &&
      normalized.includes("pull request") &&
      (normalized.includes("not found") || normalized.includes("does not exist")))
  ) {
    return "not-found";
  }

  return "command-failed";
};

// Classify before discarding stderr; keep paths and process output out of errors.
const isTransientGitExit = (stderr: string) =>
  /unable to create [^\n]*\.lock['"]?: file exists/i.test(stderr) ||
  /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(stderr);

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const vcsProcesses = yield* Semaphore.make(VCS_PROCESS_CONCURRENCY);
  const githubProcesses = yield* Semaphore.make(GITHUB_PROCESS_CONCURRENCY);

  const runUnbounded = Effect.fn("VcsProcess.runUnbounded")(function* (input: VcsProcessInput) {
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    };

    const result = yield* processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: input.outputMode ?? "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.tapError((error) =>
          error._tag === "ProcessTimeoutError"
            ? Effect.logWarning("VCS process timed out").pipe(
                Effect.annotateLogs({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  timeoutMs: error.timeoutMs,
                }),
              )
            : Effect.void,
        ),
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      );

    if (result.code === null) {
      return yield* new VcsProcessMissingExitCodeError(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      const failureKind = classifyNonZeroExit(input.command, result.stderr);
      // Authentication stderr may echo credentials; never retain or log it.
      // Every other failure gets a sanitized stderr snippet in the journal so
      // the real CLI error survives for diagnosis (the wire error keeps only
      // stderrLength by design).
      if (failureKind !== "authentication") {
        yield* Effect.logWarning("VCS process exited with a non-zero status").pipe(
          Effect.annotateLogs({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            exitCode: result.code,
            failureKind,
            stderr: redactSecrets(result.stderr).slice(0, MAX_STDERR_LOG_CHARS),
            stderrTruncated: result.stderrTruncated,
          }),
        );
      }
      return yield* VcsProcessExitError.fromProcessExit(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        failureKind,
        input.command === "git" &&
          failureKind === "command-failed" &&
          isTransientGitExit(result.stderr),
      );
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8 ?? false,
      stderrInvalidUtf8: result.stderrInvalidUtf8 ?? false,
    } satisfies VcsProcessOutput;
  });

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const bounded = vcsProcesses.withPermits(1)(runUnbounded(input));
    if (
      input.command === "git" &&
      input.operation === CHECKPOINT_CAPTURE_OPERATION &&
      input.onStdoutChunk === undefined
    ) {
      // Retry the failed command, retaining the private index/tree and recovery's outer deadline.
      return yield* bounded.pipe(
        Effect.tapError((error) =>
          Effect.logDebug("checkpoint Git command failed", {
            operation: input.operation,
            errorTag: error._tag,
          }),
        ),
        Effect.retry({
          times: 2,
          while: (error) => error._tag === "VcsProcessExitError" && error.retryable === true,
          schedule: Schedule.spaced(Duration.millis(75)),
        }),
      );
    }
    return yield* input.command === "gh" ? githubProcesses.withPermits(1)(bounded) : bounded;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer));
