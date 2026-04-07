#!/bin/sh

# 1. Start cloudflared using the Service Token
# We use the flags --service-token-id and --service-token-secret
cloudflared access tcp \
  --hostname "${TUNNEL_HOSTNAME}" \
  --url localhost:8888 \
  --service-token-id "${CF_CLIENT_ID}" \
  --service-token-secret "${CF_CLIENT_SECRET}" &

# 2. Robust check: Wait until port 8888 is actually listening
echo "Waiting for tunnel to establish on localhost:8888..."
MAX_RETRIES=30
COUNT=0
while ! nc -z localhost 8888; do
  sleep 1
  COUNT=$((COUNT + 1))
  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "Error: Tunnel failed to start within 30 seconds."
    exit 1
  fi
done

echo "Tunnel is UP! Starting Node.js app..."

# 3. Start your Node.js application
exec npm start
