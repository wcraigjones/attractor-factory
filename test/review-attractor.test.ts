import { describe, expect, it } from "vitest";

import {
  assertReviewAttractorFlow,
  reviewAttractorFlowStatus
} from "../apps/factory-api/src/review-attractor.js";

describe("review attractor flow", () => {
  it("accepts attractors with review_council to review_summary path", () => {
    const content = `
      digraph pr_review {
        start [shape=Mdiamond, type="start"];
        review_council [shape=component, type="parallel", label="Review Council"];
        reviewer_a [shape=box, type="codergen"];
        council_fan_in [shape=tripleoctagon, type="parallel.fan_in"];
        review_summary [shape=box, type="codergen", label="Review Summary"];
        done [shape=Msquare, type="exit"];

        start -> review_council;
        review_council -> reviewer_a;
        reviewer_a -> council_fan_in;
        council_fan_in -> review_summary;
        review_summary -> done;
      }
    `;

    const status = reviewAttractorFlowStatus(content);
    expect(status.hasRequiredFlow).toBe(true);
    expect(status.councilNodeId).toBe("review_council");
    expect(status.summaryNodeId).toBe("review_summary");
    expect(assertReviewAttractorFlow(content)).toEqual({
      councilNodeId: "review_council",
      summaryNodeId: "review_summary"
    });
  });

  it("rejects attractors missing review_council to review_summary flow", () => {
    const content = `
      digraph invalid_pr_review {
        start [shape=Mdiamond, type="start"];
        review_council [shape=component, type="parallel", label="Review Council"];
        done [shape=Msquare, type="exit"];

        start -> review_council;
        review_council -> done;
      }
    `;

    expect(() => assertReviewAttractorFlow(content)).toThrow(
      "Review attractor must include flow review_council -> review_summary."
    );
  });
});
