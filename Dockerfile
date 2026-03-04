# vnext-local-manager: Multi-stage build
# Stage 1: Build (npm, helm, kubectl burada; final image'da yok = CVE yok)
FROM node:20-alpine AS builder

RUN apk add --no-cache curl bash && apk upgrade --no-cache && rm -rf /var/cache/apk/* /tmp/* /root/.npm 2>/dev/null || true

# Helm + kubectl (TARGETARCH = amd64 | arm64)
ARG TARGETARCH
RUN curl -fsSL "https://get.helm.sh/helm-v3.20.0-linux-${TARGETARCH}.tar.gz" | tar xz -C /tmp && \
    mv /tmp/linux-${TARGETARCH}/helm /usr/local/bin/helm && rm -rf /tmp/linux-* && \
    curl -sLO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${TARGETARCH}/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY template_values.yaml ./
COPY infra_values.yaml ./


COPY viewer/package.json viewer/package-lock.json* viewer/
RUN cd viewer && npm ci
COPY viewer ./viewer
RUN cd viewer && npm run build

# Stage 2: Runtime – Alpine; npm kaldırılıyor (sadece node server.js çalıyor → 11 npm bundle CVE yok)
FROM node:20-alpine

RUN apk upgrade --no-cache && rm -rf /var/cache/apk/* /tmp/* /usr/local/lib/node_modules/npm

ENV PORT=3000
ENV HOME=/tmp
ENV PATH="/app/bin:${PATH}"

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js /app/infra_values.yaml /app/template_values.yaml ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/viewer/dist ./viewer/dist
COPY --from=builder /app/package.json ./
COPY --from=builder /usr/local/bin/helm /usr/local/bin/kubectl /app/bin/

EXPOSE 3000
USER node
CMD ["node", "server.js"]
