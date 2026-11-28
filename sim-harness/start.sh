#!/bin/bash
cd /home/claude/b6/app-builder-pi-solohost-main
pkill -f "src/server.js" 2>/dev/null; sleep 1
rm -rf /tmp/sim/data /tmp/sim/ws /tmp/sim/projects /tmp/sim/ai.jsonl /tmp/sim/server.log; mkdir -p /tmp/sim/data /tmp/sim/ws /tmp/sim/projects
npm_config_offline=true PORT=18555 BIND=127.0.0.1 DATA_DIR=/tmp/sim/data WORKSPACE_DIR=/tmp/sim/ws PROJECTS_DIR=/tmp/sim/projects DEEPSEEK_API_KEY=sk-fake AI_PROVIDER=deepseek PREVIEW_REQUIRE_INTERNET=false PREVIEW_REQUIRE_BROWSER_TEST=false SHFH_ENABLED=0 nohup setsid node --import /tmp/sim/mockai.mjs src/server.js > /tmp/sim/server.log 2>&1 &
sleep 4; curl -s localhost:18555/health | head -c 300; echo
