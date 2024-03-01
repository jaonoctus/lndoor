FROM node:20.11.1-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY prisma/migrations/ prisma/migrations/
COPY prisma/schema.prisma prisma/schema.prisma
COPY src/ src/

RUN npx tsup src/index.ts --minify
RUN npx prisma generate

CMD [ "npm", "run", "start:prod" ]
