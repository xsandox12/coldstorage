FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY *.html *.js ./
COPY db/ ./db/
EXPOSE 9000
CMD ["node", "server.js"]
