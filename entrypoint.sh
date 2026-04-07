#!/bin/sh

# 1. Start cloudflared as a background process
# This connects to the tunnel you set up on your Mac.
# The ${TUNNEL_HOSTNAME} is pulled from Railway's environment at runtime.
cloudflared access tcp --hostname "${TUNNEL_HOSTNAME}" --url localhost:8888 &

# 2. Wait a second for the tunnel to initialize
sleep 2

# 3. Start your Node.js application
# We use 'exec' so Node becomes PID 1 (good for signal handling)
exec npm start
