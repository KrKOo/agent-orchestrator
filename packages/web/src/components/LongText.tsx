import { memo, useState } from "react";
import Markdown from "react-markdown";

/** Markdown parsing costs ~1 s per 400 KB; longer text renders as plain text instead. */
const MARKDOWN_MAX_CHARS = 100_000;
/** Plain text past this length shows a preview until "Show all". */
const PLAIN_MAX_CHARS = 200_000;
const PREVIEW_CHARS = 20_000;

/**
 * `text` as Markdown (or a plain `<pre>`), degrading to a plain-text preview with "Show all" when it
 * is too long to render quickly. Memoized: unchanged text is not re-parsed when the parent re-renders.
 */
export const LongText = memo(function LongText({ text, markdown = false, className = "" }: { text: string; markdown?: boolean; className?: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= (markdown ? MARKDOWN_MAX_CHARS : PLAIN_MAX_CHARS)) {
    return markdown ? (
      <div className={`markdown ${className}`}>
        <Markdown>{text}</Markdown>
      </div>
    ) : (
      <pre className={className}>{text}</pre>
    );
  }
  const shown = all ? text : text.slice(0, PREVIEW_CHARS);
  return (
    <div className={className}>
      <pre>{shown}</pre>
      <div className="row gap small muted">
        <span>
          {text.length.toLocaleString()} characters{markdown ? ", too long to render as Markdown" : ""}
          {shown.length < text.length ? ` — showing the first ${shown.length.toLocaleString()}` : ""}
        </span>
        {shown.length < text.length && (
          <button type="button" className="btn small" onClick={() => setAll(true)}>
            Show all
          </button>
        )}
      </div>
    </div>
  );
});
