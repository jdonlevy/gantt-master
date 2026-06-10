# Multi-stage Dockerfile for React frontend (frontend context)
FROM --platform=linux/amd64 node:20-alpine AS base

WORKDIR /app

# Development stage
FROM base AS development

COPY package*.json ./
RUN npm install

COPY . /app/

EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage
FROM base AS builder

COPY package*.json ./
RUN npm install

COPY . /app/

RUN npm run build

# Production stage
FROM --platform=linux/amd64 nginx:alpine AS production

COPY nginx.conf /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /app/dist /usr/share/nginx/html/build

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
