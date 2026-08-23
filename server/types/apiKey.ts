import { Request } from 'express';

export interface ApiKeyUser {
  email: string;
  name: string;
  scope: 'read' | 'power' | 'full';
  keyId: number;
}

export interface KeyedRequest extends Request {
  authUser?: { id: number; email: string; role: string; name: string };
  apiKeyUser?: ApiKeyUser;
}
