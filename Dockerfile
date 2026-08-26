FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client during build
RUN npm run prisma:generate

# Copy application code
COPY src ./src

# Start application
CMD ["npm", "start"]

