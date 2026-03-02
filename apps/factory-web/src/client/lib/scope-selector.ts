export const GLOBAL_SCOPE_VALUE = "__global__";

export interface ScopeOption {
  value: string;
  label: string;
}

export function isGlobalSecretsPath(pathname: string): boolean {
  return pathname === "/secrets/global" || pathname.startsWith("/secrets/global/");
}

export function isGlobalAttractorsPath(pathname: string): boolean {
  return pathname === "/attractors/global" || pathname.startsWith("/attractors/global/");
}

export function isGlobalEnvironmentsPath(pathname: string): boolean {
  return pathname === "/environments/global" || pathname.startsWith("/environments/global/");
}

export function isGlobalTaskTemplatesPath(pathname: string): boolean {
  return pathname === "/task-templates/global" || pathname.startsWith("/task-templates/global/");
}

export function isGlobalChatPath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}

export function isGlobalScopePath(pathname: string): boolean {
  return (
    isGlobalSecretsPath(pathname) ||
    isGlobalAttractorsPath(pathname) ||
    isGlobalEnvironmentsPath(pathname) ||
    isGlobalTaskTemplatesPath(pathname) ||
    isGlobalChatPath(pathname)
  );
}

export function resolveSelectedScope(input: {
  pathname: string;
  projectIdFromPath?: string;
  fallbackProjectId?: string;
}): string | undefined {
  if (isGlobalScopePath(input.pathname)) {
    return GLOBAL_SCOPE_VALUE;
  }
  if (input.projectIdFromPath) {
    return input.projectIdFromPath;
  }
  return input.fallbackProjectId;
}

export function scopeToPath(scope: string): string {
  if (scope === GLOBAL_SCOPE_VALUE) {
    return "/environments/global";
  }
  return `/projects/${scope}`;
}

export function buildScopeOptions(projects: Array<{ id: string; name: string }>): ScopeOption[] {
  return [
    { value: GLOBAL_SCOPE_VALUE, label: "Global" },
    ...projects.map((project) => ({ value: project.id, label: project.name }))
  ];
}
