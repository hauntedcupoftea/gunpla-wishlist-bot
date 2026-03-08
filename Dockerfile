FROM denoland/deno:debian

WORKDIR /app

RUN chown -R deno:deno /app

# Switch to the non-root 'deno' user provided by the base image
USER deno

# Copy the deno.json first to leverage Docker layer caching
COPY --chown=deno:deno deno.json ./

# Install dependencies globally into the Deno cache
# (This prevents re-downloading npm packages every time you change your code)
RUN deno install 

# Copy the Prisma schema and generate the Prisma Client
COPY --chown=deno:deno prisma ./prisma
COPY --chown=deno:deno prisma.config.ts ./
COPY --chown=deno:deno .env ./
RUN deno task db:generate

# Copy the rest of the application source code
COPY --chown=deno:deno . .

# Pre-compile the TypeScript into V8 bytecode
RUN deno cache src/index.ts

# Expose the port (Keep this if your bot runs a web server for healthchecks)
EXPOSE 5555

# Start the bot using the standard Deno entrypoint
CMD ["task", "start"]
