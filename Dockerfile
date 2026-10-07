FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/certs ./certs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca_pem.crt
USER node
EXPOSE 8000
CMD ["npm", "run", "start:prod"]
