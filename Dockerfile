FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN DATABASE_URL=postgresql://localhost:5432/postgres DIRECT_URL=postgresql://localhost:5432/postgres npm run prisma:generate && npm run build

EXPOSE 7860
CMD ["npm", "run", "start:prod"]
