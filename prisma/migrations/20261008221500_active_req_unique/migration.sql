CREATE UNIQUE INDEX "purchase_requirement_line_active_product_key" 
ON "purchase_requirement_line"("productId") 
WHERE status IN ('OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED');
