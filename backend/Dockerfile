FROM node:22-bookworm-slim
WORKDIR /app
# Install Playwright system dependencies (Chromium needs these libs)
RUN npx playwright install-deps chromium
# Copy root workspace manifest + lock file
COPY package.json package-lock.json ./
# Copy only backend package.json (not frontend — avoids unnecessary cache busts)
COPY backend/package.json backend/
# The backend imports @leszyrun/ui (eventCompleteness, teamResults) through a
# workspace link. Without its manifest npm ci creates no link, and every
# pipeline step failed at import with ERR_MODULE_NOT_FOUND.
COPY packages/ui/package.json packages/ui/
# Install only backend deps (plus the @leszyrun/ui link)
RUN npm ci --workspace=backend --workspace=@leszyrun/ui --omit=dev
# Install Playwright Chromium browser
RUN npx playwright install chromium
# Copy backend source
COPY backend/ backend/
COPY packages/ui/src/ packages/ui/src/
# run-weekly-digest.js imports the edge functions' deadline rule so the email and
# the in-app badge agree. Without it the digest crashed at import in the image.
COPY supabase/functions/_shared/deadlineSoon.js supabase/functions/_shared/
# publish-landing-pages.js (a pipeline step) uploads the /listy manifest to
# Supabase Storage through the public app's storage module.
COPY public/scripts/lib/publicData.js public/scripts/lib/
EXPOSE 3001
CMD ["node", "--watch", "backend/src/server.js"]
