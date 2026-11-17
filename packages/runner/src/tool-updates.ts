import type { SessionUpdate } from "@orch/protocol";

const UNFINISHED = ["pending", "in_progress"];

/**
 * Keeps tool-call progress from flooding a run's events. omp's `task` tool reports progress every few
 * milliseconds as `tool_call_update`s that each repeat a full `rawOutput` snapshot (every subagent's
 * task text, ~35 KB): one long task stored over 1 GB of events, more than a browser replay can
 * serialize. Every `rawOutput` supersedes the previous one, so only the final one is worth keeping
 * (subagent transcripts arrive separately as `subagent.*` events):
 * - an unfinished (`pending`/`in_progress`) update drops `rawOutput`;
 * - an update equal to the previous update of the same tool call in the same step is dropped: the run
 *   view merges updates field by field, so re-applying the same update changes nothing.
 * One instance per run.
 */
export class ToolUpdateCompactor {
  /** JSON of the last emitted update per unfinished tool call, keyed by step and tool call id. */
  private readonly last = new Map<string, string>();

  /** The update to emit for `stepId`, or null when it would change nothing. */
  compact(update: SessionUpdate, stepId: string): SessionUpdate | null {
    if (update.sessionUpdate !== "tool_call_update" || typeof update.toolCallId !== "string") return update;
    const key = `${stepId}\0${update.toolCallId}`;
    if (!UNFINISHED.includes(update.status as string)) {
      // Finished (or no status): passes through untouched; stop tracking instead of holding its output.
      this.last.delete(key);
      return update;
    }
    const { rawOutput: _, ...kept } = update;
    const json = JSON.stringify(kept);
    if (this.last.get(key) === json) return null;
    this.last.set(key, json);
    return kept;
  }
}
