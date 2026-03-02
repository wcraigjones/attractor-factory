import { Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "./components/ui/toast";

import { AppShell } from "./components/layout/app-shell";
import { GlobalAgentChatPage, ProjectAgentChatPage } from "./pages/agent-chat-page";
import { ArtifactViewerPage } from "./pages/artifact-viewer-page";
import { GlobalAttractorStudioPage, ProjectAttractorStudioPage } from "./pages/attractor-studio-page";
import { DashboardPage } from "./pages/dashboard-page";
import { GlobalAttractorsPage } from "./pages/global-attractors-page";
import { GlobalEnvironmentsPage } from "./pages/global-environments-page";
import { GlobalSecretsPage } from "./pages/global-secrets-page";
import { GlobalTaskTemplatesPage } from "./pages/global-task-templates-page";
import { NotFoundPage } from "./pages/not-found-page";
import { ProjectAttractorsPage } from "./pages/project-attractors-page";
import { ProjectGitHubIssueDetailPage } from "./pages/project-github-issue-detail-page";
import { ProjectGitHubIssuesPage } from "./pages/project-github-issues-page";
import { ProjectGitHubPrDetailPage } from "./pages/project-github-pr-detail-page";
import { ProjectGitHubPrQueuePage } from "./pages/project-github-pr-queue-page";
import { ProjectOverviewPage } from "./pages/project-overview-page";
import { ProjectsPage } from "./pages/projects-page";
import { ProjectEnvironmentsPage } from "./pages/project-environments-page";
import { ProjectRunsPage } from "./pages/project-runs-page";
import { ProjectSecretsPage } from "./pages/project-secrets-page";
import { ProjectSetupWizardPage } from "./pages/project-setup-wizard-page";
import { ProjectTaskTemplatesPage } from "./pages/project-task-templates-page";
import { RunDetailPage } from "./pages/run-detail-page";

export function App() {
  return (
    <>
    <Toaster />
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="setup" element={<ProjectSetupWizardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="environments/global" element={<GlobalEnvironmentsPage />} />
        <Route path="attractors/global" element={<GlobalAttractorsPage />} />
        <Route path="attractors/global/:attractorId" element={<GlobalAttractorStudioPage />} />
        <Route path="task-templates/global" element={<GlobalTaskTemplatesPage />} />
        <Route path="chat" element={<GlobalAgentChatPage />} />
        <Route path="secrets/global" element={<GlobalSecretsPage />} />
        <Route path="projects/:projectId" element={<ProjectOverviewPage />} />
        <Route path="projects/:projectId/environments" element={<ProjectEnvironmentsPage />} />
        <Route path="projects/:projectId/secrets" element={<ProjectSecretsPage />} />
        <Route path="projects/:projectId/attractors" element={<ProjectAttractorsPage />} />
        <Route path="projects/:projectId/setup" element={<ProjectSetupWizardPage />} />
        <Route path="projects/:projectId/attractors/:attractorId" element={<ProjectAttractorStudioPage />} />
        <Route path="projects/:projectId/task-templates" element={<ProjectTaskTemplatesPage />} />
        <Route path="projects/:projectId/chat" element={<ProjectAgentChatPage />} />
        <Route path="projects/:projectId/github/issues" element={<ProjectGitHubIssuesPage />} />
        <Route path="projects/:projectId/github/issues/:issueNumber" element={<ProjectGitHubIssueDetailPage />} />
        <Route path="projects/:projectId/github/pulls" element={<ProjectGitHubPrQueuePage />} />
        <Route path="projects/:projectId/github/pulls/:prNumber" element={<ProjectGitHubPrDetailPage />} />
        <Route path="projects/:projectId/runs" element={<ProjectRunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="runs/:runId/artifacts/:artifactId" element={<ArtifactViewerPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
