import type { TaskTemplate } from "./types";

export type TaskTemplateRowStatus = "Project" | "Inherited" | "Overridden";

export interface TaskTemplateViewRow {
  id: string;
  taskTemplateId: string;
  source: "project" | "global";
  name: string;
  attractorName: string;
  runType: TaskTemplate["runType"];
  active: boolean;
  scheduleEnabled: boolean;
  scheduleNextRunAt: string | null;
  scheduleLastRunAt: string | null;
  scheduleLastError: string | null;
  status: TaskTemplateRowStatus;
  muted: boolean;
}

function isProjectTemplate(template: TaskTemplate): boolean {
  return template.scope === "PROJECT";
}

export function buildEffectiveTaskTemplates(templates: TaskTemplate[]): TaskTemplate[] {
  const projectByName = new Set(
    templates.filter((template) => isProjectTemplate(template)).map((template) => template.name)
  );

  return templates.filter((template) => {
    if (isProjectTemplate(template)) {
      return true;
    }
    return !projectByName.has(template.name);
  });
}

export function buildTaskTemplateViewRows(templates: TaskTemplate[]): TaskTemplateViewRow[] {
  const projectByName = new Set(
    templates.filter((template) => isProjectTemplate(template)).map((template) => template.name)
  );

  return templates.map((template) => {
    const overridden = template.scope === "GLOBAL" && projectByName.has(template.name);
    const source = template.scope === "PROJECT" ? "project" : "global";
    return {
      id: `${source}:${template.id}`,
      taskTemplateId: template.id,
      source,
      name: template.name,
      attractorName: template.attractorName,
      runType: template.runType,
      active: template.active,
      scheduleEnabled: template.scheduleEnabled,
      scheduleNextRunAt: template.scheduleNextRunAt,
      scheduleLastRunAt: template.scheduleLastRunAt,
      scheduleLastError: template.scheduleLastError,
      status: template.scope === "PROJECT" ? "Project" : overridden ? "Overridden" : "Inherited",
      muted: overridden
    };
  });
}
