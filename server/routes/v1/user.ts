import { Router } from 'express';
import { requireAuth } from '../../middleware.js';
import { UserController } from '../../controllers/UserController.js';

export const userRouter = Router();

// All user routes require authentication
userRouter.use(requireAuth);

userRouter.get('/profile', UserController.getProfile);
userRouter.put('/profile', UserController.updateProfile);
userRouter.post('/profile', UserController.updateProfile); // Legacy support
userRouter.post('/change-password', UserController.changePassword);

userRouter.get('/ssh-keys', UserController.getSshKeys);
userRouter.put('/ssh-keys', UserController.updateSshKeys);
userRouter.get('/api-keys', UserController.getApiKeys);
userRouter.post('/api-keys', UserController.createApiKey);
userRouter.delete('/api-keys/:id', UserController.deleteApiKey);
