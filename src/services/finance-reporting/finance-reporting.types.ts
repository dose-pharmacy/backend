// ── Finance Reporting — shared types ────────────────────────────────────────
//
// Read-only aggregation layer over the pharmacy's existing canonical business
// records (sales, customer returns, supplier invoices/payments/returns,
// inventory). Nothing here is persisted; every value is derived at query time
// from the source-of-truth tables. See finance-reporting.service.ts for the
// exact SQL behind each figure.

/** Bucket size for the trend series exposed on the API contract. */
export type TrendGranularity = "DAY" | "MONTH" | "YEAR";

/** Normalised input shared by every reporting entry point. */
export type FinanceScopeInput = {
  /** Inclusive first UTC day. Defaults to 30 days ago when omitted. */
  from?: Date;
  /** Inclusive last UTC day. Defaults to today when omitted. */
  to?: Date;
  locationId?: string;
  productGroupId?: string;
};

export type FinanceReportQuery = FinanceScopeInput & {
  granularity?: TrendGranularity;
};

/** Which dimensions a section could actually honour for the requested filters. */
export type SectionBasis = {
  /** "REPORT_SCOPE" = honours location/product-group filters; "COMPANY" = whole company. */
  basis: "REPORT_SCOPE" | "COMPANY";
  /** Human-readable explanation shown to clients. */
  note: string;
};

export type FinancePeriod = {
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  locationId: string | null;
  productGroupId: string | null;
  granularity: TrendGranularity;
};

// ── Dashboard snapshot ──────────────────────────────────────────────────────

export type FinanceDashboard = {
  asOf: string;
  todayGrossSales: number;
  todayDiscounts: number;
  todayCustomerReturns: number;
  todayNetSales: number;
  todayNetSalesAfterReturns: number;
  todayTransactionCount: number;
  todayCustomerCollections: number;
  todaySupplierPayments: number;
  todaySupplierReturns: number;
  outstandingSupplierPayables: number;
  customerReceivables: number;
};

// ── Finance report ──────────────────────────────────────────────────────────

export type MoneyBreakdown = {
  grossSales: number;
  discounts: number;
  netSales: number;
  customerReturns: number;
  netSalesAfterReturns: number;
};

export type FinanceSummary = MoneyBreakdown & {
  cogs: number;
  returnedCogs: number;
  grossProfit: number;
  grossMargin: number;
  grossPurchases: number;
  supplierReturns: number;
  netPurchases: number;
  supplierPayments: number;
  supplierOutstanding: number;
  customerCollections: number;
  customerReceivables: number;
};

export type PaymentMethodTotal = { method: string; amount: number };

export type SalesPerformance = {
  grossSales: number;
  discounts: number;
  customerReturns: number;
  netSales: number;
  netSalesAfterReturns: number;
  transactionCount: number;
  unitsSold: number;
  averageTransactionValue: number;
  byPaymentMethod: PaymentMethodTotal[];
  byLocation: Array<{
    locationId: string;
    locationName: string;
    netSales: number;
    discounts: number;
    transactionCount: number;
  }>;
  byProductGroup: Array<{
    productGroupId: string;
    productGroupName: string;
    lineRevenue: number;
    unitsSold: number;
  }>;
};

export type PurchasingSection = {
  grossPurchases: number;
  supplierReturns: number;
  netPurchases: number;
  invoiceAmount: number;
  supplierPayments: number;
  supplierOutstanding: number;
  purchaseOrderCount: number;
  invoiceCount: number;
  supplierReturnCount: number;
  supplierPaymentCount: number;
  outstandingInvoiceCount: number;
  /** Portion of returns applied directly against outstanding payables. */
  supplierReturnAppliedToPayable: number;
  /** Portion of returns that became a supplier refund/credit effect. */
  supplierReturnCreditEffect: number;
};

export type CollectionsSection = {
  customerCollections: number;
  customerReceivables: number;
  byPaymentMethod: PaymentMethodTotal[];
};

export type ProfitabilitySection = {
  netSales: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
};

export type InventoryValueBucket = { key: string; value: number; quantity: number };

export type InventoryValueSection = {
  /** Σ(stock quantity × base-unit purchase price) — the codebase canonical value. */
  totalValue: number;
  /** Σ(stock quantity × batch purchase cost) — actual landed batch cost. */
  batchCostValue: number;
  totalQuantity: number;
  stockedProducts: number;
  expiredValue: number;
  expiringWithin30DaysValue: number;
  expiryBuckets: InventoryValueBucket[];
};

export type FinanceTrendPoint = {
  period: string;
  grossSales: number;
  discounts: number;
  netSales: number;
  customerReturns: number;
  netSalesAfterReturns: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
  transactionCount: number;
  unitsSold: number;
  customerCollections: number;
  supplierPayments: number;
  supplierReturns: number;
};

export type FinanceTrends = {
  granularity: TrendGranularity;
  from: string;
  to: string;
  points: FinanceTrendPoint[];
};

export type FinanceReport = {
  period: FinancePeriod;
  summary: FinanceSummary;
  salesPerformance: SalesPerformance;
  purchasing: PurchasingSection;
  collections: CollectionsSection;
  profitability: ProfitabilitySection;
  inventoryValue: InventoryValueSection;
  trends: FinanceTrends;
  scopeNotes: {
    salesPerformance: SectionBasis;
    purchasing: SectionBasis;
    collections: SectionBasis;
    inventoryValue: SectionBasis;
  };
};
