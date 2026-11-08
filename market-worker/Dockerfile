FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY market-data.js worker.js index.js package.json ./

USER node
EXPOSE 8787
CMD ["node", "index.js"]
