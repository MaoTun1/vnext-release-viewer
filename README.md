# vNext Local Manager

Kubernetes ortamında **vNext** platformunun altyapı ve domain servislerini yönetmek için kullanılan bir web uygulamasıdır. Helm chart deploy, upgrade, scale, restart gibi operasyonları tek bir arayüzden gerçekleştirmenizi sağlar.

> **UYARI: Admin paneli (`/admin`) yalnızca lokal geliştirme ortamında kullanılmak üzere tasarlanmıştır. Production veya staging ortamlarında kesinlikle aktifleştirilmemelidir. Bu sayfa, altyapı ve domain'ler üzerinde doğrudan deploy, silme ve konfigürasyon değiştirme gibi kritik operasyonlar içerir ve herhangi bir kimlik doğrulama mekanizması barındırmaz.**

## Özellikler

- **Altyapı Yönetimi** — Postgres, Vault, Redis Sentinel, Dapr, OpenTelemetry, OpenObserve gibi bileşenlerin tek komutla deploy edilmesi
- **Domain Yönetimi** — Domain bazlı veritabanı, Vault engine ve Helm release oluşturma/güncelleme/silme
- **Helm Release Viewer** — OCI registry üzerinden chart sürümlerini ve cluster'daki aktif release'leri görüntüleme (React SPA)
- **Admin Panel** — Deploy, restart, scale (0/1), değer düzenleme, upgrade ve silme işlemlerini yapabileceğiniz yönetim arayüzü (**yalnızca lokal geliştirme için**)
- **NPM Paket Push** — Orchestrator initializer pod'u üzerinden npm paketlerini push etme
- **Çoklu Dil Desteği** — Türkçe ve İngilizce arayüz

## Gereksinimler


| Araç        | Açıklama                            |
| ----------- | ----------------------------------- |
| **Node.js** | v20+ önerilir                       |
| **kubectl** | Kubernetes cluster'a erişim için    |
| **Helm 3**  | Chart deploy/upgrade işlemleri için |


> Uygulama cluster içinde çalıştırıldığında `cluster-admin` yetkisine sahip bir service account gereklidir.

## Kurulum

```bash
# Bağımlılıkları yükle
npm ci

# Viewer (React SPA) build
npm run build:viewer
```

## Çalıştırma

### Yerel Geliştirme

```bash
# Admin panel aktif olarak başlat (yalnızca lokal geliştirme!)
ADMIN_PAGE_ENABLED=true npm start
```

Uygulama varsayılan olarak **3000** portunda ayağa kalkar.

### Docker ile Çalıştırma

```bash
# Image oluştur
docker build -t vnext-local-manager .

# Container başlat (yalnızca lokal geliştirme!)
docker run -p 3000:3000 -e ADMIN_PAGE_ENABLED=true vnext-local-manager
```

### Viewer Geliştirme (Hot Reload)

```bash
cd viewer && npm run dev
```

Vite dev sunucusu `/api` isteklerini `http://localhost:3000` adresine proxy eder.

## Ortam Değişkenleri


| Değişken             | Varsayılan                                   | Açıklama                                                        |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `PORT`               | `3000`                                       | Sunucu portu                                                    |
| `PAT_DATA_DIR`       | `./data`                                     | Veri dizini (config, PAT, domain values)                        |
| `ADMIN_PAGE_ENABLED` | `false`                                      | Admin panelini aktifleştir (**yalnızca lokal geliştirme için**) |
| `HELM_CHART_REPO`    | `oci://registry.example.com/charts/vnext` | Helm chart OCI repository URL'i                                 |
| `NPM_REGISTRY`       | —                                            | NPM registry adresi                                             |
| `NPM_EMAIL`          | —                                            | NPM kullanıcı e-postası                                         |
| `NPM_USERNAME`       | —                                            | NPM kullanıcı adı                                               |
| `NPM_PASSWORD`       | —                                            | NPM şifresi                                                     |


## Arayüz Erişimi

Kubernetes ortamında uygulama varsayılan olarak **NodePort 30800** üzerinden erişime açılır (`k8s/allinone.yaml`). Yerel geliştirmede container portu 3000'dir.

| URL                              | Açıklama                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `http://localhost:30800`         | Helm Release Viewer (Kubernetes NodePort)                                       |
| `http://localhost:30800/admin`   | Admin Panel — **yalnızca lokal geliştirme** (`ADMIN_PAGE_ENABLED=true` gerekir) |
| `http://localhost:30800/health`  | Health check endpoint'i                                                         |
| `http://localhost:3000`          | Yerel geliştirme (doğrudan Node.js)                                             |


## API Referansı

### Altyapı


| Endpoint                 | Metod | Açıklama                       |
| ------------------------ | ----- | ------------------------------ |
| `/api/deploy`            | POST  | vnext-infra deploy             |
| `/api/check-infra`       | GET   | Altyapı durumunu kontrol et    |
| `/api/teardown-all`      | POST  | Tüm vnext bileşenlerini kaldır |
| `/api/infra-credentials` | GET   | Altyapı erişim bilgileri       |
| `/api/urls`              | GET   | Altyapı ve uygulama URL'leri   |
| `/api/vault/unseal`      | POST  | Vault unseal                   |
| `/api/vault/token`       | GET   | Vault root token               |


### Domain İşlemleri


| Endpoint                       | Metod | Açıklama                              |
| ------------------------------ | ----- | ------------------------------------- |
| `/api/deploy-domains`          | POST  | Domain deploy                         |
| `/api/domains`                 | GET   | Domain listesi                        |
| `/api/domains/:domain/restart` | POST  | Domain restart                        |
| `/api/domains/:domain/scale`   | POST  | Domain scale (0/1)                    |
| `/api/domains/:domain/values`  | GET   | Domain Helm values dosyasını getir    |
| `/api/domains/:domain/values`  | PUT   | Domain Helm values dosyasını güncelle |
| `/api/domain-upgrade`          | POST  | Domain Helm upgrade                   |
| `/api/domains/delete`          | POST  | Domain sil                            |


### Genel


| Endpoint                  | Metod | Açıklama                           |
| ------------------------- | ----- | ---------------------------------- |
| `/api/app-config`         | GET   | Uygulama konfigürasyonunu getir    |
| `/api/app-config`         | PUT   | Uygulama konfigürasyonunu güncelle |
| `/api/push-package`       | POST  | NPM paketi push et                 |
| `/api/v1/chart/versions`  | GET   | OCI registry'den chart sürümleri   |
| `/api/v1/releases`        | GET   | Cluster'daki Helm release'ler      |
| `/api/v1/config`          | GET   | Helm chart konfigürasyonu          |
| `/api/v1/admin-available` | GET   | Admin panel erişilebilirlik durumu |


## Yapılandırma Dosyaları


| Dosya                  | Açıklama                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `infra_values.yaml`    | vnext-infra Helm values (Postgres, Vault, Redis vb.)                           |
| `template_values.yaml` | Domain template values — `APP_DOMAIN` placeholder'ı domain adıyla değiştirilir |
| `data/app-config.json` | Çalışma zamanı konfigürasyon override'ları                                     |
| `data/.pat`            | Opsiyonel NPM Personal Access Token                                            |
| `data/domains-values/` | Domain bazlı values dosyaları (`{domain}-values.yaml`)                         |


## Proje Yapısı

```
vnext-local-manager/
├── server.js              # Express sunucu (ana giriş noktası)
├── package.json
├── Dockerfile             # Multi-stage Docker build
├── infra_values.yaml      # Altyapı Helm values
├── template_values.yaml   # Domain template values
├── lib/
│   ├── run.js             # Helm/kubectl komut çalıştırıcı
│   ├── cache.js           # In-memory TTL cache
│   └── kubeconfig.js      # In-cluster kubeconfig ayarları
├── public/
│   └── index.html         # Admin panel (vanilla HTML/JS)
├── viewer/                # Helm Release Viewer (React SPA)
│   ├── src/
│   │   ├── App.tsx        # Ana bileşen (Versions & Releases)
│   │   ├── i18n.ts        # Çoklu dil desteği (TR/EN)
│   │   └── ...
│   └── vite.config.ts
└── data/                  # Çalışma zamanı verileri
    ├── app-config.json
    └── domains-values/
```

## Teknolojiler


| Katman    | Teknoloji                                |
| --------- | ---------------------------------------- |
| Backend   | Node.js, Express                         |
| Admin UI  | Vanilla HTML/CSS/JS, CodeMirror, js-yaml |
| Viewer    | React 18, TypeScript, Vite               |
| Altyapı   | Kubernetes, Helm 3, kubectl              |
| Container | Docker (multi-stage, Alpine)             |


---

# vNext Local Manager (English)

A web application for managing **vNext** platform infrastructure and domain services in a Kubernetes environment. It provides a single interface for Helm chart deploy, upgrade, scale, and restart operations.

> **WARNING: The admin panel (`/admin`) is designed exclusively for local development use. It must NEVER be enabled in production or staging environments. This page provides direct access to critical operations such as deploying, deleting, and modifying infrastructure and domain configurations, and does not include any authentication mechanism.**

## Features

- **Infrastructure Management** — One-click deployment of Postgres, Vault, Redis Sentinel, Dapr, OpenTelemetry, OpenObserve, and more
- **Domain Management** — Create, update, and delete per-domain databases, Vault engines, and Helm releases
- **Helm Release Viewer** — View chart versions from OCI registry and active releases in the cluster (React SPA)
- **Admin Panel** — Management interface for deploy, restart, scale (0/1), value editing, upgrade, and deletion (**local development only**)
- **NPM Package Push** — Push npm packages via the orchestrator initializer pod
- **Multi-language Support** — Turkish and English UI

## Prerequisites


| Tool        | Description                         |
| ----------- | ----------------------------------- |
| **Node.js** | v20+ recommended                    |
| **kubectl** | Access to a Kubernetes cluster      |
| **Helm 3**  | For chart deploy/upgrade operations |


> When running in-cluster, a service account with `cluster-admin` privileges is required.

## Installation

```bash
# Install dependencies
npm ci

# Build Viewer (React SPA)
npm run build:viewer
```

## Running

### Local Development

```bash
# Start with admin panel enabled (local development only!)
ADMIN_PAGE_ENABLED=true npm start
```

The application listens on port **3000** by default.

### Docker

```bash
# Build the image
docker build -t vnext-local-manager .

# Run the container (local development only!)
docker run -p 3000:3000 -e ADMIN_PAGE_ENABLED=true vnext-local-manager
```

### Viewer Development (Hot Reload)

```bash
cd viewer && npm run dev
```

The Vite dev server proxies `/api` requests to `http://localhost:3000`.

## Environment Variables


| Variable             | Default                                      | Description                                     |
| -------------------- | -------------------------------------------- | ----------------------------------------------- |
| `PORT`               | `3000`                                       | Server port                                     |
| `PAT_DATA_DIR`       | `./data`                                     | Data directory (config, PAT, domain values)     |
| `ADMIN_PAGE_ENABLED` | `false`                                      | Enable admin panel (**local development only**) |
| `HELM_CHART_REPO`    | `oci://registry.example.com/charts/vnext` | Helm chart OCI repository URL                   |
| `NPM_REGISTRY`       | —                                            | NPM registry URL                                |
| `NPM_EMAIL`          | —                                            | NPM user email                                  |
| `NPM_USERNAME`       | —                                            | NPM username                                    |
| `NPM_PASSWORD`       | —                                            | NPM password                                    |


## UI Access

In Kubernetes, the application is exposed via **NodePort 30800** by default (`k8s/allinone.yaml`). The container port is 3000 for local development.

| URL                              | Description                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `http://localhost:30800`         | Helm Release Viewer (Kubernetes NodePort)                                     |
| `http://localhost:30800/admin`   | Admin Panel — **local development only** (requires `ADMIN_PAGE_ENABLED=true`) |
| `http://localhost:30800/health`  | Health check endpoint                                                         |
| `http://localhost:3000`          | Local development (direct Node.js)                                            |


## API Reference

### Infrastructure


| Endpoint                 | Method | Description                         |
| ------------------------ | ------ | ----------------------------------- |
| `/api/deploy`            | POST   | Deploy vnext-infra                  |
| `/api/check-infra`       | GET    | Check infrastructure status         |
| `/api/teardown-all`      | POST   | Remove all vnext components         |
| `/api/infra-credentials` | GET    | Infrastructure credentials          |
| `/api/urls`              | GET    | Infrastructure and application URLs |
| `/api/vault/unseal`      | POST   | Unseal Vault                        |
| `/api/vault/token`       | GET    | Get Vault root token                |


### Domain Operations


| Endpoint                       | Method | Description               |
| ------------------------------ | ------ | ------------------------- |
| `/api/deploy-domains`          | POST   | Deploy domains            |
| `/api/domains`                 | GET    | List domains              |
| `/api/domains/:domain/restart` | POST   | Restart domain            |
| `/api/domains/:domain/scale`   | POST   | Scale domain (0/1)        |
| `/api/domains/:domain/values`  | GET    | Get domain Helm values    |
| `/api/domains/:domain/values`  | PUT    | Update domain Helm values |
| `/api/domain-upgrade`          | POST   | Helm upgrade domain       |
| `/api/domains/delete`          | POST   | Delete domains            |


### General


| Endpoint                  | Method | Description                      |
| ------------------------- | ------ | -------------------------------- |
| `/api/app-config`         | GET    | Get application configuration    |
| `/api/app-config`         | PUT    | Update application configuration |
| `/api/push-package`       | POST   | Push npm package                 |
| `/api/v1/chart/versions`  | GET    | Chart versions from OCI registry |
| `/api/v1/releases`        | GET    | Helm releases in the cluster     |
| `/api/v1/config`          | GET    | Helm chart configuration         |
| `/api/v1/admin-available` | GET    | Admin panel availability status  |


## Configuration Files


| File                   | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `infra_values.yaml`    | vnext-infra Helm values (Postgres, Vault, Redis, etc.)                             |
| `template_values.yaml` | Domain template values — `APP_DOMAIN` placeholder is replaced with the domain name |
| `data/app-config.json` | Runtime configuration overrides                                                    |
| `data/.pat`            | Optional NPM Personal Access Token                                                 |
| `data/domains-values/` | Per-domain values files (`{domain}-values.yaml`)                                   |


## Project Structure

```
vnext-local-manager/
├── server.js              # Express server (main entry point)
├── package.json
├── Dockerfile             # Multi-stage Docker build
├── infra_values.yaml      # Infrastructure Helm values
├── template_values.yaml   # Domain template values
├── lib/
│   ├── run.js             # Helm/kubectl command runner
│   ├── cache.js           # In-memory TTL cache
│   └── kubeconfig.js      # In-cluster kubeconfig setup
├── public/
│   └── index.html         # Admin panel (vanilla HTML/JS)
├── viewer/                # Helm Release Viewer (React SPA)
│   ├── src/
│   │   ├── App.tsx        # Main component (Versions & Releases)
│   │   ├── i18n.ts        # Multi-language support (TR/EN)
│   │   └── ...
│   └── vite.config.ts
└── data/                  # Runtime data
    ├── app-config.json
    └── domains-values/
```

## Technologies


| Layer          | Technology                               |
| -------------- | ---------------------------------------- |
| Backend        | Node.js, Express                         |
| Admin UI       | Vanilla HTML/CSS/JS, CodeMirror, js-yaml |
| Viewer         | React 18, TypeScript, Vite               |
| Infrastructure | Kubernetes, Helm 3, kubectl              |
| Container      | Docker (multi-stage, Alpine)             |


