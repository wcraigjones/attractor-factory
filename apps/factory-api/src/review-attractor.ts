import { parseDotGraph, type DotGraph } from "@attractor/dot-engine";

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasDirectedPath(graph: DotGraph, fromId: string, toId: string): boolean {
  if (fromId === toId) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from);
    if (list) {
      list.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
  }

  const queue = [fromId];
  const visited = new Set<string>([fromId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (next === toId) {
        return true;
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return false;
}

function findReviewCouncilNodeId(graph: DotGraph): string | null {
  const preferredIds = new Set(["reviewcouncil"]);
  for (const nodeId of graph.nodeOrder) {
    if (preferredIds.has(normalizedToken(nodeId))) {
      return nodeId;
    }
  }

  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodes[nodeId];
    if (!node) {
      continue;
    }
    const label = (node.label ?? "").toLowerCase();
    if (label.includes("review council")) {
      return nodeId;
    }
  }

  return null;
}

function findReviewSummaryNodeId(graph: DotGraph): string | null {
  const preferredIds = new Set(["reviewsummary"]);
  for (const nodeId of graph.nodeOrder) {
    if (preferredIds.has(normalizedToken(nodeId))) {
      return nodeId;
    }
  }

  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodes[nodeId];
    if (!node) {
      continue;
    }
    const label = (node.label ?? "").toLowerCase();
    if (label.includes("review summary")) {
      return nodeId;
    }
  }

  return null;
}

export function reviewAttractorFlowStatus(content: string): {
  councilNodeId: string | null;
  summaryNodeId: string | null;
  hasRequiredFlow: boolean;
} {
  const graph = parseDotGraph(content);
  const councilNodeId = findReviewCouncilNodeId(graph);
  const summaryNodeId = findReviewSummaryNodeId(graph);
  const hasRequiredFlow =
    councilNodeId !== null &&
    summaryNodeId !== null &&
    hasDirectedPath(graph, councilNodeId, summaryNodeId);
  return {
    councilNodeId,
    summaryNodeId,
    hasRequiredFlow
  };
}

export function assertReviewAttractorFlow(content: string): {
  councilNodeId: string;
  summaryNodeId: string;
} {
  let status;
  try {
    status = reviewAttractorFlowStatus(content);
  } catch (error) {
    throw new Error(
      `review attractor content is invalid DOT: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!status.councilNodeId || !status.summaryNodeId || !status.hasRequiredFlow) {
    throw new Error("Review attractor must include flow review_council -> review_summary.");
  }

  return {
    councilNodeId: status.councilNodeId,
    summaryNodeId: status.summaryNodeId
  };
}
