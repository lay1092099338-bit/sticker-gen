#!/bin/bash
cd /home/ubuntu-m/.openclaw/workspace-lay-a/sticker-gen
cloudflared tunnel --url http://localhost:7788 2>&1 | tee /tmp/cf-tunnel.log
