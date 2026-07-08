#!/usr/bin/env bash
# Keep dist/ in lockstep with src/. A stale compiled dist/ silently broke
# vault_write_note (.md/frontmatter) + add_knowledge (401) on 2026-07-07 because
# a committed src fix was never recompiled. dist/ is gitignored, so git gives no
# drift signal. This script is invoked by the tracked post-commit/post-merge/
# post-checkout hooks (wired via `git config core.hooksPath hooks`).
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0
# Ensure npm is reachable even under a stripped hook PATH (GUI git clients, etc.)
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin "$HOME/.asdf/shims"; do
  [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) PATH="$p:$PATH";; esac
done
export PATH
command -v npm >/dev/null 2>&1 || { echo "[koi-mcp hook] npm not on PATH; skipping dist rebuild" >&2; exit 0; }
echo "[koi-mcp hook] rebuilding dist/ from src/ (tsc)…"
if npm run build >/tmp/koi-mcp-build.log 2>&1; then
  echo "[koi-mcp hook] dist/ rebuilt ✓ — run /mcp to reconnect personal-koi so the fresh build loads."
else
  echo "[koi-mcp hook] ⚠ tsc build FAILED — dist/ left unchanged (may be stale). See /tmp/koi-mcp-build.log" >&2
fi
exit 0
