# Playwright's image ships Chromium plus the system libraries it needs. Keep the
# tag in step with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# HOST=0.0.0.0: listen on all container interfaces so the published port works
# (outside Docker the app defaults to 127.0.0.1, this computer only).
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY templates ./templates
COPY scripts ./scripts
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js", "all"]
