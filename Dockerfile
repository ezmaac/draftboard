FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# SQLite lives on a mounted volume so it survives redeploys.
ENV DB_FILE=/data/draftboard.db PORT=8080
EXPOSE 8080
CMD ["node", "--no-warnings", "server.js"]
