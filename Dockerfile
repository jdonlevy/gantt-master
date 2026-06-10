# Multi-stage Dockerfile for React frontend
FROM --platform=linux/amd64 node:20-alpine AS base
WORKDIR /app

FROM base AS development
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ /app/
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM base AS builder
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ /app/
RUN npm run build

FROM --platform=linux/amd64 nginx:alpine AS production
COPY infrastructure/docker/nginx.conf /etc/nginx/nginx.conf
COPY infrastructure/docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
