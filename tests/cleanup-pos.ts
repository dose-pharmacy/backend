import { prisma } from "../src/database/prisma.js";
// Clean up test artifacts from prior POS test runs
const result = await prisma.$transaction(async (tx) => {
  // Delete sales (cascade removes items, allocations, payments)
  const sales = await tx.sale.deleteMany();
  // Delete stock transactions referencing sales
  const txns = await tx.stockTransaction.deleteMany({ where: { transactionType: "SALE" } });
  // Delete inventory stock that belongs to test locations
  // Delete product units for test products
  // Delete test products
  const products = await tx.product.deleteMany({ where: { name: { contains: "Pos" } } });
  // Delete product groups for test
  const groups = await tx.productGroup.deleteMany({ where: { name: { contains: "Pos" } } });
  // Delete test units
  const units = await tx.unit.deleteMany({ where: { name: { contains: "Pos" } } });
  return { sales: sales.count, txns: txns.count, products: products.count, groups: groups.count, units: units.count };
});
console.log("Cleaned:", result);
process.exit(0);
