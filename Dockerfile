# ResumeAI V2 backend for Railway.
# LibreOffice (headless Writer) renders the DOCX to PDF so the page count can be
# verified; Carlito is metric-compatible with Calibri so page counts match Word.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-crosextra-carlito fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    SOFFICE_PATH=soffice

EXPOSE 3001
CMD ["node", "server.js"]
