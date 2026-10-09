# Udhaar Agent: one shop per container. Agent37 build: npx agent37 templates build . --name udhaar-gupta --default-port 8000
FROM node:22-alpine
WORKDIR /app
COPY core ./core
COPY web ./web
COPY vendor ./vendor
COPY server ./server
COPY build.js ./
RUN node build.js && mkdir -p /app/data && chown -R node:node /app/data
USER node
# Which demo shop this image runs. One template per shop: see README, "Deploy on Agent37".
ENV SHOP=gupta
ENV PORT=8000 DATA_DIR=/app/data NODE_ENV=production REAL_CLOCK=1 TZ=Asia/Kolkata
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "server/server.js"]
