FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Europe/Warsaw

# System deps:
# - tzdata for TZ
# - curl/ca-certificates for the install-time fetches
# - the long list under playwright is what `playwright install --with-deps chromium`
#   would normally install, but we list explicitly so the image build is reproducible.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tzdata \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2 libdrm2 libxshmfence1 libxext6 libxfixes3 libxi6 libxtst6 \
      fonts-liberation libappindicator3-1 libu2f-udev xdg-utils \
   && rm -rf /var/lib/apt/lists/*

WORKDIR /app/enricher

# Install Python deps from pyproject.toml without copying source first, so layer
# caching kicks in. We give it a placeholder package directory; the real source
# is COPYed in the next step and replaces the placeholder.
COPY enricher/pyproject.toml ./
RUN mkdir -p enricher && touch enricher/__init__.py \
    && pip install -e .

# Install playwright's chromium browser (crawl4ai uses it)
RUN python -m playwright install chromium

# Copy real source (overwrites placeholder __init__.py)
COPY enricher/enricher/ ./enricher/

CMD ["python", "-m", "enricher", "run"]
