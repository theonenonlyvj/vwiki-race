import { createTrackingContext, type Env } from "../_shared/createTrackingContext";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(await tracking.handlers.listChallenges());
  } catch (caught) {
    return tracking.error(caught);
  }
};
