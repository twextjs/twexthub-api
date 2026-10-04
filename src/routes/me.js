import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { userToObject } from '../serialize.js';

// The account the presented token belongs to. It sits at the root of the API
// because it is not addressed by namespace: there is exactly one, and the token
// already names it.
export function makeMeRouter({ config }) {
  const router = Router();

  router.get('/me', requireAuth, (req, res) => {
    res.json(userToObject(req.auth.user, config));
  });

  return router;
}
