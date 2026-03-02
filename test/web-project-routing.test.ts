import { describe, expect, it } from "vitest";

import { pathForProjectSelection } from "../apps/factory-web/src/client/lib/project-routing";

describe("project routing helpers", () => {
  it("routes setup entry path to project setup", () => {
    expect(pathForProjectSelection("/setup", "proj-b")).toBe("/projects/proj-b/setup");
  });

  it("keeps project sub-route when switching project", () => {
    expect(pathForProjectSelection("/projects/proj-a/secrets", "proj-b")).toBe("/projects/proj-b/secrets");
    expect(pathForProjectSelection("/projects/proj-a/runs", "proj-b")).toBe("/projects/proj-b/runs");
  });

  it("routes run detail pages back to selected project runs", () => {
    expect(pathForProjectSelection("/runs/run-1", "proj-b")).toBe("/projects/proj-b/runs");
    expect(pathForProjectSelection("/runs/run-1/artifacts/art-1", "proj-b")).toBe(
      "/projects/proj-b/runs"
    );
  });

  it("defaults to project overview from non-project routes", () => {
    expect(pathForProjectSelection("/", "proj-b")).toBe("/projects/proj-b");
    expect(pathForProjectSelection("/projects", "proj-b")).toBe("/projects/proj-b");
  });

  it("routes global chat to project chat when selecting a project", () => {
    expect(pathForProjectSelection("/chat", "proj-b")).toBe("/projects/proj-b/chat");
  });
});
