-- DropForeignKey
ALTER TABLE "purchase_return" DROP CONSTRAINT "purchase_return_purchaseOrderItemId_fkey";

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
