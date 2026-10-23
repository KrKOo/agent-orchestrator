FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq \
 && rm -rf /var/lib/apt/lists/*

ARG OMP_URL
ARG OMP_SHA256
RUN test -n "$OMP_URL" && test -n "$OMP_SHA256" \
 && curl -fsSL -o /usr/local/bin/omp "$OMP_URL" \
 && echo "$OMP_SHA256  /usr/local/bin/omp" | sha256sum -c - \
 && chmod 755 /usr/local/bin/omp

ENV PI_NATIVES_DIR=/opt/omp-natives
# Pre-extract natives (`--version` alone does not load them; `--help` does)
# and make them readable for arbitrary --user uids.
RUN mkdir -p "$PI_NATIVES_DIR" && export HOME=/tmp/omp-build \
 && omp --version && (omp acp --help >/dev/null 2>&1 || true) \
 && ls "$PI_NATIVES_DIR"/*/*.node \
 && chmod -R a+rX "$PI_NATIVES_DIR" && rm -rf /tmp/omp-build

COPY --chmod=755 orch-entry.sh /usr/local/bin/orch-entry
ENTRYPOINT ["/usr/local/bin/orch-entry"]
CMD ["sleep", "infinity"]
