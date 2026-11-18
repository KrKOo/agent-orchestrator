# Sandbox environment

You run inside a disposable Docker sandbox as an unprivileged user. `$HOME` (`/home/agent`) is writable and is
deleted when the run ends.

## Preinstalled

- Build: gcc/g++, make, cmake, autoconf/automake/libtool, pkg-config; headers for OpenSSL, zlib, libffi, SQLite.
- Languages (via mise): Node.js LTS with npm and corepack (pnpm, yarn), Bun, Python 3 with pip and uv, Go, Rust
  (rustup, cargo, rustc, clippy, rustfmt) with cargo-binstall.
- CLI: git, git-lfs, curl, wget, jq, yq, ripgrep (`rg`), fd, sqlite3, shellcheck, tree, file, patch, zip/unzip,
  xz, zstd, bzip2.

`mise ls` shows the installed tool versions.

## Adding tools

There is no root and no `apt`/`sudo`. Install into `$HOME` instead; the bin directories are already on `PATH`:

- Other versions or tools: `mise use -g go@1.23`, `mise use -g ripgrep-all`. Prefer registry names like these:
  `aqua:<owner>/<repo>` and `github:<owner>/<repo>` hit the GitHub API, which is rate limited without a token.
- Python CLIs: `uv tool install ruff`. Project dependencies: `uv venv` / `python3 -m venv .venv`, then install.
- Node CLIs: `npm i -g <pkg>`. pnpm/yarn: `corepack pnpm …` / `corepack yarn …`.
- Rust toolchains, targets, components: rustup works as usual (`$RUSTUP_HOME` is in `$HOME`). A
  `rust-toolchain.toml` installs its pinned toolchain on the first `cargo` call; otherwise
  `rustup toolchain install 1.85.0`, `rustup target add wasm32-unknown-unknown`, `rustup component add rust-src`.
  Toolchain downloads come from `static.rust-lang.org` (crates.io network preset).
- Rust binaries: `cargo binstall <crate>` (prebuilt) or `cargo install <crate>`.
- Go binaries: `go install <module>@<version>`.

If a tool needs system libraries that are missing, do not try to work around it: report that the flow needs a
custom sandbox image (`FROM orch/sandbox-omp:latest`).

## Network

All traffic goes through a proxy that only allows the domains this flow permits; by default that is none besides
the model gateway. A download that fails with a proxy `403` (or a `CONNECT` tunnel error) means the domain is not
allowed. Do not try other mirrors or bypasses: report which domain was blocked so the flow's allowlist can be
changed.
