import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const login2faSchema = z.object({
  body: z.object({
    tempToken: z.string().min(1, 'Token is required'),
    totpCode: z.string().min(1, 'Code is required'),
  }),
});

export const setupCompleteSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Setup link token is required'),
    password: z.string().min(12, 'Password must be at least 12 characters'),
  }),
});
