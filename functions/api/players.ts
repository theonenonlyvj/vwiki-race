import { createTrackingContext, type Env } from "../_shared/createTrackingContext";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(
      await tracking.handlers.upsertPlayer(
        (await tracking.readJson(context.request)) as {
          displayName: string;
          playerId?: string;
        },
      ),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
