#!/bin/sh

echo "Starting cloudflared tunnel to ${TUNNEL_HOSTNAME}..."

# 1. Start cloudflared. 
# We use --listener-addr to force IPv4 and match our health check.
cloudflared access tcp \
  --hostname "${TUNNEL_HOSTNAME}" \
  --url localhost:8888 \
  --service-token-id "${CF_CLIENT_ID}" \
  --service-token-secret "${CF_CLIENT_SECRET}" > /tmp/cloudflared.log 2>&1 &

# 2. Wait until the port is actually open
echo "Waiting for tunnel to establish on 127.0.0.1:8888..."
MAX_RETRIES=30
COUNT=0

while ! nc -z 127.0.0.1 8888; do
  sleep 1
  COUNT=$((COUNT + 1))
  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "Error: Tunnel failed to start within 30 seconds."
    echo "--- Cloudflared Logs ---"
    cat /tmp/cloudflared.log
    exit 1
  fi
done

echo "Tunnel is UP! Starting Node.js app..."

# 3. Start the Node.js application
exec npm start
