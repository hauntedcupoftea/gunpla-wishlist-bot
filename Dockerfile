FROM node:22-alpine

RUN apk add --no-cache bash yarn

WORKDIR /app

COPY package.json yarn.lock ./

# Install all dependencies, including devDependencies
RUN yarn install --frozen-lockfile

COPY . .

# Generate Prisma client
RUN yarn prisma generate

# Add node_modules/.bin to PATH
ENV PATH /app/node_modules/.bin:$PATH

EXPOSE 5555

# Use a shell to run the command
CMD ["/bin/sh", "-c", "yarn start"]