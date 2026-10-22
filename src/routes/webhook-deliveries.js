import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { notFound } from '../errors.js';

// The delivery log and its redelivery are the same two operations for an
// extension's, an organization's and an account's hooks; only the gate that
// decides who may reach them differs. Each router runs its own gate first and
// hands over the namespace and, for an extension hook, the id it resolved, so
// the paging is written once here while the SQL stays in webhooks.js.
//
//   list(req, res, { namespace, extensionId })
//   redeliver(req, res, { namespace, extensionId })
//
// extensionId is null for the namespace-wide collections.
export function makeWebhookDeliveryRoutes({ webhooks, config }) {
  return {
    async list(req, res, { namespace, extensionId }) {
      const webhookId = Number(req.params.webhookId);
      if (!Number.isInteger(webhookId)) throw notFound('No such webhook.');
      const limit = parseLimit(config, req.query.limit);
      const cursor = decodeCursor(req.query.cursor, { i: 'int' });
      const back = parseDir(req.query.dir);
      const rows = await webhooks.listDeliveries(namespace, extensionId, webhookId, {
        limit,
        cursor,
        back,
      });
      res.json(
        keysetPage(req, rows, {
          limit,
          back,
          cursor,
          serialize: (row) => row,
          keyOf: (row) => ({ i: Number(row.id) }),
        }),
      );
    },

    async redeliver(req, res, { namespace, extensionId }) {
      const webhookId = Number(req.params.webhookId);
      const deliveryId = Number(req.params.deliveryId);
      if (!Number.isInteger(webhookId) || !Number.isInteger(deliveryId)) {
        throw notFound('No such delivery.');
      }
      const delivery = await webhooks.redeliver(namespace, extensionId, webhookId, deliveryId);
      res.status(202).json(delivery);
    },
  };
}
