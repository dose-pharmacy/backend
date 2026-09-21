-- Add missing relation from supplier_invoice_item.unitId to unit.
ALTER TABLE "supplier_invoice_item" ADD CONSTRAINT "supplier_invoice_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
