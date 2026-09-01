import { Router } from 'express';
import { VmController } from '../../controllers/VmController.js';
import { requireAuth, requireAdmin } from '../../middleware.js';

export const vmRouter = Router();

// We require authentication and admin privileges for these global VM routes
vmRouter.use(requireAuth, requireAdmin);

import { validateRequest } from '../../middleware/validateRequest.js';
import { createVmSchema } from '../../validators/vmValidators.js';

vmRouter.get('/', VmController.listVMs);
vmRouter.get('/:vmid', VmController.getVM);
vmRouter.post('/', validateRequest(createVmSchema), VmController.createVM);
