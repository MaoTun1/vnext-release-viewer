const fs = require('fs');
const path = require('path');

/**
 * In-cluster: write kubeconfig so helm/kubectl can use service account token.
 * No-op if KUBECONFIG is set or not running in a pod.
 */
function ensureInClusterKubeconfig() {
  if (process.env.KUBECONFIG) return;
  if (!process.env.KUBERNETES_SERVICE_HOST) return;
  const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
  try {
    if (!fs.existsSync(tokenPath)) return;
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    const config = {
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'in-cluster', cluster: { server: `https://${host}:${port}`, 'certificate-authority': caPath } }],
      users: [{ name: 'in-cluster', user: { token } }],
      contexts: [{ name: 'in-cluster', context: { cluster: 'in-cluster', user: 'in-cluster' } }],
      'current-context': 'in-cluster',
    };
    const outPath = path.join(process.env.HOME || '/tmp', 'kubeconfig');
    fs.writeFileSync(outPath, JSON.stringify(config), 'utf8');
    process.env.KUBECONFIG = outPath;
  } catch (_) {}
}

module.exports = { ensureInClusterKubeconfig };
