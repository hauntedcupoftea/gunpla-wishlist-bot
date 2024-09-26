# Use the official Node.js Alpine image as a base
FROM node:22-alpine

# Install bash (optional) and yarn using apk
RUN apk add --no-cache bash yarn

# Set the working directory in the container
WORKDIR /app

# Copy package.json and yarn.lock to install dependencies
COPY package.json yarn.lock ./

# Install dependencies with Yarn
RUN yarn install --frozen-lockfile

# Copy the rest of the bot's source code
COPY . .

# Expose any required port (optional)
EXPOSE 5555 
# +3000 # if/when we get a dashboard

# Start the bot (replace 'yarn dev' with 'yarn start' if in production)
CMD ["yarn", "dev"]
