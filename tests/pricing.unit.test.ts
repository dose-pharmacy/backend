import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  computeProductPricing,
  PRICING_STATUS_FILTER_VALUES,
  PRICING_STATUSES,
} from "../src/services/inventory/pricing.service.js";

/** Money helper so the expectations stay readable. */
function money(value: number): Prisma.Decimal {
  return new Prisma.Decimal(String(value));
}

function price(overrides: {
  sellingPrice: number | null;
  targetMargin: number | null;
  costBasis: number | null;
}) {
  return computeProductPricing({
    sellingPrice: overrides.sellingPrice === null ? null : money(overrides.sellingPrice),
    targetMargin: overrides.targetMargin === null ? null : money(overrides.targetMargin),
    costBasis: overrides.costBasis === null ? null : money(overrides.costBasis),
  });
}

describe("pricing: target selling price (margin on selling price)", () => {
  it("computes cost / (1 - margin), rounded to 2 dp — not markup", () => {
    const result = price({ sellingPrice: 130, targetMargin: 10, costBasis: 120 });
    expect(result.targetSellingPrice?.toString()).toBe("133.33");
    // Markup would have produced 132 — assert we are not doing that.
    expect(result.targetSellingPrice?.toString()).not.toBe("132");
  });

  it("rounds half-up without floating point noise", () => {
    const result = price({ sellingPrice: 1, targetMargin: 10, costBasis: 100 });
    expect(result.targetSellingPrice?.toString()).toBe("111.11");
  });

  it("keeps the raw cost basis and selling price untouched", () => {
    const result = price({ sellingPrice: 110, targetMargin: 10, costBasis: 120 });
    expect(result.sellingPrice?.toString()).toBe("110");
    expect(result.pricingStatus).toBe("BELOW_COST");
    expect(result.costBasis?.toString()).toBe("120");
    expect(result.targetMargin?.toString()).toBe("10");
  });
});

describe("pricing: status rules", () => {
  it("is OK when selling price is above the target", () => {
    expect(price({ sellingPrice: 150, targetMargin: 10, costBasis: 120 }).pricingStatus).toBe("OK");
  });

  it("is OK when selling price exactly equals the (rounded) target", () => {
    expect(price({ sellingPrice: 133.33, targetMargin: 10, costBasis: 120 }).pricingStatus).toBe(
      "OK",
    );
  });

  it("is BELOW_TARGET between cost and target", () => {
    // NOTE: the task brief's illustrative example (selling 110 / cost 120 →
    // BELOW_TARGET) contradicts its own precedence rule "selling <= cost ⇒
    // BELOW_COST". The rules win: 110 <= 120 is BELOW_COST, so the
    // BELOW_TARGET fixture sits strictly between cost and target.
    expect(price({ sellingPrice: 130, targetMargin: 10, costBasis: 120 }).pricingStatus).toBe(
      "BELOW_TARGET",
    );
    expect(price({ sellingPrice: 110, targetMargin: 10, costBasis: 120 }).pricingStatus).toBe(
      "BELOW_COST",
    );
  });

  it("is BELOW_COST when selling price equals cost", () => {
    expect(price({ sellingPrice: 120, targetMargin: 10, costBasis: 120 }).pricingStatus).toBe(
      "BELOW_COST",
    );
  });

  it("is BELOW_COST when selling price is under cost (and takes precedence over BELOW_TARGET)", () => {
    const result = price({ sellingPrice: 100, targetMargin: 10, costBasis: 120 });
    expect(result.pricingStatus).toBe("BELOW_COST");
    // A target price is still reported so the UI can suggest a price.
    expect(result.targetSellingPrice?.toString()).toBe("133.33");
  });

  it("is NO_MARGIN_CONFIG when the group has no usable margin", () => {
    for (const targetMargin of [null, 0]) {
      const result = price({ sellingPrice: 100, targetMargin, costBasis: 120 });
      expect(result.pricingStatus).toBe("NO_MARGIN_CONFIG");
      expect(result.targetSellingPrice).toBeNull();
      expect(result.costBasis?.toString()).toBe("120");
    }
  });

  it("is NO_MARGIN_CONFIG for a margin at or above 100% (no division by zero/negatives)", () => {
    for (const targetMargin of [100, 999.99]) {
      const result = price({ sellingPrice: 100, targetMargin, costBasis: 120 });
      expect(result.pricingStatus).toBe("NO_MARGIN_CONFIG");
      expect(result.targetSellingPrice).toBeNull();
    }
  });

  it("is NO_PURCHASE_COST when there is no valid received cost", () => {
    const result = price({ sellingPrice: 100, targetMargin: 10, costBasis: null });
    expect(result.pricingStatus).toBe("NO_PURCHASE_COST");
    expect(result.costBasis).toBeNull();
    expect(result.targetSellingPrice).toBeNull();
  });

  it("never reports BELOW_COST when the cost is unknown", () => {
    expect(price({ sellingPrice: 0, targetMargin: 10, costBasis: null }).pricingStatus).toBe(
      "NO_PURCHASE_COST",
    );
  });

  it("reports an unpriced product as BELOW_COST against a known cost", () => {
    const result = price({ sellingPrice: null, targetMargin: 10, costBasis: 120 });
    expect(result.pricingStatus).toBe("BELOW_COST");
    expect(result.sellingPrice).toBeNull();
  });
});

describe("pricing: exposed filter values", () => {
  it("accepts ALL plus every status", () => {
    expect(PRICING_STATUS_FILTER_VALUES).toEqual(["ALL", ...PRICING_STATUSES]);
  });
});
