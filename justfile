set dotenv-load := true

PI_PI_REPO := "https://github.com/disler/pi-vs-claude-code"
PI_PI_RAW  := "https://raw.githubusercontent.com/disler/pi-vs-claude-code/refs/heads/main"

default:
    @just --list

# Run Pi with the pi-pi extension (meta-agent mode)
pi-pi:
    pi -e .pi/extensions/pi-pi.ts

# Run Pi with the orchestrator extension (multi-agent workflows)
orchestrate:
    pi -e .pi/extensions/orchestrator

# Install Pi Pi from the GitHub origin repo into .pi/ (safe to re-run; also upgrades)
install-pi-pi:
    #!/usr/bin/env bash
    set -euo pipefail
    raw="{{ PI_PI_RAW }}"
    mkdir -p .pi/extensions .pi/agents/pi-pi .pi/themes

    # Extensions
    curl -fsSL "$raw/extensions/pi-pi.ts"    -o .pi/extensions/pi-pi.ts
    curl -fsSL "$raw/extensions/themeMap.ts" -o .pi/extensions/themeMap.ts

    # Agent expert definitions
    for agent in agent-expert cli-expert config-expert ext-expert keybinding-expert \
                 pi-orchestrator prompt-expert skill-expert theme-expert tui-expert; do
        curl -fsSL "$raw/.pi/agents/pi-pi/${agent}.md" -o ".pi/agents/pi-pi/${agent}.md"
    done

    # Themes
    curl -fsSL "$raw/.pi/themes/rose-pine.json" -o .pi/themes/rose-pine.json

    echo "Pi Pi installed from {{ PI_PI_REPO }}"
