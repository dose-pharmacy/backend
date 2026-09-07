import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
);
const enums = await prisma.$queryRawUnsafe<Array<{ typname: string }>>(
  "SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'",
);
const columns = await prisma.$queryRawUnsafe<
  Array<{ table_name: string; column_name: string }>
>(
  "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('user','session','account','verification') ORDER BY table_name, ordinal_position",
);

console.log(JSON.stringify({ tables, enums, columns }, null, 2));
await prisma.$disconnect();
