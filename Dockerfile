# Use official Node.js LTS image
FROM node:18-alpine

# Install cloudflared and a RELIABLE netcat
RUN apk add --no-cache curl ca-certificates netcat-openbsd

# Install cloudflared (x86_64 for Railway)
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

# Ensure the script has the right permissions
RUN chmod +x /app/entrypoint.sh

EXPOSE 7000

ENTRYPOINT ["/app/entrypoint.sh"]
