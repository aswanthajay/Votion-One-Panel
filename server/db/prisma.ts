import { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { pgPool } from './database.js';

const adapter = new PrismaPg(pgPool);
const prisma = new PrismaClient({ adapter });

export { prisma };
