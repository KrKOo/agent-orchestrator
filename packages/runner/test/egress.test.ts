import { describe, expect, test } from "bun:test";
import { renderSquidConf } from "../src/sandbox/egress";

const ports = { mcp: 7802, gateway: 7804 };
const HEAD = [
  "http_port 3128",
  "acl orch_host dstdomain host.docker.internal",
  "acl orch_host_ports port 7802 7804",
  "acl web_ports port 80 443",
  "acl CONNECT method CONNECT",
];

/** Access-control part of the config (operational trailer lines excluded). */
const rules = (conf: string) => conf.split("\n").slice(0, conf.split("\n").indexOf("access_log stdio:/dev/stdout") + 1);

describe("renderSquidConf", () => {
  test("gateway_only allows only the orchestrator host ports", () => {
    const conf = renderSquidConf({ mode: "gateway_only", allow: ["example.com"] }, ports);
    expect(rules(conf)).toEqual([
      ...HEAD,
      "http_access allow orch_host orch_host_ports",
      "http_access deny all",
      "access_log stdio:/dev/stdout",
    ]);
  });

  test("allowlist adds the allowed domains on web ports", () => {
    const conf = renderSquidConf({ mode: "allowlist", allow: ["example.com", ".github.com"] }, ports);
    expect(rules(conf)).toEqual([
      ...HEAD,
      "acl allow_dst dstdomain example.com .github.com",
      "http_access allow orch_host orch_host_ports",
      "http_access allow allow_dst web_ports",
      "http_access deny all",
      "access_log stdio:/dev/stdout",
    ]);
  });

  test("allowlist with no domains omits the domain ACL", () => {
    const conf = renderSquidConf({ mode: "allowlist", allow: [] }, ports);
    expect(conf).not.toContain("allow_dst");
  });

  test("open allows any host on web ports", () => {
    const conf = renderSquidConf({ mode: "open", allow: [] }, ports);
    expect(rules(conf)).toEqual([
      ...HEAD,
      "http_access allow orch_host orch_host_ports",
      "http_access allow web_ports",
      "http_access deny all",
      "access_log stdio:/dev/stdout",
    ]);
  });

  test("rejects allow entries that are not domains", () => {
    expect(() => renderSquidConf({ mode: "allowlist", allow: ["example.com all"] }, ports)).toThrow("Invalid allow entry");
  });
});
