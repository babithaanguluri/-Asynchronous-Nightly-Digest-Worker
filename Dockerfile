FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm install

# Copy source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Expose HTTP port
EXPOSE 3000

# Default entrypoint (can be overridden by docker-compose)
CMD ["npm", "run", "start:api"]
