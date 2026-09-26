const fs = require('fs');
const content = fs.readFileSync('src/docs/openapi.ts', 'utf-8');

const newPaths = `
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Live check",
        responses: { "200": { description: "OK" } }
      }
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness check",
        responses: { "200": { description: "OK" } }
      }
    },
    "/audit": {
      get: {
        tags: ["Audit"],
        summary: "Get audit trail",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "userId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "entity", in: "query", schema: { type: "string" } },
          { name: "entityId", in: "query", schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Audit trail", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/audit/entity/{entity}/{entityId}": {
      get: {
        tags: ["Audit"],
        summary: "Get audit trail for entity",
        parameters: [
          { name: "entity", in: "path", required: true, schema: { type: "string" } },
          { name: "entityId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Audit trail", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/audit/user/{userId}": {
      get: {
        tags: ["Audit"],
        summary: "Get audit trail for user",
        parameters: [
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Audit trail", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/notifications/read-all": {
      patch: {
        tags: ["Notifications"],
        summary: "Mark all notifications as read",
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/suppliers": {
      get: {
        tags: ["Purchasing"],
        summary: "List suppliers",
        responses: { "200": { description: "Suppliers list", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      },
      post: {
        tags: ["Purchasing"],
        summary: "Create supplier",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/suppliers/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get supplier",
        parameters: [idPathParam],
        responses: { "200": { description: "Supplier data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      patch: {
        tags: ["Purchasing"],
        summary: "Update supplier",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete supplier",
        parameters: [idPathParam],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/suppliers/{supplierId}/products": {
      get: {
        tags: ["Purchasing"],
        summary: "List products for supplier",
        parameters: [
          { name: "supplierId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "List of products", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/suppliers/{supplierId}/products/{productId}/batches": {
      get: {
        tags: ["Purchasing"],
        summary: "List batches for supplier product",
        parameters: [
          { name: "supplierId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "productId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "List of batches", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/suppliers/{supplierId}/received-products": {
      get: {
        tags: ["Purchasing"],
        summary: "List received products for supplier",
        parameters: [
          { name: "supplierId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "List of received products", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements": {
      get: {
        tags: ["Purchasing"],
        summary: "List purchase requirements",
        responses: { "200": { description: "Requirements list", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      },
      post: {
        tags: ["Purchasing"],
        summary: "Create purchase requirement",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/generate-from-reorder": {
      post: {
        tags: ["Purchasing"],
        summary: "Generate purchase requirements from reorder suggestions",
        responses: { "200": { description: "Generated requirements", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/lines": {
      get: {
        tags: ["Purchasing"],
        summary: "Get requirement lines",
        responses: { "200": { description: "Requirement lines list", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get requirement",
        parameters: [idPathParam],
        responses: { "200": { description: "Requirement data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      patch: {
        tags: ["Purchasing"],
        summary: "Update requirement",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete requirement",
        parameters: [idPathParam],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/{id}/close": {
      post: {
        tags: ["Purchasing"],
        summary: "Close requirement",
        parameters: [idPathParam],
        responses: { "200": { description: "Closed", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/{id}/lines": {
      post: {
        tags: ["Purchasing"],
        summary: "Add requirement line",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/lines/{lineId}": {
      patch: {
        tags: ["Purchasing"],
        summary: "Update requirement line",
        parameters: [
          { name: "lineId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete requirement line",
        parameters: [
          { name: "lineId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/requirements/lines/{lineId}/order-preview": {
      get: {
        tags: ["Purchasing"],
        summary: "Get order preview for line",
        parameters: [
          { name: "lineId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Preview data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders": {
      get: {
        tags: ["Purchasing"],
        summary: "List purchase orders",
        responses: { "200": { description: "List of orders", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      },
      post: {
        tags: ["Purchasing"],
        summary: "Create purchase order",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/from-requirement": {
      post: {
        tags: ["Purchasing"],
        summary: "Create PO from requirement",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/items/{itemId}": {
      patch: {
        tags: ["Purchasing"],
        summary: "Update PO item",
        parameters: [
          { name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete PO item",
        parameters: [
          { name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get purchase order",
        parameters: [idPathParam],
        responses: { "200": { description: "PO data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      patch: {
        tags: ["Purchasing"],
        summary: "Update purchase order",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}/cancel": {
      post: {
        tags: ["Purchasing"],
        summary: "Cancel PO",
        parameters: [idPathParam],
        responses: { "200": { description: "Canceled", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/items/{itemId}/accept-shortage": {
      post: {
        tags: ["Purchasing"],
        summary: "Accept shortage for PO item",
        parameters: [
          { name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: { "200": { description: "Accepted shortage", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}/close": {
      post: {
        tags: ["Purchasing"],
        summary: "Close PO",
        parameters: [idPathParam],
        responses: { "200": { description: "Closed", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/goods-receipts": {
      get: {
        tags: ["Purchasing"],
        summary: "List goods receipts",
        responses: { "200": { description: "List of goods receipts", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}/goods-receipts": {
      post: {
        tags: ["Purchasing"],
        summary: "Create goods receipt for PO",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/goods-receipts/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get goods receipt",
        parameters: [idPathParam],
        responses: { "200": { description: "Goods receipt data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete goods receipt",
        parameters: [idPathParam],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/goods-receipts/{id}/resolve": {
      patch: {
        tags: ["Purchasing"],
        summary: "Resolve goods receipt",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Resolved", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/goods-receipts/{id}/confirm": {
      post: {
        tags: ["Purchasing"],
        summary: "Confirm goods receipt",
        parameters: [idPathParam],
        responses: { "200": { description: "Confirmed", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}/invoice-upload": {
      post: {
        tags: ["Purchasing"],
        summary: "Upload invoice for PO",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Preview data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-orders/{id}/invoice-upload/confirm": {
      post: {
        tags: ["Purchasing"],
        summary: "Confirm uploaded invoice",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Confirmed", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/supplier-invoices": {
      get: {
        tags: ["Purchasing"],
        summary: "List supplier invoices",
        responses: { "200": { description: "List of supplier invoices", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      },
      post: {
        tags: ["Purchasing"],
        summary: "Create supplier invoice",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/supplier-invoices/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get supplier invoice",
        parameters: [idPathParam],
        responses: { "200": { description: "Supplier invoice data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      patch: {
        tags: ["Purchasing"],
        summary: "Update supplier invoice",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete supplier invoice",
        parameters: [idPathParam],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/supplier-invoices/{id}/payments": {
      post: {
        tags: ["Purchasing"],
        summary: "Record payment for supplier invoice",
        parameters: [idPathParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Payment recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-returns": {
      get: {
        tags: ["Purchasing"],
        summary: "List purchase returns",
        responses: { "200": { description: "List of purchase returns", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericListResponse" } } } }, ...authErrorResponses }
      },
      post: {
        tags: ["Purchasing"],
        summary: "Create purchase return",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    },
    "/purchasing/purchase-returns/{id}": {
      get: {
        tags: ["Purchasing"],
        summary: "Get purchase return",
        parameters: [idPathParam],
        responses: { "200": { description: "Purchase return data", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      },
      delete: {
        tags: ["Purchasing"],
        summary: "Delete purchase return",
        parameters: [idPathParam],
        responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/GenericDataResponse" } } } }, ...authErrorResponses }
      }
    }`;

const insertIndex = content.lastIndexOf('  },', content.indexOf('components: {'));
if (insertIndex !== -1) {
  const updatedContent = content.slice(0, insertIndex) + ',' + newPaths + content.slice(insertIndex);
  fs.writeFileSync('src/docs/openapi.ts', updatedContent, 'utf-8');
  console.log('Successfully appended paths.');
} else {
  console.log('Failed to find insert location.');
}
