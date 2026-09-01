import { z } from 'zod';

export const createVmSchema = z.object({
  body: z.object({
    vmid: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    node: z.string().optional(),
    ownerEmail: z.string().email('Owner account email must be a valid email'),
    cpus: z.union([z.string(), z.number()]).optional(),
    memoryGb: z.union([z.string(), z.number()]).optional(),
    diskGb: z.union([z.string(), z.number()]).optional(),
    expiryDays: z.union([z.string(), z.number()]).optional(),
    os: z.string().optional(),
  }),
});
