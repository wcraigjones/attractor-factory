export function pathForProjectSelection(pathname: string, projectId: string): string {
  const normalizedPath = pathname.trim().length > 0 ? pathname : "/";

  if (normalizedPath === "/setup" || normalizedPath.startsWith("/setup?")) {
    return `/projects/${projectId}/setup`;
  }

  const projectMatch = normalizedPath.match(/^\/projects\/[^/]+(\/.*)?$/);
  if (projectMatch) {
    const suffix = projectMatch[1] ?? "";
    return `/projects/${projectId}${suffix}`;
  }

  if (normalizedPath.startsWith("/runs/")) {
    return `/projects/${projectId}/runs`;
  }

  if (normalizedPath === "/chat" || normalizedPath.startsWith("/chat/")) {
    return `/projects/${projectId}/chat`;
  }

  return `/projects/${projectId}`;
}
