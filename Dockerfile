FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=pwuser:pwuser . .

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data

USER pwuser

EXPOSE 3000

CMD ["node", "src/production/productionServer.js"]
