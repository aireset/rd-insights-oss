import { Prisma } from '@prisma/client';

export async function lockUserSession(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
}
