const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');

const { createRun } = require('./lib/run');
const { createCache } = require('./lib/cache');
const { ensureInClusterKubeconfig } = require('./lib/kubeconfig');

const REGISTRY_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

const ROOT = __dirname;
const DATA_DIR = process.env.PAT_DATA_DIR || path.join(ROOT, 'data');
const VALUES_FILE = path.join(ROOT, 'infra_values.yaml');
const TEMPLATE_VALUES = path.join(ROOT, 'template_values.yaml');
const DOMAINS_VALUES_DIR = path.join(DATA_DIR, 'domains-values');
const INFRA_NAMESPACE = 'vnext-infra';
const ADMIN_PAGE_ENABLED = process.env.ADMIN_PAGE_ENABLED === 'true';
const PORT = process.env.PORT || 3000;

ensureInClusterKubeconfig();
const { run, runKubectl } = createRun(ROOT);
const { getCached, setCache } = createCache(60 * 1000);

const app = express();
app.set('trust proxy', 1);
app.use(compression({ threshold: 256 }));
app.use(cors());
app.use(express.json());

function ensureDomainsValuesDir() {
  if (!fs.existsSync(DOMAINS_VALUES_DIR)) {
    fs.mkdirSync(DOMAINS_VALUES_DIR, { recursive: true });
  }
}

function getOrCreateDomainValues(domain) {
  ensureDomainsValuesDir();
  const valuesPath = path.join(DOMAINS_VALUES_DIR, `${domain}-values.yaml`);
  if (fs.existsSync(valuesPath)) {
    return { path: valuesPath, created: false };
  }
  let content = fs.readFileSync(TEMPLATE_VALUES, 'utf8');
  content = content.replace(/APP_DOMAIN/g, domain);
  fs.writeFileSync(valuesPath, content, 'utf8');
  return { path: valuesPath, created: true };
}

// --- Adım 1: Infra deploy (+ otomatik discovery domain) ---
const AUTO_DISCOVERY_DOMAIN = 'discovery';

async function deploySingleDomain(domain, chartVersion, { ROOT_TOKEN, REDIS_PASSWORD }) {
  const lines = [];
  try {
    lines.push(`[${domain}]`);
    const { path: valuesPath, created } = getOrCreateDomainValues(domain);
    lines.push(created ? 'Values dosyası oluşturuldu.' : 'Mevcut values kullanılıyor.');

    const DB_NAME = 'vnext_' + domain.replace(/-/g, '_');
    const VAULT_ENGINE_PATH = `vnext-${domain}-engine`;
    const CONN_STR = `Host=vnext-infra-postgres.vnext-infra.svc.cluster.local;Port=5432;Database=${DB_NAME};Username=admin;Password=admin;`;
    const nsName = `vnext-${domain}`;

    const nsResult = await runKubectl(['create', 'namespace', nsName]);
    if (nsResult.code !== 0 && !(nsResult.stderr || '').includes('AlreadyExists')) {
      lines.push('Namespace oluşturulamadı.');
      return { success: false, logs: lines };
    }
    const rbResult = await runKubectl([
      'create', 'rolebinding', 'vnext-local-manager-admin',
      '--clusterrole=cluster-admin',
      '--serviceaccount=vnext-local-manager:vnext-local-manager',
      '-n', nsName,
    ]);
    if (rbResult.code !== 0 && !(rbResult.stderr || '').includes('AlreadyExists')) {
      lines.push('RoleBinding uyarısı.');
    }

    const createDbResult = await runKubectl([
      'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-postgres-0', '--',
      'psql', '-U', 'admin', '-h', 'localhost', '-p', '5432', 'postgres',
      '-c', `CREATE DATABASE "${DB_NAME}";`,
    ]);
    if (createDbResult.code !== 0 && !(createDbResult.stderr || '').includes('already exists')) {
      lines.push('Veritabanı oluşturulamadı.');
    } else {
      lines.push('Veritabanı hazır.');
    }

    const secretsJson = JSON.stringify({
      'ConnectionStrings:Default': CONN_STR,
      'redis-password': REDIS_PASSWORD,
    });
    const secretsB64 = Buffer.from(secretsJson, 'utf8').toString('base64');
    const vaultScript = [
      'set -e',
      'vault login -no-print "$ROOT_TOKEN"',
      'vault secrets enable -path="$VAULT_ENGINE_PATH" kv-v2 2>/dev/null || true',
      'echo "$SECRETS_B64" | base64 -d > /tmp/secrets.json',
      'vault kv put "$VAULT_ENGINE_PATH/workflow-secret" @/tmp/secrets.json',
      'rm -f /tmp/secrets.json',
    ].join('\n');
    const vaultExecResult = await runKubectl([
      'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-vault-0', '--',
      'env', `ROOT_TOKEN=${ROOT_TOKEN}`, `VAULT_ENGINE_PATH=${VAULT_ENGINE_PATH}`, `SECRETS_B64=${secretsB64}`,
      'sh', '-c', vaultScript,
    ]);
    if (vaultExecResult.code !== 0) {
      lines.push('Vault yapılandırması başarısız.');
      return { success: false, logs: lines };
    }
    lines.push('Vault secret yazıldı.');

    const helmRepo = getEffectiveAppConfig().HELM_CHART_REPO || 'oci://registry.example.com/charts/vnext';
    await ensureHelmRegistryLogin(helmRepo);
    const helmArgs = [
      'upgrade', '--install', `vnext-${domain}`, helmRepo,
      '--timeout', '15m',
      '-f', valuesPath,
      '--set', `global.externalVault.vaultToken=${ROOT_TOKEN}`,
      '--set', `global.appDomain=${domain}`,
      '--set', `global.externalVault.secretEngineName=${VAULT_ENGINE_PATH}`,
      '-n', nsName, '--create-namespace', '--force',
    ];
    if (chartVersion) {
      helmArgs.splice(4, 0, '--version', chartVersion);
    }
    const helmResult = await run('helm', helmArgs, { cwd: ROOT });
    lines.push(helmResult.stdout || '');
    if (helmResult.stderr) lines.push(helmResult.stderr);
    if (helmResult.code !== 0) {
      lines.push('Helm deploy başarısız.');
      return { success: false, logs: lines };
    }
    lines.push('Tamamlandı.');
    return { success: true, logs: lines };
  } catch (err) {
    lines.push('Hata: ' + err.message);
    return { success: false, logs: lines };
  }
}

app.post('/api/deploy', async (req, res) => {
  try {
    const { version } = req.body || {};
    const helmRepo = getEffectiveAppConfig().HELM_CHART_REPO || 'oci://registry.example.com/charts/vnext';
    await ensureHelmRegistryLogin(helmRepo);
    const args = [
      'upgrade', '--install', 'vnext-infra', helmRepo,
      '--timeout', '15m', '-f', VALUES_FILE,
      '-n', INFRA_NAMESPACE, '--create-namespace', '--force',
    ];
    if (version && String(version).trim()) {
      args.splice(4, 0, '--version', String(version).trim());
    }
    const helmResult = await run('helm', args, { cwd: ROOT });
    const output = [helmResult.stdout, helmResult.stderr].filter(Boolean).join('\n');
    if (helmResult.code !== 0) {
      return res.status(500).json({ success: false, error: output || `Infra deploy başarısız (çıkış: ${helmResult.code}).` });
    }

    let discoveryResult = null;
    try {
      const vaultKeysResult = await runKubectl([
        'get', 'secret', 'vault-keys', '-n', INFRA_NAMESPACE, '-o', 'json',
      ]);
      if (vaultKeysResult.code !== 0) throw new Error('Vault anahtarları alınamadı.');
      const secret = JSON.parse(vaultKeysResult.stdout);
      const keysB64 = secret.data?.['keys.json'];
      if (!keysB64) throw new Error('keys.json yok');
      const vaultKeysData = JSON.parse(Buffer.from(keysB64, 'base64').toString('utf8'));
      const ROOT_TOKEN = vaultKeysData.root_token;
      if (!ROOT_TOKEN) throw new Error('Vault root token bulunamadı.');

      let REDIS_PASSWORD = '';
      const redisResult = await runKubectl([
        'get', 'secret', 'vnext-infra-redis-sentinel', '-n', INFRA_NAMESPACE, '-o', 'json',
      ]);
      if (redisResult.code === 0) {
        try {
          const rs = JSON.parse(redisResult.stdout);
          const b64 = rs.data?.['redis-password'];
          if (b64) REDIS_PASSWORD = Buffer.from(b64, 'base64').toString('utf8');
        } catch (_) {}
      }

      discoveryResult = await deploySingleDomain(AUTO_DISCOVERY_DOMAIN, '', { ROOT_TOKEN, REDIS_PASSWORD });
    } catch (err) {
      discoveryResult = { success: false, logs: ['Discovery kurulumu atlandı: ' + err.message] };
    }

    const discoveryLog = discoveryResult ? '\n\n--- Discovery domain (otomatik) ---\n' + discoveryResult.logs.join('\n') : '';
    return res.json({
      success: true,
      output: output + discoveryLog,
      discovery: discoveryResult ? { success: discoveryResult.success, logs: discoveryResult.logs } : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Helm bulunamadı veya çalıştırılamadı.' });
  }
});

// --- vnext-infra deploy kontrolü (cache 20s) ---
const ADMIN_CACHE_TTL = 20000;

app.get('/api/check-infra', async (req, res) => {
  if (req.query.refresh !== '1' && req.query.refresh !== 'true') {
    const cached = getCached('admin:check-infra');
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=20');
      return res.json(cached);
    }
  }
  try {
    const { code, stdout } = await run('helm', [
      'list', '-n', INFRA_NAMESPACE, '--deployed', '-o', 'json',
    ], { cwd: ROOT });
    if (code !== 0) {
      return res.json({ deployed: false, message: 'Infra listesi alınamadı.' });
    }
    let list = [];
    try {
      list = JSON.parse(stdout || '[]');
    } catch {
      return res.json({ deployed: false, message: 'Infra bilgisi okunamadı.' });
    }
    const release = list.find((r) => r.name === 'vnext-infra');
    const deployed = !!release && (release.status === 'deployed' || release.status === 'superseded');
    const payload = {
      deployed,
      message: deployed ? undefined : 'Infra deploy edilmemiş.',
      version: release?.chart?.replace('vnext-', ''),
    };
    setCache('admin:check-infra', payload, ADMIN_CACHE_TTL);
    res.setHeader('Cache-Control', 'private, max-age=20');
    res.json(payload);
  } catch (err) {
    res.json({ deployed: false, message: 'Durum kontrol edilemedi.' });
  }
});

// --- Adım 2: Domain(ler) deploy ---
app.post('/api/deploy-domains', async (req, res) => {
  let domains = req.body?.domains;
  const chartVersion = req.body?.chartVersion && String(req.body.chartVersion).trim() ? req.body.chartVersion.trim() : '';
  if (Array.isArray(domains)) {
    domains = domains.map((d) => String(d).trim()).filter(Boolean);
  } else if (typeof domains === 'string') {
    domains = domains.split(/[\n,;\s]+/).map((d) => d.trim()).filter(Boolean);
  } else {
    domains = [];
  }
  if (domains.length === 0) {
    return res.status(400).json({ success: false, error: 'En az bir domain adı girin.' });
  }

  const logs = [];

  try {
    // 1) vnext-infra kontrolü
    const { code: listCode, stdout: listOut } = await run('helm', [
      'list', '-n', INFRA_NAMESPACE, '--deployed', '-o', 'json',
    ], { cwd: ROOT });
    if (listCode !== 0) {
      return res.status(400).json({
        success: false,
        error: 'Infra kontrolü yapılamadı. Önce Adım 1\'i çalıştırın.',
        logs: logs.join('\n'),
      });
    }
    let list = [];
    try {
      list = JSON.parse(listOut || '[]');
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Infra bulunamadı. Önce Adım 1\'i çalıştırın.',
        logs: logs.join('\n'),
      });
    }
    const infraRelease = list.find((r) => r.name === 'vnext-infra');
    if (!infraRelease || (infraRelease.status !== 'deployed' && infraRelease.status !== 'superseded')) {
      return res.status(400).json({
        success: false,
        error: 'Infra hazır değil. Önce Adım 1\'i çalıştırın.',
        logs: logs.join('\n'),
      });
    }
    logs.push('Infra hazır.');

    // 2) Secret'ları al (Node'da parse, jq yok)
    const vaultKeysResult = await runKubectl([
      'get', 'secret', 'vault-keys', '-n', INFRA_NAMESPACE, '-o', 'json',
    ]);
    if (vaultKeysResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: 'Vault anahtarları alınamadı.',
        logs: logs.join('\n'),
      });
    }
    let vaultKeysData;
    try {
      const secret = JSON.parse(vaultKeysResult.stdout);
      const keysB64 = secret.data?.['keys.json'];
      if (!keysB64) throw new Error('keys.json yok');
      const keysJson = Buffer.from(keysB64, 'base64').toString('utf8');
      vaultKeysData = JSON.parse(keysJson);
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: 'Vault anahtarları okunamadı.',
        logs: logs.join('\n'),
      });
    }
    const ROOT_TOKEN = vaultKeysData.root_token;
    if (!ROOT_TOKEN) {
      return res.status(500).json({ success: false, error: 'Vault root token bulunamadı.', logs: logs.join('\n') });
    }

    const redisResult = await runKubectl([
      'get', 'secret', 'vnext-infra-redis-sentinel', '-n', INFRA_NAMESPACE, '-o', 'json',
    ]);
    if (redisResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: 'Redis parolası alınamadı.',
        logs: logs.join('\n'),
      });
    }
    let REDIS_PASSWORD = '';
    try {
      const secret = JSON.parse(redisResult.stdout);
      const b64 = secret.data?.['redis-password'];
      if (b64) REDIS_PASSWORD = Buffer.from(b64, 'base64').toString('utf8');
    } catch (_) {}

    logs.push('Secret\'lar alındı.');
    logs.push(`${domains.length} domain paralel deploy ediliyor.\n`);

    const results = await Promise.all(
      domains.map(async (domain) => {
        const r = await deploySingleDomain(domain, chartVersion, { ROOT_TOKEN, REDIS_PASSWORD });
        return { domain, success: r.success, logs: r.logs };
      }),
    );

    for (const r of results) {
      logs.push('\n' + r.logs.join('\n'));
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      return res.status(500).json({
        success: false,
        error: 'Başarısız domainler: ' + failed.map((r) => r.domain).join(', '),
        logs: logs.join('\n'),
      });
    }

    res.json({ success: true, output: logs.join('\n') });
  } catch (err) {
    logs.push('Hata: ' + err.message);
    res.status(500).json({
      success: false,
      error: 'Beklenmeyen hata. Detay için aşağıdaki loga bakın.',
      logs: logs.join('\n'),
    });
  }
});

// --- Vault keys helper (vnext-infra vault-keys secret) ---
async function getVaultKeysJson() {
  const result = await runKubectl([
    'get', 'secret', 'vault-keys', '-n', INFRA_NAMESPACE, '-o', 'json',
  ]);
  if (result.code !== 0) throw new Error('Vault anahtarları alınamadı.');
  const secret = JSON.parse(result.stdout);
  const b64 = secret.data?.['keys.json'];
  if (!b64) throw new Error('keys.json bulunamadı.');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json);
}

// --- Vault Unseal ---
app.post('/api/vault/unseal', async (_req, res) => {
  try {
    const keysData = await getVaultKeysJson();
    const unsealKey = keysData.keys?.[0];
    if (!unsealKey) return res.status(500).json({ success: false, error: 'Unseal anahtarı bulunamadı.' });
    const execResult = await runKubectl([
      'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-vault-0', '--',
      'env', 'UNSEAL_KEY=' + unsealKey,
      'sh', '-c', 'vault operator unseal "$UNSEAL_KEY"',
    ]);
    if (execResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: execResult.stderr || execResult.stdout || 'Unseal başarısız.',
      });
    }
    res.json({ success: true, message: 'Vault unseal tamamlandı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Vault root token göster ---
app.get('/api/vault/token', async (_req, res) => {
  try {
    const keysData = await getVaultKeysJson();
    const token = keysData.root_token;
    if (!token) return res.status(500).json({ success: false, error: 'Root token bulunamadı.' });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Domain listesi (vnext-* namespace'ler + chart versiyonu) ---
const DOMAIN_NS_PREFIX = 'vnext-';
const DOMAIN_NS_EXCLUDE = new Set(['vnext-infra', 'vnext-local-manager']);

function chartToVersion(chart) {
  if (!chart || typeof chart !== 'string') return '';
  return chart.startsWith('vnext-') ? chart.slice(6) : chart;
}

function getScaleAndReadyFromItems(items) {
  if (!items || items.length === 0) return { scaledToZero: false, allPodsReady: false };
  const scaledToZero = items.every((r) => (r.spec?.replicas ?? 0) === 0);
  const allPodsReady = items.every((r) => {
    const desired = r.spec?.replicas ?? 0;
    if (desired === 0) return true;
    const ready = r.status?.readyReplicas ?? 0;
    return ready >= desired;
  });
  return { scaledToZero, allPodsReady };
}

async function getNamespaceScaleAndReady(namespace) {
  const result = await runKubectl([
    'get', 'deployments,statefulsets', '-n', namespace, '-o', 'json',
  ]);
  if (result.code !== 0) return { scaledToZero: false, allPodsReady: false };
  try {
    const data = JSON.parse(result.stdout || '{}');
    return getScaleAndReadyFromItems(data.items || []);
  } catch (_) {
    return { scaledToZero: false, allPodsReady: false };
  }
}

async function getHelmStatusForNamespace(namespace) {
  const releaseName = namespace;
  const result = await run('helm', ['status', releaseName, '-n', namespace, '-o', 'json'], { cwd: ROOT });
  if (result.code !== 0) return '—';
  try {
    const data = JSON.parse(result.stdout || '{}');
    const status = data.info?.status;
    return status && typeof status === 'string' ? status : '—';
  } catch (_) {
    return '—';
  }
}

app.get('/api/domains', async (req, res) => {
  const wantFull = req.query.full === '1' || req.query.full === 'true';
  const skipCache = req.query.refresh === '1' || req.query.refresh === 'true';
  const cacheKey = wantFull ? 'admin:domains:full' : 'admin:domains';

  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=20');
      return res.json(cached);
    }
  }
  try {
    const [nsResult, helmResult] = await Promise.all([
      runKubectl(['get', 'namespaces', '-o', 'json']),
      run('helm', ['list', '-A', '-o', 'json'], { cwd: ROOT }),
    ]);
    if (nsResult.code !== 0) {
      return res.status(500).json({ success: false, error: 'Namespace listesi alınamadı.' });
    }
    const nsData = JSON.parse(nsResult.stdout || '{}');
    const domainNamespaces = (nsData.items || [])
      .map((ns) => ns.metadata?.name)
      .filter(Boolean)
      .filter((name) => name.startsWith(DOMAIN_NS_PREFIX) && !DOMAIN_NS_EXCLUDE.has(name));

    const versionByNamespace = {};
    const statusByNamespace = {};
    if (helmResult.code === 0) {
      try {
        const releases = JSON.parse(helmResult.stdout || '[]');
        (releases || []).forEach((r) => {
          if (r.namespace && domainNamespaces.includes(r.namespace)) {
            if (r.chart) versionByNamespace[r.namespace] = chartToVersion(r.chart);
            const st = r.status;
            statusByNamespace[r.namespace] = (st && typeof st === 'string') ? st : '—';
          }
        });
      } catch (_) {}
    }

    let scaleReadyList;
    if (wantFull) {
      scaleReadyList = await Promise.all(
        domainNamespaces.map((ns) => getNamespaceScaleAndReady(ns)),
      );
    } else {
      scaleReadyList = domainNamespaces.map(() => ({ scaledToZero: false, allPodsReady: true }));
    }

    const domains = domainNamespaces.map((namespace, i) => {
      const domain = namespace.slice(DOMAIN_NS_PREFIX.length);
      const { scaledToZero, allPodsReady } = scaleReadyList[i];
      const helmStatus = statusByNamespace[namespace] || '—';
      let statusSuffix = '—';
      if (helmStatus !== '—') {
        if (scaledToZero) statusSuffix = '-down';
        else if (allPodsReady) statusSuffix = '-up';
        else statusSuffix = '-starting';
      }
      const status = helmStatus !== '—' ? helmStatus + statusSuffix : helmStatus;
      return {
        domain,
        namespace,
        version: versionByNamespace[namespace] || '—',
        scaledToZero,
        status,
      };
    });
    domains.sort((a, b) => a.domain.localeCompare(b.domain));

    const payload = { success: true, domains };
    setCache(cacheKey, payload, wantFull ? 10000 : ADMIN_CACHE_TTL);
    res.setHeader('Cache-Control', 'private, max-age=20');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Domain restart (rollout restart) ---
app.post('/api/domains/:domain/restart', async (req, res) => {
  const domain = (req.params.domain || '').trim().replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!domain) {
    return res.status(400).json({ success: false, error: 'Domain gerekli.' });
  }
  const ns = DOMAIN_NS_PREFIX + domain;
  try {
    const listResult = await runKubectl([
      'get', 'deployments,statefulsets', '-n', ns, '-o', 'json',
    ]);
    if (listResult.code !== 0) {
      return res.status(500).json({ success: false, error: 'Kaynak listesi alınamadı.' });
    }
    const data = JSON.parse(listResult.stdout || '{}');
    const items = data.items || [];
    const names = items.map((r) => {
      const kind = (r.kind || '').toLowerCase();
      const name = r.metadata?.name;
      if (!name) return null;
      return kind === 'statefulset' ? `statefulset/${name}` : `deployment/${name}`;
    }).filter(Boolean);
    if (names.length === 0) {
      return res.status(400).json({ success: false, error: 'Restart edilecek deployment/statefulset yok.' });
    }
    const scaledToZero = items.every((r) => (r.spec?.replicas ?? 0) === 0);
    if (scaledToZero) {
      return res.status(400).json({
        success: false,
        error: 'Replicalar 0 iken restart yapılamaz. Önce "Aç" ile podları başlatın.',
      });
    }
    const restartResult = await runKubectl([
      'rollout', 'restart', '-n', ns, ...names,
    ]);
    const out = [restartResult.stdout, restartResult.stderr].filter(Boolean).join('\n').trim();
    if (restartResult.code !== 0) {
      return res.status(500).json({ success: false, error: out || 'Restart başarısız.' });
    }
    res.json({ success: true, message: 'Restart tetiklendi.', output: out || undefined });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Domain scale (0 ↔ 1 toggle) ---
app.post('/api/domains/:domain/scale', async (req, res) => {
  const domain = (req.params.domain || '').trim().replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!domain) {
    return res.status(400).json({ success: false, error: 'Domain gerekli.' });
  }
  const ns = DOMAIN_NS_PREFIX + domain;
  try {
    const listResult = await runKubectl([
      'get', 'deployments,statefulsets', '-n', ns, '-o', 'json',
    ]);
    if (listResult.code !== 0) {
      return res.status(500).json({ success: false, error: 'Kaynak listesi alınamadı.' });
    }
    const data = JSON.parse(listResult.stdout || '{}');
    const items = data.items || [];
    const names = items.map((r) => {
      const kind = (r.kind || '').toLowerCase();
      const name = r.metadata?.name;
      if (!name) return null;
      return kind === 'statefulset' ? `statefulset/${name}` : `deployment/${name}`;
    }).filter(Boolean);
    if (names.length === 0) {
      return res.status(400).json({ success: false, error: 'Scale edilecek deployment/statefulset yok.' });
    }
    const scaledToZero = items.every((r) => (r.spec?.replicas ?? 0) === 0);
    const replicas = scaledToZero ? 1 : 0;
    const scaleResult = await runKubectl([
      'scale', '--replicas=' + replicas, ...names, '-n', ns,
    ]);
    if (scaleResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: (scaleResult.stderr || scaleResult.stdout || 'Scale başarısız.').trim(),
      });
    }
    res.json({
      success: true,
      message: replicas === 0 ? 'Replicalar 0 yapıldı.' : 'Podlar tekrar açıldı.',
      scaledToZero: replicas === 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Domain values dosyası (path traversal önleme) ---
function domainToValuesPath(domain) {
  const safe = String(domain).trim().replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!safe) return null;
  return path.join(DOMAINS_VALUES_DIR, `${safe}-values.yaml`);
}

// GET domain values içeriği
app.get('/api/domains/:domain/values', (req, res) => {
  const valuesPath = domainToValuesPath(req.params.domain);
  if (!valuesPath || !fs.existsSync(valuesPath)) {
    return res.status(404).json({ success: false, error: 'Values dosyası bulunamadı.' });
  }
  try {
    const content = fs.readFileSync(valuesPath, 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT domain values kaydet
app.put('/api/domains/:domain/values', (req, res) => {
  const valuesPath = domainToValuesPath(req.params.domain);
  if (!valuesPath) {
    return res.status(400).json({ success: false, error: 'Geçersiz domain.' });
  }
  const content = req.body?.content;
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'content gerekli.' });
  }
  try {
    ensureDomainsValuesDir();
    fs.writeFileSync(valuesPath, content, 'utf8');
    res.json({ success: true, message: 'Kaydedildi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST domain helm upgrade (mevcut values ile)
app.post('/api/domain-upgrade', async (req, res) => {
  const domain = req.body?.domain && String(req.body.domain).trim();
  if (!domain) {
    return res.status(400).json({ success: false, error: 'Domain girin.' });
  }
  const valuesPath = domainToValuesPath(domain);
  if (!valuesPath || !fs.existsSync(valuesPath)) {
    return res.status(400).json({ success: false, error: 'Values dosyası bulunamadı. Önce domain deploy edin.' });
  }
  const ns = `vnext-${domain}`;
  try {
    const keysData = await getVaultKeysJson();
    const ROOT_TOKEN = keysData.root_token;
    if (!ROOT_TOKEN) return res.status(500).json({ success: false, error: 'Vault root token alınamadı.' });
    const VAULT_ENGINE_PATH = `vnext-${domain}-engine`;

    const listResult = await run('helm', ['list', '-n', ns, '-o', 'json'], { cwd: ROOT });
    let chartVersion = '';
    if (listResult.code === 0) {
      try {
        const list = JSON.parse(listResult.stdout || '[]');
        const release = list.find((r) => r.name === `vnext-${domain}`);
        if (release?.chart) chartVersion = release.chart.replace(/^vnext-/, '');
      } catch (_) {}
    }

    const helmRepo = getEffectiveAppConfig().HELM_CHART_REPO || 'oci://registry.example.com/charts/vnext';
    await ensureHelmRegistryLogin(helmRepo);
    const helmArgs = [
      'upgrade', '--install', `vnext-${domain}`, helmRepo,
      '--timeout', '15m', '-f', valuesPath,
      '--set', `global.externalVault.vaultToken=${ROOT_TOKEN}`,
      '--set', `global.appDomain=${domain}`,
      '--set', `global.externalVault.secretEngineName=${VAULT_ENGINE_PATH}`,
      '-n', ns, '--force',
    ];
    if (chartVersion) helmArgs.splice(4, 0, '--version', chartVersion);

    const helmResult = await run('helm', helmArgs, { cwd: ROOT });
    if (helmResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: helmResult.stderr || helmResult.stdout || 'Helm upgrade başarısız.',
      });
    }
    res.json({ success: true, message: 'Helm upgrade tamamlandı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Domain silme (helm delete + namespace delete) ---
app.post('/api/domains/delete', async (req, res) => {
  let domains = req.body?.domains;
  const confirm = req.body?.confirm;
  if (confirm !== 'yes') {
    return res.status(400).json({ success: false, error: 'Onay için "yes" yazın.' });
  }
  if (Array.isArray(domains)) {
    domains = domains.map((d) => String(d).trim()).filter(Boolean);
  } else if (typeof domains === 'string') {
    domains = domains.split(/[\n,;\s]+/).map((d) => d.trim()).filter(Boolean);
  } else {
    domains = [];
  }
  if (domains.length === 0) {
    return res.status(400).json({ success: false, error: 'En az bir domain girin.' });
  }

  const logs = [];
  const failed = [];
  let rootToken = null;

  for (const domain of domains) {
    const ns = `vnext-${domain}`;
    const vaultPath = `vnext-${domain}-engine`;
    const dbName = 'vnext_' + domain.replace(/-/g, '_');

    logs.push(`${domain}: helm delete…`);
    const helmResult = await run('helm', ['delete', `vnext-${domain}`, '-n', ns], { cwd: ROOT });
    if (helmResult.stdout) logs.push(helmResult.stdout.trim());
    if (helmResult.stderr && helmResult.code !== 0) logs.push(helmResult.stderr.trim());
    if (helmResult.code !== 0) failed.push(domain);

    try {
      if (!rootToken) {
        const keys = await getVaultKeysJson();
        rootToken = keys.root_token;
      }
      if (rootToken) {
        logs.push(`${domain}: Vault engine kapatılıyor…`);
        const vaultResult = await runKubectl([
          'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-vault-0', '--',
          'env', 'ROOT_TOKEN=' + rootToken, 'VAULT_PATH=' + vaultPath,
          'sh', '-c', 'vault login -no-print "$ROOT_TOKEN" && vault secrets disable "$VAULT_PATH" 2>/dev/null || true',
        ]);
        if (vaultResult.code === 0) logs.push('Vault engine kapatıldı.');
      }
    } catch (e) {
      logs.push('Vault: ' + (e.message || 'atlandı'));
    }

    logs.push(`${domain}: Postgres DB siliniyor…`);
    const termResult = await runKubectl([
      'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-postgres-0', '--',
      'psql', '-U', 'admin', '-h', 'localhost', '-p', '5432', 'postgres', '-t', '-A',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName.replace(/'/g, "''")}' AND pid <> pg_backend_pid();`,
    ]);
    if (termResult.code !== 0) logs.push('DB bağlantıları kapatılırken: ' + (termResult.stderr || termResult.stdout || '').trim());
    const dropResult = await runKubectl([
      'exec', '-n', INFRA_NAMESPACE, 'vnext-infra-postgres-0', '--',
      'psql', '-U', 'admin', '-h', 'localhost', '-p', '5432', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '""')}";`,
    ]);
    if (dropResult.code === 0) logs.push('DB silindi.');
    else logs.push('DB: ' + (dropResult.stderr || dropResult.stdout || '').trim());

    const valuesPath = domainToValuesPath(domain);
    if (valuesPath && fs.existsSync(valuesPath)) {
      try {
        fs.unlinkSync(valuesPath);
        logs.push('Values dosyası silindi.');
      } catch (e) {
        logs.push('Values dosyası: ' + (e.message || 'silinemedi'));
      }
    }

    logs.push(`${domain}: namespace siliniyor…`);
    const nsResult = await runKubectl(['delete', 'namespace', ns]);
    if (nsResult.code !== 0 && !(nsResult.stderr || '').includes('NotFound')) {
      logs.push(nsResult.stderr || nsResult.stdout);
      failed.push(domain);
    } else {
      logs.push(`${domain} silindi.`);
    }
  }

  if (failed.length > 0) {
    return res.status(500).json({
      success: false,
      error: 'Başarısız: ' + failed.join(', '),
      logs: logs.join('\n'),
    });
  }
  res.json({ success: true, message: 'Domain(ler) silindi.', logs: logs.join('\n') });
});

// --- Tüm vnext ortamlarını kaldır (tüm vnext-* release ve namespace) ---
app.post('/api/teardown-all', async (req, res) => {
  if (req.body?.confirm !== 'yes') {
    return res.status(400).json({ success: false, error: 'Onay için "yes" yazın.' });
  }

  const listResult = await run('helm', ['list', '-A', '-o', 'json'], { cwd: ROOT });
  if (listResult.code !== 0) {
    return res.status(500).json({ success: false, error: 'Helm listesi alınamadı.' });
  }
  let releases = [];
  try {
    releases = JSON.parse(listResult.stdout || '[]').filter(
      (r) => r.name && String(r.name).startsWith('vnext-') && r.namespace,
    );
  } catch (_) {}

  if (releases.length === 0) {
    return res.json({ success: true, message: 'Silinecek vnext release yok.', deleted: [] });
  }

  const logs = [];
  const deleted = [];
  const failed = [];

  for (const r of releases) {
    const { name, namespace } = r;
    logs.push(`${name} (${namespace}): helm delete…`);
    const helmResult = await run('helm', ['delete', name, '-n', namespace], { cwd: ROOT });
    if (helmResult.stdout) logs.push(helmResult.stdout.trim());
    if (helmResult.stderr && helmResult.code !== 0) logs.push(helmResult.stderr.trim());
    if (helmResult.code !== 0) failed.push(name);

    logs.push(`${namespace}: namespace siliniyor…`);
    const nsResult = await runKubectl(['delete', 'namespace', namespace]);
    if (nsResult.code !== 0 && !(nsResult.stderr || '').includes('NotFound')) {
      logs.push(nsResult.stderr || nsResult.stdout);
      failed.push(namespace);
    } else {
      deleted.push(name);
      logs.push(`${name} kaldırıldı.`);
    }
  }

  if (failed.length > 0) {
    return res.status(500).json({
      success: false,
      error: 'Başarısız: ' + [...new Set(failed)].join(', '),
      logs: logs.join('\n'),
      deleted,
    });
  }
  res.json({
    success: true,
    message: 'Tüm vnext ortamları kaldırıldı.',
    deleted,
    logs: logs.join('\n'),
  });
});

// --- Infra credentials (Postgres/pgAdmin, OpenObserve, Redis, Vault) ---
function decodeSecretData(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, b64] of Object.entries(data)) {
    try {
      out[key] = Buffer.from(b64, 'base64').toString('utf8');
    } catch (_) {}
  }
  return out;
}

app.get('/api/infra-credentials', async (req, res) => {
  if (req.query.refresh !== '1' && req.query.refresh !== 'true') {
    const cached = getCached('admin:credentials');
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=30');
      return res.json(cached);
    }
  }
  try {
    const creds = { postgres: {}, openobserve: {}, redis: {}, vault: {} };

    const [pgResult, obResult, redisResult, vaultKeys] = await Promise.all([
      runKubectl(['get', 'secret', 'vnext-infra-pgadmin-credentials', '-n', INFRA_NAMESPACE, '-o', 'json']),
      runKubectl(['get', 'deploy', 'vnext-infra-openobserve', '-n', INFRA_NAMESPACE, '-o', 'json']),
      runKubectl(['get', 'secret', 'vnext-infra-redis-sentinel', '-n', INFRA_NAMESPACE, '-o', 'json']),
      getVaultKeysJson().catch(() => ({ root_token: '' })),
    ]);

    if (pgResult.code === 0) {
      try {
        const secret = JSON.parse(pgResult.stdout);
        creds.postgres = decodeSecretData(secret.data);
      } catch (_) {}
    }
    if (obResult.code === 0) {
      try {
        const deploy = JSON.parse(obResult.stdout);
        const env = deploy?.spec?.template?.spec?.containers?.[0]?.env || [];
        creds.openobserve = { email: env[0]?.value ?? '', password: env[1]?.value ?? '' };
      } catch (_) {}
    }
    if (redisResult.code === 0) {
      try {
        const secret = JSON.parse(redisResult.stdout);
        creds.redis = decodeSecretData(secret.data);
      } catch (_) {}
    }
    creds.vault = { root_token: vaultKeys.root_token || '' };

    const payload = { success: true, credentials: creds };
    setCache('admin:credentials', payload, 30000);
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Infra ve uygulama URL'leri (NodePort) ---
async function getServiceNodePort(namespace, serviceName) {
  const result = await runKubectl([
    'get', 'svc', serviceName, '-n', namespace, '-o', 'json',
  ]);
  if (result.code !== 0) return null;
  try {
    const svc = JSON.parse(result.stdout);
    const ports = svc?.spec?.ports || [];
    const first = ports[0];
    return first?.nodePort != null ? first.nodePort : null;
  } catch (_) {
    return null;
  }
}

app.get('/api/urls', async (req, res) => {
  if (req.query.refresh !== '1' && req.query.refresh !== 'true') {
    const cached = getCached('admin:urls');
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=20');
      return res.json(cached);
    }
  }
  try {
    const infraServices = [
      { name: 'Vault', svc: 'vnext-infra-vault', ns: INFRA_NAMESPACE },
      { name: 'OpenObserve', svc: 'vnext-infra-openobserve', ns: INFRA_NAMESPACE },
      { name: 'Redis Insight', svc: 'vnext-infra-redis-insight', ns: INFRA_NAMESPACE },
      { name: 'PgAdmin', svc: 'vnext-infra-pgadmin4', ns: INFRA_NAMESPACE },
      { name: 'Postgres', svc: 'vnext-infra-postgres', ns: INFRA_NAMESPACE },
      { name: 'Dapr Dashboard', svc: 'dapr-dashboard', ns: INFRA_NAMESPACE },
    ];

    const nsResult = await runKubectl(['get', 'namespaces', '-o', 'json']);
    let domainNamespaces = [];
    if (nsResult.code === 0) {
      try {
        const data = JSON.parse(nsResult.stdout || '{}');
        domainNamespaces = (data.items || [])
          .map((ns) => ns.metadata?.name)
          .filter(Boolean)
          .filter((n) => n.startsWith('vnext-') && !['vnext-infra', 'vnext-local-manager'].includes(n));
      } catch (_) {}
    }

    const infraPortPromises = infraServices.map(({ name, svc, ns }) =>
      getServiceNodePort(ns, svc).then((port) => ({ name, url: port != null ? `http://localhost:${port}` : null })),
    );
    const appPortPromises = domainNamespaces.map((ns) => {
      const domain = ns.replace(/^vnext-/, '');
      return getServiceNodePort(ns, `vnext-${domain}-orchestrator`).then((port) => ({
        name: `vnext-${domain}`,
        url: port != null ? `http://localhost:${port}/swagger/index.html` : null,
      }));
    });

    const [infrastructure, applications] = await Promise.all([
      Promise.all(infraPortPromises),
      Promise.all(appPortPromises),
    ]);

    const payload = { success: true, infrastructure, applications };
    setCache('admin:urls', payload, ADMIN_CACHE_TTL);
    res.setHeader('Cache-Control', 'private, max-age=20');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Uygulama konfigürasyonları (env + kullanıcı override) ---
const APP_CONFIG_FILE = path.join(DATA_DIR, 'app-config.json');
const APP_CONFIG_KEYS = ['NPM_REGISTRY', 'NPM_EMAIL', 'NPM_USERNAME', 'NPM_PASSWORD', 'HELM_CHART_REPO', 'REGISTRY_USER', 'REGISTRY_PASSWORD'];
const APP_CONFIG_DEFAULTS = {
  NPM_REGISTRY: 'https://registry.npmjs.org/',
  NPM_EMAIL: 'vnext-user@example.com',
  NPM_USERNAME: 'vnext-user',
  NPM_PASSWORD: '',
  HELM_CHART_REPO: 'oci://registry.example.com/charts/vnext',
  REGISTRY_USER: '',
  REGISTRY_PASSWORD: '',
};

function readAppConfigOverrides() {
  try {
    if (fs.existsSync(APP_CONFIG_FILE)) {
      const raw = fs.readFileSync(APP_CONFIG_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data;
    }
  } catch (_) {}
  return {};
}

function writeAppConfigOverrides(overrides) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const key of APP_CONFIG_KEYS) {
      if (overrides[key] !== undefined && overrides[key] !== null) {
        const v = String(overrides[key]).trim();
        out[key] = v;
      }
    }
    fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (_) {}
}

function readPatFromFile() {
  try {
    const patFile = path.join(DATA_DIR, '.pat');
    if (fs.existsSync(patFile)) {
      return fs.readFileSync(patFile, 'utf8').trim() || null;
    }
  } catch (_) {}
  return null;
}

function getEffectiveAppConfig() {
  const overrides = readAppConfigOverrides();
  const result = {};
  for (const key of APP_CONFIG_KEYS) {
    const override = overrides[key];
    if (override !== undefined && override !== null && String(override).trim() !== '') {
      result[key] = String(override).trim();
    } else if (key === 'NPM_PASSWORD') {
      result[key] = readPatFromFile() || (process.env[key] != null ? String(process.env[key]).trim() : '');
    } else {
      const envVal = process.env[key];
      result[key] = envVal != null ? String(envVal).trim() : (APP_CONFIG_DEFAULTS[key] || '');
    }
  }
  return result;
}

// --- Helm Release Viewer: parse HELM_CHART_REPO (oci://host/project/chart) ---
function parseHelmChartRepo(ociUrl) {
  const raw = (ociUrl || '').trim();
  if (!raw.startsWith('oci://')) return null;
  const without = raw.slice(6).replace(/\/+$/, '');
  const parts = without.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const registry = parts[0];
  const project = parts[1];
  const chart_name = parts.slice(2).join('/') || parts[1];
  const full_path = `oci://${registry}/${project}/${chart_name}`;
  return { registry, project, chart_name, full_path };
}

// Helm OCI pull için registry login (ghcr.io, Harbor vb. private registry)
async function ensureHelmRegistryLogin(ociRepoUrl) {
  const parsed = parseHelmChartRepo(ociRepoUrl || '');
  if (!parsed) return;
  const cfg = getEffectiveAppConfig();
  const user = (cfg.REGISTRY_USER || '').trim();
  const password = (cfg.REGISTRY_PASSWORD || '').trim();
  if (!user || !password) return;
  const result = await run('helm', ['registry', 'login', parsed.registry, '-u', user, '-p', password], { cwd: ROOT });
  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || '').trim() || 'Registry login failed.';
    throw new Error(`Helm registry login (${parsed.registry}) başarısız: ${msg}. REGISTRY_USER ve REGISTRY_PASSWORD (ghcr.io için PAT) kontrol edin.`);
  }
}

// --- Helm Release Viewer: admin panel erişilebilir mi? ---
// Ingress/load balancer sağlık kontrolü (SPA yüklemeden hızlı yanıt)
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/v1/admin-available', (_req, res) => {
  res.json({ enabled: ADMIN_PAGE_ENABLED });
});

// --- Helm Release Viewer API (HELM_CHART_REPO from config) ---
app.get('/api/v1/config', (_req, res) => {
  try {
    const repo = getEffectiveAppConfig().HELM_CHART_REPO || '';
    const parsed = parseHelmChartRepo(repo);
    if (!parsed) {
      return res.status(503).json({
        error: 'HELM_CHART_REPO tanımlı değil veya geçersiz (oci://host/project/chart formatında olmalı).',
      });
    }
    res.json({
      registry: parsed.registry,
      project: parsed.project,
      chart_name: parsed.chart_name,
      full_path: parsed.full_path,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HTTPS GET (self-signed cert destekli, registry istekleri için); opts.binary true ise body Buffer döner
function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'application/json', ...opts.headers },
      agent: REGISTRY_HTTPS_AGENT,
      timeout: opts.timeout || 30000,
    };
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => { chunks.push(chunk); });
      resp.on('end', () => {
        const body = opts.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8');
        resolve({
          status: resp.statusCode,
          headers: resp.headers,
          body,
          json: opts.binary ? undefined : () => {
            try {
              return JSON.parse(body);
            } catch {
              throw new Error(body || 'Invalid JSON');
            }
          },
        });
      });
    });
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

// OCI registry: 401 alındığında Bearer token al (opsiyonel Basic auth: registryUser, registryPassword)
async function getOciBearerToken(registry, repoPath, wwwAuthHeader, baseUrl, credentials) {
  if (!wwwAuthHeader || !wwwAuthHeader.includes('Bearer')) return null;
  const params = {};
  for (const part of wwwAuthHeader.replace(/^Bearer\s+/i, '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
      params[k] = v;
    }
  }
  let realm = params.realm;
  if (!realm) return null;
  if (realm.startsWith('/')) {
    realm = `${baseUrl}${realm}`;
  }
  const service = params.service || 'harbor-registry';
  const scope = params.scope || `repository:${repoPath}:pull`;
  const tokenUrl = `${realm}${realm.includes('?') ? '&' : '?'}service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}`;
  const authOpts = { timeout: 10000 };
  if (credentials && credentials.user && credentials.password) {
    authOpts.headers = {
      Authorization: 'Basic ' + Buffer.from(credentials.user + ':' + credentials.password, 'utf8').toString('base64'),
    };
  }
  try {
    const tokenRes = await httpsGet(tokenUrl, authOpts);
    if (tokenRes.status !== 200) return null;
    let tokenData;
    try {
      tokenData = tokenRes.json();
    } catch {
      return null;
    }
    return tokenData.token || tokenData.access_token || null;
  } catch {
    return null;
  }
}

const HELM_CONFIG_MEDIA_TYPE = 'application/vnd.cncf.helm.config.v1+json';

// Index'teki her manifest için config blob'unu dene; appVersion içeren ilk blob'u bul (ghcr.io mediaType set etmeyebilir)
async function resolveHelmManifestFromIndex(baseUrl, repoPath, indexJson, authHeaders) {
  const manifests = indexJson.manifests;
  if (!Array.isArray(manifests) || manifests.length === 0) return null;
  const order = [];
  const prefer = manifests.find((m) => m.platform && m.platform.architecture === 'amd64' && (m.platform.os === 'linux' || !m.platform.os));
  if (prefer) order.push(prefer);
  for (const m of manifests) {
    if (m !== prefer && m.digest) order.push(m);
  }
  for (const desc of order) {
    if (!desc.digest) continue;
    try {
      const singleUrl = `${baseUrl}/v2/${repoPath}/manifests/${desc.digest}`;
      const singleRes = await httpsGet(singleUrl, {
        headers: { Accept: 'application/vnd.oci.image.manifest.v1+json', ...authHeaders },
        timeout: 5000,
      });
      if (singleRes.status !== 200) continue;
      const man = singleRes.json();
      const config = man.config || {};
      if (!config.digest) continue;
      const blobUrl = `${baseUrl}/v2/${repoPath}/blobs/${config.digest}`;
      const blobRes = await httpsGet(blobUrl, { headers: authHeaders, timeout: 5000 });
      if (blobRes.status !== 200) continue;
      const blob = blobRes.json();
      const appVer = appVersionFromConfigBlob(blob);
      if (appVer != null) return { manifest: man, app_version: appVer };
    } catch (_) {}
  }
  const fallback = order[0] || manifests[0];
  if (!fallback || !fallback.digest) return null;
  try {
    const singleUrl = `${baseUrl}/v2/${repoPath}/manifests/${fallback.digest}`;
    const singleRes = await httpsGet(singleUrl, {
      headers: { Accept: 'application/vnd.oci.image.manifest.v1+json', ...authHeaders },
      timeout: 5000,
    });
    if (singleRes.status !== 200) return null;
    const fallbackMan = singleRes.json();
    const fromLayer = await appVersionFromChartLayer(baseUrl, repoPath, fallbackMan, authHeaders);
    return { manifest: fallbackMan, app_version: fromLayer };
  } catch (_) {
    return null;
  }
}

// Config blob'dan appVersion al; container image config (architecture/os) ise kullanma, chart version (version) kullanma
function appVersionFromConfigBlob(blob) {
  if (!blob || typeof blob !== 'object') return null;
  if (blob.architecture != null && blob.os != null) return null;
  const v = blob.appVersion ?? blob.AppVersion ?? blob.app_version ?? (blob.chart && (blob.chart.appVersion ?? blob.chart.AppVersion ?? blob.chart.app_version));
  return v != null ? String(v) : null;
}

// Helm chart layer (tar+gzip) içinde Chart.yaml'dan appVersion çıkar (ghcr.io config blob image config ise)
async function appVersionFromChartLayer(baseUrl, repoPath, manifest, authHeaders) {
  const layers = manifest.layers || [];
  const chartLayer = layers.find((l) => (l.mediaType || '').includes('helm') && (l.mediaType || '').includes('chart'));
  const layer = chartLayer || layers[0];
  if (!layer || !layer.digest) return null;
  try {
    const blobUrl = `${baseUrl}/v2/${repoPath}/blobs/${layer.digest}`;
    const blobRes = await httpsGet(blobUrl, { headers: authHeaders, timeout: 10000, binary: true });
    if (blobRes.status !== 200 || !Buffer.isBuffer(blobRes.body)) return null;
    let buf = blobRes.body;
    if ((layer.mediaType || '').includes('gzip')) {
      buf = zlib.gunzipSync(buf);
    }
    const str = buf.toString('utf8');
    const m = str.match(/appVersion:\s*["']?([^"'\r\n]+)["']?/);
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

// Tek bir tag için manifest al; digest, app_version, created döndür (index + Helm config, ghcr.io uyumlu)
async function fetchManifestForTag(baseUrl, repoPath, tag, authHeaders) {
  const manifestUrl = `${baseUrl}/v2/${repoPath}/manifests/${tag}`;
  const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
  const opts = {
    headers: { Accept: accept, ...authHeaders },
    timeout: 8000,
  };
  const res = await httpsGet(manifestUrl, opts);
  if (res.status !== 200) return {};
  const digest = res.headers['docker-content-digest'] || res.headers['content-digest'] || null;
  let app_version = null;
  let created = null;
  try {
    let manifest = res.json();
    if (manifest.manifests && Array.isArray(manifest.manifests)) {
      const resolved = await resolveHelmManifestFromIndex(baseUrl, repoPath, manifest, authHeaders);
      if (resolved) {
        manifest = resolved.manifest;
        if (resolved.app_version != null) app_version = resolved.app_version;
      }
    }
    const annotations = manifest.annotations || {};
    const labels = manifest.labels || {};
    created = annotations['org.opencontainers.image.created'] || labels['org.opencontainers.image.created'] || created;
    app_version = labels['org.opencontainers.image.appVersion'] ?? annotations['org.opencontainers.image.appVersion'] ?? app_version;
    if (app_version == null) {
      const config = manifest.config || {};
      if (config.digest) {
        const blobUrl = `${baseUrl}/v2/${repoPath}/blobs/${config.digest}`;
        const blobRes = await httpsGet(blobUrl, { headers: authHeaders, timeout: 5000 });
        if (blobRes.status === 200) {
          try {
            const blob = blobRes.json();
            app_version = appVersionFromConfigBlob(blob);
          } catch (_) {}
        }
      }
      if (app_version == null && (manifest.layers || []).length > 0) {
        app_version = await appVersionFromChartLayer(baseUrl, repoPath, manifest, authHeaders);
      }
    }
  } catch (_) {}
  return { digest, app_version, created };
}

app.get('/api/v1/chart/versions', async (req, res) => {
  const skipCache = req.query.refresh === 'true' || req.query.refresh === '1';
  if (!skipCache) {
    const cached = getCached('chart-versions');
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(cached);
    }
  }
  try {
    const cfg = getEffectiveAppConfig();
    const repo = cfg.HELM_CHART_REPO || '';
    const parsed = parseHelmChartRepo(repo);
    if (!parsed) {
      return res.status(503).json({
        error: 'HELM_CHART_REPO tanımlı değil veya geçersiz.',
      });
    }
    const { registry, project, chart_name } = parsed;
    const baseUrl = `https://${registry}`;
    const repoPath = `${project}/${chart_name}`;
    const tagsUrl = `${baseUrl}/v2/${repoPath}/tags/list`;
    let authHeaders = {};
    if (cfg.REGISTRY_USER && cfg.REGISTRY_PASSWORD) {
      authHeaders = {
        Authorization: 'Basic ' + Buffer.from(cfg.REGISTRY_USER + ':' + cfg.REGISTRY_PASSWORD, 'utf8').toString('base64'),
      };
    }
    let response = await httpsGet(tagsUrl, { headers: authHeaders });
    if (response.status === 401) {
      const wwwAuth = response.headers['www-authenticate'];
      const token = await getOciBearerToken(registry, repoPath, wwwAuth, baseUrl, {
        user: cfg.REGISTRY_USER || '',
        password: cfg.REGISTRY_PASSWORD || '',
      });
      if (token) {
        authHeaders = { Authorization: `Bearer ${token}` };
        response = await httpsGet(tagsUrl, { headers: authHeaders });
      }
    }
    if (response.status !== 200) {
      throw new Error(`Registry ${response.status}: ${(response.body || '').slice(0, 200)}`);
    }
    const data = response.json();
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const tagList = tags.filter((t) => t && typeof t === 'string');
    const BATCH = 25;
    const versions = [];
    for (let i = 0; i < tagList.length; i += BATCH) {
      const batch = tagList.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (tag) => {
          const extra = await fetchManifestForTag(baseUrl, repoPath, tag, authHeaders);
          return { name: chart_name, version: tag, ...extra };
        }),
      );
      versions.push(...results);
    }
    versions.sort((a, b) => {
      const pa = (a.version || '').replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
      const pb = (b.version || '').replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va !== vb) return vb - va;
      }
      return 0;
    });
    const payload = {
      chart_name,
      registry: `oci://${registry}/${project}/${chart_name}`,
      versions,
      total_count: versions.length,
    };
    setCache('chart-versions', payload, 120000);
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Chart versions alınamadı.' });
  }
});

app.get('/api/v1/releases', async (req, res) => {
  const skipCache = req.query.refresh === 'true' || req.query.refresh === '1';
  const chartFilter = (req.query.chart != null ? String(req.query.chart) : '').trim();
  const cacheKey = `releases:${chartFilter}`;
  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(cached);
    }
  }
  try {
    const repo = getEffectiveAppConfig().HELM_CHART_REPO || '';
    const parsed = parseHelmChartRepo(repo);
    const chartName = parsed ? parsed.chart_name : (chartFilter || 'vnext');
    const { code, signal, stdout, stderr } = await run('helm', ['list', '-A', '-o', 'json'], { cwd: ROOT });
    if (code !== 0 || signal) {
      let detail = (stderr || stdout || '').trim();
      if (!detail && signal) {
        detail = signal === 'SIGKILL'
          ? 'Process killed (SIGKILL). OOM veya kaynak limiti olabilir – pod memory/CPU artırın.'
          : `Process killed (signal: ${signal}).`;
      }
      if (!detail) detail = code != null ? `exit code ${code}` : 'Process failed to complete.';
      return res.status(500).json({
        error: 'Helm list çalıştırılamadı.',
        detail,
        releases: [],
        total_count: 0,
      });
    }
    let list = [];
    try {
      list = JSON.parse(stdout || '[]');
    } catch {
      return res.json({ chart_filter: chartName, releases: [], total_count: 0 });
    }
    const filter = (chartFilter || chartName || '').toLowerCase();
    const releases = list
      .filter((r) => !filter || (r.chart && r.chart.toLowerCase().includes(filter)))
      .map((r) => {
        const ch = (r.chart || '').trim();
        const lastDash = ch.lastIndexOf('-');
        const chart_name = lastDash > 0 ? ch.slice(0, lastDash) : ch;
        const chart_version = lastDash >= 0 ? ch.slice(lastDash + 1) : '';
        const lastDeployed = r.info?.last_deployed ?? r.updated ?? r.info?.updated ?? undefined;
        const firstDeployed = r.info?.first_deployed ?? undefined;
        const revision = typeof r.revision === 'number' ? r.revision : parseInt(String(r.revision || '0'), 10) || 0;
        return {
          name: r.name || '',
          namespace: r.namespace || '',
          chart_name: chart_name || '',
          chart_version,
          app_version: r.app_version || undefined,
          status: r.status || 'unknown',
          revision,
          first_deployed: firstDeployed,
          last_deployed: lastDeployed,
        };
      });
    const payload = { chart_filter: chartName, releases, total_count: releases.length };
    setCache(cacheKey, payload, 60000);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    const detail = err.code === 'ENOENT'
      ? 'helm veya kubectl bulunamadı (PATH kontrol edin).'
      : (err.stderr || err.stdout || err.message);
    res.status(500).json({
      error: err.message || 'Releases alınamadı.',
      detail,
      releases: [],
      total_count: 0,
    });
  }
});

app.get('/api/app-config', (_req, res) => {
  try {
    res.json({ success: true, config: getEffectiveAppConfig() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/app-config', (req, res) => {
  try {
    const overrides = readAppConfigOverrides();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    for (const key of APP_CONFIG_KEYS) {
      if (body[key] !== undefined) {
        const v = body[key] == null ? '' : String(body[key]).trim();
        if (v === '') delete overrides[key];
        else overrides[key] = v;
      }
    }
    writeAppConfigOverrides(overrides);
    res.json({ success: true, config: getEffectiveAppConfig() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Push package (initializer pod içinde npm publish) ---
app.post('/api/push-package', async (req, res) => {
  const domain = req.body?.domain && String(req.body.domain).trim();
  const packageName = req.body?.packageName && String(req.body.packageName).trim();
  const version = req.body?.version && String(req.body.version).trim();
  const cfg = getEffectiveAppConfig();
  const pat = (cfg.NPM_PASSWORD || '').trim();

  if (!domain) {
    return res.status(400).json({ success: false, error: 'Domain girin.' });
  }
  if (!packageName) {
    return res.status(400).json({ success: false, error: 'Paket adı girin.' });
  }
  if (!pat) {
    return res.status(400).json({ success: false, error: 'NPM_PASSWORD konfigürasyonda tanımlı değil. Konfigürasyon sekmesinden ayarlayın.' });
  }

  const ns = `vnext-${domain}`;

  try {
    const statusResult = await run('helm', ['status', `vnext-${domain}`, '-n', ns], { cwd: ROOT });
    if (statusResult.code !== 0) {
      return res.status(400).json({
        success: false,
        error: `vnext-${domain} release bulunamadı. Önce domain deploy edin.`,
      });
    }

    const podsResult = await runKubectl(['get', 'pods', '-n', ns, '-o', 'json']);
    if (podsResult.code !== 0) {
      return res.status(500).json({ success: false, error: 'Pod listesi alınamadı.' });
    }
    const podsData = JSON.parse(podsResult.stdout || '{}');
    const pods = (podsData.items || []).filter(
      (p) => p.metadata?.name?.includes('orchestrator-initial') && p.status?.phase === 'Running',
    );
    const initializerPod = pods[0]?.metadata?.name;
    if (!initializerPod) {
      return res.status(400).json({
        success: false,
        error: 'Orchestrator initializer pod bulunamadı veya çalışmıyor.',
      });
    }

    const publishPayload = {
      packageName,
      version: version || '',
      npmUsername: cfg.NPM_USERNAME || 'vnext-user',
      npmPassword: pat,
      appDomain: domain,
      npmRegistry: cfg.NPM_REGISTRY || '',
      npmEmail: cfg.NPM_EMAIL || '',
    };
    const publishJson = JSON.stringify(publishPayload);

    const execResult = await runKubectl([
      'exec', '-n', ns, initializerPod, '--',
      'env', 'PUBLISH_JSON=' + publishJson,
      'sh', '-c', 'curl -s -X POST -H "Content-Type: application/json" -d "$PUBLISH_JSON" http://localhost:3000/api/package/publish',
    ]);

    if (execResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: execResult.stderr || execResult.stdout || 'Package push başarısız.',
      });
    }

    res.json({
      success: true,
      message: 'Package push tamamlandı.',
      output: (execResult.stdout || '').trim() || undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const STATIC_CACHE = process.env.NODE_ENV === 'production' ? '1d' : 0;

if (ADMIN_PAGE_ENABLED) {
  app.use('/admin', express.static(path.join(__dirname, 'public'), { maxAge: STATIC_CACHE, etag: true }));
  app.get('/admin', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.get('/admin*', (req, res, next) => {
    if (req.path === '/admin' || req.path === '/admin/') return next();
    const sub = req.path.slice('/admin'.length) || '/';
    const filePath = path.join(__dirname, 'public', sub);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
} else {
  app.get('/admin', (_req, res) => res.status(404).send('Admin sayfası kapalı (ADMIN_PAGE_ENABLED=true gerekir).'));
  app.get('/admin*', (_req, res) => res.status(404).send('Admin sayfası kapalı (ADMIN_PAGE_ENABLED=true gerekir).'));
}

const VIEWER_DIST = path.join(__dirname, 'viewer', 'dist');
if (fs.existsSync(VIEWER_DIST)) {
  app.use(express.static(VIEWER_DIST, { maxAge: STATIC_CACHE, etag: true }));
  app.get('/', (_req, res, next) => {
    if (fs.existsSync(path.join(VIEWER_DIST, 'index.html'))) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.sendFile(path.join(VIEWER_DIST, 'index.html'));
    } else next();
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const f = path.join(VIEWER_DIST, req.path);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return next();
    if (fs.existsSync(path.join(VIEWER_DIST, 'index.html'))) res.sendFile(path.join(VIEWER_DIST, 'index.html'));
    else next();
  });
} else {
  app.get('/', (_req, res) => res.send('Helm Release Viewer bulunamadı. viewer dizininde npm run build çalıştırın.'));
}

app.listen(PORT, '0.0.0.0');
