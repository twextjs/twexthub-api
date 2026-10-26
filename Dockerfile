FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# `npm ci` runs the package's `postinstall`, which is `prisma generate`. That
# reads the schema, the migrations directory it points at, and the config that
# supplies the datasource, so all three have to be on disk before the install.
COPY prisma ./prisma
COPY prisma.config.mjs ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV TWEXTHUB_PORT=3000 \
    TWEXTHUB_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
