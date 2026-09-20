import { Router, type NextFunction, type Request, type Response } from 'express';
import { updatePrice, SkuNotFoundError } from '../services/price-sync.js';
import { getPriceReport } from '../services/price-report.js';

const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export interface ValidationFailure {
  error: string;
  detail: string;
}

export function validatePrice(raw: unknown): { ok: true; price: string } | { ok: false; failure: ValidationFailure } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, failure: { error: 'price_required', detail: 'Body must include a "price" field.' } };
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return {
      ok: false,
      failure: { error: 'price_invalid_type', detail: 'Price must be a string or a number.' },
    };
  }

  const price = typeof raw === 'number' ? raw.toFixed(2) : raw.trim();

  if (!PRICE_PATTERN.test(price)) {
    return {
      ok: false,
      failure: {
        error: 'price_invalid_format',
        detail: `Price must be a positive decimal with at most 2 places, got "${price}".`,
      },
    };
  }

  if (Number(price) <= 0) {
    return { ok: false, failure: { error: 'price_not_positive', detail: 'Price must be greater than zero.' } };
  }

  return { ok: true, price };
}

type Handler = (req: Request, res: Response) => Promise<void>;

function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export const pricesRouter = Router();

pricesRouter.get(
  '/prices',
  route(async (_req, res) => {
    res.json(await getPriceReport());
  }),
);

pricesRouter.patch(
  '/prices/:sku',
  route(async (req, res) => {
    const sku = req.params.sku?.trim();
    if (!sku) {
      res.status(400).json({ error: 'sku_required', detail: 'Path must include a SKU.' });
      return;
    }

    const validated = validatePrice((req.body as Record<string, unknown> | undefined)?.price);
    if (!validated.ok) {
      res.status(400).json(validated.failure);
      return;
    }

    try {
      const result = await updatePrice(sku, validated.price);
      res.status(result.summary.failed > 0 ? 207 : 200).json(result);
    } catch (err) {
      if (err instanceof SkuNotFoundError) {
        res.status(404).json({ error: 'sku_not_found', detail: err.message });
        return;
      }
      throw err;
    }
  }),
);
