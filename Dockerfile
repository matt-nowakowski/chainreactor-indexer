FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY schema.sql ./
COPY src/ ./src/

RUN npx tsc

ENV PORT=4000
EXPOSE 4000

CMD ["node", "dist/index.js"]
