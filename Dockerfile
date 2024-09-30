FROM node:22-alpine

RUN apk add --no-cache bash yarn

WORKDIR /app

COPY package.json yarn.lock ./

# Install all dependencies, including devDependencies
RUN yarn install --frozen-lockfile

COPY . .

# Generate Prisma client
RUN yarn prisma generate

EXPOSE 5555

CMD ["yarn", "start"]