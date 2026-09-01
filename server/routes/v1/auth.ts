import { Router } from 'express';
import { rateLimit } from '../../middleware.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { loginSchema, login2faSchema, setupCompleteSchema } from '../../validators/authValidators.js';
import { AuthController } from '../../controllers/AuthController.js';

export const authRouter = Router();

authRouter.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth-login' }), validateRequest(loginSchema), AuthController.login);
authRouter.post('/login/2fa', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth-login-2fa' }), validateRequest(login2faSchema), AuthController.login2fa);
authRouter.post('/passkey/challenge', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyPrefix: 'auth-passkey-challenge' }), AuthController.passkeyChallenge);
authRouter.post('/login/passkey', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth-login-passkey' }), AuthController.loginPasskey);
authRouter.get('/setup/status', AuthController.setupStatus);
authRouter.post('/setup/complete', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth-initial-setup' }), validateRequest(setupCompleteSchema), AuthController.setupComplete);
