import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { ChartVersionsResponse, ConfigResponse, ChartVersion, HelmReleasesResponse, HelmRelease } from './types';
import { type Lang, t, LANG_STORAGE_KEY } from './i18n';
import './App.css';

type TabType = 'versions' | 'releases';
type SortDirection = 'asc' | 'desc';
type ReleaseSortColumn = 'name' | 'namespace' | 'chart_version' | 'app_version' | 'status' | 'revision' | 'last_deployed';

// Semantic version comparison for sorting
function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): number[] => {
    return v.split(/[-.]/).map(p => {
      const n = parseInt(p, 10);
      return isNaN(n) ? 0 : n;
    });
  };
  
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const maxLen = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

// Debounce hook for search performance
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('versions');
  const [versions, setVersions] = useState<ChartVersion[]>([]);
  const [releases, setReleases] = useState<HelmRelease[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedVersion, setCopiedVersion] = useState<string | null>(null);
  const [adminAvailable, setAdminAvailable] = useState(false);
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem(LANG_STORAGE_KEY) as Lang) || 'tr');

  useEffect(() => {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  }, [lang]);

  // Sorting state for releases
  const [sortColumn, setSortColumn] = useState<ReleaseSortColumn>('namespace');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Debounce search (120ms for snappier feel without excessive re-renders)
  const debouncedSearchTerm = useDebounce(searchTerm, 120);

  const abortControllerRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef({ versions: false, releases: false });

  // Admin panel erişilebilir mi?
  useEffect(() => {
    fetch('/api/v1/admin-available')
      .then((r) => r.json())
      .then((data) => setAdminAvailable(!!data?.enabled))
      .catch(() => setAdminAvailable(false));
  }, []);

  const getErrorMessage = useCallback(async (res: Response): Promise<string> => {
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string' && body.error.trim()) {
        const msg = body.error;
        const detail = body.detail;
        return typeof detail === 'string' && detail.trim() ? `${msg}: ${detail}` : msg;
      }
    } catch {
      /* ignore */
    }
    return `HTTP ${res.status}: ${res.statusText}`;
  }, []);

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    const refreshQ = forceRefresh ? '?refresh=1' : '';

    const showSpinner = forceRefresh ||
      (activeTab === 'versions' && !hasDataRef.current.versions) ||
      (activeTab === 'releases' && !hasDataRef.current.releases);
    if (showSpinner) setLoading(true);
    setError(null);

    try {
      if (activeTab === 'versions') {
        const [versionsRes, configRes] = await Promise.all([
          fetch(`/api/v1/chart/versions${refreshQ}`, { signal }),
          fetch('/api/v1/config', { signal }),
        ]);

        if (!versionsRes.ok) {
          const msg = await getErrorMessage(versionsRes);
          throw new Error(msg);
        }

        const versionsData: ChartVersionsResponse = await versionsRes.json();
        const configData: ConfigResponse = await configRes.json();

        setVersions(versionsData.versions);
        setConfig(configData);
        hasDataRef.current.versions = true;

        // Prefetch other tab in idle time so first paint stays fast
        const prefetchReleases = () => fetch('/api/v1/releases').then((r) => r.ok ? r.json() : null).then((d) => {
          if (d?.releases) {
            setReleases(d.releases);
            hasDataRef.current.releases = true;
          }
        }).catch(() => {});
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(() => prefetchReleases(), { timeout: 2000 });
        else setTimeout(prefetchReleases, 1200);
      } else {
        const releasesRes = await fetch(`/api/v1/releases${refreshQ}`, { signal });

        if (!releasesRes.ok) {
          const msg = await getErrorMessage(releasesRes);
          throw new Error(msg);
        }

        const releasesData: HelmReleasesResponse = await releasesRes.json();
        setReleases(releasesData.releases);
        hasDataRef.current.releases = true;

        const prefetchVersions = () => Promise.all([fetch('/api/v1/chart/versions'), fetch('/api/v1/config')]).then(([vr, cr]) => {
          if (vr.ok && cr.ok) {
            return Promise.all([vr.json(), cr.json()]).then(([vd, cd]) => {
              setVersions(vd.versions);
              setConfig(cd);
              hasDataRef.current.versions = true;
            });
          }
        }).catch(() => {});
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(() => prefetchVersions(), { timeout: 2000 });
        else setTimeout(prefetchVersions, 1200);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Bir hata oluştu');
    } finally {
      setLoading(false);
    }
  }, [activeTab, getErrorMessage]);

  // Fetch data on tab change
  useEffect(() => {
    fetchData();
    // Cleanup on unmount/tab change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData]);

  const copyToClipboard = useCallback(async (version: string) => {
    if (!config) return;
    const command = `helm pull oci://${config.registry}/${config.project}/${config.chart_name} --version ${version}`;
    
    try {
      await navigator.clipboard.writeText(command);
      setCopiedVersion(version);
      setTimeout(() => setCopiedVersion(null), 2000);
    } catch {
      console.error('Kopyalama başarısız');
    }
  }, [config]);

  // Memoized filtering with debounced search term
  const filteredVersions = useMemo(() => {
    if (!debouncedSearchTerm) return versions;
    const term = debouncedSearchTerm.toLowerCase();
    return versions.filter((v) => v.version.toLowerCase().includes(term));
  }, [versions, debouncedSearchTerm]);

  const filteredReleases = useMemo(() => {
    let result = releases;
    
    // Filter first
    if (debouncedSearchTerm) {
      const term = debouncedSearchTerm.toLowerCase();
      result = result.filter((r) =>
        r.name.toLowerCase().includes(term) ||
        r.namespace.toLowerCase().includes(term) ||
        r.chart_version.toLowerCase().includes(term)
      );
    }
    
    // Then sort
    result = [...result].sort((a, b) => {
      let comparison = 0;
      
      switch (sortColumn) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'namespace':
          comparison = a.namespace.localeCompare(b.namespace);
          break;
        case 'chart_version':
          comparison = compareVersions(a.chart_version, b.chart_version);
          break;
        case 'app_version':
          comparison = (a.app_version || '').localeCompare(b.app_version || '');
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        case 'revision':
          comparison = a.revision - b.revision;
          break;
        case 'last_deployed':
          const dateA = a.last_deployed ? new Date(a.last_deployed).getTime() : 0;
          const dateB = b.last_deployed ? new Date(b.last_deployed).getTime() : 0;
          comparison = dateA - dateB;
          break;
      }
      
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [releases, debouncedSearchTerm, sortColumn, sortDirection]);

  const latestVersion = useMemo(() => versions[0]?.version, [versions]);

  // Memoized stats for releases tab
  const releaseStats = useMemo(() => ({
    totalReleases: releases.length,
    uniqueNamespaces: new Set(releases.map(r => r.namespace)).size,
    deployedCount: releases.filter(r => r.status === 'deployed').length
  }), [releases]);

  const formatDate = useCallback((dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [lang]);

  const getStatusColor = useCallback((status: string) => {
    switch (status.toLowerCase()) {
      case 'deployed':
        return 'status-deployed';
      case 'failed':
        return 'status-failed';
      case 'pending':
      case 'pending-install':
      case 'pending-upgrade':
        return 'status-pending';
      default:
        return 'status-unknown';
    }
  }, []);

  // Handle column sorting
  const handleSort = useCallback((column: ReleaseSortColumn) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
  }, [sortColumn]);

  return (
    <div className="app">
      {/* Background decoration */}
      <div className="bg-gradient" />
      <div className="bg-grid" />

      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="logo-section">
            <div className="logo">
              <img src="/logo.png" alt="Logo" />
            </div>
            <div className="title-group">
              <h1>{t(lang, 'title')}</h1>
              <p className="subtitle">{t(lang, 'subtitle')}</p>
            </div>
          </div>

          <div className="header-actions">
            <div className="lang-toggle" role="group" aria-label="Language">
              <button
                type="button"
                className={lang === 'tr' ? 'active' : ''}
                onClick={() => setLang('tr')}
                aria-pressed={lang === 'tr'}
              >
                TR
              </button>
              <button
                type="button"
                className={lang === 'en' ? 'active' : ''}
                onClick={() => setLang('en')}
                aria-pressed={lang === 'en'}
              >
                EN
              </button>
            </div>
            {config && activeTab === 'versions' && (
              <div className="registry-info">
                <span className="registry-label">{t(lang, 'registry')}</span>
                <code className="registry-path">{config.full_path}</code>
              </div>
            )}
            {adminAvailable && (
              <a href="/admin" className="admin-link-btn" title={t(lang, 'adminTitle')}>
                <SettingsIcon />
                {t(lang, 'admin')}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="tabs-container">
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'versions' ? 'active' : ''}`}
            onClick={() => { setActiveTab('versions'); setSearchTerm(''); }}
          >
            <PackageIcon />
            {t(lang, 'tabVersions')}
          </button>
          <button
            className={`tab ${activeTab === 'releases' ? 'active' : ''}`}
            onClick={() => { setActiveTab('releases'); setSearchTerm(''); }}
          >
            <RocketIcon />
            {t(lang, 'tabReleases')}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="main">
        <div className="container">
          {/* Stats Bar */}
          {!loading && !error && (
            <div className="stats-bar fade-in">
              {activeTab === 'versions' ? (
                <>
                  <div className="stat">
                    <span className="stat-value">{versions.length}</span>
                    <span className="stat-label">{t(lang, 'statTotalVersion')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{versions[0]?.version || '—'}</span>
                    <span className="stat-label">{t(lang, 'statLatest')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{config?.chart_name || '—'}</span>
                    <span className="stat-label">{t(lang, 'statChartName')}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="stat">
                    <span className="stat-value">{releaseStats.totalReleases}</span>
                    <span className="stat-label">{t(lang, 'statTotalRelease')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{releaseStats.uniqueNamespaces}</span>
                    <span className="stat-label">{t(lang, 'statNamespace')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{releaseStats.deployedCount}</span>
                    <span className="stat-label">{t(lang, 'statDeployed')}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Search */}
          <div className="search-section fade-in stagger-1">
            <div className="search-container">
              <SearchIcon />
              <input
                type="text"
                placeholder={activeTab === 'versions' ? t(lang, 'searchVersions') : t(lang, 'searchReleases')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
              {searchTerm && (
                <button 
                  className="search-clear"
                  onClick={() => setSearchTerm('')}
                  aria-label={t(lang, 'clearSearch')}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
            <button className="refresh-btn" onClick={() => fetchData(true)} disabled={loading}>
              <RefreshIcon spinning={loading} />
              {t(lang, 'refresh')}
            </button>
          </div>

          {/* Content */}
          {loading ? (
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>{activeTab === 'versions' ? t(lang, 'loadingVersions') : t(lang, 'loadingReleases')}</p>
            </div>
          ) : error ? (
            <div className="error-state fade-in">
              <div className="error-icon">⚠️</div>
              <h3>{t(lang, 'errorTitle')}</h3>
              <p>{error}</p>
              <button className="retry-btn" onClick={() => fetchData(true)}>
                {t(lang, 'retry')}
              </button>
            </div>
          ) : activeTab === 'versions' ? (
            // Versions Tab Content
            filteredVersions.length === 0 ? (
              <div className="empty-state fade-in">
                <div className="empty-icon">📦</div>
                <h3>{t(lang, 'emptyTitle')}</h3>
                <p>
                  {searchTerm
                    ? t(lang, 'emptySearchVersions', { term: searchTerm })
                    : t(lang, 'emptyNoVersions')}
                </p>
              </div>
            ) : (
              <div className="versions-table-container fade-in">
                <table className="versions-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t(lang, 'chartVersion')}</th>
                      <th>{t(lang, 'appVersion')}</th>
                      <th>{t(lang, 'date')}</th>
                      <th>{t(lang, 'digest')}</th>
                      <th>{t(lang, 'action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVersions.map((version, index) => (
                      <tr 
                        key={version.version}
                        className="fade-in"
                        style={{ animationDelay: `${Math.min(index * 0.02, 0.2)}s` }}
                      >
                        <td className="row-number">{index + 1}</td>
                        <td className="version-cell">
                          <div className="version-tag-wrapper">
                            <TagIcon />
                            <span className="version-text">{version.version}</span>
                            {version.version === latestVersion && <span className="latest-badge">{t(lang, 'latest')}</span>}
                          </div>
                        </td>
                        <td className="app-version-cell">
                          {version.app_version ? (
                            <span className="app-version">{version.app_version}</span>
                          ) : (
                            <span className="no-data">—</span>
                          )}
                        </td>
                        <td className="date-cell">
                          {version.created ? formatDate(version.created) : <span className="no-data">—</span>}
                        </td>
                        <td className="digest-cell">
                          {version.digest ? (
                            <code className="digest">{version.digest.substring(7, 19)}</code>
                          ) : (
                            <span className="no-data">—</span>
                          )}
                        </td>
                        <td className="action-cell">
                          <button
                            className={`copy-btn-sm ${copiedVersion === version.version ? 'copied' : ''}`}
                            onClick={() => copyToClipboard(version.version)}
                            title={t(lang, 'copyCommand')}
                          >
                            {copiedVersion === version.version ? <CheckIcon /> : <CopyIcon />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            // Releases Tab Content
            filteredReleases.length === 0 ? (
              <div className="empty-state fade-in">
                <div className="empty-icon">🚀</div>
                <h3>{t(lang, 'emptyTitle')}</h3>
                <p>
                  {searchTerm
                    ? t(lang, 'emptySearchReleases', { term: searchTerm })
                    : t(lang, 'emptyNoReleases')}
                </p>
              </div>
            ) : (
              <div className="versions-table-container fade-in">
                <table className="versions-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th className="sortable-header" onClick={() => handleSort('name')}>
                        {t(lang, 'release')}
                        <SortIcon column="name" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('namespace')}>
                        {t(lang, 'namespace')}
                        <SortIcon column="namespace" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('chart_version')}>
                        {t(lang, 'chartVersion')}
                        <SortIcon column="chart_version" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('app_version')}>
                        {t(lang, 'appVersion')}
                        <SortIcon column="app_version" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('status')}>
                        {t(lang, 'status')}
                        <SortIcon column="status" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('revision')}>
                        {t(lang, 'rev')}
                        <SortIcon column="revision" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                      <th className="sortable-header" onClick={() => handleSort('last_deployed')}>
                        {t(lang, 'lastDeploy')}
                        <SortIcon column="last_deployed" currentColumn={sortColumn} direction={sortDirection} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReleases.map((release, index) => {
                      const isLatest = release.chart_version === latestVersion;
                      const isOutdated = latestVersion && release.chart_version !== latestVersion;
                      
                      return (
                        <tr 
                          key={`${release.namespace}/${release.name}`}
                          className={`fade-in ${isOutdated ? 'outdated-row' : ''}`}
                          style={{ animationDelay: `${Math.min(index * 0.02, 0.2)}s` }}
                        >
                          <td className="row-number">{index + 1}</td>
                          <td className="release-name-cell">
                            <span className="release-name">{release.name}</span>
                          </td>
                          <td className="namespace-cell">
                            <span className="namespace-badge">{release.namespace}</span>
                          </td>
                          <td className="version-cell">
                            <div className="version-tag-wrapper">
                              <span className="version-text">{release.chart_version}</span>
                              {isLatest && <span className="latest-badge">{t(lang, 'latest')}</span>}
                              {isOutdated && <span className="outdated-badge">{t(lang, 'outdated')}</span>}
                            </div>
                          </td>
                          <td className="app-version-cell">
                            {release.app_version ? (
                              <span className="app-version">{release.app_version}</span>
                            ) : (
                              <span className="no-data">—</span>
                            )}
                          </td>
                          <td className="status-cell">
                            <span className={`status-badge ${getStatusColor(release.status)}`}>
                              {release.status}
                            </span>
                          </td>
                          <td className="revision-cell">
                            <span className="revision">{release.revision}</span>
                          </td>
                          <td className="date-cell">
                            {release.last_deployed ? formatDate(release.last_deployed) : <span className="no-data">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="footer">
        <p>{t(lang, 'footer')}</p>
      </footer>
    </div>
  );
}

// Icons
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
      className={spinning ? 'spinning' : ''}
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SortIcon({ column, currentColumn, direction }: { column: string; currentColumn: string; direction: SortDirection }) {
  const isActive = column === currentColumn;
  
  return (
    <svg 
      className={`sort-icon ${isActive ? 'active' : ''}`}
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      {isActive ? (
        direction === 'asc' ? (
          <path d="M12 5v14M5 12l7-7 7 7" />
        ) : (
          <path d="M12 5v14M5 12l7 7 7-7" />
        )
      ) : (
        <>
          <path d="M7 15l5 5 5-5" />
          <path d="M7 9l5-5 5 5" />
        </>
      )}
    </svg>
  );
}

export default App;
