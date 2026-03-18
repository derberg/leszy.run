FROM node:22-alpine
WORKDIR /app
# Copy root workspace manifest + lock file
COPY package.json package-lock.json ./
# Copy only backend package.json (not frontend — avoids unnecessary cache busts)
COPY backend/package.json backend/
# Install only backend deps
RUN npm ci --workspace=backend --omit=dev
# Copy backend source
COPY backend/ backend/
EXPOSE 3001
CMD ["node", "--watch", "backend/src/server.js"]
