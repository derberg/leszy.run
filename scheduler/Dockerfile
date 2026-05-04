FROM node:22-alpine

# docker CLI + compose plugin so the scheduler can shell out to sibling containers
# (compose v2 ships as a plugin under /usr/libexec/docker/cli-plugins/docker-compose,
# but apk packages it as docker-cli-compose which wires up `docker compose ...`).
RUN apk add --no-cache docker-cli docker-cli-compose tzdata

ENV TZ=Europe/Warsaw

WORKDIR /app

# Workspace: copy root manifests + scheduler manifest only, then npm ci --workspace
COPY package.json package-lock.json ./
COPY scheduler/package.json scheduler/
RUN npm ci --workspace=scheduler --omit=dev

COPY scheduler/ scheduler/

WORKDIR /app/scheduler

CMD ["node", "src/index.js"]
