import { describe, expect, it } from "vitest";

import { getInactiveDefaultEnvironment, listActiveEnvironments } from "../apps/factory-web/src/client/lib/environments-view";
import type { Environment, Project } from "../apps/factory-web/src/client/lib/types";

function environment(input: Partial<Environment> & Pick<Environment, "id" | "name">): Environment {
  return {
    id: input.id,
    name: input.name,
    kind: "KUBERNETES_JOB",
    runnerImage:
      "ghcr.io/example/runner@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    setupScript: null,
    serviceAccountName: null,
    resourcesJson: null,
    active: input.active ?? true,
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    updatedAt: input.updatedAt ?? new Date(0).toISOString()
  };
}

function project(input: Partial<Project> & Pick<Project, "id" | "name" | "namespace">): Project {
  return {
    id: input.id,
    name: input.name,
    namespace: input.namespace,
    githubInstallationId: null,
    repoFullName: null,
    defaultBranch: null,
    defaultEnvironmentId: input.defaultEnvironmentId ?? null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

describe("environment view helpers", () => {
  it("filters out inactive environments from active list", () => {
    const results = listActiveEnvironments([
      environment({ id: "env-1", name: "one", active: true }),
      environment({ id: "env-2", name: "two", active: false })
    ]);

    expect(results.map((item) => item.id)).toEqual(["env-1"]);
  });

  it("returns inactive default environment details", () => {
    const selected = getInactiveDefaultEnvironment(
      project({ id: "proj-1", name: "Project", namespace: "factory-proj-project", defaultEnvironmentId: "env-2" }),
      [
        environment({ id: "env-1", name: "one", active: true }),
        environment({ id: "env-2", name: "two", active: false })
      ]
    );

    expect(selected?.id).toBe("env-2");
  });

  it("returns null when default environment is active or missing", () => {
    expect(
      getInactiveDefaultEnvironment(
        project({
          id: "proj-1",
          name: "Project",
          namespace: "factory-proj-project",
          defaultEnvironmentId: "env-1"
        }),
        [environment({ id: "env-1", name: "one", active: true })]
      )
    ).toBeNull();
    expect(getInactiveDefaultEnvironment(undefined, [environment({ id: "env-1", name: "one", active: true })])).toBeNull();
  });
});
