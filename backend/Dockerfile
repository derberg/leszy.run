FROM node:22-bookworm-slim
WORKDIR /app
# Install Playwright system dependencies (Chromium needs these libs)
RUN npx playwright install-deps chromium
# Copy root workspace manifest + lock file
COPY package.json package-lock.json ./
# Copy only backend package.json (not frontend — avoids unnecessary cache busts)
COPY backend/package.json backend/
# Install only backend deps
RUN npm ci --workspace=backend --omit=dev
# Install Playwright Chromium browser
RUN npx playwright install chromium
# Copy backend source
COPY backend/ backend/
# run-weekly-digest.js imports the edge functions' deadline rule so the email and
# the in-app badge agree. Without it the digest crashed at import in the image.
COPY supabase/functions/_shared/deadlineSoon.js supabase/functions/_shared/
EXPOSE 3001
CMD ["node", "--watch", "backend/src/server.js"]
