import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export const validateRequest = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        const message = error.issues.map((e) => {
          const path = e.path.join('.');
          return `${path.replace('body.', '')}: ${e.message}`;
        }).join(', ');
        return res.status(400).json({ success: false, error: message });
      }
      return res.status(400).json({ success: false, error: 'Invalid request data' });
    }
  };
};
