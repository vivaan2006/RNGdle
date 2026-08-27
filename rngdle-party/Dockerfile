# RNGparty has zero npm dependencies, so this is deliberately minimal —
# no package install step, just copy the app and run it.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
