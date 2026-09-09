#!/usr/bin/env sh
#
# Installs the AppGap report skill for Claude Code and/or Codex by linking this
# directory into their skill folders. Re-run it after `git pull`; a link needs
# no reinstall, but this reports what is wired up.
#
#   ./install.sh          link into every agent found
#   ./install.sh --copy   copy instead of link (for a one-off share)
#
set -e

SRC=$(cd "$(dirname "$0")" && pwd)
NAME=appgap-report
MODE=link
[ "$1" = "--copy" ] && MODE=copy

if ! command -v node >/dev/null 2>&1; then
  echo "! node is not on your PATH. The skill needs Node 18 or newer (22 recommended)."
  echo "  Install it from https://nodejs.org and run this again."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "! Node $(node -v) is too old. The skill needs 18 or newer (22 recommended)."
  exit 1
fi

installed=0

install_into() {
  target_dir=$1
  agent=$2
  invoke=$3

  mkdir -p "$target_dir"
  dest="$target_dir/$NAME"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ "$(readlink "$dest" 2>/dev/null)" = "$SRC" ]; then
      echo "= $agent: already linked ($dest)"
      installed=$((installed + 1))
      return
    fi
    echo "! $agent: $dest already exists and is not this skill. Left untouched."
    return
  fi

  if [ "$MODE" = "copy" ]; then
    mkdir -p "$dest"
    cp "$SRC/SKILL.md" "$dest/"
    cp -R "$SRC/scripts" "$dest/"
    echo "+ $agent: copied to $dest"
  else
    ln -s "$SRC" "$dest"
    echo "+ $agent: linked $dest -> $SRC"
  fi
  echo "  invoke with $invoke"
  installed=$((installed + 1))
}

install_into "$HOME/.claude/skills" "Claude Code" "/$NAME"
install_into "$HOME/.agents/skills" "Codex" "\$$NAME"

echo
if [ "$installed" -eq 0 ]; then
  echo "Nothing installed."
  exit 1
fi

cat <<'NOTE'
Restart the agent once if the skill does not show up: Claude Code and Codex
watch their skill folders, but neither watches a folder that did not exist when
the session started. `/skills` lists what Claude Code can see.
NOTE
