export interface ChartVersion {
  name: string;
  version: string;
  app_version?: string;
  description?: string;
  created?: string;
  digest?: string;
}

export interface ChartVersionsResponse {
  chart_name: string;
  registry: string;
  versions: ChartVersion[];
  total_count: number;
}

export interface ConfigResponse {
  registry: string;
  project: string;
  chart_name: string;
  full_path: string;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  chart_name: string;
  chart_version: string;
  app_version?: string;
  status: string;
  revision: number;
  first_deployed?: string;
  last_deployed?: string;
}

export interface HelmReleasesResponse {
  chart_filter?: string;
  releases: HelmRelease[];
  total_count: number;
}
