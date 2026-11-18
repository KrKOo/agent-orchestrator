FROM debian:trixie-slim

# Build toolchain and CLI basics. Versioned language runtimes come from mise/rustup below. libatomic1 is needed by
# the official Node.js binaries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config cmake make autoconf automake libtool \
      libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libatomic1 \
      git git-lfs \
      curl wget ca-certificates unzip zip xz-utils zstd bzip2 \
      file less patch diffutils procps tree \
      ripgrep fd-find jq sqlite3 \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Arch comes from dpkg rather than TARGETARCH, which only BuildKit sets.
ARG MISE_VERSION=2026.11.9
ARG MISE_SHA256_ARM64=b8dd05af6447cee933928664982a8cb2fa646e6951cfc8539db23ce2554a7b04
ARG MISE_SHA256_AMD64=f13f3e5ec88807e0161669b3aa07a91d84478cdf1e95b5b92b63f85a25d42395
RUN case "$(dpkg --print-architecture)" in \
      arm64) arch=arm64 sum="$MISE_SHA256_ARM64" ;; \
      amd64) arch=x64 sum="$MISE_SHA256_AMD64" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}" \
 && echo "$sum  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise

# Preinstalled tools for every uid: /usr/local/share/mise/{installs,shims}, read-only at runtime. mise verifies
# the downloads (published checksums / aqua registry).
COPY mise.toml /etc/mise/config.toml
RUN MISE_YES=1 mise install --system && mise reshim --system && rm -rf /root/.cache /root/.local

# Rust via rustup directly: mise's rust backend keeps toolchains in the building user's ~/.rustup. The image's
# /usr/local/rustup stays read-only; orch-entry seeds a writable RUSTUP_HOME in $HOME from it (see there), and
# CARGO_HOME moves to $HOME below.
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUST_VERSION=1.100.0
RUN case "$(dpkg --print-architecture)" in \
      arm64) triple=aarch64-unknown-linux-gnu sum="$RUSTUP_SHA256_ARM64" ;; \
      amd64) triple=x86_64-unknown-linux-gnu sum="$RUSTUP_SHA256_AMD64" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init" \
 && echo "$sum  /tmp/rustup-init" | sha256sum -c - \
 && chmod 755 /tmp/rustup-init \
 && RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo /tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain "$RUST_VERSION" --component clippy,rustfmt \
 && rm -rf /tmp/rustup-init /usr/local/cargo/registry \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo

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

# Runtime installs go to $HOME (a per-run volume) and land on PATH ahead of the preinstalled versions.
# pip needs no PIP_USER: it falls back to --user when site-packages is read-only, and PIP_USER would break venvs.
# Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY is set, and the proxy is the only way out.
# No MISE_YES here (only on the build-time install): every runtime call goes through the mise shims, and MISE_YES
# would auto-trust a mise.toml in the workspace, letting a PR's `[env]`/hooks run code on any `node`/`python3` call.
ENV PATH=/home/agent/.local/bin:/home/agent/.cargo/bin:/home/agent/go/bin:/home/agent/.local/share/mise/shims:/usr/local/share/mise/shims:/usr/local/cargo/bin:$PATH \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    GOPATH=/home/agent/go \
    CARGO_HOME=/home/agent/.cargo \
    RUSTUP_HOME=/home/agent/.rustup \
    UV_TOOL_BIN_DIR=/home/agent/.local/bin \
    NODE_USE_ENV_PROXY=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# A new named volume copies this directory, mode included, so any host uid can write the run's $HOME.
RUN mkdir -m 1777 /home/agent

COPY sandbox-guide.md /opt/orch/AGENTS.md
COPY --chmod=755 orch-entry.sh /usr/local/bin/orch-entry

# Fail the build on a broken pin: every tool must run as an arbitrary non-root uid against the read-only installs,
# behind the real entrypoint (which seeds the Rust home). Offline, so mise and rustup cannot quietly auto-install a
# copy into the throwaway home instead (`RUN --network=none` would need BuildKit).
RUN setpriv --reuid=4242 --regid=4242 --clear-groups env HOME=/tmp/check RUSTUP_HOME=/tmp/check/.rustup \
      MISE_OFFLINE=1 RUSTUP_AUTO_INSTALL=0 orch-entry sh -euc ' \
      mise --version; node -v; npm -v; corepack --version; bun -v; \
      python3 -V; python3 -m pip --version; uv -V; go version; \
      cargo -V; rustc -V; cargo clippy -V; rustfmt -V; cargo binstall -V; rustup show active-toolchain; \
      yq --version; shellcheck --version; gcc --version | head -1; cmake --version | head -1; \
      git lfs version; rg --version | head -1; fd --version; jq --version; sqlite3 --version' \
 && rm -rf /tmp/check \
 && test -z "$(ls -A /home/agent)"

ENTRYPOINT ["/usr/local/bin/orch-entry"]
CMD ["sleep", "infinity"]
