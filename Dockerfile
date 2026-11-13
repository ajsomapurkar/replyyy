# For Railway / Fly.io / any Docker host. Render can use render.yaml instead.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/migrations ./infra/migrations
RUN npm ci && npm run build:prod
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start:prod"]
