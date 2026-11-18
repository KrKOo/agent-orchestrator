import { describe, expect, test } from "bun:test";
import { filterStatuses, parseRunsFilter, runsFilterSearch } from "../src/runsFilter";

const parse = (search: string) => parseRunsFilter(new URLSearchParams(search));

describe("runs filter URL", () => {
  test("a status list matching a tab selects that tab regardless of order", () => {
    expect(parse("?status=awaiting_approval,awaiting_input")).toEqual({ tab: "attention", q: "" });
    expect(parse("")).toEqual({ tab: "all", q: "" });
    expect(parse("?status=")).toEqual({ tab: "all", q: "" });
  });

  test("unknown statuses are dropped so the server never sees them; leftovers no tab matches stay custom", () => {
    expect(parse("?status=failed,bogus")).toEqual({ tab: "failed", q: "" });
    expect(parse("?status=bogus")).toEqual({ tab: "all", q: "" });
    const custom = parse("?status=cancelled,failed");
    expect(custom).toEqual({ tab: "custom", statuses: ["cancelled", "failed"], q: "" });
    expect(filterStatuses(custom)).toEqual(["cancelled", "failed"]);
  });

  test("round-trips tab, search text and flow id", () => {
    const filter = parse("?status=awaiting_input,awaiting_approval&q=fix%20%26%20ship&flowId=f1");
    expect(filter).toEqual({ tab: "attention", q: "fix & ship", flowId: "f1" });
    const search = runsFilterSearch(filter);
    expect(search).toBe("?status=awaiting_input,awaiting_approval&q=fix%20%26%20ship&flowId=f1");
    expect(parse(search)).toEqual(filter);
  });

  test("the All tab and blank search serialize to no query at all", () => {
    expect(runsFilterSearch({ tab: "all", q: "  " })).toBe("");
  });
});
