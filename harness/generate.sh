#!/usr/bin/env bash
# harness/generate.sh — regenerate client(s) from the spec via Claude Code.
#
# Usage:  harness/generate.sh <python|typescript|all>
#
# For each target language this:
#   1. wipes clients/<lang>            (regeneration is always from scratch)
#   2. renders harness/prompts/client.md with the language + output dir
#   3. runs Claude Code headless to generate the client into clients/<lang>
#   4. tees the agent's output to harness/logs/<lang>.log
#
# NOTE: Claude Code CLI flags can change between versions. If a flag is rejected,
#       run `claude --help` and adjust the invocation in run_agent() below.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_TEMPLATE="$ROOT/harness/prompts/client.md"
LOG_DIR="$ROOT/harness/logs"
mkdir -p "$LOG_DIR"

usage() { echo "usage: $0 <python|typescript|all>" >&2; exit 2; }
[ "$#" -eq 1 ] || usage

# Fill the prompt template's {{TARGET_LANGUAGE}} / {{OUTPUT_DIR}} placeholders.
render_prompt() {
  local lang="$1" outdir="$2"
  sed -e "s|{{TARGET_LANGUAGE}}|$lang|g" \
      -e "s|{{OUTPUT_DIR}}|$outdir|g" \
      "$PROMPT_TEMPLATE"
}

# The single point where the agentic tool is invoked. Swap this body to use a
# different tool (e.g. Codex) without touching the rest of the harness.
run_agent() {
  local prompt="$1"
  claude -p "$prompt" \
    --permission-mode acceptEdits \
    --allowedTools "Read,Glob,Grep,Write,Edit,Bash"
  # If unattended verification (npm build, booting the server) needs bash without
  # prompts, you may instead run:
  #   claude -p "$prompt" --dangerously-skip-permissions
}

generate_one() {
  local lang="$1"
  local outdir="clients/$lang"
  echo ">> regenerating $outdir from spec"
  rm -rf "${ROOT:?}/$outdir"
  mkdir -p "$ROOT/$outdir"
  local prompt
  prompt="$(render_prompt "$lang" "$outdir")"
  ( cd "$ROOT" && run_agent "$prompt" ) 2>&1 | tee "$LOG_DIR/$lang.log"
  echo ">> done: $outdir   (log: harness/logs/$lang.log)"
}

case "$1" in
  python|typescript) generate_one "$1" ;;
  all)               generate_one python; generate_one typescript ;;
  *)                 usage ;;
esac