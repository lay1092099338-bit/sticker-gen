#!/bin/bash
# 贴纸生成器启动脚本
cd "$(dirname "$0")"

echo "🌸 启动贴纸生成器..."

# Kill old instances
pkill -f "node server.js" 2>/dev/null
sleep 1

# Start server
node server.js > /tmp/sticker-gen.log 2>&1 &
SERVER_PID=$!
echo "✅ Server PID: $SERVER_PID (port 7788)"
sleep 2

# Start cloudflare tunnel
CLOUDFLARED=~/.nvm/versions/node/v24.14.0/lib/node_modules/cloudflared/bin/cloudflared
$CLOUDFLARED tunnel --url http://localhost:7788 2>&1 &
TUNNEL_PID=$!
echo "🌐 Cloudflare Tunnel PID: $TUNNEL_PID"
echo "⏳ 等待隧道URL..."
sleep 10

# Get URL from logs
URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/tunnel.log 2>/dev/null | head -1)
echo "🔗 公开访问地址: $URL"
echo ""
echo "停止服务: kill $SERVER_PID $TUNNEL_PID"
