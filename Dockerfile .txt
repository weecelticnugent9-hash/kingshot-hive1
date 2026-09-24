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

# The roster and the editable map live here. Mount a Railway Volume at /app/data
# (configure this in the Railway dashboard) to keep both across deploys.
ENV HIVE_DATA_DIR=/app/data

CMD ["node", "bot.js"]
