import { DOMAIN_RE, type NetworkPolicy } from "@orch/protocol";

/** Squid config for a run's egress proxy: the only route out of the sandbox's internal network. */
export function renderSquidConf(policy: NetworkPolicy, ports: { mcp: number; gateway: number }): string {
  for (const domain of policy.allow) {
    if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid allow entry: ${domain}`);
  }
  const lines = [
    "http_port 3128",
    "acl orch_host dstdomain host.docker.internal",
    `acl orch_host_ports port ${ports.mcp} ${ports.gateway}`,
    "acl web_ports port 80 443",
    "acl CONNECT method CONNECT",
  ];
  if (policy.mode === "allowlist" && policy.allow.length > 0) lines.push(`acl allow_dst dstdomain ${policy.allow.join(" ")}`);
  lines.push("http_access allow orch_host orch_host_ports");
  if (policy.mode === "allowlist" && policy.allow.length > 0) lines.push("http_access allow allow_dst web_ports");
  if (policy.mode === "open") lines.push("http_access allow web_ports");
  lines.push(
    "http_access deny all",
    "access_log stdio:/dev/stdout",
    // Operational settings for a single-purpose, cache-less container.
    "cache_log /dev/stderr",
    "cache deny all",
    "pid_filename none",
    "shutdown_lifetime 0 seconds",
  );
  return `${lines.join("\n")}\n`;
}
