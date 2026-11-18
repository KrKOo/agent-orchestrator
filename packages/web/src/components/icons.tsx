// Shared icon vocabulary (lucide-react): one icon per step kind and per run/step status.
import type { RunStatus, Step, StepStatus } from "@orch/protocol";
import {
  Ban,
  Brain,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Hand,
  LoaderCircle,
  type LucideIcon,
  Mail,
  MessageSquareText,
  Repeat,
  ShieldQuestion,
  SkipForward,
  Split,
  SquareSlash,
  SquareTerminal,
  Terminal,
  Upload,
} from "lucide-react";

const KIND_ICON: Record<Step["kind"], LucideIcon> = {
  prompt: Mail,
  skill: Brain,
  command: Terminal,
  slash: SquareSlash,
  shell: SquareTerminal,
  git_commit: GitCommitHorizontal,
  git_push: Upload,
  github_pr: GitPullRequestArrow,
  intervention: Hand,
  github_comment: MessageSquareText,
  loop: Repeat,
  condition: Split,
};

/** The step kind's icon; decorative unless `label` is given (then it is announced as an image). */
export function KindIcon({ kind, size = 16, label }: { kind: Step["kind"]; size?: number; label?: string }) {
  const Icon = KIND_ICON[kind];
  return label ? (
    <Icon size={size} role="img" aria-label={label} className="kind-glyph" />
  ) : (
    <Icon size={size} aria-hidden className="kind-glyph" />
  );
}

const STATUS_ICON: Record<RunStatus | StepStatus, LucideIcon> = {
  pending: CircleDashed,
  queued: Clock,
  assigned: Clock,
  running: LoaderCircle,
  awaiting_approval: ShieldQuestion,
  awaiting_input: CirclePause,
  succeeded: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
  skipped: SkipForward,
};

/** Status glyph colored like its chip (`.status-icon.s-<status>`); always labelled for screen readers. */
export function StatusIcon({ status, size = 16 }: { status: RunStatus | StepStatus; size?: number }) {
  const Icon = STATUS_ICON[status] ?? CircleDashed;
  const label = status.replaceAll("_", " ");
  return (
    <Icon
      size={size}
      role="img"
      aria-label={label}
      className={`status-icon s-${status}${status === "running" ? " spin" : ""}`}
    >
      <title>{label}</title>
    </Icon>
  );
}
