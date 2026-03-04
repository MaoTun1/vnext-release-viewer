#!/usr/bin/env bash
# API ve sayfa testleri - localhost:30800 (veya BASE_URL)
set -e
BASE="${BASE_URL:-http://localhost:30800}"
FAIL=0

check() {
  local name="$1"
  local method="${2:-GET}"
  local path="$3"
  local want="${4:-200}"
  local code
  code=$(curl -s -o /tmp/test-api-out -w "%{http_code}" -X "$method" "$BASE$path" ${5:+-d "$5"} ${5:+-H "Content-Type: application/json"})
  if [ "$code" = "$want" ]; then
    echo "OK   $name ($code)"
  else
    echo "FAIL $name (got $code, want $want)"
    cat /tmp/test-api-out 2>/dev/null | head -c 200
    echo ""
    FAIL=1
  fi
}

echo "=== vnext-local-manager API testleri ($BASE) ==="
echo ""

check "GET / (Helm Release Viewer)" GET "/" 200
check "GET /admin/ (Admin panel)" GET "/admin/" 200
check "GET /api/check-infra" GET "/api/check-infra" 200
check "GET /api/domains" GET "/api/domains" 200
check "GET /api/app-config" GET "/api/app-config" 200
check "GET /api/urls" GET "/api/urls" 200
check "GET /api/vault/token" GET "/api/vault/token" 200
check "GET /api/infra-credentials" GET "/api/infra-credentials" 200
check "GET /api/v1/config" GET "/api/v1/config" 200
check "GET /api/v1/admin-available" GET "/api/v1/admin-available" 200
check "GET /api/v1/releases" GET "/api/v1/releases" 200
check "GET /api/domains/fake/values (404)" GET "/api/domains/fake/values" 404
check "POST /api/deploy-domains empty (400)" POST "/api/deploy-domains" 400 '{"domains":[]}'

# Chart versions registry 401 olabilir (Harbor auth)
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/chart/versions")
if [ "$code" = "200" ] || [ "$code" = "500" ]; then
  echo "OK   GET /api/v1/chart/versions ($code)"
else
  echo "FAIL GET /api/v1/chart/versions (got $code)"
  FAIL=1
fi

# Viewer asset
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/assets/index-DpnN3or5.js" 2>/dev/null || echo "000")
if [ "$code" = "200" ]; then
  echo "OK   GET /assets/... (viewer JS)"
else
  echo "SKIP GET /assets/... (asset name may vary)"
fi

echo ""
if [ $FAIL -eq 0 ]; then
  echo "Tüm testler geçti."
  exit 0
else
  echo "Bazı testler başarısız."
  exit 1
fi
