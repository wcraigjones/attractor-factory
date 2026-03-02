import { describe, expect, it } from "vitest";

import {
  buildScopeOptions,
  GLOBAL_SCOPE_VALUE,
  isGlobalAttractorsPath,
  isGlobalChatPath,
  isGlobalEnvironmentsPath,
  isGlobalTaskTemplatesPath,
  resolveSelectedScope,
  scopeToPath
} from "../apps/factory-web/src/client/lib/scope-selector";

describe("scope selector helpers", () => {
  it("resolves /secrets/global path to global scope sentinel", () => {
    expect(resolveSelectedScope({ pathname: "/secrets/global", fallbackProjectId: "proj-1" })).toBe(
      GLOBAL_SCOPE_VALUE
    );
  });

  it("resolves project path params to project scope", () => {
    expect(resolveSelectedScope({ pathname: "/projects/proj-2/secrets", projectIdFromPath: "proj-2" })).toBe(
      "proj-2"
    );
  });

  it("resolves /attractors/global path to global scope sentinel", () => {
    expect(resolveSelectedScope({ pathname: "/attractors/global", fallbackProjectId: "proj-1" })).toBe(
      GLOBAL_SCOPE_VALUE
    );
    expect(isGlobalAttractorsPath("/attractors/global")).toBe(true);
  });

  it("resolves /environments/global path to global scope sentinel", () => {
    expect(resolveSelectedScope({ pathname: "/environments/global", fallbackProjectId: "proj-1" })).toBe(
      GLOBAL_SCOPE_VALUE
    );
    expect(isGlobalEnvironmentsPath("/environments/global")).toBe(true);
  });

  it("resolves /task-templates/global path to global scope sentinel", () => {
    expect(resolveSelectedScope({ pathname: "/task-templates/global", fallbackProjectId: "proj-1" })).toBe(
      GLOBAL_SCOPE_VALUE
    );
    expect(isGlobalTaskTemplatesPath("/task-templates/global")).toBe(true);
  });

  it("resolves /chat path to global scope sentinel", () => {
    expect(resolveSelectedScope({ pathname: "/chat", fallbackProjectId: "proj-1" })).toBe(
      GLOBAL_SCOPE_VALUE
    );
    expect(isGlobalChatPath("/chat")).toBe(true);
  });

  it("keeps global scope fallback on non-project routes", () => {
    expect(resolveSelectedScope({ pathname: "/", fallbackProjectId: GLOBAL_SCOPE_VALUE })).toBe(GLOBAL_SCOPE_VALUE);
    expect(resolveSelectedScope({ pathname: "/projects", fallbackProjectId: GLOBAL_SCOPE_VALUE })).toBe(
      GLOBAL_SCOPE_VALUE
    );
    expect(resolveSelectedScope({ pathname: "/setup", fallbackProjectId: GLOBAL_SCOPE_VALUE })).toBe(
      GLOBAL_SCOPE_VALUE
    );
  });

  it("builds options with Global as first row", () => {
    const options = buildScopeOptions([
      { id: "proj-1", name: "Project One" },
      { id: "proj-2", name: "Project Two" }
    ]);

    expect(options[0]).toEqual({ value: GLOBAL_SCOPE_VALUE, label: "Global" });
    expect(options.slice(1).map((option) => option.value)).toEqual(["proj-1", "proj-2"]);
  });

  it("maps selected global scope to /environments/global", () => {
    expect(scopeToPath(GLOBAL_SCOPE_VALUE)).toBe("/environments/global");
    expect(scopeToPath("proj-1")).toBe("/projects/proj-1");
  });
});
