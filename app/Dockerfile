  # app/Dockerfile
  FROM node:20-alpine
  WORKDIR /usr/src/app
  COPY package*.json ./
  RUN npm ci --omit=dev
  COPY . .
  ENV NODE_ENV=production PORT=4000
  EXPOSE 4000
  CMD ["node","index.js"]