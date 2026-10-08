import { getDb } from "@/db";
import { DB_RATE_LIMITS, json, preflight, readJson, withApi } from "@/lib/api";
import { checkoutBodySchema } from "@/lib/validation";
import { startCheckout } from "@/server/checkout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

export const POST = withApi(async (req) => {
  const body = checkoutBodySchema.parse(await readJson(req));
  const db = await getDb();
  const result = await startCheckout(db, {
    holdId: body.holdId,
    customer: body.customer,
    birthdayChild: body.birthdayChild ?? null,
    message: body.message ?? null,
    accept: body.accept,
    returnUrl: body.returnUrl ?? null,
    payInStore: body.payInStore ?? false,
    origin: req.headers.get("origin"),
  });
  return json(result);
}, { dbRateLimit: DB_RATE_LIMITS.checkout });
