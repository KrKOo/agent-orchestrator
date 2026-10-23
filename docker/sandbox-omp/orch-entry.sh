#!/bin/sh
set -e
mkdir -p "$HOME/.omp/agent"
if [ -f /orch/config/models.yml ]; then
  cp /orch/config/models.yml "$HOME/.omp/agent/models.yml"
fi
for d in agents skills; do
  if [ -d "/orch/omp-user/$d" ]; then cp -R "/orch/omp-user/$d" "$HOME/.omp/agent/$d"; fi
done
exec "$@"
