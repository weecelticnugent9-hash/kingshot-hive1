# Use the official Node image. "slim" keeps the image small and starts fast.
FROM node:20-slim

# Run as a non-root user.
WORKDIR /app

# Copy dependency manifests first so Docker can cache the install layer.
COPY package.json ./

# Install only production dependencies.
RUN npm install --omit=dev

# Copy the bot source.
COPY . .

# The roster lives here. Mount a volume at /app/data to keep it across deploys.
VOLUME ["/app/data"]
ENV HIVE_DB=/app/data/hive.json

CMD ["node", "bot.js"]
