import { type FlowBinding, type InputDef, isGitHubInput } from "@orch/protocol";

/**
 * Run dialog prefill of an input, as the text the API takes: its default, else the value of the one field it sets,
 * so the dialog shows the setting the run gets when the input is left as is. An input bound to several fields
 * starts empty: any one field's value would overwrite the others, while an empty input keeps each field's own.
 */
export function initialInputValue(d: InputDef, bindings: FlowBinding[]): string {
  if (isGitHubInput(d)) return "";
  if (d.default !== undefined) return String(d.default);
  const bound = bindings.filter((b) => b.key === d.key);
  if (bound.length > 1) return "";
  // An unbound boolean is a plain checkbox: unchecked sends false.
  if (bound.length === 0) return d.type === "boolean" ? "false" : "";
  const value = bound[0]!.value;
  const text = Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value);
  if (d.type === "select") return d.options.some((o) => o.value === text) ? text : "";
  if (d.type === "boolean") return text === "true" ? "true" : "false";
  return text;
}
