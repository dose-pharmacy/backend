/**
 * Shared OpenAPI fragments.
 */
const idPathParam = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string", format: "uuid" },
};

const productIdPathParam = {
  name: "productId",
  in: "path" as const,
  required: true,
  schema: { type: "string", format: "uuid" },
};

const productUnitPathParams = [
  {
    name: "productId",
    in: "path" as const,
    required: true,
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "unitId",
    in: "path" as const,
    required: true,
    schema: { type: "string", format: "uuid" },
  },
];

const transferIdPathParam = {
  name: "transferId",
  in: "path" as const,
  required: true,
  schema: { type: "string", format: "uuid" },
};

const transferItemPathParams = [
  {
    name: "transferId",
    in: "path" as const,
    required: true,
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "itemId",
    in: "path" as const,
    required: true,
    schema: { type: "string", format: "uuid" },
  },
];

const authErrorResponses = {
  "401": {
    description: "Unauthenticated — a valid session cookie is required",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
  },
  "403": {
    description: "Forbidden — the session belongs to a non-admin role",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
  },
} as const;

const authOriginParameter = {
  name: "Origin",
  in: "header" as const,
  required: true,
  description:
    "The configured frontend origin, for example http://localhost:5173. Better Auth uses this header for trusted-origin and CSRF checks.",
  schema: { type: "string", format: "uri", example: "http://localhost:5173" },
};

/**
 * OpenAPI 3.0.3 specification for the inventory API.
 *
 * Served as JSON at GET /api-docs and rendered in Swagger UI at
 * GET /api-docs/ui. Every path here mirrors a real route in
 * src/routes/inventory.ts.
 *
 * Notes on units:
 *  - `Unit` is a REUSABLE master unit ("Tablet", "Strip", "Box", ...).
 *  - `ProductUnit` is the product-specific configuration (conversion factor,
 *    prices, base-unit flag) referencing a master Unit.
 *  - ProductUnit.purchasePrice is the DEFAULT / reference purchase price.
 *    The authoritative historical cost of received stock lives on the Batch
 *    (purchaseCost) and is never overwritten by this value.
 *  - Transfer items keep both `quantity` + `unitId` (user entry) and
 *    `baseQuantity` (server-normalised to the product base unit at entry
 *    time). Stock is always stored and moved in base units.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Pharmacy Management System — Inventory API",
    version: "1.0.0",
    description:
      "Inventory API for the Pharmacy Management System. All inventory routes require an authenticated ADMIN session (Better Auth cookie).\n\n" +
      "- **Units** (`/inventory/units`): reusable master units that can be shared by many products.\n" +
      "- **Products** (`/inventory/products`): product creation accepts an embedded `units` array that configures ProductUnits atomically with the product.\n" +
      "- **Transfers** (`/inventory/transfers`): draft items are edited with dedicated item endpoints; completion moves stock in base units inside a single transaction.",
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "Authentication", description: "Better Auth email, session, and Google OAuth endpoints" },
    { name: "Dashboard", description: "Inventory overview metrics" },
    { name: "Product Groups", description: "Product grouping and classification" },
    { name: "Locations", description: "Inventory storage locations" },
    { name: "Batches", description: "Product inventory batches" },
    { name: "Expiry", description: "Expiry monitoring and actions" },
    { name: "Reorder", description: "Reorder dashboards and purchase requirements" },
    { name: "Units", description: "Reusable master units (Tablet, Strip, Box, ml, mg, ...)" },
    { name: "Products", description: "Products with embedded unit configuration" },
    { name: "Product Units", description: "Product-specific unit configuration" },
    { name: "Transfers", description: "Stock transfers between locations" },
    { name: "Stock", description: "Stock movements and current stock" },
  ],
  paths: {
    "/api/auth/sign-up/email": {
      post: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Register with email and password",
        description: "Creates a user and automatically starts a session. The response sets the Better Auth session cookie.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuthSignUpInput" },
            },
          },
        },
        responses: {
          "200": { description: "User registered and session created", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
          "400": { description: "Invalid input or email already registered" },
        },
      },
    },
    "/api/auth/sign-in/email": {
      post: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Sign in with email and password",
        description: "The Origin header must equal the configured FRONTEND_URL. The response sets the Better Auth session cookie.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuthSignInInput" },
            },
          },
        },
        responses: {
          "200": { description: "Signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/api/auth/sign-out": {
      post: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Sign out",
        description: "Invalidates the current session. Send the session cookie and the configured frontend Origin header.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [], sessionCookie: [] }],
        responses: {
          "200": { description: "Signed out", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
          "401": { description: "No valid session" },
        },
      },
    },
    "/api/auth/get-session": {
      get: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Get the current session",
        description: "Returns the current user and session, or null when no valid session exists.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [], sessionCookie: [] }],
        responses: {
          "200": { description: "Current session or null", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSessionResponse" } } } },
        },
      },
    },
    "/api/auth/sign-in/social": {
      post: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Start Google sign-in",
        description: "Starts the Google OAuth flow. Use provider=google and a callbackURL pointing to the frontend.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuthSocialSignInInput" },
            },
          },
        },
        responses: {
          "200": { description: "OAuth redirect details", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
        },
      },
    },
    "/api/auth/callback/google": {
      get: {
        tags: ["Authentication"],
        servers: [{ url: "/" }],
        summary: "Google OAuth callback",
        description: "Browser callback handled by Better Auth after Google authentication. Normally follow the redirect returned by Google rather than calling this manually.",
        parameters: [authOriginParameter],
        security: [{ authOrigin: [] }],
        responses: {
          "302": { description: "Redirects to the frontend callback URL" },
        },
      },
    },
    "/inventory/dashboard": {
      get: {
        tags: ["Dashboard"],
        summary: "Get the inventory dashboard",
        parameters: [{ name: "thresholds", in: "query", schema: { type: "string", example: "30,60,90" }, description: "Comma-separated expiry thresholds in days" }],
        responses: { "200": { description: "Dashboard metrics", content: { "application/json": { schema: { $ref: "#/components/schemas/DashboardResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/product-groups": {
      get: {
        tags: ["Product Groups"],
        summary: "List product groups",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "search", in: "query", schema: { type: "string" } }, { name: "isActive", in: "query", schema: { type: "boolean" } }],
        responses: { "200": { description: "Product groups", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses },
      },
      post: {
        tags: ["Product Groups"],
        summary: "Create a product group",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ProductGroupCreateInput" } } } },
        responses: { "201": { description: "Product group created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/product-groups/{id}": {
      get: {
        tags: ["Product Groups"],
        summary: "Get a product group",
        parameters: [idPathParam],
        responses: { "200": { description: "Product group", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Product group not found" }, ...authErrorResponses },
      },
      patch: {
        tags: ["Product Groups"],
        summary: "Update a product group",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ProductGroupUpdateInput" } } } },
        responses: { "200": { description: "Product group updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Product group not found" }, ...authErrorResponses },
      },
      delete: {
        tags: ["Product Groups"],
        summary: "Deactivate a product group",
        parameters: [idPathParam],
        responses: { "200": { description: "Product group deactivated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Product group not found" }, ...authErrorResponses },
      },
    },
    "/inventory/locations": {
      get: {
        tags: ["Locations"],
        summary: "List inventory locations",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "search", in: "query", schema: { type: "string" } }, { name: "isActive", in: "query", schema: { type: "boolean" } }],
        responses: { "200": { description: "Locations", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses },
      },
      post: {
        tags: ["Locations"],
        summary: "Create an inventory location",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LocationCreateInput" } } } },
        responses: { "201": { description: "Location created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/locations/{id}": {
      get: {
        tags: ["Locations"],
        summary: "Get an inventory location",
        parameters: [idPathParam],
        responses: { "200": { description: "Location", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Location not found" }, ...authErrorResponses },
      },
      patch: {
        tags: ["Locations"],
        summary: "Update an inventory location",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LocationUpdateInput" } } } },
        responses: { "200": { description: "Location updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Location not found" }, ...authErrorResponses },
      },
      delete: {
        tags: ["Locations"],
        summary: "Deactivate an inventory location",
        parameters: [idPathParam],
        responses: { "200": { description: "Location deactivated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Location not found" }, ...authErrorResponses },
      },
    },
    "/inventory/inventory-products": {
      get: {
        tags: ["Products"],
        summary: "List products with stock status",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "productGroupId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "brand", in: "query", schema: { type: "string" } },
          { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "stockStatus", in: "query", schema: { type: "string", enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"] } },
          { name: "isActive", in: "query", schema: { type: "string", enum: ["true", "false"] } },
        ],
        responses: { "200": { description: "Products and stock status", content: { "application/json": { schema: { $ref: "#/components/schemas/InventoryProductListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/products/{productId}/stock": {
      get: {
        tags: ["Stock"],
        summary: "Get stock for a product",
        parameters: [productIdPathParam, { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } }, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }],
        responses: { "200": { description: "Product stock", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/products/{productId}/batches": {
      get: {
        tags: ["Batches"],
        summary: "List batches for a product",
        parameters: [productIdPathParam, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Product batches", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/products/{productId}/transactions": {
      get: {
        tags: ["Stock"],
        summary: "List transactions for a product",
        parameters: [productIdPathParam, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } }, { name: "type", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Product stock transactions", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/batches": {
      get: {
        tags: ["Batches"],
        summary: "List inventory batches",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "productId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["AVAILABLE", "LOW_STOCK", "DEPLETED", "EXPIRED"] } },
          { name: "expiresBefore", in: "query", schema: { type: "string", format: "date" } },
          { name: "expiresAfter", in: "query", schema: { type: "string", format: "date" } },
        ],
        responses: { "200": { description: "Batches", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchListResponse" } } } }, ...authErrorResponses },
      },
      post: {
        tags: ["Batches"],
        summary: "Create a batch",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BatchCreateInput" } } } },
        responses: { "201": { description: "Batch created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/batches/{id}": {
      get: {
        tags: ["Batches"],
        summary: "Get a batch",
        parameters: [idPathParam],
        responses: { "200": { description: "Batch", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchDetailResponse" } } } }, "404": { description: "Batch not found" }, ...authErrorResponses },
      },
      patch: {
        tags: ["Batches"],
        summary: "Update a batch",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BatchUpdateInput" } } } },
        responses: { "200": { description: "Batch updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Batch not found" }, ...authErrorResponses },
      },
      delete: {
        tags: ["Batches"],
        summary: "Deactivate a batch",
        parameters: [idPathParam],
        responses: { "200": { description: "Batch deactivated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Batch not found" }, ...authErrorResponses },
      },
    },
    "/inventory/batches/{id}/transactions": {
      get: {
        tags: ["Stock"],
        summary: "List transactions for a batch",
        parameters: [idPathParam, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "type", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Batch transactions", content: { "application/json": { schema: { $ref: "#/components/schemas/StockTransactionListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/location-stock": {
      get: {
        tags: ["Stock"],
        summary: "List stock by location",
        parameters: [{ name: "locationId", in: "query", required: true, schema: { type: "string", format: "uuid" } }, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "search", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Location stock", content: { "application/json": { schema: { $ref: "#/components/schemas/LocationStockResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/expiry/dashboard": {
      get: {
        tags: ["Expiry"],
        summary: "Get expiry dashboard",
        parameters: [{ name: "thresholds", in: "query", schema: { type: "string", example: "30,60,90" }, description: "Comma-separated expiry thresholds in days" }, { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } }, { name: "productId", in: "query", schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Expiry metrics", content: { "application/json": { schema: { $ref: "#/components/schemas/ExpiryDashboardResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/expiry/batches": {
      get: {
        tags: ["Expiry"],
        summary: "List batches by expiry window",
        parameters: [{ name: "thresholds", in: "query", schema: { type: "string", example: "30,60,90" } }, { name: "windowStart", in: "query", schema: { type: "integer", minimum: 0, example: 0 } }, { name: "windowEnd", in: "query", schema: { type: "integer", minimum: 1, example: 30 } }, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } }, { name: "productId", in: "query", schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Expiring batches", content: { "application/json": { schema: { $ref: "#/components/schemas/ExpiryBatchListResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/batches/{batchId}/expiry-actions": {
      get: {
        tags: ["Expiry"],
        summary: "List expiry actions for a batch",
        parameters: [{ name: "batchId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }],
        responses: { "200": { description: "Expiry actions", content: { "application/json": { schema: { $ref: "#/components/schemas/ExpiryActionListResponse" } } } }, ...authErrorResponses },
      },
      post: {
        tags: ["Expiry"],
        summary: "Create an expiry action",
        parameters: [{ name: "batchId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ExpiryActionInput" } } } },
        responses: { "201": { description: "Expiry action created", content: { "application/json": { schema: { $ref: "#/components/schemas/ExpiryActionResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/bin-card": {
      get: {
        tags: ["Stock"],
        summary: "Get the stock bin card",
        description: "Returns the running stock ledger for a product at a location, optionally limited to one batch and date range. Quantities are always in the product base unit.",
        parameters: [
          { name: "productId", in: "query", required: true, schema: { type: "string", format: "uuid", example: "product-uuid" } },
          { name: "locationId", in: "query", required: true, schema: { type: "string", format: "uuid", example: "location-uuid" } },
          { name: "batchId", in: "query", schema: { type: "string", format: "uuid", example: "batch-uuid" } },
          { name: "startDate", in: "query", schema: { type: "string", format: "date", example: "2026-09-01" } },
          { name: "endDate", in: "query", schema: { type: "string", format: "date", example: "2026-09-10" } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1, example: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20, example: 20 } },
        ],
        responses: {
          "200": { description: "Bin card opening balance, movements, and closing balance", content: { "application/json": { schema: { $ref: "#/components/schemas/BinCardResponse" } } } },
          "404": { description: "Product or location not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/reorder/dashboard": {
      get: {
        tags: ["Reorder"],
        summary: "Get reorder dashboard",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "urgency", in: "query", schema: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] } }],
        responses: { "200": { description: "Reorder metrics", content: { "application/json": { schema: { $ref: "#/components/schemas/ReorderDashboardResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/reorder/suggestions": {
      get: {
        tags: ["Reorder"],
        summary: "List reorder suggestions",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }],
        responses: { "200": { description: "Reorder suggestions", content: { "application/json": { schema: { $ref: "#/components/schemas/ReorderSuggestionsResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/products/{productId}/reorder-config": {
      get: {
        tags: ["Reorder"],
        summary: "Get product reorder configuration",
        parameters: [productIdPathParam],
        responses: { "200": { description: "Reorder configuration", content: { "application/json": { schema: { $ref: "#/components/schemas/ReorderConfigResponse" } } } }, ...authErrorResponses },
      },
      put: {
        tags: ["Reorder"],
        summary: "Create or update product reorder configuration",
        parameters: [productIdPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReorderConfigInput" } } } },
        responses: { "200": { description: "Reorder configuration saved", content: { "application/json": { schema: { $ref: "#/components/schemas/ReorderConfigResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/reorder/generate-purchase-requirements": {
      post: {
        tags: ["Reorder"],
        summary: "Generate purchase requirements from reorder suggestions",
        responses: { "200": { description: "Purchase requirements generated", content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseRequirementsResponse" } } } }, ...authErrorResponses },
      },
    },
    "/inventory/units": {
      get: {
        tags: ["Units"],
        summary: "List reusable master units",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "search", in: "query", schema: { type: "string" }, description: "Match by name or symbol" },
          { name: "isActive", in: "query", schema: { type: "string", enum: ["true", "false"] } },
        ],
        responses: {
          "200": {
            description: "Paginated list of master units",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UnitListResponse" } } },
          },
          ...authErrorResponses,
        },
      },
      post: {
        tags: ["Units"],
        summary: "Create a reusable master unit",
        description: "A master unit is the reusable concept only (e.g. \"Box\"). Product-specific behavior is configured via ProductUnit.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UnitCreateInput" } } },
        },
        responses: {
          "201": { description: "Unit created", content: { "application/json": { schema: { $ref: "#/components/schemas/UnitResponse" } } } },
          "409": { description: "Duplicate unit name", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/units/{id}": {
      get: {
        tags: ["Units"],
        summary: "Get a master unit by id",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Unit", content: { "application/json": { schema: { $ref: "#/components/schemas/UnitResponse" } } } },
          "404": { description: "Unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      patch: {
        tags: ["Units"],
        summary: "Update a master unit",
        parameters: [idPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UnitUpdateInput" } } },
        },
        responses: {
          "200": { description: "Unit updated", content: { "application/json": { schema: { $ref: "#/components/schemas/UnitResponse" } } } },
          "404": { description: "Unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate unit name", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      delete: {
        tags: ["Units"],
        summary: "Deactivate (soft-delete) a master unit",
        description: "Soft delete: the unit is deactivated so it can no longer be attached to products or transfers, but historical records stay intact.",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Unit deactivated", content: { "application/json": { schema: { $ref: "#/components/schemas/EmptySuccessResponse" } } } },
          "404": { description: "Unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/products": {
      get: {
        tags: ["Products"],
        summary: "List products",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "productGroupId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "brand", in: "query", schema: { type: "string" } },
          { name: "isActive", in: "query", schema: { type: "string", enum: ["true", "false"] } },
        ],
        responses: {
          "200": { description: "Paginated product list", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductListResponse" } } } },
          ...authErrorResponses,
        },
      },
      post: {
        tags: ["Products"],
        summary: "Create a product with its unit configuration",
        description:
          "Creates the product and its ProductUnit configurations atomically in one transaction. `units` is optional for backward compatibility (units can also be added via POST /inventory/products/{productId}/units). When supplied, exactly one entry must be the base unit (conversionFactor = 1) and every master unit must exist and be active.\n\n" +
          "**purchasePrice is the default/reference purchase price** — NOT the authoritative historical cost. Actual received cost is recorded on the Batch.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProductCreateInput" } } },
        },
        responses: {
          "201": { description: "Product created (with units when supplied)", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductDetailResponse" } } } },
          "404": { description: "Product group or unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate SKU / duplicate or missing base unit / inactive unit", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/products/{id}": {
      get: {
        tags: ["Products"],
        summary: "Get product detail (units + stock summary)",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Product detail", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductDetailResponse" } } } },
          "404": { description: "Product not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      patch: {
        tags: ["Products"],
        summary: "Update a product and safely upsert its unit configuration",
        description:
          "Updates product fields and, when `units` is supplied, upserts unit configurations: existing configs are updated (conversion factor/prices), missing ones are created. The base unit cannot be removed or re-designated here — use the dedicated product-unit endpoints for structural changes.",
        parameters: [idPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUpdateInput" } } },
        },
        responses: {
          "200": { description: "Product updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductDetailResponse" } } } },
          "404": { description: "Product not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate SKU / base-unit conflicts", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      delete: {
        tags: ["Products"],
        summary: "Deactivate a product",
        parameters: [idPathParam],
        responses: { "200": { description: "Product deactivated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, "404": { description: "Product not found" }, ...authErrorResponses },
      },
    },
    "/inventory/products/{productId}/units": {
      get: {
        tags: ["Product Units"],
        summary: "List a product's unit configurations",
        parameters: [productIdPathParam],
        responses: {
          "200": { description: "ProductUnit list", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUnitListResponse" } } } },
          "404": { description: "Product not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      post: {
        tags: ["Product Units"],
        summary: "Configure a reusable master unit for a product",
        description:
          "Attaches an existing master unit to a product with a conversion factor and prices. The same master unit can be configured for many products; it can only be configured once per product. A product must have exactly one base unit (conversionFactor = 1).",
        parameters: [productIdPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUnitCreateInput" } } },
        },
        responses: {
          "201": { description: "ProductUnit created", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUnitResponse" } } } },
          "404": { description: "Product or unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate config / inactive unit / base unit already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/products/{productId}/units/convert": {
      post: {
        tags: ["Product Units"],
        summary: "Convert a quantity between two of the product's units",
        parameters: [productIdPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ConvertUnitsInput" } } },
        },
        responses: {
          "200": { description: "Conversion result", content: { "application/json": { schema: { $ref: "#/components/schemas/ConvertUnitsResponse" } } } },
          "422": { description: "Unit not configured for the product", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/products/{productId}/units/{unitId}": {
      patch: {
        tags: ["Product Units"],
        summary: "Update a product-unit configuration",
        description: "The base unit conversion factor is fixed at 1 and cannot be changed.",
        parameters: [productUnitPathParams],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUnitUpdateInput" } } },
        },
        responses: {
          "200": { description: "ProductUnit updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductUnitResponse" } } } },
          "404": { description: "ProductUnit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Base unit conversion factor change", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      delete: {
        tags: ["Product Units"],
        summary: "Delete a product-unit configuration",
        description: "The base unit of a product cannot be deleted — a product must always keep exactly one base unit.",
        parameters: [productUnitPathParams],
        responses: {
          "200": { description: "ProductUnit deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/EmptySuccessResponse" } } } },
          "404": { description: "ProductUnit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Base unit cannot be deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers": {
      get: {
        tags: ["Transfers"],
        summary: "List stock transfers",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["DRAFT", "PENDING", "COMPLETED", "CANCELLED"] } },
          { name: "fromLocationId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "toLocationId", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Paginated transfer list", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferListResponse" } } } },
          ...authErrorResponses,
        },
      },
      post: {
        tags: ["Transfers"],
        summary: "Create a draft transfer with unit-aware items",
        description:
          "Creates the transfer (status DRAFT) and its items in one transaction. For each item: the batch must belong to the product, the unit must be configured for the product and active, and the server computes `baseQuantity` (quantity x conversionFactor) which is persisted for auditability.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/TransferCreateInput" } } },
        },
        responses: {
          "201": { description: "Draft transfer created", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferResponse" } } } },
          "404": { description: "Location, product, batch or unit not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate item / inactive location or unit / insufficient data", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation error / batch-product mismatch / invalid unit", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers/{id}": {
      get: {
        tags: ["Transfers"],
        summary: "Get a transfer by id",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Transfer", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferResponse" } } } },
          "404": { description: "Transfer not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      patch: {
        tags: ["Transfers"],
        summary: "Update transfer header fields",
        description:
          "Updates locations/date/reason only. `status` is NOT accepted here — state transitions happen exclusively through POST /inventory/transfers/{id}/complete and POST /inventory/transfers/{id}/cancel. Items are managed via the dedicated item endpoints.",
        parameters: [idPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/TransferUpdateInput" } } },
        },
        responses: {
          "200": { description: "Transfer updated", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferResponse" } } } },
          "404": { description: "Transfer not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Transfer is completed/cancelled or location inactive", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers/{transferId}/items": {
      post: {
        tags: ["Transfers"],
        summary: "Add an item to a draft transfer",
        description:
          "Only allowed while the transfer is editable (DRAFT/PENDING). The same product + batch + unit combination can appear only once. `baseQuantity` is server-calculated and persisted.",
        parameters: [transferIdPathParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/TransferItemCreateInput" } } },
        },
        responses: {
          "201": { description: "Item added", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferItemResponse" } } } },
          "404": { description: "Transfer not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate item / transfer not editable / inactive unit", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation error / batch-product mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers/{transferId}/items/{itemId}": {
      patch: {
        tags: ["Transfers"],
        summary: "Update a draft transfer item",
        description: "Updates quantity and/or unit; `baseQuantity` is recomputed with the current ProductUnit conversion factor and persisted.",
        parameters: [transferItemPathParams],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/TransferItemUpdateInput" } } },
        },
        responses: {
          "200": { description: "Item updated", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferItemResponse" } } } },
          "404": { description: "Transfer or item not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Duplicate item / transfer not editable", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
      delete: {
        tags: ["Transfers"],
        summary: "Remove a draft transfer item",
        parameters: [transferItemPathParams],
        responses: {
          "200": { description: "Item removed", content: { "application/json": { schema: { $ref: "#/components/schemas/EmptySuccessResponse" } } } },
          "404": { description: "Transfer or item not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Transfer not editable", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers/{id}/complete": {
      post: {
        tags: ["Transfers"],
        summary: "Complete a transfer (moves stock atomically)",
        description:
          "Runs the entire completion in ONE database transaction: validates transfer/locations/items, validates source stock using the persisted base quantities, records TRANSFER_OUT at the source and TRANSFER_IN at the destination for every item, then sets status = COMPLETED. If any step fails, everything rolls back — the database can never end up with stock moved but the transfer still DRAFT/PENDING, or the transfer COMPLETED but no movement.",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Transfer completed", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferResponse" } } } },
          "404": { description: "Transfer not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Already completed/cancelled / insufficient stock / inactive location", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/transfers/{id}/cancel": {
      post: {
        tags: ["Transfers"],
        summary: "Cancel a transfer",
        description: "Allowed while the transfer is DRAFT or PENDING. A completed transfer cannot be cancelled.",
        parameters: [idPathParam],
        responses: {
          "200": { description: "Transfer cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/TransferResponse" } } } },
          "404": { description: "Transfer not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Already cancelled / cannot cancel a completed transfer", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/opening-stock": {
      post: {
        tags: ["Stock"],
        summary: "Record opening stock for a batch at a location",
        description:
          "`quantity` is expressed in the unit identified by `unitId`; the server converts it to the product base unit using the ProductUnit conversion factor and records an OPENING/IN StockTransaction.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/OpeningStockInput" } } },
        },
        responses: {
          "201": { description: "Movement recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/StockMovementResponse" } } } },
          "404": { description: "Batch not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "409": { description: "Insufficient stock / inactive location / expired batch / inactive unit", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Batch-product mismatch / invalid unit", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/stock-adjustments": {
      post: {
        tags: ["Stock"],
        summary: "Record a manual stock adjustment",
        description:
          "`quantity` is expressed in the unit identified by `unitId` and converted to base units by the server. `reason` is mandatory and stored on the immutable StockTransaction.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/StockAdjustmentInput" } } },
        },
        responses: {
          "201": { description: "Movement recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/StockMovementResponse" } } } },
          "409": { description: "Insufficient stock / inactive location / expired batch", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
    "/inventory/stock": {
      get: {
        tags: ["Stock"],
        summary: "List current stock (always in base units)",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "productId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "batchId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "locationId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "search", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Paginated stock list", content: { "application/json": { schema: { $ref: "#/components/schemas/StockListResponse" } } } },
          ...authErrorResponses,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      authOrigin: {
        type: "apiKey",
        in: "header",
        name: "Origin",
        description:
          "Required for Better Auth requests. Set this to the configured FRONTEND_URL, such as http://localhost:5173.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description:
          "Better Auth session cookie. Sign in first via POST /api/auth/sign-in/email (or the app), then the cookie is sent automatically.",
      },
    },
    schemas: {
      GenericDataResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", example: "9f1c2a3b-4d5e-4f60-8a71-2b3c4d5e6f70" },
              name: { type: "string", example: "Main Store" },
              description: { type: "string", nullable: true, example: "Central pharmacy warehouse" },
              isActive: { type: "boolean", example: true },
              status: { type: "string", example: "AVAILABLE" },
              quantity: { type: "number", example: 1250 },
            },
          },
        },
        example: {
          success: true,
          data: {
            id: "9f1c2a3b-4d5e-4f60-8a71-2b3c4d5e6f70",
            name: "Main Store",
            isActive: true,
          },
        },
      },
      GenericListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid", example: "9f1c2a3b-4d5e-4f60-8a71-2b3c4d5e6f70" },
                name: { type: "string", example: "Paracetamol 500mg" },
                sku: { type: "string", example: "PCM-500" },
                batchNumber: { type: "string", example: "PCM001" },
                quantity: { type: "number", example: 1250 },
                unit: { type: "string", example: "Tablet" },
                status: { type: "string", example: "IN_STOCK" },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: {
          success: true,
          data: [
            {
              id: "9f1c2a3b-4d5e-4f60-8a71-2b3c4d5e6f70",
              name: "Paracetamol 500mg",
              sku: "PCM-500",
              quantity: 1250,
              unit: "Tablet",
              status: "IN_STOCK",
            },
          ],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
      ProductGroupCreateInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 100, example: "Analgesics" },
          description: { type: "string", maxLength: 500, example: "Pain relief medicines" },
          defaultProfitMargin: { type: "number", minimum: 0, maximum: 100, example: 20 },
          isActive: { type: "boolean", default: true, example: true },
        },
        example: {
          name: "Analgesics",
          description: "Pain relief medicines",
          defaultProfitMargin: 20,
          isActive: true,
        },
      },
      ProductGroupUpdateInput: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100, example: "Analgesics" },
          description: { type: "string", maxLength: 500, example: "Updated pain relief medicines" },
          defaultProfitMargin: { type: "number", minimum: 0, maximum: 100, example: 22 },
          isActive: { type: "boolean", example: true },
        },
        example: { description: "Updated pain relief medicines", isActive: true },
      },
      LocationCreateInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 100, example: "Main Store" },
          description: { type: "string", maxLength: 500, example: "Central pharmacy warehouse" },
          isActive: { type: "boolean", default: true, example: true },
        },
        example: { name: "Main Store", description: "Central pharmacy warehouse", isActive: true },
      },
      LocationUpdateInput: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100, example: "Main Store" },
          description: { type: "string", maxLength: 500, example: "Central pharmacy warehouse" },
          isActive: { type: "boolean", example: true },
        },
        example: { description: "Central pharmacy warehouse", isActive: true },
      },
      BatchCreateInput: {
        type: "object",
        required: ["productId", "batchNumber", "expiryDate"],
        properties: {
          productId: { type: "string", format: "uuid", example: "product-uuid" },
          batchNumber: { type: "string", maxLength: 64, example: "PCM001" },
          manufacturingDate: { type: "string", format: "date", example: "2026-01-15" },
          receivedDate: { type: "string", format: "date", example: "2026-09-10" },
          expiryDate: { type: "string", format: "date", example: "2027-08-31" },
          purchaseCost: { type: "number", minimum: 0, example: 110 },
          supplierReference: { type: "string", maxLength: 200, example: "ABC Pharma invoice 1042" },
        },
        example: {
          productId: "product-uuid",
          batchNumber: "PCM001",
          receivedDate: "2026-09-10",
          expiryDate: "2027-08-31",
          purchaseCost: 110,
          supplierReference: "ABC Pharma invoice 1042",
        },
      },
      BatchUpdateInput: {
        type: "object",
        properties: {
          batchNumber: { type: "string", maxLength: 64, example: "PCM001" },
          manufacturingDate: { type: "string", format: "date", nullable: true, example: "2026-01-15" },
          receivedDate: { type: "string", format: "date", nullable: true, example: "2026-09-10" },
          expiryDate: { type: "string", format: "date", example: "2027-09-30" },
          purchaseCost: { type: "number", minimum: 0, nullable: true, example: 112 },
          supplierReference: { type: "string", maxLength: 200, nullable: true, example: "ABC Pharma invoice 1042" },
        },
        example: { expiryDate: "2027-09-30", purchaseCost: 112 },
      },
      ExpiryActionInput: {
        type: "object",
        required: ["batchId", "actionType"],
        properties: {
          batchId: { type: "string", format: "uuid", example: "batch-uuid" },
          actionType: { type: "string", enum: ["RETURN_TO_SUPPLIER", "CLEARANCE_SALE", "DISPOSE"], example: "DISPOSE" },
          quantity: { type: "number", minimum: 0, example: 25 },
          locationId: { type: "string", format: "uuid", example: "location-uuid" },
          supplierId: { type: "string", format: "uuid", example: "supplier-uuid" },
          discountPercent: { type: "number", minimum: 0, maximum: 100, example: 25 },
          reason: { type: "string", maxLength: 500, example: "Expired stock" },
          notes: { type: "string", maxLength: 500, example: "Disposed according to pharmacy policy" },
        },
        example: {
          batchId: "batch-uuid",
          actionType: "DISPOSE",
          quantity: 25,
          locationId: "location-uuid",
          reason: "Expired stock",
          notes: "Disposed according to pharmacy policy",
        },
      },
      ReorderConfigInput: {
        type: "object",
        required: ["minimumStockLevel", "reorderPoint", "reorderQuantity"],
        properties: {
          minimumStockLevel: { type: "number", minimum: 0, example: 20 },
          reorderPoint: { type: "number", minimum: 0, example: 50 },
          leadTimeDays: { type: "integer", minimum: 1, maximum: 365, example: 14 },
          reorderQuantity: { type: "number", minimum: 0, example: 100 },
          useSalesVelocity: { type: "boolean", example: true },
          bufferPercentage: { type: "number", minimum: 0, maximum: 100, example: 10 },
        },
        example: {
          minimumStockLevel: 20,
          reorderPoint: 50,
          leadTimeDays: 14,
          reorderQuantity: 100,
          useSalesVelocity: true,
          bufferPercentage: 10,
        },
      },
      AuthSignUpInput: {
        type: "object",
        required: ["name", "email", "password"],
        properties: {
          name: { type: "string", example: "Ada Lovelace" },
          email: { type: "string", format: "email", example: "ada@example.com" },
          password: { type: "string", format: "password", minLength: 8, maxLength: 128 },
        },
      },
      AuthSignInInput: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "ada@example.com" },
          password: { type: "string", format: "password" },
        },
      },
      AuthSocialSignInInput: {
        type: "object",
        required: ["provider"],
        properties: {
          provider: { type: "string", enum: ["google"], example: "google" },
          callbackURL: { type: "string", format: "uri", example: "http://localhost:5173" },
        },
      },
      AuthResponse: {
        type: "object",
        description: "Better Auth response. The exact fields depend on the endpoint; successful sign-in and sign-up also set a session cookie.",
        properties: {
          token: { type: "string", nullable: true, example: null },
          user: { $ref: "#/components/schemas/AuthUser" },
          session: { $ref: "#/components/schemas/AuthSession" },
          url: { type: "string", format: "uri", nullable: true, example: null },
        },
        example: {
          token: null,
          user: { id: "user-uuid", name: "Ada Lovelace", email: "ada@example.com", role: "ADMIN" },
          session: { id: "session-uuid", expiresAt: "2026-09-17T12:00:00.000Z" },
        },
      },
      AuthSessionResponse: {
        type: "object",
        nullable: true,
        description: "Better Auth session response, or null when unauthenticated.",
        example: {
          user: { id: "user-uuid", name: "Ada Lovelace", email: "ada@example.com", role: "ADMIN" },
          session: { id: "session-uuid", expiresAt: "2026-09-17T12:00:00.000Z" },
        },
      },
      AuthUser: {
        type: "object",
        properties: {
          id: { type: "string", example: "user-uuid" },
          name: { type: "string", example: "Ada Lovelace" },
          email: { type: "string", format: "email", example: "ada@example.com" },
          role: { type: "string", enum: ["ADMIN", "PHARMACIST", "CASHIER"], example: "ADMIN" },
        },
      },
      AuthSession: {
        type: "object",
        properties: {
          id: { type: "string", example: "session-uuid" },
          expiresAt: { type: "string", format: "date-time", example: "2026-09-17T12:00:00.000Z" },
        },
      },
      Unit: {
        type: "object",
        description: "Reusable master unit (e.g. Tablet, Strip, Box, Bottle, Vial, ml, mg). Product-specific behavior lives on ProductUnit.",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "Box" },
          symbol: { type: "string", nullable: true, example: "BX" },
          description: { type: "string", nullable: true },
          isActive: { type: "boolean", example: true },
          productCount: { type: "integer", example: 5, description: "Number of products using this unit" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "isActive", "createdAt", "updatedAt", "productCount"],
      },
      UnitCreateInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Box" },
          symbol: { type: "string", example: "BX" },
          description: { type: "string" },
          isActive: { type: "boolean", default: true },
        },
        required: ["name"],
      },
      UnitUpdateInput: {
        type: "object",
        properties: {
          name: { type: "string" },
          symbol: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          isActive: { type: "boolean" },
        },
      },
      UnitResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { $ref: "#/components/schemas/Unit" },
        },
        example: {
          success: true,
          data: { id: "unit-uuid", name: "Box", symbol: "BX", description: null, isActive: true, createdAt: "2026-09-10T12:00:00.000Z", updatedAt: "2026-09-10T12:00:00.000Z" },
        },
      },
      UnitListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { $ref: "#/components/schemas/Unit" } },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: {
          success: true,
          data: [{ id: "unit-uuid", name: "Box", symbol: "BX", description: null, isActive: true }],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
      ProductUnitConfig: {
        type: "object",
        description:
          "Embedded unit configuration accepted on product create/update. The same master unit can be used by many products with different factors/prices.",
        properties: {
          unitId: { type: "string", format: "uuid", example: "box-master-unit-id" },
          conversionFactor: { type: "number", example: 100, description: "1 unit = conversionFactor base units. Base unit must be exactly 1." },
          sellPrice: { type: "number", example: 150, description: "Sell price for this product unit" },
          purchasePrice: {
            type: "number",
            example: 110,
            description:
              "DEFAULT / reference purchase price for this product unit. NOT the authoritative historical inventory cost — actual received cost is recorded on the Batch.",
          },
          isBaseUnit: { type: "boolean", example: false, description: "Exactly one base unit per product, with conversionFactor = 1." },
        },
        required: ["unitId", "conversionFactor"],
      },
      ProductCreateInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Paracetamol 500mg" },
          genericName: { type: "string", example: "Paracetamol" },
          brand: { type: "string", example: "Example" },
          sku: { type: "string", example: "PCM-500" },
          productGroupId: { type: "string", format: "uuid" },
          description: { type: "string" },
          imageUrl: { type: "string", format: "uri" },
          minimumStock: { type: "number", example: 100 },
          reorderPoint: { type: "number" },
          isActive: { type: "boolean", default: true },
          units: {
            type: "array",
            description: "Optional: unit configurations created atomically with the product.",
            items: { $ref: "#/components/schemas/ProductUnitConfig" },
            example: [
              { unitId: "tablet-unit-id", conversionFactor: 1, sellPrice: 2, purchasePrice: 1.2, isBaseUnit: true },
              { unitId: "strip-unit-id", conversionFactor: 10, sellPrice: 18, purchasePrice: 12, isBaseUnit: false },
              { unitId: "box-unit-id", conversionFactor: 100, sellPrice: 150, purchasePrice: 110, isBaseUnit: false },
            ],
          },
        },
        required: ["name", "sku", "productGroupId"],
      },
      ProductUpdateInput: {
        type: "object",
        properties: {
          name: { type: "string" },
          genericName: { type: "string", nullable: true },
          brand: { type: "string", nullable: true },
          sku: { type: "string" },
          productGroupId: { type: "string", format: "uuid" },
          description: { type: "string" },
          imageUrl: { type: "string", nullable: true },
          minimumStock: { type: "number" },
          reorderPoint: { type: "number", nullable: true },
          isActive: { type: "boolean" },
          units: {
            type: "array",
            description: "Optional upsert of unit configurations (existing configs updated, missing ones created).",
            items: { $ref: "#/components/schemas/ProductUnitConfig" },
          },
        },
      },
      ProductUnit: {
        type: "object",
        description: "Product-specific configuration of a reusable master Unit.",
        properties: {
          id: { type: "string", format: "uuid" },
          productId: { type: "string", format: "uuid" },
          unitId: { type: "string", format: "uuid" },
          unit: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string", example: "Box" },
              symbol: { type: "string", nullable: true },
              isActive: { type: "boolean" },
            },
          },
          conversionFactor: { type: "number", example: 100 },
          sellPrice: { type: "number", nullable: true },
          purchasePrice: {
            type: "number",
            nullable: true,
            description: "Default/reference purchase price — not historical batch cost.",
          },
          isBaseUnit: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      ProductUnitCreateInput: {
        type: "object",
        properties: {
          unitId: { type: "string", format: "uuid", example: "box-master-unit-id" },
          conversionFactor: { type: "number", example: 100 },
          sellPrice: { type: "number" },
          purchasePrice: { type: "number", description: "Default/reference purchase price." },
          isBaseUnit: { type: "boolean", default: false },
        },
        required: ["unitId", "conversionFactor"],
      },
      ProductUnitUpdateInput: {
        type: "object",
        properties: {
          conversionFactor: { type: "number", description: "Base unit factor is fixed at 1." },
          sellPrice: { type: "number", nullable: true },
          purchasePrice: { type: "number", nullable: true },
        },
      },
      ProductUnitResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { $ref: "#/components/schemas/ProductUnit" },
        },
        example: {
          success: true,
          data: { id: "product-unit-uuid", productId: "product-uuid", unitId: "box-unit-uuid", conversionFactor: 100, sellPrice: 150, purchasePrice: 110, isBaseUnit: false },
        },
      },
      ProductUnitListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { $ref: "#/components/schemas/ProductUnit" } },
        },
        example: { success: true, data: [{ id: "product-unit-uuid", unitId: "box-unit-uuid", conversionFactor: 100, sellPrice: 150, purchasePrice: 110, isBaseUnit: false }] },
      },
      ConvertUnitsInput: {
        type: "object",
        properties: {
          quantity: { type: "number", example: 2 },
          fromUnitId: { type: "string", format: "uuid" },
          toUnitId: { type: "string", format: "uuid" },
        },
        required: ["quantity", "fromUnitId", "toUnitId"],
      },
      ConvertUnitsResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              originalQuantity: { type: "number", example: 2 },
              fromUnit: { type: "string", example: "Box" },
              toUnit: { type: "string", example: "Tablet" },
              convertedQuantity: { type: "number", example: 200 },
            },
          },
        },
        example: { success: true, data: { originalQuantity: 2, fromUnit: "Box", toUnit: "Tablet", convertedQuantity: 200 } },
      },
      ProductSummary: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          genericName: { type: "string", nullable: true },
          brand: { type: "string", nullable: true },
          sku: { type: "string" },
          isActive: { type: "boolean" },
        },
      },
      ProductListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { $ref: "#/components/schemas/ProductSummary" } },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: { success: true, data: [{ id: "product-uuid", name: "Paracetamol 500mg", genericName: "Paracetamol", brand: "Example", sku: "PCM-500", isActive: true }], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } },
      },
      ProductDetailResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              genericName: { type: "string", nullable: true },
              brand: { type: "string", nullable: true },
              sku: { type: "string" },
              description: { type: "string", nullable: true },
              minimumStock: { type: "number" },
              reorderPoint: { type: "number", nullable: true },
              isActive: { type: "boolean" },
              productGroupId: { type: "string", format: "uuid" },
              productGroup: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  isActive: { type: "boolean" },
                },
              },
              units: { type: "array", items: { $ref: "#/components/schemas/ProductUnit" } },
              stockSummary: {
                type: "object",
                properties: {
                  totalQuantity: { type: "number", description: "Always in base units" },
                  byLocation: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        locationId: { type: "string", format: "uuid" },
                        locationName: { type: "string" },
                        quantity: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        example: {
          success: true,
          data: {
            id: "product-uuid",
            name: "Paracetamol 500mg",
            genericName: "Paracetamol",
            brand: "Example",
            sku: "PCM-500",
            minimumStock: 100,
            reorderPoint: 200,
            isActive: true,
            units: [{ unitId: "tablet-unit-uuid", conversionFactor: 1, sellPrice: 2, isBaseUnit: true }],
            stockSummary: { totalQuantity: 1250, byLocation: [{ locationName: "Main Store", quantity: 1250 }] },
          },
        },
      },
      TransferItemCreateInput: {
        type: "object",
        description:
          "`quantity` is the user-entered quantity in `unitId`. `baseQuantity` is server-calculated (quantity x ProductUnit conversion factor at entry time) — do not supply it on create; responses expose the persisted normalized value.",
        properties: {
          productId: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          unitId: { type: "string", format: "uuid", example: "box-master-unit-id" },
          quantity: { type: "number", example: 2, description: "User-entered quantity in the selected unit" },
        },
        required: ["productId", "batchId", "unitId", "quantity"],
        example: {
          productId: "...",
          batchId: "...",
          unitId: "box-master-unit-id",
          quantity: 2,
        },
      },
      TransferItemUpdateInput: {
        type: "object",
        properties: {
          unitId: { type: "string", format: "uuid" },
          quantity: { type: "number" },
        },
      },
      TransferItem: {
        type: "object",
        description:
          "Transfer line item keeping BOTH the user entry (quantity + unitId) and the normalized base quantity used by the inventory engine.",
        properties: {
          id: { type: "string", format: "uuid" },
          transferId: { type: "string", format: "uuid" },
          productId: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          unitId: { type: "string", format: "uuid" },
          quantity: { type: "number", example: 2, description: "User-entered quantity (audit)" },
          baseQuantity: { type: "number", example: 200, description: "Normalized quantity in the product's base unit, computed at entry time" },
          product: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              sku: { type: "string" },
            },
          },
          batch: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              batchNumber: { type: "string" },
              expiryDate: { type: "string", format: "date" },
            },
          },
          unit: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string", example: "Box" },
              symbol: { type: "string", nullable: true },
            },
          },
        },
        example: {
          id: "item-id",
          transferId: "transfer-id",
          productId: "...",
          batchId: "...",
          unitId: "box-master-unit-id",
          quantity: 2,
          baseQuantity: 200,
        },
      },
      TransferItemResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { $ref: "#/components/schemas/TransferItem" },
        },
        example: {
          success: true,
          data: { id: "transfer-item-uuid", transferId: "transfer-uuid", productId: "product-uuid", batchId: "batch-uuid", unitId: "box-unit-uuid", quantity: 5, baseQuantity: 500 },
        },
      },
      TransferCreateInput: {
        type: "object",
        properties: {
          fromLocationId: { type: "string", format: "uuid" },
          toLocationId: { type: "string", format: "uuid" },
          transferDate: { type: "string", format: "date-time" },
          reason: { type: "string" },
          items: { type: "array", items: { $ref: "#/components/schemas/TransferItemCreateInput" }, minItems: 1 },
        },
        required: ["fromLocationId", "toLocationId", "items"],
      },
      TransferUpdateInput: {
        type: "object",
        description: "Status is intentionally NOT accepted here.",
        properties: {
          fromLocationId: { type: "string", format: "uuid" },
          toLocationId: { type: "string", format: "uuid" },
          transferDate: { type: "string", format: "date-time" },
          reason: { type: "string", nullable: true },
        },
      },
      Transfer: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          fromLocationId: { type: "string", format: "uuid" },
          toLocationId: { type: "string", format: "uuid" },
          fromLocation: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, isActive: { type: "boolean" } } },
          toLocation: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, isActive: { type: "boolean" } } },
          transferDate: { type: "string", format: "date-time" },
          reason: { type: "string", nullable: true },
          status: { type: "string", enum: ["DRAFT", "PENDING", "COMPLETED", "CANCELLED"] },
          createdBy: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } },
          items: { type: "array", items: { $ref: "#/components/schemas/TransferItem" } },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      TransferResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { $ref: "#/components/schemas/Transfer" },
        },
        example: {
          success: true,
          data: { id: "transfer-uuid", fromLocationId: "main-store-uuid", toLocationId: "branch-uuid", transferDate: "2026-09-10T12:00:00.000Z", status: "DRAFT", reason: "Branch replenishment", items: [] },
        },
      },
      TransferListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { $ref: "#/components/schemas/Transfer" } },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: { success: true, data: [{ id: "transfer-uuid", fromLocationId: "main-store-uuid", toLocationId: "branch-uuid", status: "COMPLETED", items: [] }], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } },
      },
      OpeningStockInput: {
        type: "object",
        description: "`quantity` is in the unit identified by `unitId`; converted to base units server-side.",
        properties: {
          productId: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          locationId: { type: "string", format: "uuid" },
          quantity: { type: "number", example: 2 },
          unitId: { type: "string", format: "uuid", example: "box-master-unit-id" },
          notes: { type: "string" },
        },
        required: ["productId", "batchId", "locationId", "quantity", "unitId"],
      },
      StockAdjustmentInput: {
        type: "object",
        properties: {
          productId: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          locationId: { type: "string", format: "uuid" },
          direction: { type: "string", enum: ["IN", "OUT"] },
          quantity: { type: "number" },
          unitId: { type: "string", format: "uuid" },
          reason: { type: "string" },
        },
        required: ["productId", "batchId", "locationId", "direction", "quantity", "unitId", "reason"],
      },
      StockMovementResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              transaction: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  productId: { type: "string" },
                  batchId: { type: "string" },
                  locationId: { type: "string" },
                  transactionType: { type: "string" },
                  direction: { type: "string", enum: ["IN", "OUT"] },
                  quantity: { type: "number", description: "Always in base units" },
                  balanceAfter: { type: "number" },
                },
              },
              stock: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  quantity: { type: "number", description: "Always in base units" },
                },
              },
            },
          },
        },
        example: {
          success: true,
          data: {
            transaction: { id: "transaction-uuid", productId: "product-uuid", batchId: "batch-uuid", locationId: "location-uuid", transactionType: "OPENING_STOCK", direction: "IN", quantity: 2000, balanceAfter: 2000 },
            stock: { id: "stock-uuid", quantity: 2000 },
          },
        },
      },
      BinCardResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              openingBalance: { type: "number", example: 500, description: "Balance before the requested date range, in base units" },
              transactions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", format: "date-time", example: "2026-09-10T08:30:00.000Z" },
                    reference: { type: "string", nullable: true, example: "OPENING_STOCK:transaction-uuid" },
                    transactionType: { type: "string", example: "RECEIVING" },
                    direction: { type: "string", enum: ["IN", "OUT"], example: "IN" },
                    in: { type: "number", example: 2000 },
                    out: { type: "number", example: 0 },
                    balance: { type: "number", example: 2500 },
                    user: {
                      type: "object",
                      nullable: true,
                      properties: {
                        id: { type: "string", example: "user-uuid" },
                        name: { type: "string", example: "Ada Lovelace" },
                        email: { type: "string", format: "email", example: "ada@example.com" },
                      },
                    },
                  },
                },
              },
              closingBalance: { type: "number", example: 2500, description: "Balance after the requested date range, in base units" },
            },
          },
        },
        example: {
          success: true,
          data: {
            openingBalance: 500,
            transactions: [{ date: "2026-09-10T08:30:00.000Z", reference: "RECEIVING:transaction-uuid", transactionType: "RECEIVING", direction: "IN", in: 2000, out: 0, balance: 2500, user: { id: "user-uuid", name: "Ada Lovelace", email: "ada@example.com" } }],
            closingBalance: 2500,
          },
        },
      },
      StockListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                productId: { type: "string" },
                batchId: { type: "string" },
                locationId: { type: "string" },
                quantity: { type: "number", description: "Always in base units" },
                reservedQuantity: { type: "number" },
                product: { $ref: "#/components/schemas/ProductSummary" },
                batch: { type: "object", properties: { id: { type: "string" }, batchNumber: { type: "string" }, expiryDate: { type: "string" } } },
                location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: {
          success: true,
          data: [{ id: "stock-uuid", productId: "product-uuid", batchId: "batch-uuid", locationId: "location-uuid", quantity: 1000, reservedQuantity: 100, product: { id: "product-uuid", name: "Paracetamol 500mg", sku: "PCM-500" }, batch: { id: "batch-uuid", batchNumber: "PCM001", expiryDate: "2027-08-31" }, location: { id: "location-uuid", name: "Main Store" } }],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
      PaginationMeta: {
        type: "object",
        properties: {
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
      EmptySuccessResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { nullable: true },
        },
        example: { success: true, data: null },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string" },
              details: { type: "object", nullable: true },
            },
            required: ["code", "message"],
          },
        },
        example: { success: false, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: { field: "name", message: "Name is required" } } },
      },
      DashboardResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              metrics: {
                type: "object",
                properties: {
                  totalProducts: { type: "integer", example: 150 },
                  totalStock: { type: "number", example: 125000 },
                  lowStock: { type: "integer", example: 12 },
                  outOfStock: { type: "integer", example: 3 },
                  nearExpiry: { type: "integer", example: 8 },
                  expiredBatches: { type: "integer", example: 2 },
                  criticalExpiry: { type: "integer", example: 5 },
                },
              },
            },
          },
        },
        example: {
          success: true,
          data: { metrics: { totalProducts: 150, totalStock: 125000, lowStock: 12, outOfStock: 3, nearExpiry: 8, expiredBatches: 2, criticalExpiry: 5 } },
        },
      },
      InventoryProductListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
                genericName: { type: "string", nullable: true },
                brand: { type: "string", nullable: true },
                sku: { type: "string" },
                productGroup: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } }, nullable: true },
                isActive: { type: "boolean" },
                minimumStock: { type: "number" },
                reorderPoint: { type: "number", nullable: true },
                baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
                totalStock: { type: "number", description: "Total stock in base units" },
                selectedLocationStock: { type: "number", nullable: true, description: "Stock at selected location in base units" },
                nearestExpiry: {
                  type: "object",
                  properties: {
                    batchId: { type: "string", format: "uuid" },
                    batchNumber: { type: "string" },
                    expiryDate: { type: "string", format: "date" },
                    quantity: { type: "number" },
                  },
                  nullable: true,
                },
                stockStatus: { type: "string", enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"] },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      ProductDetailResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              genericName: { type: "string", nullable: true },
              brand: { type: "string", nullable: true },
              sku: { type: "string" },
              description: { type: "string", nullable: true },
              imageUrl: { type: "string", format: "uri", nullable: true },
              minimumStock: { type: "number" },
              reorderPoint: { type: "number", nullable: true },
              isActive: { type: "boolean" },
              productGroupId: { type: "string", format: "uuid" },
              productGroup: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  isActive: { type: "boolean" },
                },
              },
              baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
              units: { type: "array", items: { $ref: "#/components/schemas/ProductUnit" } },
              stockSummary: {
                type: "object",
                properties: {
                  totalQuantity: { type: "number", description: "Always in base units" },
                  baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
                  byLocation: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        locationId: { type: "string", format: "uuid" },
                        locationName: { type: "string" },
                        quantity: { type: "number" },
                      },
                    },
                  },
                },
              },
              batchCount: { type: "integer" },
              transactionCount: { type: "integer" },
              locationCount: { type: "integer" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
        example: {
          success: true,
          data: {
            id: "product-uuid",
            name: "Paracetamol 500mg",
            genericName: "Paracetamol",
            brand: "Example",
            sku: "PCM-500",
            minimumStock: 100,
            reorderPoint: 200,
            isActive: true,
            baseUnit: { id: "unit-uuid", name: "Tablet", symbol: "TAB" },
            units: [{ unitId: "tablet-unit-uuid", conversionFactor: 1, sellPrice: 2, isBaseUnit: true }],
            stockSummary: { totalQuantity: 1250, baseUnit: { id: "unit-uuid", name: "Tablet" }, byLocation: [{ locationName: "Main Store", quantity: 1250 }] },
            batchCount: 5,
            transactionCount: 23,
            locationCount: 2,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
          },
        },
      },
      StockListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                productId: { type: "string" },
                batchId: { type: "string" },
                locationId: { type: "string" },
                quantity: { type: "number", description: "Total quantity in base units" },
                reservedQuantity: { type: "number" },
                availableQuantity: { type: "number", description: "Quantity minus reserved" },
                stockStatus: { type: "string", enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"] },
                baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
                product: { $ref: "#/components/schemas/ProductSummary" },
                batch: { type: "object", properties: { id: { type: "string" }, batchNumber: { type: "string" }, expiryDate: { type: "string" } } },
                location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: {
          success: true,
          data: [{ id: "stock-uuid", productId: "product-uuid", batchId: "batch-uuid", locationId: "location-uuid", quantity: 1000, reservedQuantity: 100, availableQuantity: 900, stockStatus: "IN_STOCK", baseUnit: { id: "unit-uuid", name: "Tablet", symbol: "TAB" }, product: { id: "product-uuid", name: "Paracetamol 500mg", sku: "PCM-500" }, batch: { id: "batch-uuid", batchNumber: "PCM001", expiryDate: "2027-08-31" }, location: { id: "location-uuid", name: "Main Store" } }],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
      BatchListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                productId: { type: "string", format: "uuid" },
                batchNumber: { type: "string" },
                manufacturingDate: { type: "string", format: "date", nullable: true },
                receivedDate: { type: "string", format: "date", nullable: true },
                expiryDate: { type: "string", format: "date" },
                purchaseCost: { type: "number", nullable: true },
                supplierReference: { type: "string", nullable: true },
                totalQuantity: { type: "number", description: "Total stock in base units" },
                status: { type: "string", enum: ["AVAILABLE", "LOW_STOCK", "DEPLETED", "EXPIRED"] },
                daysUntilExpiry: { type: "integer", description: "Negative if expired" },
                product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string" } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      BatchDetailResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              productId: { type: "string", format: "uuid" },
              batchNumber: { type: "string" },
              manufacturingDate: { type: "string", format: "date", nullable: true },
              receivedDate: { type: "string", format: "date", nullable: true },
              expiryDate: { type: "string", format: "date" },
              purchaseCost: { type: "number", nullable: true },
              supplierReference: { type: "string", nullable: true },
              totalQuantity: { type: "number", description: "Total stock in base units" },
              locationStock: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    locationId: { type: "string", format: "uuid" },
                    locationName: { type: "string" },
                    quantity: { type: "number" },
                  },
                },
              },
              status: { type: "string", enum: ["AVAILABLE", "LOW_STOCK", "DEPLETED", "EXPIRED"] },
              daysUntilExpiry: { type: "integer" },
              product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string" } } },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      StockTransactionListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                transactionType: { type: "string", example: "OPENING" },
                direction: { type: "string", enum: ["IN", "OUT"] },
                quantity: { type: "number", description: "Always in base units" },
                balanceAfter: { type: "number" },
                referenceType: { type: "string", nullable: true },
                referenceId: { type: "string", nullable: true },
                notes: { type: "string", nullable: true },
                createdAt: { type: "string", format: "date-time" },
                product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" } } },
                batch: { type: "object", properties: { id: { type: "string" }, batchNumber: { type: "string" }, expiryDate: { type: "string" } } },
                location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
                baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
                createdBy: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      BinCardResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true },
              openingBalance: { type: "number", example: 500, description: "Balance before the requested date range, in base units" },
              transactions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    transactionId: { type: "string", format: "uuid" },
                    date: { type: "string", format: "date-time" },
                    reference: { type: "string", nullable: true },
                    transactionType: { type: "string" },
                    direction: { type: "string", enum: ["IN", "OUT"] },
                    in: { type: "number" },
                    out: { type: "number" },
                    balance: { type: "number" },
                    notes: { type: "string", nullable: true },
                    batch: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        batchNumber: { type: "string" },
                        expiryDate: { type: "string", format: "date" },
                      },
                      nullable: true,
                    },
                    costPrice: { type: "number", nullable: true },
                    user: {
                      type: "object",
                      nullable: true,
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        email: { type: "string", format: "email" },
                      },
                    },
                  },
                },
              },
              closingBalance: { type: "number" },
            },
          },
        },
        example: {
          success: true,
          data: {
            baseUnit: { id: "unit-uuid", name: "Tablet", symbol: "TAB" },
            openingBalance: 500,
            transactions: [{ transactionId: "tx-uuid", date: "2026-09-10T08:30:00.000Z", reference: "RECEIVING:tx-uuid", transactionType: "RECEIVING", direction: "IN", in: 2000, out: 0, balance: 2500, notes: "Opening stock", batch: { id: "batch-uuid", batchNumber: "PCM001", expiryDate: "2027-08-31" }, costPrice: 1.10, user: { id: "user-uuid", name: "Ada Lovelace", email: "ada@example.com" } }],
            closingBalance: 2500,
          },
        },
      },
      LocationStockResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, genericName: { type: "string" }, brand: { type: "string" }, sku: { type: "string" }, productGroup: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } },
                locations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      locationId: { type: "string", format: "uuid" },
                      locationName: { type: "string" },
                      quantity: { type: "number" },
                    },
                  },
                },
                totalQuantity: { type: "number" },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      ExpiryDashboardResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              windows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    daysFrom: { type: "integer" },
                    daysTo: { type: "integer" },
                    batchCount: { type: "integer" },
                    totalQuantity: { type: "number" },
                    batches: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          batchNumber: { type: "string" },
                          expiryDate: { type: "string", format: "date" },
                          daysRemaining: { type: "integer" },
                          purchaseCost: { type: "number", nullable: true },
                          status: { type: "string", enum: ["EXPIRED", "CRITICAL", "EXPIRING_SOON", "WARNING", "NORMAL"] },
                          product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string", nullable: true } } },
                          stock: { type: "object", properties: { quantity: { type: "number" }, location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, nullable: true } } },
                        },
                      },
                    },
                  },
                },
              },
              summary: {
                type: "object",
                properties: {
                  expired: { type: "integer" },
                  critical: { type: "integer" },
                  expiringSoon: { type: "integer" },
                  warning: { type: "integer" },
                  normal: { type: "integer" },
                  totalBatches: { type: "integer" },
                  totalQuantity: { type: "number" },
                },
              },
            },
          },
        },
      },
      ExpiryBatchListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                batchNumber: { type: "string" },
                expiryDate: { type: "string", format: "date" },
                daysRemaining: { type: "integer" },
                purchaseCost: { type: "number", nullable: true },
                status: { type: "string", enum: ["EXPIRED", "CRITICAL", "EXPIRING_SOON", "WARNING", "NORMAL"] },
                product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string", nullable: true } } },
                stock: { type: "object", properties: { quantity: { type: "number" }, location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, nullable: true } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      ExpiryActionListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                batchId: { type: "string", format: "uuid" },
                actionType: { type: "string", enum: ["RETURN_TO_SUPPLIER", "CLEARANCE_SALE", "DISPOSE"] },
                quantity: { type: "number", nullable: true },
                locationId: { type: "string", format: "uuid", nullable: true },
                supplierId: { type: "string", format: "uuid", nullable: true },
                discountPercent: { type: "number", nullable: true },
                reason: { type: "string", nullable: true },
                notes: { type: "string", nullable: true },
                performedById: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
                batch: { type: "object", properties: { id: { type: "string" }, batchNumber: { type: "string" }, productId: { type: "string" }, expiryDate: { type: "string" } } },
                location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, nullable: true },
                performedBy: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      ExpiryActionResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              action: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  batchId: { type: "string", format: "uuid" },
                  actionType: { type: "string", enum: ["RETURN_TO_SUPPLIER", "CLEARANCE_SALE", "DISPOSE"] },
                  quantity: { type: "number", nullable: true },
                  locationId: { type: "string", format: "uuid", nullable: true },
                  supplierId: { type: "string", format: "uuid", nullable: true },
                  discountPercent: { type: "number", nullable: true },
                  reason: { type: "string", nullable: true },
                  notes: { type: "string", nullable: true },
                  performedById: { type: "string" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
              stockMovement: {
                type: "object",
                nullable: true,
                properties: {
                  id: { type: "string", format: "uuid" },
                  transactionType: { type: "string" },
                  direction: { type: "string", enum: ["IN", "OUT"] },
                  quantity: { type: "number" },
                  balanceAfter: { type: "number" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
              remainingStock: { type: "number", nullable: true, description: "Remaining stock at location after action (for DISPOSE/RETURN_TO_SUPPLIER)" },
            },
          },
        },
      },
      ReorderConfigResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              productId: { type: "string", format: "uuid" },
              minimumStockLevel: { type: "number" },
              reorderPoint: { type: "number" },
              leadTimeDays: { type: "integer" },
              reorderQuantity: { type: "number" },
              useSalesVelocity: { type: "boolean" },
              bufferPercentage: { type: "number" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
              product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true } } },
            },
          },
        },
      },
      ReorderDashboardResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string", nullable: true }, baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true } } },
                    currentStock: { type: "number" },
                    minimumThreshold: { type: "number" },
                    reorderPoint: { type: "number" },
                    suggestedQuantity: { type: "number" },
                    urgency: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
                    leadTimeDays: { type: "integer" },
                    useSalesVelocity: { type: "boolean" },
                    hasSalesData: { type: "boolean" },
                  },
                },
              },
              summary: {
                type: "object",
                properties: {
                  critical: { type: "integer" },
                  high: { type: "integer" },
                  medium: { type: "integer" },
                  low: { type: "integer" },
                  totalItems: { type: "integer" },
                  totalSuggestedQuantity: { type: "number" },
                },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      ReorderSuggestionsResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, brand: { type: "string", nullable: true }, baseUnit: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, symbol: { type: "string", nullable: true } }, nullable: true } } },
                currentStock: { type: "number" },
                reorderPoint: { type: "number" },
                minimumStockLevel: { type: "number" },
                suggestedQuantity: { type: "number" },
                calculationMethod: { type: "string", enum: ["CONFIGURED", "SALES_VELOCITY"] },
                leadTimeDays: { type: "integer" },
                averageDailySales: { type: "number", nullable: true },
                bufferQuantity: { type: "number" },
                hasSalesData: { type: "boolean" },
              },
            },
          },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      PurchaseRequirementsResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              requirements: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    productId: { type: "string", format: "uuid" },
                    productName: { type: "string" },
                    productSku: { type: "string" },
                    suggestedQuantity: { type: "number" },
                    calculationMethod: { type: "string", enum: ["CONFIGURED", "SALES_VELOCITY"] },
                    currentStock: { type: "number" },
                    reorderPoint: { type: "number" },
                    leadTimeDays: { type: "integer" },
                    status: { type: "string", example: "DRAFT" },
                  },
                },
              },
              generatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      UnitListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { $ref: "#/components/schemas/Unit" } },
          meta: { $ref: "#/components/schemas/PaginationMeta" },
        },
        example: {
          success: true,
          data: [{ id: "unit-uuid", name: "Box", symbol: "BX", description: null, isActive: true, productCount: 5, createdAt: "2026-09-10T12:00:00.000Z", updatedAt: "2026-09-10T12:00:00.000Z" }],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
    },
  },
  security: [{ sessionCookie: [] }],
} as const;


