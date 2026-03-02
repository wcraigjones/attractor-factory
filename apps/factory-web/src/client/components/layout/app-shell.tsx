import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { getRun, listProjects } from "../../lib/api";
import { pathForProjectSelection } from "../../lib/project-routing";
import {
  buildScopeOptions,
  GLOBAL_SCOPE_VALUE,
  isGlobalAttractorsPath,
  isGlobalChatPath,
  isGlobalEnvironmentsPath,
  isGlobalSecretsPath,
  resolveSelectedScope,
  scopeToPath
} from "../../lib/scope-selector";
import { cn } from "../../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const primaryNav = [
  { to: "/", label: "Dashboard" },
  { to: "/projects", label: "Projects" }
];
const SCOPE_STORAGE_KEY = "factory.selectedScope";

function toTitleCase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ projectId?: string; runId?: string }>();
  const projectIdFromPath = params.projectId;
  const runIdFromPath = params.runId;
  const [persistedScope, setPersistedScope] = useState<string | undefined>(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const value = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
  });

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects
  });
  const runContextQuery = useQuery({
    queryKey: ["run-context", runIdFromPath],
    queryFn: () => getRun(runIdFromPath ?? ""),
    enabled: Boolean(runIdFromPath)
  });

  const scopeOptions = useMemo(() => buildScopeOptions(projectsQuery.data ?? []), [projectsQuery.data]);
  const validPersistedScope = useMemo(() => {
    if (!persistedScope) {
      return undefined;
    }
    if (persistedScope === GLOBAL_SCOPE_VALUE) {
      return persistedScope;
    }
    return projectsQuery.data?.some((project) => project.id === persistedScope) ? persistedScope : undefined;
  }, [persistedScope, projectsQuery.data]);
  const selectedScope = resolveSelectedScope({
    pathname: location.pathname,
    projectIdFromPath,
    fallbackProjectId:
      runContextQuery.data?.projectId ??
      validPersistedScope ??
      (runIdFromPath && runContextQuery.isLoading ? undefined : projectsQuery.data?.[0]?.id)
  });
  const selectedProjectId = selectedScope === GLOBAL_SCOPE_VALUE ? undefined : selectedScope;
  const globalScopeSelected = selectedScope === GLOBAL_SCOPE_VALUE;

  useEffect(() => {
    if (!selectedScope || typeof window === "undefined") {
      return;
    }
    if (persistedScope !== selectedScope) {
      setPersistedScope(selectedScope);
    }
    window.localStorage.setItem(SCOPE_STORAGE_KEY, selectedScope);
  }, [persistedScope, selectedScope]);

  const breadcrumbs = useMemo(() => {
    const parts = location.pathname.split("/").filter(Boolean);
    const items: Array<{ href: string; label: string }> = [{ href: "/", label: "Dashboard" }];

    if (parts.length === 0) {
      return items;
    }

    let cursor = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      cursor += `/${part}`;

      if (part === "secrets" && parts[index + 1] === "global") {
        items.push({ href: "/secrets/global", label: "Global Secrets" });
        break;
      }

      if (part === "attractors" && parts[index + 1] === "global") {
        items.push({ href: "/attractors/global", label: "Global Attractors" });
        break;
      }

      if (part === "environments" && parts[index + 1] === "global") {
        items.push({ href: "/environments/global", label: "Global Environments" });
        break;
      }

      if (part === "projects" && index + 1 < parts.length) {
        const projectId = parts[index + 1] ?? "";
        const project = projectsQuery.data?.find((candidate) => candidate.id === projectId);
        items.push({ href: "/projects", label: "Projects" });
        items.push({ href: `/projects/${projectId}`, label: project?.name ?? "Project" });
        index += 1;
        cursor += `/${projectId}`;
        continue;
      }

      if (part === "runs" && index + 1 < parts.length) {
        const runId = parts[index + 1] ?? "";
        const runProjectId = runContextQuery.data?.projectId;
        const runProject = runProjectId
          ? projectsQuery.data?.find((candidate) => candidate.id === runProjectId)
          : undefined;
        if (runProjectId) {
          items.push({ href: "/projects", label: "Projects" });
          items.push({ href: `/projects/${runProjectId}`, label: runProject?.name ?? "Project" });
          items.push({ href: `/projects/${runProjectId}/runs`, label: "Runs" });
        } else {
          items.push({ href: "/projects", label: "Runs" });
        }
        items.push({ href: `/runs/${runId}`, label: runId.slice(0, 8) });
        index += 1;
        cursor += `/${runId}`;
        continue;
      }

      items.push({ href: cursor, label: toTitleCase(part) });
    }

    return items;
  }, [location.pathname, projectsQuery.data, runContextQuery.data?.projectId]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-card/90 p-4 backdrop-blur md:min-h-screen md:w-64 md:border-b-0 md:border-r">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Attractor</p>
          <h1 className="text-xl font-semibold">Factory</h1>
        </div>
        <nav className="space-y-1">
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "block rounded-md px-3 py-2 text-sm",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                )
              }
              end={item.to === "/"}
            >
              {item.label}
            </NavLink>
          ))}
          {globalScopeSelected ? (
            <div className="mt-4 space-y-1 border-t border-border pt-4">
              <NavLink
                to="/chat"
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm",
                    isActive || isGlobalChatPath(location.pathname)
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )
                }
              >
                Chat
              </NavLink>
              <NavLink
                to="/environments/global"
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm",
                    isActive || isGlobalEnvironmentsPath(location.pathname)
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )
                }
              >
                Environments
              </NavLink>
              <NavLink
                to="/secrets/global"
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm",
                    isActive || isGlobalSecretsPath(location.pathname)
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )
                }
              >
                Secrets
              </NavLink>
              <NavLink
                to="/attractors/global"
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm",
                    isActive || isGlobalAttractorsPath(location.pathname)
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )
                }
                >
                Attractors
              </NavLink>
              <NavLink
                to="/task-templates/global"
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm",
                    isActive
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )
                }
              >
                Task Templates
              </NavLink>
            </div>
          ) : selectedProjectId ? (
            <div className="mt-4 space-y-1 border-t border-border pt-4">
              {[
                { to: `/projects/${selectedProjectId}`, label: "Overview" },
                { to: `/projects/${selectedProjectId}/setup`, label: "Setup" },
                { to: `/projects/${selectedProjectId}/chat`, label: "Chat" },
                { to: `/projects/${selectedProjectId}/environments`, label: "Environments" },
                { to: `/projects/${selectedProjectId}/secrets`, label: "Secrets" },
                { to: `/projects/${selectedProjectId}/attractors`, label: "Attractors" },
                { to: `/projects/${selectedProjectId}/task-templates`, label: "Task Templates" },
                { to: `/projects/${selectedProjectId}/github/issues`, label: "GitHub Issues" },
                { to: `/projects/${selectedProjectId}/github/pulls`, label: "PR Queue" },
                { to: `/projects/${selectedProjectId}/runs`, label: "Runs" }
              ].map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-2 text-sm",
                      isActive ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted"
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ) : null}
        </nav>
      </aside>

      <div className="flex-1">
        <header className="flex flex-col gap-3 border-b border-border bg-card/75 px-5 py-4 backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <div key={crumb.href} className="flex items-center gap-2">
                  {index > 0 ? <span>/</span> : null}
                  {isLast ? (
                    <span className="font-medium text-foreground">{crumb.label}</span>
                  ) : (
                    <Link to={crumb.href} className="hover:text-foreground">
                      {crumb.label}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex w-full items-center gap-2 md:w-auto">
            <Select
              value={selectedScope ?? ""}
              onValueChange={(value) => {
                if (!value) {
                  return;
                }
                if (value === GLOBAL_SCOPE_VALUE) {
                  navigate(scopeToPath(value));
                  return;
                }
                navigate(pathForProjectSelection(location.pathname, value));
              }}
            >
              <SelectTrigger className="md:w-72">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        <main className="p-5 md:p-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
