// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type { DatabaseSync } from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialOmpScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseOmpLine,
  parseOpencodeMessage,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 *
 * `fileName` restricts the walk to a single basename (Grok's `updates.jsonl`).
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const fileName = options?.fileName;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (fileName !== undefined) {
        if (entry.name !== fileName) continue;
      } else if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  // opencode persists its log in SQLite rather than JSONL; the file-based
  // readers below cannot parse it.
  if (provider === "opencode") return readOpencodeDbRecords(filePath);

  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const ompState = initialOmpScanState();

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "grok") {
        if (!mightCarryUsage(line, provider)) continue;
        for (const grokRecord of parseGrokLine(line)) records.push(grokRecord);
        continue;
      }

      if (provider === "omp") {
        if (!mightCarryUsage(line, provider) && !line.includes('"type":"session"')) continue;
        const record = parseOmpLine(line, ompState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}

/**
 * Reads priced assistant messages from the opencode SQLite database.
 *
 * opencode persists its session log in a SQLite database rather than JSONL, so
 * this queries the `message` table and runs each row's `data` document through
 * {@link parseOpencodeMessage}. The row count is small (a few thousand even on
 * long-lived installs), so materialising every row is fine.
 *
 * Returns `null` when the database could not be opened or read, matching the
 * JSONL reader's failure semantics for the scan cache.
 */
export async function readOpencodeDbRecords(
  dbPath: string,
): Promise<readonly UsageRecord[] | null> {
  // node:sqlite exists only in the Node runtime the server ships with; the
  // Bun-side test bundle cannot load it statically, hence the lazy import
  // despite the static type import above.
  const { DatabaseSync } = await import("node:sqlite");
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const rows = database
      .prepare("SELECT data, session_id FROM message")
      .all() as unknown as readonly {
      data: string;
      session_id: string;
    }[];

    const records: UsageRecord[] = [];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const record = parseOpencodeMessage(data, row.session_id);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a read-only connection is best-effort.
    }
  }
}
