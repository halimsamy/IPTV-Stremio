# Use official Node.js LTS image
FROM node:18-alpine

# Install cloudflared (x86_64 for Railway's servers)
RUN apk add --no-cache curl ca-certificates
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy the rest of the code
COPY . .

# Copy and prepare the entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose your app port
EXPOSE 7000

# Use the script to start the container
ENTRYPOINT ["/app/entrypoint.sh"]
