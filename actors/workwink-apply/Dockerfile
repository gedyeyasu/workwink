FROM apify/actor-node-playwright-chrome:22-1.61.1

COPY --chown=myuser:myuser package.json package-lock.json ./
RUN npm --quiet set progress=false \
    && npm ci --include=dev \
    && npm cache clean --force

COPY --chown=myuser:myuser . ./
RUN npm run build \
    && npm prune --omit=dev

CMD ["npm", "start", "--silent"]
