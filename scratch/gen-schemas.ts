import fs from 'fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as supplierValidators from '../src/validators/purchasing/supplier.js';
import * as requirementValidators from '../src/validators/purchasing/requirement.js';
import * as purchaseOrderValidators from '../src/validators/purchasing/purchase-order.js';
import * as goodsReceiptValidators from '../src/validators/purchasing/goods-receipt.js';
import * as supplierInvoiceValidators from '../src/validators/purchasing/supplier-invoice.js';
import * as notificationValidators from '../src/validators/notification.js';
import * as expiryValidators from '../src/validators/inventory/expiry-action.js';

const schemas = {
  SupplierCreateInput: supplierValidators.createSupplierSchema,
  SupplierUpdateInput: supplierValidators.updateSupplierSchema,
  RequirementCreateInput: requirementValidators.createRequirementSchema,
  RequirementUpdateInput: requirementValidators.updateRequirementSchema,
  RequirementLineAddInput: requirementValidators.addRequirementLineSchema,
  RequirementLineUpdateInput: requirementValidators.updateRequirementLineSchema,
  PurchaseOrderCreateInput: purchaseOrderValidators.createPurchaseOrderSchema,
  PurchaseOrderFromRequirementInput: purchaseOrderValidators.createPurchaseOrderFromRequirementSchema,
  PurchaseOrderUpdateInput: purchaseOrderValidators.updatePurchaseOrderSchema,
  PurchaseOrderItemUpdateInput: purchaseOrderValidators.updatePurchaseOrderItemSchema,
  AcceptShortageInput: purchaseOrderValidators.acceptShortageSchema,
  GoodsReceiptCreateInput: goodsReceiptValidators.createGoodsReceiptSchema,
  GoodsReceiptResolveInput: goodsReceiptValidators.resolveGoodsReceiptSchema,
  SupplierInvoiceCreateInput: supplierInvoiceValidators.createSupplierInvoiceSchema,
  SupplierInvoiceUpdateInput: supplierInvoiceValidators.updateSupplierInvoiceSchema,
  SupplierInvoicePaymentInput: supplierInvoiceValidators.recordPaymentSchema,
  NotificationCreateInput: notificationValidators.createNotificationSchema,
  NotificationSettingsUpdateInput: notificationValidators.updateNotificationSettingsSchema,
  ExpiryActionInput: expiryValidators.createExpiryActionSchema,
};

const openApiSchemas: Record<string, any> = {};

for (const [key, schema] of Object.entries(schemas)) {
  const jsonSchema = zodToJsonSchema(schema as any, key);
  openApiSchemas[key] = jsonSchema.definitions?.[key] || jsonSchema;
}

// Modify openapi.ts to inject these schemas and update the generic object types in the paths.
let openapiContent = fs.readFileSync('src/docs/openapi.ts', 'utf-8');

// 1. Inject schemas into components.schemas
const componentsMarker = 'components: {';
const schemasMarker = 'schemas: {';
const index = openapiContent.indexOf(schemasMarker);

if (index !== -1) {
  const schemaStr = Object.entries(openApiSchemas).map(([k, v]) => `      ${k}: ${JSON.stringify(v, null, 2)},`).join('\n');
  openapiContent = openapiContent.slice(0, index + schemasMarker.length) + '\n' + schemaStr + openapiContent.slice(index + schemasMarker.length);
}

// 2. Fix the paths to use these schemas
const pathReplacements = [
  { path: '"/purchasing/suppliers"', method: 'post', ref: 'SupplierCreateInput' },
  { path: '"/purchasing/suppliers/{id}"', method: 'patch', ref: 'SupplierUpdateInput' },
  { path: '"/purchasing/requirements"', method: 'post', ref: 'RequirementCreateInput' },
  { path: '"/purchasing/requirements/{id}"', method: 'patch', ref: 'RequirementUpdateInput' },
  { path: '"/purchasing/requirements/{id}/lines"', method: 'post', ref: 'RequirementLineAddInput' },
  { path: '"/purchasing/requirements/lines/{lineId}"', method: 'patch', ref: 'RequirementLineUpdateInput' },
  { path: '"/purchasing/purchase-orders"', method: 'post', ref: 'PurchaseOrderCreateInput' },
  { path: '"/purchasing/purchase-orders/from-requirement"', method: 'post', ref: 'PurchaseOrderFromRequirementInput' },
  { path: '"/purchasing/purchase-orders/{id}"', method: 'patch', ref: 'PurchaseOrderUpdateInput' },
  { path: '"/purchasing/purchase-orders/items/{itemId}"', method: 'patch', ref: 'PurchaseOrderItemUpdateInput' },
  { path: '"/purchasing/purchase-orders/{id}/goods-receipts"', method: 'post', ref: 'GoodsReceiptCreateInput' },
  { path: '"/purchasing/goods-receipts/{id}/resolve"', method: 'patch', ref: 'GoodsReceiptResolveInput' },
  { path: '"/purchasing/supplier-invoices"', method: 'post', ref: 'SupplierInvoiceCreateInput' },
  { path: '"/purchasing/supplier-invoices/{id}"', method: 'patch', ref: 'SupplierInvoiceUpdateInput' },
  { path: '"/purchasing/supplier-invoices/{id}/payments"', method: 'post', ref: 'SupplierInvoicePaymentInput' },
];

for (const rep of pathReplacements) {
  const target = `schema: { type: "object" }`;
  const replacement = `schema: { $ref: "#/components/schemas/${rep.ref}" }`;
  // We can just globally replace the { type: "object" } in the block of that path
  // Since we don't have block-level replace easily, let's just do a string replace carefully.
  // Actually, we can use regex to target the specific path and method.
  const regex = new RegExp(`(${rep.path}:\\s*\\{[\\s\\S]*?${rep.method}:\\s*\\{[\\s\\S]*?)schema:\\s*\\{\\s*type:\\s*"object"\\s*\\}`, 'g');
  openapiContent = openapiContent.replace(regex, `$1schema: { $ref: "#/components/schemas/${rep.ref}" }`);
}

// Add query params and body to notification endpoints and expiry
// Notification read-all has no body or params, so it's fine.
// Notification settings PATCH uses NotificationSettingsUpdateInput
openapiContent = openapiContent.replace(
  /("\/notifications\/settings":\s*\{\s*patch:\s*\{\s*tags:\s*\["Notifications"\],\s*summary:\s*"Update notification settings",\s*)responses/g,
  `$1requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NotificationSettingsUpdateInput" } } } },\n        responses`
);

fs.writeFileSync('src/docs/openapi.ts', openapiContent);
console.log('Schemas generated and openapi.ts updated.');
