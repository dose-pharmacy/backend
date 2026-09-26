const fs = require('fs');
let c = fs.readFileSync('src/docs/openapi.ts', 'utf-8');

// ─── STEP 1: Remove the bad JSON-dumped schemas that were injected ────────────
// The gen-schemas script injected JSON at the start of the schemas: { block.
// We need to find the schemas: { marker and then cut everything up to the first
// "real" schema that existed before (AuthSignUpInput).
const schemasMarker = 'schemas: {\n';
const firstGoodSchema = '      AuthSignUpInput: {';
const schemasStart = c.indexOf(schemasMarker);
const goodSchemasStart = c.indexOf(firstGoodSchema);
if (schemasStart !== -1 && goodSchemasStart !== -1 && goodSchemasStart > schemasStart) {
  // Replace the injected JSON block with nothing
  c = c.slice(0, schemasStart + schemasMarker.length) + c.slice(goodSchemasStart);
  console.log('✓ Stripped bad injected JSON schemas');
}

// ─── STEP 2: Fix the trailing brace mismatch at end of file ──────────────────
// After removing the injected block, the file should end correctly.
// Let's verify by finding the last few lines. 
// The existing schemas section already has the correct closing:
//   },          <- closes schemas
// },            <- closes components
// security: ...
// So we just need to make sure there are no extra closing braces.

// Find UpdateNotificationSettingsInput (last real schema) and clean up after it.
const lastSchemaEnd = c.lastIndexOf('      },\n') + '      },\n'.length;
// Find security: after the last schema
const securityIdx = c.indexOf('  security: [', lastSchemaEnd - 200);
if (securityIdx !== -1) {
  // Extract the bit between last schema closing and security
  const between = c.slice(lastSchemaEnd, securityIdx);
  // Should be:
  //     },   <- closes schemas
  //   },     <- closes components
  // If there are more or fewer braces, replace:
  c = c.slice(0, lastSchemaEnd) + '    },\n  },\n  ' + c.slice(securityIdx + '  security: ['.length);
  c = c.replace('  security: [', 'x_placeholder');
  c = c.replace('x_placeholder', '  security: [');
  console.log('✓ Fixed trailing brace structure');
}

// ─── STEP 3: Fix the purchasing paths to use proper $refs ────────────────────
// The appended paths used `schema: { type: "object" }` as placeholder bodies.
// Replace these with proper $ref schemas referencing the new components.

const bodyReplacements = [
  ['"/purchasing/suppliers"', 'post', 'SupplierCreateInput'],
  ['"/purchasing/suppliers/{id}"', 'patch', 'SupplierUpdateInput'],
  ['"/purchasing/requirements"', 'post', 'RequirementCreateInput'],
  ['"/purchasing/requirements/{id}"', 'patch', 'RequirementUpdateInput'],
  ['"/purchasing/requirements/{id}/lines"', 'post', 'RequirementLineAddInput'],
  ['"/purchasing/requirements/lines/{lineId}"', 'patch', 'RequirementLineUpdateInput'],
  ['"/purchasing/purchase-orders"', 'post', 'PurchaseOrderCreateInput'],
  ['"/purchasing/purchase-orders/from-requirement"', 'post', 'PurchaseOrderFromRequirementInput'],
  ['"/purchasing/purchase-orders/{id}"', 'patch', 'PurchaseOrderUpdateInput'],
  ['"/purchasing/purchase-orders/items/{itemId}"', 'patch', 'PurchaseOrderItemUpdateInput'],
  ['"/purchasing/purchase-orders/{id}/goods-receipts"', 'post', 'GoodsReceiptCreateInput'],
  ['"/purchasing/goods-receipts/{id}/resolve"', 'patch', 'GoodsReceiptResolveInput'],
  ['"/purchasing/supplier-invoices"', 'post', 'SupplierInvoiceCreateInput'],
  ['"/purchasing/supplier-invoices/{id}"', 'patch', 'SupplierInvoiceUpdateInput'],
  ['"/purchasing/supplier-invoices/{id}/payments"', 'post', 'SupplierInvoicePaymentInput'],
  ['"/purchasing/purchase-returns"', 'post', 'PurchaseReturnCreateInput'],
  ['"/purchasing/purchase-orders/{id}/invoice-upload"', 'post', 'InvoiceUploadInput'],
  ['"/purchasing/purchase-orders/{id}/invoice-upload/confirm"', 'post', 'InvoiceUploadInput'],
  ['"/purchasing/purchase-orders/items/{itemId}/accept-shortage"', 'post', 'AcceptShortageInput'],
];

for (const [pathKey, method, schemaRef] of bodyReplacements) {
  // Find the path block, then within it find the method, then replace { type: "object" }
  const pathIdx = c.indexOf(pathKey + ':');
  if (pathIdx === -1) { console.log('  ! Path not found:', pathKey); continue; }
  // Find the next path key to limit our search scope
  const nextPathIdx = c.indexOf('\n    "/', pathIdx + 1);
  const scopeEnd = nextPathIdx !== -1 ? nextPathIdx : pathIdx + 5000;
  const scope = c.slice(pathIdx, scopeEnd);
  
  const methodIdx = scope.indexOf(method + ': {');
  if (methodIdx === -1) { console.log('  ! Method not found:', method, 'in', pathKey); continue; }
  const methodScope = scope.slice(methodIdx);
  
  const placeholder = 'schema: { type: "object" }';
  if (methodScope.includes(placeholder)) {
    const replacement = `schema: { $ref: "#/components/schemas/${schemaRef}" }`;
    const newMethodScope = methodScope.replace(placeholder, replacement);
    const newScope = scope.slice(0, methodIdx) + newMethodScope;
    c = c.slice(0, pathIdx) + newScope + c.slice(pathIdx + scope.length);
    console.log('  ✓ Replaced body for', pathKey, method);
  }
}

// ─── STEP 4: Inject proper TypeScript schemas at end of components.schemas ────
const newSchemas = `
      // ── Purchasing Schemas ────────────────────────────────────────────────
      SupplierCreateInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, example: "ABC Pharma Ltd" },
          contactPerson: { type: "string", maxLength: 200, example: "John Doe" },
          email: { type: "string", format: "email", maxLength: 200, example: "john@abcpharma.com" },
          phone: { type: "string", maxLength: 50, example: "+251911000000" },
          address: { type: "string", maxLength: 500, example: "Addis Ababa, Ethiopia" },
          paymentTerms: { type: "string", maxLength: 500, example: "Net 30 days" },
          isActive: { type: "boolean", default: true },
        },
      },
      SupplierUpdateInput: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          contactPerson: { type: "string", maxLength: 200 },
          email: { type: "string", format: "email", maxLength: 200 },
          phone: { type: "string", maxLength: 50 },
          address: { type: "string", maxLength: 500 },
          paymentTerms: { type: "string", maxLength: 500 },
          isActive: { type: "boolean" },
        },
      },
      RequirementLineInput: {
        type: "object",
        required: ["productId", "quantityNeeded"],
        properties: {
          productId: { type: "string", format: "uuid" },
          unitId: { type: "string", format: "uuid", description: "Omit to use the product's base unit" },
          quantityNeeded: { type: "number", minimum: 0.001, example: 100 },
          reasonCode: { type: "string", enum: ["LOW_STOCK", "REORDER_ALERT", "MANUAL"] },
          notes: { type: "string", maxLength: 500 },
        },
      },
      RequirementCreateInput: {
        type: "object",
        required: ["lines"],
        properties: {
          requiredBy: { type: "string", format: "date-time", description: "When the stock is needed by" },
          notes: { type: "string", maxLength: 1000 },
          lines: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/RequirementLineInput" } },
        },
      },
      RequirementUpdateInput: {
        type: "object",
        properties: {
          requiredBy: { type: "string", format: "date-time", nullable: true },
          notes: { type: "string", maxLength: 1000, nullable: true },
          lines: {
            type: "array",
            items: {
              type: "object",
              required: ["productId", "quantityNeeded"],
              properties: {
                productId: { type: "string", format: "uuid" },
                quantityNeeded: { type: "number", minimum: 0.001 },
                unitId: { type: "string", format: "uuid" },
                reasonCode: { type: "string", enum: ["LOW_STOCK", "REORDER_ALERT", "MANUAL"] },
                notes: { type: "string", maxLength: 500, nullable: true },
              },
            },
          },
        },
      },
      RequirementLineAddInput: { $ref: "#/components/schemas/RequirementLineInput" },
      RequirementLineUpdateInput: {
        type: "object",
        properties: {
          quantityNeeded: { type: "number", minimum: 0.001 },
          unitId: { type: "string", format: "uuid" },
          reasonCode: { type: "string", enum: ["LOW_STOCK", "REORDER_ALERT", "MANUAL"] },
          notes: { type: "string", maxLength: 500, nullable: true },
        },
      },
      PurchaseOrderItemInput: {
        type: "object",
        required: ["productId", "quantityOrdered", "unitCost"],
        properties: {
          productId: { type: "string", format: "uuid" },
          unitId: { type: "string", format: "uuid", description: "Omit to use the product's base unit" },
          quantityOrdered: { type: "number", minimum: 0.001, example: 200 },
          unitCost: { type: "number", minimum: 0.01, example: 45.50, description: "Cost per unit (max 2 decimal places)" },
          requirementLineId: { type: "string", format: "uuid", description: "Link to a requirement line" },
        },
      },
      PurchaseOrderCreateInput: {
        type: "object",
        required: ["supplierId", "items"],
        properties: {
          supplierId: { type: "string", format: "uuid" },
          expectedDeliveryDate: { type: "string", format: "date-time" },
          notes: { type: "string", maxLength: 1000 },
          items: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/PurchaseOrderItemInput" } },
        },
      },
      PurchaseOrderFromRequirementItemInput: {
        type: "object",
        required: ["requirementLineId", "quantityOrdered", "unitCost"],
        properties: {
          requirementLineId: { type: "string", format: "uuid" },
          quantityOrdered: { type: "number", minimum: 0.001 },
          unitCost: { type: "number", minimum: 0.01 },
        },
      },
      PurchaseOrderFromRequirementInput: {
        type: "object",
        required: ["supplierId", "items"],
        properties: {
          supplierId: { type: "string", format: "uuid" },
          expectedDeliveryDate: { type: "string", format: "date-time" },
          notes: { type: "string", maxLength: 1000 },
          items: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/PurchaseOrderFromRequirementItemInput" } },
        },
      },
      PurchaseOrderUpdateInput: {
        type: "object",
        properties: {
          expectedDeliveryDate: { type: "string", format: "date-time", nullable: true },
          notes: { type: "string", maxLength: 1000, nullable: true },
        },
      },
      PurchaseOrderItemUpdateInput: {
        type: "object",
        description: "At least one field required",
        properties: {
          quantityOrdered: { type: "number", minimum: 0.001 },
          unitCost: { type: "number", minimum: 0.01 },
        },
      },
      AcceptShortageInput: {
        type: "object",
        description: "At least one field required",
        properties: {
          quantityShort: { type: "number", minimum: 0.001, description: "Defaults to full remaining quantity if omitted" },
          shortReason: { type: "string", maxLength: 500, nullable: true },
        },
      },
      GoodsReceiptItemInput: {
        type: "object",
        required: ["purchaseOrderItemId", "locationId", "deliveredQty", "actualQty"],
        properties: {
          purchaseOrderItemId: { type: "string", format: "uuid" },
          locationId: { type: "string", format: "uuid" },
          deliveredQty: { type: "number", minimum: 0.001, description: "Quantity on delivery note" },
          actualQty: { type: "number", minimum: 0.001, description: "Quantity physically received" },
          batchNumber: { type: "string", maxLength: 100 },
          manufacturingDate: { type: "string", format: "date-time" },
          expiryDate: { type: "string", format: "date-time" },
        },
      },
      GoodsReceiptCreateInput: {
        type: "object",
        required: ["items"],
        properties: {
          receivedDate: { type: "string", format: "date-time" },
          discrepancyNote: { type: "string", maxLength: 1000 },
          items: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/GoodsReceiptItemInput" } },
        },
      },
      GoodsReceiptResolveItemInput: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
          deliveredQty: { type: "number", minimum: 0.001 },
          actualQty: { type: "number", minimum: 0.001 },
          batchNumber: { type: "string", maxLength: 100, nullable: true },
          manufacturingDate: { type: "string", format: "date-time", nullable: true },
          expiryDate: { type: "string", format: "date-time", nullable: true },
        },
      },
      GoodsReceiptResolveInput: {
        type: "object",
        properties: {
          discrepancyNote: { type: "string", maxLength: 1000 },
          items: { type: "array", items: { $ref: "#/components/schemas/GoodsReceiptResolveItemInput" } },
        },
      },
      SupplierInvoiceItemInput: {
        type: "object",
        required: ["purchaseOrderItemId", "quantity"],
        properties: {
          purchaseOrderItemId: { type: "string", format: "uuid" },
          quantity: { type: "number", minimum: 0.001, description: "Quantity invoiced in the PO item's ordered unit" },
          unitCost: { type: "number", minimum: 0.01, description: "Optional per-item cost override; defaults to PO item unitCost" },
        },
      },
      SupplierInvoiceCreateInput: {
        type: "object",
        required: ["invoiceNumber", "supplierId"],
        properties: {
          invoiceNumber: { type: "string", minLength: 1, maxLength: 100, example: "INV-2026-001" },
          supplierId: { type: "string", format: "uuid" },
          purchaseOrderId: { type: "string", format: "uuid", description: "Link to a PO — if provided, items is required" },
          invoiceDate: { type: "string", format: "date-time" },
          dueDate: { type: "string", format: "date-time", description: "Required when paymentTerms=CREDIT" },
          goodsAmount: { type: "number", minimum: 0, description: "Required for non-PO invoices" },
          taxAmount: { type: "number", minimum: 0 },
          additionalChargesAmount: { type: "number", minimum: 0 },
          discountAmount: { type: "number", minimum: 0 },
          paymentTerms: { type: "string", enum: ["CREDIT", "NO_CREDIT"] },
          paymentMethod: { type: "string", enum: ["CASH", "CARD", "DIGITAL_TRANSFER"] },
          items: { type: "array", items: { $ref: "#/components/schemas/SupplierInvoiceItemInput" }, description: "Required for PO-linked invoices" },
        },
      },
      SupplierInvoiceUpdateInput: {
        type: "object",
        properties: {
          dueDate: { type: "string", format: "date-time", nullable: true },
          paymentTerms: { type: "string", enum: ["CREDIT", "NO_CREDIT"], nullable: true },
          paymentMethod: { type: "string", enum: ["CASH", "CARD", "DIGITAL_TRANSFER"], nullable: true },
        },
      },
      SupplierInvoicePaymentInput: {
        type: "object",
        required: ["amount"],
        properties: {
          amount: { type: "number", minimum: 0.01, example: 5000.00 },
          paymentDate: { type: "string", format: "date-time" },
          notes: { type: "string", maxLength: 500 },
        },
      },
      PurchaseReturnCreateInput: {
        type: "object",
        required: ["supplierId", "productId", "locationId", "reason", "quantity", "unitCost"],
        properties: {
          supplierId: { type: "string", format: "uuid" },
          productId: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          locationId: { type: "string", format: "uuid" },
          reason: { type: "string", enum: ["EXPIRED", "DAMAGED", "INCORRECT_DELIVERY"] },
          quantity: { type: "number", minimum: 0.001 },
          unitId: { type: "string", format: "uuid" },
          unitCost: { type: "number", minimum: 0.01 },
          debitNoteAmount: { type: "number", minimum: 0 },
          notes: { type: "string", maxLength: 1000 },
        },
      },
      InvoiceUploadInput: {
        type: "object",
        description: "Extracted invoice data from uploaded document",
        properties: {
          invoiceNumber: { type: "string" },
          supplierName: { type: "string" },
          invoiceDate: { type: "string", format: "date-time" },
          dueDate: { type: "string", format: "date-time" },
          totalAmount: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                purchaseOrderItemId: { type: "string", format: "uuid" },
                quantity: { type: "number" },
                unitCost: { type: "number" },
              },
            },
          },
        },
      },
      // ── Notification Schemas ─────────────────────────────────────────────
      NotificationSettingsUpdateInput: {
        type: "object",
        description: "All fields are optional — only provided fields are updated",
        properties: {
          paymentRemindersEnabled: { type: "boolean", description: "Enable/disable payment reminder notifications" },
          remindBeforeDueDays: { type: "integer", minimum: 1, description: "Days before due date to send reminder" },
          remindOnDueDate: { type: "boolean" },
          remindWhenOverdue: { type: "boolean" },
          expiryAlertsEnabled: { type: "boolean", description: "Enable/disable expiry alert notifications" },
          alertWithin6Months: { type: "boolean" },
          alertWithin1Year: { type: "boolean" },
        },
        example: {
          paymentRemindersEnabled: true,
          remindBeforeDueDays: 3,
          expiryAlertsEnabled: true,
          alertWithin6Months: true,
        },
      },
      NotificationSettingsResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          paymentRemindersEnabled: { type: "boolean" },
          remindBeforeDueDays: { type: "integer" },
          remindOnDueDate: { type: "boolean" },
          remindWhenOverdue: { type: "boolean" },
          expiryAlertsEnabled: { type: "boolean" },
          alertWithin6Months: { type: "boolean" },
          alertWithin1Year: { type: "boolean" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
`;

// Find the right place to insert: just before the closing of schemas: { ... }
// We look for the LAST occurrence of "      }," followed by two closing lines
// The structure we want at the end is:
//    [our new schemas]
//      },   <- last old schema
//    },     <- closes schemas:
//  },       <- closes components:
//  security: ...

// Find the existing UpdateNotificationSettingsInput (old duplicate) and make sure it's removed
const oldNS = '      UpdateNotificationSettingsInput: {\n        type: "object",\n        properties: {\n          paymentRemindersEnabled: { type: "boolean" },';
const oldNSEnd = c.indexOf(oldNS);
if (oldNSEnd !== -1) {
  // find the closing of this block
  let depth = 0;
  let i = oldNSEnd;
  while (i < c.length) {
    if (c[i] === '{') depth++;
    else if (c[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
    i++;
  }
  // also skip optional trailing comma and newline
  while (i < c.length && (c[i] === ',' || c[i] === '\n' || c[i] === '\r')) i++;
  c = c.slice(0, oldNSEnd) + c.slice(i);
  console.log('✓ Removed old UpdateNotificationSettingsInput duplicate');
}

// Now find the last "real" schema closing and insert our new schemas before the schemas-closing brace
// Strategy: find the last line that is `      },` before `    },\n  },\n  security:`
const tailMarker = '    },\n  },\n  security:';
const tailAlt = '    },\n  },\n  security:';
let tailIdx = c.lastIndexOf('    },\n  },\n  security:');
if (tailIdx === -1) {
  tailIdx = c.lastIndexOf("    },\r\n  },\r\n  security:");
}

if (tailIdx !== -1) {
  // Insert new schemas just before the `    },` closing tag
  c = c.slice(0, tailIdx) + newSchemas + c.slice(tailIdx);
  console.log('✓ Injected new TypeScript schemas into components.schemas');
} else {
  // Fallback: find before security:
  const secIdx = c.lastIndexOf('  security:');
  if (secIdx !== -1) {
    c = c.slice(0, secIdx) + newSchemas + '    },\n  },\n  ' + c.slice(secIdx);
    console.log('✓ Injected schemas (fallback method)');
  }
}

// ─── STEP 5: Fix the purchasing paths query params ────────────────────────────
// Add proper query params to the GET purchasing endpoints that only have responses

// suppliers list
c = c.replace(
  '"tags": ["Purchasing"],\n        "summary": "List suppliers"',
  'tags: ["Purchasing"],\n        summary: "List suppliers",\n        parameters: [\n          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },\n          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },\n          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },\n          { name: "isActive", in: "query", schema: { type: "string", enum: ["true", "false"] } },\n        ],'
);

fs.writeFileSync('src/docs/openapi.ts', c);
console.log('\n✅ All done. Run npm run typecheck to verify.');
