#!/bin/sh
set -e
mkdir -p "$HOME/.omp/agent"
# User-level omp context, loaded into every session: what the image provides and how to add tools without root.
cp /opt/orch/AGENTS.md "$HOME/.omp/agent/AGENTS.md"
if [ -f /orch/config/models.yml ]; then
  cp /orch/config/models.yml "$HOME/.omp/agent/models.yml"
fi
for d in agents skills; do
  if [ -d "/orch/omp-user/$d" ]; then cp -R "/orch/omp-user/$d" "$HOME/.omp/agent/$d"; fi
done
# rustup writes its home (toolchains pinned by rust-toolchain.toml, `rustup target/component add`), so the run gets
# its own RUSTUP_HOME seeded from the image's read-only one. Toolchains are directory copies whose files are
# symlinks: new targets and components land in $HOME, the preinstalled binaries stay shared. rustup rewrites the
# bookkeeping files in lib/rustlib (via hard links), so those are real copies.
if [ ! -e "$RUSTUP_HOME/settings.toml" ]; then
  mkdir -p "$RUSTUP_HOME/toolchains"
  # --no-preserve=mode: the image's files are read-only to us, their copies must not be.
  cp -R --no-preserve=mode /usr/local/rustup/settings.toml /usr/local/rustup/update-hashes "$RUSTUP_HOME/"
  for tc in /usr/local/rustup/toolchains/*; do
    dst="$RUSTUP_HOME/toolchains/${tc##*/}"
    cp -Rs --no-preserve=mode "$tc" "$dst"
    find "$tc/lib/rustlib" -maxdepth 1 -type f \
      -exec cp --no-preserve=mode --remove-destination -t "$dst/lib/rustlib" {} +
  done
fi
# Bind mounts show up with the host owner's uid (or root on Docker Desktop), which git
# rejects as "dubious ownership"; the container itself is the trust boundary.
git config --global --add safe.directory '*'
exec "$@"
